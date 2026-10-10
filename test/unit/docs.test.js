import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { buildPatternSet } from "../../src/patterns.js"

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8")

test("the example config is valid and uses the token rules", () => {
  const cfg = JSON.parse(read("vibeguard.config.json.example"))
  assert.equal(cfg.enabled, true)
  assert.doesNotThrow(() => buildPatternSet(cfg.patterns))
  for (const rule of ["openai_key", "anthropic_key", "github_token", "aws_access_key", "google_api_key", "private_key", "jwt", "email"]) {
    assert.ok(cfg.patterns.builtin.includes(rule), rule)
  }
})

test("README documents the V2 install line", () => {
  assert.match(read("README.md"), /opencode-vibeguard@git\+https:\/\/github\.com\/BohdanParkhomenkoNix\/opencode-vibeguard\.git/)
  assert.equal(existsSync(new URL("../../README-zh.md", import.meta.url)), false)
})

test("CI runs the unit tests", () => {
  assert.match(read(".github/workflows/test.yml"), /npm test/)
})
