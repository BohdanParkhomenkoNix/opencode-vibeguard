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

test("dirty is set by a change and cleared by the caller", () => {
  const o = make()
  assert.equal(o.dirty, false)
  o.markModelMade("s1", MADE)
  assert.equal(o.dirty, true)
})
