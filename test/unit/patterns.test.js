import { test } from "node:test"
import assert from "node:assert/strict"
import { buildPatternSet, BUILTIN_NAMES } from "../../src/patterns.js"
import { redactText } from "../../src/engine.js"

function hits(text, builtin) {
  const found = []
  redactText(text, buildPatternSet({ builtin }), {
    getOrCreatePlaceholder(original, category) { found.push({ original, category }); return "X" },
  })
  return found
}

const SAMPLES = {
  openai_key: [`key sk-proj-${"Ab3".repeat(16)} end`, "OPENAI_KEY"],
  anthropic_key: [`sk-ant-api03-${"Xy9_".repeat(20)}`, "ANTHROPIC_KEY"],
  github_token: [`token=ghp_${"aB3d".repeat(9)}`, "GITHUB_TOKEN"],
  aws_access_key: ["id AKIAIOSFODNN7EXAMPLE x", "AWS_ACCESS_KEY"],
  google_api_key: [`AIza${"Sy0_-".repeat(7)}`, "GOOGLE_API_KEY"],
  private_key: ["-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----", "PRIVATE_KEY"],
  jwt: ["Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "JWT"],
}

for (const [name, [text, category]] of Object.entries(SAMPLES)) {
  test(`${name} catches its real format`, () => {
    const found = hits(text, [name])
    assert.equal(found.length, 1)
    assert.equal(found[0].category, category)
  })
}

test("private_key takes the whole block", () => {
  assert.equal(hits(SAMPLES.private_key[0], ["private_key"])[0].original, SAMPLES.private_key[0])
})

test("an Anthropic key is not reported as an OpenAI key", () => {
  assert.deepEqual(hits(SAMPLES.anthropic_key[0], ["openai_key"]), [])
})

test("lookalikes are left alone", () => {
  const all = Object.keys(SAMPLES)
  for (const text of ["task-runner-configuration-file-name", "sk-learn", "ghp_short", "AKIA1234", "AIzaShort",
    "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----", "eyJhbGciOi"]) {
    assert.deepEqual(hits(text, all), [], text)
  }
})

test("every new rule is a known builtin", () => {
  for (const name of [...Object.keys(SAMPLES), "email"]) assert.ok(BUILTIN_NAMES.includes(name), name)
})

test("an unknown builtin is an error", () => {
  assert.throws(() => buildPatternSet({ builtin: ["nope"] }), /unknown builtin rule "nope"/)
})

test("a broken regex is an error that names its category", () => {
  assert.throws(() => buildPatternSet({ regex: [{ pattern: "(", category: "mine" }] }), /patterns\.regex\[0\] \(MINE\) is not a valid regex/)
})

test("wrong shapes are errors and never echo keyword values", () => {
  assert.throws(() => buildPatternSet({ keywords: "x" }), /patterns\.keywords must be an array/)
  assert.throws(() => buildPatternSet([]), /patterns must be an object/)
  const error = (() => { try { buildPatternSet({ keywords: [{ value: 42 }] }) } catch (e) { return e } })()
  assert.match(error.message, /patterns\.keywords\[0\] needs a non-empty string "value"/)
  assert.doesNotMatch(error.message, /42/)
})

test("a broken regex error never echoes the pattern text", () => {
  const error = (() => { try { buildPatternSet({ regex: [{ pattern: "hunter2-secret(", category: "mine" }] }) } catch (e) { return e } })()
  assert.match(error.message, /patterns\.regex\[0\] \(MINE\) is not a valid regex/)
  assert.doesNotMatch(error.message, /hunter2/)
})

function excluded(text, exclude) {
  const found = []
  redactText(text, buildPatternSet({ builtin: ["email"], exclude }), {
    getOrCreatePlaceholder(original) { found.push(original); return "X" },
  })
  return found.sort()
}

test("exclude covers a domain and its subdomains, any case", () => {
  assert.deepEqual(excluded("a@example.com b@mail.example.com C@Example.COM", ["example.com"]), [])
})

test("exclude does not cover lookalike domains", () => {
  assert.deepEqual(excluded("a@notexample.com x@example.com.evil.io", ["example.com"]), ["a@notexample.com", "x@example.com.evil.io"])
})

test("exclude still matches an exact value", () => {
  assert.deepEqual(excluded("git@github.com:org/repo.git a@b.io", ["git@github.com"]), ["a@b.io"])
})
