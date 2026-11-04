/**
 * Upgrade safety: an old database must open without losing a row.
 *
 * The migration is additive only — new tables, new columns with defaults. This test builds
 * a v2-shaped database by hand (the schema v2 shipped), fills it, then opens it with the
 * current `State` and checks every row survived and the new columns took their defaults.
 *
 * Run: node test/migration.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { State } from '../lib/state.js'

const results = []
function check(name, condition, detail = undefined) {
  results.push({ name, pass: Boolean(condition), detail })
  if (!condition) console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  else console.log(`ok    ${name}`)
}

/** The exact schema v2 shipped: no v3 tables, no v3 columns. */
const V2_SCHEMA = `
CREATE TABLE ticket (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, thread_key TEXT NOT NULL,
  session_id TEXT, router_session TEXT, intent TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,
  rounds INTEGER NOT NULL DEFAULT 0, last_report TEXT, last_report_state TEXT, failure TEXT
);
CREATE TABLE message (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT, blob_id TEXT, request_id TEXT, created_at INTEGER NOT NULL);
CREATE TABLE blob (id TEXT PRIMARY KEY, content TEXT NOT NULL, summary TEXT NOT NULL, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE route_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, ticket_id TEXT, detail TEXT);
CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE source (id TEXT PRIMARY KEY, kind TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  config TEXT NOT NULL, bot_id TEXT, cursor TEXT, health TEXT, health_at INTEGER, updated_at INTEGER NOT NULL);
CREATE TABLE trigger_event (id TEXT PRIMARY KEY, source TEXT NOT NULL, thread_key TEXT NOT NULL,
  actor TEXT, human INTEGER NOT NULL DEFAULT 1, addressed TEXT, text TEXT, meta TEXT, channel TEXT, url TEXT,
  disposition TEXT NOT NULL, reason TEXT, at INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE subscription (ticket_id TEXT NOT NULL, thread_key TEXT NOT NULL, origin TEXT NOT NULL DEFAULT 'source',
  created_at INTEGER NOT NULL, PRIMARY KEY (ticket_id, thread_key));
CREATE TABLE channel_message (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, channel TEXT NOT NULL, thread TEXT NOT NULL,
  address TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL, reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
`

const dir = await mkdtemp(join(tmpdir(), 'concierge-migration-'))
const dbPath = join(dir, 'old.sqlite')

