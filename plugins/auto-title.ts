import type { Plugin } from "@opencode-ai/plugin";

interface SessionState {
  lastProcessedCount: number;
}

// Per-session state: tracks the user message count at which we last generated a title.
// This is keyed by session ID so multiple concurrent sessions are handled independently.
const state = new Map<string, SessionState>();

// Processing lock: prevents re-entering the title generation flow for the same session.
// Without this, session.idle could fire again while we're still generating (e.g. after
// the temp session prompt completes, which triggers its own idle event).
const processing = new Set<string>();

// Generate the first title after 3 user messages (enough context for a meaningful title).
// Then re-trigger every 5 additional user messages so the title evolves with the conversation.
const FIRST_THRESHOLD = 3;
const INTERVAL = 5;

export const AutoTitlePlugin: Plugin = async (ctx) => {
  return {
    // Hook into all server events, but only act on session.idle.
    // session.idle fires after each AI response finishes, which is the safest
    // time to snapshot the conversation state for title generation.
    event: async ({ event }) => {
      if (event.type !== "session.idle") return;

      const sessionId = event.properties.sessionID;
      if (!sessionId || processing.has(sessionId)) return;

      try {
        // ── 1. Count user messages to decide if we should generate a title ──
        const { data: messages } = await ctx.client.session.messages({
          path: { id: sessionId },
        });
        if (!messages) return;

        // Only count user-role messages. Assistant messages, compaction summaries,
        // and other system messages are excluded from the threshold check.
        const userCount = messages.filter((m) => m.info.role === "user").length;
        if (userCount < FIRST_THRESHOLD) return;

        // Retrieve the last processed count for this session (defaults to 0).
        // When lastProcessedCount is 0, the first threshold is FIRST_THRESHOLD.
        // For subsequent generations, the threshold is lastProcessedCount + INTERVAL.
        const s = state.get(sessionId) ?? { lastProcessedCount: 0 };
        const nextThreshold =
          s.lastProcessedCount === 0 ?
            FIRST_THRESHOLD
          : s.lastProcessedCount + INTERVAL;
        if (userCount < nextThreshold) return;

        // Acquire the processing lock for this session
        processing.add(sessionId);

        // ── 2. Get current session info for the refinement prompt ──
        const { data: session } = await ctx.client.session.get({
          path: { id: sessionId },
        });
        if (!session) return;

        // Strip the date/time suffix we previously appended (e.g. " - 07/07/2026 12:59AM")
        // so the model only sees the semantic core title like "Fix auth redirect".
        // Without this, the date/time bleeds into every refinement, making the title
        // longer with each cycle.
        const currentTitle = (session.title || "").replace(
          /\s*-\s*\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}(?:AM|PM)$/,
          "",
        );

        // ── 3. Build a plain-text representation of the conversation ──
        // This avoids injecting messages into the real session (which would create noise).
        // Instead, we'll feed this text into a temporary session.
        const conversationText = messages
          .map((m) => {
            const role = m.info.role === "user" ? "Human" : "Assistant";
            const text = m.parts
              .filter(
                (p): p is Extract<typeof p, { type: "text" }> =>
                  p.type === "text",
              )
              .map((p) => p.text)
              .join("");
            return `[${role}]: ${text}`;
          })
          .join("\n\n");

        // ── 4. Create a throwaway session ──
        // We generate the title in a temporary session so no messages are added to
        // the user's real conversation. The temp session is created, used once, and
        // deleted — all invisible to the user.
        const { data: tempSession } = await ctx.client.session.create({
          body: { title: "__title_gen__" },
          query: { directory: ctx.directory },
        });
        if (!tempSession) return;

        try {
          // Inject the full conversation as a single user message with noReply: true.
          // noReply: true means the AI does NOT respond to this message — it's just
          // context stored in the session history for the subsequent prompt to use.
          await ctx.client.session.prompt({
            path: { id: tempSession.id },
            body: {
              noReply: true,
              parts: [{ type: "text", text: conversationText }],
            },
          });

          // Now send the title-generation prompt with noReply: false (default),
          // which triggers an AI response. The model sees the injected conversation
          // as context and generates a concise title based on it.
          //
          // If a title already exists, we ask the model to refine it rather than
          // generate from scratch — this gives smoother evolution across cycles.
          const promptText =
            currentTitle ?
              `Refine the session title based on the full conversation. Current title: "${currentTitle}". Reply with ONLY the new title, 3-5 words, no quotes.`
            : `Based on this conversation, suggest a concise 3-5 word session title. Reply with ONLY the title, no quotes.`;

          const { data: result } = await ctx.client.session.prompt({
            path: { id: tempSession.id },
            body: {
              model: { providerID: "opencode", modelID: "big-pickle" },
              parts: [{ type: "text", text: promptText }],
            },
          });
          if (!result) return;

          // Extract the title from the assistant's response. The response may contain
          // multiple parts (text, reasoning, tool calls), so we pick the first text part.
          const textPart = result.parts.find((p) => p.type === "text");
          if (!textPart || textPart.type !== "text") return;
          let titleText = textPart.text.trim();

          // Strip surrounding quotes that the model sometimes adds despite the instruction
          titleText = titleText.replace(/^["']|["']$/g, "");
          if (!titleText) return;

          // ── 5. Format the final title ──
          // Pattern: {semantic title} - {DD/MM/YYYY} {HH:MMAM/PM}
          // e.g. "Fix auth redirect - 07/07/2026 12:59AM"
          const now = new Date();
          const dateStr = now.toLocaleDateString("en-GB");
          const timeStr = now
            .toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
            .replace(" ", ""); // Remove the space between minutes and AM/PM
          const formattedTitle = `${titleText} - ${dateStr} ${timeStr}`;

          // Update the real session's title
          await ctx.client.session.update({
            path: { id: sessionId },
            body: { title: formattedTitle },
          });

          // Advance the counter: +1 accounts for our injected prompt message so the
          // next threshold correctly reflects INTERVAL real user messages later.
          state.set(sessionId, { lastProcessedCount: userCount + 1 });
        } finally {
          // Always delete the temp session, even if an error occurred above.
          // The .catch() silently swallows cleanup errors (e.g. session already deleted).
          await ctx.client.session
            .delete({ path: { id: tempSession.id } })
            .catch(() => {});
        }
      } catch (err) {
        // On any error, keep the existing title and log for debugging.
        console.error("[auto-title]", err);
      } finally {
        // Always release the processing lock
        processing.delete(sessionId);
      }
    },
  };
};
