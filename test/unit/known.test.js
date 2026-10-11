import { test } from "node:test"
import assert from "node:assert/strict"
import { CHUNK, knownMatcher, mapGaps } from "../../src/known.js"
import { getPlaceholderRegex } from "../../src/session.js"

const PH = `__VG_TEST_${"a".repeat(12)}__`
const placeholders = getPlaceholderRegex("__VG_")
const needlesOf = (n) => Array.from({ length: n }, (_, i) => `needle-${String(i).padStart(4, "0")}`)

test("mapGaps applies fn between placeholders only", () => {
  assert.equal(mapGaps(`x ${PH} y`, placeholders, (g) => g.toUpperCase()), `X ${PH} Y`)
})

test("the longest needle wins", () => {
  const seen = []
  knownMatcher(["abc", "abcdef"]).replaceIn("xabcdefx", placeholders, (found) => { seen.push(found); return PH })
  assert.deepEqual(seen, ["abcdef"])
})

test("needles on both sides of every chunk boundary are replaced", () => {
  const needles = needlesOf(2 * CHUNK + 1)
  const out = knownMatcher(needles).replaceIn(needles.join(" "), placeholders, () => PH)
  assert.ok(!out.includes("needle-"), "a needle survived a chunk boundary")
  assert.equal(out.split(PH).length - 1, needles.length)
})

test("a shorter needle in a later chunk never matches inside a placeholder an earlier chunk wrote", () => {
  const long = needlesOf(CHUNK)
  const out = knownMatcher([...long, "TEST"]).replaceIn(`${long[0]} TEST`, placeholders, (found) => (found === "TEST" ? "<short>" : PH))
  assert.equal(out, `${PH} <short>`)
})

test("find returns a needle from a later chunk, or null", () => {
  const needles = needlesOf(2 * CHUNK + 1)
  const m = knownMatcher(needles)
  assert.equal(m.find(`x ${needles.at(-1)} y`), needles.at(-1))
  assert.equal(m.find("nothing here"), null)
  assert.equal(m.find(`again ${needles.at(-1)}`), needles.at(-1), "find must not keep lastIndex between calls")
})

test("regex metacharacters are literal; empty input is harmless", () => {
  assert.equal(knownMatcher(["a.b"]).find("axb"), null)
  assert.equal(knownMatcher(["a.b"]).find("a.b"), "a.b")
  const empty = knownMatcher(["", ""])
  assert.equal(empty.size, 0)
  assert.equal(empty.find("anything"), null)
  assert.equal(empty.replaceIn("anything", placeholders, () => PH), "anything")
})
