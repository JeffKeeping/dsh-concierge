/**
 * The tool surface: the only four tools the operator's Session sees.
 *
 * `ask` and `send` are the Router's entries, `read` is the continuation entry for
 * spilled context, and `report` is the worker's only exit. Each tool returns a plain
 * JSON value and renders it as one text block, so the JSON is also what the model
 * reads.
 */
import { summarize } from './text.js'
import { jsonSafe } from './supervisor.js'
import { requireRouter, requireWorkerOf, checkReadRef } from './identity.js'
/** @param {{ name: string, description: string, parameters: object, run: (args: any, exec: any) => Promise<unknown> }} spec */
function define({ name, description, parameters, run }) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    execute: async (args, exec) => jsonSafe(await run(args ?? {}, exec)),
  }
}

/**
 * Build the tool definitions.
 * @param {{ router: import('./router.js').Router, supervisor: import('./supervisor.js').Supervisor,
 *           state: import('./state.js').State, channels?: import('./channels.js').Channels,
 *           intake?: import('./sources/intake.js').Intake }} services
 */
export function tools({ router, supervisor, state, channels = undefined, intake = undefined }) {
  const ask = define({
    name: 'superagent_ask',
    description: [
      'Submit a request to the super-agent. A Router decides whether it joins an existing ticket thread or opens a new ticket,',
      'and a worker does the work in its own directory. Returns routing facts; answer the operator in one short message.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The request, in the operator\'s own words.' },
        title: { type: 'string', description: 'Optional short ticket title; derived from the request when omitted.' },
        ticket_id: { type: 'string', description: 'Attach this request to a known ticket instead of routing it.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async run(args, exec) {
      requireRouter({ exec, state })
      if (typeof args.text !== 'string' || args.text.trim() === '') throw new Error('text is required')
      const result = await router.ask({
        text: args.text,
        title: args.title,
        ticketId: args.ticket_id,
        caller: exec?.agent?.id,
      })
      return { ...result, overview: router.overview() }
    },
  })

  const send = define({
    name: 'superagent_send',
    description: 'Send a follow-up to the worker of an existing ticket. It goes straight to that worker; the Router does not re-assess it.',
    parameters: {
      type: 'object',
      properties: {
        ticket_id: { type: 'string', description: 'Ticket to continue.' },
        text: { type: 'string', description: 'The follow-up message.' },
      },
      required: ['ticket_id', 'text'],
      additionalProperties: false,
    },
    async run(args, exec) {
      requireRouter({ exec, state })
      if (typeof args.ticket_id !== 'string' || args.ticket_id.trim() === '') throw new Error('ticket_id is required')
      if (typeof args.text !== 'string' || args.text.trim() === '') throw new Error('text is required')
      return supervisor.send(args.ticket_id, args.text)
    },
  })

  /**
   * `superagent_status`: the first step of the lost-worker procedure.
   *
   * It asks the worker to report, and records that it asked. It never decides anything
   * itself: the watchdog does the escalation, and a ticket is only reopened after all three
   * steps of the procedure have run out.
   */
  const status = define({
    name: 'superagent_status',
    description: [
      'Ask a worker to report its current state now. This is step (a) of the lost-worker procedure:',
      'use it before ever considering a reopen, then superagent_send as step (b), and only then step (c).',
      'It sends a nudge and returns what the ticket currently shows.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        ticket_id: { type: 'string', description: 'Ticket whose worker should report.' },
      },
      required: ['ticket_id'],
      additionalProperties: false,
    },
    async run(args, exec) {
      requireRouter({ exec, state })
      if (typeof args.ticket_id !== 'string' || args.ticket_id.trim() === '') throw new Error('ticket_id is required')
      return supervisor.requestStatus(args.ticket_id)
    },
  })

  /**
   * `superagent_reopen`: step (c), and only step (c).
   *
   * It refuses unless the earlier steps are on record for that ticket. The refusals name the
   * missing step, so the Router learns the procedure rather than guessing at it.
   */
  const reopen = define({
    name: 'superagent_reopen',
    description: [
      'Reopen a stalled ticket as a fresh ticket with a handover. This is step (c): it refuses',
      'unless superagent_status and then superagent_send have both happened for that ticket.',
      'Anything you pass as a lead is stored as 【待核实线索】 and the new worker is told to',
      'reproduce it before acting.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        ticket_id: { type: 'string', description: 'The stalled ticket to reopen.' },
        leads: {
          type: 'array',
          description: 'Unverified observations for the new worker. Never phrased as requirements.',
          items: { type: 'string' },
        },
        task: { type: 'string', description: 'Optional restatement of the task; defaults to the original request.' },
      },
      required: ['ticket_id'],
      additionalProperties: false,
    },
    async run(args, exec) {
      requireRouter({ exec, state })
      if (typeof args.ticket_id !== 'string' || args.ticket_id.trim() === '') throw new Error('ticket_id is required')
      const leads = Array.isArray(args.leads) ? args.leads.filter(lead => typeof lead === 'string') : []
      return router.reopen({ ticketId: args.ticket_id, leads, task: args.task })
    },
  })

  const read = define({
    name: 'superagent_read',
    description: 'Read long content held by reference: ticket:<id>, thread:<key>, blob:<id>, msg:<id> or report:<ticket id>. Use it instead of guessing what a reference holds. A worker may only read references of its own ticket; `follow: true` walks the reference chain.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Reference id, for example blob:1a2b3c4d.' },
        offset: { type: 'number', description: 'Character offset to start from; default 0.' },
        limit: { type: 'number', description: 'Maximum characters to return; default all remaining.' },
        follow: { type: 'boolean', description: 'Walk one hop of the reference chain and list what this reference was derived from.' },
        hops: { type: 'number', description: 'How many hops to walk when follow is set; default 1, maximum 4.' },
      },
      required: ['ref'],
      additionalProperties: false,
    },
    async run(args, exec) {
      const gate = checkReadRef({ exec, state }, args.ref)
      if (!gate.allowed) throw new Error(`${gate.code}: ${gate.message}`)
      const offset = Number.isFinite(args.offset) ? Math.max(0, Math.floor(args.offset)) : 0
      const limit = Number.isFinite(args.limit) ? Math.max(1, Math.floor(args.limit)) : undefined
      const value = state.readRef(args.ref, offset, limit)
      if (args.follow !== true) return value
      const hops = Number.isFinite(args.hops) ? Math.min(4, Math.max(1, Math.floor(args.hops))) : 1
      return { ...value, chain: state.followRef(args.ref, hops) }
    },
  })

  const report = define({
    name: 'superagent_report',
    description: [
      'Worker exit: report to the Router instead of talking to the operator.',
      'state: progress keeps working, done finishes, blocked or failed asks the Router to step in.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        ticket_id: { type: 'string', description: 'Ticket this worker owns.' },
        summary: { type: 'string', description: 'What happened, in a few sentences.' },
        state: { type: 'string', enum: ['progress', 'done', 'blocked', 'failed'], description: 'Report state; default progress.' },
        next: { type: 'string', description: 'What you will do next, when still working.' },
        workspace: { type: 'string', description: 'Optional path or branch a person should look at.' },
      },
      required: ['ticket_id', 'summary'],
      additionalProperties: false,
    },
    async run(args, exec) {
      if (typeof args.ticket_id !== 'string' || args.ticket_id.trim() === '') throw new Error('ticket_id is required')
      requireWorkerOf({ exec, state }, args.ticket_id)
      if (typeof args.summary !== 'string' || args.summary.trim() === '') throw new Error('summary is required')
      const allowed = new Set(['progress', 'done', 'blocked', 'failed'])
      const reportState = allowed.has(args.state) ? args.state : 'progress'
      return supervisor.report(args.ticket_id, {
        summary: args.summary,
        state: reportState,
        next: args.next,
        workspace: args.workspace,
      })
    },
  })

  return [ask, send, status, read, reopen, report].map(definition => ({
    ...definition,
    description: summarize(definition.description, 900),
  }))
}

