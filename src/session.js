import { createHmac } from "node:crypto"

function sanitizeCategory(input) {
  const raw = String(input ?? "").trim()
  if (!raw) return "TEXT"
  const upper = raw.toUpperCase()
  const safe = upper.replace(/[^A-Z0-9_]/g, "_").replace(/_+/g, "_")
  if (!safe) return "TEXT"
  return safe
}

/** A last-use renewal alone marks the store for saving only when it moves this far. */
export const RENEW_STEP_MS = 60_000

/** The 12-hex hash inside a placeholder, lowercased; undefined for anything else. */
export function placeholderHash(placeholder) {
  return String(placeholder).match(/_([0-9a-fA-F]{12})(?:_\d+)?__$/)?.[1]?.toLowerCase()
}

/**
 * Placeholder ↔ value map shared by every session of one OpenCode process.
 * - placeholder: __VG_<CATEGORY>_<hash12>__, hash12 = first 12 hex chars of HMAC-SHA256(key, value)
 * - a mapping lives while it is used: ttlMs counts from the last use; 0 (`session.ttl: "0s"`)
 *   means mappings never expire by age; maxMappings evicts the least recently used
 * - `dirty` is set by any change so the caller knows the store needs saving; a renewal sets it
 *   only when it moves last use forward by RENEW_STEP_MS
 * - `version` grows whenever a mapping is added or removed, so an index of the values can be reused
 */
export class PlaceholderSession {
  /**
   * @param {{ prefix: string, ttlMs: number, maxMappings: number, secret: Uint8Array }} options
   */
  constructor(options) {
    const prefix = String(options?.prefix ?? "__VG_")
    this.prefix = prefix
    this.ttlMs = Number.isFinite(options?.ttlMs) ? Number(options.ttlMs) : 60 * 60 * 1000
    this.maxMappings = Number.isFinite(options?.maxMappings) ? Number(options.maxMappings) : 100000
    // The key comes from key.js: a random per-process key would change every placeholder
    // after an OpenCode restart, while the stored replies still hold the old ones.
    if (!(options?.secret instanceof Uint8Array) || options.secret.length !== 32) throw new Error("PlaceholderSession needs a 32-byte secret")
    this.secret = Uint8Array.from(options.secret)

    /** @type {Map<string,string>} */
    this.forward = new Map()
    /** @type {Map<string,string>} */
    this.reverse = new Map()
    /** @type {Map<string,number>} placeholder -> last use */
    this.used = new Map()
    this.dirty = false
    this.version = 0
  }

  drop(placeholder) {
    const original = this.forward.get(placeholder)
    this.forward.delete(placeholder)
    this.used.delete(placeholder)
    if (original !== undefined) this.reverse.delete(original)
    this.dirty = true
    this.version++
  }

