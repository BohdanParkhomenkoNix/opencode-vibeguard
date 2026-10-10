import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { KEY_BYTES, defaultKeyFile, loadKey } from "../../src/key.js"
import { tmpdir, withHome } from "../helpers/tmp.js"

test("creates a 32-byte key readable only by the owner", (t) => {
  const file = path.join(tmpdir(t), "nested", "vibeguard.key")
  const key = loadKey(file)
  assert.equal(key.length, KEY_BYTES)
  assert.equal(statSync(file).mode & 0o777, 0o600)
})

test("reuses the key that is already there", (t) => {
  const file = path.join(tmpdir(t), "vibeguard.key")
  assert.deepEqual(loadKey(file), loadKey(file))
})

test("a key of the wrong length is an error", (t) => {
  const file = path.join(tmpdir(t), "vibeguard.key")
  writeFileSync(file, "short")
  assert.throws(() => loadKey(file), /must hold 32 bytes, found 5/)
})

test("an unreadable key path is an error", (t) => {
  const dir = path.join(tmpdir(t), "is-a-dir")
  mkdirSync(dir)
  assert.throws(() => loadKey(dir), /cannot read key file/)
})

test("default key lives in the OpenCode config dir", (t) => {
  const home = tmpdir(t)
  withHome(t, home)
  assert.equal(defaultKeyFile(), path.join(home, ".config", "opencode", "vibeguard.key"))
})
