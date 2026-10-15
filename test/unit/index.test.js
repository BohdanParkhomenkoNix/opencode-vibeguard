import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import plugin, { EXECUTE_IDS, LEARN_TOOLS, REQUEST_HOOKS } from "../../src/index.js"
import { tmpdir, withHome } from "../helpers/tmp.js"

const SECRET = "vg-unit-Secret-91"

function fakeCtx(directory) {
  const hooks = { session: {}, tool: {} }
  const reg = (bucket) => async (name, cb) => { hooks[bucket][name] = cb; return { dispose() {} } }
  return { hooks, ctx: { location: { directory }, session: { hook: reg("session") }, tool: { hook: reg("tool") } } }
}

async function start(t, config) {
  const home = tmpdir(t)
  const project = tmpdir(t)
  withHome(t, home)
  if (config !== undefined) {
    const body = typeof config === "string" ? config : JSON.stringify({ key_file: path.join(home, "k"), store_file: "", ...config })
    writeFileSync(path.join(project, "vibeguard.config.json"), body)
  }
  const { hooks, ctx } = fakeCtx(project)
  await plugin.setup(ctx)
  return hooks
}

const ON = { enabled: true, patterns: { keywords: [{ value: SECRET, category: "test" }] } }
const event = (text) => ({ sessionID: "s1", system: [{ type: "text", text: `sys ${text}` }], messages: [{ role: "user", content: [{ type: "text", text }] }] })

test("plugin shape is V2", () => {
  assert.equal(plugin.id, "vibeguard")
  assert.equal(typeof plugin.setup, "function")
})

test("no config registers nothing", async (t) => {
  const hooks = await start(t)
  assert.deepEqual(hooks, { session: {}, tool: {} })
})

test("all request hooks, the guard and execute.before are registered", async (t) => {
  const hooks = await start(t, ON)
  assert.deepEqual(Object.keys(hooks.session).sort(), [...REQUEST_HOOKS, "http.request"].sort())
  assert.deepEqual(Object.keys(hooks.tool), ["execute.before"])
})

test("context and title hide the secret in system and messages", async (t) => {
  const hooks = await start(t, ON)
  for (const name of ["context", "title"]) {
    const e = event(`token ${SECRET}`)
    await hooks.session[name](e)
    assert.ok(!JSON.stringify(e).includes(SECRET), name)
    assert.match(e.messages[0].content[0].text, /__VG_TEST_[0-9a-f]{12}__/)
  }
})

test("execute.before restores across sessions, except websearch", async (t) => {
  const hooks = await start(t, ON)
  const e = event(SECRET)
  await hooks.session.context(e)
  const ph = e.messages[0].content[0].text
  const shell = { tool: "shell", sessionID: "other-session", input: { command: `echo ${ph}` } }
  await hooks.tool["execute.before"](shell)
  assert.equal(shell.input.command, `echo ${SECRET}`)
  const search = { tool: "websearch", sessionID: "s1", input: { query: ph } }
  await hooks.tool["execute.before"](search)
  assert.equal(search.input.query, ph)
})

test("unknown placeholder is left alone", async (t) => {
  const hooks = await start(t, ON)
  const e = { tool: "shell", input: { command: "echo __VG_TEST_0123456789ab__" } }
  await hooks.tool["execute.before"](e)
  assert.equal(e.input.command, "echo __VG_TEST_0123456789ab__")
})

test("the guard rejects plaintext and passes clean bodies", async (t) => {
  const hooks = await start(t, ON)
  const req = (content) => ({ kind: "primary", request: new Request("http://x/v1/chat/completions", { method: "POST", body: JSON.stringify({ messages: [{ content }] }) }) })
  await hooks.session["http.request"](req("all clean"))
  await assert.rejects(hooks.session["http.request"](req(`leak ${SECRET}`)), (error) => {
    assert.match(error.message, /vibeguard: plaintext TEST in outgoing primary request/)
    assert.ok(!error.message.includes(SECRET))
    return true
  })
})

test("a broken config blocks everything and empties the request", async (t) => {
  const hooks = await start(t, '{ "enabled": true, "patterns": { "regex": [{ "pattern": "(" }] } }')
  const e = event(`token ${SECRET}`)
  await assert.rejects(hooks.session.context(e), /vibeguard: /)
  assert.deepEqual(e.system, [])
  assert.deepEqual(e.messages, [])
  await assert.rejects(hooks.session["http.request"]({ kind: "title", request: new Request("http://x", { method: "POST", body: "{}" }) }), /vibeguard: /)
  await assert.rejects(hooks.tool["execute.before"]({ tool: "shell", input: { command: "ls" } }), /vibeguard: /)
})

