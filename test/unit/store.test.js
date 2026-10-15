import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createSaver, defaultStoreFile, emptyPayload, loadStore, mergePayloads, open, saveStore, seal } from "../../src/store.js"
import { tmpdir } from "../helpers/tmp.js"

const KEY = Buffer.alloc(32, 5)
const OTHER = Buffer.alloc(32, 6)
const PAYLOAD = {
  mappings: [["__VG_T_0123456789ab__", "hunter2", 1000]],
  sessions: { s1: { lastUsed: 1000, model: ["abcdefabcdef"] } },
  handoffs: [["0123456789ab", "s1", 1000]],
}

test("the default store lives in the XDG data directory, not next to the key", () => {
  assert.equal(defaultStoreFile(), path.join(os.homedir(), ".local", "share", "opencode", "vibeguard.store"))
})

test("seal and open round trip; the sealed text holds no plaintext", () => {
  const text = seal(PAYLOAD, KEY)
  assert.ok(!text.includes("hunter2"))
  assert.equal(JSON.parse(text).v, 1)
  assert.deepEqual(open(text, KEY), PAYLOAD)
})

test("a missing store is empty and logs nothing", (t) => {
  const logs = []
  assert.deepEqual(loadStore(path.join(tmpdir(t), "none.store"), KEY, { log: (l) => logs.push(l) }), emptyPayload())
  assert.deepEqual(logs, [])
})

const flipByte = (file) => {
  const envelope = JSON.parse(seal(PAYLOAD, KEY))
  const data = Buffer.from(envelope.data, "base64")
  data[0] ^= 1
  envelope.data = data.toString("base64")
  writeFileSync(file, JSON.stringify(envelope))
}

for (const [name, write] of [
  ["a flipped byte", flipByte],
  ["another key", (file) => writeFileSync(file, seal(PAYLOAD, OTHER))],
  ["not JSON", (file) => writeFileSync(file, "garbage hunter2")],
  ["a payload of the wrong shape", (file) => writeFileSync(file, seal({ mappings: "x" }, KEY))],
]) {
  test(`${name}: the store is moved aside, loading starts empty, the log holds no bytes`, (t) => {
    const file = path.join(tmpdir(t), "vg.store")
    write(file)
    const logs = []
    assert.deepEqual(loadStore(file, KEY, { log: (l) => logs.push(l), now: () => 42 }), emptyPayload())
    assert.equal(existsSync(file), false)
    assert.ok(existsSync(`${file}.corrupt-42`))
    assert.equal(logs.length, 1)
    assert.match(logs[0], /^\[vibeguard\] store .*vg\.store unreadable \(.+\), moved aside$/)
    assert.ok(!logs[0].includes("hunter2"))
  })
}

test("merge keeps entries from both sides with the later last use", () => {
  const a = { mappings: [["__VG_T_aaaaaaaaaaaa__", "one", 10]], sessions: { s1: { lastUsed: 10, model: ["111111111111"] } }, handoffs: [] }
  const b = {
    mappings: [["__VG_T_aaaaaaaaaaaa__", "one", 20], ["__VG_T_bbbbbbbbbbbb__", "two", 5], ["__VG_T_cccccccccccc__", "one", 30]],
    sessions: { s1: { lastUsed: 5, parent: "p", model: ["222222222222"] }, s2: { lastUsed: 7, model: [] } },
    handoffs: [["dddddddddddd", "s1", 3]],
  }
  const m = mergePayloads(a, b, { now: 30 })
  assert.deepEqual(m.mappings, [["__VG_T_aaaaaaaaaaaa__", "one", 20], ["__VG_T_bbbbbbbbbbbb__", "two", 5]])
  assert.deepEqual({ ...m.sessions.s1, model: [...m.sessions.s1.model].sort() }, { lastUsed: 10, parent: "p", model: ["111111111111", "222222222222"] })
  assert.equal(m.sessions.s2.lastUsed, 7)
  assert.deepEqual(m.handoffs, [["dddddddddddd", "s1", 3]])
})

test("merge drops what expired and caps mappings, least recently used first", () => {
  const a = {
    mappings: [["__VG_T_aaaaaaaaaaaa__", "old", 0], ["__VG_T_bbbbbbbbbbbb__", "mid", 50], ["__VG_T_cccccccccccc__", "new", 90]],
    sessions: { gone: { lastUsed: 0, model: [] } },
    handoffs: [["dddddddddddd", "gone", 0]],
  }
  const m = mergePayloads(a, emptyPayload(), { ttlMs: 60, maxMappings: 1, now: 100 })
  assert.deepEqual(m.mappings, [["__VG_T_cccccccccccc__", "new", 90]])
  assert.deepEqual(Object.keys(m.sessions), [])
  assert.deepEqual(m.handoffs, [])
})

test("save merges with what another process wrote and leaves one 0600 file", (t) => {
  const file = path.join(tmpdir(t), "sub", "vg.store")
  saveStore(file, KEY, { mappings: [["__VG_T_aaaaaaaaaaaa__", "one", 10]], sessions: {}, handoffs: [] }, { now: 20 })
  const merged = saveStore(file, KEY, { mappings: [["__VG_T_bbbbbbbbbbbb__", "two", 15]], sessions: {}, handoffs: [] }, { now: 20 })
  assert.deepEqual(merged.mappings.map(([ph]) => ph).sort(), ["__VG_T_aaaaaaaaaaaa__", "__VG_T_bbbbbbbbbbbb__"])
  assert.equal(loadStore(file, KEY).mappings.length, 2)
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(readdirSync(path.dirname(file)), ["vg.store"])
})

test("100000 mappings save and load in under 3000 ms", (t) => {
  const file = path.join(tmpdir(t), "vg.store")
  const now = Date.now()
  const mappings = Array.from({ length: 100000 }, (_, i) => [`__VG_T_${i.toString(16).padStart(12, "0")}__`, `Fake/${i}/Value+Xy`, now])
  const started = performance.now()
  saveStore(file, KEY, { mappings, sessions: {}, handoffs: [] }, { now })
  assert.equal(loadStore(file, KEY).mappings.length, 100000)
  const elapsed = performance.now() - started
  assert.ok(elapsed < 3000, `save and load took ${elapsed.toFixed(0)} ms`)
})

test("the saver saves at once, then once per window, and flush saves what is pending", () => {
  let clock = 0
  const timers = []
  let saves = 0
  const saver = createSaver(() => saves++, {
    intervalMs: 2000, now: () => clock, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length }, clearTimer: () => {},
  })
  saver.request()
  assert.equal(saves, 1)
  clock = 500
  saver.request()
  saver.request()
  assert.equal(saves, 1)
  assert.equal(timers.length, 1)
  assert.equal(timers[0].ms, 1500)
  clock = 2000
  timers[0].fn()
  assert.equal(saves, 2)
  saver.flush()
  assert.equal(saves, 2)
  clock = 2100
  saver.request()
  assert.equal(saves, 2)
  saver.flush()
  assert.equal(saves, 3)
})

test("a failing save is logged without its message and retried on the next request", () => {
  let clock = 0
  const logs = []
  let calls = 0
  const save = () => {
    calls++
    if (calls === 1) throw Object.assign(new Error("hunter2"), { code: "EACCES" })
  }
  const saver = createSaver(save, { now: () => clock, setTimer: () => 1, clearTimer: () => {}, log: (l) => logs.push(l) })
  saver.request()
  assert.deepEqual(logs, ["[vibeguard] store save failed: EACCES"])
  clock = 5000
  saver.request()
  assert.equal(calls, 2)
})
