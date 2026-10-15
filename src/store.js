import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto"
import * as nodeFs from "node:fs"
import os from "node:os"
import path from "node:path"

export const STORE_VERSION = 1
const INFO = "vibeguard store v1"

/** The XDG data directory, not ~/.config where the key is: a dotfiles sync must not carry both. */
export function defaultStoreFile() {
  return path.join(os.homedir(), ".local", "share", "opencode", "vibeguard.store")
}

export function emptyPayload() {
  return { mappings: [], sessions: {}, handoffs: [] }
}

/** A key of its own for encryption, derived from the HMAC key, which is never used for it directly. */
function storeKey(secret) {
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), INFO, 32))
}

export function seal(payload, secret) {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", storeKey(secret), iv)
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()])
  return JSON.stringify({ v: STORE_VERSION, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") })
}

/** Error messages name what failed, never the bytes: the payload holds the secrets. */
export function open(text, secret) {
  let envelope
  try {
    envelope = JSON.parse(text)
  } catch {
    throw new Error("not a store envelope")
  }
  if (envelope?.v !== STORE_VERSION || typeof envelope.iv !== "string" || typeof envelope.tag !== "string" || typeof envelope.data !== "string") {
    throw new Error("not a store envelope")
  }
  let plain
  try {
    const decipher = createDecipheriv("aes-256-gcm", storeKey(secret), Buffer.from(envelope.iv, "base64"))
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"))
    plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8")
  } catch {
    throw new Error("cannot decrypt: corrupt file or another key")
  }
  let payload
  try {
    payload = JSON.parse(plain)
  } catch {
    throw new Error("bad payload")
  }
  const ok = payload && typeof payload === "object" && Array.isArray(payload.mappings)
    && payload.sessions && typeof payload.sessions === "object" && !Array.isArray(payload.sessions) && Array.isArray(payload.handoffs)
  if (!ok) throw new Error("bad payload")
  return payload
}

const codeOf = (error) => error?.code ?? "unknown error"

/**
 * The store on disk, or an empty one. A store that cannot be read as ours is moved aside and
 * the plugin starts empty: losing mappings only leaves placeholders unrestored, it leaks nothing.
 * `fs` and `now` are replaceable for tests only.
 */
export function loadStore(file, secret, { log = console.error, fs = nodeFs, now = Date.now } = {}) {
  let text
  try {
    text = fs.readFileSync(file, "utf8")
  } catch (error) {
    if (error?.code !== "ENOENT") log(`[vibeguard] store ${file} unreadable (${codeOf(error)}), starting empty`)
    return emptyPayload()
  }
  try {
    return open(text, secret)
  } catch (error) {
    try {
      fs.renameSync(file, `${file}.corrupt-${now()}`)
    } catch {
      // Gone already, or not ours to move: starting empty is still right.
    }
    log(`[vibeguard] store ${file} unreadable (${error.message}), moved aside`)
    return emptyPayload()
  }
}

const isEntry = (entry) => Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string" && Number.isFinite(entry[2])

/**
 * Union of two payloads: an entry in either is kept with the later last use; a session's model
 * set is the union. Then everything unused for ttlMs is dropped and mappings are capped at
 * maxMappings, least recently used first, so a merge never brings back what expiry removed.
 * For a value under two placeholders, the first one seen wins (`a` before `b`).
 */
export function mergePayloads(a, b, { ttlMs = 0, maxMappings = Infinity, now = Date.now() } = {}) {
  const alive = (usedAt) => !(ttlMs > 0) || now - usedAt <= ttlMs

  const mappings = new Map()
  const placeholderOf = new Map()
  for (const entry of [...(a.mappings ?? []), ...(b.mappings ?? [])]) {
    if (!isEntry(entry)) continue
    const [placeholder, original, usedAt] = entry
    const current = mappings.get(placeholder)
    if (current) {
      if (current[1] === original) current[2] = Math.max(current[2], usedAt)
      continue
    }
    if (placeholderOf.has(original)) continue
    mappings.set(placeholder, [placeholder, original, usedAt])
    placeholderOf.set(original, placeholder)
  }
  const kept = [...mappings.values()].filter(([, , usedAt]) => alive(usedAt)).sort((x, y) => y[2] - x[2]).slice(0, maxMappings)
  kept.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))

  const sessions = {}
  for (const source of [a.sessions ?? {}, b.sessions ?? {}]) {
    for (const [id, record] of Object.entries(source)) {
      if (!record || !Number.isFinite(record.lastUsed)) continue
      const current = sessions[id] ?? (sessions[id] = { lastUsed: record.lastUsed, model: [] })
      current.lastUsed = Math.max(current.lastUsed, record.lastUsed)
      if (current.parent === undefined && typeof record.parent === "string") current.parent = record.parent
      const model = Array.isArray(record.model) ? record.model.filter((h) => typeof h === "string") : []
      current.model = [...new Set([...current.model, ...model])]
    }
  }
  for (const [id, record] of Object.entries(sessions)) if (!alive(record.lastUsed)) delete sessions[id]

  const handoffs = new Map()
  for (const entry of [...(a.handoffs ?? []), ...(b.handoffs ?? [])]) {
    if (!isEntry(entry)) continue
    const current = handoffs.get(entry[0])
    if (!current || entry[2] > current[2]) handoffs.set(entry[0], [entry[0], entry[1], entry[2]])
  }

  return { mappings: kept, sessions, handoffs: [...handoffs.values()].filter(([, , usedAt]) => alive(usedAt)) }
}

/**
 * Merges the store on disk into `payload`, writes the result aside with mode 0600 and renames
 * it into place: a reader never sees half a file, and another process's entries survive.
 * Returns what was written, for the caller to take back into memory.
 */
export function saveStore(file, secret, payload, { ttlMs, maxMappings, now = Date.now(), log = console.error, fs = nodeFs } = {}) {
  const merged = mergePayloads(payload, loadStore(file, secret, { log, fs }), { ttlMs, maxMappings, now })
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, seal(merged, secret), { mode: 0o600 })
  fs.chmodSync(tmp, 0o600)
  fs.renameSync(tmp, file)
  return merged
}

/**
 * Runs `save` at most once per intervalMs: the first request saves at once, requests inside the
 * window collapse into one trailing save. flush() saves now if a request is pending (on exit).
 * A failed save is logged by its code only and tried again on the next request.
 */
export function createSaver(save, { intervalMs = 2000, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, log = console.error } = {}) {
  let last = -Infinity
  let timer = null
  let pending = false
  const run = () => {
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
    pending = false
    last = now()
    try {
      save()
    } catch (error) {
      log(`[vibeguard] store save failed: ${error?.code ?? "unknown error"}`)
    }
  }
  return {
    request() {
      pending = true
      if (timer !== null) return
      const wait = last + intervalMs - now()
      if (wait <= 0) return run()
      timer = setTimer(run, wait)
      // The trailing save must not keep OpenCode alive; flush() on exit covers it.
      timer?.unref?.()
    },
    flush() {
      if (pending) run()
    },
  }
}
