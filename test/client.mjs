/**
 * v4 panel: the browser half.
 *
 * The client bundle is a `window.__ModuleLoader__.load` call. This test supplies a minimal
 * loader and React, runs the factory, and asserts what it registers plus what it renders
 * through its exported pure view.
 *
 * The panel's job is presentation: enum codes arrive from the Host in English and must
 * reach the operator in Chinese, the filter chips must actually filter, the banner must
 * respect its stored dismissal, and an empty state must say so.
 *
 * Run: node test/client.mjs
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const results = []
function check(name, condition, detail = undefined) {
  results.push({ name, pass: Boolean(condition), detail })
  if (!condition) console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  else console.log(`ok    ${name}`)
}

const here = fileURLToPath(new URL('.', import.meta.url))
const source = await readFile(join(here, '..', 'client.js'), 'utf8')

// ---------------------------------------------------------------- fake runtime
const React = {
  createElement(type, props, ...children) {
    return {
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false),
    }
  },
  useState(initial) { return [initial, () => {}] },
  useEffect() { return undefined },
  useCallback(fn) { return fn },
}

/** Render an element tree to text, resolving function components. */
function render(node, depth = 0) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(child => render(child, depth)).join('')
  if (depth > 30) return ''
  if (typeof node.type === 'function') {
    return render(node.type({ ...node.props, children: node.children }, node.children), depth + 1)
  }
  return node.children.map(child => render(child, depth)).join('')
}

const registrations = []
const styleNodes = []
const effects = []
const storage = new Map()

const documentStub = {
  head: { appendChild(node) { styleNodes.push(node) } },
  createElement() {
    return {
      dataset: {}, textContent: '', tag: 'style',
      remove() { const at = styleNodes.indexOf(this); if (at >= 0) styleNodes.splice(at, 1) },
    }
  },
}

const localStorageStub = {
  getItem: key => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)) },
}

let plugin
new Function('window', 'document', 'fetch', 'setInterval', 'clearInterval', 'localStorage', `${source}\n`)(
  { __ModuleLoader__: { load(spec) {
    check('the bundle declares its id', spec.id === 'dsh-concierge', spec.id)
    plugin = spec.factory(name => {
      if (name === 'react') return React
      throw new Error(`unexpected require: ${name}`)
    })
  } } },
  documentStub,
  async () => ({ ok: true, json: async () => ({}) }),
  () => ({ unref() {} }),
  () => {},
  localStorageStub,
)

// ---------------------------------------------------------------- apply()
const ctx = {
  effect(fn, label) { effects.push({ label, dispose: fn() }) },
  slots: {
    inject(_key, callback) { return callback() },
    register(options, component) { registrations.push({ options, component }); return () => {} },
  },
}
plugin.apply(ctx)

const entry = registrations.find(row => row.options.name === 'sidebar.panellist')
const main = registrations.find(row => row.options.name === 'main')

check('a sidebar entry is registered', Boolean(entry))
check('the entry id matches the panel key', entry?.options.id === main?.options.key, `${entry?.options.id} vs ${main?.options.key}`)
check('the label reads 代理管家', entry?.options.label() === '代理管家', String(entry?.options.label?.()))

const iconElement = entry.component({ size: 20 })
const svg = typeof iconElement.type === 'function' ? iconElement.type(iconElement.props) : iconElement
check('the entry renders an svg icon', svg?.type === 'svg', String(svg?.type))

const styleEffect = effects.find(row => row.label === 'concierge/panel-style')
check('the panel installs its styles', styleEffect !== undefined && styleNodes.length === 1)
check('the styles are namespaced', styleNodes[0]?.textContent.includes('.cnc-root'))
styleEffect?.dispose()
check('disposing removes the styles', styleNodes.length === 0)

// -------------------------------------------------------------- the view
const { view, maps, helpers } = plugin
check('the plugin exposes its view', typeof view === 'function')
check('the plugin exposes its maps', typeof maps?.TICKET_STATUS === 'object')
check('the plugin exposes its helpers', typeof helpers?.applyFilter === 'function')

