#!/usr/bin/env node
/**
 * Manage Source instances: they are rows in concierge.sqlite, not patch entries, because
 * an instance owns a read position and a cursor must survive a restart.
 *
 *   node scripts/source.mjs add --id wh-ops --endpoint /concierge/webhook/ops \
 *        --reply https://example.test/reply --allow alice --allow bob \
 *        --listen ops=all --listen support=mentions [--token SECRET] [--bot concierge]
 *   node scripts/source.mjs list
 *   node scripts/source.mjs show --id wh-ops
 *   node scripts/source.mjs disable --id wh-ops
 *   node scripts/source.mjs enable  --id wh-ops
 *   node scripts/source.mjs remove  --id wh-ops
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import { State } from '../lib/state.js'
import { parseWebhookConfig, persistableConfig } from '../lib/sources/webhook.js'
import { resolveToken, tokenDisplay } from '../lib/secrets.js'

const argv = process.argv.slice(2)
const command = argv[0] ?? 'list'
/**
 * Read `--name value`. A shell that rewrites a leading slash into a Windows path
 * (git-bash does this for `/concierge/webhook/ops`) is repaired here rather than pushing
 * the workaround onto the operator.
 */
const option = name => {
  const at = argv.indexOf(`--${name}`)
  const raw = at >= 0 ? argv[at + 1] : undefined
  if (name === 'endpoint' && process.env.DSH_CONCIERGE_DEBUG === '1') {
    console.error(`[source.mjs] raw --endpoint = ${JSON.stringify(raw)}`)
  }
  return name === 'endpoint' ? repairEndpoint(raw) : raw
}
const options = name => {
  const out = []
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === `--${name}`) out.push(argv[index + 1])
  }
  return out.filter(value => value !== undefined)
}

/**
 * Turn a shell-mangled route back into the path the operator meant.
 *
 * Windows shells rewrite a leading slash: `git-bash` turns `/concierge/webhook/ops` into
 * `C:/concierge/webhook/ops` (or `/c/concierge/webhook/ops`). Since a route never has a
 * drive letter, the drive and any MSYS prefix are stripped and the rest is the route.
 */
function repairEndpoint(value) {
  if (value === undefined) return undefined
  const text = String(value).replace(/\\/g, '/')
  // Drive-letter form: C:/concierge/webhook/ops
  const drive = /^[A-Za-z]:\/(.*)$/.exec(text)
  if (drive) {
    const rest = drive[1]
    // An MSYS install root can appear after the drive: C:/Program Files/Git/concierge/...
    const gitRoot = /^(?:.*\/)?(?:Program Files\/Git|Program Files\/Git\/usr)\/(.+)$/i.exec(rest)
    return `/${(gitRoot ? gitRoot[1] : rest).replace(/^\/+/, '')}`
  }
  // Already a route.
  if (text.startsWith('/') && !/^\/[a-z]\//i.test(text) && !/^\/cygdrive\/[a-z]\//i.test(text)) return text
  // POSIX-mangled form: /c/concierge/webhook/ops
  const mangled = /^\/(?:[a-z]|cygdrive\/[a-z])\/(.+)$/i.exec(text)
  if (mangled) return `/${mangled[1]}`
  return `/${text.replace(/^\/+/, '')}`
}

const stateDir = process.env.DSH_HOME
  ? join(process.env.DSH_HOME, 'dsh-concierge')
  : join(homedir(), '.dsh', 'dsh-concierge')
const state = new State({ dbPath: join(stateDir, 'concierge.sqlite'), inlineChars: 2400 })

try {
  if (command === 'add') {
    const id = option('id')
    if (!id) throw new Error('--id is required')
    const conversations = {}
    for (const entry of options('listen')) {
      const [name, mode] = String(entry).split('=')
      if (!name || (mode !== 'all' && mode !== 'mentions')) throw new Error(`--listen must be name=all or name=mentions, got "${entry}"`)
      conversations[name] = mode
    }
    const tokenFile = option('token-file')
    const tokenEnv = option('token-env')
    const inlineToken = option('token')
    const config = parseWebhookConfig({
      endpoint: option('endpoint'),
      replyUrl: option('reply'),
      ...(tokenFile ? { tokenFile } : {}),
      ...(tokenEnv ? { tokenEnv } : {}),
      ...(inlineToken ? { token: inlineToken } : {}),
      botId: option('bot') ?? 'concierge',
      conversations,
      policy: { allowed: options('allow').map(value => ({ id: value })), bots: options('bot-allow').map(value => ({ id: value })) },
    })
    // Resolve once so a bad file or unset variable fails here, not on the first request.
    const resolved = resolveToken({ tokenFile: config.tokenFile, tokenEnv: config.tokenEnv, token: config.token })
    // Persist the *source* of the token and a fingerprint; never the value.
    const saved = state.upsertSource({
      id,
      kind: 'webhook',
      config: persistableConfig(config),
      botId: config.botId,
      tokenFingerprint: tokenDisplay(resolved.token),
    })
    console.log(JSON.stringify({
      ok: true,
      source: saved,
      token: { configured: Boolean(resolved.token), source: resolved.source, fingerprint: tokenDisplay(resolved.token) },
    }, null, 2))
  } else if (command === 'list') {
    console.log(JSON.stringify(state.listSources(), null, 2))
  } else if (command === 'show') {
    const source = state.getSource(option('id'))
    if (!source) throw new Error(`no source "${option('id')}"`)
    console.log(JSON.stringify({
      source,
      subscriptions: state.subscriptionsOf(option('id')),
      triggers: state.listTriggers({ source: option('id'), limit: 10 }),
    }, null, 2))
  } else if (command === 'enable' || command === 'disable') {
    const id = option('id')
    const source = state.getSource(id)
    if (!source) throw new Error(`no source "${id}"`)
    state.upsertSource({ id, kind: source.kind, enabled: command === 'enable', config: source.config, botId: source.botId })
    console.log(JSON.stringify({ ok: true, id, enabled: command === 'enable' }))
  } else if (command === 'remove') {
    const id = option('id')
    state.tx(() => {
      state.db.prepare('DELETE FROM subscription WHERE thread_key LIKE ?').run(`webhook:${id}:%`)
      state.db.prepare('DELETE FROM source WHERE id = ?').run(id)
      state.log('source/removed', null, id)
    })
    console.log(JSON.stringify({ ok: true, removed: id }))
  } else {
    throw new Error(`unknown command "${command}"; use add, list, show, enable, disable or remove`)
  }
} finally {
  state.close()
}
