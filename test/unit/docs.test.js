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

test("README documents exclude by domain, ttl 0s and key permissions", () => {
  const readme = read("README.md")
  assert.match(readme, /`patterns\.exclude`[^\n]*domain/)
  assert.match(readme, /`"0s"`[^\n]*never expire/)
  assert.match(readme, /readable by others[^\n]*0600/)
})

test("package version is 0.2.2", () => {
  assert.equal(JSON.parse(read("package.json")).version, "0.2.2")
})

test("README limits: JSON-encoded secrets are blocked, not masked; domain exclude is address-shaped only", () => {
  const readme = read("README.md")
  assert.match(readme, /JSON-encoded[^\n]*block/)
  assert.match(readme, /address- or host-shaped[^\n]*user:pass@localhost[^\n]*masked/)
})
