import { randomBytes } from "node:crypto"
import * as nodeFs from "node:fs"
import os from "node:os"
import path from "node:path"

export const KEY_BYTES = 32

export function defaultKeyFile() {
  return path.join(os.homedir(), ".config", "opencode", "vibeguard.key")
}

/**
 * Written aside and linked into place, so no process ever reads a half-written key.
 * If another process links its key first, that key wins.
 */
function createKey(file, fs) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
  try {
    fs.writeFileSync(tmp, randomBytes(KEY_BYTES), { mode: 0o600, flag: "wx" })
    fs.linkSync(tmp, file)
  } catch (error) {
    if (error.code !== "EEXIST") throw new Error(`cannot create key file ${file}: ${error.code}`)
  } finally {
    try {
      fs.unlinkSync(tmp)
    } catch {
      // Nothing to remove: the temp file was never written.
    }
  }
}

/** The key turns placeholders back into guesses for short secrets: nobody else may read it. */
function ensureOwnerOnly(file, fs) {
  if ((fs.statSync(file).mode & 0o077) === 0) return
  try {
    fs.chmodSync(file, 0o600)
  } catch (error) {
    throw new Error(`key file ${file} is accessible by others and chmod failed: ${error.code}`)
  }
}

/**
 * HMAC key shared by every session and every OpenCode restart, so a secret keeps its
 * placeholder across them. Created on first use with owner-only permissions.
 * `fs` is replaceable for tests only.
 */
export function loadKey(file = defaultKeyFile(), fs = nodeFs) {
  let key
  try {
    key = fs.readFileSync(file)
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`cannot read key file ${file}: ${error.code}`)
    createKey(file, fs)
    key = fs.readFileSync(file)
  }
  if (key.length !== KEY_BYTES) throw new Error(`key file ${file} must hold ${KEY_BYTES} bytes, found ${key.length}`)
  ensureOwnerOnly(file, fs)
  return key
}
