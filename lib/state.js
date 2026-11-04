/**
 * The single writer of dsh-concierge state.
 *
 * Every mutation of a Ticket, a Thread, a routed message or a spilled reference goes
 * through this class, and every write is one SQLite transaction. Readers (the tool
 * surface, the watchdog) only ever call the read methods, so no two code paths can
 * disagree about a Ticket's status.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { clip, digest, summarize } from './text.js'
import { markOnce } from './untrusted.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ticket (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  status           TEXT NOT NULL,
  thread_key       TEXT NOT NULL,
  session_id       TEXT,
  router_session   TEXT,
  intent           TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  started_at       INTEGER,
  ended_at         INTEGER,
  rounds           INTEGER NOT NULL DEFAULT 0,
  last_report      TEXT,
  last_report_state TEXT,
  failure          TEXT
);
CREATE TABLE IF NOT EXISTS message (
  id         TEXT PRIMARY KEY,
  ticket_id  TEXT NOT NULL,
  role       TEXT NOT NULL,
  text       TEXT,
  blob_id    TEXT,
  request_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS blob (
  id         TEXT PRIMARY KEY,
  content    TEXT NOT NULL,
  summary    TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS route_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        INTEGER NOT NULL,
  kind      TEXT NOT NULL,
  ticket_id TEXT,
  detail    TEXT
);
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- v2 Sources ---------------------------------------------------------------
-- One row per Source instance: kind selects the SourceKind implementation. The read
-- position lives here so a restart never replays events, and bot_id is the identity
-- whose own messages must never become Triggers.
CREATE TABLE IF NOT EXISTS source (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  config     TEXT NOT NULL,
  bot_id     TEXT,
  cursor     TEXT,
  health     TEXT,
  health_at  INTEGER,
  updated_at INTEGER NOT NULL
);
-- One row per event. The id is the idempotency key: the same event delivered twice can
-- only ever produce one Trigger, and therefore at most one Ticket.
CREATE TABLE IF NOT EXISTS trigger_event (
  id        TEXT PRIMARY KEY,
  source    TEXT NOT NULL,
  thread_key TEXT NOT NULL,
  actor     TEXT,
  human     INTEGER NOT NULL DEFAULT 1,
  addressed TEXT,
  text      TEXT,
  meta      TEXT,
  channel   TEXT,
  url       TEXT,
  disposition TEXT NOT NULL,
  reason    TEXT,
  at        INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
-- Many-to-many: one Thread can carry several Tickets, one Ticket follows several Threads.
CREATE TABLE IF NOT EXISTS subscription (
  ticket_id  TEXT NOT NULL,
  thread_key TEXT NOT NULL,
  origin     TEXT NOT NULL DEFAULT 'source',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (ticket_id, thread_key)
);
-- The Channel write side: ordered per destination, retried with backoff, dropped only
-- when the destination can never receive the message.
CREATE TABLE IF NOT EXISTS channel_message (
  id          TEXT PRIMARY KEY,
  ticket_id   TEXT NOT NULL,
  channel     TEXT NOT NULL,
  thread      TEXT NOT NULL,
  address     TEXT NOT NULL,
  text        TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'pending',
  attempts    INTEGER NOT NULL DEFAULT 0,
  next_at     INTEGER NOT NULL,
  reason      TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ticket_status ON ticket(status, created_at);
CREATE INDEX IF NOT EXISTS trigger_thread ON trigger_event(thread_key, created_at);
CREATE INDEX IF NOT EXISTS trigger_source ON trigger_event(source, created_at);
CREATE INDEX IF NOT EXISTS subscription_thread ON subscription(thread_key);
CREATE INDEX IF NOT EXISTS channel_pending ON channel_message(state, next_at);
CREATE INDEX IF NOT EXISTS message_ticket ON message(ticket_id, created_at);
`

/**
 * Additive migrations.
 *
 * Every new capability only *adds* columns and tables; nothing is dropped or rewritten in
 * place, so a v1 or v2 database opens unchanged and keeps all its rows. `ALTER TABLE ADD
 * COLUMN` is used rather than a table rebuild because SQLite cannot drop a column that an
 * index or a view references, and a rebuild would need care with existing rows.
 *
 * @returns {{ applied: string[], columns: Record<string, string[]> }}
 */
function migrate(db) {
  const applied = []
  const columns = {}
  const add = (table, name, definition) => {
    const existing = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name)
    columns[table] = existing
    if (existing.includes(name)) return
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
    columns[table] = [...existing, name]
    applied.push(`${table}.${name}`)
  }
  /** Tables created after the first release; `CREATE TABLE IF NOT EXISTS` covers them. */
  db.exec(`
    -- v3: reference derivation, so superagent_read can follow a chain.
    CREATE TABLE IF NOT EXISTS ref_edge (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      from_ref   TEXT NOT NULL,
      to_ref     TEXT NOT NULL,
      kind       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    -- v3: the semantic assessment layer's decisions, for audit and replay.
    CREATE TABLE IF NOT EXISTS semantic_decision (
      id          TEXT PRIMARY KEY,
      trigger_id  TEXT NOT NULL,
      source      TEXT NOT NULL,
      thread_key  TEXT NOT NULL,
      state       TEXT NOT NULL,
      verdict     TEXT,
      reason      TEXT,
      policy_rev  INTEGER,
      gate_strength TEXT NOT NULL,
      context     TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    -- v3: versioned semantic policy text.
    CREATE TABLE IF NOT EXISTS policy_version (
      revision   INTEGER PRIMARY KEY,
      text       TEXT NOT NULL,
      origin     TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    -- v3: a Source's Thread closure, recorded once so a poll cannot close twice.
    CREATE TABLE IF NOT EXISTS thread_closure (
      thread_key TEXT PRIMARY KEY,
      outcome    TEXT NOT NULL,
      at         INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ref_chain_from ON ref_edge(from_ref);
    CREATE INDEX IF NOT EXISTS decision_pending ON semantic_decision(state, created_at);
    -- One decision per Trigger: a replay reads the stored verdict instead of asking again.
    CREATE UNIQUE INDEX IF NOT EXISTS decision_trigger ON semantic_decision(trigger_id);
  `)
  add('ticket', 'origin', "TEXT NOT NULL DEFAULT 'router'")
  add('ticket', 'source_origin', 'TEXT')
  add('ticket', 'blocked_retries', 'INTEGER NOT NULL DEFAULT 0')
  add('source', 'token_fingerprint', 'TEXT')
  // v4: deferral bookkeeping, so a backoff schedule survives a restart.
  add('semantic_decision', 'deferrals', 'INTEGER NOT NULL DEFAULT 0')
  add('semantic_decision', 'next_at', 'INTEGER')
  // v5: the lost-worker grace, and the reopened handover's unverified leads.
  add('ticket', 'nudged_at', 'INTEGER')
  add('ticket', 'leads', 'TEXT')
  add('ticket', 'reopened_from', 'TEXT')
  return { applied, columns }
}

