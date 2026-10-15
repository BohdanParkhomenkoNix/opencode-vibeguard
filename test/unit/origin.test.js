import { test } from "node:test"
import assert from "node:assert/strict"
import { OriginTracker, SUBAGENT_PREAMBLE } from "../../src/origin.js"
import { PlaceholderSession } from "../../src/session.js"

const session = new PlaceholderSession({ prefix: "__VG_", ttlMs: 0, maxMappings: 100, secret: Buffer.alloc(32, 4) })
const make = (ttlMs = 0) => new OriginTracker({ hashOf: (v) => session.hashOf(v), ttlMs })
const MADE = "bot@madeup.io"

test("a value is model-made only in the session that made it", () => {
  const o = make()
  o.markModelMade("s1", MADE)
  assert.equal(o.isModelMade("s1", MADE), true)
  assert.equal(o.isModelMade("s2", MADE), false)
  assert.equal(o.isModelMade("s1", "other@x.io"), false)
  assert.equal(o.isModelMadeHash("s1", undefined), false)
})

test("the exported state holds hashes, not values", () => {
  const o = make()
  o.markModelMade("s1", MADE)
  const state = JSON.stringify(o.exportState())
  assert.ok(!state.includes(MADE))
  assert.ok(state.includes(session.hashOf(MADE)))
})

test("a subagent linked through a handoff sees its parent's values, transitively", () => {
  const o = make()
  o.markModelMade("parent", MADE)
  o.addHandoff(`Write ${MADE} to a.txt`, "parent")
  assert.equal(o.linkSubagent("child", `${SUBAGENT_PREAMBLE}Write ${MADE} to a.txt`), true)
  assert.equal(o.isModelMade("child", MADE), true)
  o.addHandoff("go deeper", "child")
  assert.equal(o.linkSubagent("grandchild", `${SUBAGENT_PREAMBLE}go deeper`), true)
  assert.equal(o.isModelMade("grandchild", MADE), true)
})

test("no handoff, another prompt or no preamble: no link", () => {
  const o = make()
  o.markModelMade("parent", MADE)
  o.addHandoff("the prompt", "parent")
  assert.equal(o.linkSubagent("a", `${SUBAGENT_PREAMBLE}another prompt`), false)
  assert.equal(o.linkSubagent("b", "the prompt"), false)
  assert.equal(o.linkSubagent("c", undefined), false)
  for (const id of ["a", "b", "c"]) assert.equal(o.isModelMade(id, MADE), false)
})

test("a link is set once, never to itself, and a cycle from a corrupt store ends the walk", () => {
  const o = make()
  const now = Date.now()
  o.importState({ sessions: { a: { lastUsed: now, parent: "b", model: [] }, b: { lastUsed: now, parent: "a", model: [] } }, handoffs: [] })
  assert.equal(o.isModelMade("a", MADE), false)
  o.addHandoff("p", "z")
  assert.equal(o.linkSubagent("a", `${SUBAGENT_PREAMBLE}p`), false)
  o.addHandoff("q", "self")
  assert.equal(o.linkSubagent("self", `${SUBAGENT_PREAMBLE}q`), false)
})

test("export and import round trip", () => {
  const o = make()
  o.markModelMade("s1", MADE)
  o.addHandoff("p", "s1")
  o.linkSubagent("s2", `${SUBAGENT_PREAMBLE}p`)
  const copy = make()
  copy.importState(JSON.parse(JSON.stringify(o.exportState())))
  assert.equal(copy.isModelMade("s2", MADE), true)
  assert.deepEqual(copy.exportState(), o.exportState())
  copy.importState({ sessions: { bad: null, worse: { lastUsed: "x" } }, handoffs: [null, ["h"], [1, 2, 3]] })
  assert.deepEqual(copy.exportState(), o.exportState())
})

test("sessions and handoffs unused for ttl are dropped", () => {
  const o = make(1000)
  o.markModelMade("s1", MADE)
  o.addHandoff("p", "s1")
  o.cleanup(Date.now() + 5000)
  assert.equal(o.isModelMade("s1", MADE), false)
  assert.deepEqual(o.exportState(), { sessions: {}, handoffs: [] })
})

test("a session renewal sets dirty only when it moves last use forward by 60 s or more; the time always moves", () => {
  const o = make()
  const t0 = 1_000_000
  o.record("s1", t0)
  assert.equal(o.dirty, true)
  o.dirty = false
  o.record("s1", t0 + 59_999)
  assert.equal(o.dirty, false)
  assert.equal(o.exportState().sessions.s1.lastUsed, t0 + 59_999)
  o.record("s1", t0 + 119_998)
  assert.equal(o.dirty, false)
  o.record("s1", t0 + 179_998)
  assert.equal(o.dirty, true)
  assert.equal(o.exportState().sessions.s1.lastUsed, t0 + 179_998)
})

test("a model-made value, a handoff and a link still set dirty at once", () => {
  const o = make()
  o.record("parent")
  o.record("child")
  for (const change of [() => o.markModelMade("parent", MADE), () => o.addHandoff("p", "parent"), () => o.linkSubagent("child", `${SUBAGENT_PREAMBLE}p`)]) {
    o.dirty = false
    change()
    assert.equal(o.dirty, true)
  }
})

test("dirty is set by a change and cleared by the caller", () => {
  const o = make()
  assert.equal(o.dirty, false)
  o.markModelMade("s1", MADE)
  assert.equal(o.dirty, true)
})

test("the first sighting on a session's chain decides, and nothing is written again", () => {
  const o = make()
  o.markInput("s1", MADE)
  o.dirty = false
  o.markModelMade("s1", MADE)
  assert.equal(o.classOf("s1", MADE), "input")
  assert.equal(o.isModelMade("s1", MADE), false)
  assert.equal(o.sessions.get("s1").model.size, 0)
  assert.equal(o.dirty, false)
  o.markModelMade("s2", MADE)
  assert.equal(o.classOf("s2", MADE), "model")
  assert.equal(o.classOf("s1", "other@x.io"), undefined)
  assert.equal(o.classOfHash("s1", undefined), undefined)
})

test("the nearest session on the parent chain decides", () => {
  const o = make()
  o.addHandoff("p", "parent")
  assert.equal(o.linkSubagent("child", `${SUBAGENT_PREAMBLE}p`), true)
  o.markInput("parent", "seen@corp.io")
  o.markModelMade("child", "seen@corp.io")
  assert.equal(o.classOf("child", "seen@corp.io"), "input")
  assert.equal(o.sessions.get("child").model.size, 0)
  o.markModelMade("child", MADE)
  o.markInput("parent", MADE)
  assert.equal(o.classOf("child", MADE), "model")
  assert.equal(o.classOf("parent", MADE), "input")
})

test("input survives export and import; a record without input imports as empty; both sets is input", () => {
  const o = make()
  o.markInput("s1", MADE)
  const copy = make()
  copy.importState(JSON.parse(JSON.stringify(o.exportState())))
  assert.equal(copy.classOf("s1", MADE), "input")
  assert.deepEqual(copy.exportState(), o.exportState())
  const now = Date.now()
  const h = session.hashOf(MADE)
  const old = make()
  old.importState({ sessions: { s1: { lastUsed: now, model: [h] }, s2: { lastUsed: now, model: [h], input: [h, 7] } }, handoffs: [] })
  assert.equal(old.classOf("s1", MADE), "model")
  assert.equal(old.sessions.get("s1").input.size, 0)
  assert.equal(old.classOf("s2", MADE), "input")
  assert.equal(old.sessions.get("s2").input.size, 1)
})
