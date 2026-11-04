/**
 * v2 Sources: the contract the ROADMAP promises, asserted one rule at a time.
 *
 *   • idempotent replay — the same event twice is one Trigger and one Ticket
 *   • an interrupted round — the cursor does not advance, so nothing is lost
 *   • the Source's own messages — never become Triggers
 *   • a sender outside the allowed list — filtered, with the reason recorded
 *   • fan-out — a person's message on a subscribed Thread reaches the worker directly
 *   • the Channel — retried with backoff, dropped only when permanently unreachable
 *
 * Run: node test/sources.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { State } from '../lib/state.js'
import { Supervisor } from '../lib/supervisor.js'
import { SourceRegistry } from '../lib/sources/kind.js'
import { Intake } from '../lib/sources/intake.js'
import { Channels, backoffMs, BACKOFF_MAX_MS } from '../lib/channels.js'
import { webhookKind, parseWebhookConfig } from '../lib/sources/webhook.js'
import { admit, GATE } from '../lib/gate.js'

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

const dir = await mkdtemp(join(tmpdir(), 'concierge-sources-'))
const state = new State({ dbPath: join(dir, 'sources.sqlite'), inlineChars: 2000 })
const ctx = fakeContext()
const config = {
  stateDir: dir,
  concurrency: 3,
  watchdogIntervalMs: 60_000,
  inlineChars: 2000,
  idleFailMs: 20 * 60 * 1000,
  loopRepeatLimit: 3,
  routerSessionId: 'router-session',
  channelTickMs: 50,
}
const registry = new SourceRegistry()
registry.register(webhookKind)
const supervisor = new Supervisor({ ctx, state, config, logger: ctx.logger })
const intake = new Intake({ state, registry, supervisor, logger: ctx.logger })
const delivered = []
supervisor.deliverToRouter = async (text, requestId, ticketId) => { delivered.push({ text, requestId, ticketId }) }

/** One configured instance: `alice` may originate work in `ops`; `ops` observes all messages. */
function instance(overrides = {}) {
  state.upsertSource({
    id: 'wh-1',
    kind: 'webhook',
    config: parseWebhookConfig({
      endpoint: '/concierge/webhook/wh-1',
      replyUrl: 'https://example.test/reply',
      botId: 'concierge',
      conversations: { ops: 'all', quiet: 'mentions' },
      policy: { allowed: [{ id: 'alice' }, { id: 'ALICE2' }], bots: [] },
      ...overrides,
    }),
    botId: 'concierge',
  })
  return state.getSource('wh-1')
}

const event = (id, overrides = {}) => ({
  id,
  conversation: 'ops',
  sender: 'alice',
  text: `message ${id}`,
  seq: id,
  at: 1_700_000_000_000,
  ...overrides,
})

