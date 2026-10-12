import { test } from "node:test"
import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import path from "node:path"
import plugin, { REQUEST_HOOKS } from "../../src/index.js"
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
    const body = typeof config === "string" ? config : JSON.stringify({ key_file: path.join(home, "k"), ...config })
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
