import { redactText } from "./engine.js"
import { mapStrings } from "./messages.js"
import { getPlaceholderRegex } from "./session.js"

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
  // and would slip past a substring search of the wire text.
  mapStrings(parsed, (text) => {
    out.push(text)
    return text
  })
  return out
}

function categoryOf(placeholder, prefix) {
  return placeholder.slice(prefix.length).replace(/_[0-9a-fA-F]{12}(?:_\d+)?__$/, "")
}

/**
 * Last line of defence before bytes leave the machine: anything the rules match, or any value
 * already known to be secret, in any string of the outgoing body. Reports the category only.
 */
export function findLeak(bodyText, patterns, session) {
  if (!bodyText) return null
  const placeholders = getPlaceholderRegex(session.prefix)
  const known = [...session.knownEntries()]
  for (const raw of stringsOf(bodyText)) {
    const text = raw.replace(placeholders, " ")
    for (const [original, placeholder] of known) {
      if (text.includes(original)) return { category: categoryOf(placeholder, session.prefix) }
    }
    let category = null
    redactText(text, patterns, {
      getOrCreatePlaceholder(_original, ruleCategory) {
        category ??= ruleCategory
        return ""
      },
    })
    if (category) return { category }
  }
  return null
}