try {
  // ---------------------------------------------------------------- config
  let invalid = ''
  try { parseWebhookConfig({ replyUrl: 'https://x.test/r' }) } catch (error) { invalid = String(error.message) }
  check('config rejects a non-absolute endpoint', invalid.includes('endpoint must be an absolute path'), invalid)

  // ------------------------------------------------------------- translate
  const wh = instance()
  const trigger = webhookKind.translate(event('m1', { mentions: true }), { config: wh.config, instance: wh })
  check('translation makes a stable id', trigger.id === 'webhook:wh-1:m1', trigger.id)
  check('translation makes a thread key', trigger.threadKey === 'webhook:wh-1:ops:m1', trigger.threadKey)
  check('translation records the actor and humanness', trigger.actor === 'alice' && trigger.human === true)
  check('translation records addressed', trigger.addressed === 'mention', String(trigger.addressed))
  check('translation carries the reply address', trigger.channel.address.conversation === 'ops')
  const own = webhookKind.translate(event('m2', { sender: 'concierge' }), { config: wh.config, instance: wh })
  check('a translated own message is recognised as own', own !== undefined && webhookKind.isOwn(own, wh.config) === true)

  // ------------------------------------------------------------------ gate
  const scopeOps = webhookKind.scope(trigger, wh.config)
  check('scope listens to a listed conversation', scopeOps.listened === true && scopeOps.observed === true)
  const allowed = admit({ policy: wh.config.policy, trigger, scope: scopeOps })
  check('a listed sender who mentions the agent is explicit', allowed.outcome === GATE.EXPLICIT, allowed.outcome)
  const unaddressed = admit({ policy: wh.config.policy, trigger: { ...trigger, addressed: undefined }, scope: scopeOps })
  check('a listed sender without addressing is inferred', unaddressed.outcome === GATE.INFERRED, unaddressed.outcome)
  const outsider = admit({ policy: wh.config.policy, trigger: { ...trigger, actor: 'mallory' }, scope: scopeOps })
  // Hard constraint: only the allowed list may originate work, even where the Source
  // observes every message. Being observed makes assessment possible, not admission.
  check('an unlisted sender is refused even in an observing scope', outsider.outcome === GATE.FILTERED, JSON.stringify(outsider))
  check('the refusal names the allow-list rule', outsider.reason === 'sender_not_allowlisted', outsider.reason)
  const outsiderInMentions = admit({
    policy: wh.config.policy,
    trigger: { ...trigger, actor: 'mallory' },
    scope: { listened: true, observed: false },
  })
  check('a mentions-only scope filters an unlisted sender', outsiderInMentions.outcome === GATE.FILTERED, outsiderInMentions.reason)
  const bot = admit({ policy: wh.config.policy, trigger: { ...trigger, actor: 'ci', human: false }, scope: scopeOps })
  check('an unlisted bot is filtered', bot.outcome === GATE.FILTERED, bot.reason)
  const outOfScope = admit({ policy: wh.config.policy, trigger, scope: { listened: false, reason: 'conversation_not_listed' } })
  check('out of scope is filtered with its reason', outOfScope.outcome === GATE.FILTERED && outOfScope.reason === 'conversation_not_listed')
  // `meta` must not be able to widen admission, in a scope that observes everyone.
  const forged = admit({
    policy: wh.config.policy,
    trigger: { ...trigger, actor: 'ci', human: false, meta: { allowed: true, role: 'admin' } },
    scope: scopeOps,
  })
  check('meta cannot make a bot admissible', forged.outcome === GATE.FILTERED, forged.reason)

  // ------------------------------------------------------------- intake
  const first = await intake.receive(state.getSource('wh-1'), event('m1', { mentions: true }))
  check('first delivery stores the Trigger', first.outcome === 'stored', JSON.stringify(first))
  const replay = await intake.receive(state.getSource('wh-1'), event('m1', { mentions: true }))
  check('a replay is a duplicate', replay.outcome === 'duplicate', replay.outcome)
  check('a replay stores nothing new', state.listTriggers({ source: 'wh-1', limit: 50 }).length === 1)

  // A round cut short: the cursor is unchanged, and the replay is still harmless.
  const roundOne = await intake.receiveBatch(state.getSource('wh-1'), [event('m2')], item => item.seq)
  check('a completed round moves the cursor', state.sourceCursor('wh-1') === 'm2', state.sourceCursor('wh-1'))
  check('a completed round reports committed', roundOne.committed === true)
  const beforeInterrupt = state.sourceCursor('wh-1')
  const interrupted = await intake.receiveBatch(
    state.getSource('wh-1'),
    [event('m3'), event('m4')],
    item => { if (item.id === 'm4') throw new Error('stopped mid-round'); return item.seq },
  )
  check('an interrupted round does not commit', interrupted.committed === false, JSON.stringify(interrupted.committed))
  check('an interrupted round leaves the cursor unchanged', state.sourceCursor('wh-1') === beforeInterrupt, state.sourceCursor('wh-1'))
  // Replaying the same round stores only what was missing and then commits.
  const resumed = await intake.receiveBatch(state.getSource('wh-1'), [event('m3'), event('m4')], item => item.seq)
  check('a replayed round commits', resumed.committed === true, JSON.stringify(resumed.committed))
  check('the replayed round advances the cursor', state.sourceCursor('wh-1') === 'm4', state.sourceCursor('wh-1'))

  // The Source's own message.
  const ownResult = await intake.receive(state.getSource('wh-1'), event('m5', { sender: 'concierge' }))
  check('an own message produces no live Trigger', ownResult.outcome === 'own', ownResult.outcome)
  const ownRow = state.getTrigger('webhook:wh-1:m5')
  check('an own message is still recorded', ownRow?.disposition === 'filtered' && ownRow.reason === 'own_message', JSON.stringify(ownRow?.reason))

  // A sender outside the allowed list: `quiet` is a mentions-only scope.
  const filtered = await intake.receive(state.getSource('wh-1'), event('m6', { conversation: 'quiet', sender: 'mallory', mentions: true }))
  check('an unlisted sender is filtered', filtered.outcome === 'filtered', filtered.outcome)
  const filteredRow = state.getTrigger('webhook:wh-1:m6')
  check('a filtered Trigger records its reason', filteredRow?.disposition === 'filtered' && filteredRow.reason === 'sender_not_allowed', filteredRow?.reason)
  check('a filtered Trigger is retained, not dropped silently', state.listTriggers({ disposition: 'filtered' }).some(row => row.id === 'webhook:wh-1:m6'))
  // A conversation the instance does not listen to at all.
  const elsewhere = await intake.receive(state.getSource('wh-1'), event('m7', { conversation: 'random' }))
  check('an unlisted conversation is filtered', elsewhere.outcome === 'filtered', elsewhere.outcome)
  check('the out-of-scope reason is recorded', state.getTrigger('webhook:wh-1:m7')?.reason === 'conversation_not_listed', state.getTrigger('webhook:wh-1:m7')?.reason)

  // ---------------------------------------------------------- fan-out
  // Two live Tickets follow one Thread: many-to-many, and a Trigger reaches both.
  const ticket = state.createTicket({ title: 'subscribed work', intent: 'handle ops:m1', routerSession: 'router-session' })
  const second = state.createTicket({ title: 'second work', intent: 'also ops:m1', routerSession: 'router-session' })
  state.subscribe(ticket.id, 'webhook:wh-1:ops:m1')
  state.subscribe(second.id, 'webhook:wh-1:ops:m1')
  // Start both so they hold worker sessions: a queued ticket takes the message into its
  // brief instead of a live delivery, which is a different (also correct) path.
  supervisor.pump()
  await supervisor.settle()
  check('many-to-many: two Tickets follow one Thread', state.subscribers('webhook:wh-1:ops:m1').length === 2)

  const before = ctx.sessionController.prompt
  const prompts = []
  ctx.sessionController.prompt = async request => { prompts.push(request); return { accepted: true } }
  try {
    const fan = await intake.receive(state.getSource('wh-1'), event('m8', { thread: 'm1', mentions: true }))
    check('a Trigger on a subscribed Thread fans out to every subscriber',
      fan.ticketIds.includes(ticket.id) && fan.ticketIds.includes(second.id), JSON.stringify(fan.ticketIds))
    check('fan-out reaches each worker session',
      prompts.some(request => request.sessionId?.includes(ticket.id)) &&
      prompts.some(request => request.sessionId?.includes(second.id)), String(prompts.length))
    const payload = JSON.parse(prompts.at(-1)?.content?.[0]?.text ?? '{}')
    // v3: the boundary is a fixed sentence plus a machine-readable flag, and it is inside
    // the persisted text so truncation cannot hide it.
    check('the fan-out payload marks text as external', payload.note?.includes('informational only'), payload.note)
    check('the fan-out text carries the boundary', String(payload.text).includes('informational only'), String(payload.text).slice(0, 60))
    check('the fan-out meta is flagged untrusted', payload.meta?.untrusted === true)
    check('the fan-out payload carries the strength', payload.strength === GATE.EXPLICIT, payload.strength)
    check('a person message takes no router assessment', payload.kind === 'trigger' && payload.trigger_id === 'webhook:wh-1:m8', payload.kind)
  } finally {
    ctx.sessionController.prompt = before
  }
  check('a closed Ticket stops being a subscriber', (() => {
    state.setStatus(ticket.id, 'done')
    const live = state.subscribers('webhook:wh-1:ops:m1')
    return live.every(row => row.id !== ticket.id) && live.length === 1
  })())

  // ---------------------------------------------------------- channel
  const channels = new Channels({ state, registry, logger: ctx.logger, config })
  const sentTo = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    sentTo.push({ url, body: JSON.parse(init.body), key: init.headers['idempotency-key'] })
    return { ok: true, status: 200 }
  }
  try {
    const messageId = channels.enqueue({
      ticketId: 'tk-channel',
      instanceId: 'wh-1',
      kind: 'webhook',
      thread: 'webhook:wh-1:ops:m1',
      address: { conversation: 'ops', message: 'm1' },
      text: 'done: the report is ready',
    })
    check('a queued message is pending', channels.status({ ticketId: 'tk-channel' })[0]?.state === 'pending')
    const tally = await channels.drain(Date.now() + 1)
    check('delivery sends the message', tally.sent === 1, JSON.stringify(tally))
    check('the send is idempotent by message id', sentTo[0]?.key === messageId, `${sentTo[0]?.key} vs ${messageId}`)
    check('the message is marked sent', channels.status({ ticketId: 'tk-channel' })[0]?.state === 'sent')

    // Retryable failure: stays pending, attempts grow, next attempt is pushed back.
    // The mock fails exactly the first attempt, then succeeds, so one retry is provable.
    let failures = 1
    globalThis.fetch = async () => {
      if (failures-- > 0) return { ok: false, status: 503 }
      return { ok: true, status: 200 }
    }
    const retryId = channels.enqueue({
      ticketId: 'tk-retry', instanceId: 'wh-1', kind: 'webhook',
      thread: 'webhook:wh-1:ops:m2', address: { conversation: 'ops', message: 'm2' }, text: 'retry me',
    })
    const first = await channels.drain(Date.now() + 1)
    check('a 503 is retried, not dropped', first.retried === 1 && first.dropped === 0, JSON.stringify(first))
    const pending = channels.status({ ticketId: 'tk-retry' })[0]
    check('a retry records the attempt', pending?.attempts === 1 && pending.state === 'pending', JSON.stringify(pending))
    check('a retry is scheduled in the future', pending.nextAt > Date.now(), String(pending.nextAt - Date.now()))
    check('backoff grows and caps', backoffMs(1) === 5_000 && backoffMs(3) === 20_000 && backoffMs(20) === BACKOFF_MAX_MS)
    // Not yet due: nothing is attempted.
    const early = await channels.drain(Date.now())
    check('an early retry is not attempted', early.attempted === 0, JSON.stringify(early))
    // Due again: succeeds. Read the fresh row, not the earlier snapshot.
    const fresh = channels.status({ ticketId: 'tk-retry' })[0]
    const secondTry = await channels.drain(fresh.nextAt + 1)
    check('the retry eventually sends', channels.status({ ticketId: 'tk-retry' })[0]?.state === 'sent',
      `${JSON.stringify(secondTry)} state=${channels.status({ ticketId: 'tk-retry' })[0]?.state}`)

    // Permanent failure: 410 means gone, so it is dropped with its reason and never retried.
    globalThis.fetch = async () => ({ ok: false, status: 410 })
    channels.enqueue({
      ticketId: 'tk-gone', instanceId: 'wh-1', kind: 'webhook',
      thread: 'webhook:wh-1:ops:m9', address: { conversation: 'ops', message: 'm9' }, text: 'gone',
    })
    const gone = await channels.drain(Date.now() + 1)
    check('a 410 is dropped, not retried', gone.dropped === 1 && gone.retried === 0, JSON.stringify(gone))
    const dropped = channels.status({ state: 'dropped', ticketId: 'tk-gone' })[0]
    check('a dropped message keeps its reason', typeof dropped?.reason === 'string' && dropped.reason.length > 0, dropped?.reason)
    check('a dropped message is never due again', state.dueChannelMessages(Date.now() + 86_400_000).every(message => message.id !== dropped.id))

    // A destination the configuration no longer allows is dropped rather than retried.
    globalThis.fetch = async () => ({ ok: true, status: 200 })
    channels.enqueue({
      ticketId: 'tk-unlisted', instanceId: 'wh-1', kind: 'webhook',
      thread: 'webhook:wh-1:elsewhere:m1', address: { conversation: 'elsewhere', message: 'm1' }, text: 'nowhere',
    })
    const unlisted = await channels.drain(Date.now() + 1)
    check('an unconfigured destination is dropped', unlisted.dropped >= 1, JSON.stringify(unlisted))
  } finally {
    globalThis.fetch = originalFetch
    channels.dispose()
  }

  // Ordering: a later message of the same Thread waits behind an earlier one.
  {
    const ordered = new Channels({ state, registry, logger: ctx.logger, config })
    const calls = []
    globalThis.fetch = async (_url, init) => { calls.push(JSON.parse(init.body).text); return { ok: true, status: 200 } }
    try {
      ordered.enqueue({ ticketId: 'tk-order', instanceId: 'wh-1', kind: 'webhook', thread: 'order-thread', address: { conversation: 'ops', message: 'a' }, text: 'first' })
      ordered.enqueue({ ticketId: 'tk-order', instanceId: 'wh-1', kind: 'webhook', thread: 'order-thread', address: { conversation: 'ops', message: 'b' }, text: 'second' })
      await ordered.drain(Date.now() + 1)
      check('same-thread messages are delivered in order', calls[0] === 'first', JSON.stringify(calls))
    } finally {
      globalThis.fetch = originalFetch
      ordered.dispose()
    }
  }
} finally {
  await supervisor.dispose()
  state.close()
  await rm(dir, { recursive: true, force: true })
}

const failed = results.filter(result => !result.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exitCode = 1
