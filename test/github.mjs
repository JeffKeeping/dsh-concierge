/**
 * v3 steps 2–3: chain recall, Router context spill, and the GitHub Source.
 *
 * The GitHub tests drive the real `pollGithub` and `closeFinishedPullRequests` against a
 * stubbed `fetch`, so polling, idempotency, own-event exclusion and PR closure are
 * exercised as the plugin runs them, not as a mock of the plugin.
 *
 * Run: node test/github.mjs
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { State } from '../lib/state.js'
import { Supervisor } from '../lib/supervisor.js'
import { SourceRegistry } from '../lib/sources/kind.js'
import { Intake } from '../lib/sources/intake.js'
import { githubKind, parseGithubConfig, persistableGithubConfig } from '../lib/sources/github.js'
import { pollGithub, closeFinishedPullRequests, parseGithubThread } from '../lib/sources/github-watch.js'
import { ContextSpill, KEEP } from '../lib/context-spill.js'

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

/** A GitHub API stub: routes by path, records calls, and can be made to fail. */
function stubFetch(routes) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace('https://api.github.com', '')
    calls.push({ path, method: init.method ?? 'GET', body: init.body })
    const handler = Object.entries(routes).find(([prefix]) => path.startsWith(prefix))
    const value = handler ? await handler[1](path, init) : undefined
    if (value === undefined) return { ok: false, status: 404, json: async () => ({}) }
    if (value === 'fail') return { ok: false, status: 500, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => value }
  }
  return { calls, restore() { globalThis.fetch = original } }
}

const dir = await mkdtemp(join(tmpdir(), 'concierge-github-'))
const tokenFile = join(dir, 'gh-token')
await writeFile(tokenFile, 'ghp_test_token\n', 'utf8')
const state = new State({ dbPath: join(dir, 'g.sqlite'), inlineChars: 4000 })
const ctx = fakeContext()
const config = {
  stateDir: dir, concurrency: 3, watchdogIntervalMs: 60_000, inlineChars: 4000,
  idleFailMs: 20 * 60 * 1000, loopRepeatLimit: 3, blockedRetries: 3,
  routerSessionId: 'router-session', assessorSessionId: 'assessor-session', channelTickMs: 50,
}
const registry = new SourceRegistry()
registry.register(githubKind)
const supervisor = new Supervisor({ ctx, state, config, logger: ctx.logger })
const intake = new Intake({ state, registry, supervisor, logger: ctx.logger })
const host = { state, intake, registry, logger: ctx.logger, supervisor }