test("broken JSON config also blocks, without echoing the file", async (t) => {
  const hooks = await start(t, `{ "patterns": { "keywords": [{ "value": "${SECRET}" `)
  await assert.rejects(hooks.session.context(event("x")), (error) => !error.message.includes(SECRET))
})

test("the guard blocks when the event carries no readable request", async (t) => {
  const hooks = await start(t, ON)
  for (const bad of [{ kind: "primary" }, { kind: "primary", request: {} }, { kind: "primary", request: { body: new Uint8Array(2) } }]) {
    await assert.rejects(hooks.session["http.request"](bad), (error) => {
      assert.match(error.message, /vibeguard: .*request body/)
      return true
    })
  }
})

test("a blocked request leaves a missing, null or undefined system and messages as they are", async (t) => {
  const hooks = await start(t, '{ "enabled": true, "patterns": { "regex": [{ "pattern": "(" }] } }')
  const e = { sessionID: "s1", system: null, messages: undefined }
  await assert.rejects(hooks.session.context(e), /vibeguard: /)
  assert.equal(e.system, null)
  assert.equal(e.messages, undefined)
  const bare = { sessionID: "s1" }
  await assert.rejects(hooks.session.context(bare), /vibeguard: /)
  assert.deepEqual(Object.keys(bare), ["sessionID"])
})

test("the guard accepts an empty body read from a real Request, and a string body", async (t) => {
  const hooks = await start(t, ON)
  await hooks.session["http.request"]({ kind: "title", request: new Request("http://x", { method: "POST", body: "" }) })
  await hooks.session["http.request"]({ kind: "title", request: { body: "{}" } })
  await assert.rejects(hooks.session["http.request"]({ kind: "title", request: { body: `leak ${SECRET}` } }), /plaintext TEST/)
})

test("a blocked request is emptied whatever shape system and messages have", async (t) => {
  const hooks = await start(t, '{ "enabled": true, "patterns": { "regex": [{ "pattern": "(" }] } }')
  const e = { sessionID: "s1", system: `sys ${SECRET}`, messages: { 0: { role: "user", content: SECRET } } }
  await assert.rejects(hooks.session.context(e), /vibeguard: /)
  assert.equal(e.system, "")
  assert.deepEqual(e.messages, [])
})

const MAIL = { enabled: true, store_file: "", patterns: { builtin: ["email"] } }
const MADE = "bot@madeup.io"
const storeOf = (home) => path.join(home, ".local", "share", "opencode", "vibeguard.store")

/** Like start, but in a given home, so two plugin instances can share one store. */
async function startIn(t, home, config) {
  withHome(t, home)
  const project = tmpdir(t)
  writeFileSync(path.join(project, "vibeguard.config.json"), JSON.stringify({ key_file: path.join(home, "k"), ...config }))
  const { hooks, ctx } = fakeCtx(project)
  await plugin.setup(ctx)
  return hooks
}

test("a placeholder restores in a new plugin instance that shares the store", async (t) => {
  const home = tmpdir(t)
  const first = await startIn(t, home, ON)
  const e = event(`token ${SECRET}`)
  await first.session.context(e)
  const ph = e.messages[0].content[0].text.match(/__VG_TEST_[0-9a-f]{12}__/)[0]
  assert.ok(existsSync(storeOf(home)))
  assert.ok(!readFileSync(storeOf(home), "utf8").includes(SECRET))
  const second = await startIn(t, home, ON)
  const shell = { tool: "shell", sessionID: "s9", input: { command: `echo ${ph}` } }
  await second.tool["execute.before"](shell)
  assert.equal(shell.input.command, `echo ${SECRET}`)
})

test("store_file \"\" keeps everything in memory", async (t) => {
  const home = tmpdir(t)
  const hooks = await startIn(t, home, { ...ON, store_file: "" })
  await hooks.session.context(event(`token ${SECRET}`))
  assert.equal(existsSync(storeOf(home)), false)
})

test("a value the model wrote is neither masked nor blocked in its session, and is in another", async (t) => {
  const hooks = await startIn(t, tmpdir(t), MAIL)
  const write = { tool: "write", sessionID: "s1", input: { path: "a.txt", content: `contact ${MADE}` } }
  await hooks.tool["execute.before"](write)
  assert.equal(write.input.content, `contact ${MADE}`)
  const readBack = { sessionID: "s1", system: [], messages: [{ role: "tool", content: [{ type: "tool-result", id: "c", name: "read", result: { type: "text", value: `1: contact ${MADE}` } }] }] }
  await hooks.session.context(readBack)
  assert.equal(readBack.messages[0].content[0].result.value, `1: contact ${MADE}`)
  const req = (sessionID) => ({ sessionID, kind: "primary", request: new Request("http://x/v1/chat/completions", { method: "POST", body: JSON.stringify({ messages: [{ role: "tool", content: `1: contact ${MADE}` }] }) }) })
  await hooks.session["http.request"](req("s1"))
  await assert.rejects(hooks.session["http.request"](req("s2")), /plaintext EMAIL/)
  const other = { sessionID: "s2", system: [], messages: [{ role: "user", content: [{ type: "text", text: MADE }] }] }
  await hooks.session.context(other)
  assert.match(other.messages[0].content[0].text, /__VG_EMAIL_[0-9a-f]{12}__/)
})

