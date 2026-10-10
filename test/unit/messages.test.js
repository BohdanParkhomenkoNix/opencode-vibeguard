import { test } from "node:test"
import assert from "node:assert/strict"
import { mapStrings, redactStrings, restoreStrings, SKIP_KEYS } from "../../src/messages.js"
import { buildPatternSet } from "../../src/patterns.js"
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