/**
 * The v2 visibility tool: what Sources exist, what they last read, which Triggers they
 * filtered and why, and how delivery is doing. Read-only by design — admission is
 * configuration, never a tool call.
 */
export function sourceTool({ state, intake, channels }) {
  return {
    name: 'superagent_sources',
    description: [
      'Inspect Sources, their Triggers and Channel delivery. Read-only.',
      'Shows each Source cursor and health, recent Triggers with their disposition and reason,',
      'and channel messages that are pending, sent or dropped.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Limit Triggers to one Source instance id.' },
        disposition: { type: 'string', enum: ['stored', 'filtered'], description: 'Limit Triggers to one disposition.' },
        limit: { type: 'number', description: 'How many Triggers and messages to return; default 10.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) { return [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    },
    async execute(args, exec) {
      requireRouter({ exec, state })
      const limit = Number.isFinite(args?.limit) ? Math.max(1, Math.min(50, Math.floor(args.limit))) : 10
      const payload = {
        sources: state.listSources().map(source => ({
          id: source.id,
          kind: source.kind,
          enabled: source.enabled,
          cursor: source.cursor ?? null,
          health: source.health ?? null,
          // A fingerprint only: the token value is never in the database or in this view.
          token: source.tokenFingerprint ?? null,
        })),
        triggers: state.listTriggers({ source: args?.source, disposition: args?.disposition, limit }).map(trigger => ({
          id: trigger.id,
          source: trigger.source,
          thread: trigger.threadKey,
          actor: trigger.actor ?? null,
          human: trigger.human,
          addressed: trigger.addressed ?? null,
          disposition: trigger.disposition,
          reason: trigger.reason ?? null,
          text: summarize(trigger.text, 120),
        })),
        channels: channels
          ? {
            pending: state.listChannelMessages({ state: 'pending', limit }).length,
            sent: state.listChannelMessages({ state: 'sent', limit }).length,
            dropped: state.listChannelMessages({ state: 'dropped', limit }).map(message => ({
              id: message.id,
              ticket: message.ticketId,
              reason: message.reason ?? null,
            })),
            recent: channels.status({ limit }),
          }
          : null,
        intake: intake ? { received: intake.received, filtered: intake.filtered, ownDropped: intake.ownDropped } : null,
        // The semantic layer's record: every verdict, its reason and its policy revision.
        decisions: state.listDecisions({ limit }).map(decision => ({
          trigger: decision.triggerId,
          state: decision.state,
          verdict: decision.verdict ?? null,
          reason: decision.reason ?? null,
          policy_revision: decision.policyRevision ?? null,
          gate: decision.gateStrength,
        })),
        policy: { revision: state.currentPolicy().revision, origin: state.currentPolicy().origin },
      }
      return jsonSafe(payload)
    },
  }
}
