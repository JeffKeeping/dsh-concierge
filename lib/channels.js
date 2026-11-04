/**
 * The Channel write side: messages a Ticket sends back to its Source.
 *
 * Delivery rules, taken from the reference design:
 *
 *  - **Ordered per Thread.** A Ticket's later message waits behind its earlier one until
 *    that earlier message has failed three times in a row. Other Tickets never wait.
 *  - **Retried, not dropped.** Any failure other than a permanent one backs off from
 *    5 seconds, doubling to 300 seconds, and the message stays queued.
 *  - **Dropped only when impossible.** A kind answers `gone` when the destination can
 *    never receive the message (deleted conversation, revoked chat). The message keeps
 *    its record and its reason, and is never queued again.
 *  - **Idempotent sends.** The message id is the idempotency key handed to the kind, so a
 *    retry after a lost acknowledgement cannot duplicate the message remotely.
 */
import { digest, summarize } from './text.js'

/** Backoff schedule: 5s doubling to 300s. */
export const BACKOFF_BASE_MS = 5_000
export const BACKOFF_MAX_MS = 300_000
/** After this many consecutive failures of an earlier message, its successors proceed. */
export const BLOCKING_FAILURES = 3

/** Delay before the next attempt, given how many have been made. */
export function backoffMs(attempts) {
  const delay = BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1)
  return Math.min(BACKOFF_MAX_MS, delay)
}

export class Channels {
  /**
   * @param {{ state: import('./state.js').State, registry: import('./sources/kind.js').SourceRegistry,
   *           logger: any, config: { channelTickMs: number } }} options
   */
  constructor({ state, registry, logger, config }) {
    this.state = state
    this.registry = registry
    this.logger = logger
    this.config = config
    this.timer = undefined
    this.draining = false
    this.disposed = false
  }

  /**
   * Queue one outbound message for a Ticket.
   *
   * @param {{ ticketId: string, instanceId: string, kind: string, thread: string,
   *           address: object, text: string, purpose?: string }} request
   * @returns {string} the message id, which is also the idempotency key
   */
  enqueue({ ticketId, instanceId, kind, thread, address, text, purpose = 'reply' }) {
    // The id is derived, not random: queueing the same reply twice is the same message.
    const id = `cm-${digest(`${ticketId}|${kind}|${thread}|${purpose}|${text}`)}`
    this.state.enqueueChannelMessage({
      id,
      ticketId,
      channel: instanceId ?? kind,
      thread: thread ?? `${kind}:default`,
      address: address ?? {},
      text,
    })
    return id
  }

  /** Start the delivery loop; one timer for the plugin's lifetime. */
  start() {
    if (this.timer !== undefined || this.disposed) return
    this.timer = setInterval(() => { void this.drain() }, this.config.channelTickMs ?? 1_000)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /**
   * Attempt every message whose retry time has come, in Thread order.
   * A message blocked by an earlier one of the same Thread is skipped, not failed.
   */
  async drain(now = Date.now()) {
    if (this.draining || this.disposed) return { attempted: 0, sent: 0, retried: 0, dropped: 0, blocked: 0 }
    this.draining = true
    const tally = { attempted: 0, sent: 0, retried: 0, dropped: 0, blocked: 0 }
    try {
      for (const message of this.state.dueChannelMessages(now)) {
        // Ordered delivery: an earlier message of the same Thread holds this one back,
        // unless it has already failed enough times to be a problem of its own.
        const earlier = this.state.blockedByEarlier(message.thread, message.createdAt, message.id)
        if (earlier && message.attempts < BLOCKING_FAILURES) {
          tally.blocked += 1
          continue
        }
        tally.attempted += 1
        const outcome = await this.deliver(message)
        tally[outcome] += 1
      }
    } finally {
      this.draining = false
    }
    return tally
  }

  /**
   * Deliver one message. `sent` and `gone` are final; anything else is retried.
   * @returns {Promise<'sent'|'dropped'|'retried'>}
   */
  async deliver(message) {
    // An instance id may be stored as `<kind>:<instance>`; the record is authoritative.
    const instance = this.state.getSource(message.channel)
    const kind = instance
      ? this.registry.get(instance.kind)
      : this.registry.get(kindNameOf(message))
    if (!kind?.channel?.send) {
      // No Channel implementation for this kind: the destination cannot receive anything.
      this.state.markChannelDropped(message.id, `no channel implementation for "${message.channel}"`)
      return 'dropped'
    }
    // A destination the configuration no longer allows is dropped, not retried forever.
    if (instance && kind.channel.allowed && !kind.channel.allowed(message.address, instance.config ?? {})) {
      this.state.markChannelDropped(message.id, 'destination no longer allowed by the Source configuration')
      return 'dropped'
    }
    try {
      const result = await kind.channel.send(
        {
          state: this.state,
          logger: this.logger,
          // The kind resolves its own destination here, so a configuration change takes
          // effect on the next attempt without re-queueing anything.
          resolve: instanceId => this.state.getSource(instanceId),
          instance,
        },
        {
          // The id is the idempotency key the kind passes to the remote service.
          id: message.id,
          ticketId: message.ticketId,
          channel: message.channel,
          thread: message.thread,
          address: message.address,
          text: message.text,
        },
      )
      if (result === 'gone') {
        this.state.markChannelDropped(message.id, 'destination permanently unreachable')
        return 'dropped'
      }
      this.state.markChannelSent(message.id)
      return 'sent'
    } catch (error) {
      const attempts = message.attempts + 1
      const delay = backoffMs(attempts)
      const reason = summarize(String(error?.message ?? error), 200)
      this.state.markChannelRetry(message.id, delay, reason)
      this.logger?.debug?.(`dsh-concierge channel ${message.id} retry ${attempts} in ${delay}ms: ${reason}`)
      return 'retried'
    }
  }

  /** Newest channel messages, so `superagent_*` or the panel can show delivery state. */
  status({ state = undefined, ticketId = undefined, limit = 20 } = {}) {
    return this.state.listChannelMessages({ state, ticketId, limit })
  }

  dispose() {
    this.disposed = true
    this.stop()
  }
}

/** The instance id stored on a message is the channel field; fall back to its prefix. */
function kindNameOf(message) {
  const value = String(message.channel ?? '')
  return value.includes(':') ? value.slice(0, value.indexOf(':')) : value
}

export { kindNameOf }
