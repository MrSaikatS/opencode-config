// auto-title — V2 session title plugin (single file, no runtime imports).
//
// Generates a `Category: Description - DD/MM/YYYY h:MMAM/PM` title on the 3rd
// assistant response and re-titles on genuine topic shifts after an idle
// debounce. Overwrites OpenCode's built-in first-response title by design.
//
// Trigger model (verified against OpenCode v2.0.11 — see API_NOTES.md):
// `session.status` / `session.idle` events are never emitted by this server,
// so session activity itself is the heartbeat. Split rule: the first title
// fires fast after the 3rd assistant response with no idle wait; retitles
// keep the full idle debounce plus a `session.wait` quiescence check.
//
// Loader note: the server does not resolve bare specifiers (npm packages) for
// auto-discovered global files, and `Plugin.define()` returns its argument
// unchanged, so this file uses an import-free structural default export.

const PLUGIN_ID = "auto-title"
const STATE_KEY = "auto-title/state/v1"
const WORKER_KEY = "auto-title/worker/v1"
const TRACE_KEY = "auto-title/trace/v1"
const CLAIM_KEY = "auto-title/claim/v1"
const CLAIM_TTL_MS = 120000
const WORKER_TITLE = "auto-title worker managed do not rename"
const SWEEP_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const SWEEP_MAX_ENTRIES = 500
const INITIAL_DEBOUNCE_MS = 3000

