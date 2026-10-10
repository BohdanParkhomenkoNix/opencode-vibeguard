import { existsSync } from "node:fs"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { defaultKeyFile } from "./key.js"

const UNITS = { ms: 1, s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 }

function fail(file, message) {
  throw new Error(`config ${file}: ${message}`)
}

function parseDurationMs(input, file) {
  const m = String(input).trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/)
  if (!m) fail(file, `session.ttl "${input}" must look like 30m, 24h or 7d`)
  return Number(m[1]) * UNITS[m[2]]
}

function expandHome(p) {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p
}

async function readJson(file) {
  const text = await fs.readFile(file, "utf8")
  try {
    return JSON.parse(text)
  } catch {
    // JSON.parse messages quote the text around the error, and that text can be a secret.
    fail(file, "is not valid JSON")
  }
}

/**
 * Strict on purpose: a config that half-loads protects less than the user believes,
 * so every malformed field is an error and the plugin blocks requests instead.
 */
function normalizeConfig(raw, file) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(file, "must be a JSON object")
  for (const key of ["enabled", "debug"]) {
    if (raw[key] !== undefined && typeof raw[key] !== "boolean") fail(file, `"${key}" must be a boolean`)
  }
  const prefix = raw.placeholder_prefix ?? "__VG_"
  if (typeof prefix !== "string" || !/^[A-Za-z0-9_]+$/.test(prefix)) fail(file, "placeholder_prefix must match [A-Za-z0-9_]+")

  const session = raw.session ?? {}
  if (typeof session !== "object" || Array.isArray(session)) fail(file, "session must be an object")
  const ttlMs = parseDurationMs(session.ttl ?? "24h", file)
  const maxMappings = session.max_mappings ?? 100000
  if (!Number.isInteger(maxMappings) || maxMappings <= 0) fail(file, "session.max_mappings must be a positive integer")

  if (raw.key_file !== undefined && (typeof raw.key_file !== "string" || !raw.key_file)) fail(file, "key_file must be a non-empty string")
  const keyFile = raw.key_file ? path.resolve(path.dirname(file), expandHome(raw.key_file)) : defaultKeyFile()

  return {
    enabled: raw.enabled === true,
    debug: raw.debug === true,
    prefix,
    ttlMs,
    maxMappings,
    patterns: raw.patterns,
    keyFile,
  }
}

export function getConfigCandidates(directory) {
  const dir = String(directory ?? process.cwd())
  const candidates = [
    path.join(dir, "vibeguard.config.json"),
    path.join(dir, ".opencode", "vibeguard.config.json"),
    path.join(os.homedir(), ".config", "opencode", "vibeguard.config.json"),
  ]
  const env = process.env.OPENCODE_VIBEGUARD_CONFIG
  return env ? [path.resolve(dir, expandHome(env)), ...candidates] : candidates
}

/** First existing candidate wins. None at all: disabled, a deliberate off switch. An env path that does not exist is an error. */
export async function loadConfig(directory) {
  const explicit = process.env.OPENCODE_VIBEGUARD_CONFIG
  for (const [i, file] of getConfigCandidates(directory).entries()) {
    if (!existsSync(file)) {
      // A named file that is missing is a typo, not the deliberate "no config" off switch.
      if (explicit && i === 0) fail(file, "not found")
      continue
    }
    return { ...normalizeConfig(await readJson(file), file), loadedFrom: file }
  }
  return {
    enabled: false, debug: false, prefix: "__VG_", ttlMs: UNITS.d, maxMappings: 100000,
    patterns: undefined, keyFile: defaultKeyFile(), loadedFrom: "",
  }
}
