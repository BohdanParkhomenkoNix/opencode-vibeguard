import { redactText } from "./engine.js"
import { escapedViews } from "./escapes.js"
import { knownMatcher } from "./known.js"
import { mapStrings } from "./messages.js"
import { getPlaceholderRegex } from "./session.js"

const MAX_JSON_DEPTH = 3

function parseNested(text) {
  const head = text.trimStart()[0]
  if (head !== "{" && head !== "[") return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function collect(value, out, depth) {
  mapStrings(value, (text) => {
    out.push(text)
    if (depth < MAX_JSON_DEPTH) {
      const nested = parseNested(text)
      if (nested !== undefined) {
        try {
          collect(nested, out, depth + 1)
        } catch (error) {
          // Hostile deep JSON overflows the stack; the raw string is already in `out`.
          if (!(error instanceof RangeError)) throw error
        }
      }
    }
    return text
  })
}

function stringsOf(bodyText) {
  let parsed
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return [bodyText]
  }
  if (typeof parsed === "string") return [parsed]
  const out = []
  // Decoded strings, not the raw body: a secret with a quote or a newline is escaped in JSON
  // and would slip past a substring search of the wire text. Strings that are JSON themselves
  // (tool_calls[].function.arguments) are decoded again for the same reason.
  collect(parsed, out, 0)
  return out
}

function categoryOf(placeholder, prefix) {
  return placeholder.slice(prefix.length).replace(/_[0-9a-fA-F]{12}(?:_\d+)?__$/, "")
}

function leakIn(text, known, placeholderOf, patterns, prefix) {
  const original = known.find(text)
  if (original !== null) return { category: categoryOf(placeholderOf.get(original), prefix) }
  let category = null
  redactText(text, patterns, {
    getOrCreatePlaceholder(_original, ruleCategory) {
      category ??= ruleCategory
      return ""
    },
  })
  return category ? { category } : null
}

/**
 * Last line of defence before bytes leave the machine: anything the rules match, or any value
 * already known to be secret, in any string of the outgoing body, also with JSON escapes undone.
 * Reports the category only.
 */
export function findLeak(bodyText, patterns, session) {
  if (!bodyText) return null
  const placeholders = getPlaceholderRegex(session.prefix)
  const placeholderOf = new Map(session.knownEntries())
  const known = knownMatcher([...placeholderOf.keys()])
  for (const raw of stringsOf(bodyText)) {
    const text = raw.replace(placeholders, " ")
    for (const view of [text, ...escapedViews(text)]) {
      const leak = leakIn(view, known, placeholderOf, patterns, session.prefix)
      if (leak) return leak
    }
  }
  return null
}
