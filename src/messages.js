import { redactText } from "./engine.js"
import { escapedForms, escapedViews } from "./escapes.js"
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

/**
 * Applies fn to the text between placeholders only. A placeholder already in the history is a
 * finished replacement: a rule matching inside it would wrap it in a second placeholder, and
 * restore would then give a tool the inner placeholder instead of the value.
 */
function mapGaps(text, placeholders, fn) {
  let out = ""
  let last = 0
  for (const m of text.matchAll(placeholders)) {
    out += fn(text.slice(last, m.index)) + m[0]
    last = m.index + m[0].length
  }
  return out + fn(text.slice(last))
}

/**
 * Rules run on the text and, to learn values only, on its views with JSON escapes undone:
 * `password = \"…\"` in a notebook read with `read` only matches once `\"` is undone. The
 * known-value pass then replaces the value in whatever escaped form it takes in the text.
 */
function rulePass(root, patterns, session) {
  const placeholders = getPlaceholderRegex(session.prefix)
  return mapStrings(root, (text) => mapGaps(text, placeholders, (gap) => {
    for (const view of escapedViews(gap)) redactText(view, patterns, session)
    return redactText(gap, patterns, session).text
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
  const needles = [...originalOf.keys()].sort((a, b) => b.length - a.length)
  const known = new RegExp(needles.map((o) => o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g")
  const placeholders = getPlaceholderRegex(session.prefix)
  return mapStrings(root, (text) => mapGaps(text, placeholders, (gap) => gap.replace(known, (found) => session.lookupReverse(originalOf.get(found)))), SKIP_KEYS)
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
