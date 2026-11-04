/**
 * The Router layer: the operator's only counterpart.
 *
 * v1 has no second LLM here on purpose. The Router role is played by the Session that
 * calls these tools, and this module supplies what an LLM Router needs to be useful:
 * a batch window, so requests that arrive while the Router is thinking are decided
 * together, and a Ticket lookup, so a follow-up joins its existing Thread instead of
 * opening new work.
 */
import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { summarize } from './text.js'
import { reopenedTaskText } from './handover.js'

export class Router {
  /**
   * @param {{ state: import('./state.js').State, supervisor: import('./supervisor.js').Supervisor,
   *           config: { routerBatchMs: number }, logger: any }} options
   */
  constructor({ state, supervisor, config, logger }) {
    this.state = state
    this.supervisor = supervisor
    this.config = config
    this.logger = logger
    /** Requests accepted but not yet decided, in arrival order. */
    this.pending = []
    this.batch = undefined
    this.batchSeq = 0
    /** The Session that filed the most recent request; reports go back here. */
    this.routerSessionId = undefined
  }

  /** Requests merged into the current batch, for the Router's next turn. */
  drainBatch() {
    if (this.pending.length === 0) return { batch: [], ids: [] }
    this.batchSeq += 1
    const items = this.pending.splice(0)
    this.batch = { id: `batch-${this.batchSeq}`, at: Date.now(), items }
    return { batch: items, ids: items.map(item => item.id) }
  }

  /** Whether new work should wait: a batch window is open and the Router is thinking. */
  get batching() {
    return this.batch !== undefined
  }

  /** Close the batch window; called after the Router answered. */
  settle() {
    this.batch = undefined
    return this.supervisor.pump()
  }

  /**
   * Reopen a stalled ticket.
   *
   * The lost-worker procedure is a gate, not advice: without a recorded nudge (`status`) and
   * a `send` after it, a reopen is refused. The ceremony matters — a worker that finished its
   * artifact and never reported looks identical, from outside, to a dead one, and reopening
   * throws away work that already exists.
   *
   * The new ticket carries the old worker's artifact paths as facts and the Router's own
   * observations as 待核实线索, never as requirements.
   *
   * @param {{ ticketId: string, leads?: string[], task?: string }} input
   */
  async reopen({ ticketId, leads = [], task = undefined }) {
    const ticket = this.state.getTicket(ticketId)
    if (!ticket) return { ok: false, reason: 'unknown-ticket', message: `no ticket "${ticketId}"` }
    if (ticket.status === 'done') return { ok: false, reason: 'already-done', message: `ticket ${ticketId} completed` }

    // Step (a): a nudge must be recorded.
    const nudgedAt = this.state.nudgedAt(ticketId)
    if (nudgedAt === undefined) {
      return {
        ok: false,
        reason: 'procedure-incomplete',
        step: 'a',
        message: '失联流程第 a 步未执行：先调用 superagent_status 催报，等一个巡检周期后再决定。',
      }
    }
    // Step (b): a message must have been sent after the nudge.
    const sentAfterNudge = this.state.messages(ticketId, 200)
      .some(row => row.role === 'operator' && row.created_at > nudgedAt)
    if (!sentAfterNudge) {
      return {
        ok: false,
        reason: 'procedure-incomplete',
        step: 'b',
        message: '失联流程第 b 步未执行：用 superagent_send 提醒「立即 superagent_report」，再等一个巡检周期。',
      }
    }

    const artifacts = await this.artifactPaths(ticketId)
    const text = reopenedTaskText({
      title: ticket.title,
      task: task ?? this.state.rawIntentText(ticket),
      artifacts,
      leads,
      previousTicketId: ticketId,
    })

    const reopened = this.state.createTicket({
      title: ticket.title,
      intent: text,
      routerSession: this.routerSessionId,
      reopenedFrom: ticketId,
    })
    this.state.setLeads(reopened.id, leads)
    this.state.subscribe(reopened.id, reopened.threadKey, 'router')
    this.state.setStatus(ticketId, 'failed', { failure: `reopened as ${reopened.id} after the lost-worker procedure` })
    this.state.log('ticket/reopened', reopened.id, `from ${ticketId} with ${leads.length} lead(s)`)
    this.supervisor.releaseSlot(ticketId)
    this.supervisor.pump()
    return {
      ok: true,
      ticket_id: reopened.id,
      reopened_from: ticketId,
      leads: leads.length,
      artifacts: artifacts.reduce((sum, row) => sum + (row.files?.length ?? 0), 0),
      message: `已重开为 ${reopened.id}；上游线索已标注为待核实。`,
    }
  }

