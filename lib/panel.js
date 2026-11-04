/**
 * The panel's read-only aggregation.
 *
 * One endpoint answers the whole panel: KPI counts, the seven-day flow, both distributions,
 * the ticket list, Source health and the delivery queue — all for one requested time range.
 * Aggregating on the Host keeps the client dumb and the payload small, and means a range
 * change is one request rather than a re-derivation in the browser.
 *
 * Nothing here writes. Every number is derived from the same SQLite rows the tools use, so
 * the panel can never disagree with the system it reports on.
 */

/** The time ranges the header offers. */
export const RANGES = Object.freeze({
  today: 'today',
  '7d': '7d',
  all: 'all',
})

/** Normalise a range token; anything unknown falls back to `all`, never to a guess. */
export function normalizeRange(value) {
  return value === RANGES.today || value === RANGES['7d'] ? value : RANGES.all
}

/** The inclusive lower bound of a range, or undefined for `all`. */
export function rangeStart(range, now = Date.now()) {
  if (range === RANGES.all) return undefined
  if (range === RANGES['7d']) return now - 7 * 24 * 60 * 60 * 1000
  // Today: local midnight. The Host runs in the operator's zone.
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** Whether a ticket is a smoke-test artifact rather than real work. */
export function isTestTicket(ticket) {
  const origin = String(ticket.origin ?? '')
  if (origin === 'test') return true
  const text = `${ticket.title ?? ''} ${ticket.intent ?? ''}`.toLowerCase()
  return text.includes('probe/') || text.includes('smoke') || text.includes('冒烟') || text.includes('测试')
}

/**
 * Whether a ticket waits for a person. A `failed` ticket always does; a `blocked` report
 * does; everything else is the system's own work.
 */
export function needsPerson(ticket) {
  if (ticket.status === 'failed') return 'failed'
  if (ticket.lastReportState === 'blocked') return 'blocked'
  return undefined
}

/** The panel's status buckets, mapped from the stored status codes. */
export function statusBucket(ticket) {
  if (ticket.status === 'done') return 'completed'
  if (ticket.status === 'failed') return 'failed'
  if (ticket.status === 'running') return 'running'
  return 'queued'
}

/** Seven day buckets, oldest first, labelled by local date. */
function dayBuckets(now) {
  const buckets = []
  for (let offset = 6; offset >= 0; offset--) {
    const date = new Date(now - offset * 24 * 60 * 60 * 1000)
    date.setHours(0, 0, 0, 0)
    buckets.push({ key: date.getTime(), label: `${date.getMonth() + 1}/${date.getDate()}`, created: 0, completed: 0, failed: 0 })
  }
  return buckets
}

/** Place one timestamp in its bucket, ignoring anything outside the window. */
function bucketOf(buckets, at) {
  if (!Number.isFinite(at)) return undefined
  for (const bucket of buckets) {
    if (at >= bucket.key && at < bucket.key + 24 * 60 * 60 * 1000) return bucket
  }
  return undefined
}

/**
 * The one judgement the whole panel shares.
 *
 * Every row is classified exactly once, here: whether it is a test artifact, whether it
 * waits for a person, and which list it belongs to. KPI counts and list rows both read
 * these fields, so a card's number and the rows behind it cannot disagree — the earlier
 * version counted `needs` across every ticket while the list hid test tickets, and the two
 * drifted apart the moment a smoke ticket failed.
 *
 * `lists` names every filter that shows the row. `attention` rows are always real work:
 * a test ticket is never something the operator must act on.
 */
export function classify(ticket) {
  const test = isTestTicket(ticket)
  const needs = needsPerson(ticket) ?? null
  const attention = needs !== null && !test
  const lists = []
  if (attention) lists.push('attention')
  if (!test) lists.push('all')
  if (test) lists.push('test')
  return { test, needs, attention, lists, bucket: statusBucket(ticket) }
}

/** Whether a classified row belongs to `filter`. The only filter predicate there is. */
export function inFilter(row, filter) {
  return Array.isArray(row?.lists) && row.lists.includes(filter)
}

/**
 * Build the panel payload.
 *
 * @param {{ state: any, supervisor: any, assessor: any, channels?: any, intake?: any }} services
 * @param {{ range?: string, limit?: number, now?: number }} options
 */
export function panelSnapshot(services, { range = RANGES.all, limit = 50, now = Date.now() } = {}) {
  const { state, supervisor, assessor, channels, intake } = services
  const window = normalizeRange(range)
  const since = rangeStart(window, now)

  // Every ticket, newest first: the panel filters rather than paging, so it needs the set.
  const all = state.listTickets({ status: 'all', limit: 500 })
  // A range window selects by *activity*: a ticket that ended yesterday but was touched
  // today still belongs to today's view, and one that ended long ago must drop out of it.
  const latest = ticket => Math.max(ticket.updatedAt ?? 0, ticket.endedAt ?? 0)
  const inRange = since === undefined ? all : all.filter(ticket => latest(ticket) >= since)

  const tickets = inRange.map(ticket => {
    const lastReport = readReport(ticket.lastReport)
    const kind = classify(ticket)
    return {
      id: ticket.id,
      title: ticket.title,
      status: ticket.status,
      bucket: kind.bucket,
      report: ticket.lastReportState ?? null,
      summary: lastReport?.summary ?? null,
      detail: lastReport
        ? {
          state: lastReport.state ?? null,
          next: lastReport.next ?? null,
          workspace: lastReport.workspace ?? null,
          at: lastReport.at ?? null,
        }
        : null,
      rounds: ticket.rounds,
      blockedRetries: ticket.blockedRetries ?? 0,
      failure: ticket.failure ?? null,
      // A reopened ticket carries unverified leads. The panel shows them separately from the
      // work itself, so nobody reads a guess as a requirement.
      leads: Array.isArray(ticket.leads) ? ticket.leads : [],
      reopenedFrom: ticket.reopenedFrom ?? null,
      nudgedAt: ticket.nudgedAt ?? null,
      // The classification is computed once, above; these fields are what both the KPI
      // counts and the list filters read.
      needs: kind.needs,
      attention: kind.attention,
      test: kind.test,
      lists: kind.lists,
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
      endedAt: ticket.endedAt ?? null,
    }
  })

  // ------------------------------------------------------------------ KPI
  // Counted through the same fields the list filters on: `attention` for what needs a
  // person, `test` to exclude, `status` for the rest.
  const completed = tickets.filter(ticket => ticket.status === 'done')
  const failed = tickets.filter(ticket => ticket.status === 'failed')
  const queued = tickets.filter(ticket => ticket.status === 'queued')
  const running = tickets.filter(ticket => ticket.status === 'running')
  const needing = tickets.filter(ticket => ticket.attention)

  const todayStart = rangeStart(RANGES.today, now)
  const endedToday = ticket => ticket.status === 'done' && (ticket.endedAt ?? 0) >= todayStart
  const failedToday = ticket => ticket.status === 'failed' && (ticket.endedAt ?? 0) >= todayStart

  const queue = channels
    ? {
      pending: state.listChannelMessages({ state: 'pending', limit: 100 }).map(row => ({
        id: row.id, ticket: row.ticketId, attempts: row.attempts, nextAt: row.nextAt, reason: row.reason ?? null,
      })),
      dropped: state.listChannelMessages({ state: 'dropped', limit: 100 }).map(row => ({
        id: row.id, ticket: row.ticketId, reason: row.reason ?? null,
      })),
    }
    : { pending: [], dropped: [] }

  const kpi = {
    needsAttention: needing.length,
    running: running.length,
    slotLimit: supervisor?.config?.concurrency ?? 0,
    queued: queued.length,
    doneToday: tickets.filter(endedToday).length,
    failedToday: tickets.filter(failedToday).length,
    deliveryBacklog: queue.pending.length + queue.dropped.length,
  }

  // --------------------------------------------------------------- charts
  const buckets = dayBuckets(now)
  for (const ticket of all) {
    const created = bucketOf(buckets, ticket.createdAt)
    if (created) created.created += 1
    if (ticket.status === 'done') {
      const done = bucketOf(buckets, ticket.endedAt ?? 0)
      if (done) done.completed += 1
    }
    if (ticket.status === 'failed') {
      const bad = bucketOf(buckets, ticket.endedAt ?? 0)
      if (bad) bad.failed += 1
    }
  }

  const statusDistribution = [
    { key: 'queued', value: queued.length },
    { key: 'running', value: running.length },
    { key: 'completed', value: completed.length },
    { key: 'failed', value: failed.length },
  ]

  const decisions = state.listDecisions({ limit: 200 })
  const verdictCount = verdict => decisions.filter(row => row.verdict === verdict).length
  // A decision still awaiting a verdict has no `verdict`; counting it under a verdict would
  // attribute a judgement that was never made. It is its own slice instead.
  const verdictDistribution = [
    { key: 'accept', value: verdictCount('accept') },
    { key: 'ignore', value: verdictCount('ignore') },
    { key: 'need_context', value: verdictCount('need_context') },
    { key: 'deferred', value: decisions.filter(row => row.verdict === null || row.verdict === undefined || row.state === 'pending').length },
  ]

  // ---------------------------------------------------------------- detail
  const sources = state.listSources().map(source => ({
    id: source.id,
    kind: source.kind,
    enabled: source.enabled,
    cursor: source.cursor ?? null,
    health: source.health ?? null,
    token: source.tokenFingerprint ?? null,
    recent: state.listTriggers({ source: source.id, limit: 5 }).map(trigger => ({
      id: trigger.id,
      disposition: trigger.disposition,
      reason: trigger.reason ?? null,
      actor: trigger.actor ?? null,
      at: trigger.at,
    })),
  }))

  const attention = [
    ...needing.map(ticket => ({ kind: 'ticket', id: ticket.id, why: ticket.needs, title: ticket.title })),
    ...queue.dropped.map(row => ({ kind: 'channel', id: row.id, why: 'dropped', title: row.reason ?? '' })),
    ...(supervisor?.probeHistory?.at(-1)?.health?.ok === false
      ? [{ kind: 'infrastructure', id: 'state', why: 'unhealthy', title: '数据库自检失败' }]
      : []),
  ]

  return {
    ok: true,
    generatedAt: now,
    range: window,
    attention,
    kpi,
    // Whether the Router preset is installed: the operator needs to know before opening a
    // session and watching it do the work by hand.
    ...(services.preset ? { preset: services.preset } : {}),
    charts: {
      flow: { days: buckets.map(bucket => ({ label: bucket.label, created: bucket.created, completed: bucket.completed, failed: bucket.failed })) },
      status: statusDistribution,
      verdicts: verdictDistribution,
    },
    tickets,
    sources,
    decisions: decisions.slice(0, 40).map(decision => ({
      trigger: decision.triggerId,
      state: decision.state,
      verdict: decision.verdict ?? null,
      reason: decision.reason ?? null,
      policyRevision: decision.policyRevision ?? null,
      deferrals: decision.deferrals ?? 0,
      nextAt: decision.nextAt ?? null,
    })),
    channels: queue,
    policy: { revision: state.currentPolicy().revision, origin: state.currentPolicy().origin },
    ...(intake ? { intake: { received: intake.received, filtered: intake.filtered, ownDropped: intake.ownDropped } } : {}),
    ...(assessor ? { assessment: { accepted: assessor.accepted, ignored: assessor.ignored, deferred: assessor.deferred } } : {}),
  }
}

/** A stored report is JSON; a damaged one reads as absent rather than breaking the panel. */
function readReport(raw) {
  if (typeof raw !== 'string' || raw === '') return undefined
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' ? value : undefined
  } catch {
    return { summary: raw }
  }
}

