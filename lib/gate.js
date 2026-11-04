/**
 * The code-level admission gate: who may originate work through a Source.
 *
 * This is deliberately *not* a model decision. The allowed list and the admission cells
 * are read from the Source's stored policy configuration, and the only inputs are facts
 * the Source itself produced (`actor`, `human`, `addressed`). A model answer, a message
 * body, or a `meta` field can never widen this gate — `meta` is untrusted data and is
 * not even passed in.
 *
 * v3 adds the semantic assessment layer on top; this module stays the deterministic
 * first layer that a bad model answer cannot bypass.
 */

/** Outcomes the gate can return. `accepted` is required before work may start. */
export const GATE = Object.freeze({
  /** On the allowed list, and the message actually addresses the agent. */
  EXPLICIT: 'explicit',
  /** On the allowed list, or a listed bot: permitted, but not by an explicit request. */
  INFERRED: 'inferred',
  /** Recognized but not permitted to originate work. Recorded, never silently dropped. */
  FILTERED: 'filtered',
})

/** Normalise an identity for comparison; ids compare case-insensitively. */
function sameId(left, right) {
  return String(left ?? '').trim().toLowerCase() === String(right ?? '').trim().toLowerCase()
}

/**
 * Decide whether one Trigger may originate work, from configuration and Trigger facts
 * only.
 *
 * @param {{
 *   policy: { allowed?: Array<{id: string}>, bots?: Array<{id: string}>, row?: string },
 *   trigger: { actor?: string, human: boolean, addressed?: 'mention'|'direct' },
 *   scope: { listened: boolean, observed?: boolean, row?: string, reason?: string },
 * }} input
 * @returns {{ outcome: string, reason?: string }} the gate result; `filtered` never starts work.
 */
export function admit({ policy, trigger, scope }) {
  // 1. Scope first: an event this instance does not receive never reaches assessment.
  if (!scope.listened) {
    return { outcome: GATE.FILTERED, reason: scope.reason ?? 'out_of_scope' }
  }

  // 2. An empty actor (CI, anonymous) may only ever be inferred, never explicit.
  const actor = String(trigger.actor ?? '').trim()
  const allowed = Array.isArray(policy?.allowed) ? policy.allowed : []
  const bots = Array.isArray(policy?.bots) ? policy.bots : []
  const listedPerson = actor !== '' && allowed.some(entry => sameId(entry?.id, actor))
  const listedBot = actor !== '' && bots.some(entry => sameId(entry?.id, actor))

  // 3. A bot is never a person, even if it somehow appears on the allowed list.
  if (!trigger.human) {
    return listedBot
      ? { outcome: GATE.INFERRED, reason: 'listed_bot' }
      : { outcome: GATE.FILTERED, reason: 'bot_not_listed' }
  }

  // 4. A person must be on the list AND the message must address the agent to be
  //    explicit. Merely mentioning a topic is not a request.
  if (listedPerson) {
    return trigger.addressed
      ? { outcome: GATE.EXPLICIT, reason: `addressed_by_${trigger.addressed}` }
      : { outcome: GATE.INFERRED, reason: 'listed_unaddressed' }
  }

  // 5. An unlisted person is refused. Being *observed* (an `all` scope) is what makes an
  //    admission-table decision possible at all, but this plugin's standing rule is
  //    stricter than the reference's table: work only starts for someone on the allowed
  //    list. `meta` is never consulted, and an unlisted sender cannot widen this by
  //    addressing the agent.
  return { outcome: GATE.FILTERED, reason: scope.observed ? 'sender_not_allowlisted' : 'sender_not_allowed' }
}

/** Whether a gate result is allowed to start or continue work. */
export function admitted(outcome) {
  return outcome === GATE.EXPLICIT || outcome === GATE.INFERRED
}
