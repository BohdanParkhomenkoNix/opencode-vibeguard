import { test } from "node:test"
import assert from "node:assert/strict"
import { learnModelMade, redactRequest } from "../../src/messages.js"
import { OriginTracker } from "../../src/origin.js"
import { buildPatternSet } from "../../src/patterns.js"
import { PlaceholderSession } from "../../src/session.js"

const patterns = buildPatternSet({ builtin: ["email"] })
const secretValue = buildPatternSet({ regex: [{ pattern: String.raw`(?<=password["']?\s*[:=]\s*["']?)[A-Za-z0-9]{12,}`, category: "secret_value" }] })
const MADE = "bot@madeup.io"
const PH = /__VG_EMAIL_[0-9a-f]{12}__/

function fresh() {
  const session = new PlaceholderSession({ prefix: "__VG_", ttlMs: 0, maxMappings: 1000, secret: Buffer.alloc(32, 8) })
  const tracker = new OriginTracker({ hashOf: (v) => session.hashOf(v), ttlMs: 0 })
  return { session, tracker, origin: (sessionId = "s1") => ({ sessionId, tracker }) }
}
const user = (text) => ({ role: "user", content: [{ type: "text", text }] })
const assistantText = (text) => ({ role: "assistant", content: [{ type: "text", text }] })
const writeCall = (content) => ({ role: "assistant", content: [{ type: "tool-call", id: "c1", name: "write", input: { path: "notes.py", content } }] })
const readResult = (text) => ({ role: "tool", content: [{ type: "tool-result", id: "c2", name: "read", result: { type: "text", value: text } }] })

test("a value the model wrote first is masked neither in its call nor in the read-back", () => {
  const { session, origin } = fresh()
  const messages = [user("make notes"), writeCall(`contact ${MADE}`), readResult(`1: contact ${MADE}`)]
  redactRequest([[], messages], patterns, session, origin())
  assert.equal(messages[1].content[0].input.content, `contact ${MADE}`)
  assert.equal(messages[2].content[0].result.value, `1: contact ${MADE}`)
  assert.equal([...session.knownEntries()].length, 0)
})

test("a value sent to the model first stays a secret when the model repeats it", () => {
  const { session, origin } = fresh()
  const messages = [readResult(`1: owner ${MADE}`), assistantText(`I see ${MADE}`)]
  redactRequest([[], messages], patterns, session, origin())
  assert.match(messages[0].content[0].result.value, PH)
  assert.match(messages[1].content[0].text, PH)
  assert.ok(!JSON.stringify(messages).includes(MADE))
})

test("the system prompt counts as sent to the model first", () => {
  const { session, origin } = fresh()
  const system = [{ type: "text", text: `git user ${MADE}` }]
  const messages = [assistantText(`hi ${MADE}`)]
  redactRequest([system, messages], patterns, session, origin())
  assert.ok(!JSON.stringify([system, messages]).includes(MADE))
})

test("a model-made value is masked in another session", () => {
  const { session, origin } = fresh()
  redactRequest([[], [writeCall(MADE)]], patterns, session, origin("s1"))
  const other = [user(`cat notes: ${MADE}`)]
  redactRequest([[], other], patterns, session, origin("s2"))
  assert.match(other[0].content[0].text, PH)
})

test("a value in a tool input is model-made before any request carries it", () => {
  const { session, tracker, origin } = fresh()
  learnModelMade({ input: { path: "a.py", content: `x = "${MADE}"` } }, patterns, session, origin())
  assert.equal(tracker.isModelMade("s1", MADE), true)
  const messages = [readResult(`1: x = "${MADE}"`)]
  redactRequest([[], messages], patterns, session, origin())
  assert.ok(messages[0].content[0].result.value.includes(MADE))
})

test("an escaped spelling of a model-made value in a read-back is left as it is", () => {
  const { session, origin } = fresh()
  const notebook = String.raw`1: {"cells": [{"source": ["password = \"Fake7pass9word12\"\n"]}]}`
  const messages = [writeCall(`password = "Fake7pass9word12"`), readResult(notebook)]
  redactRequest([[], messages], secretValue, session, origin())
  assert.equal(messages[1].content[0].result.value, notebook)
  assert.equal([...session.knownEntries()].length, 0)
})

test("placeholders in the model's output are not learned as values", () => {
  const { session, tracker, origin } = fresh()
  const ph = session.getOrCreatePlaceholder("real@corp.io", "email")
  redactRequest([[], [assistantText(`mail ${ph}`)]], patterns, session, origin())
  assert.equal(tracker.sessions.get("s1")?.model.size ?? 0, 0)
})

test("without a session id nothing is model-made, as in 0.2.6", () => {
  const { session } = fresh()
  const messages = [writeCall(MADE), readResult(MADE)]
  redactRequest([[], messages], patterns, session)
  assert.ok(!JSON.stringify(messages).includes(MADE))
})

test("a known secret the model outputs stays a secret", () => {
  const { session, tracker, origin } = fresh()
  session.getOrCreatePlaceholder(MADE, "email")
  const messages = [assistantText(`mail ${MADE}`)]
  redactRequest([[], messages], patterns, session, origin())
  assert.match(messages[0].content[0].text, PH)
  assert.equal(tracker.isModelMade("s1", MADE), false)
})

test("a model-made value that became a secret in another session is not replaced here", () => {
  const { session, origin } = fresh()
  redactRequest([[], [writeCall(MADE)]], patterns, session, origin("s1"))
  redactRequest([[], [user(MADE)]], patterns, session, origin("s2"))
  const messages = [readResult(`1: ${MADE}`)]
  redactRequest([[], messages], patterns, session, origin("s1"))
  assert.equal(messages[0].content[0].result.value, `1: ${MADE}`)
})

test("a root of plain strings is still redacted", () => {
  const { session, origin } = fresh()
  const system = [`git user ${MADE}`]
  redactRequest([system, []], patterns, session, origin())
  assert.match(system[0], PH)
})