try {
  // ---------------------------------------------------------------- build a v2 db
  const old = new DatabaseSync(dbPath)
  old.exec('PRAGMA journal_mode = WAL')
  old.exec(V2_SCHEMA)
  const now = Date.now()
  old.prepare(`INSERT INTO ticket (id,title,status,thread_key,intent,created_at,updated_at,rounds)
               VALUES (?,?,?,?,?,?,?,?)`).run('t-old1', 'existing ticket', 'done', 'thread-t-old1', 'the original ask', now - 5000, now - 4000, 1)
  old.prepare(`INSERT INTO ticket (id,title,status,thread_key,intent,created_at,updated_at,rounds)
               VALUES (?,?,?,?,?,?,?,?)`).run('t-old2', 'open ticket', 'running', 'thread-t-old2', 'still going', now - 3000, now - 2000, 2)
  old.prepare('INSERT INTO message (id,ticket_id,role,text,created_at) VALUES (?,?,?,?,?)').run('t-old1-m0', 't-old1', 'router', 'the original ask', now - 5000)
  old.prepare('INSERT INTO message (id,ticket_id,role,text,created_at) VALUES (?,?,?,?,?)').run('t-old2-m0', 't-old2', 'router', 'still going', now - 3000)
  old.prepare('INSERT INTO blob (id,content,summary,bytes,created_at) VALUES (?,?,?,?,?)').run('blob-old1', 'a long body', 'long body', 12, now - 5000)
  old.prepare('INSERT INTO route_log (at,kind,ticket_id,detail) VALUES (?,?,?,?)').run(now - 5000, 'ticket/created', 't-old1', 'existing ticket')
  old.prepare('INSERT INTO kv (key,value) VALUES (?,?)').run('some-setting', 'kept')
  old.prepare(`INSERT INTO source (id,kind,enabled,config,bot_id,cursor,updated_at) VALUES (?,?,?,?,?,?,?)`)
    .run('wh-old', 'webhook', 1, JSON.stringify({ endpoint: '/concierge/webhook/old', replyUrl: 'http://h.test/r', conversations: { ops: 'all' }, policy: { allowed: [], bots: [] } }), 'concierge', '42', now)
  old.prepare(`INSERT INTO trigger_event (id,source,thread_key,actor,human,text,meta,disposition,at,created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?)`).run('webhook:wh-old:e1', 'wh-old', 'webhook:wh-old:ops:e1', 'alice', 1, 'old trigger', '{}', 'stored', now - 4000, now - 4000)
  old.prepare('INSERT INTO subscription (ticket_id,thread_key,origin,created_at) VALUES (?,?,?,?)').run('t-old2', 'webhook:wh-old:ops:e1', 'source', now - 2000)
  old.prepare(`INSERT INTO channel_message (id,ticket_id,channel,thread,address,text,state,attempts,next_at,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run('cm-old', 't-old1', 'wh-old', 'th', '{}', 'old reply', 'sent', 1, now, now - 1000, now - 1000)
  old.close()

  // ------------------------------------------------------------ open with state
  const state = new State({ dbPath, inlineChars: 2000 })
  const applied = state.migrated.applied
  check('the migration ran', applied.length > 0, applied.join(','))
  check('v3 tables exist', (() => {
    const names = state.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name)
    return ['ref_edge', 'semantic_decision', 'policy_version', 'thread_closure'].every(table => names.includes(table))
  })())

  // Every old row survived.
  check('old tickets survive', state.listTickets({ status: 'all', limit: 10 }).length === 2, String(state.listTickets({ status: 'all', limit: 10 }).length))
  check('an old ticket keeps its text', state.getTicket('t-old1')?.intent === 'the original ask')
  check('an old ticket keeps its status', state.getTicket('t-old1')?.status === 'done')
  check('an old open ticket keeps running', state.getTicket('t-old2')?.status === 'running')
  check('old messages survive', state.messages('t-old1').length === 1)
  check('old blobs survive', state.readRef('blob:blob-old1').content === 'a long body')
  check('old kv survives', state.getKV('some-setting') === 'kept')
  check('old sources survive', state.listSources().length === 1)
  check('an old cursor survives', state.sourceCursor('wh-old') === '42', state.sourceCursor('wh-old'))
  check('old triggers survive', state.getTrigger('webhook:wh-old:e1')?.text === 'old trigger')
  check('old subscriptions survive', state.subscribers('webhook:wh-old:ops:e1').length === 1)
  check('old channel messages survive', state.channelMessage('cm-old')?.state === 'sent')

  // New columns took their documented defaults on old rows.
  check('an old ticket defaults to router origin', state.ticketOrigin('t-old1') === 'router', state.ticketOrigin('t-old1'))
  check('an old ticket defaults to zero blocked retries', state.getTicket('t-old1')?.blockedRetries === 0, String(state.getTicket('t-old1')?.blockedRetries))
  check('an old ticket has no source origin', state.getTicket('t-old1')?.sourceOrigin === undefined)
  check('an old source has no token fingerprint', state.getSource('wh-old')?.tokenFingerprint === undefined)
  check('the default policy is served', state.currentPolicy().revision === 0)

  // The upgraded database is fully usable.
  const fresh = state.createTicket({ title: 'new after upgrade', intent: 'work' })
  check('a new ticket can be filed after upgrading', state.getTicket(fresh.id)?.status === 'queued')
  state.subscribe(fresh.id, 'webhook:wh-old:ops:e1', 'source')
  check('new subscriptions work after upgrading', state.subscribers('webhook:wh-old:ops:e1').length === 2)
  state.queueDecision({ triggerId: 'webhook:wh-old:e1', source: 'wh-old', threadKey: 'webhook:wh-old:ops:e1', strength: 'inferred', context: {} })
  check('new decisions work after upgrading', state.getDecision('webhook:wh-old:e1')?.state === 'pending')
  state.addRefEdge('report:t-old1', 'blob:blob-old1', 'cited')
  check('new ref edges work after upgrading', state.followRef('report:t-old1', 1)[0]?.refs[0]?.ref === 'blob:blob-old1')
  state.close()

  // Reopening is a no-op: the migration is idempotent.
  const reopened = new State({ dbPath, inlineChars: 2000 })
  check('reopening applies nothing', reopened.migrated.applied.length === 0, reopened.migrated.applied.join(','))
  check('reopening keeps every row', reopened.listTickets({ status: 'all', limit: 10 }).length === 3, String(reopened.listTickets({ status: 'all', limit: 10 }).length))
  check('reopening keeps the new edges', reopened.followRef('report:t-old1', 1)[0]?.refs[0]?.ref === 'blob:blob-old1')
  reopened.close()
} finally {
  await rm(dir, { recursive: true, force: true })
}

const failed = results.filter(result => !result.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exitCode = 1
