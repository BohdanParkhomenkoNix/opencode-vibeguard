import { loadConfig } from "./config.js"
import { findLeak } from "./guard.js"
import { loadKey } from "./key.js"
import { redactStrings, restoreStrings } from "./messages.js"
import { buildPatternSet } from "./patterns.js"
import { restoreText } from "./restore.js"
import { PlaceholderSession } from "./session.js"

const LOG = "[vibeguard]"

/** Session hooks that see an LLM request before it is sent: system and messages are redacted here. */
export const REQUEST_HOOKS = ["context", "title", "compaction", "generate"]

/** A secret never belongs in a query to a third-party search service. */
export const NO_RESTORE_TOOLS = new Set(["websearch"])

async function bodyText(request) {
  if (!request) return ""
  if (typeof request.clone === "function") return request.clone().text()
  return typeof request.body === "string" ? request.body : ""
}

/** If OpenCode ever sends a request whose hook failed, it goes out empty. */
function block(event) {
  for (const key of ["system", "messages"]) {
    if (Array.isArray(event?.[key])) event[key].length = 0
  }
}

async function setup(ctx) {
  let state
  try {
    const config = await loadConfig(ctx?.location?.directory)
    if (!config.enabled) {
      if (config.debug) console.error(`${LOG} disabled (${config.loadedFrom || "no config"})`)
      return
    }
    state = {
      config,
      patterns: buildPatternSet(config.patterns),
      session: new PlaceholderSession({
        prefix: config.prefix, ttlMs: config.ttlMs, maxMappings: config.maxMappings, secret: loadKey(config.keyFile),
      }),
    }
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

  for (const name of REQUEST_HOOKS) {
    await ctx.session.hook(name, async (event) => {
      try {
        ready()
        state.session.cleanup()
        const replaced = redactStrings(event.system, state.patterns, state.session) + redactStrings(event.messages, state.patterns, state.session)
        debug(`kind=${name} replaced=${replaced}`)
      } catch (error) {
        block(event)
        console.error(`${LOG} ${name} request blocked: ${error.message}`)
        throw error
      }
    })
  }

  await ctx.session.hook("http.request", async (event) => {
    ready()
    const leak = findLeak(await bodyText(event.request), state.patterns, state.session)
    debug(`kind=${event.kind} guard=${leak ? "BLOCKED" : "clean"}`)
    if (leak) throw new Error(`vibeguard: plaintext ${leak.category} in outgoing ${event.kind} request`)
  })

  await ctx.tool.hook("execute.before", async (event) => {
    ready()
    if (NO_RESTORE_TOOLS.has(event.tool)) return
    if (typeof event.input === "string") event.input = restoreText(event.input, state.session)
    else restoreStrings(event.input, state.session)
  })
}

export { setup }
export default { id: "vibeguard", setup }
