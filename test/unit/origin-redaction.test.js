import { test } from "node:test"
import assert from "node:assert/strict"
import { findLeak } from "../../src/guard.js"
import { classify, redactRequest } from "../../src/messages.js"
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
  classify({ input: { path: "a.py", content: `x = "${MADE}"` } }, "model", patterns, session, origin())
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

test("a value known from another session is model-made here when the model writes it first", () => {
  const { session, tracker, origin } = fresh()
  session.getOrCreatePlaceholder(MADE, "email")
  const messages = [assistantText(`mail ${MADE}`)]
  redactRequest([[], messages], patterns, session, origin())
  assert.equal(messages[0].content[0].text, `mail ${MADE}`)
  assert.equal(tracker.isModelMade("s1", MADE), true)
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

const body = (messages) => JSON.stringify({ messages })

test("a secret in session A that the model writes first in session B is masked in A only", () => {
  const { session, tracker, origin } = fresh()
  const a = [readResult(`1: owner ${MADE}`)]
  redactRequest([[], a], patterns, session, origin("A"))
  assert.match(a[0].content[0].result.value, PH)
  const b = [user("make notes"), writeCall(`contact ${MADE}`), readResult(`1: contact ${MADE}`)]
  redactRequest([[], b], patterns, session, origin("B"))
  assert.equal(b[1].content[0].input.content, `contact ${MADE}`)
  assert.equal(b[2].content[0].result.value, `1: contact ${MADE}`)
  assert.equal(tracker.isModelMade("B", MADE), true)
  assert.equal(findLeak(body(b), patterns, session, origin("B")), null)
  assert.equal(findLeak(body(b), patterns, session, origin("A"))?.category, "EMAIL")
  const again = [readResult(`1: owner ${MADE}`)]
  redactRequest([[], again], patterns, session, origin("A"))
  assert.match(again[0].content[0].result.value, PH)
})

test("a value that reaches session B as input first is a secret in B, whatever another session says", () => {
  const { session, origin } = fresh()
  redactRequest([[], [writeCall(MADE)]], patterns, session, origin("A"))
  const b = [readResult(`1: ${MADE}`), assistantText(`saw ${MADE}`)]
  redactRequest([[], b], patterns, session, origin("B"))
  assert.match(b[0].content[0].result.value, PH)
  assert.match(b[1].content[0].text, PH)
  assert.ok(!JSON.stringify(b).includes(MADE))
})

test("a bare value the map learned from a context rule elsewhere is model-made where the model writes it first", () => {
  const { session, tracker, origin } = fresh()
  const SV = /__VG_SECRET_VALUE_[0-9a-f]{12}__/
  redactRequest([[], [readResult(`password = "Fake7pass9word12"`)]], secretValue, session, origin("A"))
  const b = [assistantText("use Fake7pass9word12 as the sample"), readResult("1: Fake7pass9word12")]
  redactRequest([[], b], secretValue, session, origin("B"))
  assert.equal(b[0].content[0].text, "use Fake7pass9word12 as the sample")
  assert.equal(b[1].content[0].result.value, "1: Fake7pass9word12")
  assert.equal(tracker.isModelMade("B", "Fake7pass9word12"), true)
  const c = [readResult("1: Fake7pass9word12")]
  redactRequest([[], c], secretValue, session, origin("C"))
  assert.match(c[0].content[0].result.value, SV)
})

test("a value that arrived only escaped is a secret when the model later writes it plainly", () => {
  const { session, tracker, origin } = fresh()
  const escaped = String.raw`{"note": "password = \"Fake7pass9word12\""}`
  const messages = [readResult(escaped), assistantText(`password = "Fake7pass9word12"`)]
  redactRequest([[], messages], secretValue, session, origin())
  assert.equal(tracker.classOf("s1", "Fake7pass9word12"), "input")
  assert.ok(!JSON.stringify(messages).includes("Fake7pass9word12"))
})

test("a subagent's model writing a value its parent saw as input gets it masked", () => {
  const { session, tracker, origin } = fresh()
  redactRequest([[], [readResult(`1: ${MADE}`)]], patterns, session, origin("parent"))
  tracker.addHandoff("p", "parent")
  tracker.linkSubagent("child", "You are a subagent spawned by another session.\np")
  const child = [assistantText(`mail ${MADE}`)]
  redactRequest([[], child], patterns, session, origin("child"))
  assert.match(child[0].content[0].text, PH)
})

test("a model-made value that contains a shorter secret is masked the way the guard checks it", () => {
  const { session, tracker, origin } = fresh()
  const inner = "inner.secret@corp.io"
  const outer = `x${inner}`
  session.getOrCreatePlaceholder(outer, "email")
  const b = [readResult(inner), assistantText(`mail ${outer}`), readResult(`1: ${outer}`)]
  redactRequest([[], b], patterns, session, origin("B"))
  assert.equal(tracker.classOf("B", inner), "input")
  assert.equal(tracker.classOf("B", outer), "model")
  assert.ok(!JSON.stringify(b).includes(inner))
  assert.equal(findLeak(body(b), patterns, session, origin("B")), null)
})

test("a value the model only extended is not model-made: an email suffix", () => {
  const { session, tracker, origin } = fresh()
  redactRequest([[], [readResult("1: owner bob@corp.io")]], patterns, session, origin("A"))
  const b = [assistantText("ping jimbob@corp.io"), readResult("1: owner bob@corp.io")]
  redactRequest([[], b], patterns, session, origin("B"))
  assert.equal(tracker.classOf("B", "bob@corp.io"), "input")
  assert.match(b[1].content[0].result.value, PH)
  assert.equal(findLeak(body(b), patterns, session, origin("B")), null)
})

test("a value the model only extended is not model-made: an ipv4 prefix", () => {
  const { session, tracker, origin } = fresh()
  const ipv4 = buildPatternSet({ builtin: ["ipv4"] })
  redactRequest([[], [readResult("db_host = 10.20.0.5")]], ipv4, session, origin("A"))
  const b = [assistantText("Example: set host to 10.20.0.50 in staging"), readResult("db_host = 10.20.0.5")]
  redactRequest([[], b], ipv4, session, origin("B"))
  assert.equal(tracker.classOf("B", "10.20.0.5"), "input")
  assert.match(b[1].content[0].result.value, /__VG_IPV4_[0-9a-f]{12}__/)
  assert.equal(findLeak(body(b), ipv4, session, origin("B")), null)
})

test("a known value at the end of a sentence is still whole, so model-made", () => {
  const { session, tracker, origin } = fresh()
  redactRequest([[], [readResult("1: owner bob@corp.io")]], patterns, session, origin("A"))
  const b = [assistantText("mail bob@corp.io."), readResult("1: owner bob@corp.io")]
  redactRequest([[], b], patterns, session, origin("B"))
  assert.equal(tracker.classOf("B", "bob@corp.io"), "model")
  assert.equal(b[1].content[0].result.value, "1: owner bob@corp.io")
})

test("classification over 100000 known mappings stays under 3000 ms", () => {
  const { session, origin } = fresh()
  session.maxMappings = 200000
  for (let i = 0; i < 100000; i++) session.getOrCreatePlaceholder(`user${i}@bulk.io`, "email")
  const messages = [user("hello"), assistantText(`mail ${MADE}`), readResult("1: nothing here")]
  const started = Date.now()
  redactRequest([[], messages], patterns, session, origin())
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`)
})

test("classify builds the known-value index once while the placeholder map is unchanged, and again after any change", () => {
  const { session, tracker, origin } = fresh()
  session.getOrCreatePlaceholder("jane@corp.io", "email")
  let builds = 0
  const entries = session.knownEntries.bind(session)
  session.knownEntries = () => (builds++, entries())
  const call = (text) => classify({ input: text }, "model", patterns, session, origin())
  call("a")
  call("b")
  assert.equal(builds, 1)
  session.getOrCreatePlaceholder("new@corp.io", "email")
  call("new@corp.io")
  assert.equal(builds, 2)
  assert.equal(tracker.classOf("s1", "new@corp.io"), "model")
  session.importMappings([["__VG_EMAIL_aaaaaaaaaaaa__", "imported@corp.io", Date.now()]])
  call("imported@corp.io")
  assert.equal(tracker.classOf("s1", "imported@corp.io"), "model")
  session.drop(session.lookupReverse("new@corp.io"))
  call("c")
  assert.equal(builds, 4)
})
