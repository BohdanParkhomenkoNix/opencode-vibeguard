import { redactText } from "./engine.js"
import { restoreText } from "./restore.js"

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

export function redactStrings(root, patterns, session) {
  return mapStrings(root, (text) => redactText(text, patterns, session).text, SKIP_KEYS)
}

export function restoreStrings(root, session) {
  return mapStrings(root, (text) => restoreText(text, session))
}
