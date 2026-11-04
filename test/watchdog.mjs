/**
 * Watchdog contract: liveness is not progress.
 *
 * A worker whose Session answers but whose ticket state never changes must be failed,
 * and a worker that keeps advancing must be left alone. Both are asserted against the
 * real Supervisor with a fake Host, so the rule is pinned without spending 5 minutes
 * of wall clock per probe.
 *
 * Run: node test/watchdog.mjs
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
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
  const prompts = []
  return {
    prompts,
    logger: { warn() {}, info() {}, debug() {} },
    agents: { get: id => sessions.get(id), withoutInitiator: operation => operation() },
    sessionController: {
      async resolveAgent(id) {
        return sessions.has(id)
          ? { agent: sessions.get(id) }
          : { error: Object.assign(new Error('not found'), { code: 'session/not-found' }) }
      },
      async create(request) {
        const agent = { id: request.sessionId, status: 'running' }
        sessions.set(request.sessionId, agent)
        return { sessionId: request.sessionId }
      },
      async rename() { return { title: '', seq: 0 } },
      async prompt(request) { prompts.push(request); return { accepted: true } },
    },
    setStatus(id, status) {
      const agent = sessions.get(id)
      if (agent) agent.status = status
    },
  }
}

const dir = await mkdtemp(join(tmpdir(), 'concierge-watchdog-'))
const state = new State({ dbPath: join(dir, 'watchdog.sqlite'), inlineChars: 2000 })
const ctx = fakeContext()
const baseConfig = {
  stateDir: dir,
  concurrency: 3,
  watchdogIntervalMs: 60_000,
  inlineChars: 2000,
  idleFailMs: 20 * 60 * 1000,
  loopRepeatLimit: 3,
  routerSessionId: 'router-session',
}

try {
  // --- case 1: a busy worker is never failed, however long it takes -------------
  const supervisor = new Supervisor({ ctx, state, config: baseConfig, logger: ctx.logger })
  const stuck = state.createTicket({ title: 'stuck', intent: 'do work on stuck.txt', routerSession: 'router-session' })
  supervisor.pump()
  await supervisor.settle()
  const stuckSession = state.getTicket(stuck.id).sessionId
  check('worker session started', typeof stuckSession === 'string' && stuckSession.length > 0, String(stuckSession))
  // The Session keeps reporting "running" while the ticket row does not move: this is a
  // worker in the middle of a long edit, not a stuck one.
  ctx.setStatus(stuckSession, 'running')
  let rounds = 0
  for (let index = 0; index < 6; index++) {
    const round = await supervisor.inspect()
    rounds = round.findings.length
  }
  check('a busy worker is never failed', state.getTicket(stuck.id)?.status === 'running', state.getTicket(stuck.id)?.status)
  check('the probe still records it as healthy', supervisor.probeHistory.at(-1)?.findings.every(row => row.verdict === 'healthy') === true)

  // --- case 1b: an idle worker is nudged first, then failed after the grace ---------
  ctx.setStatus(stuckSession, 'idle')
  let nudgedRound
  for (let index = 0; index < 6; index++) {
    const round = await supervisor.inspect()
    rounds = round.findings.length
    const finding = round.findings.find(row => row.ticket_id === stuck.id)
    if (finding?.verdict === 'nudged') { nudgedRound = round.at; break }
  }
  check('the watchdog asks for a report before failing anything', nudgedRound !== undefined, 'expected a nudged verdict')
  check('nothing is failed while the nudge is pending', state.getTicket(stuck.id)?.status === 'running', state.getTicket(stuck.id)?.status)
  check('the nudge is recorded on the ticket', typeof state.nudgedAt(stuck.id) === 'number', String(state.nudgedAt(stuck.id)))
  check('the nudge was delivered to the worker session', ctx.prompts.some(row => String(row.content?.[0]?.text ?? '').includes('superagent_report')))

  // Inside the grace window the ticket is left alone, however many probes run.
  for (let index = 0; index < 3; index++) await supervisor.inspect()
  check('the grace period holds across probes', state.getTicket(stuck.id)?.status === 'running', state.getTicket(stuck.id)?.status)

  // Age the nudge past one inspection period: now the failure is allowed.
  state.db.prepare('UPDATE ticket SET nudged_at = ? WHERE id = ?')
    .run(Date.now() - baseConfig.watchdogIntervalMs - 1000, stuck.id)
  void 0
  for (let index = 0; index < 4; index++) {
    const round = await supervisor.inspect()
    rounds = round.findings.length
    if (state.getTicket(stuck.id)?.status === 'failed') break
  }
  check('an idle stalled worker is failed after the grace', state.getTicket(stuck.id)?.status === 'failed', state.getTicket(stuck.id)?.status)
  check('the failure names the watchdog', String(state.getTicket(stuck.id)?.failure ?? '').includes('watchdog'), state.getTicket(stuck.id)?.failure)
  check('the failure says the probes were idle', String(state.getTicket(stuck.id)?.failure ?? '').includes('idle probes'), state.getTicket(stuck.id)?.failure)
  check('the failure records that a report was requested',
    String(state.getTicket(stuck.id)?.failure ?? '').includes('superagent_report was requested'), state.getTicket(stuck.id)?.failure)
  check('the probe ran for every open worker', rounds >= 1, String(rounds))
  check('infrastructure was probed', (supervisor.probeHistory.at(-1)?.health?.ok ?? false) === true)
  await supervisor.dispose()

  // --- case 1c: a worker writing files is progressing, not stuck ----------------
  // The production failure: the worker finished the artifact but never reported. Files
  // changing in its directory must hold off the failure, even with no report at all.
  const writing = state.createTicket({ title: 'writing files', intent: 'build the site', routerSession: 'router-session' })
  const writingSupervisor = new Supervisor({ ctx, state, config: baseConfig, logger: ctx.logger })
  writingSupervisor.pump()
  await writingSupervisor.settle()
  const writingSession = state.getTicket(writing.id).sessionId
  ctx.setStatus(writingSession, 'idle')
  const workerDir = join(dir, 'agent', writing.id)
  await mkdir(workerDir, { recursive: true })

  // First probe establishes a baseline with no files.
  await writingSupervisor.inspect()
  let sawFiles = false
  for (let index = 0; index < 5; index++) {
    // Each round writes a file, so the signature keeps moving.
    await writeFile(join(workerDir, `artifact-${index}.html`), `<!doctype html><title>${index}</title>`)
    const round = await writingSupervisor.inspect()
    const finding = round.findings.find(row => row.ticket_id === writing.id)
    if (String(finding?.detail ?? '').includes('files changed')) sawFiles = true
    if (state.getTicket(writing.id)?.status === 'failed') break
  }
  check('changing files counts as progress', sawFiles, 'expected a files-changed verdict')
  check('a worker writing files is not failed', state.getTicket(writing.id)?.status === 'running', state.getTicket(writing.id)?.status)
  check('the evidence is logged', state.recentLog(50).some(row => row.kind === 'watchdog/artifact-progress'))
  await writingSupervisor.dispose()

  // The report contract is still the authority: files alone never close a ticket.
  check('files alone do not finish a ticket', state.getTicket(writing.id)?.status !== 'done')

  // --- case 2: a worker that keeps reporting progress is left alone -------------
  const healthy = new Supervisor({ ctx, state, config: baseConfig, logger: ctx.logger })
  const busy = state.createTicket({ title: 'busy', intent: 'do work on busy.txt', routerSession: 'router-session' })
  healthy.pump()
  await healthy.settle()
  const busySession = state.getTicket(busy.id).sessionId
  ctx.setStatus(busySession, 'running')
  let survived = true
  for (let index = 0; index < 5; index++) {
    // Each probe sees a new report, which is exactly what real progress looks like.
    state.report(busy.id, { summary: `step ${index}`, state: 'progress' })
    await healthy.inspect()
    if (state.getTicket(busy.id)?.status === 'failed') { survived = false; break }
  }
  check('a progressing worker is not failed', survived, state.getTicket(busy.id)?.failure)
  check('the progressing ticket is still open', state.getTicket(busy.id)?.status === 'running', state.getTicket(busy.id)?.status)
  await healthy.dispose()

  // --- case 3: the probe reports problems to the router ------------------------
  const routed = []
  const reporting = new Supervisor({ ctx, state, config: baseConfig, logger: ctx.logger })
  reporting.deliverToRouter = async (text, requestId, ticketId) => { routed.push({ text, ticketId }) }
  ctx.sessionController.create({ sessionId: 'router-session', cwd: dir })
  const quiet = state.createTicket({ title: 'quiet', intent: 'work on quiet.txt', routerSession: 'router-session' })
  reporting.pump()
  await reporting.settle()
  const quietSession = state.getTicket(quiet.id).sessionId
  ctx.setStatus(quietSession, 'running')
  for (let index = 0; index < 6; index++) {
    await reporting.inspect()
    if (state.getTicket(quiet.id)?.status === 'failed') break
  }
  check('the watchdog told the router', routed.some(item => item.text.includes('watchdog')), String(routed.length))
  await reporting.dispose()
} finally {
  state.close()
  await rm(dir, { recursive: true, force: true })
}

const failed = results.filter(result => !result.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exitCode = 1
