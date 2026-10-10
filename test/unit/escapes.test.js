import { test } from "node:test"
import assert from "node:assert/strict"
import { MAX_ESCAPE_DEPTH, escapedForms, escapedViews } from "../../src/escapes.js"

test("no backslash, no views", () => {
  assert.deepEqual(escapedViews('plain "text" here'), [])
})

const esc = (s) => JSON.stringify(s).slice(1, -1)

test("each changing level is one view, up to 3", () => {
  const plain = '{"p":"a\\"b"}'
  assert.equal(MAX_ESCAPE_DEPTH, 3)
  assert.deepEqual(escapedViews(esc(esc(esc(plain)))), [esc(esc(plain)), esc(plain), plain])
})

test("views stop when a level changes nothing", () => {
  assert.deepEqual(escapedViews('say \\"hi\\"'), ['say "hi"'])
  assert.deepEqual(escapedViews("C:\\x\\y"), [])
})

test("all JSON escapes are decoded, unknown ones are kept", () => {
  assert.deepEqual(escapedViews('a\\tb\\nc\\/d\\u00e9\\x'), ["a\tb\nc/d\u00e9\\x"])
})

test("forms of a plain value are empty", () => {
  assert.deepEqual(escapedForms("Plain12345"), [])
})

test("forms cover JSON levels, escaped slashes and \\u escapes", () => {
  const forms = escapedForms('p"w/é')
  assert.ok(forms.includes('p\\"w/é'), "level 1")
  assert.ok(forms.includes('p\\\\\\"w/é'), "level 2")
  assert.ok(forms.includes('p\\\\\\\\\\\\\\"w/é'), "level 3")
  assert.ok(forms.includes('p\\"w\\/é'), "PHP slash")
  assert.ok(forms.includes('p\\"w/\\u00e9'), "ensure_ascii")
  assert.ok(!forms.includes('p"w/é'), "not the value itself")
  assert.equal(new Set(forms).size, forms.length)
})
