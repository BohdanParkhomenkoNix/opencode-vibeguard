import { RENEW_STEP_MS } from "./session.js"

/** OpenCode starts a subagent's first user message with this line, then the parent's prompt. */
export const SUBAGENT_PREAMBLE = "You are a subagent spawned by another session.\n"

/**
 * The origin journal: per session, which values the model made up (`model`) and which reached
 * the model as input first (`input`). A value is kept as the 12-hex HMAC a placeholder carries
 * (`hashOf`), never in plain text. A subagent session links to the session that spawned it; a
 * class is looked up along that chain and the nearest session holding the hash decides. The first
 * sighting on a chain decides: a value the chain already holds is never written again. `dirty` is
 * set by any change; a renewal sets it only when it moves last use forward by RENEW_STEP_MS.
 */
export class OriginTracker {
  /** @param {{ hashOf(value: string): string, ttlMs: number }} options */
  constructor({ hashOf, ttlMs }) {
    this.hashOf = hashOf
    this.ttlMs = ttlMs
    /** @type {Map<string, { lastUsed: number, parent?: string, model: Set<string>, input: Set<string> }>} */
    this.sessions = new Map()
    /** @type {Map<string, { parent: string, lastUsed: number }>} prompt hash -> parent session */
    this.handoffs = new Map()
    this.dirty = false
  }

  /** The session's record, created or renewed; a renewal alone sets `dirty` as PlaceholderSession#touch does. */
  record(sessionId, now = Date.now()) {
    let record = this.sessions.get(sessionId)
    if (!record) {
      record = { lastUsed: now, model: new Set(), input: new Set() }
      this.sessions.set(sessionId, record)
      this.dirty = true
    } else if (record.lastUsed < now) {
      if (now - record.lastUsed >= RENEW_STEP_MS) this.dirty = true
      record.lastUsed = now
    }
    return record
  }

  /** Writes the value to one set of the session's journal unless its chain already holds it. */
  mark(sessionId, value, set) {
    const record = this.record(sessionId)
    const hash = this.hashOf(value)
    if (this.classOfHash(sessionId, hash) !== undefined) return
    record[set].add(hash)
    this.dirty = true
  }

  markModelMade(sessionId, value) {
    this.mark(sessionId, value, "model")
  }

  markInput(sessionId, value) {
    this.mark(sessionId, value, "input")
  }

  classOf(sessionId, value) {
    return this.classOfHash(sessionId, this.hashOf(value))
  }

  /**
   * "model", "input" or undefined. Follows parent links; within one session input wins (only a
   * merge of two stores puts a hash in both sets). A cycle (only a corrupt store can hold one)
   * ends the walk.
   */
  classOfHash(sessionId, hash) {
    if (!hash) return undefined
    const seen = new Set()
    for (let id = sessionId; typeof id === "string" && !seen.has(id); id = this.sessions.get(id)?.parent) {
      seen.add(id)
      const record = this.sessions.get(id)
      if (record?.input.has(hash)) return "input"
      if (record?.model.has(hash)) return "model"
    }
    return undefined
  }

  isModelMade(sessionId, value) {
    return this.isModelMadeHash(sessionId, this.hashOf(value))
  }

  isModelMadeHash(sessionId, hash) {
    return this.classOfHash(sessionId, hash) === "model"
  }

  /** Called with the restored prompt of a `subagent` call, which is what the child receives. */
  addHandoff(prompt, parentId, now = Date.now()) {
    this.handoffs.set(this.hashOf(prompt), { parent: parentId, lastUsed: now })
    this.dirty = true
  }

  /** Links a session to its parent when its first user message is a prompt the parent handed off. */
  linkSubagent(sessionId, firstUserText) {
    if (typeof firstUserText !== "string" || !firstUserText.startsWith(SUBAGENT_PREAMBLE)) return false
    if (this.sessions.get(sessionId)?.parent !== undefined) return false
    const handoff = this.handoffs.get(this.hashOf(firstUserText.slice(SUBAGENT_PREAMBLE.length)))
    if (!handoff || handoff.parent === sessionId) return false
    this.record(sessionId).parent = handoff.parent
    this.dirty = true
    return true
  }

  cleanup(now = Date.now()) {
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) return
    for (const [id, record] of this.sessions) {
      if (now - record.lastUsed > this.ttlMs) {
        this.sessions.delete(id)
        this.dirty = true
      }
    }
    for (const [hash, handoff] of this.handoffs) {
      if (now - handoff.lastUsed > this.ttlMs) {
        this.handoffs.delete(hash)
        this.dirty = true
      }
    }
  }

  exportState() {
    const sessions = {}
    for (const [id, record] of this.sessions) {
      sessions[id] = { lastUsed: record.lastUsed, ...(record.parent !== undefined && { parent: record.parent }), model: [...record.model], input: [...record.input] }
    }
    return { sessions, handoffs: [...this.handoffs].map(([hash, handoff]) => [hash, handoff.parent, handoff.lastUsed]) }
  }

  /** Takes state from the store, merged into memory; malformed entries are skipped. Does not set `dirty`. */
  importState({ sessions, handoffs } = {}) {
    const hashes = (list) => (Array.isArray(list) ? list.filter((hash) => typeof hash === "string") : [])
    for (const [id, record] of Object.entries(sessions ?? {})) {
      if (!record || !Number.isFinite(record.lastUsed)) continue
      const current = this.sessions.get(id) ?? { lastUsed: record.lastUsed, model: new Set(), input: new Set() }
      current.lastUsed = Math.max(current.lastUsed, record.lastUsed)
      if (current.parent === undefined && typeof record.parent === "string") current.parent = record.parent
      for (const hash of hashes(record.model)) current.model.add(hash)
      for (const hash of hashes(record.input)) current.input.add(hash)
      this.sessions.set(id, current)
    }
    for (const entry of Array.isArray(handoffs) ? handoffs : []) {
      if (!Array.isArray(entry)) continue
      const [hash, parent, usedAt] = entry
      if (typeof hash !== "string" || typeof parent !== "string" || !Number.isFinite(usedAt)) continue
      const current = this.handoffs.get(hash)
      if (!current || current.lastUsed < usedAt) this.handoffs.set(hash, { parent, lastUsed: usedAt })
    }
  }
}
