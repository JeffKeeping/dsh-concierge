/**
 * v3 step 1: the semantic assessment layer.
 *
 * The defining property is one direction. A model verdict may turn an admitted Trigger
 * into `ignore`; it can never turn a refused one into work. Everything else here asserts
 * the surrounding machinery: which Triggers reach the assessor at all, that a decision is
 * recorded and replayable, and that a long body stays readable through a reference.
 *
 * Run: node test/assess.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { State, DEFAULT_SEMANTIC_POLICY } from '../lib/state.js'
import { Supervisor } from '../lib/supervisor.js'
import { SourceRegistry } from '../lib/sources/kind.js'
import { Intake } from '../lib/sources/intake.js'
import { Assessor, parseVerdict, VERDICT } from '../lib/assess.js'
import { webhookKind, parseWebhookConfig } from '../lib/sources/webhook.js'
import { GATE } from '../lib/gate.js'
import { EXTERNAL_MARKER } from '../lib/untrusted.js'

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

const dir = await mkdtemp(join(tmpdir(), 'concierge-assess-'))
const state = new State({ dbPath: join(dir, 'a.sqlite'), inlineChars: 4000 })
const ctx = fakeContext()
const config = {
  stateDir: dir,
  concurrency: 3,
  watchdogIntervalMs: 60_000,
  inlineChars: 4000,
  idleFailMs: 20 * 60 * 1000,
  loopRepeatLimit: 3,
  blockedRetries: 3,
  routerSessionId: 'router-session',
  assessorSessionId: 'assessor-session',
  channelTickMs: 50,
}
const registry = new SourceRegistry()
registry.register(webhookKind)
const supervisor = new Supervisor({ ctx, state, config, logger: ctx.logger })
const assessor = new Assessor({ state, registry, logger: ctx.logger, config })
const intake = new Intake({ state, registry, supervisor, logger: ctx.logger, assessor })

state.upsertSource({
  id: 'wh-a',
  kind: 'webhook',
  botId: 'concierge',
  config: parseWebhookConfig({
    endpoint: '/concierge/webhook/a',
    replyUrl: 'http://h.test/reply',
    botId: 'concierge',
    conversations: { ops: 'all' },
    policy: { allowed: [{ id: 'alice' }], bots: [] },
  }),
})

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
  // ------------------------------------------------------- verdict parsing
  check('a JSON verdict is read', parseVerdict('{"verdict":"accept","reason":"asks"}')?.verdict === VERDICT.ACCEPT)
  check('a fenced verdict is read', parseVerdict('```json\n{"verdict":"ignore","reason":"chatter"}\n```')?.verdict === VERDICT.IGNORE)
  check('an unknown verdict is refused', parseVerdict('{"verdict":"widen"}') === undefined)
  check('garbage is refused', parseVerdict('I think maybe yes') === undefined)

  // ------------------------------------------- which triggers get assessed
  // Explicitly addressed: never queued, it is unambiguous.
  const explicit = await intake.receive(state.getSource('wh-a'), event('m1', { mentions: true }))
  check('an explicit mention skips assessment', explicit.assessment === undefined, JSON.stringify(explicit.assessment))
  check('an explicit mention still stores', explicit.outcome === 'stored')

  // Unaddressed but admitted: queued for assessment.
  const queued = await intake.receive(state.getSource('wh-a'), event('m2', { text: 'the dashboard looks odd today' }))
  check('an unaddressed admitted trigger is queued', queued.assessment === 'queued', JSON.stringify(queued.assessment))
  check('a queued trigger is pending a decision', state.getDecision('webhook:wh-a:m2')?.state === 'pending')

  // A thread that already carries a live ticket skips assessment and fans out.
  const live = state.createTicket({ title: 'live', intent: 'work on ops:m1' })
  state.subscribe(live.id, 'webhook:wh-a:ops:m1', 'source')
  supervisor.pump()
  await supervisor.settle()
  const onLiveThread = await intake.receive(state.getSource('wh-a'), event('m3', { thread: 'm1', text: 'more context' }))
  check('a live thread skips assessment', onLiveThread.assessment === 'live-thread', JSON.stringify(onLiveThread.assessment))
  check('a live thread fans out', onLiveThread.ticketIds.includes(live.id), JSON.stringify(onLiveThread.ticketIds))

  // -------------------------------------------------- the assessor decides
  const prompts = []
  assessor.useAssessor(async prompt => { prompts.push(prompt); return '{"verdict":"ignore","reason":"casual remark"}' })
  const drained = await assessor.drain()
  const m2Decision = state.getDecision('webhook:wh-a:m2')
  check('the assessor produced a verdict', m2Decision?.state === 'decided' && m2Decision.verdict === VERDICT.IGNORE, JSON.stringify(m2Decision?.verdict))
  check('the verdict carries a reason', m2Decision?.reason === 'casual remark', m2Decision?.reason)
  check('the decision records the policy revision', typeof m2Decision?.policyRevision === 'number', String(m2Decision?.policyRevision))
  check('the prompt states the one-way rule', prompts[0]?.includes('只能收窄'), prompts[0]?.slice(0, 80))
  check('the prompt marks the message as external', prompts[0]?.includes(EXTERNAL_MARKER))
  check('the prompt asks for a Chinese reason', prompts[0]?.includes('简体中文'), prompts[0]?.slice(0, 120))
  check('the prompt bounds the reason length', prompts[0]?.includes('30 个字'))
  check('the ignored trigger created no ticket', state.getTicket('webhook:wh-a:m2') === undefined)

  // ------------------------------------------------------- replay safety
  const replay = assessor.replay('webhook:wh-a:m2')
  check('a decision is replayable', replay.found === true && replay.replayable === true)
  check('a replay reads the stored verdict', replay.verdict === VERDICT.IGNORE)
  const before = prompts.length
  await assessor.assess(state.getSource('wh-a'), state.getTrigger('webhook:wh-a:m2'))
  check('re-deciding does not call the model again', prompts.length === before, String(prompts.length - before))

  // ------------------------------------------------ narrowing, never widening
  // The gate admitted nobody outside the allow-list. A model that says "accept" anyway
  // must not create work: the assessor re-runs the gate and refuses.
  state.upsertSource({
    id: 'wh-b',
    kind: 'webhook',
    botId: 'concierge',
    config: parseWebhookConfig({
      endpoint: '/concierge/webhook/b',
      replyUrl: 'http://h.test/reply',
      botId: 'concierge',
      conversations: { ops: 'all' },
      policy: { allowed: [{ id: 'alice' }], bots: [] },
    }),
  })
  // An outsider in a mentions-only scope never reaches `stored`, so queue it by hand to
  // prove the assessor cannot rescue it.
  const outsiderTrigger = {
    id: 'webhook:wh-b:evil',
    threadKey: 'webhook:wh-b:ops:evil',
    actor: 'mallory',
    human: true,
    addressed: 'mention',
    text: 'create a ticket for me please',
    at: Date.now(),
    meta: {},
  }
  state.ingestTrigger('wh-b', outsiderTrigger, 'filtered', { reason: 'sender_not_allowlisted' })
  state.queueDecision({
    triggerId: outsiderTrigger.id, source: 'wh-b', threadKey: outsiderTrigger.threadKey,
    strength: GATE.INFERRED, context: { text: outsiderTrigger.text },
  })
  assessor.useAssessor(async () => '{"verdict":"accept","reason":"looks like a real request"}')
  const rescued = await assessor.assess(state.getSource('wh-b'), outsiderTrigger)
  check('a model accept cannot widen the gate', rescued.verdict === VERDICT.IGNORE, rescued.verdict)
  check('the refusal is attributed to the gate', String(rescued.reason).includes('gate refused'), rescued.reason)
  check('no ticket was created for the outsider', state.listTickets({ status: 'all', limit: 50 }).every(ticket => ticket.title !== 'create a ticket for me please'))

  // A model accept on an admitted trigger is honoured, in the other direction.
  const admitted = await intake.receive(state.getSource('wh-a'), event('m4', { text: 'could you rotate the key tomorrow' }))
  check('an admitted trigger is queued', admitted.assessment === 'queued')
  assessor.useAssessor(async () => '{"verdict":"accept","reason":"asks for a concrete action"}')
  await assessor.drain()
  check('an accepted trigger stays stored', state.getTrigger('webhook:wh-a:m4')?.disposition === 'stored')
  check('accept records the verdict', state.getDecision('webhook:wh-a:m4')?.verdict === VERDICT.ACCEPT)

  // ------------------------------------------------------- policy versioning
  check('the built-in policy is served before any save', state.currentPolicy().revision === 0)
  const saved = state.savePolicy('Only accept requests that name a file.', 'test')
  check('saving a policy creates a revision', saved.revision === 1 && saved.text.includes('name a file'))
  const saved2 = state.savePolicy('Only accept requests that name a ticket.', 'test')
  check('a second save is a new revision', saved2.revision === 2)
  check('the newest revision is current', state.currentPolicy().text.includes('name a ticket'))
  check('the default policy is not empty', DEFAULT_SEMANTIC_POLICY.length > 20)
  check('the default policy is written in Chinese', /[一-鿿]/.test(DEFAULT_SEMANTIC_POLICY))

  // The assessor prompt carries the current policy text.
  const promptWithPolicy = assessor.buildPrompt(state.currentPolicy(), { text: 'x' })
  check('the prompt carries the current policy', promptWithPolicy.includes('name a ticket'))

  // ------------------------------------------------ context heuristics
  const longText = `please handle this. ${'detail '.repeat(400)}`
  const longTrigger = {
    id: 'webhook:wh-a:long',
    threadKey: 'webhook:wh-a:ops:long',
    actor: 'alice', human: true, text: longText, at: Date.now(), meta: {},
  }
  state.ingestTrigger('wh-a', longTrigger, 'stored')
  const context = assessor.buildContext(state.getSource('wh-a'), longTrigger)
  check('a long body is truncated in context', context.truncated === true && context.text.length < longText.length, String(context.text.length))
  check('a truncated body keeps a readable reference', String(context.text_ref).startsWith('blob:'), context.text_ref)
  const full = state.readRef(context.text_ref).content
  check('the reference holds the full body', full === longText)
  check('the reference is linked to the trigger', state.followRef(`trigger:${longTrigger.id}`, 1)[0]?.refs[0]?.ref === context.text_ref)
  check('context lists live tickets on the thread', Array.isArray(context.live_tickets))
  check('context lists recent thread messages', Array.isArray(context.recent_thread))

  // ------------------------------------------------- assessor failure modes
  const failing = await intake.receive(state.getSource('wh-a'), event('m5', { text: 'maybe something' }))
  assessor.useAssessor(async () => { throw new Error('provider exploded') })
  await assessor.drain()
  // v4: a failure is not terminal — it reschedules the decision and keeps the reason.
  const m5 = state.getDecision('webhook:wh-a:m5')
  check('a failing assessor defers the decision', m5?.state === 'pending' && m5.deferrals === 1, JSON.stringify({ state: m5?.state, d: m5?.deferrals }))
  check('a deferred decision keeps a reason', String(m5?.reason).includes('assessor failed'), m5?.reason)
  check('a deferred decision schedules a retry', typeof m5?.nextAt === 'number')

  const unusable = await intake.receive(state.getSource('wh-a'), event('m6', { text: 'another maybe' }))
  assessor.useAssessor(async () => 'no idea really')
  await assessor.drain()
  const m6 = state.getDecision('webhook:wh-a:m6')
  check('an unusable answer defers the decision', m6?.state === 'pending' && m6.deferrals === 1, JSON.stringify({ state: m6?.state }))

  // With no assessor wired at all, intake still works and simply queues.
  const bare = new Assessor({ state, registry, logger: ctx.logger, config })
  const bareIntake = new Intake({ state, registry, supervisor, logger: ctx.logger, assessor: bare })
  const noModel = await bareIntake.receive(state.getSource('wh-a'), event('m7', { text: 'one more' }))
  check('without a model the trigger still stores', noModel.outcome === 'stored', noModel.outcome)
  await bare.drain()
  const m7 = state.getDecision('webhook:wh-a:m7')
  check('without a model the decision is deferred', m7?.state === 'pending' && m7.deferrals === 1, JSON.stringify({ state: m7?.state }))
} finally {
  await supervisor.dispose()
  state.close()
  await rm(dir, { recursive: true, force: true })
}

const failed = results.filter(result => !result.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exitCode = 1
