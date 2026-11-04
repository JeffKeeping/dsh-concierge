/**
 * v4 step 0: deferred decisions back off, escalate, and survive a restart.
 *
 * The schedule is stored, not held in memory: this test closes the database between
 * attempts and reopens it, which is what a Host restart looks like to the plugin.
 *
 * Run: node test/defer.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { State } from '../lib/state.js'
import { Assessor } from '../lib/assess.js'
import { SourceRegistry } from '../lib/sources/kind.js'
import { webhookKind, parseWebhookConfig } from '../lib/sources/webhook.js'

const results = []
function check(name, condition, detail = undefined) {
  results.push({ name, pass: Boolean(condition), detail })
  if (!condition) console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  else console.log(`ok    ${name}`)
}

const dir = await mkdtemp(join(tmpdir(), 'concierge-defer-'))
const dbPath = join(dir, 'd.sqlite')
const BASE = 15 * 60 * 1000
const config = {
  deferBaseMs: BASE,
  maxDeferrals: 3,
  assessorTickMs: 60_000,
  assessorBatch: 5,
}

function open() {
  return new State({ dbPath, inlineChars: 2000 })
}

function seed(state, triggerId = 'wh:1') {
  state.upsertSource({
    id: 'wh', kind: 'webhook', botId: 'concierge',
    config: parseWebhookConfig({
      endpoint: '/concierge/webhook/x', replyUrl: 'http://h.test/r',
      conversations: { ops: 'all' }, policy: { allowed: [{ id: 'alice' }], bots: [] },
    }),
  })
  state.ingestTrigger('wh', {
    id: triggerId, threadKey: 'webhook:wh:ops:1', actor: 'alice', human: true,
    text: 'maybe a request', at: Date.now(), meta: { conversation: 'ops' },
  }, 'stored')
  state.queueDecision({ triggerId, source: 'wh', threadKey: 'webhook:wh:ops:1', strength: 'inferred', context: { text: 'maybe a request' } })
  return triggerId
}

let state = open()
try {
  const registry = new SourceRegistry()
  registry.register(webhookKind)
  const assessor = new Assessor({ state, registry, logger: { warn() {}, debug() {} }, config })

  // ---------------------------------------------- the first failure schedules a retry
  const triggerId = seed(state)
  assessor.useAssessor(async () => { throw new Error('provider down') })
  const t0 = Date.now()
  await assessor.drain(5, t0)
  const first = state.getDecision(triggerId)
  check('a failed assessment stays pending', first.state === 'pending', first.state)
  check('the attempt is counted', first.deferrals === 1, String(first.deferrals))
  check('the reason is kept', String(first.reason).includes('provider down'), first.reason)
  check('a retry is scheduled 15 minutes out', Math.abs((first.nextAt - t0) - BASE) < 1000, String(first.nextAt - t0))

  // Not due yet: the same instant finds nothing to do.
  const early = await assessor.drain(5, t0 + 1000)
  check('an early retry is not attempted', early.length === 0, String(early.length))

  // ---------------------------------------------------- backoff doubles, then escalates
  await assessor.drain(5, t0 + BASE + 1)
  const second = state.getDecision(triggerId)
  check('the second attempt is counted', second.deferrals === 2, String(second.deferrals))
  check('the second delay doubles', Math.abs((second.nextAt - (t0 + BASE + 1)) - 2 * BASE) < 1000, String(second.nextAt - (t0 + BASE + 1)))

  await assessor.drain(5, t0 + 10 * BASE)
  const third = state.getDecision(triggerId)
  check('the third failure escalates to a verdict', third.state === 'decided', third.state)
  check('the verdict is ignore', third.verdict === 'ignore', third.verdict)
  check('the reason records the whole streak', String(third.reason).includes('deferred 3 times'), third.reason)
  check('an escalated decision has no retry time', third.nextAt === undefined, String(third.nextAt))
  check('an escalated decision is counted once', third.deferrals === 3, String(third.deferrals))

  // ------------------------------------------------------- survives a restart
  const restartId = 'wh:2'
  state.ingestTrigger('wh', {
    id: restartId, threadKey: 'webhook:wh:ops:2', actor: 'alice', human: true,
    text: 'another maybe', at: Date.now(), meta: { conversation: 'ops' },
  }, 'stored')
  state.queueDecision({ triggerId: restartId, source: 'wh', threadKey: 'webhook:wh:ops:2', strength: 'inferred', context: {} })
  assessor.useAssessor(async () => { throw new Error('still down') })
  const beforeRestart = Date.now()
  await assessor.drain(5, beforeRestart)
  const scheduled = state.getDecision(restartId).nextAt
  check('a pending retry has a stored time', typeof scheduled === 'number', String(scheduled))

  // Close and reopen: a Host restart keeps the schedule, it does not reset it.
  state.close()
  state = open()
  const afterRestart = state.getDecision(restartId)
  check('the schedule survives a restart', afterRestart.nextAt === scheduled, `${afterRestart.nextAt} vs ${scheduled}`)
  check('the attempt count survives a restart', afterRestart.deferrals === 1, String(afterRestart.deferrals))
  check('the timer is not reset on reopen', afterRestart.nextAt > Date.now(), 'the retry is still in the future')

  const restarted = new Assessor({ state, registry, logger: { warn() {}, debug() {} }, config })
  restarted.useAssessor(async () => '{"verdict":"accept","reason":"looks real"}')
  const tooEarly = await restarted.drain(5, Date.now())
  check('after a restart an early retry still waits', tooEarly.length === 0, String(tooEarly.length))
  const dueLater = await restarted.drain(5, scheduled + 1)
  check('after a restart the due retry runs', dueLater.length === 1, JSON.stringify(dueLater))
  check('and it can finally decide', state.getDecision(restartId).verdict === 'accept', state.getDecision(restartId).verdict)

  // --------------------------------------------------- recovery clears the streak
  const recoverId = 'wh:3'
  state.ingestTrigger('wh', {
    id: recoverId, threadKey: 'webhook:wh:ops:3', actor: 'alice', human: true,
    text: 'third', at: Date.now(), meta: { conversation: 'ops' },
  }, 'stored')
  state.queueDecision({ triggerId: recoverId, source: 'wh', threadKey: 'webhook:wh:ops:3', strength: 'inferred', context: {} })
  // The reopened `state` needs an assessor bound to it, as the plugin would rebuild one.
  restarted.useAssessor(async () => { throw new Error('down') })
  await restarted.drain(5, Date.now())
  check('one failure is pending', state.getDecision(recoverId).deferrals === 1)
  const pendingAt = state.getDecision(recoverId).nextAt
  restarted.useAssessor(async () => '{"verdict":"accept","reason":"fine"}')
  await restarted.drain(5, pendingAt + 1)
  const recovered = state.getDecision(recoverId)
  check('a successful retry decides', recovered.verdict === 'accept', recovered.verdict)
  check('a decided row keeps its attempt history', recovered.deferrals === 1, String(recovered.deferrals))

  // ------------------------------------------------------- the configured limits
  const tight = new Assessor({ state, registry, logger: { warn() {}, debug() {} }, config: { ...config, deferBaseMs: 1000, maxDeferrals: 2 } })
  const tightId = 'wh:4'
  state.ingestTrigger('wh', {
    id: tightId, threadKey: 'webhook:wh:ops:4', actor: 'alice', human: true,
    text: 'fourth', at: Date.now(), meta: { conversation: 'ops' },
  }, 'stored')
  state.queueDecision({ triggerId: tightId, source: 'wh', threadKey: 'webhook:wh:ops:4', strength: 'inferred', context: {} })
  tight.useAssessor(async () => { throw new Error('down') })
  const now = Date.now()
  await tight.drain(5, now)
  check('a configured base delay is used', Math.abs((state.getDecision(tightId).nextAt - now) - 1000) < 200, String(state.getDecision(tightId).nextAt - now))
  await tight.drain(5, now + 2000)
  check('a configured deferral limit escalates sooner', state.getDecision(tightId).verdict === 'ignore', state.getDecision(tightId).verdict)

  // ---------------------------------------------------- the retry loop is disposable
  tight.startRetryLoop()
  check('the retry loop starts', tight.retryTimer !== undefined)
  tight.startRetryLoop()
  check('a second start does not add a timer', tight.retryTimer !== undefined)
  tight.dispose()
  check('dispose stops the loop', tight.retryTimer === undefined && tight.disposed === true)
} finally {
  // `state` may already be closed by the restart leg above.
  try { state.close() } catch { /* already closed */ }
  await rm(dir, { recursive: true, force: true })
}

const failed = results.filter(result => !result.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exitCode = 1
