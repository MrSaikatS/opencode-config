import type { Plugin } from "@opencode-ai/plugin";

interface SessionState {
  lastProcessedCount: number;
}

// Per-session state: tracks the user message count at which we last generated a title.
const state = new Map<string, SessionState>();

// Processing lock: prevents re-entering the title generation flow for the same session.
const processing = new Set<string>();

const FIRST_THRESHOLD = 3;
const INTERVAL = 5;
const TEMP_SESSION_TITLE = "__temp_title_gen__";

// Flag to ensure we only run the startup cleanup once.
let cleanupDone = false;

// Cache for the small model configuration to avoid fetching it on every event.
let cachedTitleModel: { providerID: string; modelID: string } | undefined =
  undefined;
let modelConfigChecked = false;

export const AutoTitlePlugin: Plugin = async (ctx) => {
  return {
    event: async ({ event }) => {
      // Safely run cleanup on the first event received, ensuring the server is fully ready.
      if (!cleanupDone) {
        cleanupDone = true;
        try {
          const { data: sessions } = await ctx.client.session.list();
          if (sessions) {
            for (const session of sessions) {
              if (session.title === TEMP_SESSION_TITLE) {
                await ctx.client.session
                  .delete({ path: { id: session.id } })
                  .catch(() => {});
              }
            }
          }
        } catch (err) {
          await ctx.client.app
            .log({
              body: {
                service: "auto-title-plugin",
                level: "warn",
                message: "Failed to cleanup orphaned temp sessions on startup",
                extra: {
                  error: err instanceof Error ? err.message : String(err),
                },
              },
            })
            .catch(() => {}); // Swallow logging error so the plugin doesn't crash
        }
      }

      // Fetch and cache the small_model from opencode.json configuration once.
      if (!modelConfigChecked) {
        modelConfigChecked = true;
        try {
          const { data: config } = await ctx.client.config.get();

          // opencode.json stores small_model as a string like "anthropic/claude-3-5-haiku-20241022"
          const smallModelStr = config?.small_model as string | undefined;

          if (smallModelStr && smallModelStr.includes("/")) {
            const [providerID, modelID] = smallModelStr.split("/");
            cachedTitleModel = { providerID, modelID };
          }
        } catch (err) {
          await ctx.client.app
            .log({
              body: {
                service: "auto-title-plugin",
                level: "warn",
                message:
                  "Failed to fetch small_model from config, falling back to default model",
                extra: {
                  error: err instanceof Error ? err.message : String(err),
                },
              },
            })
            .catch(() => {}); // Swallow logging error
        }
      }

      const properties = event.properties as any;
      const sessionId = properties?.sessionID;
      if (!sessionId) return;

      // Reset state on compaction since message counts will change drastically
      if (event.type === "session.compacted") {
        state.delete(sessionId);
        return;
      }

      // Handle both legacy 'session.idle' and current 'session.status' (idle) events.
      const isIdle =
        event.type === "session.idle" ||
        (event.type === "session.status" &&
          properties?.status?.type === "idle");

      if (!isIdle || processing.has(sessionId)) return;

      try {
        const { data: messages } = await ctx.client.session.messages({
          path: { id: sessionId },
        });
        if (!messages || messages.length === 0) return;

        // Only generate a title if the AI has actually finished responding.
        const lastMessage = messages[messages.length - 1];
        if (lastMessage.info.role !== "assistant") return;

        const userCount = messages.filter((m) => m.info.role === "user").length;
        if (userCount < FIRST_THRESHOLD) return;

        // Recover state after a server restart.
        if (!state.has(sessionId)) {
          const { data: currentSession } = await ctx.client.session.get({
            path: { id: sessionId },
          });
          if (
            currentSession?.title &&
            /\s*-\s*\d{2}\/\d{2}\/\d{4}\s+\d{1,2}:\d{2}(?:AM|PM)$/.test(
              currentSession.title,
            )
          ) {
            state.set(sessionId, { lastProcessedCount: userCount });
          }
        }

        const s = state.get(sessionId) ?? { lastProcessedCount: 0 };
        const nextThreshold =
          s.lastProcessedCount === 0 ?
            FIRST_THRESHOLD
          : s.lastProcessedCount + INTERVAL;
        if (userCount < nextThreshold) return;

        // Acquire the processing lock for this session
        processing.add(sessionId);

        const { data: session } = await ctx.client.session.get({
          path: { id: sessionId },
        });
        if (!session) return;

        // Strip the date/time suffix we previously appended.
        const currentTitle = (session.title || "").replace(
          /\s*-\s*\d{2}\/\d{2}\/\d{4}\s+\d{1,2}:\d{2}(?:AM|PM)$/,
          "",
        );

        // Truncate context to the last 6 messages and cap individual message length to 1000 characters.
        const recentMessages = messages.slice(-6);
        const conversationText = recentMessages
          .map((m) => {
            const role = m.info.role === "user" ? "Human" : "Assistant";
            const text = m.parts
              .filter(
                (p): p is Extract<typeof p, { type: "text" }> =>
                  p.type === "text",
              )
              .map((p) => p.text)
              .join("");
            const truncatedText =
              text.length > 1000 ? text.substring(0, 1000) + "..." : text;
            return `[${role}]: ${truncatedText}`;
          })
          .join("\n\n");

        // Create a throwaway session so no messages are added to the user's real conversation history.
        const { data: tempSession } = await ctx.client.session.create({
          body: { title: TEMP_SESSION_TITLE },
        });
        if (!tempSession) return;

        try {
          // Inject the full conversation as a single user message with noReply: true.
          // Use the parsed small_model object if available.
          const contextPromptBody: any = {
            noReply: true,
            parts: [{ type: "text", text: conversationText }],
          };
          if (cachedTitleModel) {
            contextPromptBody.model = cachedTitleModel;
          }

          await ctx.client.session.prompt({
            path: { id: tempSession.id },
            body: contextPromptBody,
          });

          // Ask the model to refine the existing title or generate a new one from scratch.
          const promptText =
            currentTitle ?
              `Refine the session title based on the full conversation. Current title: "${currentTitle}". Reply with ONLY the new title, 3-5 words, no quotes.`
            : `Based on this conversation, suggest a concise 3-5 word session title. Reply with ONLY the title, no quotes.`;

          const titlePromptBody: any = {
            parts: [{ type: "text", text: promptText }],
          };
          if (cachedTitleModel) {
            titlePromptBody.model = cachedTitleModel;
          }

          const { data: result } = await ctx.client.session.prompt({
            path: { id: tempSession.id },
            body: titlePromptBody,
          });
          if (!result) return;

          // Extract the title from the assistant's response.
          const textPart = result.parts.find((p) => p.type === "text");
          if (!textPart || textPart.type !== "text") return;

          // Strip surrounding quotes and markdown bolding/italics.
          let titleText = textPart.text.trim();
          titleText = titleText
            .replace(/^["'*]|["']*$/g, "")
            .replace(/\*\*/g, "");
          if (!titleText || titleText.length > 60) return; // Failsafe if model rambles

          // Format the final title with date and time.
          const now = new Date();
          const dateStr = now.toLocaleDateString("en-GB");
          const timeStr = now
            .toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
            .replace(" ", "");
          const formattedTitle = `${titleText} - ${dateStr} ${timeStr}`;

          // Update the real session's title and advance the counter.
          await ctx.client.session.update({
            path: { id: sessionId },
            body: { title: formattedTitle },
          });

          state.set(sessionId, { lastProcessedCount: userCount });
        } finally {
          // Always delete the temp session, even if an error occurred above.
          await ctx.client.session
            .delete({ path: { id: tempSession.id } })
            .catch(() => {});
        }
      } catch (err) {
        // Use official app.log() instead of console.error for structured logging.
        await ctx.client.app
          .log({
            body: {
              service: "auto-title-plugin",
              level: "error",
              message: `Failed to generate title for session ${sessionId}`,
              extra: {
                error: err instanceof Error ? err.message : String(err),
              },
            },
          })
          .catch(() => {});
      } finally {
        // Always release the processing lock
        processing.delete(sessionId);
      }
    },
  };
};
