/**
 * The Source protocol, following the reference project's `docs/008-cookbook.md`.
 *
 * A **kind** is a reusable implementation (`webhook`, later `github`, `feishu`).
 * An **instance** is one configuration of a kind: whether it runs, what it listens to,
 * its own bot identity and its own read position. Instances live in SQLite, so a restart
 * never replays events.
 *
 * Four responsibilities, exactly as the cookbook splits them:
 *   1. translate events into Triggers with stable ids,
 *   2. decide what the instance receives (`scope`) and who may originate work (`policy`),
 *   3. provide replies (`channel`) and Thread context (`threadContext`),
 *   4. maintain its intake loop (`start`).
 */

/**
 * @typedef {object} Trigger
 * @property {string} id            Idempotency key. The same event yields one Trigger.
 * @property {string} threadKey     Primary Thread; its full key is `<kind>:<id>`.
 * @property {string=} actor        Source-native sender id; the allowed list names it.
 * @property {boolean} human        false for bots and CI.
 * @property {'mention'|'direct'=} addressed  Set only when the message addresses the agent.
 * @property {string} text          Untrusted message text.
 * @property {object} meta          Source-specific data. Untrusted: never authorization.
 * @property {object=} channel      {source, thread, address} for replies.
 * @property {string=} url          Link to the source message.
 * @property {number} at            Event time in epoch milliseconds.
 */

/**
 * @typedef {object} ScopeResult
 * @property {boolean} listened     Whether this instance receives the event at all.
 * @property {boolean=} observed    Whether it also receives unaddressed messages there.
 * @property {string=} row          Admission row id for the gate.
 * @property {string=} reason       Why it was not listened to, for the disposition record.
 */

/**
 * @typedef {object} SourceKind
 * @property {string} kind                              Stable id; prefixes Thread keys.
 * @property {string} title                             Human-readable name.
 * @property {(raw: unknown) => object} parseConfig     Validate instance config; throws.
 * @property {(trigger: Trigger, config: object) => ScopeResult} scope
 * @property {(trigger: Trigger, config: object) => boolean} isOwn
 *           Whether the event was produced by this instance's own bot identity.
 * @property {object=} channel
 * @property {(address: object, config: object) => boolean} channel.allowed
 * @property {(host: object, message: object) => Promise<'sent'|'gone'>} channel.send
 * @property {(trigger: Trigger, config: object) => string} channel.threadKeyOf
 * @property {object=} intake                           How the kind receives events.
 * @property {(host: object, instance: object, signal: AbortSignal) => Promise<void>} intake.start
 */

/** A registered kind must provide translation, scope and identification. */
export function assertSourceKind(kind) {
  const required = ['kind', 'title', 'parseConfig', 'scope', 'isOwn']
  for (const field of required) {
    if (typeof kind?.[field] !== (field === 'kind' || field === 'title' ? 'string' : 'function')) {
      throw new Error(`source kind "${kind?.kind ?? '(unnamed)'}" is missing ${field}`)
    }
  }
  if (kind.channel) {
    for (const field of ['allowed', 'send', 'threadKeyOf']) {
      if (typeof kind.channel[field] !== 'function') throw new Error(`source kind "${kind.kind}" channel is missing ${field}`)
    }
  }
  return kind
}

/** The registry of kinds. Kinds are code; instances are rows in SQLite. */
export class SourceRegistry {
  constructor() {
    /** @type {Map<string, SourceKind>} */
    this.kinds = new Map()
  }

  /** Register a kind; returns the disposer, so it lives inside a Cordis effect. */
  register(kind) {
    assertSourceKind(kind)
    if (this.kinds.has(kind.kind)) throw new Error(`source kind "${kind.kind}" is already registered`)
    this.kinds.set(kind.kind, kind)
    return () => { this.kinds.delete(kind.kind) }
  }

  get(name) {
    return this.kinds.get(String(name ?? ''))
  }

  list() {
    return [...this.kinds.values()]
  }

  /** Validate an instance's stored config through its kind. */
  parseConfig(kindName, raw) {
    const kind = this.get(kindName)
    if (!kind) throw new Error(`unknown source kind "${kindName}"`)
    return kind.parseConfig(raw ?? {})
  }
}

/** A stable Thread key from the Source's own id. */
export function threadKey(kind, id) {
  return `${kind}:${id}`
}

/** A stable Trigger id: `<kind>:<source event id>`. */
export function triggerId(kind, eventId) {
  return `${kind}:${eventId}`
}
