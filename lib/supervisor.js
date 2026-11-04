/**
 * The supervisor: worker sessions, worker slots, direct-through delivery and the
 * watchdog probe.
 *
 * It owns every DSH Session dsh-concierge creates and is the only component that
 * talks to the Host's session API. The Router layer never touches a worker
 * directly; it files a Ticket and asks this module to (re)launch.
 */
import { mkdir } from 'node:fs/promises'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { TICKET_STATES } from './state.js'
import { clip, digest, summarize, blocksText } from './text.js'
import { markOnce, isMarked, EXTERNAL_MARKER } from './untrusted.js'
import { workerSessionId } from './identity.js'
import { WORKER_RULES } from './handover.js'

/** Marks a message dsh-concierge injected, so workers tell it apart from a person. */
export const SOURCE = 'dsh-concierge'

/** Drop undefined keys so every tool result is lossless JSON. */
export function jsonSafe(value) {
  if (value === undefined) return null
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(jsonSafe)
  const out = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue
    out[key] = jsonSafe(entry)
  }
  return out
}

export class Supervisor {
  /**
   * @param {{
   *   ctx: any,
   *   state: import('./state.js').State,
   *   config: { stateDir: string, concurrency: number, workerPreset?: string,
   *             routerSessionId: string, watchdogIntervalMs: number,
   *             idleFailMs: number, loopRepeatLimit: number, inlineChars: number },
   *   logger: any,
   * }} options
   */
  constructor({ ctx, state, config, logger }) {
    this.ctx = ctx
    this.state = state
    this.config = config
    this.logger = logger
    /** ticket id -> launch bookkeeping; presence means the worker holds a slot. */
    this.slots = new Map()
    this.disposed = false
    this.watchdogTimer = undefined
    this.pumping = false
    this.observed = []
    this.probeHistory = []
    /** In-flight launches, so a caller can wait for the workers to be up. */
    this.launches = new Set()
    /**
     * Terminal tickets whose report was already relayed. A worker that reports twice in
     * one turn must not deliver the same answer twice: the first terminal report is the
     * operator's notification, later ones are absorbed.
     */
    this.announced = new Set()
    /** Coalesced progress notices: one pending notice per ticket, latest summary wins. */
    this.pendingProgress = new Map()
    this.progressTimer = undefined
  }

  /**
   * Buffer a non-terminal notice per ticket and flush once, so a worker that reports
   * `progress` five times produces one message instead of five.
   */
  queueProgress(ticketId, payload) {
    this.pendingProgress.set(ticketId, payload)
    if (this.progressTimer !== undefined) return
    this.progressTimer = setTimeout(() => {
      this.progressTimer = undefined
      void this.flushProgress()
    }, 400)
    this.progressTimer.unref?.()
  }

  /** Send every buffered progress notice, newest summary per ticket. */
  async flushProgress() {
    const batch = [...this.pendingProgress.entries()]
    this.pendingProgress.clear()
    for (const [ticketId, payload] of batch) {
      await this.deliverToRouter(
        JSON.stringify(payload),
        `concierge:progress:${ticketId}:${digest(payload.summary)}`,
        ticketId,
      ).catch(() => {})
    }
  }

  /** Wait until every launch started so far has settled. Used by tests and shutdown. */
  async settle() {
    while (this.launches.size > 0) await Promise.allSettled([...this.launches])
  }

  get openSlots() {
    return Math.max(0, this.config.concurrency - this.slots.size)
  }

  // ------------------------------------------------------------------ launch

  /**
   * Start every queued ticket that fits, oldest first. Safe to call at any time;
   * concurrent calls collapse into one pump.
   */
  pump() {
    if (this.disposed || this.pumping) return
    const free = this.openSlots
    if (free <= 0) return
    this.pumping = true
    try {
      const claimed = this.state.claimNext(free)
      for (const ticket of claimed) {
        this.slots.set(ticket.id, { startedAt: Date.now(), reported: false, rounds: [] })
        const launch = this.launch(ticket)
          .catch(error => this.fail(ticket.id, error))
          .finally(() => { this.launches.delete(launch) })
        this.launches.add(launch)
      }
    } finally {
      this.pumping = false
    }
  }

