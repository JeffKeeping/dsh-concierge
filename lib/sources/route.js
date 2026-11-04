/**
 * The webhook intake route: one HTTP callback per Source instance.
 *
 * The route is thin on purpose. It authenticates, hands the parsed body to `Intake`, and
 * answers. Everything that matters — translation, the gate, idempotency, cursor movement,
 * fan-out — happens in the Source-agnostic layer, so a second kind needs no route logic.
 *
 * `POST <endpoint>?instance=<id>` with a JSON body:
 *   { id, conversation, sender, text, thread?, bot?, mentions?, addressed?, at?, url?, seq? }
 *
 * Answers:
 *   202 { outcome: 'stored' | 'filtered' | 'duplicate' | 'own', trigger_id?, ticket_ids[] }
 *   400 malformed body        401 bad token        404 unknown instance
 */
import { readBody, sendJson } from './http.js'

/**
 * Register the route for every enabled webhook instance.
 *
 * @param {{ ctx: any, state: any, intake: any, logger: any, registry?: any }} options
 * @returns {{ dispose: () => void, reload: () => void }} disposer plus a hot reload
 */
export function registerWebhookRoutes({ ctx, state, intake, logger, registry = undefined }) {
  let disposers = []
  /** Paths currently mounted, so a reload only adds what is missing. */
  const mounted = new Map()

  const mount = instance => {
    if (mounted.has(instance.config.endpoint)) return
    const config = instance.config
    const path = config.endpoint
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path,
      async handler(req, res) {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method-not-allowed' })
        let body
        try {
          body = await readBody(req, 1_000_000)
        } catch (error) {
          return sendJson(res, 400, { error: 'bad-body', detail: String(error?.message ?? error) })
        }
        // Authentication is configuration, never a Trigger field, so a forged body cannot
        // widen who may ask for work. The kind owns the check so a new kind brings its own.
        const live = state.getSource(instance.id) ?? instance
        const kind = registry?.get(live.kind) ?? { authorizes: () => true }
        if (typeof kind.authorizes === 'function' && !kind.authorizes(body, live.config ?? {})) {
          return sendJson(res, 401, { error: 'unauthorized' })
        }
        try {
          // One HTTP callback is a round of one event. Going through `receiveBatch` means
          // the cursor is committed by the same code path as a polled round, so the read
          // position is real and a restart resumes rather than replays.
          const round = await intake.receiveBatch(live, [body], event => event?.seq)
          const result = round.outcomes[0] ?? { outcome: 'filtered', ticketIds: [] }
          return sendJson(res, result.outcome === 'stored' ? 202 : 200, {
            outcome: result.outcome,
            trigger_id: result.triggerId,
            ticket_ids: result.ticketIds ?? [],
            cursor: round.cursor ?? null,
          })
        } catch (error) {
          logger?.warn?.(`dsh-concierge webhook ${instance.id} failed: ${String(error)}`)
          return sendJson(res, 500, { error: 'intake-failed', detail: String(error?.message ?? error) })
        }
      },
    })
    mounted.set(path, { dispose, instanceId: instance.id })
    disposers.push(dispose)
  }

  for (const instance of state.listSources('webhook')) {
    if (instance.enabled) mount(instance)
  }

  return {
    /** Add routes for instances created since the last call. */
    reload() {
      for (const instance of state.listSources('webhook')) {
        if (instance.enabled) mount(instance)
      }
    },
    dispose() {
      for (const dispose of disposers.splice(0)) { try { dispose() } catch { /* gone */ } }
      mounted.clear()
    },
  }
}