  /** The previous worker's artifact paths and file names, for the handover's facts block. */
  async artifactPaths(ticketId) {
    const dir = join(this.config.stateDir ?? '.', 'agent', ticketId)
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      const files = entries.filter(entry => entry.isFile()).map(entry => entry.name).sort()
      return [{ path: dir, files }]
    } catch {
      return []
    }
  }

  /**
   * `superagent_ask`. Decides routing for one request:
   * an explicit ticket id, a Thread match, or a new Ticket.
   * @returns routing facts the Router uses to write its short answer.
   */
  async ask({ text, title = undefined, ticketId = undefined, caller = undefined }) {
    const request = { id: `ask-${randomUUID().slice(0, 8)}`, at: Date.now(), text, title }
    this.pending.push(request)
    // Remember which Session to answer: the one that actually asked.
    if (caller) this.routerSessionId = caller
    if (ticketId) {
      const ticket = this.state.getTicket(ticketId)
      if (!ticket) return { request_id: request.id, routed: 'unknown-ticket', message: `no ticket "${ticketId}"` }
      if (ticket.status === 'done' || ticket.status === 'failed') {
        return { request_id: request.id, routed: 'closed-ticket', ticket_id: ticket.id, status: ticket.status }
      }
      return this.followUp(ticket, text, request)
    }
    const match = this.matchThread(text)
    if (match) return this.followUp(match, text, request)
    const ticket = this.state.createTicket({
      title: title ?? summarize(text, 60),
      intent: text,
      routerSession: this.routerSessionId,
    })
    // v2: a Router-filed Ticket subscribes to its own Thread, so later Triggers on that
    // Thread reach it as fan-out instead of needing a new assessment.
    this.state.subscribe(ticket.id, ticket.threadKey, 'router')
    this.state.log('router/new-ticket', ticket.id)
    this.supervisor.pump()
    return {
      request_id: request.id,
      routed: 'new-ticket',
      ticket_id: ticket.id,
      status: ticket.status,
      slots: this.supervisor.openSlots,
      batch: this.pending.length,
      message: `queued ticket ${ticket.id}`,
    }
  }

  /** Attach a message to the Thread that already covers it. */
  async followUp(ticket, text, request) {
    const send = await this.supervisor.send(ticket.id, text)
    this.state.log('router/follow-up', ticket.id)
    return { ...send, request_id: request.id, routed: 'thread', ticket_id: ticket.id }
  }

  /**
   * v2 Thread matching, in two layers.
   *
   * **Subscriptions first.** A request that names a Thread already carried by a Ticket
   * belongs to that Ticket. This is the real relation, and it is many-to-many: several
   * Tickets may follow one Thread.
   *
   * **Artefact heuristic only as a fallback**, for a request with no Source behind it.
   * It matches concrete artefacts (paths, filenames, issue ids), never vocabulary, and
   * only against Tickets that are still open — a closed Ticket is not a thread to join.
   */
  matchThread(text) {
    const subscribed = this.matchSubscription(text)
    if (subscribed) return subscribed
    return this.matchArtefact(text)
  }

  /**
   * A request that quotes a Thread key, or whose concrete artefact is already the subject
   * of a Ticket whose Thread has a Source behind it, joins that Ticket.
   */
  matchSubscription(text) {
    const source = String(text ?? '')
    for (const ticket of this.state.listTickets({ status: 'open', limit: 20 })) {
      for (const subscription of this.state.subscriptionsOf(ticket.id)) {
        // An explicit `webhook:<instance>:<thread>` reference is unambiguous.
        if (subscription.threadKey !== ticket.threadKey && source.includes(subscription.threadKey)) return ticket
      }
    }
    return undefined
  }

  /** The v1 heuristic, kept for Tickets with no Source: concrete artefacts only. */
  matchArtefact(text) {
    const wanted = artefactSet(text)
    if (wanted.size === 0) return undefined
    let best
    let bestScore = 0
    for (const ticket of this.state.listTickets({ status: 'open', limit: 20 })) {
      // Only open Tickets: a finished ticket is history, not a live thread.
      const intent = this.state.intentText(ticket)
      const existing = artefactSet(`${ticket.title} ${intent}`)
      if (existing.size === 0) continue
      // Every artefact the new request names must be accounted for by this ticket, and
      // the ticket must not be about a different artefact of the same shape.
      const matched = [...wanted].filter(name => [...existing].some(other => sameArtefact(name, other)))
      if (matched.length === 0) continue
      if (matched.length !== new Set([...wanted].map(name => name.split(/[\\/]/).pop())).size) continue
      if (matched.length > bestScore) { best = ticket; bestScore = matched.length }
    }
    return best
  }

  /** The Router's list of what needs a person or a decision. */
  overview() {
    const sources = this.state.listSources().map(source => ({
      id: source.id,
      kind: source.kind,
      enabled: source.enabled,
      cursor: source.cursor,
      health: source.health?.state ?? 'unknown',
    }))
    return {
      slots: { used: this.supervisor.slots.size, limit: this.supervisor.config.concurrency },
      batch_pending: this.pending.length,
      sources,
      undelivered: this.state.listChannelMessages({ state: 'pending', limit: 5 }).length,
      dropped: this.state.listChannelMessages({ state: 'dropped', limit: 5 }).length,
      open: this.state.listTickets({ status: 'open', limit: 10 }).map(ticket => ({
        id: ticket.id,
        title: summarize(ticket.title, 60),
        status: ticket.status,
        report: ticket.lastReportState ?? 'none',
        threads: this.state.subscriptionsOf(ticket.id).length,
      })),
      last_watchdog: this.supervisor.probeHistory.at(-1) ?? null,
    }
  }
}

