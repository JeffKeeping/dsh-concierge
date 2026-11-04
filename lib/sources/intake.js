/**
 * Intake: one event becomes one Trigger, then fans out to the Tickets following its Thread.
 *
 * The order here is the safety contract:
 *
 *   1. translate (a kind's job) → Trigger with a stable id
 *   2. the Source's own messages never enter the domain at all
 *   3. the code-level gate decides admission; a refused event is still *recorded* with
 *      its reason, never silently dropped
 *   4. store the Trigger and move the cursor in one transaction, so an interrupted round
 *      replays instead of losing or double-counting events
 *   5. fan out to live subscribers — a person's message arriving this way skips Router
 *      assessment entirely and goes straight to that worker
 */
import { admit, admitted, GATE } from '../gate.js'
import { externalField, markOnce, EXTERNAL_MARKER } from '../untrusted.js'

export class Intake {
  /**
   * @param {{ state: import('../state.js').State, registry: import('./kind.js').SourceRegistry,
   *           supervisor: object, logger: any }} options
   */
  constructor({ state, registry, supervisor, logger, assessor = undefined }) {
    this.state = state
    this.registry = registry
    this.supervisor = supervisor
    this.logger = logger
    this.assessor = assessor
    this.ownDropped = 0
    this.received = 0
    this.filtered = 0
    this.queuedForAssessment = 0
  }

  /**
   * Take in one event for one Source instance.
   *
   * The cursor is NOT moved here. `receiveBatch` moves it once, after every event of the
   * round is stored — that is the interruption guarantee: a round cut short leaves the
   * cursor where it was, and stable ids make the replay harmless.
   *
   * @returns {Promise<{ outcome: 'stored'|'duplicate'|'filtered'|'own', triggerId?: string,
   *                     ticketIds: string[], cursor?: string }>}
   */
  async receive(instance, event, { cursor = undefined } = {}) {
    const kind = this.registry.get(instance.kind)
    if (!kind) throw new Error(`unknown source kind "${instance.kind}"`)
    const config = instance.config ?? {}

    // 1. Translate. A kind returns undefined for an event it does not model.
    const trigger = await kind.translate(event, { config, botId: instance.botId, instance })
    if (!trigger) {
      this.ownDropped += 1
      this.state.ingestTrigger(
        instance.id,
        {
          id: fallbackTriggerId(instance, event),
          threadKey: `${instance.kind}:unmodelled`,
          text: '',
          human: false,
          at: Date.now(),
          meta: {},
        },
        'filtered',
        { reason: 'unmodelled_event' },
      )
      return { outcome: 'filtered', ticketIds: [], cursor }
    }

    // 2. The Source's own messages produce no Trigger. Recorded, so the count is auditable.
    if (kind.isOwn(trigger, config, instance)) {
      this.ownDropped += 1
      this.state.ingestTrigger(instance.id, trigger, 'filtered', { reason: 'own_message' })
      return { outcome: 'own', triggerId: trigger.id, ticketIds: [], cursor }
    }

    // 3. The deterministic gate. Configuration and Trigger facts only.
    const scope = kind.scope(trigger, config)
    const decision = admit({ policy: policyOf(instance, kind), trigger, scope })
    if (!admitted(decision.outcome)) {
      this.filtered += 1
      this.state.ingestTrigger(instance.id, trigger, 'filtered', { reason: decision.reason })
      return { outcome: 'filtered', triggerId: trigger.id, ticketIds: [], cursor }
    }

    // 4. Store once. The id is the idempotency key.
    const stored = this.state.ingestTrigger(instance.id, trigger, 'stored')
    if (stored.outcome === 'duplicate') {
      return { outcome: 'duplicate', triggerId: trigger.id, ticketIds: [], cursor }
    }
    this.received += 1

    // 5. Route. Directly addressed Triggers, and Threads that already carry a live Ticket,
    //    fan out now. Everything else queues for the semantic layer, which may only
    //    narrow what the gate admitted.
    if (this.assessor) {
      const routing = this.assessor.enqueue(instance, trigger, decision.outcome)
      if (routing.queued) {
        this.queuedForAssessment += 1
        this.state.log('trigger/queued-for-assessment', null, `${trigger.id} (${decision.outcome})`)
        return { outcome: 'stored', triggerId: trigger.id, ticketIds: [], cursor, assessment: 'queued' }
      }
      if (routing.ticketIds.length > 0) {
        const fan = await this.fanOut(instance, trigger, decision.outcome, routing.ticketIds)
        return { outcome: 'stored', triggerId: trigger.id, ticketIds: fan, cursor, assessment: 'live-thread' }
      }
    }

    // 6. Otherwise fan out to every live subscriber. A person's message takes no Router
    //    assessment: it is delivered straight to that worker.
    const ticketIds = await this.fanOut(instance, trigger, decision.outcome)
    return { outcome: 'stored', triggerId: trigger.id, ticketIds, cursor }
  }

