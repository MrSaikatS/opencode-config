import { Plugin } from "@opencode/plugin";

const PLUGIN_ID = "auto-title";
const STATE_KEY = "auto-title/state/v1";
const TRACE_KEY = "auto-title/trace/v1";
const FAILURE_KEY = "auto-title/failure/v1";
const CLAIM_KEY = "auto-title/claim/v1";
const CLAIM_TTL_MS = 120000;
const FS_LOCK_TTL_MS = 120000;
const CODE_VERSION = "2026-10-21-fslock-1";
const COOLDOWN_MS = 10 * 60 * 1000;
const WORKER_TITLE = "auto-title worker managed do not rename";

const unwrap = (v) => {
  if (
    v &&
    typeof v === "object" &&
    "data" in v &&
    v.data &&
    typeof v.data === "object"
  )
    return v.data;
  return v;
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const defaultOptions = () => {
  return {
    minUserMessages: 6,
    maxUserMessages: 6,
    maxCharsPerMessage: 1200,
    initialTitleAtAssistantCount: 3,
    retitleAfterAssistantDelta: 5,
    enableRetitle: true,
    includeOpeningRequest: true,
    enabled: true,
  };
};

const fail = (key, why) => {
  throw new Error(`[${PLUGIN_ID}] invalid option "${key}": ${why}`);
};

const validateOptions = (raw) => {
  const o = { ...defaultOptions(), ...(raw ?? {}) };
  for (const k of ["minUserMessages", "maxUserMessages"]) {
    if (!Number.isInteger(o[k]) || o[k] < 1 || o[k] > 50)
      fail(k, "must be an integer 1..50");
  }
  if (o.maxUserMessages < o.minUserMessages)
    fail("maxUserMessages", "must be >= minUserMessages");
  if (
    !Number.isInteger(o.maxCharsPerMessage) ||
    o.maxCharsPerMessage < 100 ||
    o.maxCharsPerMessage > 8000
  )
    fail("maxCharsPerMessage", "must be an integer 100..8000");
  if (
    !Number.isInteger(o.initialTitleAtAssistantCount) ||
    o.initialTitleAtAssistantCount < 1
  )
    fail("initialTitleAtAssistantCount", "must be an integer >= 1");
  if (
    !Number.isInteger(o.retitleAfterAssistantDelta) ||
    o.retitleAfterAssistantDelta < 1
  )
    fail("retitleAfterAssistantDelta", "must be an integer >= 1");
  for (const k of ["enableRetitle", "includeOpeningRequest", "enabled"]) {
    if (typeof o[k] !== "boolean") fail(k, "must be a boolean");
  }
  return o;
};

// ---------------------------------------------------------------------------
// Pure logic: title parsing / timestamp / transcript / prompts
// ---------------------------------------------------------------------------

const TITLE_SUFFIX_RE =
  /\s*-\s*\d{2}\/\d{2}\/\d{4}\s+\d{1,2}:\d{2}(?:AM|PM)\s*$/;

const parseTitle = (raw) => {
  if (typeof raw !== "string") return null;
  const line = raw
    .trim()
    .split("\n")
    .map((l) => l.trim().replace(/^["'`]+|["'`.,;]+$/g, ""))
    .find(Boolean);
  if (!line) return null;
  let title = stripTimestamp(line)
    .replace(/^["'`]+|["'`.,;]+$/g, "")
    .trim();
  // Lenient upgrade: if model still emits old "Category: Title", keep part after colon.
  const colon = title.indexOf(":");
  if (colon > 0 && colon < 40) {
    const after = title.slice(colon + 1).trim();
    if (after.length >= 3) title = after;
  }
  if (title.length < 3 || title.length > 120) return null;
  if (!/[A-Za-z0-9]/.test(title)) return null;
  return { title };
};

const formatTimestamp = (date = new Date()) => {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = date.getFullYear();
  let hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  return `${dd}/${mm}/${yyyy} ${hours}:${minutes}${ampm}`;
};

const stripTimestamp = (title) => {
  return String(title).replace(TITLE_SUFFIX_RE, "").trim();
};

const assistantTextParts = (msg) => {
  if (!msg || msg.type !== "assistant" || !Array.isArray(msg.content))
    return [];
  return msg.content.filter(
    (p) =>
      p &&
      p.type === "text" &&
      typeof p.text === "string" &&
      p.text.trim().length > 0,
  );
};

const countAssistantResponses = (messages) => {
  let n = 0;
  for (const m of messages) {
    if (assistantTextParts(m).length > 0) n++;
  }
  return n;
};

const userTextOf = (msg) => {
  if (!msg || msg.type !== "user") return "";
  return typeof msg.text === "string" ? msg.text.trim() : "";
};

const extractTranscript = (messages, opts, firstUserText) => {
  const maxUserMessages = opts.maxUserMessages;
  const maxChars = opts.maxCharsPerMessage;
  const collected = [];
  // messages are oldest-first; walk from the newest end
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = userTextOf(messages[i]);
    if (!text) continue;
    collected.push(text);
    if (collected.length >= maxUserMessages) break;
  }
  collected.reverse();
  const parts = [];
  const windowHasOpening =
    firstUserText && collected.some((t) => t === firstUserText);
  if (opts.includeOpeningRequest && firstUserText && !windowHasOpening) {
    const body =
      firstUserText.length > maxChars ?
        firstUserText.slice(0, maxChars) + "…"
      : firstUserText;
    parts.push(`Opening request:\n${body}`);
  }
  collected.forEach((t, i) => {
    const body = t.length > maxChars ? t.slice(0, maxChars) + "…" : t;
    parts.push(`User message ${i + 1}:\n${body}`);
  });
  return parts.join("\n\n");
};

const SYSTEM_PROMPT = `You generate concise session titles for a coding assistant conversation.

Output exactly ONE line containing only the title text.

Title MUST be 4-8 words, specific to the conversation's actual subject.
Do NOT include a category, label, prefix, date, time, timestamp, or trailing punctuation.
Do NOT output in "Category: Description" format.
Do NOT wrap the output in quotes, backticks, or markdown.
Output only the single line. No preamble, no explanation.

Always generate a fresh title from the conversation. Never reuse a prior title.`;

const buildPrompt = (transcript) => {
  // No system parameter on generate text, so fold system prompt in.
  return `${SYSTEM_PROMPT}\n\nConversation (user messages only):\n${transcript}`;
};

// ---------------------------------------------------------------------------
// Model resolution: agents.title.model only
// ---------------------------------------------------------------------------

const parseModelString = (s) => {
  const i = s.indexOf("/");
  if (i <= 0 || i === s.length - 1) return null;
  const rest = s.slice(i + 1);
  const hash = rest.indexOf("#");
  const out = {
    providerID: s.slice(0, i),
    id: hash < 0 ? rest : rest.slice(0, hash),
  };
  if (hash >= 0 && rest.slice(hash + 1)) out.variant = rest.slice(hash + 1);
  return out;
};

const normalizeModelRef = (v) => {
  if (!v) return null;
  if (typeof v === "string") return parseModelString(v);
  if (typeof v === "object") {
    const providerID = v.providerID ?? v.provider;
    const id = v.id ?? v.model ?? v.modelID;
    if (typeof providerID === "string" && typeof id === "string") {
      const out = { providerID, id };
      if (typeof v.variant === "string") out.variant = v.variant;
      return out;
    }
  }
  return null;
};

const resolveTitleModel = async (ctx, _options, _session, log) => {
  // Title-agent only. No explicit option, no session fallback, no server default.
  try {
    const agent = await ctx.agent.get({ agentID: "title" });
    // Client-shaped calls wrap payloads in a `data` envelope; unwrap first.
    const info =
      agent && typeof agent === "object" && "data" in agent ?
        agent.data
      : agent;
    const ref = normalizeModelRef(info && info.model);
    if (ref) {
      log.debug(`model source=title-agent ${ref.providerID}/${ref.id}`);
      return ref;
    }
    log.debug("model source=title-agent-missing");
  } catch (err) {
    log.debug(`title agent lookup failed: ${err?.message ?? err}`);
  }
  return undefined;
};

const failureKeyFor = (model) => `${model.providerID}/${model.id}`;

const isAuthFailure = (err) => {
  const msg = String(err?.message ?? err).toLowerCase();
  return (
    msg.includes("403") ||
    msg.includes("401") ||
    msg.includes("rejected") ||
    msg.includes("inference_failed") ||
    msg.includes("forbidden") ||
    msg.includes("unauthorized")
  );
};

const getFailureAt = async (ctx, model) => {
  try {
    const all = await ctx.storage.get(FAILURE_KEY);
    const at = all?.[failureKeyFor(model)]?.at;
    return typeof at === "number" ? at : 0;
  } catch {
    return 0;
  }
};

const recordFailure = async (ctx, model, log) => {
  try {
    let all = null;
    try {
      all = await ctx.storage.get(FAILURE_KEY);
    } catch {}
    if (!all || typeof all !== "object") all = {};
    all[failureKeyFor(model)] = { at: Date.now() };
    await ctx.storage.set(FAILURE_KEY, all);
  } catch (err) {
    log.debug(`failure store write failed: ${err?.message ?? err}`);
  }
};

const clearFailure = async (ctx, model) => {
  try {
    const all = await ctx.storage.get(FAILURE_KEY);
    const key = failureKeyFor(model);
    if (all && all[key]) {
      delete all[key];
      await ctx.storage.set(FAILURE_KEY, all);
    }
  } catch {}
};

// ---------------------------------------------------------------------------
// Adapters (only place that touches ctx)
// ---------------------------------------------------------------------------

const makeLogger = () => {
  const p = (level, ...args) => console[level](`[${PLUGIN_ID}]`, ...args);
  return {
    debug: (...a) => p("log", ...a),
    info: (...a) => p("log", ...a),
    warn: (...a) => p("warn", ...a),
    error: (...a) => p("error", ...a),
  };
};

const listMessages = async (ctx, sessionID) => {
  const res = await ctx.session.context({ sessionID });
  return (
    Array.isArray(res) ? res
    : res && Array.isArray(res.data) ? res.data
    : []
  );
};

const getSession = async (ctx, sessionID) => {
  return unwrap(await ctx.session.get({ sessionID }));
};

const isRootSession = (session) => {
  return !!session && session.parentID == null;
};

const renameSession = async (ctx, sessionID, title) => {
  await ctx.session.update({ sessionID, title });
};

const makeStateStore = (ctx, log) => {
  let cache = null; // { sessions: Record<id, state> }

  const load = async () => {
    if (cache) return cache;

    try {
      const raw = await ctx.storage.get(STATE_KEY);
      cache =
        (
          raw &&
          typeof raw === "object" &&
          raw.sessions &&
          typeof raw.sessions === "object"
        ) ?
          { sessions: raw.sessions }
        : { sessions: {} };
    } catch (err) {
      log.warn(
        `storage read failed, using memory only: ${err?.message ?? err}`,
      );
      cache = { sessions: {} };
    }

    return cache;
  };

  const persist = async () => {
    try {
      await ctx.storage.set(STATE_KEY, cache);
    } catch (err) {
      log.warn(`storage write failed: ${err?.message ?? err}`);
    }
  };

  return {
    read: async (sessionID, fresh = false) => {
      if (fresh) cache = null;
      const s = (await load()).sessions;
      return s[sessionID];
    },
    write: async (sessionID, state) => {
      const s = (await load()).sessions;
      s[sessionID] = state;
      await persist();
    },
    delete: async (sessionID) => {
      const s = (await load()).sessions;
      if (s[sessionID]) {
        delete s[sessionID];
        await persist();
      }
    },
  };
};

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

export default Plugin.define({
  id: PLUGIN_ID,
  setup: async (ctx) => {
    const options = validateOptions(ctx.options);
    const log = makeLogger();
    if (!options.enabled) {
      log.info(`disabled via options; version=${ctx.app?.version ?? "?"}`);
      return;
    }
    log.info(
      `loaded (app=${ctx.app?.version ?? "?"}, dir=${ctx.location?.directory ?? "?"}, auto-title=${CODE_VERSION})`,
    );

    const state = makeStateStore(ctx, log);
    const instanceID =
      Math.random().toString(36).slice(2) + Date.now().toString(36);
    const instanceShort = instanceID.slice(-6);
    const processing = new Map();
    const selfGenerating = new Set();
    const workerIDs = new Set();
    let workerChain = Promise.resolve();
    const controller = new AbortController();
    const owningDir = ctx.location?.directory;

    // Visible trace: console lines never reach opencode.log, so each run
    // records its decision in storage where the CLI can read it back.
    const note = async (sessionID, decision, extra) => {
      try {
        let all = null;
        try {
          all = await ctx.storage.get(TRACE_KEY);
        } catch {}
        if (!all || typeof all !== "object") all = {};
        all[sessionID] = {
          at: Date.now(),
          decision,
          inst: instanceShort,
          v: CODE_VERSION,
          ...(extra ?? {}),
        };
        const ids = Object.keys(all);
        if (ids.length > 100) {
          ids
            .sort((a, b) => (all[a]?.at ?? 0) - (all[b]?.at ?? 0))
            .slice(0, ids.length - 100)
            .forEach((id) => {
              delete all[id];
            });
        }
        await ctx.storage.set(TRACE_KEY, all);
      } catch (err) {
        log.debug(`trace write failed: ${err?.message ?? err}`);
      }
    };
    // Slim cross-instance single-flight: first copy to reach generation
    // claims the run in shared storage. Late copies see a fresh foreign
    // claim and stand down. Fail open so a hiccup never blocks titles.
    const claimRun = async (sessionID) => {
      try {
        let all = null;
        try {
          all = await ctx.storage.get(CLAIM_KEY);
        } catch {}
        if (!all || typeof all !== "object") all = {};
        const now = Date.now();
        const cur = all[sessionID];
        if (
          cur &&
          cur.owner !== instanceID &&
          now - (cur.at ?? 0) < CLAIM_TTL_MS
        )
          return false;
        all[sessionID] = { owner: instanceID, at: now };
        await ctx.storage.set(CLAIM_KEY, all);
        return true;
      } catch {
        return true;
      }
    };
    const releaseClaim = async (sessionID) => {
      try {
        const all = await ctx.storage.get(CLAIM_KEY);
        if (all && all[sessionID]?.owner === instanceID) {
          delete all[sessionID];
          await ctx.storage.set(CLAIM_KEY, all);
        }
      } catch {}
    };
    // Filesystem single-flight: shared across processes on this machine,
    // unlike ctx.storage which may be scoped per location. Fail open so a
    // missing node:fs or tmpdir never blocks titles.
    let fsMod = null;
    let osMod = null;
    let fsAvailable = null;
    const loadFs = async () => {
      if (fsAvailable !== null) return fsAvailable;
      try {
        fsMod = await import("node:fs");
        osMod = await import("node:os");
        fsAvailable = true;
      } catch {
        fsAvailable = false;
      }
      return fsAvailable;
    };
    const fsLockPath = (sessionID) => {
      const safe = String(sessionID).replace(/[^A-Za-z0-9_-]/g, "_");
      return `${osMod.tmpdir()}/auto-title-claim-${safe}.lock`;
    };
    const acquireFsLock = async (sessionID) => {
      try {
        if (!(await loadFs())) return true;
        const path = fsLockPath(sessionID);
        let cur = null;
        try {
          cur = JSON.parse(fsMod.readFileSync(path, "utf8"));
        } catch {}
        const now = Date.now();
        if (
          cur &&
          cur.owner !== instanceID &&
          now - (cur.at ?? 0) < FS_LOCK_TTL_MS
        )
          return false;
        fsMod.writeFileSync(path, JSON.stringify({ owner: instanceID, at: now }));
        return true;
      } catch {
        return true;
      }
    };
    const releaseFsLock = (sessionID) => {
      try {
        if (!fsAvailable) return;
        const path = fsLockPath(sessionID);
        let cur = null;
        try {
          cur = JSON.parse(fsMod.readFileSync(path, "utf8"));
        } catch {
          return;
        }
        if (cur && cur.owner === instanceID) {
          try {
            fsMod.unlinkSync(path);
          } catch {}
        }
      } catch {}
    };
    const createFreshWorker = async (model, targetDir) => {
      if (!model) throw new Error("title model missing");
      const dir = targetDir || owningDir;
      const input = { title: WORKER_TITLE };
      if (model) input.model = { providerID: model.providerID, id: model.id };
      if (dir) input.location = { directory: dir };
      const created = unwrap(await ctx.session.create(input));
      const id = created && created.id;
      if (!id) throw new Error("worker create returned no id");
      try {
        await ctx.session.switchAgent({ sessionID: id, agent: "build" });
      } catch (err) {
        log.debug(`worker switchAgent failed: ${err?.message ?? err}`);
      }
      if (model) {
        try {
          await ctx.session.switchModel({
            sessionID: id,
            model: { providerID: model.providerID, id: model.id },
          });
        } catch (err) {
          log.debug(`worker switchModel failed: ${err?.message ?? err}`);
        }
      }
      workerIDs.add(id);
      log.debug(
        `ephemeral worker created: ${id} in ${dir ?? "default location"}`,
      );
      return id;
    };
    const removeWorker = async (wid) => {
      workerIDs.delete(wid);
      selfGenerating.delete(wid);
      if (!wid) return;
      try {
        await ctx.session.remove({ sessionID: wid });
      } catch (err) {
        log.debug(`worker remove failed: ${err?.message ?? err}`);
      }
    };
    const runWorkerExclusive = (fn) => {
      const p = workerChain.then(fn);
      workerChain = p.catch(() => {});
      return p;
    };
    const sleepAborted = (ms, signal) =>
      new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new Error("aborted"));
        const t = setTimeout(() => {
          signal?.removeEventListener?.("abort", onAbort);
          resolve();
        }, ms);
        const onAbort = () => {
          clearTimeout(t);
          reject(new Error("aborted"));
        };
        signal?.addEventListener?.("abort", onAbort, { once: true });
      });
    const generateWithFallback = async ({
      sessionID,
      model,
      prompt,
      signal,
      targetDir,
    }) => {
      // Inside-only ephemeral worker: fresh project session per run via its
      // primary agent loop, removed after reading so context never grows.
      return await runWorkerExclusive(async () => {
        const wid = await createFreshWorker(model, targetDir);
        if (signal?.aborted) {
          await removeWorker(wid);
          throw new Error("aborted");
        }
        selfGenerating.add(wid);
        try {
          await ctx.session.prompt({ sessionID: wid, text: prompt });
          await ctx.session.wait({ sessionID: wid });
          if (signal?.aborted) throw new Error("aborted");
          const readWorkerText = async () => {
            const msgs = await listMessages(ctx, wid);
            for (let i = msgs.length - 1; i >= 0; i--) {
              const parts = assistantTextParts(msgs[i]);
              if (parts.length) return parts.map((p) => p.text).join("\n");
            }
            return null;
          };
          const first = await readWorkerText();
          if (first) return first;
          // One delayed re-read covers the wait/context visibility race
          // without spending a second worker and inference call.
          await sleepAborted(4000, signal);
          if (signal?.aborted) throw new Error("aborted");
          const second = await readWorkerText();
          if (second) return second;
          throw new Error("worker-empty");
        } finally {
          selfGenerating.delete(wid);
          await removeWorker(wid);
        }
      });
    };

    const eventDir = (event) => {
      return event?.location?.directory;
    };

    const maybeGenerateTitle = async (sessionID) => {
      if (processing.has(sessionID)) return;
      if (workerIDs.has(sessionID)) return;
      if (selfGenerating.has(sessionID)) return;
      const ac = new AbortController();
      processing.set(sessionID, ac);
      const startedAt = Date.now();
      try {
        let session = null;
        try {
          session = await getSession(ctx, sessionID);
        } catch (err) {
          log.debug(
            `getSession failed for ${sessionID}: ${err?.message ?? err}`,
          );
          return;
        }
        if (!session || !isRootSession(session)) return;
        if (
          typeof session.title === "string" &&
          session.title.startsWith("auto-title worker")
        ) {
          workerIDs.add(sessionID);
          return;
        }

        // Direct check: count responses then generate at once when due.
        // No timers and no quiet wait. Every skip leaves a trace.
        let messages = [];
        try {
          messages = await listMessages(ctx, sessionID);
        } catch (err) {
          log.debug(
            `context read failed for ${sessionID}: ${err?.message ?? err}`,
          );
          return;
        }
        const assistantCount = countAssistantResponses(messages);
        const prior = await state.read(sessionID);

        const isInitial = prior?.lastTitleAtAssistantCount == null;
        log.info(
          `check ${sessionID}: assistants=${assistantCount} ` +
            `priorCount=${prior?.lastTitleAtAssistantCount ?? "none"} initial=${isInitial}`,
        );
        await note(sessionID, "run", { assistantCount, isInitial });
        if (
          isInitial &&
          assistantCount < options.initialTitleAtAssistantCount
        ) {
          log.info(
            `skip ${sessionID}: need=${options.initialTitleAtAssistantCount} have=${assistantCount}`,
          );
          await note(sessionID, "skip-count", { assistantCount });
          return;
        }
        if (!isInitial) {
          if (!options.enableRetitle) {
            log.info(`skip ${sessionID}: retitle disabled`);
            await note(sessionID, "skip-disabled", { assistantCount });
            return;
          }
          const delta = assistantCount - (prior.lastTitleAtAssistantCount ?? 0);
          if (assistantCount < (prior.lastTitleAtAssistantCount ?? 0)) {
            // Context compacted or truncated since the last title, so the
            // live count fell below the stored one. Rebase instead of
            // stalling on a negative delta forever.
            log.info(
              `rebase ${sessionID}: count fell ${prior.lastTitleAtAssistantCount} -> ${assistantCount}`,
            );
            await state.write(sessionID, {
              lastTitleAtAssistantCount: assistantCount,
              lastGeneratedAt: prior?.lastGeneratedAt ?? Date.now(),
            });
            await note(sessionID, "rebase", {
              assistantCount,
              storedCount: prior.lastTitleAtAssistantCount ?? 0,
            });
            return;
          }
          if (delta < options.retitleAfterAssistantDelta) {
            log.info(
              `skip ${sessionID}: delta=${delta} need=${options.retitleAfterAssistantDelta}`,
            );
            await note(sessionID, "skip-delta", { assistantCount, delta });
            return;
          }
        }

        const windowSize =
          isInitial ? options.minUserMessages : options.maxUserMessages;
        let firstUserText = "";
        for (const m of messages) {
          const t = userTextOf(m);
          if (t) {
            firstUserText = t;
            break;
          }
        }
        const transcript = extractTranscript(
          messages,
          {
            maxUserMessages: windowSize,
            maxCharsPerMessage: options.maxCharsPerMessage,
            includeOpeningRequest: options.includeOpeningRequest,
          },
          firstUserText,
        );
        if (!transcript) {
          log.info(`skip ${sessionID}: empty transcript`);
          await note(sessionID, "skip-transcript", { assistantCount });
          return;
        }

        const model = await resolveTitleModel(ctx, options, session, log);
        if (!model) {
          log.info(`skip ${sessionID}: no agents.title.model configured`);
          await note(sessionID, "skip-no-title-model", { assistantCount });
          return;
        }
        const lastFailureAt = await getFailureAt(ctx, model);
        if (lastFailureAt && Date.now() - lastFailureAt < COOLDOWN_MS) {
          log.info(`skip ${sessionID}: title model cooling down after 403`);
          await note(sessionID, "skip-cooldown", { assistantCount });
          return;
        }
        if (ac.signal.aborted) return;

        if (!(await claimRun(sessionID))) {
          log.info(`skip ${sessionID}: claimed by another instance`);
          await note(sessionID, "skip-claimed", { assistantCount });
          return;
        }

        if (!(await acquireFsLock(sessionID))) {
          log.info(`skip ${sessionID}: fs-locked by another process`);
          await note(sessionID, "skip-fs-locked", { assistantCount });
          return;
        }

        let raw = "";
        const genStartedAt = Date.now();
        const prompt = buildPrompt(transcript);
        const targetDir =
          session?.directory ?? session?.location?.directory ?? owningDir;
        // Single attempt only: one worker, one inference call. A stall or
        // failure is recorded and the run ends; the next due trigger tries
        // again instead of spending a second worker on a retry.
        const runOnce = () => {
          const genPromise = generateWithFallback({
            sessionID,
            model,
            prompt,
            signal: ac.signal,
            targetDir,
          });
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error("generate-timeout-90s")), 90000),
          );
          // Attach a no-op catch so the loser of the race cannot produce an
          // unhandled rejection after we moved on.
          genPromise.catch(() => {});
          return Promise.race([genPromise, timeoutPromise]);
        };
        try {
          selfGenerating.add(sessionID);
          try {
            try {
              raw = await runOnce();
            } catch (err) {
              if (ac.signal.aborted) throw err;
              if (isAuthFailure(err)) {
                await recordFailure(ctx, model, log);
                log.warn(
                  `title model rejected for ${sessionID}, cooling down: ${err?.message ?? err}`,
                );
                await note(sessionID, "error-auth-cooldown", {
                  assistantCount,
                  ms: Date.now() - genStartedAt,
                  error: String(err?.message ?? err).slice(0, 160),
                });
                return;
              }
              // No retry by design: keep only the first attempt so one title
              // run can never spend a second worker or inference call.
              const failMsg = String(err?.message ?? err).toLowerCase();
              const terminal =
                failMsg.includes("worker-empty") ||
                failMsg.includes("unparseable")
                  ? "error-empty"
                  : "error-generate";
              log.info(
                `no retry for ${sessionID} after: ${err?.message ?? err}`,
              );
              await note(sessionID, terminal, {
                assistantCount,
                ms: Date.now() - genStartedAt,
                error: String(err?.message ?? err).slice(0, 160),
              });
              return;
            }
          } finally {
            selfGenerating.delete(sessionID);
          }
        } catch (err) {
          if (isAuthFailure(err)) await recordFailure(ctx, model, log);
          if (!ac.signal.aborted)
            log.warn(
              `generation failed for ${sessionID}: ${err?.message ?? err}`,
            );
          await note(
            sessionID,
            isAuthFailure(err) ? "error-auth-cooldown" : "error-generate",
            {
              assistantCount,
              ms: Date.now() - genStartedAt,
              error: String(err?.message ?? err).slice(0, 160),
            },
          );
          return;
        }
        if (ac.signal.aborted) return;

        const parsed = parseTitle(raw);
        if (!parsed) {
          log.info(
            `skip ${sessionID}: unparseable output after ${Date.now() - genStartedAt}ms`,
          );
          log.debug(
            `raw title output for ${sessionID}: ${JSON.stringify(raw).slice(0, 200)}`,
          );
          await note(sessionID, "skip-parse", {
            assistantCount,
            ms: Date.now() - genStartedAt,
            raw: String(raw).slice(0, 160),
          });
          return;
        }
        const base = parsed.title;
        await clearFailure(ctx, model);
        // Fresh every run. Every successful run renames with a fresh timestamp.
        // Stored count and stored time both advance, so the next run needs 5 fresh replies
        // instead of looping on the same gap.

        const latest = await state.read(sessionID, true);
        if (
          latest &&
          latest.lastGeneratedAt &&
          latest.lastGeneratedAt > startedAt
        ) {
          log.debug(
            `another instance titled ${sessionID} first; skipping rename`,
          );
          await note(sessionID, "skip-converged", { assistantCount });
          return;
        }

        const finalTitle = `${base} - ${formatTimestamp()}`;
        await renameSession(ctx, sessionID, finalTitle);
        await state.write(sessionID, {
          lastTitleAtAssistantCount: assistantCount,
          lastGeneratedAt: Date.now(),
        });
        await note(sessionID, "titled", {
          assistantCount,
          ms: Date.now() - genStartedAt,
          title: finalTitle,
        });
        log.info(
          `titled session ${sessionID} in ${Date.now() - genStartedAt}ms: ${finalTitle}`,
        );
      } catch (err) {
        if (!ac.signal.aborted)
          log.warn(
            `title flow failed for ${sessionID}: ${err?.message ?? err}`,
          );
      } finally {
        processing.delete(sessionID);
        void releaseClaim(sessionID);
        releaseFsLock(sessionID);
      }
    };

    const watcher = (async () => {
      for await (const event of ctx.event.subscribe({
        signal: controller.signal,
      })) {
        try {
          const dir = eventDir(event);
          if (dir && owningDir && dir !== owningDir) continue;
          const data = event.data;
          const sessionID =
            data && typeof data.sessionID === "string" ? data.sessionID : null;
          if (event.type === "session.deleted") {
            if (!sessionID) continue;
            const c = processing.get(sessionID);
            if (c) {
              try {
                c.abort();
              } catch {}
              processing.delete(sessionID);
            }
            await state.delete(sessionID);
            continue;
          }
          if (!sessionID) continue;
          if (workerIDs.has(sessionID)) continue;
          if (selfGenerating.has(sessionID)) continue;
          if (processing.has(sessionID)) continue;
          // Direct check with no timers. Count gate inside decides.
          void maybeGenerateTitle(sessionID);
        } catch (err) {
          if (!controller.signal.aborted)
            log.warn(`event handling failed: ${err?.message ?? err}`);
        }
      }
    })().catch((err) => {
      if (!controller.signal.aborted)
        log.warn(`event loop stopped: ${err?.message ?? err}`);
    });

    // Suppress both built-in title calls so the ephemeral worker primary is
    // the single model call per title. Workers and real root sessions keep
    // their current title here; the watcher renames via session.update.
    const titleHook = await ctx.session.hook("title", async (event) => {
      try {
        const s = await getSession(ctx, event.sessionID);
        if (!s || typeof s.title !== "string") return;
        if (
          workerIDs.has(event.sessionID) ||
          s.title.startsWith("auto-title worker")
        ) {
          event.result = s.title;
          return;
        }
        if (s.parentID != null) return;
        event.result = s.title;
      } catch {
        return;
      }
    });

    return async () => {
      controller.abort();
      try {
        await titleHook.dispose();
      } catch {}
      await watcher;
      for (const c of processing.values()) {
        try {
          c.abort();
        } catch {}
      }
      processing.clear();
      selfGenerating.clear();
      workerIDs.clear();
    };
  },
});
