import { test } from "node:test"
import assert from "node:assert/strict"
import { findLeak } from "../../src/guard.js"
import { buildPatternSet } from "../../src/patterns.js"
import { PlaceholderSession } from "../../src/session.js"

const patterns = buildPatternSet({ builtin: ["email", "private_key"], exclude: ["noreply@anthropic.com"] })
const session = () => new PlaceholderSession({ prefix: "__VG_", ttlMs: 60_000, maxMappings: 100, secret: Buffer.alloc(32, 3) })
const body = (content) => JSON.stringify({ model: "m", messages: [{ role: "user", content }] })

test("a clean body passes", () => {
  assert.equal(findLeak(body("hello"), patterns, session()), null)
})

test("a rule match is reported by category only", () => {
  const leak = findLeak(body("mail me at alice@corp.io"), patterns, session())
  assert.deepEqual(leak, { category: "EMAIL" })
})

test("escaped secret is caught", () => {
  const s = session()
  const original = 'pa"ss\nword-42'
  const ph = s.getOrCreatePlaceholder(original, "test")
  assert.ok(ph)
  assert.deepEqual(findLeak(body(`x ${original} y`), patterns, s), { category: "TEST" })
  const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----"
  assert.deepEqual(findLeak(body(key), patterns, s), { category: "PRIVATE_KEY" })
})

test("placeholders and excluded values pass", () => {
  const s = session()
  const ph = s.getOrCreatePlaceholder("alice@corp.io", "email")
  assert.equal(findLeak(body(`send to ${ph} from noreply@anthropic.com`), patterns, s), null)
})

test("placeholder text is not scanned as a leak", () => {
  const keywordPatterns = buildPatternSet({ keywords: [{ value: "EMAIL", category: "probe" }] })
  const s = session()
  const ph = s.getOrCreatePlaceholder("alice@corp.io", "email")
  assert.equal(findLeak(body(`send to ${ph}`), keywordPatterns, s), null)
})

test("a non-JSON body is scanned as text", () => {
  assert.deepEqual(findLeak("raw alice@corp.io", patterns, session()), { category: "EMAIL" })
  assert.equal(findLeak("", patterns, session()), null)
})

const toolCallBody = (args) =>
  JSON.stringify({ model: "m", messages: [{ role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "shell", arguments: args } }] }] })
const nest = (value, levels) => {
  let v = value
  for (let i = 0; i < levels; i++) v = JSON.stringify({ v })
  return v
}

test("a known value escaped inside tool-call arguments is caught", () => {
  const s = session()
  const original = 'pa"ss\\word-42'
  s.getOrCreatePlaceholder(original, "test")
  assert.deepEqual(findLeak(toolCallBody(JSON.stringify({ command: `echo ${original}` })), patterns, s), { category: "TEST" })
})

test("placeholders inside nested JSON pass", () => {
  const s = session()
  const ph = s.getOrCreatePlaceholder("alice@corp.io", "email")
  assert.equal(findLeak(toolCallBody(JSON.stringify({ command: `mail ${ph}` })), patterns, s), null)
})

test("text that only looks like JSON is scanned as text", () => {
  assert.equal(findLeak(body("{not json"), patterns, session()), null)
  assert.deepEqual(findLeak(body("[oops alice@corp.io"), patterns, session()), { category: "EMAIL" })
})

test("nesting deeper than 3 levels is not decoded", () => {
  const s = session()
  const original = 'q"uote-secret-1'
  s.getOrCreatePlaceholder(original, "test")
  assert.deepEqual(findLeak(body(nest(original, 3)), patterns, s), { category: "TEST" })
  assert.equal(findLeak(body(nest(original, 4)), patterns, s), null)
})

test("the guard honours exclude by domain", () => {
  const byDomain = buildPatternSet({ builtin: ["email"], exclude: ["example.com"] })
  assert.equal(findLeak(body("write to dev@Example.com"), byDomain, session()), null)
  assert.deepEqual(findLeak(body("write to dev@notexample.com"), byDomain, session()), { category: "EMAIL" })
})

test("deeply nested JSON inside a string does not crash the guard", () => {
  const deep = "[".repeat(20000) + "]".repeat(20000)
  assert.equal(findLeak(body(deep), patterns, session()), null)
  assert.deepEqual(findLeak(body(`${deep} alice@corp.io`), patterns, session()), { category: "EMAIL" })
  assert.deepEqual(findLeak(JSON.stringify({ model: "m", messages: [{ role: "user", content: deep }, { role: "user", content: "alice@corp.io" }] }), patterns, session()), { category: "EMAIL" })
})

const secretValue = buildPatternSet({ regex: [{ pattern: String.raw`(?<=password["']?\s*[:=]\s*["']?)[A-Za-z0-9]{12,}`, category: "secret_value" }] })
const readOutput = (value) => `Read file /tmp/nb.ipynb, lines 1-3\n1: {\n2:   "cells": [{"source": ["password = \\"${value}\\"\\n"]}]\n3: }`

test("a rule match visible only after unescaping is caught", () => {
  assert.deepEqual(findLeak(body(readOutput("Fake7pass9word12")), secretValue, session()), { category: "SECRET_VALUE" })
})

test("a known value written escaped inside non-JSON text is caught", () => {
  const s = session()
  s.getOrCreatePlaceholder('pa"ss-word-42', "test")
  assert.deepEqual(findLeak(body('1: {"cmd": "echo pa\\"ss-word-42"}  trailing'), patterns, s), { category: "TEST" })
})