const { PANEL_PATH: HOST_PATH } = await import('../lib/panel.js')
const clientPath = /const PANEL_PATH = '([^']+)'/.exec(source)?.[1]
check('the client fetches the host panel path', clientPath === HOST_PATH.replace(/^\//, ''), `${clientPath} vs ${HOST_PATH}`)

// ------------------------------------------------------------- 中文映射
check('queued maps to 排队', maps.TICKET_STATUS.queued === '排队')
check('running maps to 进行中', maps.TICKET_STATUS.running === '进行中')
check('done maps to 已完成', maps.TICKET_STATUS.done === '已完成')
check('failed maps to 失败', maps.TICKET_STATUS.failed === '失败')
check('blocked report maps to 受阻', maps.REPORT_STATE.blocked === '受阻')
check('accept maps to 接受', maps.VERDICT.accept === '接受')
check('ignore maps to 忽略', maps.VERDICT.ignore === '忽略')
check('need_context maps to 需补充上下文', maps.VERDICT.need_context === '需补充上下文')
check('deferred maps to 暂缓', maps.VERDICT.deferred === '暂缓')
check('stored maps to 已接收', maps.DISPOSITION.stored === '已接收')
check('filtered maps to 已过滤', maps.DISPOSITION.filtered === '已过滤')
check('the range labels are Chinese', maps.RANGE_LABEL.today === '今天' && maps.RANGE_LABEL['7d'] === '7 天' && maps.RANGE_LABEL.all === '全部')
check('the filter labels are Chinese', maps.FILTER_LABEL.attention === '需要处理' && maps.FILTER_LABEL.test === '测试')

// ---------------------------------------------------------- 过滤联动
// The Host classifies each row once and sends `lists`; the client only reads it.
const tickets = [
  { id: 't-1', title: 'real work', status: 'failed', needs: 'failed', test: false, lists: ['attention', 'all'] },
  { id: 't-2', title: 'running work', status: 'running', needs: null, test: false, lists: ['all'] },
  { id: 't-3', title: 'probe/smoke 冒烟', status: 'done', needs: null, test: true, lists: ['test'] },
]
check('the attention filter keeps only what needs a person', helpers.applyFilter(tickets, 'attention').map(row => row.id).join() === 't-1')
check('the all filter keeps real work only', helpers.applyFilter(tickets, 'all').map(row => row.id).join() === 't-1,t-2')
check('the test filter keeps test tickets only', helpers.applyFilter(tickets, 'test').map(row => row.id).join() === 't-3')
check('test tickets never appear under attention', helpers.applyFilter(tickets, 'attention').every(row => row.test !== true))
check('empty attention says so', helpers.emptyText('attention') === '没有需要你处理的事')
check('empty tests say so', helpers.emptyText('test') === '没有测试工单')
check('the relative time reads Chinese', helpers.relative(Date.now() - 5000).includes('刚刚'))

// ------------------------------------------------------------- rendering
const snapshot = {
  ok: true,
  attention: [{ kind: 'ticket', id: 't-1', why: 'failed', title: 'broken' }],
  kpi: { needsAttention: 1, running: 1, slotLimit: 3, queued: 2, doneToday: 4, failedToday: 1, deliveryBacklog: 2 },
  charts: {
    flow: { days: [
      { label: '11/1', created: 1, completed: 0, failed: 0 },
      { label: '11/2', created: 2, completed: 1, failed: 0 },
      { label: '11/3', created: 0, completed: 2, failed: 1 },
    ] },
    status: [{ key: 'queued', value: 2 }, { key: 'running', value: 1 }, { key: 'completed', value: 4 }, { key: 'failed', value: 1 }],
    verdicts: [{ key: 'accept', value: 3 }, { key: 'ignore', value: 1 }, { key: 'need_context', value: 0 }, { key: 'deferred', value: 2 }],
  },
  tickets: [
    { id: 't-1', title: '失败的工单', status: 'failed', needs: 'failed', attention: true, summary: '出错了', report: 'failed', rounds: 2, blockedRetries: 1, test: false, lists: ['attention', 'all'], updatedAt: Date.now() - 60_000 },
    { id: 't-2', title: '进行中的工单', status: 'running', needs: null, attention: false, summary: '正在做', report: 'progress', rounds: 1, blockedRetries: 0, test: false, lists: ['all'], updatedAt: Date.now() - 120_000 },
    { id: 't-3', title: 'probe/smoke 冒烟验证', status: 'done', needs: null, attention: false, summary: 'ok', report: 'done', rounds: 1, blockedRetries: 0, test: true, lists: ['test'], updatedAt: Date.now() - 5000 },
  ],
  sources: [{ id: 'wh-p', kind: 'webhook', enabled: true, cursor: '42', token: 'abcd…1234ef56', health: { state: 'ready' }, recent: [{ disposition: 'filtered', reason: 'sender_not_allowlisted' }] }],
  decisions: [{ trigger: 'webhook:wh-p:trg-1', state: 'decided', verdict: 'accept', reason: '请求具体', policyRevision: 2, deferrals: 0 }],
  channels: { pending: [{ id: 'cm-1', ticket: 't-2', attempts: 1, nextAt: 1, reason: 'HTTP 503' }], dropped: [{ id: 'cm-2', ticket: 't-1', reason: '已失效' }] },
  policy: { revision: 2, origin: 'test' },
}

const text = render(view({ snapshot, ui: { filter: 'attention' } }))
check('the title row renders', text.includes('代理管家'), text.slice(0, 40))
check('the subtitle shows workers and policy', text.includes('执行中 1/3') && text.includes('策略 v2'), text.slice(0, 80))
check('the range switch offers all three', text.includes('今天') && text.includes('7 天') && text.includes('全部'))
check('the banner announces the work', text.includes('有 1 件事需要你处理'))

check('the KPI row shows every card', ['需要处理', '执行中', '排队', '今日完成', '今日失败', '投递积压'].every(label => text.includes(label)), text.slice(0, 220))
check('the KPI values render', text.includes('今日完成') && text.includes('4'), text.slice(0, 220))
check('the chart section renders', text.includes('趋势与分布') && text.includes('近 7 天工单流向'))
check('the flow bars are labelled', text.includes('11/2'))
check('the status legend maps to Chinese', text.includes('完成 4'), text.slice(0, 400))
check('the verdict legend maps to Chinese', text.includes('接受 3') && text.includes('暂缓 2'), text.slice(0, 400))
check('the filter chips render', text.includes('需要处理') && text.includes('测试'))
check('the failed ticket shows its Chinese status', text.includes('失败的工单') && text.includes('失败'), text.slice(0, 300))
check('the summary line renders', text.includes('出错了'))
check('the detail is hidden by default', !text.includes('工单 t-1'), 'detail should be collapsed')
check('the detail disclosure is offered', text.includes('展开细节'))
check('the collapsed sections are named', text.includes('来源健康') && text.includes('语义决策') && text.includes('投递队列'))
check('collapsed bodies are not rendered', !text.includes('abcd…1234ef56'))

check('attention hides running work', !text.includes('进行中的工单'), 'attention should only show t-1')
check('attention hides test tickets', !text.includes('冒烟验证'))

const openText = render(view({ snapshot, ui: { filter: 'attention', expanded: { 't-1': true } } }))
check('an expanded row shows its detail', openText.includes('工单 t-1'), openText.slice(0, 200))
check('the detail maps the report state', openText.includes('最近汇报 失败'), openText.slice(0, 300))
check('the detail shows the blocked count', openText.includes('受阻次数 1'))

const allText = render(view({ snapshot, ui: { filter: 'all' } }))
check('the all filter includes running work', allText.includes('进行中的工单'))
check('the all filter still excludes tests', !allText.includes('冒烟验证'))
const testText = render(view({ snapshot, ui: { filter: 'test' } }))
check('the test filter shows test tickets', testText.includes('冒烟验证'))
check('the test filter hides real work', !testText.includes('进行中的工单'))

const noBanner = render(view({ snapshot, ui: { filter: 'attention', bannerDismissed: true } }))
check('a dismissed banner is gone', !noBanner.includes('有 1 件事需要你处理'))
check('the banner key is namespaced', source.includes('dsh-concierge:banner-dismissed'))
check('the banner writes to storage', source.includes('setItem(BANNER_KEY'))
check('the banner reads storage', source.includes('getItem(BANNER_KEY'))

const collapsed = render(view({ snapshot, ui: { filter: 'attention', chartsOpen: false } }))
check('a collapsed chart area hides the charts', !collapsed.includes('近 7 天工单流向'))
check('the collapse control is still offered', collapsed.includes('趋势与分布') && collapsed.includes('展开'))

const detailOpen = render(view({ snapshot, ui: { filter: 'attention', detailOpen: { 'detail:sources': true } } }))
check('an opened detail section renders its table', detailOpen.includes('abcd…1234ef56'), detailOpen.slice(0, 300))
check('the source row maps its disposition', detailOpen.includes('已过滤'))

const emptySnapshot = {
  ok: true, attention: [], kpi: { needsAttention: 0, running: 0, slotLimit: 3, queued: 0, doneToday: 0, failedToday: 0, deliveryBacklog: 0 },
  charts: { flow: { days: [] }, status: [], verdicts: [] }, tickets: [], sources: [], decisions: [],
  channels: { pending: [], dropped: [] }, policy: { revision: 0, origin: 'builtin' },
}
const emptyText = render(view({ snapshot: emptySnapshot, ui: { filter: 'attention' } }))
check('an empty panel says nothing needs you', emptyText.includes('没有需要你处理的事'), emptyText.slice(0, 140))
check('an empty banner reassures instead of alerting', emptyText.includes('一切正常'))
check('an empty panel still shows zero KPIs', emptyText.includes('需要处理'))

const partial = render(view({ snapshot: { ok: true }, ui: {} }))
check('a partial snapshot renders', partial.includes('代理管家'), partial.slice(0, 60))
check('a partial snapshot shows the empty list state', partial.includes('没有需要你处理的事'))

const failures = results.filter(result => !result.pass)
console.log(`\n${results.length - failures.length}/${results.length} checks passed`)
if (failures.length > 0) process.exitCode = 1
