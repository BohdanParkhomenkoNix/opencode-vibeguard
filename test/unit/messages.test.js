import { test } from "node:test"
import assert from "node:assert/strict"
import { mapStrings, redactRequest, redactStrings, restoreStrings, SKIP_KEYS } from "../../src/messages.js"
import { BUILTIN_NAMES, buildPatternSet } from "../../src/patterns.js"
import { findLeak } from "../../src/guard.js"
import { PlaceholderSession } from "../../src/session.js"

const SECRET = "hunter2-very-secret"
const patterns = buildPatternSet({ keywords: [{ value: SECRET, category: "test" }] })
const session = () => new PlaceholderSession({ prefix: "__VG_", ttlMs: 60_000, maxMappings: 100, secret: Buffer.alloc(32, 7) })
const toolCall = (input) => ({ type: "tool-call", id: "c1", name: "shell", input, providerExecuted: false })
const toolResult = (text) => ({ type: "tool-result", id: "c1", name: "shell", namespace: "builtin", result: { type: "content", value: [{ type: "text", text }] } })
const reasoningPart = (text) => ({ type: "reasoning", text, providerMetadata: {} })

test("system, text, reasoning and tool input/output are all redacted", () => {
  const s = session()
  const system = [{ type: "text", text: `password ${SECRET}` }]
  const messages = [
    { id: "m1", role: "user", content: [{ type: "text", text: `use ${SECRET}` }] },
    { id: "m2", role: "assistant", content: [reasoningPart(`thinking about ${SECRET}`), toolCall({ command: `echo ${SECRET}` }), toolResult(`${SECRET}\n`)] },
  ]
  const changed = redactStrings(system, patterns, s) + redactStrings(messages, patterns, s)
  assert.equal(changed, 5)
  assert.ok(!JSON.stringify({ system, messages }).includes(SECRET))
})

test("service fields are never rewritten", () => {
  const s = session()
  const part = { type: "text", id: SECRET, callID: SECRET, text: SECRET }
  redactStrings([part], patterns, s)
  assert.equal(part.id, SECRET)
  assert.equal(part.callID, SECRET)
  assert.notEqual(part.text, SECRET)
  assert.ok(SKIP_KEYS.has("callID"))
})

test("tool-call id and name are kept while its input is redacted", () => {
  const s = session()
  const part = { type: "tool-call", id: SECRET, name: SECRET, input: { command: SECRET } }
  redactStrings([part], patterns, s)
  assert.equal(part.id, SECRET)
  assert.equal(part.name, SECRET)
  assert.notEqual(part.input.command, SECRET)
  assert.ok(SKIP_KEYS.has("name"))
  assert.ok(SKIP_KEYS.has("namespace"))
})

test("test_class_instances_are_walked", () => {
  class Msg { constructor(role, content) { this.id = "m1"; this.role = role; this.content = content; this.metadata = {} } }
  const msgs = [new Msg("user", [{ type: "text", text: `x ${SECRET}` }])]
  redactStrings(msgs, patterns, session())
  assert.ok(!msgs[0].content[0].text.includes(SECRET))
})

test("redaction is idempotent", () => {
  const s = session()
  const msgs = [{ content: [{ type: "text", text: `a ${SECRET} b` }] }]
  redactStrings(msgs, patterns, s)
  const once = JSON.stringify(msgs)
  assert.equal(redactStrings(msgs, patterns, s), 0)
  assert.equal(JSON.stringify(msgs), once)
})

test("a second pass over redacted text changes nothing, for every builtin and a lookbehind rule", () => {
  const s = session()
  const all = buildPatternSet({
    builtin: BUILTIN_NAMES,
    regex: [{ pattern: String.raw`(?<=API_KEY=)\S+`, category: "ENVKEY" }],
  })
  const samples = [
    "mail dev.user@corp-example.io now",
    "API_KEY=abcdef0123456789xyz",
    "dsn postgres://app:pw0123456789@db.internal.io/app",
    "sk-" + "a1B2c3D4e5F6g7H8i9J0k1L2",
    "sk-ant-" + "a1B2c3D4e5F6g7H8i9J0k1L2",
    "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
    "AKIA" + "ABCDEFGHIJKLMNOP",
    "AIza" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----",
    "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4",
    "uuid 123e4567-e89b-12d3-a456-426614174000",
    "host 10.20.30.40 mac 00:1a:2b:3c:4d:5e",
    "phone 13812345678 id 11010519491231002X",
  ]
  const msgs = [{ content: samples.map((text) => ({ type: "text", text })) }]
  assert.ok(redactStrings(msgs, all, s) > 0)
  const once = JSON.stringify(msgs)
  assert.equal(redactStrings(msgs, all, s), 0)
  assert.equal(JSON.stringify(msgs), once)
})

