/**
 * dsh-concierge — a two-layer "Super-agent" orchestration plugin for DeepSeek Harness.
 *
 * The operator only ever talks to a Router: `superagent_ask` files work,
 * `superagent_send` continues an existing thread, `superagent_read` follows a
 * reference. Workers are Session-per-ticket, each in its own directory, and they
 * answer through `superagent_report` only. A watchdog probes liveness *and*
 * substantive progress, and SQLite holds every ticket so a restart resumes work
 * instead of losing it.
 *
 * @module dsh-concierge
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdir } from 'node:fs/promises'
import { State } from './lib/state.js'
import { Supervisor } from './lib/supervisor.js'
import { Router } from './lib/router.js'
import { tools, sourceTool } from './lib/tools.js'
import { SourceRegistry } from './lib/sources/kind.js'
import { Intake } from './lib/sources/intake.js'
import { Channels } from './lib/channels.js'
import { registerWebhookRoutes } from './lib/sources/route.js'
import { webhookKind } from './lib/sources/webhook.js'
import { githubKind } from './lib/sources/github.js'
import { watchGithub } from './lib/sources/github-watch.js'
import { Assessor } from './lib/assess.js'
import { ContextSpill } from './lib/context-spill.js'
import { panelSnapshot, registerPanelRoute, PANEL_PATH } from './lib/panel.js'
import { registerRouterPreset, ROUTER_PRESET_ID, ROUTER_PRESET_VERSION } from './lib/preset.js'

export const name = 'dsh-concierge'
/**
 * Host services this plugin touches. `tools` publishes the tools, `agents` resolves live
 * Sessions, `sessionController` creates and resumes worker Sessions, and `webServer`
 * carries the webhook Source's inbound route. All are mounted by the base composition.
 */
export const inject = ['tools', 'agents', 'sessionController']
const DEFAULTS = Object.freeze({
  stateDir: undefined,
  concurrency: 3,
  watchdogIntervalMs: 5 * 60 * 1000,
  routerBatchMs: 800,
  inlineChars: 2400,
  idleFailMs: 20 * 60 * 1000,
  loopRepeatLimit: 3,
  blockedRetries: 3,
  assessorSessionId: 'concierge-assessor',
  assessorTimeoutMs: 60_000,
  assessorTickMs: 60_000,
  assessorBatch: 5,
  deferBaseMs: 15 * 60 * 1000,
  maxDeferrals: 3,
  semanticAssessment: true,
  routerSessionId: 'concierge-router',
  routerPresetId: ROUTER_PRESET_ID,
  workerPreset: undefined,
})

/**
 * Normalise the row's config. Defaults live here rather than in a schema export so an
 * empty row is a working plugin and a partial row never becomes an invalid one.
 */
function normalizeConfig(rawConfig) {
  const input = rawConfig && typeof rawConfig === 'object' ? rawConfig : {}
  const number = (value, fallback, min) => (Number.isFinite(value) && value >= min ? Math.floor(value) : fallback)
  const text = (value, fallback) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback)
  return {
    stateDir: text(input.stateDir, DEFAULTS.stateDir),
    concurrency: number(input.concurrency, DEFAULTS.concurrency, 1),
    watchdogIntervalMs: number(input.watchdogIntervalMs, DEFAULTS.watchdogIntervalMs, 1000),
    routerBatchMs: number(input.routerBatchMs, DEFAULTS.routerBatchMs, 0),
    inlineChars: number(input.inlineChars, DEFAULTS.inlineChars, 200),
    idleFailMs: number(input.idleFailMs, DEFAULTS.idleFailMs, 1000),
    loopRepeatLimit: number(input.loopRepeatLimit, DEFAULTS.loopRepeatLimit, 1),
    blockedRetries: number(input.blockedRetries, DEFAULTS.blockedRetries, 1),
    assessorSessionId: text(input.assessorSessionId, DEFAULTS.assessorSessionId),
    assessorTimeoutMs: number(input.assessorTimeoutMs, DEFAULTS.assessorTimeoutMs, 1000),
    assessorTickMs: number(input.assessorTickMs, DEFAULTS.assessorTickMs, 1000),
    assessorBatch: number(input.assessorBatch, DEFAULTS.assessorBatch, 1),
    deferBaseMs: number(input.deferBaseMs, DEFAULTS.deferBaseMs, 1000),
    maxDeferrals: number(input.maxDeferrals, DEFAULTS.maxDeferrals, 1),
    semanticAssessment: input.semanticAssessment !== false,
    routerSessionId: text(input.routerSessionId, DEFAULTS.routerSessionId),
    routerPresetId: text(input.routerPresetId, DEFAULTS.routerPresetId),
    workerPreset: text(input.workerPreset, DEFAULTS.workerPreset),
  }
}