test("websearch input is learned from but not restored", async (t) => {
  const hooks = await startIn(t, tmpdir(t), MAIL)
  const search = { tool: "websearch", sessionID: "s1", input: { query: `who is ${MADE}` } }
  await hooks.tool["execute.before"](search)
  assert.equal(search.input.query, `who is ${MADE}`)
  const readBack = { sessionID: "s1", system: [], messages: [{ role: "user", content: [{ type: "text", text: MADE }] }] }
  await hooks.session.context(readBack)
  assert.equal(readBack.messages[0].content[0].text, MADE)
})

test("the input of a tool the model does not call directly is real data: masked and blocked", async (t) => {
  const REAL = "jane.doe@realcorp.io"
  const hooks = await startIn(t, tmpdir(t), MAIL)
  // A Code Mode inner call: the outer session id, an input the script built at run time.
  await hooks.tool["execute.before"]({ tool: "mcp_crm_add", sessionID: "s1", input: { to: REAL } })
  const result = { sessionID: "s1", system: [], messages: [{ role: "tool", content: [{ type: "tool-result", id: "c", name: "execute", result: { type: "text", value: `added ${REAL}` } }] }] }
  await hooks.session.context(result)
  assert.ok(!JSON.stringify(result).includes(REAL))
  assert.match(result.messages[0].content[0].result.value, /__VG_EMAIL_[0-9a-f]{12}__/)
  const req = { sessionID: "s1", kind: "primary", request: new Request("http://x/v1/chat/completions", { method: "POST", body: JSON.stringify({ messages: [{ role: "tool", content: `added ${REAL}` }] }) }) }
  await assert.rejects(hooks.session["http.request"](req), /plaintext EMAIL/)
})

test("a Code Mode inner call named like a built-in is still real data: it shares the outer execute's id", async (t) => {
  const REAL = "jane.doe@realcorp.io"
  const hooks = await startIn(t, tmpdir(t), MAIL)
  // An MCP server `apply` with a tool `patch`, called from the script (docs/v2-facts.md F12).
  await hooks.tool["execute.before"]({ tool: "execute", sessionID: "s1", messageID: "m1", id: "call_7", input: { code: "await tools.apply.patch(await tools.crm.find())" } })
  await hooks.tool["execute.before"]({ tool: "apply_patch", sessionID: "s1", messageID: "m1", id: "call_7", input: { to: REAL } })
  const result = { sessionID: "s1", system: [], messages: [{ role: "tool", content: [{ type: "tool-result", id: "call_7", name: "execute", result: { type: "text", value: `patched ${REAL}` } }] }] }
  await hooks.session.context(result)
  assert.ok(!JSON.stringify(result).includes(REAL))
  // The model's own call under another id still teaches.
  await hooks.tool["execute.before"]({ tool: "write", sessionID: "s1", messageID: "m2", id: "call_8", input: { path: "a.txt", content: MADE } })
  const readBack = { sessionID: "s1", system: [], messages: [{ role: "user", content: [{ type: "text", text: MADE }] }] }
  await hooks.session.context(readBack)
  assert.equal(readBack.messages[0].content[0].text, MADE)
})

test("an inner call still restores placeholders, and the restored value stays a secret", async (t) => {
  const REAL = "jane.doe@realcorp.io"
  const hooks = await startIn(t, tmpdir(t), MAIL)
  const first = { sessionID: "s1", system: [], messages: [{ role: "user", content: [{ type: "text", text: REAL }] }] }
  await hooks.session.context(first)
  const ph = first.messages[0].content[0].text
  await hooks.tool["execute.before"]({ tool: "execute", sessionID: "s1", messageID: "m1", id: "call_7", input: { code: "" } })
  const inner = { tool: "apply_patch", sessionID: "s1", messageID: "m1", id: "call_7", input: { to: ph } }
  await hooks.tool["execute.before"](inner)
  assert.equal(inner.input.to, REAL)
  const later = { sessionID: "s1", system: [], messages: [{ role: "assistant", content: [{ type: "text", text: REAL }] }] }
  await hooks.session.context(later)
  assert.ok(!JSON.stringify(later).includes(REAL))
})