  /**
   * Deliver one stored Trigger to the given Tickets, or to every live subscriber.
   * A Ticket that is already running receives it directly; a queued one gets it in its brief.
   */
  async fanOut(instance, trigger, strength, ticketIds = undefined) {
    const targets = ticketIds
      ? ticketIds.map(id => this.state.getTicket(id)).filter(Boolean)
      : this.state.subscribers(trigger.threadKey)
    const delivered = []
    for (const ticket of targets) {
      const text = fanOutText(trigger, strength)
      const result = await this.supervisor.send(ticket.id, text)
      delivered.push(ticket.id)
      this.state.log(
        result.ok ? 'trigger/fanned-out' : 'trigger/fan-out-failed',
        ticket.id,
        `${trigger.id}${result.ok ? '' : `: ${result.reason}`}`,
      )
    }
    return delivered
  }

  /**
   * Feed a whole round from one Source.
   *
   * The cursor is committed ONCE, after the loop, and only when every event in the round
   * was processed without throwing. A crash or a stop mid-round leaves the cursor
   * unchanged, so the next round reads the same events again and the stable ids make that
   * replay a no-op for the ones already stored.
   *
   * @returns {Promise<{ outcomes: object[], cursor: string|undefined, committed: boolean }>}
   */
  async receiveBatch(instance, events, cursorOf) {
    const outcomes = []
    let lastCursor
    try {
      for (const event of events) {
        // Individual failures must not lose the rest of the round: record and continue.
        try {
          outcomes.push(await this.receive(instance, event))
        } catch (error) {
          outcomes.push({ outcome: 'error', error: String(error?.message ?? error), ticketIds: [] })
        }
        lastCursor = cursorOf(event)
      }
    } catch (error) {
      // A failure outside one event (a stop, a broken transport) keeps the cursor.
      return { outcomes, cursor: this.state.sourceCursor(instance.id), committed: false, error: String(error?.message ?? error) }
    }
    this.state.commitRound(instance.id, lastCursor)
    return { outcomes, cursor: lastCursor, committed: true }
  }

  /** Recent dispositions for the panel and for troubleshooting. */
  report(limit = 20) {
    return {
      received: this.received,
      filtered: this.filtered,
      ownDropped: this.ownDropped,
      triggers: this.state.listTriggers({ limit }),
    }
  }
}

/**
 * The policy block for one instance: `allowed` and `bots` come from the stored Source
 * configuration. There is no other input, which is what keeps a model answer from
 * widening admission.
 */
function policyOf(instance, kind) {
  const config = instance.config ?? {}
  const policy = config.policy && typeof config.policy === 'object' ? config.policy : {}
  return {
    allowed: Array.isArray(policy.allowed) ? policy.allowed : [],
    bots: Array.isArray(policy.bots) ? policy.bots : [],
    row: policy.row ?? kind.kind,
  }
}

/** The message a worker receives when a Trigger on its Thread fans out to it. */
function fanOutText(trigger, strength) {
  return JSON.stringify({
    kind: 'trigger',
    trigger_id: trigger.id,
    thread: trigger.threadKey,
    strength,
    from: trigger.actor ?? 'unknown',
    human: trigger.human,
    at: new Date(trigger.at ?? Date.now()).toISOString(),
    url: trigger.url,
    channel: trigger.channel,
    // The marker is inside the persisted text, so it survives blob spill and truncation.
    text: markOnce(trigger.text, { origin: `${trigger.source}:${trigger.threadKey}` }),
    // meta is untrusted data with a machine-readable flag as well as the prose boundary.
    meta: { untrusted: true, note: EXTERNAL_MARKER, value: trigger.meta ?? {} },
    note: EXTERNAL_MARKER,
  })
}

/** A stable id for an event a kind cannot model, so the refusal is still recorded once. */
function fallbackTriggerId(instance, event) {
  const raw = event && typeof event === 'object'
    ? String(event.id ?? event.event_id ?? JSON.stringify(event).slice(0, 64))
    : String(event)
  return `${instance.kind}:unmodelled:${raw}`
}

export { GATE }
