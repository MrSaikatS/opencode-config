import type { Plugin } from "@opencode-ai/plugin";

interface SessionState {
  lastProcessedCount: number;
}

interface TitleModel {
  providerID: string;
  modelID: string;
}

const FIRST_THRESHOLD = 3;
const INTERVAL = 5;
const TEMP_SESSION_TITLE = "__temp_title_gen__";
const TITLE_SUFFIX_RE = /\s*-\s*\d{2}\/\d{2}\/\d{4}\s+\d{1,2}:\d{2}(?:AM|PM)$/;

// Local in-memory state. The processing lock is intentionally separate:
// state tracks completed/reserved work, while processing prevents concurrent work.
const state = new Map<string, SessionState>();
const processing = new Set<string>();

// Lazy initialization promises.
// Assigning the promise BEFORE the first await makes initialization effectively
// single-flight even when multiple events arrive at the same time.
let cleanupPromise: Promise<void> | undefined;
let modelConfigPromise: Promise<void> | undefined;

let cachedTitleModel: TitleModel | undefined;

const log = async (
  ctx: Parameters<Plugin>[0],
  level: "warn" | "error" | "info",
  message: string,
  extra?: Record<string, unknown>,
) => {
  await ctx.client.app
    .log({
      body: {
        service: "auto-title-plugin",
        level,
        message,
        ...(extra ? { extra } : {}),
      },
    })
    .catch(() => {});
};

