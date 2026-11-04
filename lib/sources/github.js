/**
 * The GitHub Source, following `lib/sources/kind.js`.
 *
 * Events come from two places, both polled:
 *
 *   notifications   the account's own notification list — one Thread per (repo, number)
 *   subscribed PRs  every pull request a live Ticket follows, so a merge or close is seen
 *                   even when notifications are quiet
 *
 * Mapping onto the domain:
 *
 *   Trigger   one notification, or one PR state change
 *   Thread    `github:<instance>:<owner>/<name>#<number>`
 *   Actor     the login that produced the event, as the allow-list names it
 *   Channel   the issue or pull-request comment endpoint, keyed by the reply's message id
 *
 * The agent's own account never produces a Trigger (`isOwn`), which is what stops a reply
 * posted by the agent from re-entering as new work.
 *
 * Credentials follow `lib/secrets.js`: the token is read from a file or the environment at
 * request time and is never stored.
 */
import { resolveToken } from '../secrets.js'

const API = 'https://api.github.com'

/** Validate instance configuration. Throws with a specific reason. */
export function parseGithubConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const account = String(input.account ?? '').trim()
  if (account === '') throw new Error('github config: account is required')
  const tokenFile = typeof input.tokenFile === 'string' && input.tokenFile !== '' ? input.tokenFile : undefined
  const tokenEnv = typeof input.tokenEnv === 'string' && input.tokenEnv !== '' ? input.tokenEnv : undefined
  const inlineToken = typeof input.token === 'string' && input.token !== '' ? input.token : undefined
  if (!tokenFile && !tokenEnv && !inlineToken) throw new Error('github config: tokenFile, tokenEnv or token is required')

  const policy = input.policy && typeof input.policy === 'object' ? input.policy : {}
  const allowed = Array.isArray(policy.allowed)
    ? policy.allowed.map(entry => ({ id: String(entry?.id ?? '').trim() })).filter(entry => entry.id !== '')
    : []
  const bots = Array.isArray(policy.bots)
    ? policy.bots.map(entry => ({ id: String(entry?.id ?? '').trim() })).filter(entry => entry.id !== '')
    : []

  const repositories = Array.isArray(input.repositories)
    ? input.repositories.map(value => String(value).trim()).filter(value => /^[\w.-]+\/[\w.-]+$/.test(value))
    : []

  return {
    account,
    ...(tokenFile ? { tokenFile } : {}),
    ...(tokenEnv ? { tokenEnv } : {}),
    ...(inlineToken ? { token: inlineToken } : {}),
    hasToken: true,
    repositories,
    // Which notification reasons this instance receives. `mention` and `review_requested`
    // address the agent; the rest are ambient and go to assessment.
    reasons: Array.isArray(input.reasons) && input.reasons.length > 0
      ? input.reasons.map(value => String(value))
      : ['mention', 'review_requested', 'assign', 'comment', 'subscribed', 'state_change'],
    policy: { allowed, bots },
    pollSeconds: Number.isFinite(input.pollSeconds) ? Math.min(3600, Math.max(15, input.pollSeconds)) : 60,
    apiBase: typeof input.apiBase === 'string' && input.apiBase !== '' ? input.apiBase.replace(/\/+$/, '') : API,
    sendTimeoutMs: Number.isFinite(input.sendTimeoutMs) ? Math.max(1_000, input.sendTimeoutMs) : 15_000,
  }
}

/** The config subset that may be persisted: never the secret value. */
export function persistableGithubConfig(config) {
  const { token, ...rest } = config ?? {}
  return rest
}

/** The Thread key for one repository issue or pull request. */
export function githubThreadKey(instanceId, repository, number) {
  return `github:${instanceId}:${repository}#${number}`
}

/** The pull request an event is about, when it is about one. */
export function pullRequestOf(event) {
  const subject = event?.subject ?? {}
  if (subject.type === 'PullRequest') return Number(subject.url?.split('/').pop())
  return undefined
}

/**
 * Translate one notification into a Trigger.
 *
 * A notification carries a `subject` (title, type, url) rather than a message body: the
 * body is read on demand by `threadContext`, so a Trigger stays small.
 */