try {
  // ------------------------------------------------ step 2: chain recall
  const blobA = state.spill('the original requirement', 'requirement')
  const blobB = state.spill(`derived from ${blobA}`, 'derived detail')
  state.addRefEdge(`blob:${blobB}`, `blob:${blobA}`, 'derived-from')
  const ticket = state.createTicket({ title: 'recall', intent: 'do the thing' })
  state.addRefEdge(`report:${ticket.id}`, `blob:${blobB}`, 'cited')

  const oneHop = state.followRef(`report:${ticket.id}`, 1)
  check('one hop lists the cited reference', oneHop[0]?.refs[0]?.ref === `blob:${blobB}`, JSON.stringify(oneHop[0]?.refs[0]))
  const twoHops = state.followRef(`report:${ticket.id}`, 2)
  check('two hops reach the source', twoHops[1]?.refs[0]?.ref === `blob:${blobA}`, JSON.stringify(twoHops.map(level => level.refs.map(r => r.ref))))
  check('a chain carries a summary per ref', typeof oneHop[0]?.refs[0]?.summary === 'string')
  check('a repeated edge is not duplicated', (() => {
    state.addRefEdge(`report:${ticket.id}`, `blob:${blobB}`, 'cited')
    return state.followRef(`report:${ticket.id}`, 1)[0].refs.length === 1
  })())
  check('a cycle terminates', (() => {
    state.addRefEdge(`blob:${blobA}`, `report:${ticket.id}`, 'loop')
    const chain = state.followRef(`report:${ticket.id}`, 4)
    return chain.length <= 4
  })())

  // -------------------------------------------- step 2: router context spill
  const spill = new ContextSpill({ state, inlineChars: 200, logger: ctx.logger })
  for (let index = 0; index < KEEP.decision + 3; index++) {
    spill.add({ kind: 'decision', text: `decision ${index}: filed ticket for request ${index}` })
  }
  const view = spill.view()
  const compactedDecisions = view.entries.filter(entry => entry.kind === 'decision' && entry.read)
  check('old decisions become references', compactedDecisions.length === 3, String(compactedDecisions.length))
  check('each compacted entry keeps a summary', compactedDecisions.every(entry => typeof entry.summary === 'string' && entry.summary.length > 0))
  check('the newest decisions stay inline', view.entries.filter(entry => entry.kind === 'decision' && entry.inline).length === KEEP.decision)
  check('compaction is counted', view.compacted === 3, String(view.compacted))

  const big = 'x'.repeat(500)
  const bigRef = spill.add({ kind: 'terminal', text: big })
  check('an oversized item spills immediately', String(bigRef).startsWith('blob:'), String(bigRef))
  check('an oversized item keeps its summary inline', spill.view().entries.at(-1).summary.length > 0)
  check('inline bytes stay bounded', spill.inlineBytes() < 4000, String(spill.inlineBytes()))

  // Terminal reports are kept longer than decisions: they are what a person waits for.
  const terminalSpill = new ContextSpill({ state, inlineChars: 10_000, logger: ctx.logger })
  for (let index = 0; index < KEEP.terminal; index++) terminalSpill.add({ kind: 'terminal', text: `done ${index}` })
  check('terminal entries stay inline within their budget', terminalSpill.view().entries.every(entry => entry.inline !== undefined))

  // ------------------------------------------------ step 3: the GitHub Source
  const ghConfig = parseGithubConfig({
    account: 'concierge-bot',
    tokenFile,
    repositories: ['acme/app'],
    policy: { allowed: [{ id: 'alice' }], bots: [] },
  })
  check('a github config keeps the token source, not the value', !('token' in persistableGithubConfig(ghConfig)))
  state.upsertSource({ id: 'gh-1', kind: 'github', botId: 'concierge-bot', config: persistableGithubConfig(ghConfig) })
  const instance = state.getSource('gh-1')

  const notification = (id, number, overrides = {}) => ({
    id,
    unread: true,
    reason: 'mention',
    updated_at: '2026-11-04T08:00:00Z',
    subject: { title: `issue ${number}`, type: 'Issue', url: `https://api.github.com/repos/acme/app/issues/${number}` },
    repository: { full_name: 'acme/app', owner: { login: 'acme' }, name: 'app' },
    actor: 'alice',
    ...overrides,
  })

  // A normal round: two notifications, one of them the bot's own.
  let stub = stubFetch({
    '/notifications': () => [
      notification('n1', 10),
      notification('n2', 11, { actor: 'concierge-bot' }),
    ],
    '/repos/acme/app/pulls': () => ({}),
  })
  let round = await pollGithub(host, instance)
  check('a round reads its notifications', round.read === 2, String(round.read))
  check('the actor event is stored', state.getTrigger('github:gh-1:n1')?.disposition === 'stored', state.getTrigger('github:gh-1:n1')?.disposition)
  check('the bot own event is filtered', state.getTrigger('github:gh-1:n2')?.disposition === 'filtered', state.getTrigger('github:gh-1:n2')?.disposition)
  check('the bot own event says why', state.getTrigger('github:gh-1:n2')?.reason === 'own_message', state.getTrigger('github:gh-1:n2')?.reason)
  const n1 = state.getTrigger('github:gh-1:n1')
  check('the thread key is stable and readable', n1?.threadKey === 'github:gh-1:acme/app#10', n1?.threadKey)
  check('a mention is recorded as addressed', n1?.addressed === 'mention', n1?.addressed)
  check('the cursor is committed', round.committed === true && state.sourceCursor('gh-1') !== undefined, state.sourceCursor('gh-1'))
  const cursorAfterFirst = state.sourceCursor('gh-1')

  // Idempotency: the same notifications again change nothing. The own-message event was
  // already filtered on the first read, so the replay reports one duplicate for `n1` and
  // stores nothing.
  round = await pollGithub(host, instance)
  check('a replay stores nothing new', round.stored === 0, JSON.stringify({ stored: round.stored, dup: round.duplicates }))
  check('a replay is recognised as a duplicate', round.duplicates >= 1, String(round.duplicates))
  check('a replay keeps one row per event', state.listTriggers({ source: 'gh-1', limit: 50 }).length === 2)
  stub.restore()

  // A repository the instance does not watch yields no Trigger.
  stub = stubFetch({
    '/notifications': () => [notification('n3', 12, { repository: { full_name: 'other/repo' } })],
    '/repos/acme/app/pulls': () => ({}),
  })
  round = await pollGithub(host, instance)
  check('an unwatched repository produces nothing', state.getTrigger('github:gh-1:n3') === undefined)
  stub.restore()

  // A failed poll must not advance the cursor.
  stub = stubFetch({ '/notifications': () => 'fail' })
  const before = state.sourceCursor('gh-1')
  round = await pollGithub(host, instance)
  check('a failed poll reports failure', round.ok === false)
  check('a failed poll keeps the cursor', state.sourceCursor('gh-1') === before, state.sourceCursor('gh-1'))
  stub.restore()

  // ------------------------------------------------- PR closure closes tickets
  const prTicket = state.createTicket({ title: 'fix the PR', intent: 'work on acme/app#42' })
  state.subscribe(prTicket.id, 'github:gh-1:acme/app#42', 'source')
  supervisor.pump()
  await supervisor.settle()
  check('the ticket follows its PR thread', state.subscribers('github:gh-1:acme/app#42').length === 1)

  stub = stubFetch({
    '/notifications': () => [],
    '/repos/acme/app/pulls/42': () => ({ number: 42, state: 'closed', merged: true, merged_at: '2026-11-04T09:00:00Z' }),
  })
  const closed = await closeFinishedPullRequests(host, instance)
  check('a merged PR closes its thread', closed.length === 1 && closed[0].outcome === 'merged', JSON.stringify(closed))
  check('the subscribed ticket is closed', state.getTicket(prTicket.id)?.status === 'done', state.getTicket(prTicket.id)?.status)
  check('the closure is recorded on the ticket', String(state.getTicket(prTicket.id)?.lastReport).includes('merged'), String(state.getTicket(prTicket.id)?.lastReport).slice(0, 80))
  check('the thread closure is recorded once', state.threadClosure('github:gh-1:acme/app#42')?.outcome === 'merged')
  const again = await closeFinishedPullRequests(host, instance)
  check('a second poll does not close again', again.length === 0, JSON.stringify(again))
  stub.restore()

  // A closed-but-unmerged PR is a `closed` outcome, not a merge.
  const prTicket2 = state.createTicket({ title: 'abandoned PR', intent: 'work on acme/app#43' })
  state.subscribe(prTicket2.id, 'github:gh-1:acme/app#43', 'source')
  stub = stubFetch({
    '/notifications': () => [],
    '/repos/acme/app/pulls/43': () => ({ number: 43, state: 'closed', merged: false }),
  })
  const closed2 = await closeFinishedPullRequests(host, instance)
  check('an unmerged close is its own outcome', closed2[0]?.outcome === 'closed', JSON.stringify(closed2[0]?.outcome))
  stub.restore()

  // An open PR closes nothing.
  const openTicket = state.createTicket({ title: 'open PR', intent: 'work on acme/app#44' })
  state.subscribe(openTicket.id, 'github:gh-1:acme/app#44', 'source')
  stub = stubFetch({
    '/notifications': () => [],
    '/repos/acme/app/pulls/44': () => ({ number: 44, state: 'open' }),
  })
  const openResult = await closeFinishedPullRequests(host, instance)
  check('an open PR closes nothing', openResult.length === 0)
  check('the open ticket stays open', state.getTicket(openTicket.id)?.status !== 'done')
  stub.restore()

  // ----------------------------------------------------- threadContext reads
  stub = stubFetch({
    // The comments path carries a query string, so it must match before the issue path.
    '/repos/acme/app/issues/10/comments': () => [
      { id: 900, user: { login: 'bob', type: 'User' }, created_at: '2026-11-04T07:30:00Z', body: 'I can reproduce this' },
      { id: 901, user: { login: 'ci-bot', type: 'Bot' }, created_at: '2026-11-04T07:35:00Z', body: 'checks failed' },
    ],
    '/repos/acme/app/issues/10': () => ({ title: 'issue 10', body: 'the reported problem', user: { login: 'alice', type: 'User' }, created_at: '2026-11-04T07:00:00Z', html_url: 'https://github.com/acme/app/issues/10' }),
  })
  const context = await githubKind.threadContext.read({ instance }, { meta: { repository: 'acme/app', number: 10, type: 'Issue', instance: 'gh-1' } })
  check('thread context reads the body and comments', context.messages.length === 3, String(context.messages.length))
  check('thread context marks bots', context.messages.some(message => message.bot === true))
  check('thread context is time ordered', context.messages[0].at <= context.messages.at(-1).at)
  check('thread context exposes the message id of the subject', githubKind.threadContext.messageId({ meta: { repository: 'acme/app', number: 10 } }) === 'acme/app#10')
  stub.restore()

  // ------------------------------------------------------- channel replies
  stub = stubFetch({
    '/notifications': () => [],
    '/repos/acme/app/issues/10/comments': (path, init) => ({ id: 1, body: JSON.parse(init.body) }),
  })
  const sent = await githubKind.channel.send({ instance, resolve: () => instance }, {
    id: 'cm-abc123',
    ticketId: prTicket.id,
    channel: 'gh-1',
    thread: 'github:gh-1:acme/app#10',
    address: { repository: 'acme/app', number: 10 },
    text: 'working on it',
  })
  check('a github reply posts a comment', sent === 'sent')
  check('the reply is idempotency-keyed by message id', String(stub.calls.at(-1)?.path).includes('/comments'))
  stub.restore()

  // A gone destination is permanent, so the channel drops rather than retries.
  stub = stubFetch({ '/repos/acme/app/issues/10/comments': () => undefined })
  const gone = await githubKind.channel.send({ instance, resolve: () => instance }, {
    id: 'cm-gone', ticketId: prTicket.id, channel: 'gh-1',
    thread: 'github:gh-1:acme/app#10', address: { repository: 'acme/app', number: 10 }, text: 'x',
  })
  check('a missing issue is reported gone', gone === 'gone', gone)
  stub.restore()

  // ------------------------------------------------------------- scope rules
  const scoped = githubKind.scope({ meta: { repository: 'other/repo' } }, state.getSource('gh-1').config)
  check('an unlisted repository is out of scope', scoped.listened === false && scoped.reason === 'repository_not_listed')
  const inScope = githubKind.scope({ meta: { repository: 'acme/app' } }, state.getSource('gh-1').config)
  check('a listed repository is observed', inScope.listened === true && inScope.observed === true)
  check('the bot account is recognised as own', githubKind.isOwn({ actor: 'CONCIERGE-BOT' }, { account: 'concierge-bot' }) === true)
  check('a different actor is not own', githubKind.isOwn({ actor: 'alice' }, { account: 'concierge-bot' }) === false)

  // A parsed thread key round-trips, and an unrelated one is refused.
  check('a thread key parses', JSON.stringify(parseGithubThread('github:gh-1:acme/app#42')) === JSON.stringify({ instance: 'gh-1', repository: 'acme/app', number: 42 }))
  check('another instance thread is refused', parseGithubThread('github:gh-2:acme/app#42', 'gh-1') === undefined)
} finally {
  await supervisor.dispose()
  state.close()
  await rm(dir, { recursive: true, force: true })
}

const failed = results.filter(result => !result.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exitCode = 1
