import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { defaultStoreFile, emptyPayload, loadStore, open, seal } from "../../src/store.js"
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
