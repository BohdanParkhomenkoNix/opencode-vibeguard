import { randomBytes } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

export const KEY_BYTES = 32

export function defaultKeyFile() {
  return path.join(os.homedir(), ".config", "opencode", "vibeguard.key")
}

/**
 * HMAC key shared by every session and every OpenCode restart, so a secret keeps its
 * placeholder across them. Created on first use with owner-only permissions.
 */
export function loadKey(file = defaultKeyFile()) {
  let key
  try {
    key = readFileSync(file)
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`cannot read key file ${file}: ${error.code}`)
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    try {
      writeFileSync(file, randomBytes(KEY_BYTES), { mode: 0o600, flag: "wx" })
    } catch (writeError) {
      // Another process created it first: use theirs.
      if (writeError.code !== "EEXIST") throw new Error(`cannot create key file ${file}: ${writeError.code}`)
    }
    chmodSync(file, 0o600)
    key = readFileSync(file)
  }
  if (key.length !== KEY_BYTES) throw new Error(`key file ${file} must hold ${KEY_BYTES} bytes, found ${key.length}`)
  return key
}
