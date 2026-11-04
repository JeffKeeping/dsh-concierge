/**
 * Router context compaction.
 *
 * The Router is one long-lived Session. Left alone, its context grows with the number of
 * tickets, and a long orchestration eventually drowns in its own history. This keeps the
 * growth flat: an early decision is replaced by a `blob:` reference plus a one-line
 * summary, and the summary line is what stays visible. Nothing is deleted — the reference
 * reads back through `superagent_read`, and `followRef` walks from it to its sources.
 *
 * The policy is per producer, as the ROADMAP asks. Routing decisions age out first
 * (they are history), then progress notices; a terminal report is kept inline because it
 * is what the operator is waiting for.
 */
import { summarize } from './text.js'

/** How many entries of each kind stay inline before the oldest becomes a reference. */
export const KEEP = Object.freeze({
  decision: 6,
  progress: 4,
  terminal: 12,
  watchdog: 2,
})

export class ContextSpill {
  /**
   * @param {{ state: import('./state.js').State, inlineChars: number, logger: any }} options
   */
  constructor({ state, inlineChars, logger }) {
    this.state = state
    this.inlineChars = inlineChars
    this.logger = logger
    /** The compacted view the Router is given: newest first, each entry summarised. */
    this.entries = []
    /** Counts, so the overview can show that compaction is working. */
    this.compacted = 0
  }

  /**
   * Add one Router-visible item. Oversized bodies and aged-out history both become
   * references; the summary line stays inline in either case.
   *
   * @param {{ kind: 'decision'|'progress'|'terminal'|'watchdog', text: string,
   *           ref?: string, summary?: string }} item
   */
  add(item) {
    const text = String(item.text ?? '')
    const summary = item.summary ?? summarize(text, 160)
    let ref = item.ref
    // Oversized on its own: spill it immediately rather than waiting for the age rule.
    if (ref === undefined && text.length > this.inlineChars) {
      try {
        const blobId = this.state.spill(text, summary)
        ref = `blob:${blobId}`
        if (item.ref_from) this.state.addRefEdge(item.ref_from, ref, 'compacted')
      } catch (error) {
        this.logger?.warn?.(`dsh-concierge could not spill a router item: ${String(error)}`)
      }
    }
    this.entries.push({ kind: item.kind, at: Date.now(), text: ref ? undefined : text, ref, summary })
    this.compact(item.kind)
    return ref
  }

  /** Age out the oldest entries of one kind once its inline budget is exceeded. */
  compact(kind) {
    const keep = KEEP[kind] ?? 4
    const ofKind = this.entries.filter(entry => entry.kind === kind)
    if (ofKind.length <= keep) return
    const excess = ofKind.slice(0, ofKind.length - keep)
    for (const entry of excess) {
      if (entry.ref !== undefined) continue
      try {
        const blobId = this.state.spill(entry.text ?? entry.summary, entry.summary)
        entry.ref = `blob:${blobId}`
        entry.text = undefined
        this.compacted += 1
      } catch (error) {
        this.logger?.warn?.(`dsh-concierge could not compact a router entry: ${String(error)}`)
      }
    }
  }

  /** The compact view: what the Router sees on each turn. Bounded by construction. */
  view() {
    return {
      entries: this.entries.slice(-40).map(entry => ({
        kind: entry.kind,
        at: new Date(entry.at).toISOString(),
        summary: entry.summary,
        ...(entry.ref ? { read: entry.ref } : { inline: entry.text }),
      })),
      compacted: this.compacted,
    }
  }

  /** Bytes of inline text still held, for the overview and for tests. */
  inlineBytes() {
    let total = 0
    for (const entry of this.entries) if (entry.text !== undefined) total += Buffer.byteLength(entry.text, 'utf8')
    return total
  }
}
