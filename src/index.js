import { loadConfig } from "./config.js"
import { findLeak } from "./guard.js"
import { loadKey } from "./key.js"
import { learnModelMade, redactRequest, restoreStrings } from "./messages.js"
import { OriginTracker } from "./origin.js"
import { buildPatternSet } from "./patterns.js"
import { restoreText } from "./restore.js"
import { PlaceholderSession } from "./session.js"
import { createSaver, loadStore, saveStore } from "./store.js"

const LOG = "[vibeguard]"

/** Session hooks that see an LLM request before it is sent: system and messages are redacted here. */
export const REQUEST_HOOKS = ["context", "title", "compaction", "generate"]

/** A secret never belongs in a query to a third-party search service. */
export const NO_RESTORE_TOOLS = new Set(["websearch"])

/**
 * Built-in tools whose input the model writes itself: only their `execute.before` teaches which
 * values the model made up. A Code Mode inner call fires `execute.before` with the outer session
 * id and an input the script built at run time, possibly from real data the provider never saw;
 * MCP and plugin tools are reached that way, so their input is always treated as real data.
 */
export const LEARN_TOOLS = new Set([
  "write", "edit", "multiedit", "patch", "apply_patch", "shell", "bash", "read", "glob", "grep", "list",
  "webfetch", "websearch", "todowrite", "subagent", "task", "execute",
])

/** No readable body is an error, not an empty body: a guard that reads nothing checks nothing. */
async function bodyText(request) {
  if (request && typeof request.clone === "function") return request.clone().text()
  if (request && typeof request.text === "function") return request.text()
  if (request && typeof request.body === "string") return request.body
  throw new Error("vibeguard: cannot read the request body")
}

/** If OpenCode ever sends a request whose hook failed, it goes out empty, whatever shape it has. */
function block(event) {
  for (const key of ["system", "messages"]) {
    const value = event?.[key]
    if (Array.isArray(value)) value.length = 0
    else if (typeof value === "string") event[key] = ""
    else if (value !== null && value !== undefined) event[key] = []
  }
}

/** The text of the first user message: a subagent's is the preamble followed by its prompt. */
function firstUserText(messages) {
  const first = Array.isArray(messages) ? messages.find((m) => m?.role === "user") : undefined
  if (typeof first?.content === "string") return first.content
  return Array.isArray(first?.content) ? first.content.find((p) => p?.type === "text")?.text : undefined
}

/** One `exit` listener for every plugin instance: a pending save must reach the disk. */
const savers = new Set()
function flushOnExit(saver) {
  if (savers.size === 0) process.once("exit", () => { for (const s of savers) s.flush() })
  savers.add(saver)
}

function openStore(config, secret, session, tracker) {
  const payload = loadStore(config.storeFile, secret)
  session.importMappings(payload.mappings)
  tracker.importState(payload)
  const persist = () => {
    session.cleanup()
    tracker.cleanup()
    const state = { mappings: session.exportMappings(), ...tracker.exportState() }
    const merged = saveStore(config.storeFile, secret, state, { ttlMs: config.ttlMs, maxMappings: config.maxMappings })
    // Another process's entries become usable here too.
    session.importMappings(merged.mappings)
    tracker.importState(merged)
    session.dirty = false
    tracker.dirty = false
  }
  session.dirty = false
  tracker.dirty = false
  const saver = createSaver(persist)
  flushOnExit(saver)
  return saver
}

async function setup(ctx) {
  let state
  try {
    const config = await loadConfig(ctx?.location?.directory)
    if (!config.enabled) {
      if (config.debug) console.error(`${LOG} disabled (${config.loadedFrom || "no config"})`)
      return
    }
    const secret = loadKey(config.keyFile)
    const session = new PlaceholderSession({ prefix: config.prefix, ttlMs: config.ttlMs, maxMappings: config.maxMappings, secret })
    const tracker = new OriginTracker({ hashOf: (value) => session.hashOf(value), ttlMs: config.ttlMs })
    const patterns = buildPatternSet(config.patterns)
    state = { config, patterns, session, tracker, saver: config.storeFile ? openStore(config, secret, session, tracker) : null }
  } catch (error) {
    // Fail closed: a guard that cannot start must not let requests through unguarded.
    state = { error }
    console.error(`${LOG} setup failed, every request is blocked: ${error.message}`)
  }

  const ready = () => {
    if (state.error) throw new Error(`vibeguard: ${state.error.message}`)
  }
  const debug = (line) => {
    if (state.config?.debug) console.error(`${LOG} ${line}`)
  }
  /** No session id (an event shape OpenCode does not send today): nothing is model-made. */
  const originOf = (sessionId) => {
    if (typeof sessionId !== "string" || !sessionId) return undefined
    state.tracker.record(sessionId)
    return { sessionId, tracker: state.tracker }
  }
  const changed = () => {
    if (state.saver && (state.session.dirty || state.tracker.dirty)) state.saver.request()
  }

  for (const name of REQUEST_HOOKS) {
    await ctx.session.hook(name, async (event) => {
      try {
        ready()
        state.session.cleanup()
        state.tracker.cleanup()
        const origin = originOf(event.sessionID)
        // Before redaction, so a subagent's first message already sees its parent's values.
        if (origin) state.tracker.linkSubagent(origin.sessionId, firstUserText(event.messages))
        const replaced = redactRequest([event.system, event.messages], state.patterns, state.session, origin)
        debug(`kind=${name} replaced=${replaced}`)
        changed()
      } catch (error) {
        block(event)
        console.error(`${LOG} ${name} request blocked: ${error.message}`)
        throw error
      }
    })
  }

  await ctx.session.hook("http.request", async (event) => {
    ready()
    const leak = findLeak(await bodyText(event.request), state.patterns, state.session, originOf(event.sessionID))
    debug(`kind=${event.kind} guard=${leak ? "BLOCKED" : "clean"}`)
    changed()
    if (leak) throw new Error(`vibeguard: plaintext ${leak.category} in outgoing ${event.kind} request`)
  })

  await ctx.tool.hook("execute.before", async (event) => {
    ready()
    const origin = originOf(event.sessionID)
    // Read before restore: the input is still exactly what the model wrote.
    if (origin && LEARN_TOOLS.has(event.tool)) learnModelMade({ input: event.input }, state.patterns, state.session, origin)
    if (!NO_RESTORE_TOOLS.has(event.tool)) {
      if (typeof event.input === "string") event.input = restoreText(event.input, state.session)
      else restoreStrings(event.input, state.session)
    }
    // The restored prompt is what the subagent receives as its first message.
    if (origin && event.tool === "subagent" && typeof event.input?.prompt === "string") {
      state.tracker.addHandoff(event.input.prompt, origin.sessionId)
    }
    changed()
  })
}

export { setup }
export default { id: "vibeguard", setup }