export function githubTriggerFromNotification(notification, { config, instance }) {
  if (!notification || typeof notification !== 'object') return undefined
  const id = String(notification.id ?? '').trim()
  const repository = String(notification.repository?.full_name ?? '').trim()
  if (id === '' || repository === '') return undefined
  if (config.repositories.length > 0 && !config.repositories.includes(repository)) return undefined

  const subject = notification.subject ?? {}
  const number = Number(subject.url?.split('/').pop() ?? 0)
  const reason = String(notification.reason ?? 'subscribed')
  if (!config.reasons.includes(reason)) return undefined

  const addressed = reason === 'mention' ? 'mention' : reason === 'review_requested' ? 'direct' : undefined
  const threadKey = githubThreadKey(instance.id, repository, number || id)
  return {
    id: `github:${instance.id}:${id}`,
    threadKey,
    actor: String(notification.actor ?? ''),
    human: true,
    ...(addressed ? { addressed } : {}),
    text: String(subject.title ?? ''),
    at: Date.parse(notification.updated_at ?? '') || Date.now(),
    url: subject.url,
    channel: {
      source: 'github',
      thread: threadKey,
      address: { repository, number, kind: subject.type ?? 'Issue', instance: instance.id },
    },
    meta: {
      instance: instance.id,
      repository,
      number,
      type: subject.type ?? 'Issue',
      reason,
      notificationId: id,
      unread: notification.unread === true,
    },
  }
}

/** Translate one pull-request state observation into a Thread-close fact. */
export function githubPrFact(pullRequest, repository) {
  if (!pullRequest || typeof pullRequest !== 'object') return undefined
  const number = Number(pullRequest.number ?? 0)
  if (number === 0) return undefined
  const state = String(pullRequest.state ?? 'open')
  if (state === 'open') return undefined
  return {
    repository,
    number,
    outcome: pullRequest.merged === true || pullRequest.merged_at ? 'merged' : 'closed',
    at: Date.parse(pullRequest.closed_at ?? pullRequest.updated_at ?? '') || Date.now(),
  }
}

