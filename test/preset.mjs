/**
 * The Router preset: the division-of-labour fix.
 *
 * A general-purpose Session, told to build a website, starts building it. The cure is a
 * Session whose prompt says it does not execute. These tests assert the declaration is
 * stable (a second registration is a no-op), that the instructions actually carry the
 * constraints, that the tool set cannot produce artifacts, and that an operator's own
 * preset of the same id is never overwritten.
 *
 * Run: node test/preset.mjs
 */
import {
  routerPresetDefinition, registerRouterPreset, ROUTER_INSTRUCTIONS,
  ROUTER_PRESET_ID, ROUTER_PRESET_VERSION,
} from '../lib/preset.js'

const results = []
function check(name, condition, detail = undefined) {
  results.push({ name, pass: Boolean(condition), detail })
  if (!condition) console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  else console.log(`ok    ${name}`)
}

/** A stand-in for `ctx.agentPresets` that behaves like the registry: duplicate ids throw. */
function fakeRegistry(existing = []) {
  const rows = [...existing]
  const registered = []
  return {
    rows,
    registered,
    async list() { return rows.map(row => ({ id: row.id, name: row.name })) },
    async register(definition) {
      if (rows.some(row => row.id === definition.id)) throw new Error(`preset "${definition.id}" already exists`)
      rows.push({ id: definition.id, name: definition.name })
      registered.push(definition)
      return async () => {
        const at = rows.findIndex(row => row.id === definition.id)
        if (at >= 0) rows.splice(at, 1)
      }
    },
  }
}

const logger = { info() {}, warn() {}, debug() {} }

// ------------------------------------------------------------- the declaration
const definition = routerPresetDefinition()
check('the preset id is the documented default', definition.id === ROUTER_PRESET_ID, definition.id)
check('the preset has a display name', typeof definition.name === 'string' && definition.name.length > 0, definition.name)
check('the preset has a description', typeof definition.description === 'string' && definition.description.length > 0)
check('the preset declares plugins', Array.isArray(definition.plugins) && definition.plugins.length > 0, String(definition.plugins?.length))

// ------------------------------------------------------- the prompt constraints
check('the prompt forbids executing', ROUTER_INSTRUCTIONS.includes('不亲自执行'), 'must say it does not execute')
check('the prompt says to delegate on requests', ROUTER_INSTRUCTIONS.includes('superagent_ask'), 'must name superagent_ask')
check('the prompt names the follow-up tool', ROUTER_INSTRUCTIONS.includes('superagent_send'))
check('the prompt names the read tool', ROUTER_INSTRUCTIONS.includes('superagent_read'))
check('the prompt caps the reply at 100 words', ROUTER_INSTRUCTIONS.includes('100 词'))
check('the prompt allows chit-chat without a ticket', ROUTER_INSTRUCTIONS.includes('闲聊') && ROUTER_INSTRUCTIONS.includes('不必开工单'), 'must exempt chit-chat')
check('the prompt forbids writing code', ROUTER_INSTRUCTIONS.includes('不写代码'))
check('the prompt forbids long commands', ROUTER_INSTRUCTIONS.includes('不跑长命令'))
check('the prompt is the persona prefix', definition.plugins.find(row => row.id === 'persona')?.config?.prefix === ROUTER_INSTRUCTIONS)

// ------------------------------------------- the tool set cannot make artifacts
const rows = definition.plugins.map(row => row.id)
check('no shell tool is mounted', !rows.some(id => /bash|pwsh|shell/.test(id)), JSON.stringify(rows))
check('no subagent tool is mounted', !rows.some(id => id.includes('subagent')), JSON.stringify(rows))
check('no goal or workflow tool is mounted', !rows.some(id => /goal|workflow/.test(id)), JSON.stringify(rows))
// v5 removed the filesystem tool entirely: reading a worker's directory to 'check on it'
  // is the越界 this preset exists to prevent, and a read-only flag invites exactly that.
  check('no filesystem tool is mounted', !rows.some(id => id.startsWith('tool-fs')), JSON.stringify(rows))
check('the persona row is present', rows.includes('persona'))

// --------------------------------------------------------- registration is idempotent
const registry = fakeRegistry()
const first = await registerRouterPreset({ agentPresets: registry, logger })
check('the first registration succeeds', first.registered === true, JSON.stringify(first))
check('the registry holds the preset', registry.rows.some(row => row.id === ROUTER_PRESET_ID))
check('the registration carries its version', first.version === ROUTER_PRESET_VERSION, String(first.version))
check('a disposer is returned', typeof first.dispose === 'function')

const second = await registerRouterPreset({ agentPresets: registry, logger })
check('a second registration is refused, not duplicated', second.registered === false, JSON.stringify(second))
check('the refusal names the conflict', String(second.conflict).includes('already exists'), second.conflict)
check('the registry still holds exactly one', registry.rows.filter(row => row.id === ROUTER_PRESET_ID).length === 1)
check('the definition was registered once', registry.registered.length === 1, String(registry.registered.length))

await first.dispose()
check('disposing removes the preset', !registry.rows.some(row => row.id === ROUTER_PRESET_ID))

// ------------------------------------- an operator's own preset is left untouched
const theirs = fakeRegistry([{ id: ROUTER_PRESET_ID, name: '我的调度台' }])
const conflicted = await registerRouterPreset({ agentPresets: theirs, logger })
check('an existing preset is not replaced', conflicted.registered === false, JSON.stringify(conflicted))
check('the conflict mentions the existing preset', String(conflicted.conflict).includes('我的调度台'), conflicted.conflict)
check('the existing preset keeps its name', theirs.rows.find(row => row.id === ROUTER_PRESET_ID)?.name === '我的调度台')
check('nothing new was registered', theirs.registered.length === 0)

// A custom id is honoured, so an operator can avoid the clash.
const custom = fakeRegistry()
const customResult = await registerRouterPreset({ agentPresets: custom, logger, presetId: 'my-router' })
check('a custom preset id is honoured', customResult.registered === true && custom.rows.some(row => row.id === 'my-router'))

// A composition without the registry degrades instead of throwing.
const missing = await registerRouterPreset({ agentPresets: undefined, logger })
check('a missing registry is reported, not thrown', missing.registered === false && String(missing.conflict).includes('unavailable'), missing.conflict)

// A registry that throws on register is reported as a conflict.
const broken = {
  async list() { throw new Error('listing failed') },
  async register() { throw new Error('registry is read-only') },
}
const brokenResult = await registerRouterPreset({ agentPresets: broken, logger })
check('a failing registry is reported', brokenResult.registered === false, JSON.stringify(brokenResult))
check('a failing registry names its reason', String(brokenResult.conflict).includes('read-only'), brokenResult.conflict)

const failures = results.filter(result => !result.pass)
console.log(`\n${results.length - failures.length}/${results.length} checks passed`)
if (failures.length > 0) process.exitCode = 1