const unwrap = (v) => {
  if (v && typeof v === "object" && "data" in v && v.data && typeof v.data === "object") return v.data
  return v
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const defaultOptions = () => {
  return {
    titleModel: undefined,
    smallModel: undefined,
    minUserMessages: 6,
    maxUserMessages: 10,
    maxCharsPerMessage: 1200,
    initialTitleAtAssistantCount: 3,
    retitleAfterAssistantDelta: 3,
    idleDebounceMs: 30000,
    enableRetitle: true,
    includeOpeningRequest: true,
    enabled: true,
  }
}

const fail = (key, why) => {
  throw new Error(`[${PLUGIN_ID}] invalid option "${key}": ${why}`)
}

const validateOptions = (raw) => {
  const o = { ...defaultOptions(), ...(raw ?? {}) }
  if (o.titleModel !== undefined && typeof o.titleModel !== "string" && typeof o.titleModel !== "object") fail("titleModel", "must be a string or {providerID, modelID}")
  if (o.smallModel !== undefined && typeof o.smallModel !== "string") fail("smallModel", "must be a string")
  for (const k of ["minUserMessages", "maxUserMessages"]) {
    if (!Number.isInteger(o[k]) || o[k] < 1 || o[k] > 50) fail(k, "must be an integer 1..50")
  }
  if (o.maxUserMessages < o.minUserMessages) fail("maxUserMessages", "must be >= minUserMessages")
  if (!Number.isInteger(o.maxCharsPerMessage) || o.maxCharsPerMessage < 100 || o.maxCharsPerMessage > 8000) fail("maxCharsPerMessage", "must be an integer 100..8000")
  if (!Number.isInteger(o.initialTitleAtAssistantCount) || o.initialTitleAtAssistantCount < 1) fail("initialTitleAtAssistantCount", "must be an integer >= 1")
  if (!Number.isInteger(o.retitleAfterAssistantDelta) || o.retitleAfterAssistantDelta < 1) fail("retitleAfterAssistantDelta", "must be an integer >= 1")
  if (!Number.isInteger(o.idleDebounceMs) || o.idleDebounceMs < 0 || o.idleDebounceMs > 600000) fail("idleDebounceMs", "must be an integer 0..600000")
  for (const k of ["enableRetitle", "includeOpeningRequest", "enabled"]) {
    if (typeof o[k] !== "boolean") fail(k, "must be a boolean")
  }
  return o
}

// ---------------------------------------------------------------------------
// Pure logic: title parsing / timestamp / transcript / prompts
// ---------------------------------------------------------------------------

const VALID_CATEGORIES = new Set([
  "Feature", "Bugfix", "Refactor", "Docs",
  "Test", "Chore", "Investigation", "Question",
])

const TITLE_LINE_RE = /^([A-Za-z]+):\s*(.+)$/
const TITLE_SUFFIX_RE = /\s*-\s*\d{2}\/\d{2}\/\d{4}\s+\d{1,2}:\d{2}(?:AM|PM)\s*$/

const parseTitle = (raw) => {
  if (typeof raw !== "string") return null
  const line = raw
    .trim()
    .split("\n")
    .map((l) => l.trim().replace(/^["'`]+|["'`.,;]+$/g, ""))
    .find(Boolean)
  if (!line) return null
  const match = stripTimestamp(line).match(TITLE_LINE_RE)
  if (!match) return null
  const lowered = match[1].trim().toLowerCase()
  const category = lowered.charAt(0).toUpperCase() + lowered.slice(1)
  const title = match[2].trim().replace(/^["'`]+|["'`.,;]+$/g, "")
  if (!VALID_CATEGORIES.has(category)) return null
  if (title.length < 3 || title.length > 120) return null
  if (!/[A-Za-z0-9]/.test(title)) return null
  return { category, title }
}

const formatTimestamp = (date = new Date()) => {
  const dd = String(date.getDate()).padStart(2, "0")
  const mm = String(date.getMonth() + 1).padStart(2, "0")
  const yyyy = date.getFullYear()
  let hours = date.getHours()
  const minutes = String(date.getMinutes()).padStart(2, "0")
  const ampm = hours >= 12 ? "PM" : "AM"
  hours = hours % 12 || 12
  return `${dd}/${mm}/${yyyy} ${hours}:${minutes}${ampm}`
}

const stripTimestamp = (title) => {
  return String(title).replace(TITLE_SUFFIX_RE, "").trim()
}

const normalize = (s) => {
  return String(s).toLowerCase().replace(/\s+/g, " ").trim()
}

const assistantTextParts = (msg) => {
  if (!msg || msg.type !== "assistant" || !Array.isArray(msg.content)) return []
  return msg.content.filter(
    (p) => p && p.type === "text" && typeof p.text === "string" && p.text.trim().length > 0,
  )
}

const countAssistantResponses = (messages) => {
  let n = 0
  for (const m of messages) {
    if (assistantTextParts(m).length > 0) n++
  }
  return n
}

const userTextOf = (msg) => {
  if (!msg || msg.type !== "user") return ""
  return typeof msg.text === "string" ? msg.text.trim() : ""
}

const extractTranscript = (messages, opts, firstUserText) => {
  const maxUserMessages = opts.maxUserMessages
  const maxChars = opts.maxCharsPerMessage
  const collected = []
  // messages are oldest-first; walk from the newest end
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = userTextOf(messages[i])
    if (!text) continue
    collected.push(text)
    if (collected.length >= maxUserMessages) break
  }
  collected.reverse()
  const parts = []
  const windowHasOpening =
    firstUserText && collected.some((t) => t === firstUserText)
  if (opts.includeOpeningRequest && firstUserText && !windowHasOpening) {
    const body =
      firstUserText.length > maxChars ? firstUserText.slice(0, maxChars) + "…" : firstUserText
    parts.push(`Opening request:\n${body}`)
  }
  collected.forEach((t, i) => {
    const body = t.length > maxChars ? t.slice(0, maxChars) + "…" : t
    parts.push(`User message ${i + 1}:\n${body}`)
  })
  return parts.join("\n\n")
}

const SYSTEM_PROMPT = `You generate concise session titles for a coding assistant conversation.

Output exactly ONE line, in this exact format:
<Category>: <Description>

Category MUST be one of: Feature, Bugfix, Refactor, Docs, Test, Chore, Investigation, Question
Description MUST be 4-10 words, specific to the conversation's actual subject.
Do NOT include a date, time, timestamp, or trailing punctuation.
Do NOT wrap the output in quotes, backticks, or markdown.
Output only the single line. No preamble, no explanation.

If a previous title is supplied and the conversation topic has NOT materially
shifted, output that previous title unchanged (without any timestamp).
If the topic HAS materially shifted, output a new title.`

const buildPrompt = (prevTitle, transcript) => {
  // ctx.generate.text has no `system` parameter: fold the system prompt in.
  return `${SYSTEM_PROMPT}\n\nPrevious title: ${prevTitle ?? "none"}\n\nConversation (user messages only):\n${transcript}`
}

// ---------------------------------------------------------------------------
// Model resolution: explicit option -> title agent (migrated small_model)
// -> session model -> server default
// ---------------------------------------------------------------------------

const parseModelString = (s) => {
  const i = s.indexOf("/")
  if (i <= 0 || i === s.length - 1) return null
  const rest = s.slice(i + 1)
  const hash = rest.indexOf("#")
  const out = { providerID: s.slice(0, i), id: hash < 0 ? rest : rest.slice(0, hash) }
  if (hash >= 0 && rest.slice(hash + 1)) out.variant = rest.slice(hash + 1)
  return out
}

const normalizeModelRef = (v) => {
  if (!v) return null
  if (typeof v === "string") return parseModelString(v)
  if (typeof v === "object") {
    const providerID = v.providerID ?? v.provider
    const id = v.id ?? v.model ?? v.modelID
    if (typeof providerID === "string" && typeof id === "string") {
      const out = { providerID, id }
      if (typeof v.variant === "string") out.variant = v.variant
      return out
    }
  }
  return null
}

const resolveTitleModel = async (ctx, options, session, log) => {
  // Chain: explicit option, title agent model (migrated small_model),
  // session model, server default. The worker tier runs the resolved model;
  // the final tier uses the session model directly.
  const explicit = normalizeModelRef(options.titleModel ?? options.smallModel)
  if (explicit) {
    log.debug(`model source=explicit ${explicit.providerID}/${explicit.id}`)
    return explicit
  }
  try {
    const agent = await ctx.agent.get({ agentID: "title" })
    // Client-shaped calls wrap payloads in a `data` envelope; unwrap first.
    const info = agent && typeof agent === "object" && "data" in agent ? agent.data : agent
    const ref = normalizeModelRef(info && info.model)
    if (ref) {
      log.debug(`model source=title-agent ${ref.providerID}/${ref.id}`)
      return ref
    }
  } catch (err) {
    log.debug(`title agent lookup failed: ${err?.message ?? err}`)
  }
  const fallback = normalizeModelRef(session && session.model)
  if (fallback) {
    log.debug(`model source=session ${fallback.providerID}/${fallback.id}`)
    return fallback
  }
  log.debug("model source=server-default (omitted)")
  return undefined
}

// ---------------------------------------------------------------------------
// Adapters (only place that touches ctx)
// ---------------------------------------------------------------------------

const makeLogger = () => {
  const p = (level, ...args) => console[level](`[${PLUGIN_ID}]`, ...args)
  return {
    debug: (...a) => p("log", ...a),
    info: (...a) => p("log", ...a),
    warn: (...a) => p("warn", ...a),
    error: (...a) => p("error", ...a),
  }
}

const listMessages = async (ctx, sessionID) => {
  const res = await ctx.session.context({ sessionID })
  return Array.isArray(res) ? res : res && Array.isArray(res.data) ? res.data : []
}

const getSession = async (ctx, sessionID) => {
  return unwrap(await ctx.session.get({ sessionID }))
}

const isRootSession = (session) => {
  return !!session && session.parentID == null
}

const renameSession = async (ctx, sessionID, title) => {
  await ctx.session.update({ sessionID, title })
}

const toText = (res) => {
  if (typeof res === "string") return res
  if (res && typeof res.text === "string") return res.text
  return String(res?.text ?? "")
}

const oneShotText = async (ctx, { model, prompt, signal }) => {
  const input = { prompt }
  if (model) input.model = model
  return toText(await ctx.generate.text(input, { signal }))
}

const sessionGenerateText = async (ctx, { sessionID, prompt, signal }) => {
  return toText(await ctx.session.generate({ sessionID, prompt }, { signal }))
}

const makeStateStore = (ctx, log) => {
  let cache = null // { sessions: Record<id, state> }
  const load = async () => {
    if (cache) return cache
    try {
      const raw = await ctx.storage.get(STATE_KEY)
      cache =
        raw && typeof raw === "object" && raw.sessions && typeof raw.sessions === "object"
          ? { sessions: raw.sessions }
          : { sessions: {} }
    } catch (err) {
      log.warn(`storage read failed, using memory only: ${err?.message ?? err}`)
      cache = { sessions: {} }
    }
    return cache
  }
  const persist = async () => {
    try {
      await ctx.storage.set(STATE_KEY, cache)
    } catch (err) {
      log.warn(`storage write failed: ${err?.message ?? err}`)
    }
  }
  return {
    read: async (sessionID, fresh = false) => {
      if (fresh) cache = null
      const s = (await load()).sessions
      return s[sessionID]
    },
    write: async (sessionID, state) => {
      const s = (await load()).sessions
      s[sessionID] = state
      await persist()
    },
    delete: async (sessionID) => {
      const s = (await load()).sessions
      if (s[sessionID]) {
        delete s[sessionID]
        await persist()
      }
    },
    sweep: async () => {
      const s = (await load()).sessions
      const now = Date.now()
      let changed = false
      for (const [id, st] of Object.entries(s)) {
        if (st && typeof st.lastGeneratedAt === "number" && now - st.lastGeneratedAt > SWEEP_MAX_AGE_MS) {
          delete s[id]
          changed = true
        }
      }
      const ids = Object.entries(s)
        .sort((a, b) => (a[1]?.lastGeneratedAt ?? 0) - (b[1]?.lastGeneratedAt ?? 0))
        .map(([id]) => id)
      while (ids.length > SWEEP_MAX_ENTRIES) {
        delete s[ids.shift()]
        changed = true
      }
      if (changed) await persist()
    },
  }
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

export default {
  id: PLUGIN_ID,
  setup: (ctx) => {
    const options = validateOptions(ctx.options)
    const log = makeLogger()
    if (!options.enabled) {
      log.info(`disabled via options; version=${ctx.app?.version ?? "?"}`)
      return
    }
    log.info(`loaded (app=${ctx.app?.version ?? "?"}, dir=${ctx.location?.directory ?? "?"})`)

    const state = makeStateStore(ctx, log)
    const instanceID = Math.random().toString(36).slice(2) + Date.now().toString(36)
    const idleTimers = new Map()
    const processing = new Map()
    const selfGenerating = new Set()
    const workerIDs = new Set()
    let workerChain = Promise.resolve()
    const controller = new AbortController()
    const owningDir = ctx.location?.directory

    const getStoredWorker = async () => {
      try {
        const raw = await ctx.storage.get(WORKER_KEY)
        return raw && typeof raw.sessionID === "string" ? raw : null
      } catch {
        return null
      }
    }
    const setStoredWorker = async (v) => {
      try {
        await ctx.storage.set(WORKER_KEY, v)
      } catch (err) {
        log.warn(`worker store write failed: ${err?.message ?? err}`)
      }
    }
    // Single flight across stacked instances: the first copy to reach
    // generation claims the run in shared storage. Late copies see a fresh
    // foreign claim and stand down before spending inference. Fail open so
    // a storage hiccup never blocks titles.
    const claimRun = async (sessionID) => {
      try {
        let all = null
        try {
          all = await ctx.storage.get(CLAIM_KEY)
        } catch {}
        if (!all || typeof all !== "object") all = {}
        const now = Date.now()
        const cur = all[sessionID]
        if (cur && cur.owner !== instanceID && now - (cur.at ?? 0) < CLAIM_TTL_MS) return false
        all[sessionID] = { owner: instanceID, at: now }
        await ctx.storage.set(CLAIM_KEY, all)
        return true
      } catch {
        return true
      }
    }
    const verifyClaim = async (sessionID) => {
      try {
        const all = await ctx.storage.get(CLAIM_KEY)
        return all?.[sessionID]?.owner === instanceID
      } catch {
        return true
      }
    }
    const releaseClaim = async (sessionID) => {
      try {
        const all = await ctx.storage.get(CLAIM_KEY)
        if (all && all[sessionID]?.owner === instanceID) {
          delete all[sessionID]
          await ctx.storage.set(CLAIM_KEY, all)
        }
      } catch {}
    }
    // Visible trace: console lines never reach opencode.log, so each run
    // records its decision in storage where the CLI can read it back.
    const note = async (sessionID, decision, extra) => {
      try {
        let all = null
        try {
          all = await ctx.storage.get(TRACE_KEY)
        } catch {}
        if (!all || typeof all !== "object") all = {}
        all[sessionID] = { at: Date.now(), decision, ...(extra ?? {}) }
        const ids = Object.keys(all)
        if (ids.length > 100) {
          ids
            .sort((a, b) => (all[a]?.at ?? 0) - (all[b]?.at ?? 0))
            .slice(0, ids.length - 100)
            .forEach((id) => {
              delete all[id]
            })
        }
        await ctx.storage.set(TRACE_KEY, all)
      } catch (err) {
        log.debug(`trace write failed: ${err?.message ?? err}`)
      }
    }
    const ensureWorker = async (model) => {
      const stored = await getStoredWorker()
      if (stored) {
        try {
          const s = await getSession(ctx, stored.sessionID)
          if (s && s.id) {
            if (model && (s.model?.id !== model.id || s.model?.providerID !== model.providerID)) {
              try {
                await ctx.session.switchModel({
                  sessionID: s.id,
                  model: { providerID: model.providerID, id: model.id },
                })
              } catch (err) {
                log.debug(`worker switchModel failed: ${err?.message ?? err}`)
              }
            }
            workerIDs.add(s.id)
            return s.id
          }
        } catch (err) {
          log.debug(`worker lookup failed, recreating: ${err?.message ?? err}`)
        }
      }
      const input = { title: WORKER_TITLE }
      if (model) input.model = { providerID: model.providerID, id: model.id }
      if (owningDir) input.location = { directory: owningDir }
      const created = unwrap(await ctx.session.create(input))
      const id = created && created.id
      if (!id) throw new Error("worker create returned no id")
      workerIDs.add(id)
      await setStoredWorker({ sessionID: id })
      log.debug(`worker session created: ${id}`)
      return id
    }
    const runWorkerExclusive = (fn) => {
      const p = workerChain.then(fn)
      workerChain = p.catch(() => {})
      return p
    }
    const generateWithFallback = async ({ sessionID, model, prompt, signal }) => {
      // Tier 1: one-shot. Free-tier opencode models always 403 here, so they
      // skip straight to the worker.
      const skipOneShot = !!model && model.providerID === "opencode"
      if (!skipOneShot) {
        try {
          return await oneShotText(ctx, { model, prompt, signal })
        } catch (err) {
          log.debug(`one-shot failed for ${sessionID}, trying worker: ${err?.message ?? err}`)
        }
      }
      // Tier 2: reused worker session under the resolved small model.
      try {
        return await runWorkerExclusive(async () => {
          const wid = await ensureWorker(model)
          if (signal?.aborted) throw new Error("aborted")
          return await sessionGenerateText(ctx, { sessionID: wid, prompt, signal })
        })
      } catch (err) {
        log.debug(`worker failed for ${sessionID}, trying session fallback: ${err?.message ?? err}`)
      }
      // Tier 3: transient generation on the real session (session model).
      return await sessionGenerateText(ctx, { sessionID, prompt, signal })
    }

    void (async () => {
      const w = await getStoredWorker()
      if (w) workerIDs.add(w.sessionID)
    })().catch(() => {})

    const cancelTimer = (sessionID) => {
      const t = idleTimers.get(sessionID)
      if (t) {
        clearTimeout(t)
        idleTimers.delete(sessionID)
      }
    }
    const abortGeneration = (sessionID) => {
      const c = processing.get(sessionID)
      if (c) {
        try {
          c.abort()
        } catch {}
        processing.delete(sessionID)
      }
    }
    const scheduleTitle = (sessionID, delayMs) => {
      cancelTimer(sessionID)
      idleTimers.set(
        sessionID,
        setTimeout(() => {
          idleTimers.delete(sessionID)
          void maybeGenerateTitle(sessionID)
        }, delayMs ?? options.idleDebounceMs),
      )
    }
    // Split rule: untitled sessions fire fast so the first title lands near
    // the 3rd response; titled sessions keep the full idle debounce.
    const scheduleByState = (sessionID) => {
      state
        .read(sessionID)
        .then((prior) => {
          if (prior?.lastTitle) scheduleTitle(sessionID)
          else scheduleTitle(sessionID, Math.min(INITIAL_DEBOUNCE_MS, options.idleDebounceMs))
        })
        .catch(() => scheduleTitle(sessionID))
    }
    const heartbeat = (sessionID) => {
      // Session activity re-arms the debounce: while the conversation is
      // alive, events keep arriving and the timer never fires. New activity
      // aborts any in-flight generation for a stale turn — unless the
      // activity is our own session.generate fallback call.
      if (!selfGenerating.has(sessionID)) abortGeneration(sessionID)
      scheduleByState(sessionID)
    }

    const eventDir = (event) => {
      return event?.location?.directory
    }

    const maybeGenerateTitle = async (sessionID) => {
      if (processing.has(sessionID)) return
      if (workerIDs.has(sessionID)) return
      const ac = new AbortController()
      processing.set(sessionID, ac)
      const startedAt = Date.now()
      try {
        let session = null
        try {
          session = await getSession(ctx, sessionID)
        } catch (err) {
          log.debug(`getSession failed for ${sessionID}: ${err?.message ?? err}`)
          return
        }
        if (!session || !isRootSession(session)) return
        if (typeof session.title === "string" && session.title.startsWith("auto-title worker")) {
          workerIDs.add(sessionID)
          return
        }

        // Read-then-gate: count responses before spending any idle wait,
        // so the first title can fire fast and every skip leaves a trace.
        let messages = []
        try {
          messages = await listMessages(ctx, sessionID)
        } catch (err) {
          log.debug(`context read failed for ${sessionID}: ${err?.message ?? err}`)
          return
        }
        const assistantCount = countAssistantResponses(messages)
        const prior = await state.read(sessionID)

        const isInitial = !prior?.lastTitle
        log.info(
          `check ${sessionID}: assistants=${assistantCount} ` +
            `prior=${prior?.lastTitle ?? "none"} initial=${isInitial}`,
        )
        await note(sessionID, "run", { assistantCount, isInitial })
        if (isInitial && assistantCount < options.initialTitleAtAssistantCount) {
          log.info(
            `skip ${sessionID}: need=${options.initialTitleAtAssistantCount} have=${assistantCount}`,
          )
          await note(sessionID, "skip-count", { assistantCount })
          return
        }
        if (!isInitial) {
          if (!options.enableRetitle) {
            log.info(`skip ${sessionID}: retitle disabled`)
            await note(sessionID, "skip-disabled", { assistantCount })
            return
          }
          const delta = assistantCount - (prior.lastTitleAtAssistantCount ?? 0)
          if (assistantCount < (prior.lastTitleAtAssistantCount ?? 0)) {
            // Context compacted or truncated since the last title, so the
            // live count fell below the stored one. Rebase instead of
            // stalling on a negative delta forever.
            log.info(
              `rebase ${sessionID}: count fell ${prior.lastTitleAtAssistantCount} -> ${assistantCount}`,
            )
            await state.write(sessionID, { ...prior, lastTitleAtAssistantCount: assistantCount })
            await note(sessionID, "rebase", {
              assistantCount,
              storedCount: prior.lastTitleAtAssistantCount ?? 0,
            })
            return
          }
          if (delta < options.retitleAfterAssistantDelta) {
            log.info(
              `skip ${sessionID}: delta=${delta} need=${options.retitleAfterAssistantDelta}`,
            )
            await note(sessionID, "skip-delta", { assistantCount, delta })
            return
          }
          // Retitle idle guard: only spend inference once the session is
          // actually quiescent. The first title skips this by design.
          try {
            await ctx.session.wait({ sessionID }, { signal: ac.signal })
          } catch (err) {
            if (!ac.signal.aborted) log.debug(`wait failed for ${sessionID}: ${err?.message ?? err}`)
            return
          }
          if (ac.signal.aborted) return
        }

        const windowSize = isInitial ? options.minUserMessages : options.maxUserMessages
        let firstUserText = ""
        for (const m of messages) {
          const t = userTextOf(m)
          if (t) {
            firstUserText = t
            break
          }
        }
        const transcript = extractTranscript(
          messages,
          { maxUserMessages: windowSize, maxCharsPerMessage: options.maxCharsPerMessage, includeOpeningRequest: options.includeOpeningRequest },
          firstUserText,
        )
        if (!transcript) {
          log.info(`skip ${sessionID}: empty transcript`)
          await note(sessionID, "skip-transcript", { assistantCount })
          return
        }

        const prevTitle = prior?.lastTitle ? stripTimestamp(prior.lastTitle) : null
        const model = await resolveTitleModel(ctx, options, session, log)
        if (ac.signal.aborted) return

        if (!(await claimRun(sessionID))) {
          log.info(`skip ${sessionID}: claimed by another instance`)
          await note(sessionID, "skip-claimed", { assistantCount })
          return
        }

        // Small jitter + claim verify + fresh-state re-read so concurrent
        // instances converge instead of rename-storming.
        await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 2000)))
        if (ac.signal.aborted) return
        if (!(await verifyClaim(sessionID))) {
          log.info(`skip ${sessionID}: lost claim to another instance`)
          await note(sessionID, "skip-claimed", { assistantCount })
          return
        }

        let raw = ""
        const genStartedAt = Date.now()
        const prompt = buildPrompt(prevTitle, transcript)
        // One attempt races generation against a 45s timeout. Title calls
        // normally take ~30s, so a stall gets one retry on a fresh worker
        // instead of failing the whole run.
        const runOnce = () => {
          const genPromise = generateWithFallback({
            sessionID,
            model,
            prompt,
            signal: ac.signal,
          })
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error("generate-timeout-45s")), 45000),
          )
          // Attach a no-op catch so the loser of the race cannot produce an
          // unhandled rejection after we moved on.
          genPromise.catch(() => {})
          return Promise.race([genPromise, timeoutPromise])
        }
        try {
          selfGenerating.add(sessionID)
          try {
            try {
              raw = await runOnce()
            } catch (err) {
              if (ac.signal.aborted) throw err
              log.debug(`generate retry for ${sessionID} after: ${err?.message ?? err}`)
              await setStoredWorker(null)
              if (ac.signal.aborted) throw err
              raw = await runOnce()
            }
          } finally {
            selfGenerating.delete(sessionID)
          }
        } catch (err) {
          if (!ac.signal.aborted) log.warn(`generation failed for ${sessionID}: ${err?.message ?? err}`)
          await note(sessionID, "error-generate", {
            assistantCount,
            ms: Date.now() - genStartedAt,
            error: String(err?.message ?? err).slice(0, 160),
          })
          return
        }
        if (ac.signal.aborted) return

        const parsed = parseTitle(raw)
        if (!parsed) {
          log.info(`skip ${sessionID}: unparseable output after ${Date.now() - genStartedAt}ms`)
          log.debug(`raw title output for ${sessionID}: ${JSON.stringify(raw).slice(0, 200)}`)
          await note(sessionID, "skip-parse", {
            assistantCount,
            ms: Date.now() - genStartedAt,
            raw: String(raw).slice(0, 160),
          })
          return
        }
        const base = `${parsed.category}: ${parsed.title}`
        if (prevTitle && normalize(base) === normalize(prevTitle)) {
          log.info(`skip ${sessionID}: topic unchanged, keeps "${prevTitle}"`)
          await note(sessionID, "skip-same-topic", { assistantCount, base })
          return
        }

        const latest = await state.read(sessionID, true)
        if (latest && latest.lastGeneratedAt && latest.lastGeneratedAt > startedAt) {
          log.debug(`another instance titled ${sessionID} first; skipping rename`)
          await note(sessionID, "skip-converged", { assistantCount })
          return
        }

        const finalTitle = `${base} - ${formatTimestamp()}`
        await renameSession(ctx, sessionID, finalTitle)
        await state.write(sessionID, {
          lastTitle: base,
          lastTitleAtAssistantCount: assistantCount,
          lastGeneratedAt: Date.now(),
        })
        await note(sessionID, "titled", {
          assistantCount,
          ms: Date.now() - genStartedAt,
          title: finalTitle,
        })
        log.info(`titled session ${sessionID} in ${Date.now() - genStartedAt}ms: ${finalTitle}`)
      } catch (err) {
        if (!ac.signal.aborted) log.warn(`title flow failed for ${sessionID}: ${err?.message ?? err}`)
      } finally {
        processing.delete(sessionID)
        void releaseClaim(sessionID)
      }
    }

    const watcher = (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        try {
          const dir = eventDir(event)
          if (dir && owningDir && dir !== owningDir) continue
          const data = event.data
          const sessionID = data && typeof data.sessionID === "string" ? data.sessionID : null
          if (event.type === "session.deleted") {
            if (!sessionID) continue
            cancelTimer(sessionID)
            abortGeneration(sessionID)
            await state.delete(sessionID)
            continue
          }
          if (!sessionID) continue
          if (workerIDs.has(sessionID)) continue
          if (event.type === "session.status" && data?.status?.type === "idle") {
            scheduleByState(sessionID)
          } else if (event.type === "session.idle") {
            scheduleByState(sessionID)
          } else if (event.type === "session.status") {
            cancelTimer(sessionID)
            abortGeneration(sessionID)
          } else {
            // No status/idle events on current servers: any session activity
            // is the heartbeat that re-arms the debounce.
            heartbeat(sessionID)
          }
        } catch (err) {
          if (!controller.signal.aborted) log.warn(`event handling failed: ${err?.message ?? err}`)
        }
      }
    })().catch((err) => {
      if (!controller.signal.aborted) log.warn(`event loop stopped: ${err?.message ?? err}`)
    })

    void state.sweep().catch((err) => log.warn(`sweep failed: ${err?.message ?? err}`))

    return async () => {
      controller.abort()
      await watcher
      for (const t of idleTimers.values()) clearTimeout(t)
      idleTimers.clear()
      for (const c of processing.values()) {
        try {
          c.abort()
        } catch {}
      }
      processing.clear()
      selfGenerating.clear()
      workerIDs.clear()
    }
  },
}