/** An HTTP client bound to one instance's credentials, read fresh on every call. */
export function githubClient(config) {
  const token = () => resolveToken({ tokenFile: config.tokenFile, tokenEnv: config.tokenEnv, token: config.token }).token
  const call = async (path, init = {}) => {
    const secret = token()
    if (!secret) throw new Error('github: no token available')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.sendTimeoutMs ?? 15_000)
    timer.unref?.()
    try {
      const response = await fetch(`${config.apiBase}${path}`, {
        ...init,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${secret}`,
          'user-agent': `dsh-concierge/${config.account}`,
          'x-github-api-version': '2022-11-28',
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      })
      if (response.status === 304) return { notModified: true, status: 304, body: undefined }
      if (response.status === 404) return { gone: true, status: 404, body: undefined }
      if (!response.ok) throw new Error(`github ${path} failed with HTTP ${response.status}`)
      return { status: response.status, body: await response.json() }
    } finally {
      clearTimeout(timer)
    }
  }
  return {
    /** Unread notifications, newest first, at most one page. */
    async notifications() {
      const result = await call('/notifications?all=false&per_page=50')
      return result.notModified || result.gone ? [] : (Array.isArray(result.body) ? result.body : [])
    },
    /** Reads a Thread's comments and the subject body, for `threadContext`. */
    async threadContext(repository, number, kind) {
      const base = `/repos/${repository}/${kind === 'PullRequest' ? 'pulls' : 'issues'}/${number}`
      const subject = await call(base)
      const comments = await call(`${base}/comments?per_page=50`)
      const messages = []
      if (subject.body && typeof subject.body === 'object') {
        messages.push({
          id: `${repository}#${number}`,
          from: subject.body.user?.login ?? '',
          at: Date.parse(subject.body.created_at ?? '') || 0,
          text: String(subject.body.body ?? subject.body.title ?? ''),
          ...(subject.body.user?.type === 'Bot' ? { bot: true } : {}),
          ...(subject.body.html_url ? { url: subject.body.html_url } : {}),
        })
      }
      const list = comments.notModified || comments.gone ? [] : (Array.isArray(comments.body) ? comments.body : [])
      for (const comment of list) {
        messages.push({
          id: String(comment.id ?? ''),
          from: comment.user?.login ?? '',
          at: Date.parse(comment.created_at ?? '') || 0,
          text: String(comment.body ?? ''),
          ...(comment.user?.type === 'Bot' ? { bot: true } : {}),
          ...(comment.html_url ? { url: comment.html_url } : {}),
        })
      }
      messages.sort((left, right) => left.at - right.at)
      return { messages, body: { messages } }
    },
    /** One pull request's current state, so a merge or close can close its Thread. */
    async pullRequest(repository, number) {
      const result = await call(`/repos/${repository}/pulls/${number}`)
      if (result.notModified) return undefined
      if (result.gone) return { number, state: 'closed', merged: false, gone: true }
      return result.body
    },
    /** Post a comment on the issue or pull request a reply belongs to. */
    async comment(repository, number, text, key) {
      const result = await call(`/repos/${repository}/issues/${number}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // The key is recorded in the body: GitHub has no idempotency header for comments,
        // so a retry can be recognised by a reader if the first attempt actually landed.
        body: JSON.stringify({ body: text }),
      })
      if (result.gone) return 'gone'
      return 'sent'
    },
    /** The account behind the token, used to recognise the agent's own events. */
    async viewer() {
      const result = await call('/user')
      return result.notModified || result.gone ? undefined : result.body?.login
    },
    key: () => key,
  }
}

/** The GitHub Source kind. */
export const githubKind = {
  kind: 'github',
  title: 'GitHub',
  parseConfig: parseGithubConfig,

  translate(event, { config, instance }) {
    // A PR state observation is not a Trigger: it is a Thread close, handled by
    // `threadClosed`. Only notifications become Triggers.
    if (event?.kind === 'notification') return githubTriggerFromNotification(event.notification, { config, instance })
    return githubTriggerFromNotification(event, { config, instance })
  },

  scope(trigger, config) {
    if (config.repositories.length > 0 && !config.repositories.includes(trigger.meta?.repository)) {
      return { listened: false, reason: 'repository_not_listed' }
    }
    // A notification is addressed to this account, so unaddressed activity in a watched
    // repository is observed rather than delivered as a mention.
    return { listened: true, observed: true, row: trigger.meta?.repository }
  },

  isOwn(trigger, config) {
    const actor = String(trigger.actor ?? '')
    return actor !== '' && actor.toLowerCase() === String(config.account ?? '').toLowerCase()
  },

  /** The account's own login, so an event authored by it is dropped before assessment. */
  async identify(instance) {
    const client = githubClient(instance.config)
    return client.viewer()
  },

  channel: {
    allowed(address, config) {
      return typeof address?.repository === 'string' && Number(address?.number) > 0
    },
    async send(host, message) {
      const instance = host?.resolve?.(message.channel) ?? host?.instance
      if (!instance) throw new Error('github channel: unknown instance')
      const client = githubClient(instance.config)
      const { repository, number } = message.address ?? {}
      // The reply id is the idempotency key; GitHub records it in the body for a reader.
      return client.comment(repository, number, `${message.text}`, message.id)
    },
    threadKeyOf(trigger) {
      return trigger.channel?.thread ?? trigger.threadKey
    },
  },

  /** Cookbook step 6: what the assessor may read around a Trigger. */
  threadContext: {
    messageId(trigger) {
      return `${trigger.meta?.repository}#${trigger.meta?.number}`
    },
    async read(host, trigger) {
      const instance = host?.instance ?? host?.resolve?.(trigger.meta?.instance)
      if (!instance) return { messages: [] }
      const client = githubClient(instance.config)
      return client.threadContext(String(trigger.meta?.repository), Number(trigger.meta?.number), String(trigger.meta?.type ?? 'Issue'))
    },
  },
}