  /** Create (or resume) the worker Session for one ticket and deliver its brief. */
  async launch(ticket) {
    const cwd = join(this.config.stateDir, 'agent', ticket.id)
    await mkdir(cwd, { recursive: true })
    const sessionId = ticket.sessionId ?? workerSessionId(ticket.id)
    const agent = await this.ensureSession(sessionId, cwd, ticket.title, 'worker')
    this.state.attachSession(ticket.id, sessionId)
    const brief = this.brief(ticket, cwd)
    const requestId = `concierge:launch:${ticket.id}:${ticket.rounds}`
    await this.prompt(sessionId, requestId, brief)
    this.state.bumpRound(ticket.id)
    this.state.log('worker/launched', ticket.id, sessionId)
  }

  /** The worker's brief: inline recent context, references for the rest. */
  brief(ticket, cwd) {
    const context = this.state.inlineContext(ticket.id)
    // A ticket that has run before is being resumed, not begun: the note keeps the worker
    // from repeating outside effects it may already have performed before a restart.
    const resumed = ticket.rounds > 0 || Boolean(ticket.lastReport)
    const payload = {
      ticket_id: ticket.id,
      title: ticket.title,
      role: 'worker',
      working_directory: cwd,
      ...(resumed
        ? {
          resumed: true,
          note: 'This ticket ran before and is being resumed. Check the working directory and what you already did before repeating any outside action.',
          previous_report_state: ticket.lastReportState ?? 'unknown',
          rounds_so_far: ticket.rounds,
        }
        : {}),
      task: this.state.intentText(ticket),
      ...(this.state.ticketOrigin(ticket.id) === 'source'
        ? {
          // A Source-backed ticket's task text is external. The marker is written here,
          // before anything is stored or spilled, so truncation cannot hide it.
          external_input: true,
          note: EXTERNAL_MARKER,
        }
        : {}),
      // A reopened ticket's leads are the Router's guesses, not facts. They are repeated
      // here, labelled, because a worker that reads only the brief must still see them as
      // unverified rather than as part of the task.
      ...(Array.isArray(ticket.leads) && ticket.leads.length > 0
        ? {
          unverified_leads: ticket.leads,
          leads_note: '【待核实线索】以上是上游的观察，可能错误。动手前先自行复现核实，不要当成需求。',
        }
        : {}),
      ...(ticket.reopenedFrom ? { reopened_from: ticket.reopenedFrom } : {}),
      // Messages a person added after the ticket existed are instructions, not chatter.
      ...(() => {
        const operators = context.recent.filter(entry => entry.role === 'operator')
        return operators.length > 0 ? { operator_instructions: operators } : {}
      })(),
      recent_messages: context.recent,
      earlier_messages: context.folded,
      rules: [
        'You own this single task. Work in the working directory above.',
        'You do not talk to the operator. Every result, question and blocker goes to superagent_report.',
        // The template from `handover.js`: the only exit, the first progress, and evidence.
        ...WORKER_RULES,
        `Use state "done" when the task is finished, "blocked" or "failed" when you cannot continue, and "progress" only for a checkpoint while you keep working.`,
        // The original request may already have been superseded: an operator message that
        // changed the task outranks it, and "waiting for confirmation" is not a result.
        'Operator messages after the task statement are the current instruction. If one changes the task, do that instead of the original wording.',
        'If you have what you need, do the work now. Do not report done for a task you left undone, and do not keep waiting once a confirmation has arrived.',
        'Keep summaries short. Long artifacts belong in files inside the working directory, referenced by path.',
      ],
    }
    const text = JSON.stringify(payload, null, 2)
    return text.length > this.config.inlineChars
      ? JSON.stringify({ ticket_id: ticket.id, title: ticket.title, brief_ref: `blob:${this.state.spill(text, summarize(ticket.title))}`, read_with: 'superagent_read' }, null, 2)
      : text
  }