/** The statuses a Ticket may hold. Anything else is a bug in the writer, not a state. */
export const TICKET_STATES = Object.freeze(['queued', 'running', 'done', 'failed'])

export class State {
  /**
   * @param {{ dbPath: string, inlineChars: number }} options
   */
  constructor({ dbPath, inlineChars }) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.dbPath = dbPath
    this.inlineChars = inlineChars
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec(SCHEMA)
    /** Columns added after v1/v2 shipped; applied in place so an old database opens. */
    this.migrated = migrate(this.db)
    this.closed = false
  }

  /** Run `fn` inside one immediate transaction; rollback on throw. */
  tx(fn) {
    if (this.closed) throw new Error('dsh-concierge state is closed')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const value = fn()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* the transaction is already gone */ }
      throw error
    }
  }

  close() {
    if (this.closed) return
    this.closed = true
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)') } catch { /* best effort */ }
    try { this.db.close() } catch { /* best effort */ }
  }

  // ---------------------------------------------------------------- references

  /**
   * Store long content and return its reference.
   * Content within `inlineChars` stays where the caller already put it, so only the
   * oversized part of a payload becomes a reference.
   */
  spill(content, summary = undefined) {
    const id = `blob-${randomUUID().slice(0, 8)}`
    const text = String(content ?? '')
    this.db.prepare('INSERT INTO blob (id, content, summary, bytes, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, text, summary ?? summarize(text), Buffer.byteLength(text, 'utf8'), Date.now())
    return id
  }

  /** Read one reference: `ticket:<id>`, `thread:<key>`, `blob:<id>`, `msg:<id>`, `report:<ticket id>`. */
  readRef(ref, offset = 0, limit = undefined) {
    const raw = String(ref ?? '').trim()
    const at = raw.indexOf(':')
    if (at < 0) throw new Error(`unrecognised reference "${raw}"; use ticket:<id>, thread:<key>, blob:<id>, msg:<id> or report:<ticket id>`)
    const kind = raw.slice(0, at)
    const key = raw.slice(at + 1)
    let content
    if (kind === 'blob') {
      const row = this.db.prepare('SELECT content FROM blob WHERE id = ?').get(key)
      if (!row) throw new Error(`no spilled content "${key}"`)
      content = row.content
    } else if (kind === 'msg') {
      const row = this.db.prepare('SELECT text, blob_id FROM message WHERE id = ?').get(key)
      if (!row) throw new Error(`no message "${key}"`)
      content = row.blob_id
        ? (this.db.prepare('SELECT content FROM blob WHERE id = ?').get(row.blob_id)?.content ?? row.text ?? '')
        : (row.text ?? '')
    } else if (kind === 'ticket') {
      const ticket = this.getTicket(key)
      if (!ticket) throw new Error(`no ticket "${key}"`)
      content = JSON.stringify(ticket, null, 2)
    } else if (kind === 'report') {
      const ticket = this.getTicket(key)
      if (!ticket) throw new Error(`no ticket "${key}"`)
      content = ticket.lastReport ?? '(no report yet)'
    } else if (kind === 'thread') {
      const rows = this.db.prepare('SELECT id, role, text, blob_id, created_at FROM message WHERE ticket_id IN (SELECT ticket_id FROM ticket WHERE thread_key = ?) ORDER BY created_at ASC').all(key)
      content = rows.map(row => `[${row.role}] ${row.blob_id ? `(see blob:${row.blob_id}) ` : ''}${row.text ?? ''}`).join('\n')
    } else {
      throw new Error(`unknown reference kind "${kind}"`)
    }
    const text = String(content ?? '')
    if (limit === undefined && offset === 0) return { ref: raw, bytes: Buffer.byteLength(text, 'utf8'), content: text }
    const slice = text.slice(offset, limit === undefined ? undefined : offset + limit)
    return {
      ref: raw,
      bytes: Buffer.byteLength(text, 'utf8'),
      offset,
      returned: slice.length,
      truncated: offset + slice.length < text.length,
      content: slice,
    }
  }

  /**
   * The ticket's original request text.
   *
   * For a Source-backed ticket the text is external, so it is returned with the boundary
   * marker applied. The marker is applied at *read* time on top of stored text and is also
   * stored for source tickets (see `createTicket`), which is why a spilled or truncated
   * preview still shows it.
   */
  intentText(ticket) {
    const raw = this.rawIntentText(ticket)
    return ticket.origin === 'source' ? markOnce(raw, { origin: ticket.sourceOrigin }) : raw
  }

  /** The stored text without a marker, for internal comparisons. */
  rawIntentText(ticket) {
    if (!ticket.intent.startsWith('blob:')) return ticket.intent
    try {
      return this.readRef(ticket.intent).content
    } catch {
      return this.readRef(`msg:${ticket.id}-m0`).content
    }
  }

  /** Where a ticket came from: `router` for an operator request, `source` for a Trigger. */
  ticketOrigin(ticketId) {
    const row = this.db.prepare('SELECT origin FROM ticket WHERE id = ?').get(String(ticketId ?? ''))
    return row?.origin ?? 'router'
  }

  /**
   * Whether `blobId` is reachable from `ticketId`: referenced by one of its messages, its
   * intent, a report it produced, or an edge in the recall chain it owns.
   */
  blobBelongsTo(ticketId, blobId) {
    const id = String(ticketId ?? '')
    const blob = String(blobId ?? '')
    if (id === '' || blob === '') return false
    const ref = `blob:${blob}`
    const viaMessage = this.db.prepare('SELECT 1 AS hit FROM message WHERE ticket_id = ? AND blob_id = ? LIMIT 1').get(id, blob)
    if (viaMessage) return true
    const viaIntent = this.db.prepare('SELECT 1 AS hit FROM ticket WHERE id = ? AND intent = ? LIMIT 1').get(id, ref)
    if (viaIntent) return true
    // A report that spilled its body stores the reference inside last_report's JSON.
    const report = this.db.prepare('SELECT last_report FROM ticket WHERE id = ?').get(id)?.last_report
    if (typeof report === 'string' && report.includes(ref)) return true
    // The recall chain: an edge owned by a reference this ticket can already read.
    const edges = this.db.prepare('SELECT from_ref FROM ref_edge WHERE to_ref = ?').all(ref)
    return edges.some(edge => {
      const owner = String(edge.from_ref)
      if (owner.startsWith(`ticket:${id}`) || owner.startsWith(`report:${id}`) || owner.startsWith(`msg:${id}-`)) return true
      return false
    })
  }

  // ------------------------------------------------------------------- tickets

  createTicket({ title, intent, threadKey = undefined, origin = 'router', routerSession = undefined, sourceOrigin = undefined, reopenedFrom = undefined }) {
    const id = `t-${randomUUID().slice(0, 8)}`
    const now = Date.now()
    const key = threadKey ?? `thread-${id}`
    // External text carries its boundary into storage, so a spilled blob keeps it too.
    const text = origin === 'source' ? markOnce(intent, { origin: sourceOrigin }) : intent
    const stored = text.length > this.inlineChars ? this.spill(text, summarize(text)) : undefined
    this.tx(() => {
      this.db.prepare(`INSERT INTO ticket (id, title, status, thread_key, router_session, intent, origin, source_origin, reopened_from, created_at, updated_at)
                       VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, title, key, routerSession ?? null, stored ? `blob:${stored}` : text, origin, sourceOrigin ?? null, reopenedFrom ?? null, now, now)
      if (stored) this.db.prepare('INSERT INTO message (id, ticket_id, role, blob_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(`${id}-m0`, id, origin, stored, now)
      else this.db.prepare('INSERT INTO message (id, ticket_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(`${id}-m0`, id, origin, text, now)
      this.log('ticket/created', id, title)
    })
    return this.getTicket(id)
  }

  getTicket(id) {
    const row = this.db.prepare('SELECT * FROM ticket WHERE id = ?').get(String(id ?? ''))
    return row ? hydrate(row) : undefined
  }

  listTickets({ status = 'open', limit = 20 } = {}) {
    const sql = status === 'all'
      ? 'SELECT * FROM ticket ORDER BY created_at DESC LIMIT ?'
      : "SELECT * FROM ticket WHERE status IN ('queued','running') ORDER BY created_at ASC LIMIT ?"
    return this.db.prepare(sql).all(limit).map(hydrate)
  }

  /** Take up to `max` queued tickets, oldest first, and mark them running. */
  claimNext(max) {
    if (max <= 0) return []
    const candidates = this.db.prepare("SELECT id FROM ticket WHERE status = 'queued' ORDER BY created_at ASC LIMIT ?").all(max)
    const claimed = []
    for (const { id } of candidates) {
      const now = Date.now()
      const result = this.db.prepare("UPDATE ticket SET status = 'running', started_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'").run(now, now, id)
      if (result.changes === 1) {
        this.log('ticket/started', id)
        claimed.push(this.getTicket(id))
      }
    }
    return claimed
  }

  /** Record the worker session that serves a ticket. */
  attachSession(id, sessionId) {
    this.tx(() => {
      this.db.prepare('UPDATE ticket SET session_id = ?, updated_at = ? WHERE id = ?').run(sessionId, Date.now(), id)
    })
    return this.getTicket(id)
  }

  bumpRound(id) {
    this.tx(() => {
      this.db.prepare('UPDATE ticket SET rounds = rounds + 1, updated_at = ? WHERE id = ?').run(Date.now(), id)
    })
    return this.getTicket(id)
  }

  setStatus(id, status, { failure = null } = {}) {
    if (!TICKET_STATES.includes(status)) throw new Error(`unknown ticket status "${status}"`)
    const now = Date.now()
    this.tx(() => {
      const ended = status === 'done' || status === 'failed'
      this.db.prepare('UPDATE ticket SET status = ?, updated_at = ?, ended_at = ?, failure = ? WHERE id = ?')
        .run(status, now, ended ? now : null, failure, id)
      this.log(`ticket/${status}`, id, failure ?? undefined)
    })
    return this.getTicket(id)
  }

  /**
   * Record that someone asked this ticket's worker to report, and when.
   *
   * The watchdog reads this to decide whether it may fail a silent ticket yet: one nudge
   * plus one inspection period is the grace it grants before closing anything.
   */
  markNudged(ticketId) {
    this.tx(() => {
      this.db.prepare('UPDATE ticket SET nudged_at = ?, updated_at = ? WHERE id = ?')
        .run(Date.now(), Date.now(), String(ticketId ?? ''))
    })
  }

  /** Store the Router's unverified observations for a reopened ticket. */
  setLeads(ticketId, leads) {
    const list = Array.isArray(leads) ? leads.filter(lead => String(lead ?? '').trim() !== '') : []
    this.tx(() => {
      this.db.prepare('UPDATE ticket SET leads = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(list), Date.now(), String(ticketId ?? ''))
      this.log('ticket/leads', ticketId, `${list.length} unverified lead(s)`)
    })
    return list
  }

  /** When the worker was last asked to report, or undefined when never asked. */
  nudgedAt(ticketId) {
    const row = this.db.prepare('SELECT nudged_at FROM ticket WHERE id = ?').get(String(ticketId ?? ''))
    return row?.nudged_at ?? undefined
  }

  /** Record a rejected report so the Router can be told a worker tried but broke the contract. */
  markNudgeCleared(ticketId) {
    this.db.prepare('UPDATE ticket SET nudged_at = NULL WHERE id = ?').run(String(ticketId ?? ''))
  }

  /** Record one blocked report; returns the new consecutive count. */
  bumpBlockedRetry(ticketId) {    this.tx(() => {
      this.db.prepare('UPDATE ticket SET blocked_retries = blocked_retries + 1, updated_at = ? WHERE id = ?')
        .run(Date.now(), ticketId)
    })
    const row = this.db.prepare('SELECT blocked_retries FROM ticket WHERE id = ?').get(String(ticketId ?? ''))
    return row?.blocked_retries ?? 0
  }

  /** A ticket that made progress is no longer on a blocked streak. */
  resetBlockedRetry(ticketId) {
    this.db.prepare('UPDATE ticket SET blocked_retries = 0 WHERE id = ? AND blocked_retries <> 0').run(String(ticketId ?? ''))
  }

  /** Put a ticket back in the queue so the supervisor launches it again. */
  requeue(id) {
    const now = Date.now()
    this.tx(() => {
      this.db.prepare("UPDATE ticket SET status = 'queued', updated_at = ?, ended_at = NULL WHERE id = ?").run(now, id)
      this.log('ticket/requeued', id)
    })
    return this.getTicket(id)
  }

  /** Recover statuses left behind by a crash or a restart of the Host process. */
  recoverOnBoot() {
    const stale = this.db.prepare("SELECT id FROM ticket WHERE status = 'running'").all()
    if (stale.length === 0) return { requeued: 0 }
    const now = Date.now()
    this.tx(() => {
      for (const { id } of stale) {
        this.db.prepare("UPDATE ticket SET status = 'queued', updated_at = ? WHERE id = ?").run(now, id)
        this.log('ticket/recovered', id, 'host restart')
      }
    })
    return { requeued: stale.length }
  }

  // ------------------------------------------------------------------ messages

  appendMessage(ticketId, role, text, { requestId = null } = {}) {
    const id = `${ticketId}-m${randomUUID().slice(0, 6)}`
    const now = Date.now()
    const stored = text.length > this.inlineChars ? this.spill(text, summarize(text)) : undefined
    this.tx(() => {
      if (stored) this.db.prepare('INSERT INTO message (id, ticket_id, role, blob_id, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, ticketId, role, stored, requestId, now)
      else this.db.prepare('INSERT INTO message (id, ticket_id, role, text, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, ticketId, role, text, requestId, now)
      this.db.prepare('UPDATE ticket SET updated_at = ? WHERE id = ?').run(now, ticketId)
      this.log('message', ticketId, role)
    })
    return id
  }

  messages(ticketId, limit = 20) {
    return this.db.prepare('SELECT id, role, text, blob_id, created_at FROM message WHERE ticket_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(ticketId, limit).reverse()
  }

  /** Inline thread context for a Ticket: recent messages inline, older ones as references. */
  inlineContext(ticketId, inlineMessages = 6) {
    const rows = this.messages(ticketId, 50)
    const recent = rows.slice(-inlineMessages)
    const folded = rows.slice(0, Math.max(0, rows.length - inlineMessages))
    return {
      recent: recent.map(row => ({
        id: row.id,
        role: row.role,
        at: row.created_at,
        text: row.blob_id ? `(spilled) ${this.db.prepare('SELECT summary FROM blob WHERE id = ?').get(row.blob_id)?.summary ?? ''}` : clip(row.text ?? '', 400).text,
        ...(row.blob_id ? { read: `blob:${row.blob_id}` } : {}),
      })),
      folded: folded.map(row => ({
        id: row.id,
        role: row.role,
        at: row.created_at,
        read: row.blob_id ? `blob:${row.blob_id}` : `msg:${row.id}`,
        summary: row.blob_id
          ? (this.db.prepare('SELECT summary FROM blob WHERE id = ?').get(row.blob_id)?.summary ?? '')
          : summarize(row.text ?? ''),
      })),
    }
  }

  // -------------------------------------------------------------------- report

  report(ticketId, { summary, state = 'progress', next = undefined, workspace = undefined }) {
    const ticket = this.getTicket(ticketId)
    if (!ticket) throw new Error(`no ticket "${ticketId}"`)
    const now = Date.now()
    const payload = JSON.stringify({ state, summary, next, workspace, at: now })
    this.tx(() => {
      this.db.prepare('UPDATE ticket SET last_report = ?, last_report_state = ?, updated_at = ? WHERE id = ?')
        .run(payload, state, now, ticketId)
      this.log(`report/${state}`, ticketId, summarize(summary, 120))
    })
    return this.getTicket(ticketId)
  }

  // ------------------------------------------------------------------------- kv

  getKV(key, fallback = undefined) {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key)
    return row ? row.value : fallback
  }

  setKV(key, value) {
    this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value))
  }

  // ------------------------------------------------------------------ sources

  /** Create or replace one Source instance. Configuration is stored as JSON. */
  upsertSource({ id, kind, enabled = true, config = {}, botId = null, tokenFingerprint = undefined }) {
    const now = Date.now()
    this.tx(() => {
      this.db.prepare(`INSERT INTO source (id, kind, enabled, config, bot_id, token_fingerprint, cursor, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
                       ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, enabled = excluded.enabled,
                         config = excluded.config, bot_id = excluded.bot_id,
                         token_fingerprint = excluded.token_fingerprint, updated_at = excluded.updated_at`)
        .run(id, kind, enabled ? 1 : 0, JSON.stringify(config ?? {}), botId, tokenFingerprint ?? null, now)
      this.log('source/upserted', null, `${kind}:${id}`)
    })
    return this.getSource(id)
  }

  getSource(id) {
    const row = this.db.prepare('SELECT * FROM source WHERE id = ?').get(String(id ?? ''))
    return row ? hydrateSource(row) : undefined
  }

  listSources(kind = undefined) {
    const rows = kind
      ? this.db.prepare('SELECT * FROM source WHERE kind = ? ORDER BY id').all(kind)
      : this.db.prepare('SELECT * FROM source ORDER BY id').all()
    return rows.map(hydrateSource)
  }

  /** The read position of one Source; a string so any cursor representation survives. */
  sourceCursor(id) {
    return this.db.prepare('SELECT cursor FROM source WHERE id = ?').get(String(id ?? ''))?.cursor ?? undefined
  }

  setSourceHealth(id, health) {
    this.tx(() => {
      this.db.prepare('UPDATE source SET health = ?, health_at = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(health ?? null), Date.now(), Date.now(), id)
    })
  }

  // ----------------------------------------------------------------- triggers

  /**
   * Store one Trigger together with the cursor move, in ONE transaction.
   *
   * This is the interruption guarantee: either the Trigger is stored *and* the cursor
   * moved past it, or neither happened and the next round reads it again. A duplicate id
   * returns `duplicate` and never touches the cursor's meaning — replay is safe because
   * the id is the idempotency key.
   *
   * @returns {{ outcome: 'stored'|'duplicate'|'filtered', triggerId: string, ticketId?: string }}
   */
  ingestTrigger(sourceId, trigger, disposition, { reason = null, cursor = undefined } = {}) {
    return this.tx(() => {
      const now = Date.now()
      const existing = this.db.prepare('SELECT id, disposition FROM trigger_event WHERE id = ?').get(trigger.id)
      if (existing) {
        // A replay is safe *and* must still let a later round move forward: the event is
        // already stored, so the cursor may pass it. This is what makes an interrupted
        // round resumable instead of stuck on the same duplicate forever.
        if (cursor !== undefined) {
          this.db.prepare('UPDATE source SET cursor = ?, updated_at = ? WHERE id = ?').run(String(cursor), now, sourceId)
        }
        return { outcome: 'duplicate', triggerId: trigger.id }
      }
      this.db.prepare(`INSERT INTO trigger_event
        (id, source, thread_key, actor, human, addressed, text, meta, channel, url, disposition, reason, at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          trigger.id,
          sourceId,
          trigger.threadKey,
          trigger.actor ?? null,
          trigger.human ? 1 : 0,
          trigger.addressed ?? null,
          trigger.text ?? null,
          JSON.stringify(trigger.meta ?? {}),
          trigger.channel ? JSON.stringify(trigger.channel) : null,
          trigger.url ?? null,
          disposition,
          reason,
          trigger.at ?? now,
          now,
        )
      // Only a round that stored everything it read may advance the cursor.
      if (cursor !== undefined) {
        this.db.prepare('UPDATE source SET cursor = ?, updated_at = ? WHERE id = ?').run(String(cursor), now, sourceId)
      }
      this.log(`trigger/${disposition}`, null, `${trigger.id}${reason ? ` (${reason})` : ''}`)
      return { outcome: disposition === 'stored' ? 'stored' : 'filtered', triggerId: trigger.id }
    })
  }

  /**
   * Mark one round complete: every Trigger it covered is stored, so the cursor may move.
   * Called once after a batch, which is stricter than moving per item.
   */
  commitRound(sourceId, cursor) {
    if (cursor === undefined) return
    this.tx(() => {
      this.db.prepare('UPDATE source SET cursor = ?, updated_at = ? WHERE id = ?').run(String(cursor), Date.now(), sourceId)
      this.log('source/round', null, `${sourceId} -> ${cursor}`)
    })
  }

  /** Move a Source's cursor without storing anything, for a round that read nothing. */
  advanceCursor(sourceId, cursor) {
    this.tx(() => {
      this.db.prepare('UPDATE source SET cursor = ?, updated_at = ? WHERE id = ?').run(String(cursor), Date.now(), sourceId)
    })
  }

  getTrigger(id) {
    const row = this.db.prepare('SELECT * FROM trigger_event WHERE id = ?').get(String(id ?? ''))
    return row ? hydrateTrigger(row) : undefined
  }

  /** Triggers on one Thread, oldest first — the Thread's context for assessment. */
  threadTriggers(threadKey, limit = 50) {
    return this.db.prepare('SELECT * FROM trigger_event WHERE thread_key = ? ORDER BY at ASC, created_at ASC LIMIT ?')
      .all(String(threadKey ?? ''), limit).map(hydrateTrigger)
  }

  /** Recent Triggers with their disposition, so a filtered event is never invisible. */
  listTriggers({ source = undefined, disposition = undefined, limit = 20 } = {}) {
    const where = []
    const args = []
    if (source !== undefined) { where.push('source = ?'); args.push(source) }
    if (disposition !== undefined) { where.push('disposition = ?'); args.push(disposition) }
    const sql = `SELECT * FROM trigger_event ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`
    return this.db.prepare(sql).all(...args, limit).map(hydrateTrigger)
  }

  // ------------------------------------------------------------ subscriptions

  /** Subscribe a Ticket to a Thread. Many-to-many: neither side is exclusive. */
  subscribe(ticketId, threadKey, origin = 'source') {
    this.tx(() => {
      this.db.prepare(`INSERT INTO subscription (ticket_id, thread_key, origin, created_at) VALUES (?, ?, ?, ?)
                       ON CONFLICT(ticket_id, thread_key) DO NOTHING`)
        .run(ticketId, threadKey, origin, Date.now())
      this.log('subscription/added', ticketId, threadKey)
    })
  }

  unsubscribe(ticketId, threadKey) {
    this.tx(() => {
      this.db.prepare('DELETE FROM subscription WHERE ticket_id = ? AND thread_key = ?').run(ticketId, threadKey)
      this.log('subscription/removed', ticketId, threadKey)
    })
  }

  /** Live Tickets following one Thread: the fan-out set for a new Trigger. */
  subscribers(threadKey) {
    return this.db.prepare(`SELECT t.* FROM subscription s JOIN ticket t ON t.id = s.ticket_id
                            WHERE s.thread_key = ? AND t.status IN ('queued','running')
                            ORDER BY t.created_at ASC`).all(String(threadKey ?? '')).map(hydrate)
  }

  subscriptionsOf(ticketId) {
    return this.db.prepare('SELECT thread_key, origin, created_at FROM subscription WHERE ticket_id = ? ORDER BY created_at')
      .all(String(ticketId ?? '')).map(row => ({ threadKey: row.thread_key, origin: row.origin, createdAt: row.created_at }))
  }

  /** Threads of one instance that a live Ticket follows: the set to poll for closure. */
  liveGithubThreads(instanceId) {
    const prefix = `github:${instanceId}:%`
    return this.db.prepare(`SELECT DISTINCT s.thread_key FROM subscription s
                            JOIN ticket t ON t.id = s.ticket_id
                            WHERE s.thread_key LIKE ? AND t.status IN ('queued','running')`)
      .all(prefix).map(row => ({ threadKey: row.thread_key }))
  }

  /** Whether a Thread's closure is already recorded, so a poll does not close twice. */
  hasThreadClosed(threadKey) {
    const row = this.db.prepare("SELECT 1 AS hit FROM thread_closure WHERE thread_key = ? LIMIT 1").get(String(threadKey ?? ''))
    return Boolean(row)
  }

  /** Record that a Source closed a Thread, with its outcome and time. */
  recordThreadClosed(threadKey, outcome, at) {
    this.tx(() => {
      this.db.prepare(`INSERT INTO thread_closure (thread_key, outcome, at, created_at) VALUES (?, ?, ?, ?)
                       ON CONFLICT(thread_key) DO NOTHING`)
        .run(String(threadKey), String(outcome), Number(at) || Date.now(), Date.now())
      this.log('thread/closed', null, `${threadKey} ${outcome}`)
    })
  }

  threadClosure(threadKey) {
    const row = this.db.prepare('SELECT * FROM thread_closure WHERE thread_key = ?').get(String(threadKey ?? ''))
    return row ? { threadKey: row.thread_key, outcome: row.outcome, at: row.at } : undefined
  }

  // ------------------------------------------------------------------ channel

  /** Queue one outbound message. `thread` groups a Ticket's messages for ordering. */
  enqueueChannelMessage({ id, ticketId, channel, thread, address, text }) {
    const now = Date.now()
    this.tx(() => {
      this.db.prepare(`INSERT INTO channel_message (id, ticket_id, channel, thread, address, text, state, attempts, next_at, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
                       ON CONFLICT(id) DO NOTHING`)
        .run(id, ticketId, channel, thread, JSON.stringify(address ?? {}), text, now, now, now)
      this.log('channel/queued', ticketId, `${channel} ${id}`)
    })
  }

  /** Messages whose retry time has come, ordered by thread then creation for stable delivery. */
  dueChannelMessages(now = Date.now(), limit = 20) {
    return this.db.prepare(`SELECT * FROM channel_message WHERE state = 'pending' AND next_at <= ?
                            ORDER BY thread ASC, created_at ASC LIMIT ?`).all(now, limit).map(hydrateChannel)
  }

  /** Whether an earlier message of the same thread has not gone out yet. */
  blockedByEarlier(thread, createdAt, id) {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM channel_message
                                 WHERE thread = ? AND state = 'pending' AND created_at < ? AND id <> ?`)
      .get(thread, createdAt, id)
    return (row?.n ?? 0) > 0
  }

  markChannelSent(id) {
    this.tx(() => {
      this.db.prepare("UPDATE channel_message SET state = 'sent', updated_at = ? WHERE id = ?").run(Date.now(), id)
      this.log('channel/sent', null, id)
    })
  }

  /** Schedule a retry with exponential backoff, capped. */
  markChannelRetry(id, delayMs, reason) {
    const now = Date.now()
    this.tx(() => {
      this.db.prepare(`UPDATE channel_message SET state = 'pending', attempts = attempts + 1,
                       next_at = ?, reason = ?, updated_at = ? WHERE id = ?`).run(now + delayMs, reason, now, id)
      this.log('channel/retry', null, `${id} in ${delayMs}ms: ${reason}`)
    })
  }

  /** Permanently undeliverable: kept with its reason, never queued again. */
  markChannelDropped(id, reason) {
    this.tx(() => {
      this.db.prepare("UPDATE channel_message SET state = 'dropped', reason = ?, updated_at = ? WHERE id = ?")
        .run(reason, Date.now(), id)
      this.log('channel/dropped', null, `${id}: ${reason}`)
    })
  }

  channelMessage(id) {
    const row = this.db.prepare('SELECT * FROM channel_message WHERE id = ?').get(String(id ?? ''))
    return row ? hydrateChannel(row) : undefined
  }

  listChannelMessages({ state = undefined, ticketId = undefined, limit = 50 } = {}) {
    const where = []
    const args = []
    if (state !== undefined) { where.push('state = ?'); args.push(state) }
    if (ticketId !== undefined) { where.push('ticket_id = ?'); args.push(ticketId) }
    const sql = `SELECT * FROM channel_message ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`
    return this.db.prepare(sql).all(...args, limit).map(hydrateChannel)
  }

  /**
   * The reference chain: what `ref` was derived from, one hop at a time.
   *
   * Edges are recorded when a report cites inputs and when a spill is produced from a
   * message, so a chain reads `report:<id>` → the inputs it cited → the blobs behind them.
   * One hop by default, as the ROADMAP specifies; `hops` follows further, bounded so a
   * cycle or a wide fan-out cannot explode the context.
   */
  followRef(ref, hops = 1) {
    const start = String(ref ?? '')
    const seen = new Set([start])
    const levels = []
    let frontier = [start]
    for (let depth = 0; depth < Math.max(1, hops); depth++) {
      const next = []
      const row = []
      for (const current of frontier) {
        const edges = this.db.prepare('SELECT to_ref, kind FROM ref_edge WHERE from_ref = ? ORDER BY id').all(current)
        for (const edge of edges) {
          if (seen.has(edge.to_ref)) continue
          seen.add(edge.to_ref)
          next.push(edge.to_ref)
          row.push({ from: current, ref: edge.to_ref, kind: edge.kind, summary: this.refSummary(edge.to_ref) })
        }
      }
      if (row.length === 0) break
      levels.push({ hop: depth + 1, refs: row })
      frontier = next
    }
    return levels
  }

  /** Record that `from` was derived from `to`. Idempotent for the same pair and kind. */
  addRefEdge(fromRef, toRef, kind = 'derived') {
    if (!fromRef || !toRef || fromRef === toRef) return
    const existing = this.db.prepare('SELECT 1 AS hit FROM ref_edge WHERE from_ref = ? AND to_ref = ? AND kind = ? LIMIT 1')
      .get(String(fromRef), String(toRef), String(kind))
    if (existing) return
    this.db.prepare('INSERT INTO ref_edge (from_ref, to_ref, kind, created_at) VALUES (?, ?, ?, ?)')
      .run(String(fromRef), String(toRef), String(kind), Date.now())
  }

  /** A one-line description of a reference, for a chain listing. */
  refSummary(ref) {
    const raw = String(ref ?? '')
    const at = raw.indexOf(':')
    const kind = at < 0 ? '' : raw.slice(0, at)
    const key = at < 0 ? raw : raw.slice(at + 1)
    try {
      if (kind === 'blob') return this.db.prepare('SELECT summary FROM blob WHERE id = ?').get(key)?.summary ?? ''
      if (kind === 'msg') {
        const row = this.db.prepare('SELECT text, blob_id FROM message WHERE id = ?').get(key)
        if (!row) return ''
        return row.blob_id
          ? (this.db.prepare('SELECT summary FROM blob WHERE id = ?').get(row.blob_id)?.summary ?? '')
          : summarize(row.text ?? '')
      }
      if (kind === 'report') return summarize(this.getTicket(key)?.lastReport ?? '', 120)
      if (kind === 'ticket') return summarize(this.getTicket(key)?.title ?? '', 80)
      if (kind === 'thread') return `${this.threadTriggers(key, 1).length} trigger(s)`
    } catch { /* a damaged row is not an error here */ }
    return ''
  }

  // ------------------------------------------------------------------ semantic

  /** The current semantic policy text and its revision. */
  currentPolicy() {
    const row = this.db.prepare('SELECT revision, text, origin, created_at FROM policy_version ORDER BY revision DESC LIMIT 1').get()
    if (row) return { revision: row.revision, text: row.text, origin: row.origin, createdAt: row.created_at }
    return { revision: 0, text: DEFAULT_SEMANTIC_POLICY, origin: 'builtin', createdAt: Date.now() }
  }

  /** Save a new policy revision; returns it. Immutable, so history stays auditable. */
  savePolicy(text, origin = 'config') {
    const next = (this.db.prepare('SELECT MAX(revision) AS rev FROM policy_version').get()?.rev ?? 0) + 1
    this.tx(() => {
      this.db.prepare('INSERT INTO policy_version (revision, text, origin, created_at) VALUES (?, ?, ?, ?)')
        .run(next, String(text), origin, Date.now())
      this.log('policy/saved', null, `revision ${next} by ${origin}`)
    })
    return this.currentPolicy()
  }

  /** Queue one Trigger for semantic assessment. */
  queueDecision({ triggerId, source, threadKey, strength, context }) {
    const id = `d-${randomUUID().slice(0, 8)}`
    const now = Date.now()
    this.tx(() => {
      this.db.prepare(`INSERT INTO semantic_decision
        (id, trigger_id, source, thread_key, state, gate_strength, context, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)
        ON CONFLICT(trigger_id) DO NOTHING`)
        .run(id, triggerId, source, threadKey, strength, JSON.stringify(context ?? {}), now, now)
      this.log('decision/queued', null, triggerId)
    })
    return this.db.prepare('SELECT * FROM semantic_decision WHERE trigger_id = ?').get(triggerId)
  }

  /**
   * Decisions due for another attempt.
   *
   * A decision becomes due when its `next_at` has passed. `next_at` is a stored timestamp,
   * not an in-memory timer, so a restart resumes the schedule instead of resetting it.
   */
  pendingDecisions(limit = 5, now = Date.now()) {
    return this.db.prepare(`SELECT * FROM semantic_decision
                            WHERE state = 'pending' AND (next_at IS NULL OR next_at <= ?)
                            ORDER BY created_at ASC LIMIT ?`)
      .all(now, limit).map(hydrateDecision)
  }

  /** Every decision still waiting on a verdict, due now or later: the panel's view. */
  deferredDecisions(limit = 20) {
    return this.db.prepare("SELECT * FROM semantic_decision WHERE state = 'pending' ORDER BY created_at ASC LIMIT ?")
      .all(limit).map(hydrateDecision)
  }

  getDecision(triggerId) {
    const row = this.db.prepare('SELECT * FROM semantic_decision WHERE trigger_id = ?').get(String(triggerId ?? ''))
    return row ? hydrateDecision(row) : undefined
  }

  /**
   * Record a verdict. The decision is immutable once decided: a replay reads the stored
   * verdict instead of asking again, which is what makes the layer auditable.
   */
  decideSemantic(triggerId, { verdict, reason = null, policyRevision = null, context = undefined }) {
    const now = Date.now()
    this.tx(() => {
      this.db.prepare(`UPDATE semantic_decision SET state = 'decided', verdict = ?, reason = ?,
                       policy_rev = ?, context = COALESCE(?, context), updated_at = ?
                       WHERE trigger_id = ? AND state = 'pending'`)
        .run(verdict, reason, policyRevision, context === undefined ? null : JSON.stringify(context), now, triggerId)
      this.log(`decision/${verdict}`, null, String(triggerId))
    })
    return this.getDecision(triggerId)
  }

  /**
   * Record one failed or unusable assessment attempt.
   *
   * A deferred decision is not final: it is rescheduled with exponential backoff, so a
   * transient provider failure does not silently drop a Trigger. At `maxDeferrals` the
   * layer stops guessing and records `ignore` with the streak, because a request that
   * cannot be assessed three times running is not going to become assessable.
   *
   * @returns {{ decision: object, escalated: boolean }}
   */
  deferDecision(triggerId, reason, { baseMs = 15 * 60 * 1000, maxDeferrals = 3, now = Date.now() } = {}) {
    const row = this.db.prepare('SELECT deferrals FROM semantic_decision WHERE trigger_id = ?').get(String(triggerId ?? ''))
    const deferrals = (row?.deferrals ?? 0) + 1
    if (deferrals >= maxDeferrals) {
      // Escalate to a final verdict; the reason keeps the whole streak readable.
      this.tx(() => {
        this.db.prepare(`UPDATE semantic_decision SET state = 'decided', verdict = 'ignore', deferrals = ?,
                         reason = ?, next_at = NULL, updated_at = ? WHERE trigger_id = ?`)
          .run(deferrals, `deferred ${deferrals} times; last attempt: ${reason}`, now, triggerId)
        this.log('decision/escalated', null, `${triggerId} after ${deferrals} deferrals`)
      })
      return { decision: this.getDecision(triggerId), escalated: true }
    }
    // 15 minutes, then 30, doubling; capped at one day so a long outage still retries.
    // The delay is measured from the attempt's own clock so a late drain cannot skew it.
    const delay = Math.min(24 * 60 * 60 * 1000, baseMs * 2 ** (deferrals - 1))
    const nextAt = now + delay
    this.tx(() => {
      this.db.prepare(`UPDATE semantic_decision SET state = 'pending', deferrals = ?, reason = ?,
                       next_at = ?, updated_at = ? WHERE trigger_id = ?`)
        .run(deferrals, reason, nextAt, now, triggerId)
      this.log('decision/deferred', null, `${triggerId} attempt ${deferrals}, retry in ${Math.round(delay / 60000)}m`)
    })
    return { decision: this.getDecision(triggerId), escalated: false }
  }

  listDecisions({ state = undefined, limit = 20 } = {}) {
    const sql = state
      ? 'SELECT * FROM semantic_decision WHERE state = ? ORDER BY created_at DESC LIMIT ?'
      : 'SELECT * FROM semantic_decision ORDER BY created_at DESC LIMIT ?'
    const rows = state ? this.db.prepare(sql).all(state, limit) : this.db.prepare(sql).all(limit)
    return rows.map(hydrateDecision)
  }

  // ------------------------------------------------------------------------ log

  log(kind, ticketId = null, detail = undefined) {
    try {
      this.db.prepare('INSERT INTO route_log (at, kind, ticket_id, detail) VALUES (?, ?, ?, ?)')
        .run(Date.now(), kind, ticketId, detail ?? null)
    } catch { /* the log must never break a mutation */ }
  }

  recentLog(limit = 40) {
    return this.db.prepare('SELECT at, kind, ticket_id, detail FROM route_log ORDER BY id DESC LIMIT ?').all(limit)
  }

  /** Watchdog infrastructure probe: database, WAL and the ticket table must answer. */
  probe() {
    try {
      const check = this.db.prepare('PRAGMA quick_check').get()
      const ok = Object.values(check ?? {})[0] === 'ok'
      const count = this.db.prepare('SELECT COUNT(*) AS n FROM ticket').get()?.n ?? 0
      return { ok, integrity: ok ? 'ok' : String(Object.values(check ?? {})[0]), tickets: count, dbPath: this.dbPath }
    } catch (error) {
      return { ok: false, integrity: String(error?.message ?? error), tickets: 0, dbPath: this.dbPath }
    }
  }
}

/** The built-in semantic policy, used until an operator saves a revision. */
export const DEFAULT_SEMANTIC_POLICY = [
  '判断一条外部消息是否在向本系统提出工作请求。',
  '',
  '接受（accept）：消息具体要求做、改、修、解释或产出某件事，且提出者明显在对本系统说话。',
  '忽略（ignore）：社交寒暄、致谢、别人已完成工作的状态汇报，或明确对着其他人说的内容。',
  '需补充上下文（need_context）：可能是请求，但只看当前上下文无法判断。',
  '',
  '不要考虑谁有权提出请求：准入在你看这条消息之前就已经决定。',
  '你只能收窄已准入的范围，永远不能扩大。',
].join('\n')

/** One semantic decision row. */
function hydrateDecision(row) {
  return {
    id: row.id,
    triggerId: row.trigger_id,
    source: row.source,
    threadKey: row.thread_key,
    state: row.state,
    verdict: row.verdict ?? undefined,
    reason: row.reason ?? undefined,
    policyRevision: row.policy_rev ?? undefined,
    gateStrength: row.gate_strength,
    deferrals: row.deferrals ?? 0,
    nextAt: row.next_at ?? undefined,
    context: parseJSON(row.context, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Map a database row to the Ticket shape the rest of the plugin uses. */
function hydrate(row) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    threadKey: row.thread_key,
    sessionId: row.session_id ?? undefined,
    routerSession: row.router_session ?? undefined,
    intent: row.intent,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at ?? undefined,
    endedAt: row.ended_at ?? undefined,
    rounds: row.rounds,
    lastReport: row.last_report ?? undefined,
    lastReportState: row.last_report_state ?? undefined,
    failure: row.failure ?? undefined,
    origin: row.origin ?? 'router',
    sourceOrigin: row.source_origin ?? undefined,
    blockedRetries: row.blocked_retries ?? 0,
    nudgedAt: row.nudged_at ?? undefined,
    leads: row.leads ? parseJSON(row.leads, []) : [],
    reopenedFrom: row.reopened_from ?? undefined,
    digest: digest(`${row.status}|${row.last_report ?? ''}|${row.rounds}`),
  }
}

/** A Source instance row, with its parsed configuration and health. */
function hydrateSource(row) {
  return {
    id: row.id,
    kind: row.kind,
    enabled: row.enabled === 1,
    config: parseJSON(row.config, {}),
    botId: row.bot_id ?? undefined,
    tokenFingerprint: row.token_fingerprint ?? undefined,
    cursor: row.cursor ?? undefined,
    health: row.health ? parseJSON(row.health, undefined) : undefined,
    healthAt: row.health_at ?? undefined,
    updatedAt: row.updated_at,
  }
}

/** One immutable Trigger, as the engine and the tools read it. */
function hydrateTrigger(row) {
  return {
    id: row.id,
    source: row.source,
    threadKey: row.thread_key,
    actor: row.actor ?? undefined,
    human: row.human === 1,
    addressed: row.addressed ?? undefined,
    text: row.text ?? '',
    meta: parseJSON(row.meta, {}),
    channel: row.channel ? parseJSON(row.channel, undefined) : undefined,
    url: row.url ?? undefined,
    disposition: row.disposition,
    reason: row.reason ?? undefined,
    at: row.at,
    createdAt: row.created_at,
  }
}

/** One outbound Channel message. */
function hydrateChannel(row) {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    channel: row.channel,
    thread: row.thread,
    address: parseJSON(row.address, {}),
    text: row.text,
    state: row.state,
    attempts: row.attempts,
    nextAt: row.next_at,
    reason: row.reason ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Parse a JSON column, falling back instead of throwing on a damaged row. */
function parseJSON(text, fallback) {
  try {
    const value = JSON.parse(text)
    return value ?? fallback
  } catch {
    return fallback
  }
}
