import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
import { tmpdir, withHome } from "../helpers/tmp.js"

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"))

test("package targets V2 and runs unit tests", () => {
  assert.equal(pkg.name, "opencode-vibeguard")
  assert.equal(pkg.type, "module")
  assert.equal(pkg.main, "./src/index.js")
  assert.equal(pkg.scripts.test, "node --test test/unit/")
  assert.match(pkg.engines.node, />=20/)
})

test("tmp helpers isolate HOME", (t) => {
  const dir = tmpdir(t)
  assert.ok(existsSync(dir))
  withHome(t, dir)
  assert.equal(process.env.HOME, dir)
})