test("an execute call id silences only the same session and message, and only the last EXECUTE_IDS of them", async (t) => {
  const hooks = await startIn(t, tmpdir(t), MAIL)
  const fire = (e) => hooks.tool["execute.before"]({ input: { code: "" }, ...e })
  const learned = async (sessionID, value) => {
    const e = { sessionID, system: [], messages: [{ role: "user", content: [{ type: "text", text: value }] }] }
    await hooks.session.context(e)
    return e.messages[0].content[0].text === value
  }
  await fire({ tool: "execute", sessionID: "s1", messageID: "m1", id: "call_1" })
  await fire({ tool: "write", sessionID: "s2", messageID: "m1", id: "call_1", input: { path: "a", content: "a2@madeup.io" } })
  assert.ok(await learned("s2", "a2@madeup.io"), "another session")
  await fire({ tool: "write", sessionID: "s1", messageID: "m9", id: "call_1", input: { path: "a", content: "a9@madeup.io" } })
  assert.ok(await learned("s1", "a9@madeup.io"), "another message")
  for (let i = 0; i < EXECUTE_IDS; i++) await fire({ tool: "execute", sessionID: "s3", messageID: "m", id: `x${i}` })
  await fire({ tool: "write", sessionID: "s1", messageID: "m1", id: "call_1", input: { path: "a", content: "old@madeup.io" } })
  assert.ok(await learned("s1", "old@madeup.io"), "the oldest id is forgotten")
  await fire({ tool: "write", sessionID: "s3", messageID: "m", id: `x${EXECUTE_IDS - 1}`, input: { path: "a", content: "new@madeup.io" } })
  assert.ok(!(await learned("s3", "new@madeup.io")), "a recent id still marks an inner call")
})

test("LEARN_TOOLS names the built-in tools whose input the model writes itself", () => {
  assert.deepEqual([...LEARN_TOOLS].sort(), ["apply_patch", "bash", "edit", "execute", "glob", "grep", "list", "multiedit", "patch", "read", "shell", "subagent", "task", "todowrite", "webfetch", "websearch", "write"])
})

test("a subagent spawned with a made-up value sees it unmasked", async (t) => {
  const hooks = await startIn(t, tmpdir(t), MAIL)
  const prompt = `Email ${MADE} the report`
  await hooks.tool["execute.before"]({ tool: "subagent", sessionID: "parent", input: { agent: "general", description: "d", prompt } })
  const child = { sessionID: "child", system: [], messages: [{ role: "user", content: [{ type: "text", text: `You are a subagent spawned by another session.\n${prompt}` }] }] }
  await hooks.session.context(child)
  assert.ok(child.messages[0].content[0].text.includes(MADE))
  const stranger = { sessionID: "stranger", system: [], messages: [{ role: "user", content: [{ type: "text", text: `You are a subagent spawned by another session.\nEmail ${MADE} now` }] }] }
  await hooks.session.context(stranger)
  assert.ok(!stranger.messages[0].content[0].text.includes(MADE))
})

test("a corrupt store is moved aside and the plugin still guards", async (t) => {
  const home = tmpdir(t)
  mkdirSync(path.dirname(storeOf(home)), { recursive: true })
  writeFileSync(storeOf(home), "garbage")
  const hooks = await startIn(t, home, ON)
  const e = event(`token ${SECRET}`)
  await hooks.session.context(e)
  assert.ok(!JSON.stringify(e).includes(SECRET))
  assert.ok(readdirSync(path.dirname(storeOf(home))).some((n) => n.startsWith("vibeguard.store.corrupt-")))
})

test("a value restored from a placeholder is a secret in that session, even when the model's call holds it later", async (t) => {
  const REAL = "jane.doe@realcorp.io"
  const hooks = await startIn(t, tmpdir(t), MAIL)
  const first = { sessionID: "A", system: [], messages: [{ role: "user", content: [{ type: "text", text: REAL }] }] }
  await hooks.session.context(first)
  const ph = first.messages[0].content[0].text
  const call = { tool: "shell", sessionID: "B", input: { command: `echo ${ph}` } }
  await hooks.tool["execute.before"](call)
  assert.equal(call.input.command, `echo ${REAL}`)
  const later = { sessionID: "B", system: [], messages: [{ role: "assistant", content: [{ type: "tool-call", id: "c", name: "shell", input: { command: `echo ${REAL}` } }] }] }
  await hooks.session.context(later)
  assert.ok(!JSON.stringify(later).includes(REAL))
})
