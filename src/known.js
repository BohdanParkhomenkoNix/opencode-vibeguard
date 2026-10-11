/** At most this many alternatives per regex: one alternation of thousands of needles falls off V8's fast path. */
export const CHUNK = 200

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Applies fn to the text between placeholders only. A placeholder already in the text is a
 * finished replacement: a match inside it would wrap it in a second placeholder, and restore
 * would then give a tool the inner placeholder instead of the value.
 */
export function mapGaps(text, placeholders, fn) {
  let out = ""
  let last = 0
  for (const m of text.matchAll(placeholders)) {
    out += fn(text.slice(last, m.index)) + m[0]
    last = m.index + m[0].length
  }
  return out + fn(text.slice(last))
}

/**
 * Finds and replaces a set of literal strings, longest first, with one regex per CHUNK needles.
 * Later chunks only see the gaps between placeholders, so a shorter needle never splits a
 * replacement an earlier chunk made.
 */
export function knownMatcher(needles) {
  const sorted = [...new Set(needles)].filter(Boolean).sort((a, b) => b.length - a.length)
  const chunks = []
  for (let i = 0; i < sorted.length; i += CHUNK) {
    chunks.push(new RegExp(sorted.slice(i, i + CHUNK).map(escapeRegex).join("|"), "g"))
  }
  return {
    size: sorted.length,
    find(text) {
      for (const re of chunks) {
        re.lastIndex = 0
        const m = re.exec(text)
        if (m) return m[0]
      }
      return null
    },
    replaceIn(text, placeholders, fn) {
      let out = text
      for (const re of chunks) out = mapGaps(out, placeholders, (gap) => gap.replace(re, fn))
      return out
    },
  }
}