test("an email-like rule does not match inside a placeholder", () => {
  const s = session()
  const email = buildPatternSet({ builtin: ["email"] })
  const text = "x:__VG_T_0123456789ab__@host.io"
  const msgs = [{ content: [{ type: "text", text }] }]
  assert.equal(redactStrings(msgs, email, s), 0)
  assert.equal(msgs[0].content[0].text, text)
})

test("a lookbehind rule does not re-wrap a placeholder that follows its context", () => {
  const s = session()
  const lookbehind = buildPatternSet({ regex: [{ pattern: String.raw`(?<=API_KEY=)\S+`, category: "ENVKEY" }] })
  const text = "API_KEY=__VG_ENVKEY_0123456789ab__"
  const msgs = [{ content: [{ type: "text", text }] }]
  assert.equal(redactStrings(msgs, lookbehind, s), 0)
  assert.equal(msgs[0].content[0].text, text)
})

test("text around a placeholder is still redacted", () => {
  const s = session()
  const ph = "__VG_T_0123456789ab__"
  const msgs = [{ content: [{ type: "text", text: `${SECRET} ${ph} ${SECRET}` }] }]
  redactStrings(msgs, patterns, s)
  const out = msgs[0].content[0].text
  assert.ok(!out.includes(SECRET))
  assert.ok(out.includes(` ${ph} `))
})

test("a value learned from a context rule is hidden when it appears bare, before or after the context", () => {
  const value = "Zq81LmNp4RtVw2Xy"
  const s = session()
  const lookbehind = buildPatternSet({ regex: [{ pattern: String.raw`(?<=API_KEY=)[A-Za-z0-9]{12,}`, category: "ENVKEY" }] })
  const messages = [
    { role: "user", content: [{ type: "text", text: `earlier output ${value}` }] },
    { role: "user", content: [{ type: "text", text: `API_KEY=${value}` }] },
    { role: "assistant", content: [toolResult(`${value}\n`)] },
  ]
  const system = [{ type: "text", text: `bare ${value}` }]
  const replaced = redactRequest([system, messages], lookbehind, s)
  assert.ok(replaced > 0)
  const body = JSON.stringify({ system, messages })
  assert.ok(!body.includes(value))
  assert.equal(findLeak(body, lookbehind, s), null)
  assert.equal(new Set(body.match(/__VG_ENVKEY_[0-9a-f]{12}__/g)).size, 1)
})

test("restore brings the value back and leaves unknown placeholders", () => {
  const s = session()
  const msgs = [{ content: [{ type: "text", text: SECRET }] }]
  redactStrings(msgs, patterns, s)
  const input = { command: `echo ${msgs[0].content[0].text} __VG_TEST_0123456789ab__` }
  restoreStrings(input, s)
  assert.equal(input.command, `echo ${SECRET} __VG_TEST_0123456789ab__`)
})

test("cycles and binary values are survived", () => {
  const node = { text: SECRET, bytes: new Uint8Array([1, 2]) }
  node.self = node
  assert.equal(mapStrings(node, (x) => x.toUpperCase()), 1)
  assert.equal(node.text, SECRET.toUpperCase())
})

test("skip keys do not protect fields inside tool input and result payloads", () => {
  const s = session()
  const parts = [
    toolCall({ name: SECRET, id: SECRET, command: "x" }),
    { type: "tool-result", id: "c1", name: "shell", result: { type: "content", value: [{ type: "text", text: "ok" }, { name: SECRET }] } },
  ]
  redactStrings(parts, patterns, s)
  assert.ok(!JSON.stringify(parts).includes(SECRET))
  assert.equal(parts[0].id, "c1")
  assert.equal(parts[0].name, "shell")
})

test("strings directly inside arrays are processed", () => {
  const s = session()
  const root = { content: [`a ${SECRET}`, "plain"] }
  assert.equal(redactStrings(root, patterns, s), 1)
  assert.ok(!root.content[0].includes(SECRET))
  assert.equal(root.content[1], "plain")
})

test("restore ignores SKIP_KEYS", () => {
  const s = session()
  const holder = [{ text: SECRET }]
  redactStrings(holder, patterns, s)
  const placeholder = holder[0].text
  const part = { type: "tool-call", id: placeholder, name: placeholder, input: { command: placeholder } }
  restoreStrings(part, s)
  assert.equal(part.id, SECRET)
  assert.equal(part.name, SECRET)
  assert.equal(part.input.command, SECRET)
})