/**
 * Function words that carry no topic. Dropping them is what keeps "the" from merging
 * two unrelated requests into one thread.
 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'than', 'of', 'to', 'in', 'on', 'at', 'by', 'for',
  'with', 'from', 'into', 'about', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its',
  'this', 'that', 'these', 'those', 'we', 'you', 'they', 'he', 'she', 'i', 'me', 'my', 'our', 'your',
  'their', 'please', 'again', 'still', 'also', 'just', 'not', 'no', 'yes', 'do', 'does', 'did', 'can',
  'could', 'should', 'would', 'will', 'shall', 'may', 'might', 'must', 'have', 'has', 'had', 'get', 'got',
  'make', 'made', 'use', 'using', 'add', 'added', 'fix', 'fixed', 'test', 'tests', 'page', 'pages',
  '的', '了', '和', '与', '在', '是', '我', '你', '他', '她', '它', '这', '那', '请', '一下', '一个',
])

/**
 * The concrete artefacts a request names: paths, filenames and issue-style ids.
 * These are what make two requests "the same work" or not; ordinary words are not.
 */
export function artefactSet(text) {
  const found = new Set()
  const source = String(text ?? '')
  // Paths: anything with a separator and a dotted or slashed tail.
  for (const match of source.matchAll(/[A-Za-z]:[\\/][^\s，。；、）)"']+|(?:\.{0,2}\/)[^\s，。；、）)"']+/g)) {
    found.add(normalizePath(match[0]))
  }
  // Bare filenames with an extension.
  for (const match of source.matchAll(/(?<![\w/.-])([\w.-]{1,80}\.[A-Za-z0-9]{1,8})(?![\w/.-])/g)) {
    found.add(match[1].toLowerCase())
  }
  // Issue-style references such as #123 or ABC-45.
  for (const match of source.matchAll(/(?:^|\s)#(\d{1,7})\b/g)) found.add(`#${match[1]}`)
  for (const match of source.matchAll(/\b([A-Z]{2,10}-\d{1,6})\b/g)) found.add(match[1].toLowerCase())
  return found
}

/** Compare paths by their final segment when only a filename is given. */
function normalizePath(value) {
  const cleaned = String(value).replace(/[\\/]+$/, '').toLowerCase()
  return cleaned
}

/**
 * The artefact identity used for matching: a bare filename and a full path that ends
 * with it must agree, which the caller checks by comparing final segments too.
 */
function sameArtefact(a, b) {
  if (a === b) return true
  const tailA = a.split(/[\\/]/).pop()
  const tailB = b.split(/[\\/]/).pop()
  return tailA !== undefined && tailA === tailB
}

/** Distinctive lowercase tokens with function words removed. */
function contentTokens(text) {
  return String(text ?? '').toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/)
    .filter(word => (word.length >= 3 || /[\u4e00-\u9fff]/.test(word)) && !STOPWORDS.has(word))
}

/** Kept for callers that only need tokenisation; shares the stopword policy. */
function tokens(text) {
  return contentTokens(text)
}
