/**
 * The lost-worker procedure and the reopened handover.
 *
 * The incident: a worker finished its artifact but never reported; the Router decided it was
 * gone, verified the artifact itself, got it wrong, and wrote that wrong conclusion into a
 * reopened ticket. These tests pin every part of the fix:
 *
 *   - the procedure is a gate: no reopen until `status` and then `send` are on record;
 *   - the handover separates facts (artifact paths) from 待核实线索 (unverified claims);
 *   - the new worker's text carries the reproduce-first instruction;
 *   - the worker template asks for a first progress report and for evidence.
 *
 * Run: node test/handover.mjs
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { State } from '../lib/state.js'
import { Supervisor } from '../lib/supervisor.js'
import { Router } from '../lib/router.js'
import { tools } from '../lib/tools.js'
import {
  WORKER_RULES, VERIFY_FIRST, LEADS_LABEL, CONTRACT_LABEL,
  reopenedTaskText, isReopened,
} from '../lib/handover.js'
import { ROUTER_INSTRUCTIONS } from '../lib/preset.js'

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
    on() { return () => {} },
    sessionController: {
      async resolveAgent(id) {
        return sessions.has(id)
          ? { agent: sessions.get(id) }
          : { error: Object.assign(new Error('not found'), { code: 'session/not-found' }) }
      },
      async create(request) {
        sessions.set(request.sessionId, { id: request.sessionId, status: 'running', session: { id: request.sessionId } })
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

const dir = await mkdtemp(join(tmpdir(), 'concierge-handover-'))
const state = new State({ dbPath: join(dir, 'h.sqlite'), inlineChars: 8000 })
const ctx = fakeContext()
const config = {
  stateDir: dir, concurrency: 3, watchdogIntervalMs: 60_000, inlineChars: 8000,
  idleFailMs: 20 * 60 * 1000, loopRepeatLimit: 3, blockedRetries: 3,
  routerSessionId: 'router-session', channelTickMs: 1000,
}
const supervisor = new Supervisor({ ctx, state, config, logger: ctx.logger })
const router = new Router({ state, supervisor, config, logger: ctx.logger })
const registry = new Map(tools({ router, supervisor, state }).map(tool => [tool.name, tool]))
const call = (name, args) => registry.get(name).execute(args, {
  signal: new AbortController().signal,
  agent: { id: 'router-session' },
})

try {
  // ------------------------------------------------ the Router's own constraints
  check('the preset forbids touching the worker workspace', ROUTER_INSTRUCTIONS.includes('读取或写入 Worker 的工作目录'))
  check('the preset forbids running verification tools', ROUTER_INSTRUCTIONS.includes('运行任何验证工作产物的工具'))
  check('the preset states the prohibition has no exception', ROUTER_INSTRUCTIONS.includes('无例外'))
  check('the preset spells out the three-step procedure', ROUTER_INSTRUCTIONS.includes('a)') && ROUTER_INSTRUCTIONS.includes('b)') && ROUTER_INSTRUCTIONS.includes('c)'))
  check('the preset names superagent_status as step a', ROUTER_INSTRUCTIONS.includes('superagent_status'))
  check('the preset forbids skipping steps', ROUTER_INSTRUCTIONS.includes('不得跳过'))
  check('the preset labels router findings as unverified', ROUTER_INSTRUCTIONS.includes(LEADS_LABEL))
  check('the preset warns its conclusions may be wrong', ROUTER_INSTRUCTIONS.includes('可能错误'))

  // -------------------------------------------------------- the worker template
  check('the worker rules name the only exit', WORKER_RULES.some(rule => rule.includes('唯一的退出通道')))
  check('the worker rules ask for a first progress report', WORKER_RULES.some(rule => rule.includes('立刻') && rule.includes('progress')))
  check('the worker rules require evidence', WORKER_RULES.some(rule => rule.includes('证据')))
  check('the worker rules say artifacts alone are not done', WORKER_RULES.some(rule => rule.includes('不算完成')))

  // ---------------------------------------------- the procedure is a gate
  const stalled = state.createTicket({ title: '很慢的网站', intent: 'build a pelican site', routerSession: 'router-session' })
  supervisor.pump()
  await supervisor.settle()

  const withoutNudge = await call('superagent_reopen', { ticket_id: stalled.id })
  check('a reopen without a nudge is refused', withoutNudge.ok === false && withoutNudge.reason === 'procedure-incomplete', JSON.stringify(withoutNudge))
  check('the refusal names step a', withoutNudge.step === 'a', String(withoutNudge.step))
  check('nothing was reopened', state.listTickets({ status: 'all', limit: 50 }).filter(t => t.reopenedFrom === stalled.id).length === 0)

  const nudge = await call('superagent_status', { ticket_id: stalled.id })
  check('superagent_status nudges the worker', nudge.ok === true && nudge.nudged === true, JSON.stringify(nudge))
  check('the nudge was delivered as a report request', ctx.prompts.some(row => String(row.content?.[0]?.text ?? '').includes('superagent_report')))
  check('the nudge is recorded', typeof state.nudgedAt(stalled.id) === 'number')

  const afterNudgeOnly = await call('superagent_reopen', { ticket_id: stalled.id })
  check('a reopen after only step a is still refused', afterNudgeOnly.ok === false && afterNudgeOnly.step === 'b', JSON.stringify(afterNudgeOnly))

  await call('superagent_send', { ticket_id: stalled.id, text: '立即调用 superagent_report 汇报当前状态' })
  // The gate looks for a person's message after the nudge; the send records one.
  state.db.prepare('UPDATE message SET created_at = ? WHERE ticket_id = ? AND role = ?')
    .run((state.nudgedAt(stalled.id) ?? 0) + 1, stalled.id, 'operator')

  // The previous worker left an artifact but never reported — the exact incident shape.
  const workerDir = join(dir, 'agent', stalled.id)
  await mkdir(workerDir, { recursive: true })
  await writeFile(join(workerDir, 'index.html'), '<!doctype html><title>pelican</title>')
  await writeFile(join(workerDir, 'evidence.png'), 'not really a png')

  const reopened = await call('superagent_reopen', {
    ticket_id: stalled.id,
    leads: ['index.html 里的动画可能没有真的动起来', '截图看起来是静态的'],
  })
  check('the procedure complete, the reopen succeeds', reopened.ok === true, JSON.stringify(reopened))
  check('the old ticket is closed', state.getTicket(stalled.id)?.status === 'failed', state.getTicket(stalled.id)?.status)
  check('the old ticket records why it was reopened', String(state.getTicket(stalled.id)?.failure).includes('reopened as'), state.getTicket(stalled.id)?.failure)

  const fresh = state.getTicket(reopened.ticket_id)
  check('a new ticket exists', Boolean(fresh))
  check('the new ticket points at its predecessor', fresh.reopenedFrom === stalled.id, fresh.reopenedFrom)
  check('the new ticket stores the leads', fresh.leads.length === 2, JSON.stringify(fresh.leads))
  check('the artifact count is reported', reopened.artifacts === 2, String(reopened.artifacts))

  // ------------------------------------------- the handover separates fact from guess
  const body = state.intentText(fresh)
  check('the handover names the previous ticket', body.includes(stalled.id))
  check('the handover has a facts block', body.includes('上一 worker 的产物（事实）'))
  check('the facts block lists the artifact', body.includes('index.html'), body.slice(0, 200))
  check('the handover has a leads block', body.includes(LEADS_LABEL))
  check('the leads block lists the guesses', body.includes('动画可能没有真的动起来'))
  check('the handover has a contract block', body.includes(CONTRACT_LABEL))
  check('the handover carries the reproduce-first sentence', body.includes(VERIFY_FIRST), VERIFY_FIRST)
  check('the facts block comes before the leads block', body.indexOf('产物（事实）') < body.indexOf(LEADS_LABEL))
  check('the handover is recognised as reopened', isReopened(body) === true)

  // The new worker's brief repeats the leads, labelled, so skimming is not enough to miss them.
  const brief = JSON.parse(supervisor.brief(fresh, join(dir, 'agent', fresh.id)))
  check('the worker brief carries the leads', Array.isArray(brief.unverified_leads) && brief.unverified_leads.length === 2, JSON.stringify(brief.unverified_leads))
  check('the brief marks them unverified', String(brief.leads_note).includes(LEADS_LABEL), brief.leads_note)
  check('the brief names the predecessor', brief.reopened_from === stalled.id)
  check('the brief carries the worker rules', brief.rules.some(rule => rule.includes('唯一的退出通道')))
  check('the brief asks for a first progress report', brief.rules.some(rule => rule.includes('立刻')))

  // ------------------------------------------------------- edge cases
  const notStalled = state.createTicket({ title: 'fine', intent: 'ok' })
  const doneReopen = await call('superagent_reopen', { ticket_id: notStalled.id })
  check('an unknown-procedure ticket is refused', doneReopen.ok === false, JSON.stringify(doneReopen))
  const unknown = await call('superagent_reopen', { ticket_id: 't-does-not-exist' })
  check('an unknown ticket is refused', unknown.reason === 'unknown-ticket', JSON.stringify(unknown))

  const reusable = reopenedTaskText({ title: 'x', task: 'do x', artifacts: [], leads: [], previousTicketId: 't-1' })
  check('a handover with no artifacts says so', reusable.includes('没有留下可识别的产物'))
  check('a handover with no leads says so', reusable.includes('没有提供线索'))
  check('a handover always carries the reproduce-first sentence', reusable.includes(VERIFY_FIRST))
} finally {
  await supervisor.dispose()
  state.close()
  await rm(dir, { recursive: true, force: true })
}

const failures = results.filter(result => !result.pass)
console.log(`\n${results.length - failures.length}/${results.length} checks passed`)
if (failures.length > 0) process.exitCode = 1
