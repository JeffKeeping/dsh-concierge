/**
 * The GitHub intake loop and its Thread lifecycle.
 *
 * Polling, per the cookbook: read once per `pollSeconds`, take in every event, and commit
 * the read position only after the whole round is stored. Notification ids are stable, so
 * a replayed round is a no-op.
 *
 * Pull requests add the one thing a notification cannot express: a Thread that *ends*.
 * When a followed PR is merged or closed, the Tickets subscribed to its Thread are done
 * with it, and that is the moment to close them. The engine decides the Ticket's end; this
 * module only supplies the fact, exactly as `003-execution.md` requires.
 */
import { githubClient, githubPrFact, parseGithubConfig, githubThreadKey } from './github.js'
export { githubPrFact, githubThreadKey, parseGithubConfig }

/** How many notifications one round reads; the API pages at 50. */
const PAGE = 50

/**
 * One polling round. Returns a summary for health reporting.
 *
 * @param {{ state: any, registry: any, intake: any, logger: any }} host
 * @param {object} instance the `source` row
 * @param {{ signal?: AbortSignal }} options
 */
export async function pollGithub(host, instance, { signal = undefined } = {}) {
  const config = instance.config ?? {}
  const client = githubClient(config)
  const outcomes = []

  // 1. Notifications. Each becomes an event with a stable cursor.
  let notifications = []
  try {
    notifications = await client.notifications()
  } catch (error) {
    host.logger?.warn?.(`dsh-concierge github ${instance.id} notification poll failed: ${String(error)}`)
    // A failed read must not advance anything: the cursor stays where it was.
    return { ok: false, read: 0, stored: 0, error: String(error?.message ?? error) }
  }
  if (signal?.aborted) return { ok: false, read: 0, stored: 0, aborted: true }

  const events = notifications
    .slice(0, PAGE)
    .map(notification => ({ kind: 'notification', notification }))
    // Most recent first from the API; take them oldest first so the Thread reads naturally.
    .sort((left, right) => Date.parse(left.notification.updated_at ?? '') - Date.parse(right.notification.updated_at ?? ''))

  const cursorOf = event => {
    const notification = event.notification ?? event
    return String(notification.updated_at ?? notification.id ?? '')
  }
  const round = await host.intake.receiveBatch(instance, events, cursorOf)
  outcomes.push(...round.outcomes)

  // 2. Pull requests a live Ticket follows: their state decides whether a Thread is done.
  const closed = await closeFinishedPullRequests(host, instance, { signal })

  const stored = outcomes.filter(outcome => outcome.outcome === 'stored').length
  const filtered = outcomes.filter(outcome => outcome.outcome === 'filtered').length
  const duplicates = outcomes.filter(outcome => outcome.outcome === 'duplicate').length
  return {
    ok: true,
    read: events.length,
    stored,
    filtered,
    duplicates,
    closed,
    cursor: round.cursor ?? null,
    committed: round.committed === true,
  }
}

/**
 * For every Thread a live Ticket follows, read its pull request; when it is merged or
 * closed, close the Tickets that were waiting on it.
 *
 * This is the only place a Source ends work, and it ends it the way the reference model
 * does: the Ticket is closed because its Thread closed, not because a worker reported.
 */
export async function closeFinishedPullRequests(host, instance, { signal = undefined } = {}) {
  const config = instance.config ?? {}
  const client = githubClient(config)
  const threads = host.state.liveGithubThreads(instance.id)
  const results = []
  for (const thread of threads) {
    if (signal?.aborted) break
    const parsed = parseGithubThread(thread.threadKey, instance.id)
    if (!parsed) continue
    let pullRequest
    try {
      pullRequest = await client.pullRequest(parsed.repository, parsed.number)
    } catch (error) {
      host.logger?.warn?.(`dsh-concierge github ${instance.id} could not read PR ${parsed.repository}#${parsed.number}: ${String(error)}`)
      continue
    }
    if (!pullRequest) continue
    const fact = githubPrFact(pullRequest, parsed.repository)
    if (!fact) continue
    // Record the fact once; the Thread's closure is idempotent.
    if (host.state.hasThreadClosed(thread.threadKey)) continue
    host.state.recordThreadClosed(thread.threadKey, fact.outcome, fact.at)
    const closedTickets = []
    for (const ticket of host.state.subscribers(thread.threadKey)) {
      const report = `Thread closed: ${parsed.repository}#${parsed.number} was ${fact.outcome}.`
      host.state.report(ticket.id, { summary: report, state: 'done' })
      host.state.setStatus(ticket.id, 'done')
      host.state.log('ticket/thread-closed', ticket.id, `${thread.threadKey} ${fact.outcome}`)
      closedTickets.push(ticket.id)
      await host.supervisor.releaseSlot?.(ticket.id)
    }
    results.push({ thread: thread.threadKey, outcome: fact.outcome, tickets: closedTickets })
  }
  return results
}

/** Parse `github:<instance>:<owner>/<name>#<number>`. */
export function parseGithubThread(threadKey, instanceId = undefined) {
  const match = /^github:([^:]+):([\w.-]+\/[\w.-]+)#(\d+)$/.exec(String(threadKey ?? ''))
  if (!match) return undefined
  if (instanceId !== undefined && match[1] !== instanceId) return undefined
  return { instance: match[1], repository: match[2], number: Number(match[3]) }
}

/**
 * The loop the plugin runs for one GitHub instance.
 * Waits for the switch, follows configuration, and stops cleanly on abort.
 */
export async function watchGithub(host, instanceId, signal) {
  let failures = 0
  while (!signal.aborted) {
    const instance = host.state.getSource(instanceId)
    if (!instance || !instance.enabled) break
    let config
    try {
      config = parseGithubConfig(instance.config)
    } catch (error) {
      host.state.setSourceHealth(instanceId, { state: 'error', detail: String(error?.message ?? error), at: Date.now() })
      break
    }
    const at = Date.now()
    const round = await pollGithub(host, instance, { signal })
    if (round.ok) {
      failures = 0
      host.state.setSourceHealth(instanceId, {
        state: round.stored > 0 ? 'working' : 'ready',
        detail: `${round.read} notifications, ${round.stored} stored, ${round.filtered} filtered, ${round.closed.length} threads closed`,
        at,
        cursor: round.cursor,
      })
    } else {
      failures += 1
      // One network failure is retried next round; three in a row need a person.
      if (failures >= 3) {
        host.state.setSourceHealth(instanceId, { state: 'error', detail: round.error ?? 'poll failed', at, failures })
      }
    }
    await sleep(config.pollSeconds * 1000, signal)
  }
}

/** Sleep that ends at once when the loop is stopped. */
function sleep(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve() }, ms)
    timer.unref?.()
    const onAbort = () => { clearTimeout(timer); resolve() }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}
