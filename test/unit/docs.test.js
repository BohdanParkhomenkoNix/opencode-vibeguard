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

test("package version is 0.3.0", () => {
  assert.equal(JSON.parse(read("package.json")).version, "0.3.0")
})

test("README documents the store, sliding ttl and values the model made up", () => {
  const readme = read("README.md")
  assert.match(readme, /`store_file`[^\n]*~\/\.local\/share\/opencode\/vibeguard\.store/)
  assert.match(readme, /`session\.ttl`[^\n]*unused[^\n]*`30d`/)
  assert.match(readme, /encryption[^\n]*not against a process that can read your whole home directory/)
  assert.match(readme, /made up by the model[^\n]*not masked/)
  assert.match(readme, /subagent whose prompt cannot be matched[^\n]*masks/)
})

test("the example config uses the 30d ttl", () => {
  assert.equal(JSON.parse(read("vibeguard.config.json.example")).session.ttl, "30d")
})

test("the example config shows the default store_file", () => {
  assert.equal(JSON.parse(read("vibeguard.config.json.example")).store_file, "~/.local/share/opencode/vibeguard.store")
})

test("README limits: inputs of MCP or plugin tools are real data", () => {
  assert.match(read("README.md"), /inputs of MCP or plugin tools[^\n]*always treated as real data/)
})

test("README limits: escaped secrets are masked; domain exclude is address-shaped only", () => {
  const readme = read("README.md")
  assert.match(readme, /escaped text[^\n]*masked[^\n]*3 levels/)
  assert.match(readme, /base64[^\n]*not detected/)
  assert.doesNotMatch(readme, /JSON-encoded text[^\n]*is not masked/)
  assert.match(readme, /address- or host-shaped[^\n]*user:pass@localhost[^\n]*masked/)
})

test("README limits: a placeholder restores the exact text it replaced", () => {
  const readme = read("README.md")
  assert.match(readme, /placeholder restores the exact text it replaced[^\n]*JSON-escaped PEM[^\n]*jq -r \.private_key sa\.json > key\.pem/)
})

test("README: exclude normalization, broad entries, local logs", () => {
  const readme = read("README.md")
  assert.match(readme, /leading `@` or `\*\.` is dropped/)
  assert.match(readme, /broad entry[^\n]*exempts every address and host/)
  assert.match(readme, /local logs[^\n]*plaintext/)
  assert.match(readme, /One leading `\*\.` is the only wildcard[^\n]*can never match and is a config error/)
})

test("no orphan screenshot in the repo", () => {
  assert.equal(existsSync(new URL("../../screenshot.png", import.meta.url)), false)
})
