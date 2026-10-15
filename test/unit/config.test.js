import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { loadConfig } from "../../src/config.js"
import { tmpdir, withHome } from "../helpers/tmp.js"

function setup(t) {
  const home = tmpdir(t)
  const project = tmpdir(t)
  withHome(t, home)
  const prev = process.env.OPENCODE_VIBEGUARD_CONFIG
  delete process.env.OPENCODE_VIBEGUARD_CONFIG
  t.after(() => {
    if (prev === undefined) delete process.env.OPENCODE_VIBEGUARD_CONFIG
    else process.env.OPENCODE_VIBEGUARD_CONFIG = prev
  })
  const write = (file, value) => {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value))
    return file
  }
  return { home, project, write, global: path.join(home, ".config", "opencode", "vibeguard.config.json") }
}

test("no config anywhere means disabled", async (t) => {
  const { project } = setup(t)
  const cfg = await loadConfig(project)
  assert.equal(cfg.enabled, false)
  assert.equal(cfg.loadedFrom, "")
})

test("project root wins over .opencode and global", async (t) => {
  const { project, write, global } = setup(t)
  write(global, { enabled: true, debug: false })
  write(path.join(project, ".opencode", "vibeguard.config.json"), { enabled: true, debug: false })
  const root = write(path.join(project, "vibeguard.config.json"), { enabled: true, debug: true })
  const cfg = await loadConfig(project)
  assert.equal(cfg.loadedFrom, root)
  assert.equal(cfg.debug, true)
})

test("env path wins over everything", async (t) => {
  const { project, write } = setup(t)
  write(path.join(project, "vibeguard.config.json"), { enabled: false })
  const env = write(path.join(project, "custom.json"), { enabled: true })
  process.env.OPENCODE_VIBEGUARD_CONFIG = env
  assert.equal((await loadConfig(project)).loadedFrom, env)
})

test("an env path to a missing file is an error that names the path only", async (t) => {
  const { project, write, global } = setup(t)
  write(global, { enabled: true })
  const missing = path.join(project, "typo.json")
  process.env.OPENCODE_VIBEGUARD_CONFIG = missing
  await assert.rejects(loadConfig(project), (error) => {
    assert.equal(error.message, `config ${missing}: not found`)
    return true
  })
})

test("defaults: 30d ttl, default key and store, __VG_ prefix", async (t) => {
  const { home, project, write, global } = setup(t)
  write(global, { enabled: true })
  const cfg = await loadConfig(project)
  assert.equal(cfg.ttlMs, 30 * 24 * 60 * 60 * 1000)
  assert.equal(cfg.prefix, "__VG_")
  assert.equal(cfg.keyFile, path.join(home, ".config", "opencode", "vibeguard.key"))
  assert.equal(cfg.storeFile, path.join(home, ".local", "share", "opencode", "vibeguard.store"))
})

test("store_file resolves next to its config, expands ~, and \"\" turns the store off", async (t) => {
  const { home, project, write } = setup(t)
  const local = path.join(project, "vibeguard.config.json")
  write(local, { enabled: true, store_file: "data/vg.store" })
  assert.equal((await loadConfig(project)).storeFile, path.join(project, "data", "vg.store"))
  write(local, { enabled: true, store_file: "~/vg.store" })
  assert.equal((await loadConfig(project)).storeFile, path.join(home, "vg.store"))
  write(local, { enabled: true, store_file: "" })
  assert.equal((await loadConfig(project)).storeFile, "")
  write(local, { enabled: true, store_file: 5 })
  await assert.rejects(loadConfig(project), /store_file must be a string/)
})

test("no config at all still names the default store", async (t) => {
  const { home, project } = setup(t)
  const cfg = await loadConfig(project)
  assert.equal(cfg.enabled, false)
  assert.equal(cfg.storeFile, path.join(home, ".local", "share", "opencode", "vibeguard.store"))
})

test("key_file is resolved next to its config and expands ~", async (t) => {
  const { home, project, write } = setup(t)
  write(path.join(project, "vibeguard.config.json"), { enabled: true, key_file: "keys/k" })
  assert.equal((await loadConfig(project)).keyFile, path.join(project, "keys", "k"))
  write(path.join(project, "vibeguard.config.json"), { enabled: true, key_file: "~/k" })
  assert.equal((await loadConfig(project)).keyFile, path.join(home, "k"))
})

test("broken JSON is an error that does not echo the file", async (t) => {
  const { project, write } = setup(t)
  write(path.join(project, "vibeguard.config.json"), '{ "patterns": { "keywords": [{ "value": "hunter2" ')
  await assert.rejects(loadConfig(project), (error) => {
    assert.match(error.message, /is not valid JSON/)
    assert.doesNotMatch(error.message, /hunter2/)
    return true
  })
})

test("bad field types and durations are errors", async (t) => {
  const { project, write } = setup(t)
  const file = path.join(project, "vibeguard.config.json")
  write(file, { enabled: "yes" })
  await assert.rejects(loadConfig(project), /"enabled" must be a boolean/)
  write(file, { enabled: true, session: { ttl: "forever" } })
  await assert.rejects(loadConfig(project), /session\.ttl/)
  write(file, { enabled: true, session: { max_mappings: 0 } })
  await assert.rejects(loadConfig(project), /session\.max_mappings/)
  write(file, { enabled: true, placeholder_prefix: "bad prefix" })
  await assert.rejects(loadConfig(project), /placeholder_prefix/)
  write(file, { enabled: true, key_file: 7 })
  await assert.rejects(loadConfig(project), /key_file/)
})

test("a ttl error does not echo the value", async (t) => {
  const { project, write } = setup(t)
  write(path.join(project, "vibeguard.config.json"), { enabled: true, session: { ttl: "Leak-Me-42" } })
  await assert.rejects(loadConfig(project), (e) => /session\.ttl must look like 30m, 24h or 7d/.test(e.message) && !e.message.includes("Leak-Me-42"))
})

test("~user/ in key_file is an error", async (t) => {
  const { project, write } = setup(t)
  write(path.join(project, "vibeguard.config.json"), { enabled: true, key_file: "~someone/vibeguard.key" })
  const file = path.join(project, "vibeguard.config.json")
  await assert.rejects(loadConfig(project), (e) => e.message === `config ${file}: only ~/ is supported in key_file`)
})

test("~user/ in OPENCODE_VIBEGUARD_CONFIG is an error", async (t) => {
  const { project } = setup(t)
  process.env.OPENCODE_VIBEGUARD_CONFIG = "~someone/vg.json"
  await assert.rejects(loadConfig(project), /only ~\/ is supported in OPENCODE_VIBEGUARD_CONFIG/)
})