  // ------------------------------------------------------------------ session

  /**
   * Resolve a live Agent, creating the Session when it does not exist yet.
   * `sessionController.resolveAgent` resumes a persisted Session, which is what makes
   * "the session is lost, the state is not" work after a restart.
   */
  async ensureSession(sessionId, cwd, title, role) {
    const live = this.ctx.agents.get(sessionId)
    if (live) return live
    const resolved = await this.ctx.sessionController.resolveAgent(sessionId)
    if ('error' in resolved) {
      if (resolved.error.code !== 'session/not-found') throw resolved.error
      const preset = role === 'worker'
        ? this.config.workerPreset
        : role === 'router' ? this.config.routerPreset : this.config.inspectorPreset
      /** @type {Record<string, unknown>} */
      const request = { sessionId, cwd }
      if (preset) request.agentPreset = preset
      await this.ctx.sessionController.create(request)
      const again = await this.ctx.sessionController.resolveAgent(sessionId)
      if ('error' in again) throw again.error
      try { await this.ctx.sessionController.rename({ sessionId, title }) } catch { /* titles are cosmetic */ }
      return again.agent
    }
    return resolved.agent
  }

  /**
   * Deliver one text message. `queue` starts a turn when the worker is idle, and the
   * caller's abort signal owns the call only until the inbox accepts it.
   */
  async prompt(sessionId, requestId, text, signal = undefined) {
    await this.ctx.sessionController.prompt({
      requestId,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
      clientTimeZone: 'Asia/Shanghai',
    }, signal ?? new AbortController().signal)
  }

  // ----------------------------------------------------------------- delivery

  /**
   * `superagent_send`: hand a follow-up to the worker that owns the ticket.
   * This is the direct-through path and never re-enters Router assessment.
   */
  async send(ticketId, text) {
    const ticket = this.state.getTicket(ticketId)
    if (!ticket) return { ok: false, reason: 'unknown-ticket', message: `no ticket "${ticketId}"` }
    if (ticket.status === 'done' || ticket.status === 'failed') {
      return { ok: false, reason: 'closed-ticket', message: `ticket ${ticketId} is ${ticket.status}; ask again to open new work` }
    }
    this.state.appendMessage(ticketId, 'operator', text, { requestId: `concierge:send:${randomUUID().slice(0, 8)}` })
    if (ticket.status === 'queued') {
      // No worker yet: the message joins the brief, and the queue decides when it starts.
      return { ok: true, delivery: 'queued', ticket: this.state.getTicket(ticketId), slots: this.openSlots }
    }
    if (!ticket.sessionId) {
      this.state.requeue(ticketId)
      this.pump()
      return { ok: true, delivery: 'relaunched', ticket: this.state.getTicket(ticketId) }
    }
    await this.prompt(ticket.sessionId, `concierge:send:${ticketId}:${randomUUID().slice(0, 8)}`, text)
    this.state.log('worker/send', ticketId, summarize(text, 80))
    return { ok: true, delivery: 'delivered', ticket: this.state.getTicket(ticketId), slots: this.openSlots }
  }

