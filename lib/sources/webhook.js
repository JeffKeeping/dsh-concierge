/**
 * The webhook Source: the reference cookbook's recipe implemented against this plugin.
 *
 * Inbound: `POST <endpoint>` carries one event. It becomes a Trigger whose id is derived
 * from the event's own id, so redelivery is idempotent. The cursor is the event's `seq`
 * when the sender supplies one, so an interrupted round replays instead of skipping.
 *
 * Outbound: replies are `POST <replyUrl>` with the message id as the idempotency key. A
 * 410 (or any 4xx that states the destination is gone) is permanent; everything else is
 * retryable and throws so the Channel backs off.
 *
 * Configuration (stored per instance, validated here — never through a model):
 *   {
 *     endpoint: '/concierge/webhook/<instance>',   // route path this instance answers
 *     replyUrl: 'https://example.test/reply',      // where replies are POSTed
 *     tokenFile: '/run/secrets/webhook-token',     // preferred: read at request time
 *     tokenEnv: 'CONCIERGE_WEBHOOK_TOKEN',         // alternative
 *     botId: 'concierge',                          // this Source's own identity
 *     policy: { allowed: [{id, name?}], bots: [{id}] },
 *     conversations: { '<conversation>': 'mentions'|'all' },
 *   }
 *
 * The token value itself is never stored: SQLite keeps a fingerprint (see `secrets.js`),
 * and the value is read from its file or variable when a request is authenticated.
 */
import { resolveToken, tokenMatches } from '../secrets.js'

/** Validate instance configuration. Throws with a specific reason, never coerces. */
export function parseWebhookConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const endpoint = String(input.endpoint ?? '').trim()
  if (!endpoint.startsWith('/')) throw new Error('webhook config: endpoint must be an absolute path, for example /concierge/webhook/ops')
  const replyUrl = String(input.replyUrl ?? '').trim()
  if (replyUrl === '') throw new Error('webhook config: replyUrl is required')
  let parsed
  try { parsed = new URL(replyUrl) } catch { throw new Error(`webhook config: replyUrl "${replyUrl}" is not a URL`) }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('webhook config: replyUrl must be http(s)')

  const policy = input.policy && typeof input.policy === 'object' ? input.policy : {}
  const allowed = Array.isArray(policy.allowed)
    ? policy.allowed.map(entry => ({ id: String(entry?.id ?? '').trim(), ...(entry?.name ? { name: String(entry.name) } : {}) })).filter(entry => entry.id !== '')
    : []
  const bots = Array.isArray(policy.bots)
    ? policy.bots.map(entry => ({ id: String(entry?.id ?? '').trim() })).filter(entry => entry.id !== '')
    : []

  const conversations = {}
  if (input.conversations && typeof input.conversations === 'object') {
    for (const [key, value] of Object.entries(input.conversations)) {
      if (value === 'mentions' || value === 'all') conversations[String(key)] = value
    }
  }

  // Token material: only the *source* is persisted. A plain `token` is accepted for a
  // one-off bootstrap and is never written to SQLite; `persistableConfig` strips it.
  const tokenFile = typeof input.tokenFile === 'string' && input.tokenFile !== '' ? input.tokenFile : undefined
  const tokenEnv = typeof input.tokenEnv === 'string' && input.tokenEnv !== '' ? input.tokenEnv : undefined
  const inlineToken = typeof input.token === 'string' && input.token !== '' ? input.token : undefined

  return {
    endpoint,
    replyUrl: parsed.toString(),
    ...(tokenFile ? { tokenFile } : {}),
    ...(tokenEnv ? { tokenEnv } : {}),
    ...(inlineToken ? { token: inlineToken } : {}),
    hasToken: Boolean(tokenFile || tokenEnv || inlineToken),
    botId: String(input.botId ?? 'concierge'),
    policy: { allowed, bots },
    conversations,
    // How long a send may take before it counts as a retryable failure.
    sendTimeoutMs: Number.isFinite(input.sendTimeoutMs) ? Math.max(1_000, input.sendTimeoutMs) : 10_000,
  }
}

/** The subset of a config that may be persisted: no secret value ever reaches this. */
export function persistableConfig(config) {
  const { token, ...rest } = config ?? {}
  return rest
}

/**
 * Translate one inbound webhook event into a Trigger, following cookbook step 3.
 * Stable ids, the Thread, the actor, `human`, `addressed`, and the reply Channel.
 */
