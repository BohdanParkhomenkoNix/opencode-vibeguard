import { redactText } from "./engine.js"
import { escapedForms, escapedViews } from "./escapes.js"
import { knownMatcher, mapGaps } from "./known.js"
import { restoreText } from "./restore.js"
import { getPlaceholderRegex, placeholderHash } from "./session.js"

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
const NEVER = () => false

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
function learnFromViews(gap, patterns, session, skip) {
  const kept = []
  for (const view of escapedViews(gap)) {
    for (const { original, category } of matchesIn(view, patterns)) {
      if (skip(original)) continue
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
 * A match `skip` accepts (a value the model made up) is left as it is: replacing it with itself.
 */
function rulePass(root, patterns, session, skip = NEVER) {
  const placeholders = getPlaceholderRegex(session.prefix)
  const masker = skip === NEVER ? session : {
    prefix: session.prefix,
    getOrCreatePlaceholder: (original, category) => (skip(original) ? original : session.getOrCreatePlaceholder(original, category)),
  }
  return mapStrings(root, (text) => mapGaps(text, placeholders, (gap) => {
    const learned = learnFromViews(gap, patterns, session, skip)
    const masked = learned.size === 0 ? gap : knownMatcher([...learned.keys()]).replaceIn(gap, placeholders, (found) => learned.get(found))
    return mapGaps(masked, placeholders, (rest) => redactText(rest, patterns, masker).text)
  }), SKIP_KEYS)
}

/** The placeholder map's values and every escaped form of them, needle -> original. */
function knownNeedles(session, skipEntry = NEVER) {
  const originalOf = new Map()
  for (const [original, placeholder] of session.knownEntries()) {
    if (!original || skipEntry(original, placeholder)) continue
    originalOf.set(original, original)
    for (const form of escapedForms(original)) if (!originalOf.has(form)) originalOf.set(form, original)
  }
  return originalOf
}

function knownIndex(session) {
  const originalOf = knownNeedles(session)
  return { originalOf, matcher: knownMatcher([...originalOf.keys()]) }
}

/**
 * Replaces every value the session already knows, and every escaped form of it, with its
 * existing placeholder, longest first. A context rule (a lookbehind) learns a value from one
 * occurrence, but the same value turns up bare or escaped in tool output, and the guard blocks
 * any known value it finds. An entry `skipEntry` accepts (made up by the model here) is left,
 * and is left out of the matcher, as the guard leaves it out.
 */
function knownPass(root, session, skipEntry = NEVER) {
  const originalOf = knownNeedles(session, skipEntry)
  if (originalOf.size === 0) return 0
  const known = knownMatcher([...originalOf.keys()])
  const placeholders = getPlaceholderRegex(session.prefix)
  return mapStrings(root, (text) => known.replaceIn(text, placeholders, (found) => session.lookupReverse(originalOf.get(found))), SKIP_KEYS)
}

/** Redacts one tree: rules first, then the values they learned. Returns the number of strings changed. */
export function redactStrings(root, patterns, session) {
  return rulePass(root, patterns, session) + knownPass(root, session)
}

const ALNUM = /[A-Za-z0-9]/
const VALUE_CHAR = /[A-Za-z0-9_%+@-]/

/**
 * Whether text[offset, offset + length) stands as a whole token: the character before and the
 * one after are not part of a value. A `.` is part of a value only next to a letter or digit,
 * so `10.20.0.50` does not hold `10.20.0.5`, while a sentence-end `.` does not extend a value.
 */
function isWholeToken(text, offset, length) {
  const end = offset + length
  const before = text[offset - 1]
  const after = text[end]
  if (before !== undefined && (VALUE_CHAR.test(before) || (before === "." && ALNUM.test(text[offset - 2] ?? "")))) return false
  if (after !== undefined && (VALUE_CHAR.test(after) || (after === "." && ALNUM.test(text[end + 1] ?? "")))) return false
  return true
}

/**
 * Writes the class of every value in root to the origin journal of origin.sessionId: "model" for
 * the model's own output, "input" for anything sent to it. A value is a rule match, in the raw text
 * or in an escaped view, or a value of the placeholder map in any escaped form (`known`, built once
 * per request; in model output a known value counts only as a whole token, as the model never wrote
 * a substring of a longer value as a value). Placeholders are not scanned. A value the session's chain already holds keeps its
 * class. Wrap a tool input as `{ input }` so every key of it is content.
 * @param {"model" | "input"} kind
 * @param {{ sessionId: string, tracker: import("./origin.js").OriginTracker }} origin
 */
export function classify(root, kind, patterns, session, origin, known = knownIndex(session)) {
  const mark = kind === "model"
    ? (value) => origin.tracker.markModelMade(origin.sessionId, value)
    : (value) => origin.tracker.markInput(origin.sessionId, value)
  const placeholders = getPlaceholderRegex(session.prefix)
  mapStrings(root, (text) => {
    mapGaps(text, placeholders, (gap) => {
      for (const view of [gap, ...escapedViews(gap)]) {
        for (const { original } of matchesIn(view, patterns)) mark(original)
      }
      known.matcher.replaceIn(gap, placeholders, (found, offset, text) => {
        if (kind === "input" || isWholeToken(text, offset, found.length)) mark(known.originalOf.get(found))
        return found
      })
      return gap
    })
    return text
  }, SKIP_KEYS)
}

const isNode = (value) => value !== null && typeof value === "object"
const itemsOf = (root) => (Array.isArray(root) && root.every(isNode) ? root : [root])

/**
 * Redacts several trees of one request. First every item is classified in history order (system,
 * then each message): an `assistant` message is the model's output, anything else is input, and
 * the first sighting in the session's chain decides. Then the rules and the known-value pass mask
 * everything but the values model-made in this session. Without `origin` (no session id) nothing
 * is classified and nothing is model-made. The known-value pass runs only after every rule pass,
 * because a bare value can sit in a tree walked before the tree where a rule first learns it.
 * @param {unknown[]} roots
 * @param {{ sessionId: string, tracker: import("./origin.js").OriginTracker }} [origin]
 */
export function redactRequest(roots, patterns, session, origin) {
  if (origin) {
    const known = knownIndex(session)
    for (const root of roots) {
      for (const item of itemsOf(root)) classify(item, item?.role === "assistant" ? "model" : "input", patterns, session, origin, known)
    }
  }
  const skip = origin ? (original) => origin.tracker.isModelMade(origin.sessionId, original) : NEVER
  const skipEntry = origin ? (_original, placeholder) => origin.tracker.isModelMadeHash(origin.sessionId, placeholderHash(placeholder)) : NEVER
  let changed = 0
  for (const root of roots) for (const item of itemsOf(root)) changed += rulePass(item, patterns, session, skip)
  for (const root of roots) changed += knownPass(root, session, skipEntry)
  return changed
}

export function restoreStrings(root, session) {
  return mapStrings(root, (text) => restoreText(text, session))
}
