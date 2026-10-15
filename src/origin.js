import { RENEW_STEP_MS } from "./session.js"

/** OpenCode starts a subagent's first user message with this line, then the parent's prompt. */
export const SUBAGENT_PREAMBLE = "You are a subagent spawned by another session.\n"

/**
 * Which values the model made up, per session. A value is kept as the 12-hex HMAC a placeholder
 * carries (`hashOf`), never in plain text. A subagent session links to the session that spawned
 * it and sees its parent's values as made up too. `dirty` is set by any change; a renewal sets it
 * only when it moves last use forward by RENEW_STEP_MS.
 */
export class OriginTracker {
  /** @param {{ hashOf(value: string): string, ttlMs: number }} options */
  constructor({ hashOf, ttlMs }) {
    this.hashOf = hashOf
    this.ttlMs = ttlMs
    /** @type {Map<string, { lastUsed: number, parent?: string, model: Set<string> }>} */
    this.sessions = new Map()
    /** @type {Map<string, { parent: string, lastUsed: number }>} prompt hash -> parent session */
    this.handoffs = new Map()
    this.dirty = false
  }

  /** The session's record, created or renewed; a renewal alone sets `dirty` as PlaceholderSession#touch does. */
  record(sessionId, now = Date.now()) {
    let record = this.sessions.get(sessionId)
    if (!record) {
      record = { lastUsed: now, model: new Set() }
      this.sessions.set(sessionId, record)
      this.dirty = true
    } else if (record.lastUsed < now) {
      if (now - record.lastUsed >= RENEW_STEP_MS) this.dirty = true
      record.lastUsed = now
    }
    return record
  }

  markModelMade(sessionId, value) {
    const record = this.record(sessionId)
    const hash = this.hashOf(value)
    if (record.model.has(hash)) return
    record.model.add(hash)
    this.dirty = true
  }

  isModelMade(sessionId, value) {
    return this.isModelMadeHash(sessionId, this.hashOf(value))
  }

  /** Follows parent links; a cycle (only a corrupt store can hold one) ends the walk. */
  isModelMadeHash(sessionId, hash) {
    if (!hash) return false
    const seen = new Set()
    for (let id = sessionId; typeof id === "string" && !seen.has(id); id = this.sessions.get(id)?.parent) {
      seen.add(id)
      if (this.sessions.get(id)?.model.has(hash)) return true
    }
    return false
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
      sessions[id] = { lastUsed: record.lastUsed, ...(record.parent !== undefined && { parent: record.parent }), model: [...record.model] }
    }
    return { sessions, handoffs: [...this.handoffs].map(([hash, handoff]) => [hash, handoff.parent, handoff.lastUsed]) }
  }

  /** Takes state from the store, merged into memory; malformed entries are skipped. Does not set `dirty`. */
  importState({ sessions, handoffs } = {}) {
    for (const [id, record] of Object.entries(sessions ?? {})) {
      if (!record || !Number.isFinite(record.lastUsed)) continue
      const current = this.sessions.get(id) ?? { lastUsed: record.lastUsed, model: new Set() }
      current.lastUsed = Math.max(current.lastUsed, record.lastUsed)
      if (current.parent === undefined && typeof record.parent === "string") current.parent = record.parent
      for (const hash of Array.isArray(record.model) ? record.model : []) if (typeof hash === "string") current.model.add(hash)
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
