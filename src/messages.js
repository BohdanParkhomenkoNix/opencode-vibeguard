import { redactText } from "./engine.js"
import { escapedForms, escapedViews } from "./escapes.js"
import { knownMatcher, mapGaps } from "./known.js"
import { restoreText } from "./restore.js"
import { getPlaceholderRegex } from "./session.js"

/**
 * String fields that identify things rather than carry content. Rewriting them would break
 * tool-call pairing or message routing. Objects under these keys are still walked.
 */
export const SKIP_KEYS = new Set([
  "id", "type", "role", "sessionID", "messageID", "callID", "toolCallId", "toolCallID",
  "toolName", "tool", "name", "namespace", "providerID", "modelID", "mime", "mediaType",
])

/**
 * Keys whose value is a tool payload (call arguments, call result). Inside them every key is
 * content chosen by the model or the tool, so SKIP_KEYS no longer applies: an argument named
 * `name` or `id` can carry a secret.
 */
export const PAYLOAD_KEYS = new Set(["input", "result"])

const NO_SKIP = new Set()

function walkable(value) {
  return value !== null && typeof value === "object" && !ArrayBuffer.isView(value) && !(value instanceof Date) && !(value instanceof RegExp)
}

/**
 * Applies fn to every string reachable from root, in place. Any object is walked, not only
 * plain ones: V2 may hand over class instances, and skipping them would leak their text.
 * `skip` applies at message and part level only; PAYLOAD_KEYS subtrees are walked without it.
 */
export function mapStrings(root, fn, skip = NO_SKIP) {
  let changed = 0
  const seen = new WeakSet()
  const visit = (node, skip) => {
    if (!walkable(node) || seen.has(node)) return
    seen.add(node)
    const isArray = Array.isArray(node)
    for (const key of isArray ? node.keys() : Object.keys(node)) {
      const value = node[key]
      if (typeof value !== "string") {
        visit(value, !isArray && PAYLOAD_KEYS.has(key) ? NO_SKIP : skip)
        continue
      }
      if (!isArray && skip.has(key)) continue
      const next = fn(value)
      if (next !== value) {
        node[key] = next
        changed++
      }
    }
  }
  visit(root, skip)
  return changed
}

/** Runs the rules on text and returns what they match, registering nothing. */
function matchesIn(text, patterns) {
  const found = []
  redactText(text, patterns, {
    getOrCreatePlaceholder(original, category) {
      found.push({ original, category })
      return ""
    },
  })
  return found
}

/**
 * Values the rules find in the views of a gap (JSON escapes undone), registered only when the gap
 * spells them in a form the replacement can find; a value seen only in a view would take a
 * max_mappings slot for nothing. A placeholder restores exactly the bytes it replaced: a needle
 * the rules match whole in the raw gap keeps its own mapping, and only a spelling the raw rules
 * would split takes the decoded value's placeholder. Returns needle -> placeholder.
 */
function learnFromViews(gap, patterns, session) {
  const kept = []
  for (const view of escapedViews(gap)) {
    for (const { original, category } of matchesIn(view, patterns)) {
      const needles = [original, ...escapedForms(original)].filter((n) => gap.includes(n))
      if (needles.length > 0) kept.push({ original, category, needles })
    }
  }
  if (kept.length === 0) return new Map()

  const rawHits = new Set(matchesIn(gap, patterns).map((hit) => hit.original))
  const learned = new Map()
  const decoded = new Map()
  const placeholderOf = (original, category) => {
    if (!decoded.has(original)) decoded.set(original, session.getOrCreatePlaceholder(original, category))
    return decoded.get(original)
  }
  for (const { original, category, needles } of kept) {
    if (needles.includes(original) && !learned.has(original)) learned.set(original, placeholderOf(original, category))
  }
  for (const { original, category, needles } of kept) {
    for (const n of needles) {
      if (n === original || learned.has(n)) continue
      learned.set(n, rawHits.has(n) ? session.getOrCreatePlaceholder(n, category) : placeholderOf(original, category))
    }
  }
  return learned
}

/**
 * Values learned from the views are replaced in every escaped form first, then the rules run on
 * what is left of the raw text. In the other order a rule whose class includes `/` masks only the
 * part of `abc\/def…` after the backslash, and `abc\/` reaches the provider.
 */
function rulePass(root, patterns, session) {
  const placeholders = getPlaceholderRegex(session.prefix)
  return mapStrings(root, (text) => mapGaps(text, placeholders, (gap) => {
    const learned = learnFromViews(gap, patterns, session)
    const masked = learned.size === 0 ? gap : knownMatcher([...learned.keys()]).replaceIn(gap, placeholders, (found) => learned.get(found))
    return mapGaps(masked, placeholders, (rest) => redactText(rest, patterns, session).text)
  }), SKIP_KEYS)
}

/**
 * Replaces every value the session already knows, and every escaped form of it, with its
 * existing placeholder, longest first. A context rule (a lookbehind) learns a value from one
 * occurrence, but the same value turns up bare or escaped in tool output, and the guard blocks
 * any known value it finds.
 */
function knownPass(root, session) {
  const originalOf = new Map()
  for (const [original] of session.knownEntries()) {
    if (!original) continue
    originalOf.set(original, original)
    for (const form of escapedForms(original)) if (!originalOf.has(form)) originalOf.set(form, original)
  }
  if (originalOf.size === 0) return 0
  const known = knownMatcher([...originalOf.keys()])
  const placeholders = getPlaceholderRegex(session.prefix)
  return mapStrings(root, (text) => known.replaceIn(text, placeholders, (found) => session.lookupReverse(originalOf.get(found))), SKIP_KEYS)
}

/** Redacts one tree: rules first, then the values they learned. Returns the number of strings changed. */
export function redactStrings(root, patterns, session) {
  return rulePass(root, patterns, session) + knownPass(root, session)
}

/**
 * Redacts several trees of one request. The known-value pass runs only after every rule pass,
 * because a bare value can sit in a tree walked before the tree where a rule first learns it.
 */
export function redactRequest(roots, patterns, session) {
  let changed = 0
  for (const root of roots) changed += rulePass(root, patterns, session)
  for (const root of roots) changed += knownPass(root, session)
  return changed
}

export function restoreStrings(root, session) {
  return mapStrings(root, (text) => restoreText(text, session))
}