  /**
   * `superagent_report`: the worker's only way out. Records the report, releases the
   * slot, and relays to the Router so the Router answers the operator once.
   */
  async report(ticketId, { summary, state: reportState = 'progress', next = undefined, workspace = undefined }) {
    const ticket = this.state.getTicket(ticketId)
    if (!ticket) return { ok: false, reason: 'unknown-ticket', message: `no ticket "${ticketId}"` }
    // A closed ticket accepts no more reports: the first terminal report is the record,
    // and a later one from the same turn must not rewrite it.
    if (ticket.status === 'done' || ticket.status === 'failed') {
      return {
        ok: false,
        reason: 'closed-ticket',
        message: `ticket ${ticketId} is already ${ticket.status}; stop reporting and end your turn`,
        ticket_status: ticket.status,
      }
    }
    const updated = this.state.report(ticketId, { summary, state: reportState, next, workspace })
    const slot = this.slots.get(ticketId)
    if (slot) slot.reported = true
    // A report decides the ticket's own state; the Executor is outside the domain, exactly
    // as the reference model says, so the ticket never follows the Session's liveness.
    if (reportState === 'done') {
      this.state.setStatus(ticketId, 'done')
    } else if (reportState === 'failed') {
      this.state.setStatus(ticketId, 'failed', { failure: summary })
    } else if (reportState === 'blocked') {
      // Blocked keeps the ticket open but frees its slot: nobody is making progress. A
      // ticket that keeps blocking is not waiting any more — it is stuck, and the operator
      // must be told rather than the queue retried forever.
      const retries = this.state.bumpBlockedRetry(ticketId)
      if (retries >= this.config.blockedRetries) {
        const failure = `blocked ${retries} times in a row; last reason: ${summarize(summary, 300)}`
        this.state.setStatus(ticketId, 'failed', { failure })
        this.state.log('ticket/blocked-limit', ticketId, failure)
        this.slots.delete(ticketId)
        this.pump()
        await this.deliverToRouter(
          JSON.stringify({
            kind: 'ticket_failed',
            ticket_id: ticketId,
            title: updated.title,
            error: failure,
            blocked_retries: retries,
            limit: this.config.blockedRetries,
            note: 'This ticket kept asking to be unblocked without progress and was closed. Respond to its question, then file new work.',
          }),
          `concierge:blocked-limit:${ticketId}:${digest(failure)}`,
          ticketId,
        ).catch(() => {})
        return { ok: true, ticket: this.state.getTicket(ticketId), slots: this.openSlots, closed_by: 'blocked-limit' }
      }
      this.state.setStatus(ticketId, 'queued')
    } else if (reportState === 'progress') {
      // Progress on an unblocked ticket resets the blocked streak: it is moving again.
      this.state.resetBlockedRetry(ticketId)
    }
    if (reportState !== 'progress') {
      this.slots.delete(ticketId)
      this.pump()
    }
    const payload = {
      kind: 'worker_report',
      ticket_id: ticketId,
      title: updated.title,
      state: reportState,
      summary,
      next,
      workspace,
      ticket_status: this.state.getTicket(ticketId)?.status,
    }
    if (reportState === 'progress') {
      // Progress is a checkpoint, not news: coalesce it so five checkpoints become one.
      this.queueProgress(ticketId, payload)
    } else if (this.announced.has(ticketId)) {
      // The terminal answer was already relayed; a second one is the same answer.
      this.state.log('report/suppressed', ticketId, summarize(summary, 60))
    } else {
      this.announced.add(ticketId)
      await this.deliverToRouter(
        JSON.stringify(payload),
        `concierge:report:${ticketId}:${digest(summary)}`,
        ticketId,
      )
    }
    return { ok: true, ticket: this.state.getTicket(ticketId), slots: this.openSlots }
  }

  /** Release a ticket's worker slot without a report; used when a Source closes its Thread. */
  releaseSlot(ticketId) {
    this.slots.delete(ticketId)
    this.pump()
  }

