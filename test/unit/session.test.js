import { test } from "node:test"
import assert from "node:assert/strict"
import { PlaceholderSession, getPlaceholderRegex } from "../../src/session.js"

const KEY_A = Buffer.alloc(32, 1)
const KEY_B = Buffer.alloc(32, 2)
const make = (secret = KEY_A, extra = {}) => new PlaceholderSession({ prefix: "__VG_", ttlMs: 60_000, maxMappings: 100, secret, ...extra })

test("same key gives the same placeholder in a fresh instance", () => {
  const first = make().getOrCreatePlaceholder("hunter2", "test")
  assert.equal(make().getOrCreatePlaceholder("hunter2", "test"), first)
  assert.match(first, /^__VG_TEST_[0-9a-f]{12}__$/)
})

test("another key gives another placeholder", () => {
  assert.notEqual(make(KEY_A).getOrCreatePlaceholder("hunter2", "x"), make(KEY_B).getOrCreatePlaceholder("hunter2", "x"))
})

test("a secret is required", () => {
  assert.throws(() => new PlaceholderSession({ prefix: "__VG_" }), /needs a 32-byte secret/)
  assert.throws(() => make(Buffer.alloc(8)), /needs a 32-byte secret/)
})

test("knownEntries lists original and placeholder", () => {
  const s = make()
  const ph = s.getOrCreatePlaceholder("hunter2", "test")
  assert.deepEqual([...s.knownEntries()], [["hunter2", ph]])
  assert.equal(s.lookup(ph), "hunter2")
})

test("expired mappings are dropped by cleanup", () => {
  const s = make(KEY_A, { ttlMs: 1000 })
  const ph = s.getOrCreatePlaceholder("hunter2", "test")
  s.cleanup(Date.now() + 5000)
  assert.equal(s.lookup(ph), undefined)
})

test("the oldest mapping is evicted at max_mappings", () => {
  const s = make(KEY_A, { maxMappings: 1 })
  const first = s.getOrCreatePlaceholder("one", "t")
  s.getOrCreatePlaceholder("two", "t")
  assert.equal(s.lookup(first), undefined)
})

test("placeholder regex finds suffixed placeholders", () => {
  assert.deepEqual("a __VG_X_0123456789ab__ b __VG_X_0123456789ab_2__".match(getPlaceholderRegex("__VG_")).length, 2)
})
