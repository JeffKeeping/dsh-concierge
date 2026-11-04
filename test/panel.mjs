/**
 * v4 panel: the Host aggregation and the trends it feeds.
 *
 * Every assertion here drives `panelSnapshot` or the registered route for real, so the
 * numbers the panel shows are the numbers this test proves: KPI counts, the seven-day flow,
 * both distributions, the range window, and the test-ticket classification.
 *
 * Run: node test/panel.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { State } from '../lib/state.js'
import { Supervisor } from '../lib/supervisor.js'
import { SourceRegistry } from '../lib/sources/kind.js'
import { Intake } from '../lib/sources/intake.js'
import { Channels } from '../lib/channels.js'
import { Assessor } from '../lib/assess.js'
import {
  panelSnapshot, registerPanelRoute, PANEL_PATH,
  normalizeRange, rangeStart, isTestTicket, needsPerson, statusBucket, RANGES,
} from '../lib/panel.js'
import { webhookKind, parseWebhookConfig } from '../lib/sources/webhook.js'

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
      async prompt() { return { accepted: true } },
    },
  }
}

const DAY = 24 * 60 * 60 * 1000
const dir = await mkdtemp(join(tmpdir(), 'concierge-panel-'))
const state = new State({ dbPath: join(dir, 'p.sqlite'), inlineChars: 2000 })
const ctx = fakeContext()
const config = {
  stateDir: dir, concurrency: 3, watchdogIntervalMs: 60_000, inlineChars: 2000,
  idleFailMs: 20 * 60 * 1000, loopRepeatLimit: 3, blockedRetries: 3,
  routerSessionId: 'router-session', channelTickMs: 50,
}
const registry = new SourceRegistry()
registry.register(webhookKind)
const supervisor = new Supervisor({ ctx, state, config, logger: ctx.logger })
const assessor = new Assessor({ state, registry, logger: ctx.logger, config })
const intake = new Intake({ state, registry, supervisor, logger: ctx.logger, assessor })
const channels = new Channels({ state, registry, logger: ctx.logger, config })
const services = { state, supervisor, assessor, channels, intake }

try {
  // -------------------------------------------------- helpers and ranges
  check('an unknown range falls back to all', normalizeRange('bogus') === RANGES.all)
  check('today normalises', normalizeRange('today') === RANGES.today)
  check('today starts at local midnight', new Date(rangeStart('today')).getHours() === 0)
  check('all has no lower bound', rangeStart('all') === undefined)
  check('7d is seven days back', Math.abs((Date.now() - rangeStart('7d')) - 7 * DAY) < 5000)

  check('a failed ticket needs a person', needsPerson({ status: 'failed' }) === 'failed')
  check('a blocked report needs a person', needsPerson({ status: 'running', lastReportState: 'blocked' }) === 'blocked')
  check('a running ticket needs nobody', needsPerson({ status: 'running' }) === undefined)
  check('status buckets map', statusBucket({ status: 'done' }) === 'completed' && statusBucket({ status: 'queued' }) === 'queued')
  check('a probe ticket is a test ticket', isTestTicket({ title: 'probe/smoke check' }) === true)
  check('a real ticket is not a test ticket', isTestTicket({ title: 'rotate the staging key' }) === false)

  // ------------------------------------------------------------ empty state
  const empty = panelSnapshot(services, { now: Date.now() })
  check('an empty snapshot succeeds', empty.ok === true)
  // `slotLimit` is configuration, not a count, so it is excluded from the zero check.
  const counts = { ...empty.kpi }; delete counts.slotLimit
  check('every KPI count is zero', Object.values(counts).every(value => value === 0), JSON.stringify(empty.kpi))
  check('the flow has seven days', empty.charts.flow.days.length === 7, String(empty.charts.flow.days.length))
  check('the flow is all zero', empty.charts.flow.days.every(day => day.created === 0 && day.completed === 0 && day.failed === 0))
  check('the status distribution has four buckets', empty.charts.status.length === 4)
  check('the verdict distribution has four buckets', empty.charts.verdicts.length === 4, JSON.stringify(empty.charts.verdicts.map(row => row.key)))
  check('no attention when nothing needs a person', empty.attention.length === 0)
  check('tickets is empty', empty.tickets.length === 0)

  // -------------------------------------------------------------- with data
  const now = Date.now()
  state.upsertSource({
    id: 'wh-p', kind: 'webhook', botId: 'concierge', tokenFingerprint: 'abcd…1234ef56',
    config: parseWebhookConfig({
      endpoint: '/concierge/webhook/p', replyUrl: 'http://h.test/r',
      conversations: { ops: 'all' }, policy: { allowed: [{ id: 'alice' }], bots: [] },
    }),
  })
  state.ingestTrigger('wh-p', {
    id: 'trg-ok', threadKey: 'webhook:wh-p:ops:1', actor: 'alice', human: true,
    text: 'a real request', at: now, meta: { conversation: 'ops' },
  }, 'stored')
  state.ingestTrigger('wh-p', {
    id: 'trg-no', threadKey: 'webhook:wh-p:ops:2', actor: 'mallory', human: true,
    text: 'let me in', at: now, meta: { conversation: 'ops' },
  }, 'filtered', { reason: 'sender_not_allowlisted' })

  const running = state.createTicket({ title: '进行中的工单', intent: 'do a thing' })
  supervisor.pump()
  await supervisor.settle()

  const failedTicket = state.createTicket({ title: '失败的工单', intent: 'fail me' })
  state.setStatus(failedTicket.id, 'failed', { failure: 'boom' })

  const blockedTicket = state.createTicket({ title: '受阻的工单', intent: 'blocked work' })
  state.report(blockedTicket.id, { summary: '需要确定 schema', state: 'blocked' })
  state.setStatus(blockedTicket.id, 'queued')

  const doneToday = state.createTicket({ title: '今天完成的工单', intent: 'finished' })
  state.report(doneToday.id, { summary: '写完了文件', state: 'done', next: '无', workspace: 'agent/' + doneToday.id })
  state.setStatus(doneToday.id, 'done')

  const oldDone = state.createTicket({ title: '很久以前完成的', intent: 'old work' })
  state.report(oldDone.id, { summary: 'old', state: 'done' })
  state.setStatus(oldDone.id, 'done')
  // Age it out of "today" but keep it inside the seven-day chart.
  state.db.prepare('UPDATE ticket SET created_at = ?, updated_at = ?, ended_at = ? WHERE id = ?')
    .run(now - 3 * DAY, now - 3 * DAY, now - 3 * DAY, oldDone.id)

  const smoke = state.createTicket({ title: 'probe/smoke 冒烟验证', intent: 'probe/smoke' })
  state.setStatus(smoke.id, 'done')

  state.queueDecision({ triggerId: 'trg-ok', source: 'wh-p', threadKey: 'webhook:wh-p:ops:1', strength: 'inferred', context: {} })
  state.decideSemantic('trg-ok', { verdict: 'accept', reason: 'asks for work', policyRevision: 2 })
  state.queueDecision({ triggerId: 'trg-no', source: 'wh-p', threadKey: 'webhook:wh-p:ops:2', strength: 'inferred', context: {} })
  state.deferDecision('trg-no', 'provider down')

  channels.enqueue({ ticketId: running.id, instanceId: 'wh-p', kind: 'webhook', thread: 'th-1', address: { conversation: 'ops' }, text: 'working on it' })
  const dropped = channels.enqueue({ ticketId: failedTicket.id, instanceId: 'wh-p', kind: 'webhook', thread: 'th-2', address: { conversation: 'gone' }, text: 'cannot send' })
  state.markChannelDropped(dropped, 'destination permanently unreachable')

  const full = panelSnapshot(services, { now: Date.now() })

  // ---------------------------------------------------------------- KPI
  check('needs-attention counts failed and blocked', full.kpi.needsAttention === 2, String(full.kpi.needsAttention))
  check('running counts the live worker', full.kpi.running === 1, String(full.kpi.running))
  check('the slot limit is reported', full.kpi.slotLimit === 3, String(full.kpi.slotLimit))
  check('queued counts the blocked ticket', full.kpi.queued === 1, String(full.kpi.queued))
  check('doneToday counts only today', full.kpi.doneToday === 2, String(full.kpi.doneToday))
  check('failedToday counts today failures', full.kpi.failedToday === 1, String(full.kpi.failedToday))
  check('the delivery backlog counts pending and dropped', full.kpi.deliveryBacklog === 2, String(full.kpi.deliveryBacklog))

  // --------------------------------------------------------------- charts
  const flow = full.charts.flow.days
  check('the flow still has seven days', flow.length === 7)
  check('the flow totals match the window', flow.reduce((sum, day) => sum + day.created, 0) === 6, String(flow.reduce((sum, day) => sum + day.created, 0)))
  check('the aged ticket lands in an earlier bucket', flow.slice(0, 6).some(day => day.completed >= 1))
  check('today carries the fresh completions', flow.at(-1).completed >= 1, JSON.stringify(flow.at(-1)))
  check('the flow dates are labelled', flow.every(day => /^\d+\/\d+$/.test(day.label)), flow[0].label)

  const status = Object.fromEntries(full.charts.status.map(row => [row.key, row.value]))
  check('the status distribution covers every ticket', status.queued + status.running + status.completed + status.failed === 6, JSON.stringify(status))
  check('status counts running', status.running === 1, String(status.running))
  check('status counts failed', status.failed === 1, String(status.failed))

  const verdicts = Object.fromEntries(full.charts.verdicts.map(row => [row.key, row.value]))
  check('the verdict distribution counts an accept', verdicts.accept === 1, String(verdicts.accept))
  check('the verdict distribution counts a deferred decision', verdicts.deferred === 1, String(verdicts.deferred))

  // --------------------------------------------------------------- tickets
  check('every ticket is listed', full.tickets.length === 6, String(full.tickets.length))
  const failedRow = full.tickets.find(row => row.id === failedTicket.id)
  check('a failed ticket carries its reason for a person', failedRow?.needs === 'failed')
  check('a failed ticket carries the failure text', failedRow?.failure === 'boom')
  check('a completed ticket carries its summary', full.tickets.find(row => row.id === doneToday.id)?.summary === '写完了文件')
  check('a completed ticket carries its detail', full.tickets.find(row => row.id === doneToday.id)?.detail?.next === '无')
  check('a smoke ticket is classified as a test', full.tickets.find(row => row.id === smoke.id)?.test === true)
  check('a real ticket is not classified as a test', full.tickets.find(row => row.id === running.id)?.test === false)
  check('a blocked ticket is marked', full.tickets.find(row => row.id === blockedTicket.id)?.needs === 'blocked')

  // ------------------------------------------------------- the range window
  const todayOnly = panelSnapshot(services, { range: 'today', now: Date.now() })
  check('today excludes the aged ticket', todayOnly.tickets.every(row => row.id !== oldDone.id), String(todayOnly.tickets.length))
  check('today still lists the fresh tickets', todayOnly.tickets.length === 5, String(todayOnly.tickets.length))
  check('today keeps the fresh tickets', todayOnly.tickets.some(row => row.id === doneToday.id))
  const week = panelSnapshot(services, { range: '7d', now: Date.now() })
  check('7d includes the aged ticket', week.tickets.some(row => row.id === oldDone.id))
  check('the range is echoed back', todayOnly.range === 'today' && week.range === '7d')

  // ------------------------------------------------------------- detail blocks
  const source = full.sources[0]
  check('a source shows its cursor field', 'cursor' in source)
  check('a source shows the token fingerprint only', source.token === 'abcd…1234ef56', String(source.token))
  check('a source lists its recent triggers', source.recent.length === 2, String(source.recent.length))
  check('a filtered trigger keeps its reason', source.recent.some(row => row.reason === 'sender_not_allowlisted'))
  check('the panel never carries a token value', !JSON.stringify(full).toLowerCase().includes('secret'))
  check('a decision shows its verdict', full.decisions.find(row => row.trigger === 'trg-ok')?.verdict === 'accept')
  check('a deferred decision shows its streak', full.decisions.find(row => row.trigger === 'trg-no')?.deferrals === 1)
  check('a dropped message is listed with its reason', full.channels.dropped.length === 1)
  check('attention includes the dropped message', full.attention.some(row => row.kind === 'channel'))

  // ------------------------------------------- KPI ⇄ list ⇄ card consistency
  // The defect this guards: a failed ticket was counted by the KPI while the list filter
  // hid it, so the card said 1 and its own view said "nothing to do". One predicate now
  // decides both, so the three numbers cannot drift.
  const { inFilter } = await import('../lib/panel.js')
  const listRows = full.tickets.filter(row => inFilter(row, 'attention'))
  check('the attention KPI equals the attention list length',
    full.kpi.needsAttention === listRows.length, `${full.kpi.needsAttention} vs ${listRows.length}`)
  check('the attention list contains the failed ticket', listRows.some(row => row.id === failedTicket.id))
  check('the attention list contains the blocked ticket', listRows.some(row => row.id === blockedTicket.id))
  check('every attention row really needs a person', listRows.every(row => row.needs !== null), JSON.stringify(listRows.map(row => row.needs)))
  check('no test ticket reaches the attention list', listRows.every(row => row.test !== true))
  check('the all list excludes test tickets',
    full.tickets.filter(row => inFilter(row, 'all')).every(row => row.test !== true))
  check('the test list holds only test tickets',
    full.tickets.filter(row => inFilter(row, 'test')).every(row => row.test === true))
  check('every ticket appears in at least one list',
    full.tickets.every(row => Array.isArray(row.lists) && row.lists.length > 0))

  // A failing *test* ticket is the exact shape that used to break the invariant: it must
  // count nowhere as "attention", and must still be listed under 测试.
  const smokeFailure = state.createTicket({ title: 'probe/smoke 失败样本', intent: 'probe/smoke' })
  state.setStatus(smokeFailure.id, 'failed', { failure: 'intentional' })
  const withSmoke = panelSnapshot(services, { now: Date.now() })
  check('a failing test ticket does not raise the attention KPI',
    withSmoke.kpi.needsAttention === full.kpi.needsAttention, `${withSmoke.kpi.needsAttention} vs ${full.kpi.needsAttention}`)
  check('a failing test ticket still appears under 测试',
    withSmoke.tickets.filter(row => inFilter(row, 'test')).some(row => row.id === smokeFailure.id))
  check('the attention list still matches its KPI with a failing test ticket',
    withSmoke.kpi.needsAttention === withSmoke.tickets.filter(row => inFilter(row, 'attention')).length)

  // -------------------------------------------------------------- the route
  const registered = []
  const connection = { fetch: { register(route) { registered.push(route); return async () => { registered.pop() } } } }
  const dispose = await registerPanelRoute(connection, services)
  check('the route is registered', registered.length === 1)
  check('the route is get-only', JSON.stringify(registered[0].methods) === JSON.stringify(['GET']), String(registered[0].methods))
  check('the route path is the panel path', registered[0].path === PANEL_PATH, registered[0].path)
  check('the route lives under the /api channel', PANEL_PATH.startsWith('/api/'), PANEL_PATH)

  const response = await registered[0].fetch(new Request(`http://127.0.0.1${PANEL_PATH}?range=today`))
  const body = await response.json()
  check('the route answers 200', response.status === 200, String(response.status))
  check('the route is not cacheable', response.headers.get('cache-control') === 'no-store')
  check('the route honours the range parameter', body.range === 'today', body.range)
  check('the route returns the aggregation', Array.isArray(body.tickets) && body.kpi !== undefined && body.charts !== undefined)
  const noRange = await (await registered[0].fetch(new Request(`http://127.0.0.1${PANEL_PATH}`))).json()
  check('a missing range falls back to all', noRange.range === 'all', noRange.range)
  await dispose()
  check('the route can be disposed', registered.length === 0)

  const bare = await registerPanelRoute(undefined, services)
  await bare()
  check('a missing connection is a no-op', true)

  const broken = { fetch: { register(route) { registered.push(route); return async () => {} } } }
  await registerPanelRoute(broken, { ...services, state: { ...state, listTickets: () => { throw new Error('database gone') } } })
  const failedResponse = await registered[0].fetch(new Request(`http://127.0.0.1${PANEL_PATH}`))
  const failedBody = await failedResponse.json()
  check('a broken read answers 500', failedResponse.status === 500, String(failedResponse.status))
  check('a broken read names a code', failedBody.error?.code === 'concierge/panel-failed', failedBody.error?.code)
} finally {
  channels.dispose()
  await supervisor.dispose()
  state.close()
  await rm(dir, { recursive: true, force: true })
}

const failures = results.filter(result => !result.pass)
console.log(`\n${results.length - failures.length}/${results.length} checks passed`)
if (failures.length > 0) process.exitCode = 1