  /**
   * Step (a) of the lost-worker procedure: ask the worker to report now.
   *
   * This is a *nudge*, not a decision. It records that it asked, so the watchdog can tell
   * "we already asked once" from "nobody has asked yet" and grant the corresponding grace.
   */
  async requestStatus(ticketId) {
    const ticket = this.state.getTicket(ticketId)
    if (!ticket) return { ok: false, reason: 'unknown-ticket', message: `no ticket "${ticketId}"` }
    if (ticket.status === 'done' || ticket.status === 'failed') {
      return { ok: false, reason: 'closed-ticket', message: `ticket ${ticketId} is ${ticket.status}`, ticket_status: ticket.status }
    }
    if (!ticket.sessionId) {
      return { ok: false, reason: 'no-worker', message: `ticket ${ticketId} has no worker session yet`, ticket_status: ticket.status }
    }
    const nudge = '立即调用 superagent_report 汇报当前状态，无论完成与否。'
    try {
      await this.prompt(ticket.sessionId, `concierge:status:${ticketId}:${Date.now()}`, nudge)
    } catch (error) {
      this.state.log('worker/status-failed', ticketId, String(error?.message ?? error))
      return { ok: false, reason: 'delivery-failed', message: String(error?.message ?? error) }
    }
    this.state.markNudged(ticketId)
    this.state.log('worker/status-requested', ticketId, 'lost-worker procedure step (a)')
    return {
      ok: true,
      ticket_id: ticketId,
      nudged: true,
      ticket_status: ticket.status,
      round: ticket.rounds,
      last_report: ticket.lastReportState ?? null,
      message: '已催报。若一个巡检周期后仍无汇报，用 superagent_send 再提醒一次，之后才考虑重开。',
    }
  }