const initializeCleanup = async (ctx: Parameters<Plugin>[0]) => {
  if (cleanupPromise) return cleanupPromise;

  cleanupPromise = (async () => {
    try {
      const { data: sessions } = await ctx.client.session.list();

      if (!sessions) return;

      await Promise.all(
        sessions
          .filter((session) => session.title === TEMP_SESSION_TITLE)
          .map((session) =>
            ctx.client.session
              .delete({ path: { id: session.id } })
              .catch(() => {}),
          ),
      );
    } catch (err) {
      await log(
        ctx,
        "warn",
        "Failed to cleanup orphaned temp sessions on startup",
        {
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  })();

  return cleanupPromise;
};

const initializeModelConfig = async (ctx: Parameters<Plugin>[0]) => {
  if (modelConfigPromise) return modelConfigPromise;

  modelConfigPromise = (async () => {
    try {
      const { data: config } = await ctx.client.config.get();
      const smallModel = config?.small_model;

      if (typeof smallModel !== "string") return;

      const separator = smallModel.indexOf("/");
      if (separator <= 0 || separator === smallModel.length - 1) return;

      cachedTitleModel = {
        providerID: smallModel.slice(0, separator),
        modelID: smallModel.slice(separator + 1),
      };
    } catch (err) {
      await log(
        ctx,
        "warn",
        "Failed to fetch small_model from config, falling back to default model",
        {
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  })();

  return modelConfigPromise;
};

const getSessionTitle = (title: string | undefined) =>
  (title ?? "").replace(TITLE_SUFFIX_RE, "").trim();

const extractMessageText = (message: {
  parts: Array<{ type: string; text?: string }>;
}) => {
  return message.parts
    .filter(
      (part): part is { type: "text"; text: string } =>
        part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("");
};

const buildConversationText = (
  messages: Array<{
    info: { role: string };
    parts: Array<{ type: string; text?: string }>;
  }>,
) => {
  return messages
    .slice(-6)
    .map((message) => {
      const role = message.info.role === "user" ? "Human" : "Assistant";
      const text = extractMessageText(message);
      const truncated = text.length > 1000 ? `${text.slice(0, 1000)}...` : text;

      return `[${role}]: ${truncated}`;
    })
    .join("\n\n");
};

const extractTitle = (text: string) => {
  let title = text.trim();

  // Remove common formatting accidentally returned by the model.
  title = title
    .replace(/^\s*["'`]+|["'`]+\s*$/g, "")
    .replace(/\*\*/g, "")
    .replace(/^\s*[-*]\s*/, "")
    .trim();

  // The model is instructed to return only a title, but reject obvious
  // multi-line/rambly responses as a safety check.
  if (!title || title.length > 60 || title.includes("\n")) {
    return undefined;
  }

  return title;
};

export const AutoTitlePlugin: Plugin = async (ctx) => {
  // Start initialization once when the plugin loads rather than making
  // every event participate in the initialization path.
  void initializeCleanup(ctx);
  void initializeModelConfig(ctx);

  return {
    event: async ({ event }) => {
      const properties = event.properties as any;
      const sessionId = properties?.sessionID;

      if (!sessionId) return;

      // Compaction invalidates the message-count based state.
      if (event.type === "session.compacted") {
        state.delete(sessionId);
        return;
      }

      const isIdle =
        event.type === "session.idle" ||
        (event.type === "session.status" &&
          properties?.status?.type === "idle");

      if (!isIdle) return;

      /*
       * IMPORTANT:
       *
       * This check/add pair MUST happen before the first await.
       *
       * JavaScript executes synchronously until the first await, so two
       * concurrent event handlers cannot both pass this section.
       */
      if (processing.has(sessionId)) return;
      processing.add(sessionId);

      let previousState: SessionState | undefined;
      let reservationMade = false;

      try {
        const { data: messages } = await ctx.client.session.messages({
          path: { id: sessionId },
        });

        if (!messages?.length) return;

        // Only process completed assistant turns.
        const lastMessage = messages[messages.length - 1];
        if (lastMessage.info.role !== "assistant") return;

        const userCount = messages.filter(
          (message) => message.info.role === "user",
        ).length;

        if (userCount < FIRST_THRESHOLD) return;

        /*
         * Recover the in-memory state after a plugin/server restart.
         *
         * We only need to query the session when state is absent.
         */
        let session: Awaited<
          ReturnType<typeof ctx.client.session.get>
        >["data"] = undefined;

        if (!state.has(sessionId)) {
          const response = await ctx.client.session.get({
            path: { id: sessionId },
          });

          session = response.data;

          if (session?.title && TITLE_SUFFIX_RE.test(session.title)) {
            state.set(sessionId, {
              lastProcessedCount: userCount,
            });
          }
        }

        const sessionState = state.get(sessionId) ?? {
          lastProcessedCount: 0,
        };

        const nextThreshold =
          sessionState.lastProcessedCount === 0 ?
            FIRST_THRESHOLD
          : sessionState.lastProcessedCount + INTERVAL;

        if (userCount < nextThreshold) return;

        /*
         * Reserve this message count BEFORE any expensive model work.
         *
         * The processing Set already prevents concurrent executions in this
         * plugin instance. This reservation additionally means that once this
         * event has been accepted, later idle events cannot independently
         * decide to process the same message count.
         */
        previousState = state.get(sessionId);
        state.set(sessionId, {
          lastProcessedCount: userCount,
        });
        reservationMade = true;

        // If state existed, fetch the current session now.
        if (!session) {
          const response = await ctx.client.session.get({
            path: { id: sessionId },
          });

          session = response.data;
        }

        if (!session) return;

        const currentTitle = getSessionTitle(session.title);
        const conversationText = buildConversationText(messages);

        const { data: tempSession } = await ctx.client.session.create({
          body: { title: TEMP_SESSION_TITLE },
        });

        if (!tempSession) return;

        try {
          /*
           * First prompt only injects the conversation into the temporary
           * session. noReply=true is critical: it should NOT invoke an LLM
           * generation.
           */
          const contextPromptBody: {
            noReply: true;
            parts: [{ type: "text"; text: string }];
            model?: TitleModel;
          } = {
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

          /*
           * This is the ONLY prompt in the title workflow that should invoke
           * the model.
           */
          const promptText =
            currentTitle ?
              `Refine the session title based on the full conversation. Current title: "${currentTitle}". Reply with ONLY the new title, 3-5 words, no quotes.`
            : `Based on this conversation, suggest a concise 3-5 word session title. Reply with ONLY the title, no quotes.`;

          const titlePromptBody: {
            parts: [{ type: "text"; text: string }];
            model?: TitleModel;
          } = {
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

          const textPart = result.parts.find((part) => part.type === "text");

          if (!textPart || textPart.type !== "text") return;

          const titleText = extractTitle(textPart.text);
          if (!titleText) return;

          const now = new Date();
          const dateStr = now.toLocaleDateString("en-GB");
          const timeStr = now
            .toLocaleTimeString("en-US", {
              hour: "2-digit",
              minute: "2-digit",
            })
            .replace(" ", "");

          const formattedTitle = `${titleText} - ${dateStr} ${timeStr}`;

          await ctx.client.session.update({
            path: { id: sessionId },
            body: { title: formattedTitle },
          });
        } finally {
          await ctx.client.session
            .delete({ path: { id: tempSession.id } })
            .catch(() => {});
        }
      } catch (err) {
        /*
         * Generation failed, so release the reservation. The next idle event
         * can retry instead of silently losing this title-generation slot.
         */
        if (reservationMade) {
          if (previousState) {
            state.set(sessionId, previousState);
          } else {
            state.delete(sessionId);
          }
        }

        await log(
          ctx,
          "error",
          `Failed to generate title for session ${sessionId}`,
          {
            error: err instanceof Error ? err.message : String(err),
          },
        );
      } finally {
        processing.delete(sessionId);
      }
    },
  };
};