  cleanup(now = Date.now()) {
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) return
    for (const [placeholder, usedAt] of this.used.entries()) {
      if (now - usedAt > this.ttlMs) this.drop(placeholder)
    }
  }

  evictOldest() {
    let oldestPlaceholder = ""
    let oldestTime = Infinity
    for (const [placeholder, usedAt] of this.used.entries()) {
      if (usedAt >= oldestTime) continue
      oldestTime = usedAt
      oldestPlaceholder = placeholder
    }
    if (oldestPlaceholder) this.drop(oldestPlaceholder)
  }

  /**
   * Renews a mapping; never moves its last use back. A renewal alone is worth saving only when it
   * moves last use forward by RENEW_STEP_MS: otherwise every request would rewrite the store.
   */
  touch(placeholder, now = Date.now()) {
    const usedAt = this.used.get(placeholder)
    if (usedAt === undefined || usedAt >= now) return
    this.used.set(placeholder, now)
    if (now - usedAt >= RENEW_STEP_MS) this.dirty = true
  }

  lookup(placeholder, now = Date.now()) {
    const original = this.forward.get(placeholder)
    if (original !== undefined) this.touch(placeholder, now)
    return original
  }

  lookupReverse(original, now = Date.now()) {
    const placeholder = this.reverse.get(original)
    if (placeholder !== undefined) this.touch(placeholder, now)
    return placeholder
  }

  knownEntries() {
    return this.reverse.entries()
  }

  hashOf(original) {
    return createHmac("sha256", this.secret).update(String(original)).digest("hex").slice(0, 12)
  }

  generatePlaceholder(original, category) {
    return `${this.prefix}${sanitizeCategory(category)}_${this.hashOf(original)}__`
  }

  set(placeholder, original, now) {
    this.forward.set(placeholder, original)
    this.reverse.set(original, placeholder)
    this.used.set(placeholder, now)
    this.dirty = true
    this.version++
  }

  /**
   * The same original always maps to the same placeholder.
   * @param {string} original
   * @param {string} category
   */
  getOrCreatePlaceholder(original, category) {
    const existing = this.lookupReverse(original)
    if (existing) return existing

    const now = Date.now()
    this.cleanup(now)

    if (Number.isFinite(this.maxMappings) && this.maxMappings > 0) {
      while (this.forward.size >= this.maxMappings) this.evictOldest()
    }

    const base = this.generatePlaceholder(original, category)
    const current = this.forward.get(base)
    if (current === undefined || current === original) {
      this.set(base, original, now)
      return base
    }

    // A hash12 collision: a _N suffix keeps placeholders unique.
    const withoutSuffix = base.slice(0, -2)
    for (let i = 2; ; i++) {
      const candidate = `${withoutSuffix}_${i}__`
      const prev = this.forward.get(candidate)
      if (prev === undefined || prev === original) {
        this.set(candidate, original, now)
        return candidate
      }
    }
  }

  /** [placeholder, original, lastUsed] for every mapping, for the store. */
  exportMappings() {
    return [...this.forward].map(([placeholder, original]) => [placeholder, original, this.used.get(placeholder)])
  }

  /**
   * Takes mappings from the store. An entry that conflicts with a mapping in memory (the same
   * placeholder for another value, or the same value under another placeholder) is skipped;
   * the same mapping keeps the later last use. Then the map is cut to maxMappings, least
   * recently used first. Importing does not set `dirty`: the store's own merge applies the cap.
   */
  importMappings(entries) {
    if (!Array.isArray(entries)) return
    for (const entry of entries) {
      if (!Array.isArray(entry)) continue
      const [placeholder, original, usedAt] = entry
      if (typeof placeholder !== "string" || typeof original !== "string" || !Number.isFinite(usedAt)) continue
      const current = this.forward.get(placeholder)
      if (current === undefined) {
        if (this.reverse.has(original)) continue
        this.forward.set(placeholder, original)
        this.reverse.set(original, placeholder)
        this.used.set(placeholder, usedAt)
        this.version++
      } else if (current === original && usedAt > this.used.get(placeholder)) {
        this.used.set(placeholder, usedAt)
      }
    }
    this.trimToMax()
  }

  /** Drops the least recently used excess over maxMappings in one sort, not one scan per entry. */
  trimToMax() {
    if (!Number.isFinite(this.maxMappings) || this.maxMappings <= 0 || this.forward.size <= this.maxMappings) return
    const byUse = [...this.used].sort((a, b) => b[1] - a[1])
    for (const [placeholder] of byUse.slice(this.maxMappings)) {
      this.reverse.delete(this.forward.get(placeholder))
      this.forward.delete(placeholder)
      this.used.delete(placeholder)
    }
    this.version++
  }
}

export function getPlaceholderRegex(prefix) {
  const escaped = String(prefix).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  // Pattern: __VG_CATEGORY_HASH12__ or __VG_CATEGORY_HASH12_N__
  return new RegExp(`${escaped}[A-Za-z0-9_]+_[a-f0-9A-F]{12}(?:_\\d+)?__`, "g")
}
