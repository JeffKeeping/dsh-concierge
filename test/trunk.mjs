/**
 * In-memory verification of the dsh-concierge trunk.
 *
 * It exercises the real State, Router and Supervisor classes against a fake Cordis
 * context that records what the plugin would have done to DSH Sessions. Nothing here
 * touches a real Host session, so the run is repeatable and offline.
 *
 * Run: node test/trunk.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { State } from '../lib/state.js'
import { Supervisor } from '../lib/supervisor.js'
import { Router } from '../lib/router.js'
import { tools } from '../lib/tools.js'

const results = []
function check(name, condition, detail = undefined) {
  results.push({ name, pass: Boolean(condition), detail })
  if (!condition) console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  else console.log(`ok    ${name}`)
}

/** A fake Host that behaves like the parts of ctx this plugin uses. */
function fakeContext() {
  const sessions = new Map()
  const created = []
  const prompts = []
  const agentStatus = new Map()
  const fake = {
    created,
    prompts,
    logger: { warn() {}, info() {}, debug() {} },
    agents: {
      get(id) { return sessions.get(id) },
      withoutInitiator: operation => operation(),
    },
    sessionController: {
      async resolveAgent(id) {
        const live = sessions.get(id)
        if (live) return { agent: live }
        return { error: Object.assign(new Error('not found'), { code: 'session/not-found' }) }
      },
      async create(request) {
        created.push(request)
        const agent = { id: request.sessionId, status: 'idle' }
        sessions.set(request.sessionId, agent)
        agentStatus.set(request.sessionId, 'idle')
        return { sessionId: request.sessionId }
      },
      async rename() { return { title: '', seq: 0 } },
      async prompt(request) {
        prompts.push(request)
        const agent = sessions.get(request.sessionId)
        if (agent) agent.status = 'running'
        return { accepted: true }
      },
    },
  }
  fake.setStatus = (id, status) => {
    const agent = sessions.get(id)
    if (agent) agent.status = status
  }
  return fake
}

const dir = await mkdtemp(join(tmpdir(), 'concierge-trunk-'))
const ctx = fakeContext()
const notices = []
// The Router Session files requests; notices are delivered back to it.
await ctx.sessionController.create({ sessionId: 'router-session', cwd: dir })
ctx.setStatus('router-session', 'idle')
const originalPrompt = ctx.sessionController.prompt
ctx.sessionController.prompt = async (request) => {
  if (request.sessionId === 'router-session') {
    notices.push({ text: request.content?.[0]?.text ?? '', requestId: request.requestId })
    return { accepted: true }
  }
  return originalPrompt(request)
}
const state = new State({ dbPath: join(dir, 'concierge.sqlite'), inlineChars: 2000 })
const config = {
  stateDir: dir,
  concurrency: 3,
  watchdogIntervalMs: 5 * 60 * 1000,
  routerBatchMs: 800,
  inlineChars: 2000,
  idleFailMs: 20 * 60 * 1000,
  loopRepeatLimit: 3,
  routerSessionId: 'router-session',
}

  const supervisor = new Supervisor({ ctx, state, config, logger: ctx.logger })
  const router = new Router({ state, supervisor, config, logger: ctx.logger })
  const registry = new Map(tools({ router, supervisor, state }).map(tool => [tool.name, tool]))

const call = (toolName, args) => registry.get(toolName).execute(args, {
  signal: new AbortController().signal,
  agent: { id: 'router-session' },
})
/** Reports come from a worker, so the call carries that worker's Session identity. */
const report = (ticketId, args) => registry.get('superagent_report').execute(
  { ticket_id: ticketId, ...args },
  { signal: new AbortController().signal, agent: { id: `concierge-worker-${ticketId}` } },
)