export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const stateDir = config.stateDir ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-concierge')
  const dbPath = join(stateDir, 'concierge.sqlite')
  const resolved = { ...config, stateDir }
  const logger = ctx.logger ?? console

  const state = new State({ dbPath, inlineChars: config.inlineChars })
  // The supervisor owns worker sessions and the watchdog, and delivers Router notices.
  const supervisor = new Supervisor({ ctx, state, config: resolved, logger })
  const router = new Router({ state, supervisor, config: resolved, logger })

  // v2: Sources, intake, and the Channel write side.
  const registry = new SourceRegistry()
  // v3: the semantic assessment layer. It is wired to a model below when one is available.
  const assessor = new Assessor({ state, registry, logger, config: resolved })
  const intake = new Intake({ state, registry, supervisor, logger, assessor })
  const channels = new Channels({ state, registry, logger, config: resolved })

  // The Router preset: the division-of-labour fix. A general-purpose Session builds the
  // website itself; a Session told it is a Router delegates. The declaration is owned here
  // and versioned with the plugin; an operator's own preset of the same id is never replaced.
  let presetStatus = { registered: false, version: ROUTER_PRESET_VERSION }
  ctx.inject(['agentPresets'], scope => {
    let disposed = false
    let dispose
    registerRouterPreset({
      agentPresets: scope.agentPresets,
      logger,
      presetId: resolved.routerPresetId,
    }).then(result => {
      presetStatus = result
      if (result.conflict) {
        // Loud on purpose: the operator must know their Router preset did not install, or
        // they will open a Session and watch it build the website by hand.
        logger?.warn?.(`dsh-concierge: router preset not installed — ${result.conflict}`)
      }
      if (result.registered && !disposed) dispose = result.dispose
    }).catch(error => {
      presetStatus = { registered: false, conflict: String(error), version: ROUTER_PRESET_VERSION }
      logger?.warn?.(`dsh-concierge: router preset registration failed — ${String(error)}`)
    })
    return async () => {
      disposed = true
      if (typeof dispose === 'function') await dispose().catch(() => {})
    }
  })

  // Every resource is registered inside an effect, so unloading the plugin releases it.
  ctx.effect(() => {
    const disposers = []
    for (const definition of tools({ router, supervisor, state, channels, intake })) {
      disposers.push(ctx.tools.register(definition))
    }
    disposers.push(ctx.tools.register(sourceTool({ state, intake, channels })))
    return () => { for (const dispose of disposers.splice(0)) { try { dispose() } catch { /* already gone */ } } }
  }, 'dsh-concierge/tools()')

  // The webhook and github kinds are code; instances are rows. Registering a kind is
  // effect-scoped, so unloading the plugin removes it cleanly.
  ctx.effect(() => {
    const disposers = [registry.register(webhookKind), registry.register(githubKind)]
    return () => {
      for (const dispose of disposers.splice(0)) { try { dispose() } catch { /* already gone */ } }
    }
  }, 'dsh-concierge/source-kinds()')

  // v3: one polling loop per enabled GitHub instance. Each loop owns its own fiber so a
  // stop aborts it and awaits completion, as the cookbook requires.
  const githubLoops = []
  for (const instance of state.listSources('github')) {
    if (!instance.enabled) continue
    const controller = new AbortController()
    const host = { state, intake, registry, logger, supervisor }
    ctx.effect(() => {
      const running = watchGithub(host, instance.id, controller.signal)
        .catch(error => {
          state.setSourceHealth(instance.id, { state: 'error', detail: String(error), at: Date.now() })
        })
      githubLoops.push(running)
      return async () => { controller.abort(); await running }
    }, `dsh-concierge/github-loop:${instance.id}`)
  }

  // One HTTP route per enabled webhook instance. Routes live in their own fiber so a
  // composition without `webServer` still gets the tools and the watchdog.
  let routeSet
  ctx.inject(['webServer'], scope => {
    const webServer = scope.webServer
    if (typeof webServer?.register !== 'function') return
    routeSet = registerWebhookRoutes({ ctx: { webServer }, state, intake, logger, registry })
    return () => {
      if (routeSet) routeSet.dispose()
      routeSet = undefined
    }
  })

  ctx.effect(() => {
    state.recoverOnBoot()
    supervisor.startWatchdog()
    channels.start()
    // v4: deferred assessments are retried on a schedule stored in the database, so a
    // restart resumes the wait instead of restarting it.
    if (resolved.semanticAssessment) assessor.startRetryLoop()
    supervisor.pump()
    return () => {
      assessor.dispose()
      channels.dispose()
      supervisor.dispose().catch(() => {})
      state.close()
    }
  }, 'dsh-concierge/lifecycle()')

  // The assessor needs a model. It gets a small dedicated Session of its own, created on
  // first use so a deployment that never enables Sources pays nothing for it.
  assessor.useAssessor(async prompt => {
    const sessionId = resolved.assessorSessionId
    const cwd = join(stateDir, 'assessor')
    await mkdir(cwd, { recursive: true }).catch(() => {})
    const agent = await supervisor.ensureSession(sessionId, cwd, 'concierge assessor', 'assessor')
    const requestId = `concierge:assess:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`
    return supervisor.askOnce(agent.id, requestId, prompt, resolved.assessorTimeoutMs)
  })

  // v3: the Router's own context stays flat. Long orchestrations keep their early
  // decisions as references with a one-line summary instead of growing without bound.
  const spill = new ContextSpill({ state, inlineChars: resolved.inlineChars, logger })

  // The in-app panel's data route. It uses the Host's own authenticated connection, so no
  // port is opened and the page's existing credential is the only one involved.
  ctx.inject(['connection'], scope => {
    const connection = scope.connection
    if (typeof connection?.fetch?.register !== 'function') {
      logger?.warn?.('dsh-concierge: connection.fetch is unavailable; the panel will show an error')
      return
    }
    let disposed = false
    let dispose = async () => {}
    registerPanelRoute(connection, { state, supervisor, assessor, channels, intake, get preset() { return presetStatus } })
      .then(fn => {
        if (disposed) { fn().catch(() => {}); return }
        dispose = fn
        logger?.info?.(`dsh-concierge: panel route registered at ${PANEL_PATH}`)
      })
      .catch(error => logger?.warn?.(`dsh-concierge could not register the panel route: ${String(error)}`))
    return async () => {
      disposed = true
      await dispose().catch(() => {})
    }
  })

  const service = {
    state,
    supervisor,
    router,
    registry,
    intake,
    channels,
    assessor,
    spill,
    githubLoops,
    config: resolved,
    get preset() { return presetStatus },
    get routes() { return routeSet },
  }
  return service
}

export default { name, inject, apply }
