import { test } from "node:test"
import assert from "node:assert/strict"
import * as nodeFs from "node:fs"
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
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

const withoutKid = (file) => {
  const { kid, ...envelope } = JSON.parse(seal(PAYLOAD, KEY))
  writeFileSync(file, JSON.stringify(envelope))
}

for (const [name, write] of [
  ["a flipped byte", flipByte],
  ["an envelope without a key id", withoutKid],
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
  assert.deepEqual({ ...m.sessions.s1, model: [...m.sessions.s1.model].sort() }, { lastUsed: 10, parent: "p", model: ["111111111111", "222222222222"], input: [] })
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

const corruptFiles = (dir) => readdirSync(dir).filter((n) => n.includes(".corrupt-"))

test("the envelope carries a key id: 16 hex chars, the same for one key, another for another key", () => {
  const kid = JSON.parse(seal(PAYLOAD, KEY)).kid
  assert.match(kid, /^[0-9a-f]{16}$/)
  assert.equal(JSON.parse(seal(emptyPayload(), KEY)).kid, kid)
  assert.notEqual(JSON.parse(seal(PAYLOAD, OTHER)).kid, kid)
})

test("a store sealed with another key is a FOREIGN_KEY error, left in place on load, logged without bytes", (t) => {
  const file = path.join(tmpdir(t), "vg.store")
  const text = seal(PAYLOAD, OTHER)
  writeFileSync(file, text)
  assert.throws(() => open(text, KEY), (error) => error.code === "FOREIGN_KEY" && !error.message.includes("hunter2"))
  const logs = []
  assert.deepEqual(loadStore(file, KEY, { log: (l) => logs.push(l) }), emptyPayload())
  assert.equal(readFileSync(file, "utf8"), text)
  assert.deepEqual(corruptFiles(path.dirname(file)), [])
  assert.deepEqual(logs, [`[vibeguard] store ${file} is sealed with another key; set store_file to keep a separate store for this key`])
})

test("two keys saving alternately into one path never move the store aside; the first key keeps its mappings", (t) => {
  const dir = tmpdir(t)
  const file = path.join(dir, "vg.store")
  const mine = { mappings: [["__VG_T_aaaaaaaaaaaa__", "one", 10]], sessions: {}, handoffs: [] }
  const theirs = { mappings: [["__VG_T_bbbbbbbbbbbb__", "two", 10]], sessions: {}, handoffs: [] }
  const logs = []
  const foreign = createSaver(() => saveStore(file, OTHER, theirs, { now: 20 }), { log: (l) => logs.push(l) })
  for (let round = 0; round < 3; round++) {
    saveStore(file, KEY, mine, { now: 20 })
    assert.throws(() => saveStore(file, OTHER, theirs, { now: 20 }), (error) => error.code === "FOREIGN_KEY")
  }
  foreign.request()
  assert.deepEqual(logs, ["[vibeguard] store save failed: FOREIGN_KEY"])
  assert.deepEqual(corruptFiles(dir), [])
  assert.deepEqual(loadStore(file, KEY).mappings, mine.mappings)
})

test("a store that exists but cannot be read is not overwritten by a save", () => {
  const renames = []
  const writes = []
  const fs = {
    readFileSync() { throw Object.assign(new Error("denied"), { code: "EACCES" }) },
    mkdirSync() {},
    writeFileSync(p) { writes.push(p) },
    chmodSync() {},
    renameSync(from, to) { renames.push([from, to]) },
    unlinkSync() {},
  }
  assert.throws(() => saveStore("/x/vg.store", KEY, PAYLOAD, { fs, log: () => {} }), (error) => error.code === "EACCES")
  assert.deepEqual(renames, [])
  assert.deepEqual(writes, [])
})

/** A real fs with one call replaced, to see which temp file a save writes. */
const spyFs = (overrides) => ({ ...nodeFs, ...overrides })

test("the temp file name has the pid and random bytes", (t) => {
  const file = path.join(tmpdir(t), "vg.store")
  const temps = []
  const fs = spyFs({ writeFileSync: (p, ...rest) => { temps.push(p); return nodeFs.writeFileSync(p, ...rest) } })
  saveStore(file, KEY, PAYLOAD, { now: 1000, fs })
  saveStore(file, KEY, PAYLOAD, { now: 1000, fs })
  for (const temp of temps) {
    const prefix = `${file}.tmp-${process.pid}-`
    assert.ok(temp.startsWith(prefix), temp)
    assert.match(temp.slice(prefix.length), /^[0-9a-f]{8}$/)
  }
  assert.notEqual(temps[0], temps[1])
})

test("a failed write or rename removes the temp file and rethrows", (t) => {
  for (const failing of ["writeFileSync", "renameSync"]) {
    const dir = tmpdir(t)
    const file = path.join(dir, "vg.store")
    const fs = spyFs({
      [failing]: (...args) => {
        if (failing === "writeFileSync") nodeFs.writeFileSync(args[0], "partial")
        throw Object.assign(new Error("disk"), { code: "ENOSPC" })
      },
    })
    assert.throws(() => saveStore(file, KEY, PAYLOAD, { now: 1000, fs }), (error) => error.code === "ENOSPC", failing)
    assert.deepEqual(readdirSync(dir), [], failing)
  }
})

test("a merge keeps the union of each session's input set; a record without input merges as empty", () => {
  const now = Date.now()
  const a = { mappings: [], sessions: { s1: { lastUsed: now, model: ["aaaaaaaaaaaa"], input: ["bbbbbbbbbbbb"] } }, handoffs: [] }
  const b = { mappings: [], sessions: { s1: { lastUsed: now, model: [], input: ["cccccccccccc", 5, "bbbbbbbbbbbb"] }, s2: { lastUsed: now, model: [] } }, handoffs: [] }
  const merged = mergePayloads(a, b, { now })
  assert.deepEqual(merged.sessions.s1.input, ["bbbbbbbbbbbb", "cccccccccccc"])
  assert.deepEqual(merged.sessions.s1.model, ["aaaaaaaaaaaa"])
  assert.deepEqual(merged.sessions.s2.input, [])
})
