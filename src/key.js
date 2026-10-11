import { randomBytes } from "node:crypto"
import * as nodeFs from "node:fs"
import os from "node:os"
import path from "node:path"

export const KEY_BYTES = 32

export function defaultKeyFile() {
  return path.join(os.homedir(), ".config", "opencode", "vibeguard.key")
}

const codeOf = (error) => error?.code ?? "unknown error"

const TEMP_SUFFIX = /^(\d+)\.[0-9a-f]{8}\.tmp$/

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: alive, owned by someone else.
    return error.code !== "ESRCH"
  }
}

/** A process killed between write and unlink leaves its temp file, holding key bytes, behind. */
function removeOrphanTemps(file, fs) {
  const dir = path.dirname(file)
  const prefix = `${path.basename(file)}.`
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    const m = name.slice(prefix.length).match(TEMP_SUFFIX)
    if (!m) continue
    const pid = Number(m[1])
    if (pid === process.pid || isAlive(pid)) continue
    try {
      fs.unlinkSync(path.join(dir, name))
    } catch {
      // Already gone.
    }
  }
}

/**
 * Written aside and linked into place, so no process ever reads a half-written key.
 * If another process links its key first, that key wins.
 */
function createKey(file, fs) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  removeOrphanTemps(file, fs)
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
  let written = false
  try {
    try {
      fs.writeFileSync(tmp, randomBytes(KEY_BYTES), { mode: 0o600, flag: "wx" })
      written = true
    } catch (error) {
      throw new Error(`cannot create key file ${file}: ${codeOf(error)}`)
    }
    try {
      fs.linkSync(tmp, file)
    } catch (error) {
      // EEXIST: another process linked its key first, and that key wins.
      if (error?.code !== "EEXIST") throw new Error(`cannot create key file ${file}: ${codeOf(error)}`)
    }
  } finally {
    // Only our own temp file: on a name collision the file belongs to someone else.
    if (written) {
      try {
        fs.unlinkSync(tmp)
      } catch {
        // Already gone.
      }
    }
  }
}

/** The key turns placeholders back into guesses for short secrets: nobody else may read it. */
function ensureOwnerOnly(file, fs) {
  let mode
  try {
    mode = fs.statSync(file).mode
  } catch (error) {
    throw new Error(`cannot stat key file ${file}: ${codeOf(error)}`)
  }
  if ((mode & 0o077) === 0) return
  try {
    fs.chmodSync(file, 0o600)
  } catch (error) {
    throw new Error(`key file ${file} is accessible by others and chmod failed: ${codeOf(error)}`)
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
    if (error.code !== "ENOENT") throw new Error(`cannot read key file ${file}: ${codeOf(error)}`)
    createKey(file, fs)
    key = fs.readFileSync(file)
  }
  if (key.length !== KEY_BYTES) throw new Error(`key file ${file} must hold ${KEY_BYTES} bytes, found ${key.length}`)
  ensureOwnerOnly(file, fs)
  return key
}
