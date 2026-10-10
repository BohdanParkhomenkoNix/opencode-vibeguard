/** How many layers of JSON string escaping are undone (views) or applied (forms). */
export const MAX_ESCAPE_DEPTH = 3

const ESCAPE = /\\(?:u([0-9a-fA-F]{4})|(["\\/bfnrt]))/g
const SIMPLE = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }

function unescapeOnce(text) {
  return text.replace(ESCAPE, (_, hex, ch) => (hex ? String.fromCharCode(parseInt(hex, 16)) : SIMPLE[ch]))
}

/**
 * The text with JSON string escapes undone, one entry per level that changes it. Tool output
 * such as `read` of a notebook is escaped JSON wrapped in line numbers, not JSON itself, so a
 * context rule (`password = "…"`) only matches once `\"` is undone.
 */
export function escapedViews(text) {
  if (!text.includes("\\")) return []
  const views = []
  let current = text
  for (let i = 0; i < MAX_ESCAPE_DEPTH && current.includes("\\"); i++) {
    const next = unescapeOnce(current)
    if (next === current) break
    views.push(next)
    current = next
  }
  return views
}

const jsonEscape = (s) => JSON.stringify(s).slice(1, -1)
const slashEscape = (s) => s.replaceAll("/", "\\/")
const asciiEscape = (s) => s.replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)

/**
 * How a value can be spelled inside escaped text: JSON-escaped once to three times, each level
 * also with `\/` (PHP) and `\uXXXX` for non-ASCII (Python ensure_ascii, Jupyter).
 */
export function escapedForms(value) {
  const forms = new Set()
  let level = value
  for (let i = 0; i < MAX_ESCAPE_DEPTH; i++) {
    level = jsonEscape(level)
    forms.add(level).add(slashEscape(level)).add(asciiEscape(level))
  }
  forms.delete(value)
  return [...forms]
}