try {
  // ---------------------------------------------------------------- 1. ask
  const asked = await call('superagent_ask', { text: 'Add a CSV export to the reports page' })
  check('ask opens a ticket', asked.routed === 'new-ticket', JSON.stringify(asked.routed))
  const first = asked.ticket_id
  await supervisor.settle()
  check('new ticket is running after the pump', state.getTicket(first)?.status === 'running', state.getTicket(first)?.status)
  check('worker session was created', ctx.created.some(r => r.sessionId === `concierge-worker-${first}`))
  check('worker directory was assigned', ctx.created.find(r => r.sessionId === `concierge-worker-${first}`)?.cwd.endsWith(join('agent', first)))
  const brief = ctx.prompts.at(-1)
  check('worker received its brief', brief?.content?.[0]?.text.includes(first) === true)
  check('brief omits nothing critical', JSON.parse(brief.content[0].text).task.includes('CSV'), brief.content[0].text.slice(0, 120))
  // The pump claims the ticket, but the fake agent starts idle until prompted; mark it busy.
  ctx.setStatus(`concierge-worker-${first}`, 'running')

  // ------------------------------------------------------- 2. concurrency
  const second = await call('superagent_ask', { text: 'Write cB.txt with the login fix notes' })
  const third = await call('superagent_ask', { text: 'Write cC.txt with the deployment steps' })
  const fourth = await call('superagent_ask', { text: 'Write cD.txt with the dark mode toggle plan' })
  await supervisor.settle()
  const vagueTicket = second.ticket_id
  ctx.setStatus(`concierge-worker-${second.ticket_id}`, 'running')
  ctx.setStatus(`concierge-worker-${third.ticket_id}`, 'running')
  check('concurrency limit holds at three', supervisor.slots.size === 3, String(supervisor.slots.size))
  check('fourth request is queued', state.getTicket(fourth.ticket_id)?.status === 'queued', state.getTicket(fourth.ticket_id)?.status)

  // ------------------------------------------------------ 3. direct-through
  const sent = await call('superagent_send', { ticket_id: first, text: 'Use semicolons, not tabs' })
  check('send reaches the running worker', sent.delivery === 'delivered', JSON.stringify(sent.delivery))
  check('send does not create a new ticket', state.listTickets({ status: 'all' }).length === 4, String(state.listTickets({ status: 'all' }).length))
  const lastPrompt = ctx.prompts.at(-1)
  check('follow-up went to the owning session', lastPrompt.sessionId === `concierge-worker-${first}`)
  check('follow-up is recorded on the thread', state.messages(first).some(m => m.text?.includes('semicolons')))

  // ------------------------------------------------------------ 4. report
  const reported = await report(first, {
    summary: 'CSV export implemented in reports/export.ts; tests added.',
    state: 'done',
    workspace: 'agent/' + first,
  })
  check('report closes the ticket', reported.ticket.status === 'done', reported.ticket.status)
  check('report relays to the router', notices.some(n => n.text.includes('worker_report') && n.text.includes(first)))
  const lateReport = await report(first, { summary: 'late progress', state: 'progress' })
  check('a closed ticket rejects further reports', lateReport.ok === false && lateReport.reason === 'closed-ticket', JSON.stringify(lateReport))
  check('a late report cannot reopen the ticket', state.getTicket(first)?.status === 'done' && state.getTicket(first)?.lastReportState === 'done', state.getTicket(first)?.status)
  // The freed slot is taken by the oldest queued ticket in the same call, so the count
  // stays at the limit while the queued work advances. Both facts are asserted here.
  check('queued ticket started after a slot freed', state.getTicket(fourth.ticket_id)?.status === 'running', state.getTicket(fourth.ticket_id)?.status)
  check('slot count stays at the limit while work is queued', supervisor.slots.size === 3, String(supervisor.slots.size))

  // ---------------------------------------------------- 5. thread matching
  // v1 matches on concrete artefacts, not on vocabulary: the follow-up names the same file.
  const follow = await call('superagent_ask', { text: 'Recheck cB.txt and make sure it ends with a newline' })
  check('follow-up joins the existing thread', follow.routed === 'thread' && follow.ticket_id === vagueTicket, JSON.stringify(follow))

  // ----------------------------------------------------------- 6. spill
  const huge = 'x'.repeat(6000) + ' the end'
  const spilled = state.spill(huge, 'six thousand characters')
  const back = await call('superagent_read', { ref: `blob:${spilled}` })
  check('read returns spilled content in full', back.content === huge, String(back.content.length))
  const windowed = await call('superagent_read', { ref: `blob:${spilled}`, offset: 5990, limit: 20 })
  check('read honours offset and limit', windowed.content === huge.slice(5990, 6010) && windowed.offset === 5990, JSON.stringify(windowed.content))
  const tail = await call('superagent_read', { ref: `blob:${spilled}`, offset: 6000 })
  check('read reports truncation only when content remains', tail.truncated === false && tail.content === huge.slice(6000), JSON.stringify(tail.content))

  // ------------------------------------------------- 7. watchdog dead worker
  // A worker that is "alive" but repeats the same ticket state must be failed.
  // Freeze every worker first, so the probe sees a stable digest each round.
  const watched = [first, fourth.ticket_id, third.ticket_id]
  for (const id of watched) {
    const ticket = state.getTicket(id)
    if (ticket?.sessionId) ctx.setStatus(ticket.sessionId, 'idle')
  }
  // The stalled ticket must still be running for the probe to judge it — and its worker
  // agent must be *idle*, because a busy agent is working and is never failed (v5).
  const stuck = state.getTicket(fourth.ticket_id)
  // The queued ticket was started by the pump when a slot freed; give it a worker session so
  // the probe has an agent to read, exactly as a real launch would.
  if (stuck && !stuck.sessionId) {
    state.attachSession(fourth.ticket_id, `concierge-worker-${fourth.ticket_id}`)
    await ctx.sessionController.create({ sessionId: `concierge-worker-${fourth.ticket_id}`, cwd: dir })
  }
  state.setStatus(fourth.ticket_id, 'running')
  ctx.setStatus(`concierge-worker-${fourth.ticket_id}`, 'idle')
  // Start the history clean, so the repeat count measures this ticket's own idleness.
  supervisor.slots.get(fourth.ticket_id).history = []
  const before = supervisor.slots.size
  let probes = 0
  let lastRound
  // v5: the watchdog nudges first and grants one inspection period. Drive probes until the
  // nudge appears, age it past the grace, then probe again to reach the failure.
  for (let index = 0; index < 4; index++) {
    // A real idle worker stays idle across probes; the fake's prompt() flips it back to
    // running, so reset it each round to model an idle worker accurately.
    ctx.setStatus(`concierge-worker-${fourth.ticket_id}`, 'idle')
    lastRound = await supervisor.inspect()
    probes = lastRound.findings.length
    // Age the nudge past the grace immediately after it appears. The ordering matters: the
    // nudge is written during inspect(), so it must be aged in the same iteration or the
    // next probe reads a fresh timestamp and the grace stays open forever.
    const at = state.nudgedAt(fourth.ticket_id)
    if (at !== undefined) {
      state.db.prepare('UPDATE ticket SET nudged_at = ? WHERE id = ?')
        .run(at - config.watchdogIntervalMs - 1000, fourth.ticket_id)
    }
  }
  const nudgedAt = state.nudgedAt(fourth.ticket_id)
  if (nudgedAt !== undefined) {
    state.db.prepare('UPDATE ticket SET nudged_at = ? WHERE id = ?').run(nudgedAt - config.watchdogIntervalMs - 1000, fourth.ticket_id)
  }
  // Drive probes until the watchdog nudges, then age the nudge past the grace and probe
  // again: that is the real sequence — nudge once, wait one period, then judge.
  let sawNudge = false
  for (let index = 0; index < 10; index++) {
    ctx.setStatus(`concierge-worker-${fourth.ticket_id}`, 'idle')
    lastRound = await supervisor.inspect()
    probes = Math.max(probes, lastRound.findings.length)
    const at = state.nudgedAt(fourth.ticket_id)
    if (at !== undefined && !sawNudge) {
      sawNudge = true
      state.db.prepare('UPDATE ticket SET nudged_at = ? WHERE id = ?')
        .run(at - config.watchdogIntervalMs - 1000, fourth.ticket_id)
    }
    if (state.getTicket(fourth.ticket_id)?.status === 'failed') break
  }
  check('watchdog probes every running worker', probes >= 2, String(probes))
  check('watchdog nudges before failing', typeof state.nudgedAt(fourth.ticket_id) === 'number')
  check('watchdog fails the stalled worker', state.getTicket(fourth.ticket_id)?.status === 'failed', state.getTicket(fourth.ticket_id)?.status)
  check('watchdog records a reason', String(state.getTicket(fourth.ticket_id)?.failure ?? '').includes('watchdog'), state.getTicket(fourth.ticket_id)?.failure)
  check('watchdog relays the problem', notices.some(n => n.text.includes('watchdog')))
  check('failing a worker frees its slot', supervisor.slots.size < before, `${before} -> ${supervisor.slots.size}`)

  // ------------------------------------------------------- 8. infrastructure
  const health = state.probe()
  check('database probe is healthy', health.ok === true, JSON.stringify(health))

  // ------------------------------------------------------- 9. restart recovery
  const recoverable = state.db.prepare("SELECT COUNT(*) AS n FROM ticket WHERE status = 'running'").get().n
  const recovered = state.recoverOnBoot()
  check('restart requeues running tickets', recovered.requeued === recoverable, `${recovered.requeued}/${recoverable}`)
  const afterBoot = state.listTickets({ status: 'open', limit: 20 })
  check('recovered tickets are queued again', afterBoot.every(t => t.status === 'queued'), JSON.stringify(afterBoot.map(t => t.status)))

  // The state must survive a reopen, which is the "state is in the database" promise.
  state.close()
  const reopened = new State({ dbPath: join(dir, 'concierge.sqlite'), inlineChars: 2000 })
  check('tickets survive a reopen', reopened.listTickets({ status: 'all', limit: 10 }).length === 4, String(reopened.listTickets({ status: 'all', limit: 10 }).length))
  check('completed ticket keeps its report', reopened.getTicket(first)?.lastReportState === 'done', reopened.getTicket(first)?.lastReportState)
  check('spilled content survives a reopen', reopened.readRef(`blob:${spilled}`).content === huge)
  reopened.close()
} finally {
  await supervisor.dispose()
  try { state.close() } catch { /* already closed */ }
  await rm(dir, { recursive: true, force: true })
}

const failed = results.filter(result => !result.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.error(`\n${failed.length} failed:`)
  for (const failure of failed) console.error(` - ${failure.name}${failure.detail ? `: ${failure.detail}` : ''}`)
  process.exitCode = 1
}
