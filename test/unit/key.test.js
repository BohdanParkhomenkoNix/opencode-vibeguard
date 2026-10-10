import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs"
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

test("creating a key leaves no temp file", (t) => {
  const dir = tmpdir(t)
  loadKey(path.join(dir, "vibeguard.key"))
  assert.deepEqual(readdirSync(dir), ["vibeguard.key"])
})

test("a key another process linked first is used, not overwritten", (t) => {
  const file = path.join(tmpdir(t), "vibeguard.key")
  const theirs = Buffer.alloc(KEY_BYTES, 7)
  const racing = {
    ...fs,
    linkSync(from, to) {
      fs.writeFileSync(to, theirs, { mode: 0o600 })
      return fs.linkSync(from, to)
    },
  }
  assert.deepEqual(loadKey(file, racing), theirs)
  assert.deepEqual(readdirSync(path.dirname(file)), ["vibeguard.key"])
})

test("a link failure is an error and leaves no temp file", (t) => {
  const dir = tmpdir(t)
  const failing = {
    ...fs,
    linkSync() {
      throw Object.assign(new Error("no hard links here"), { code: "EPERM" })
    },
  }
  assert.throws(() => loadKey(path.join(dir, "vibeguard.key"), failing), /cannot create key file .*: EPERM/)
  assert.deepEqual(readdirSync(dir), [])
})