  /**
   * Observe the worker directory for evidence of work.
   *
   * A signature is the sorted `path:size:mtime` of the ticket's own directory. It is
   * compared with the previous probe: any difference means the worker wrote, moved or
   * touched something, which is real progress even when the ticket row says nothing.
   *
   * This never finishes a ticket and never replaces a report: it only keeps the watchdog
   * from killing a worker that is demonstrably working.
   */
  async artifactSignal(ticket) {
    const dir = join(this.config.stateDir, 'agent', ticket.id)
    let entries = []
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return { signature: '', changed: false, detail: 'no working directory yet' }
    }
    const stats = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      try {
        const info = await stat(join(dir, entry.name))
        stats.push(`${entry.name}:${info.size}:${Math.round(info.mtimeMs)}`)
      } catch { /* a file that vanished mid-scan is not an error */ }
    }
    stats.sort()
    const signature = stats.join('|')
    const previous = this.artifactSignatures?.get(ticket.id)
    this.artifactSignatures ??= new Map()
    this.artifactSignatures.set(ticket.id, signature)
    const changed = previous !== undefined && previous !== signature
    return {
      signature,
      changed,
      detail: `${stats.length} file(s), ${changed ? 'changed since last probe' : 'unchanged'}`,
    }
  }

  /** Ask a ticket's worker to report, as step (a) of the lost-worker procedure. */
  async nudge(ticket, reason) {
    if (!ticket.sessionId) return false
    const text = '立即调用 superagent_report 汇报当前状态，无论完成与否。'
    try {
      await this.prompt(ticket.sessionId, `concierge:nudge:${ticket.id}:${Date.now()}`, text)
      this.state.markNudged(ticket.id)
      this.state.log('watchdog/nudged', ticket.id, reason)
      return true
    } catch (error) {
      this.state.log('watchdog/nudge-failed', ticket.id, String(error?.message ?? error))
      return false
    }
  }

  /** Mark a ticket failed and tell the Router; used for launch and stream failures. */
  async fail(ticketId, error) {
    if (this.disposed) return
    const message = String(error?.message ?? error)
    try {
      this.state.setStatus(ticketId, 'failed', { failure: message })
    } catch {
      // The state may already be closed during teardown; the failure is still logged.
      this.logger?.warn?.(`dsh-concierge could not record failure for ${ticketId}: ${message}`)
      return
    }
    this.slots.delete(ticketId)
    this.pump()
    if (this.announced.has(ticketId)) return
    this.announced.add(ticketId)
    await this.deliverToRouter(
      JSON.stringify({ kind: 'ticket_failed', ticket_id: ticketId, error: message }),
      `concierge:failed:${ticketId}:${digest(message)}`,
      ticketId,
    ).catch(() => {})
  }

  /**
   * Send one prompt to a Session and return the text of the answer that turn produced.
   *
   * This is how the assessor asks a question: a small dedicated Session, one prompt, one
   * answer, no tool use advertised beyond what its preset has. It waits for `turn/end` by
   * observing `session/event` on that exact Session, and gives up after `timeoutMs` so a
   * stuck assessor cannot stall intake.
   */
  async askOnce(sessionId, requestId, prompt, timeoutMs = 60_000) {
    const agent = this.ctx.agents.get(sessionId)
    if (!agent) throw new Error(`assessor Session "${sessionId}" is not live`)
    const session = agent.session
    const done = Promise.withResolvers()
    let lastAnswer = ''
    const off = this.ctx.on('session/event', (eventSession, event) => {
      if (eventSession.id !== session.id) return
      if (event.type === 'assistant/message') {
        const text = blocksText(event.data?.message?.content)
        if (text.trim() !== '') lastAnswer = text
      }
      if (event.type === 'turn/end') done.resolve(event.data?.reason?.kind ?? 'completed')
    })
    const timer = setTimeout(() => done.resolve('timeout'), timeoutMs)
    timer.unref?.()
    try {
      await this.prompt(sessionId, requestId, prompt)
      await done.promise
    } finally {
      clearTimeout(timer)
      try { off() } catch { /* already released */ }
    }
    return lastAnswer
  }

  /** Deliver a Router-facing notice to the Session that filed the work, if it is live. */
  async deliverToRouter(text, requestId, ticketId = undefined) {
    const ticket = ticketId ? this.state.getTicket(ticketId) : undefined
    const targetId = ticket?.routerSession ?? this.config.routerSessionId
    const agent = this.ctx.agents.get(targetId)
    if (!agent) {
      this.logger?.debug?.(`dsh-concierge notice held for ${targetId}: session is not live`)
      return
    }
    try {
      await this.prompt(targetId, requestId, text)
    } catch (error) {
      this.logger?.warn?.(`dsh-concierge could not deliver notice to ${targetId}: ${String(error)}`)
    }
  }

  /** Start the periodic inspection; one timer for the plugin's lifetime. */
  startWatchdog() {
    if (this.watchdogTimer !== undefined || this.disposed) return
    const tick = () => {
      this.inspect().catch(error => this.logger?.warn?.(`dsh-concierge watchdog failed: ${String(error)}`))
    }
    this.watchdogTimer = setInterval(tick, this.config.watchdogIntervalMs)
    // Do not hold the process open for the probe alone.
    this.watchdogTimer.unref?.()
  }

  stopWatchdog() {
    if (this.watchdogTimer !== undefined) {
      clearInterval(this.watchdogTimer)
      this.watchdogTimer = undefined
    }
  }

  /**
   * One inspection round: infrastructure first, then real progress per running worker.
   * A worker that is alive but has produced nothing new across the repeat limit is
   * failed, because "the process answers" is not "the task advances".
   */
  async inspect() {
    const health = this.state.probe()
    const running = this.state.listTickets({ status: 'open', limit: 50 }).filter(ticket => ticket.status === 'running')
    const findings = []
    const now = Date.now()
    for (const ticket of running) {
      const slot = this.slots.get(ticket.id)
      if (!slot) {
        findings.push({ ticket_id: ticket.id, verdict: 'orphaned', detail: 'running without a worker slot' })
        continue
      }
      const agent = this.ctx.agents.get(ticket.sessionId ?? '')
      // A worker running a turn is *working*, whatever its ticket row says: a long edit, a
      // big file write or a slow model call changes no ticket state until the report at the
      // end. Killing it for "no state change" interrupts exactly the work that was asked
      // for — which is the bug this flag now prevents.
      const busy = agent?.status === 'running'
      // Artifact signal: a worker that is writing files is progressing even when its ticket
      // row is unchanged. This is *evidence*, not a verdict — the report contract stays the
      // final authority, so it can hold off a failure but never finish a ticket.
      const artifacts = await this.artifactSignal(ticket)
      const record = {
        digest: ticket.digest,
        at: now,
        rounds: ticket.rounds,
        report: ticket.lastReportState ?? 'none',
        busy,
        files: artifacts.signature,
      }
      slot.history ??= []
      slot.history.push(record)
      if (slot.history.length > 6) slot.history.shift()
      const repeats = countTrailingRepeats(slot.history)
      const silentFor = now - (slot.history.at(-1 - repeats)?.at ?? now)

      // A ticket whose worker has changed files since the previous probe is making progress,
      // whatever its row says. Record the basis so the log explains every decision.
      const movedFiles = artifacts.changed
      if (movedFiles) {
        this.state.log('watchdog/artifact-progress', ticket.id, artifacts.detail)
        slot.history.length = 1
      }

      // Only an *idle* streak can be stuck. A busy probe is not evidence of a loop, so a
      // worker that spends several probes mid-turn is never failed for it.
      const stalled = !busy && !movedFiles && repeats >= this.config.loopRepeatLimit
      const silent = !busy && !movedFiles && silentFor >= this.config.idleFailMs

      if (stalled || silent) {
        const detail = stalled
          ? `no state change across ${repeats} idle probes (rounds=${ticket.rounds}, report=${record.report})`
          : `idle worker with no new output for ${Math.round(silentFor / 1000)}s`

        // Before failing anything, ask the worker to report and grant one inspection period.
        // This is the step that was missing in production: a worker that finished its work
        // but never reported was failed outright, and the Router then verified the artifact
        // itself and got it wrong.
        const nudged = this.state.nudgedAt(ticket.id)
        const graceOpen = nudged !== undefined && now - nudged < this.config.watchdogIntervalMs
        if (graceOpen) {
          findings.push({ ticket_id: ticket.id, verdict: 'nudged', detail: `${detail}; report requested ${Math.round((now - nudged) / 1000)}s ago, still inside the grace period` })
          continue
        }
        if (nudged === undefined) {
          // Step (a) automatically: nudge now, judge next round.
          await this.nudge(ticket, detail)
          findings.push({ ticket_id: ticket.id, verdict: 'nudged', detail: `${detail}; report requested now` })
          continue
        }
        const reason = `watchdog: ${detail}; superagent_report was requested ${Math.round((now - nudged) / 1000)}s ago and no report arrived`
        this.state.log('watchdog/failed-after-nudge', ticket.id, reason)
        await this.fail(ticket.id, new Error(reason))
        findings.push({ ticket_id: ticket.id, verdict: 'failed', detail: reason })
        continue
      }
      findings.push({
        ticket_id: ticket.id,
        verdict: 'healthy',
        detail: `${busy ? 'busy' : 'idle'}, repeats=${repeats}${movedFiles ? `, files changed (${artifacts.detail})` : ''}`,
      })
    }
    const round = { at: now, health, findings, slots: { used: this.slots.size, limit: this.config.concurrency } }
    this.probeHistory.push(round)
    if (this.probeHistory.length > 20) this.probeHistory.shift()
    this.state.log('watchdog/probe', null, `${findings.filter(f => f.verdict === 'failed').length} failed of ${findings.length}`)
    const problems = findings.filter(finding => finding.verdict !== 'healthy')
    if (problems.length > 0 || !health.ok) {
      await this.deliverToRouter(
        JSON.stringify({ kind: 'watchdog', health, problems, slots: round.slots }),
        `concierge:watchdog:${now}`,
      ).catch(() => {})
    }
    return round
  }

  /** Shutdown: stop the probe, drain launches and buffered notices, drop slots. */
  async dispose() {
    this.disposed = true
    this.stopWatchdog()
    if (this.progressTimer !== undefined) {
      clearTimeout(this.progressTimer)
      this.progressTimer = undefined
    }
    this.pendingProgress.clear()
    await this.settle()
    this.slots.clear()
  }
}

/**
 * How many trailing probes show the exact same ticket digest.
 * One repeat is normal (the worker is mid-turn); several in a row is a loop.
 */
function countTrailingRepeats(history) {
  if (history.length === 0) return 0
  const last = history.at(-1).digest
  let repeats = 0
  for (let index = history.length - 2; index >= 0; index--) {
    if (history[index].digest !== last) break
    repeats++
  }
  return repeats
}

export { TICKET_STATES, clip, summarize }