/** Cut a string to a display length without throwing on a non-string. */
function trim(value, max) {
  const text = String(value ?? '')
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * Where the panel fetches its snapshot.
 *
 * The path is absolute from the page origin and carries the `/api` prefix, because
 * `ctx.connection.fetch` composes routes into that shared channel. A route registered
 * without the prefix never reaches the connection handler, so the page falls through to
 * the SPA router and sees a 404. Other plugins follow the same convention:
 * `path: '/api/<plugin>/<endpoint>'`, fetched as `api/<plugin>/<endpoint>`.
 */
export const PANEL_PATH = '/api/concierge/panel'

/**
 * Register the panel route on the Host's own connection.
 *
 * `ctx.connection.fetch.register` composes an exact Fetch route into the shared `/api`
 * channel, so the request carries the page's existing credential and arrives same-origin:
 * no listener, no CORS, no second token. The route is GET-only and read-only.
 *
 * @returns {Promise<() => Promise<void>>} the disposer, or a no-op when unavailable
 */
export async function registerPanelRoute(connection, services) {
  if (typeof connection?.fetch?.register !== 'function') return async () => {}
  return connection.fetch.register({
    path: PANEL_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        // `?range=today|7d|all`, read from the query string the page already sends.
        const url = new URL(request.url, 'http://localhost')
        const value = panelSnapshot(services, { range: url.searchParams.get('range') ?? RANGES.all })
        return Response.json(value, { headers: { 'cache-control': 'no-store' } })
      } catch (error) {
        return Response.json(
          { ok: false, error: { code: 'concierge/panel-failed', message: String(error?.message ?? error) } },
          { status: 500, headers: { 'cache-control': 'no-store' } },
        )
      }
    },
  })
}

export { trim }
