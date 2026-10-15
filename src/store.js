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