export function webhookTrigger(event, { config, instance }) {
  const message = normalizeEvent(event)
  if (!message) return undefined
  // The Source's own messages are dropped by `isOwn`, not here: Intake must be able to
  // record *why* nothing entered the domain, and "own message" is a different reason from
  // "unmodellable event".

  const thread = `${message.conversation}:${message.thread ?? message.id}`
  const addressed = message.mentions === true ? 'mention' : message.addressed === true ? 'direct' : undefined
  return {
    id: `webhook:${instance.id}:${message.id}`,
    threadKey: `webhook:${instance.id}:${thread}`,
    actor: message.sender,
    human: message.bot !== true,
    ...(addressed ? { addressed } : {}),
    text: message.text,
    at: Number.isFinite(message.at) ? message.at : Date.now(),
    url: message.url,
    channel: {
      source: 'webhook',
      thread: `webhook:${instance.id}:${thread}`,
      // Every fact a later `allowed()` check needs travels in the address.
      address: { conversation: message.conversation, message: message.id, instance: instance.id, ...(message.url ? { url: message.url } : {}) },
    },
    // Untrusted source data. Never consulted by the gate.
    meta: {
      instance: instance.id,
      conversation: message.conversation,
      messageId: message.id,
      root: message.thread ?? message.id,
      seq: message.seq,
    },
  }
}

/** One inbound event, or undefined when it cannot be modelled. */
function normalizeEvent(event) {
  if (!event || typeof event !== 'object') return undefined
  const id = String(event.id ?? event.event_id ?? '').trim()
  const conversation = String(event.conversation ?? event.channel ?? '').trim()
  const sender = String(event.sender ?? event.from ?? '').trim()
  const text = typeof event.text === 'string' ? event.text : ''
  if (id === '' || conversation === '' || sender === '') return undefined
  return {
    id,
    conversation,
    sender,
    text,
    thread: typeof event.thread === 'string' && event.thread !== '' ? event.thread : undefined,
    bot: event.bot === true,
    mentions: event.mentions === true,
    addressed: event.addressed === true,
    at: typeof event.at === 'number' ? event.at : typeof event.at === 'string' ? Date.parse(event.at) : undefined,
    url: typeof event.url === 'string' && event.url !== '' ? event.url : undefined,
    seq: event.seq === undefined ? undefined : String(event.seq),
  }
}

/** The webhook Source kind, as `SourceRegistry` consumes it. */
export const webhookKind = {
  kind: 'webhook',
  title: 'Webhook',
  parseConfig: parseWebhookConfig,

  /** Cookbook step 4: what this instance receives, decided from meta and configuration. */
  scope(trigger, config) {
    const conversation = config.conversations?.[trigger.meta?.conversation]
    if (conversation === undefined) return { listened: false, reason: 'conversation_not_listed' }
    return {
      listened: true,
      // 'all' means unaddressed messages are observed too, which is what lets the
      // admission table admit them.
      observed: conversation === 'all',
      row: trigger.meta?.conversation,
    }
  },

  /** Whether this event came from the instance's own bot identity. */
  isOwn(trigger, config) {
    return trigger.actor !== undefined && trigger.actor === config.botId
  },

  /** Whether one inbound event carries the configured credential. */
  authorizes(event, config) {
    // Credentials are declared by the *instance configuration*, never by the request. An
    // instance with no token source is deliberately open; one with a token fails closed.
    const declared = Boolean(config?.tokenFile || config?.tokenEnv || config?.token)
    if (!declared) return true
    let expected
    try {
      expected = resolveToken({ tokenFile: config.tokenFile, tokenEnv: config.tokenEnv, token: config.token }).token
    } catch {
      // An unreadable token source must fail closed, not open.
      return false
    }
    if (!expected) return false
    const presented = event && typeof event === 'object' ? (event.token ?? event.authorization) : undefined
    return tokenMatches(presented, expected)
  },

  /** Cookbook step 5: the Channel. */
  channel: {
    allowed(address, config) {
      return typeof address?.conversation === 'string' && config.conversations?.[address.conversation] !== undefined
    },
    /**
     * POST one reply. `host.resolve(instanceId)` gives the destination at send time, so a
     * configuration change takes effect without re-queueing anything.
     */
    async send(host, message) {
      const instance = host?.resolve?.(message.channel) ?? host?.instance
      const config = instance?.config ?? host?.config
      const url = config?.replyUrl
      if (!url) throw new Error('webhook channel: no replyUrl configured for this instance')
      const timeoutMs = config?.sendTimeoutMs ?? 10_000
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      timer.unref?.()
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': message.id },
          body: JSON.stringify({
            key: message.id,
            conversation: message.address?.conversation,
            reply_to: message.address?.message,
            ticket_id: message.ticketId,
            text: message.text,
          }),
          signal: controller.signal,
        })
        // A deleted conversation or revoked chat can never receive the message.
        if (response.status === 410) return 'gone'
        if (!response.ok) throw new Error(`webhook reply failed with HTTP ${response.status}`)
        return 'sent'
      } finally {
        clearTimeout(timer)
      }
    },
    threadKeyOf(trigger) {
      return trigger.channel?.thread ?? trigger.threadKey
    },
  },

  /** Translation entry, so Intake works the same for every kind. */
  translate(event, context) {
    return webhookTrigger(event, context)
  },
}
