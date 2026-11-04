/**
 * Tool-call identity checks.
 *
 * A tool's availability is not authorization. Every dsh-concierge tool re-checks *which
 * Session* is calling, because a worker Session has the full tool set and could otherwise
 * file tickets, report on another ticket, or read another ticket's references.
 *
 * The rules:
 *
 *   superagent_ask / superagent_send   Router only
 *   superagent_report                  the worker of exactly that ticket
 *   superagent_read                    Router: anything; worker: only its own ticket's refs
 *   superagent_sources                 Router only
 *
 * Failures return one fixed, explicit error per rule so a caller learns the boundary and a
 * log reader can grep for it. The text never reveals what the other identity could see.
 */

/** Prefix of the Session id a worker for a ticket runs under. */
export const WORKER_PREFIX = 'concierge-worker-'

/** The Session id a worker for `ticketId` uses. */
export function workerSessionId(ticketId) {
  return `${WORKER_PREFIX}${ticketId}`
}

/** The ticket a Session id belongs to, or undefined when it is not a worker. */
export function ticketOfWorkerSession(sessionId) {
  const text = String(sessionId ?? '')
  return text.startsWith(WORKER_PREFIX) ? text.slice(WORKER_PREFIX.length) : undefined
}

/** A refusal with a stable code and a message that names the rule, not the other side. */
export class ToolRefusal extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ToolRefusal'
    this.code = code
  }
}

export const REFUSAL = Object.freeze({
  ROUTER_ONLY: 'superagent/router-only',
  WORKER_ONLY: 'superagent/worker-only',
  WRONG_TICKET: 'superagent/wrong-ticket',
  FOREIGN_REFERENCE: 'superagent/foreign-reference',
})

/**
 * Require the calling Session to be the Router.
 * @param {{ exec: any, state: any }} input
 */
export function requireRouter({ exec, state }) {
  const caller = exec?.agent?.id
  if (caller === undefined) {
    // A direct same-process call (a test, a management script) has no Session identity.
    // It is allowed only when it is not a worker: a worker always has an id.
    return { caller: undefined, router: true }
  }
  const ticketId = ticketOfWorkerSession(caller)
  if (ticketId !== undefined) {
    throw new ToolRefusal(REFUSAL.ROUTER_ONLY, 'superagent_ask and superagent_send may only be called by the Router Session, not by a worker')
  }
  return { caller, router: true }
}

/**
 * Require the calling Session to be the worker of `ticketId`.
 * A direct call with no Session identity is refused: only a real worker may report.
 */
export function requireWorkerOf({ exec, state }, ticketId) {
  const caller = exec?.agent?.id
  if (caller === undefined) {
    throw new ToolRefusal(REFUSAL.WORKER_ONLY, 'superagent_report may only be called by the worker Session of the ticket')
  }
  const owned = ticketOfWorkerSession(caller)
  if (owned === undefined) {
    throw new ToolRefusal(REFUSAL.WORKER_ONLY, 'superagent_report may only be called by the worker Session of the ticket')
  }
  if (owned !== String(ticketId)) {
    throw new ToolRefusal(REFUSAL.WRONG_TICKET, `this Session works on ticket ${owned}, not ${ticketId}`)
  }
  return { caller, ticketId: owned }
}

/**
 * Decide whether a caller may read `ref`.
 *
 * A worker may read references that belong to its own ticket: the ticket itself, its
 * messages, its report, blobs it produced, and threads it subscribes to. Everything else
 * is refused. The Router may read anything.
 *
 * @returns {{ allowed: true } | { allowed: false, code: string, message: string }}
 */
export function checkReadRef({ exec, state }, ref) {
  const caller = exec?.agent?.id
  const owned = ticketOfWorkerSession(caller)
  if (owned === undefined) return { allowed: true }

  const raw = String(ref ?? '').trim()
  const at = raw.indexOf(':')
  if (at < 0) return { allowed: true }
  const kind = raw.slice(0, at)
  const key = raw.slice(at + 1)

  if (kind === 'ticket' || kind === 'report') {
    return key === owned
      ? { allowed: true }
      : { allowed: false, code: REFUSAL.FOREIGN_REFERENCE, message: `this Session may only read references of ticket ${owned}` }
  }
  if (kind === 'msg') {
    // Message ids are `<ticketId>-m<n>`.
    return key.startsWith(`${owned}-`)
      ? { allowed: true }
      : { allowed: false, code: REFUSAL.FOREIGN_REFERENCE, message: `this Session may only read references of ticket ${owned}` }
  }
  if (kind === 'thread') {
    // A Thread is readable when this ticket subscribes to it.
    const ownedThreads = state.subscriptionsOf(owned).map(row => row.threadKey)
    const ticket = state.getTicket(owned)
    const keys = ticket ? [...ownedThreads, ticket.threadKey] : ownedThreads
    return keys.includes(key)
      ? { allowed: true }
      : { allowed: false, code: REFUSAL.FOREIGN_REFERENCE, message: `this Session may only read references of ticket ${owned}` }
  }
  if (kind === 'blob') {
    // A blob is readable when this ticket's messages, intent or reports reference it.
    const referenced = state.blobBelongsTo(owned, key)
    return referenced
      ? { allowed: true }
      : { allowed: false, code: REFUSAL.FOREIGN_REFERENCE, message: `this Session may only read references of ticket ${owned}` }
  }
  return { allowed: false, code: REFUSAL.FOREIGN_REFERENCE, message: `unknown reference kind "${kind}"` }
}
