/**
 * The webhook route, exercised over real HTTP.
 *
 * The point of this file is that it drives the route the plugin actually registers, with a
 * real server and real requests, so a mistake between the route and the kind's
 * `authorizes` cannot hide behind a unit stub.
 *
 * Run: node test/route.mjs
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { State } from '../lib/state.js'
import { SourceRegistry } from '../lib/sources/kind.js'
import { webhookKind, parseWebhookConfig } from '../lib/sources/webhook.js'
import { registerWebhookRoutes } from '../lib/sources/route.js'

const results = []
function check(name, condition, detail = undefined) {
  results.push({ name, pass: Boolean(condition), detail })
  if (!condition) console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  else console.log(`ok    ${name}`)
}

const dir = await mkdtemp(join(tmpdir(), 'concierge-route-'))
const tokenFile = join(dir, 'token')
await writeFile(tokenFile, 'route-secret\n', 'utf8')

const state = new State({ dbPath: join(dir, 'r.sqlite'), inlineChars: 2000 })
const registry = new SourceRegistry()
registry.register(webhookKind)
const received = []
const intake = {
  async receiveBatch(instance, events) {
    received.push({ instance: instance.id, event: events[0] })
    return { outcomes: [{ outcome: 'stored', triggerId: `t:${events[0]?.id}`, ticketIds: [] }], committed: true, cursor: events[0]?.seq }
  },
}

state.upsertSource({
  id: 'wh-route', kind: 'webhook', botId: 'concierge',
  config: persistable(parseWebhookConfig({
    endpoint: '/concierge/webhook/route',
    replyUrl: 'http://127.0.0.1:9/reply',
    tokenFile,
    conversations: { ops: 'all' },
    policy: { allowed: [{ id: 'alice' }], bots: [] },
  })),
})
state.upsertSource({
  id: 'wh-open', kind: 'webhook', botId: 'concierge',
  config: persistable(parseWebhookConfig({
    endpoint: '/concierge/webhook/open',
    replyUrl: 'http://127.0.0.1:9/reply',
    conversations: { ops: 'all' },
    policy: { allowed: [{ id: 'alice' }], bots: [] },
  })),
})

function persistable(config) {
  const { token, ...rest } = config
  return rest
}

// A tiny stand-in for the Host's web server: same registration contract, real HTTP.
const routes = new Map()
const server = createServer(async (req, res) => {
  const path = req.url?.split('?')[0] ?? ''
  const route = [...routes.entries()].find(([prefix]) => path.startsWith(prefix))
  if (!route) { res.writeHead(404).end('{}'); return }
  await route[1](req, res)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const webServer = {
  register(route) {
    routes.set(route.path, route.handler)
    return () => routes.delete(route.path)
  },
}

const routesHandle = registerWebhookRoutes({ ctx: { webServer }, state, intake, logger: { warn() {} }, registry })

const post = async (path, body) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}

try {
  // -------------------------------------------------- a guarded instance
  const wrong = await post('/concierge/webhook/route', { id: 'e1', token: 'nope', conversation: 'ops', sender: 'alice' })
  check('a wrong token is refused with 401', wrong.status === 401, String(wrong.status))
  check('a refused request never reaches intake', received.length === 0, String(received.length))

  const noToken = await post('/concierge/webhook/route', { id: 'e2', conversation: 'ops', sender: 'alice' })
  check('a missing token is refused with 401', noToken.status === 401, String(noToken.status))

  const good = await post('/concierge/webhook/route', { id: 'e3', token: 'route-secret', conversation: 'ops', sender: 'alice', seq: '7' })
  check('the right token is accepted', good.status === 202, String(good.status))
  check('an accepted request reaches intake', received.length === 1, String(received.length))
  check('the cursor is reported back', good.body.cursor === '7', String(good.body.cursor))

  // ---------------------------------------------------- an open instance
  const open = await post('/concierge/webhook/open', { id: 'e4', conversation: 'ops', sender: 'alice' })
  check('an instance with no token accepts requests', open.status === 202, String(open.status))

  // ------------------------------------------------------- shape of the route
  const get = await fetch(`http://127.0.0.1:${port}/concierge/webhook/route`)
  check('a non-POST method is refused', get.status === 405, String(get.status))
  const unknown = await post('/concierge/webhook/absent', { id: 'e5' })
  check('an unregistered path is a 404', unknown.status === 404, String(unknown.status))

  // A bad body is a client error, not a crash.
  const badBody = await fetch(`http://127.0.0.1:${port}/concierge/webhook/route`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  })
  check('a malformed body is a 400', badBody.status === 400, String(badBody.status))
} finally {
  routesHandle.dispose()
  state.close()
  await new Promise(resolve => server.close(resolve))
  await rm(dir, { recursive: true, force: true })
}

const failed = results.filter(result => !result.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exitCode = 1
