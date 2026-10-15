import { test } from "node:test"
import assert from "node:assert/strict"
import { PlaceholderSession, getPlaceholderRegex, placeholderHash } from "../../src/session.js"

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

test("ttl 0 keeps mappings forever", () => {
  const s = make(KEY_A, { ttlMs: 0 })
  const ph = s.getOrCreatePlaceholder("hunter2", "test")
  s.cleanup(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000)
  assert.equal(s.lookup(ph), "hunter2")
})

test("a 32-character string is not a secret", () => {
  assert.throws(() => make("x".repeat(32)), /needs a 32-byte secret/)
})

test("a mapping in use outlives its creation time plus ttl", () => {
  const s = make(KEY_A, { ttlMs: 1000 })
  const t0 = Date.now()
  const ph = s.getOrCreatePlaceholder("hunter2", "test")
  s.touch(ph, t0 + 900)
  s.cleanup(t0 + 1500)
  assert.equal(s.lookup(ph), "hunter2")
  s.cleanup(t0 + 2500)
  assert.equal(s.lookup(ph), undefined)
})

test("lookup and lookupReverse renew a mapping", () => {
  const s = make(KEY_A, { ttlMs: 1000 })
  const t0 = Date.now()
  const ph = s.getOrCreatePlaceholder("hunter2", "test")
  s.lookup(ph, t0 + 800)
  s.cleanup(t0 + 1700)
  assert.equal(s.lookupReverse("hunter2", t0 + 1700), ph)
  s.cleanup(t0 + 2600)
  assert.equal(s.lookup(ph), "hunter2")
})

test("eviction takes the least recently used mapping", () => {
  const s = make(KEY_A, { maxMappings: 2 })
  const one = s.getOrCreatePlaceholder("one", "t")
  const two = s.getOrCreatePlaceholder("two", "t")
  s.touch(one, Date.now() + 1000)
  s.getOrCreatePlaceholder("three", "t")
  assert.equal(s.lookup(one), "one")
  assert.equal(s.lookup(two), undefined)
})

test("hashOf is the hash a placeholder carries", () => {
  const s = make()
  const ph = s.getOrCreatePlaceholder("hunter2", "test")
  assert.equal(placeholderHash(ph), s.hashOf("hunter2"))
  assert.equal(placeholderHash("__VG_X_0123456789AB_2__"), "0123456789ab")
  assert.equal(placeholderHash("nope"), undefined)
})

test("mappings export and import with their last use", () => {
  const a = make()
  const ph = a.getOrCreatePlaceholder("hunter2", "test")
  const entries = a.exportMappings()
  assert.deepEqual(entries.map(([p, o]) => [p, o]), [[ph, "hunter2"]])
  assert.equal(typeof entries[0][2], "number")
  const b = make()
  b.importMappings(entries)
  assert.equal(b.lookup(ph), "hunter2")
  assert.equal(b.lookupReverse("hunter2"), ph)
})

test("import keeps the later last use and skips malformed or conflicting entries", () => {
  const s = make(KEY_A, { ttlMs: 1000 })
  const ph = s.getOrCreatePlaceholder("hunter2", "test")
  const t0 = Date.now()
  s.importMappings([[ph, "hunter2", t0 + 900], ["bad"], [1, 2, 3], null, [ph, "other", t0], ["__VG_T_aaaaaaaaaaaa__", "hunter2", t0]])
  s.cleanup(t0 + 1500)
  assert.equal(s.lookup(ph), "hunter2")
  assert.equal(s.exportMappings().length, 1)
  s.importMappings("not a list")
})

test("an import over max_mappings keeps the most recently used, in one pass", () => {
  const s = make(KEY_A, { ttlMs: 0, maxMappings: 10000 })
  const t0 = Date.now()
  const ph = (i) => `__VG_T_${i.toString(16).padStart(12, "0")}__`
  // Entry i was used at t0 - 100000 + i; the import order is a fixed shuffle of i.
  const entries = Array.from({ length: 100000 }, (_, k) => (k * 7919) % 100000).map((i) => [ph(i), `value-${i}`, t0 - 100000 + i])
  const started = performance.now()
  s.importMappings(entries)
  assert.equal(s.exportMappings().length, 10000)
  assert.equal(s.lookup(ph(89999), t0 - 1), undefined)
  for (const i of [90000, 95000, 99999]) assert.equal(s.lookup(ph(i), t0 - 100000 + i), `value-${i}`)
  s.getOrCreatePlaceholder("fresh", "t")
  const elapsed = performance.now() - started
  assert.equal(s.exportMappings().length, 10000)
  assert.equal(s.lookupReverse("fresh") !== undefined, true)
  assert.ok(elapsed < 1000, `import and the next placeholder took ${elapsed.toFixed(0)} ms`)
})

test("a renewal sets dirty only when it moves last use forward by 60 s or more; the time always moves", () => {
  const s = make(KEY_A, { ttlMs: 0 })
  const ph = s.getOrCreatePlaceholder("hunter2", "test")
  const t0 = s.exportMappings()[0][2]
  s.dirty = false
  s.touch(ph, t0 + 59_999)
  assert.equal(s.dirty, false)
  assert.equal(s.exportMappings()[0][2], t0 + 59_999)
  s.lookup(ph, t0 + 119_998)
  assert.equal(s.dirty, false)
  assert.equal(s.exportMappings()[0][2], t0 + 119_998)
  s.lookupReverse("hunter2", t0 + 179_998)
  assert.equal(s.dirty, true)
  assert.equal(s.exportMappings()[0][2], t0 + 179_998)
})

test("a new mapping and a drop still set dirty at once", () => {
  const s = make()
  s.getOrCreatePlaceholder("hunter2", "test")
  assert.equal(s.dirty, true)
  s.dirty = false
  s.drop(s.lookupReverse("hunter2"))
  assert.equal(s.dirty, true)
})

test("dirty is set by a change and cleared by the caller", () => {
  const s = make()
  assert.equal(s.dirty, false)
  s.getOrCreatePlaceholder("hunter2", "test")
  assert.equal(s.dirty, true)
  s.dirty = false
  s.lookup("__VG_TEST_000000000000__")
  assert.equal(s.dirty, false)
})
