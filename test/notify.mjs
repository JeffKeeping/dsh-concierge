/**
 * Notification discipline: one terminal answer per ticket, one progress notice per burst.
 *
 * A worker can call superagent_report several times inside one turn. The operator must
 * still see exactly one answer per ticket close, and at most one progress checkpoint per
 * burst — otherwise a single noisy worker floods the chat.
 *
 * Run: node test/notify.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { State } from '../lib/state.js'
import { Supervisor } from '../lib/supervisor.js'

const results = []
function check(name, condition, detail = undefined) {
  results.push({ name, pass: Boolean(condition), detail })
  if (!condition) console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  else console.log(`ok    ${name}`)
}

function fakeContext() {
  const sessions = new Map()
  return {
    logger: { warn() {}, info() {}, debug() {} },
    agents: { get: id => sessions.get(id), withoutInitiator: operation => operation() },
    sessionController: {
      async resolveAgent(id) {
        return sessions.has(id)
          ? { agent: sessions.get(id) }
          : { error: Object.assign(new Error('not found'), { code: 'session/not-found' }) }
      },
      async create(request) {
        sessions.set(request.sessionId, { id: request.sessionId, status: 'running' })
        return { sessionId: request.sessionId }
      },
      async rename() { return { title: '', seq: 0 } },
      async prompt() { return { accepted: true } },
    },
  }
}

const dir = await mkdtemp(join(tmpdir(), 'concierge-notify-'))
const state = new State({ dbPath: join(dir, 'notify.sqlite'), inlineChars: 2000 })
const ctx = fakeContext()
const config = {
  stateDir: dir,
  concurrency: 3,
  watchdogIntervalMs: 60_000,
  inlineChars: 2000,
  idleFailMs: 20 * 60 * 1000,
  loopRepeatLimit: 3,
  routerSessionId: 'router-session',
}

const delivered = []
const supervisor = new Supervisor({ ctx, state, config, logger: ctx.logger })
// Capture what would reach the operator instead of sending it.
supervisor.deliverToRouter = async (text, requestId, ticketId) => {
  delivered.push({ text: JSON.parse(text), requestId, ticketId })
}

try {
  const ticket = state.createTicket({ title: 'notify', intent: 'write notify.txt', routerSession: 'router-session' })

  // Three progress checkpoints in one burst.
  await supervisor.report(ticket.id, { summary: 'step one', state: 'progress' })
  await supervisor.report(ticket.id, { summary: 'step two', state: 'progress' })
  await supervisor.report(ticket.id, { summary: 'step three', state: 'progress' })
  await supervisor.flushProgress()
  const progressNotices = delivered.filter(item => item.text.state === 'progress')
  check('a burst of progress reports becomes one notice', progressNotices.length === 1, String(progressNotices.length))
  check('the coalesced notice carries the latest summary', progressNotices[0]?.text.summary === 'step three', progressNotices[0]?.text.summary)

  // The terminal answer, then a duplicate from the same turn.
  delivered.length = 0
  const first = await supervisor.report(ticket.id, { summary: 'done properly', state: 'done' })
  check('the terminal report closes the ticket', first.ticket?.status === 'done', first.ticket?.status)
  check('the terminal report is relayed once', delivered.length === 1, String(delivered.length))
  check('the relay says what happened', delivered[0]?.text.summary === 'done properly', delivered[0]?.text.summary)

  // A worker that keeps reporting after the close is rejected and stays silent.
  delivered.length = 0
  const again = await supervisor.report(ticket.id, { summary: 'done again', state: 'done' })
  check('a closed ticket rejects further reports', again.ok === false && again.reason === 'closed-ticket', JSON.stringify(again))
  check('a rejected report notifies nobody', delivered.length === 0, String(delivered.length))
  check('a rejected report does not rewrite the record', state.getTicket(ticket.id)?.lastReport?.includes('done properly'), state.getTicket(ticket.id)?.lastReport)

  // A separate ticket still gets its own answer: suppression is per ticket, not global.
  delivered.length = 0
  const other = state.createTicket({ title: 'other', intent: 'write other.txt', routerSession: 'router-session' })
  await supervisor.report(other.id, { summary: 'other done', state: 'done' })
  check('a different ticket is still announced', delivered.length === 1 && delivered[0].ticketId === other.id, JSON.stringify(delivered.map(item => item.ticketId)))

  // Repeated launch failures on one ticket notify once.
  delivered.length = 0
  const failing = state.createTicket({ title: 'failing', intent: 'never starts', routerSession: 'router-session' })
  await supervisor.fail(failing.id, new Error('boom'))
  await supervisor.fail(failing.id, new Error('boom again'))
  check('repeated failures notify once', delivered.length === 1, String(delivered.length))
} finally {
  await supervisor.dispose()
  state.close()
  await rm(dir, { recursive: true, force: true })
}

const failed = results.filter(result => !result.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exitCode = 1
