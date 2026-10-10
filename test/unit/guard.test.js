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
