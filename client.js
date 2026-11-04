/**
 * dsh-concierge — the browser half.
 *
 * Two registrations, both in the sidebar's own slots:
 *
 *   sidebar.panellist   the "Concierge" entry
 *   main                the panel, keyed by the same id
 *
 * The layout follows the installed context-insights plugin: a title row with a range
 * switch, a KPI row of cards, a collapsible chart area, then the list that carries the
 * real weight — and finally the detail sections, collapsed until asked for. Charts are
 * hand-drawn SVG (a donut is `strokeDasharray` on a circle, as that plugin draws it); no
 * chart library is involved.
 *
 * Every fixed string and enum is mapped to Chinese here, in the render layer. The database
 * keeps its English codes, so stored history stays readable and diffable.
 */
window.__ModuleLoader__.load({
  id: 'dsh-concierge',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const ENTRY_ID = 'dsh-concierge'
    // Relative to the page origin; the Host registers it as '/api/concierge/panel'.
    const PANEL_PATH = 'api/concierge/panel'
    const BANNER_KEY = 'dsh-concierge:banner-dismissed'

    // ------------------------------------------------------------- mapping
    // Status codes stay English in SQLite; the panel speaks Chinese.
    const TICKET_STATUS = {
      queued: '排队',
      running: '进行中',
      done: '已完成',
      failed: '失败',
    }
    const BUCKET = {
      queued: '排队',
      running: '进行中',
      completed: '完成',
      failed: '失败',
    }
    const REPORT_STATE = {
      progress: '进展',
      done: '已完成',
      blocked: '受阻',
      failed: '失败',
    }
    const VERDICT = {
      accept: '接受',
      ignore: '忽略',
      need_context: '需补充上下文',
      pending: '暂缓',
      deferred: '暂缓',
    }
    const DISPOSITION = {
      stored: '已接收',
      filtered: '已过滤',
      duplicate: '重复',
    }
    const DECISION_STATE = {
      decided: '已判决',
      pending: '待判决',
    }
    const RANGE_LABEL = { today: '今天', '7d': '7 天', all: '全部' }
    const FILTER_LABEL = { attention: '需要处理', all: '全部', test: '测试' }

    /** Relative time in Chinese; a report does not need second precision. */
    function relative(at, now = Date.now()) {
      if (!Number.isFinite(at) || at <= 0) return '—'
      const seconds = Math.max(0, Math.round((now - at) / 1000))
      if (seconds < 60) return '刚刚'
      const minutes = Math.round(seconds / 60)
      if (minutes < 60) return `${minutes} 分钟前`
      const hours = Math.round(minutes / 60)
      if (hours < 24) return `${hours} 小时前`
      const days = Math.round(hours / 24)
      if (days < 30) return `${days} 天前`
      return `${Math.round(days / 30)} 个月前`
    }

    /**
     * The needs-a-person badge text.
     *
     * It must never repeat the status badge: a failed ticket used to render "失败 失败", which
     * reads as two different problems when it is one. The needs badge says what the person
     * has to do; the status badge says where the ticket stands.
     */
    function needsLabel(ticket) {
      if (ticket.needs === 'failed') return '需要你处理'
      if (ticket.needs === 'blocked') return '等你回复'
      return undefined
    }

    // ------------------------------------------------------------- styling
    // Card, spacing and type scale follow the context-insights plugin; colours come from
    // the host theme tokens so light and dark both work.
    const STYLE = `
.cnc-root { box-sizing: border-box; height: 100%; overflow-y: auto; padding: 16px 20px 32px;
  color: var(--dsw-alias-label-primary); font-size: 13px; }
.cnc-head { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
.cnc-head-title { font-size: 15px; font-weight: 600; }
.cnc-head-sub { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.cnc-range { display: flex; gap: 2px; margin-left: auto; padding: 1px;
  background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; }
.cnc-range button { border: 0; background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 12px; padding: 3px 10px; border-radius: 5px; cursor: pointer; }
.cnc-range button:hover { color: var(--dsw-alias-label-primary); }
.cnc-range button[aria-pressed="true"] { background: var(--dsw-alias-brand-primary); color: #fff; }

.cnc-kpis { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 14px; }
.cnc-kpi { flex: 1 1 120px; min-width: 120px; text-align: left; cursor: pointer;
  background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px; padding: 12px 14px; font: inherit; color: inherit; }
.cnc-kpi:disabled { cursor: default; opacity: .55; }
.cnc-kpi-on { border-color: var(--dsw-alias-brand-primary); }
.cnc-kpi-label { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.cnc-kpi-value { font-size: 22px; font-weight: 600; margin-top: 4px;
  font-variant-numeric: tabular-nums; }
.cnc-kpi-hot .cnc-kpi-value { color: var(--dsw-alias-state-warn-primary); }
.cnc-kpi-bad .cnc-kpi-value { color: var(--dsw-alias-state-error-primary); }

.cnc-card { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px; padding: 14px 16px; margin-bottom: 14px; }
.cnc-card-sub { color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 400; }
.cnc-fold { cursor: pointer; background: none; border: 0; color: inherit; font: inherit;
  font-weight: 600; padding: 0; display: flex; align-items: baseline; gap: 8px; }
.cnc-charts { display: flex; flex-wrap: wrap; gap: 14px; }
.cnc-chart { flex: 1 1 240px; min-width: 240px; }
.cnc-bars { display: flex; align-items: flex-end; gap: 10px; height: 120px; }
.cnc-bar-group { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px; }
.cnc-bar-stack { display: flex; align-items: flex-end; gap: 2px; height: 96px; }
.cnc-bar { width: 7px; border-radius: 2px 2px 0 0; min-height: 2px; }
.cnc-bar-created { background: var(--dsw-alias-brand-primary); }
.cnc-bar-completed { background: var(--dsw-alias-state-success-primary); }
.cnc-bar-failed { background: var(--dsw-alias-state-error-primary); }
.cnc-bar-label { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.cnc-legend { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 8px; font-size: 12px; }
.cnc-legend-item { display: flex; align-items: center; gap: 5px;
  color: var(--dsw-alias-label-secondary); }
.cnc-swatch { width: 9px; height: 9px; border-radius: 2px; flex: none; }
.cnc-donut { position: relative; width: 120px; height: 120px; margin: 0 auto; }
.cnc-donut-center { position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 1px; }
.cnc-donut-total { font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; }
.cnc-donut-sub { color: var(--dsw-alias-label-secondary); font-size: 11px; }

.cnc-filters { display: flex; gap: 6px; margin-bottom: 10px; }
.cnc-chip { border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; padding: 3px 10px;
  border-radius: 999px; cursor: pointer; }
.cnc-chip:hover { color: var(--dsw-alias-label-primary); }
.cnc-chip[aria-pressed="true"] { background: var(--dsw-alias-brand-primary); color: #fff;
  border-color: var(--dsw-alias-brand-primary); }

.cnc-row { border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1); padding: 10px 12px; margin-bottom: 8px; }
.cnc-row-hot { border-left: 3px solid var(--dsw-alias-state-warn-primary); }
.cnc-row-line { display: flex; align-items: baseline; gap: 8px; }
.cnc-row-title { font-weight: 600; flex: 1; min-width: 0; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.cnc-row-time { color: var(--dsw-alias-label-secondary); font-size: 12px; flex: none; }
.cnc-badge { font-size: 11px; padding: 1px 7px; border-radius: 999px; flex: none;
  border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
.cnc-badge-running { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.cnc-badge-done { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.cnc-badge-failed { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.cnc-badge-blocked { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.cnc-row-summary { color: var(--dsw-alias-label-secondary); font-size: 12px; margin-top: 4px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cnc-row-more { border: 0; background: none; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 11px; padding: 2px 0 0; cursor: pointer; }
.cnc-row-more:hover { color: var(--dsw-alias-label-primary); }
.cnc-detail { margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.55;
  white-space: pre-wrap; word-break: break-word; }

.cnc-empty { color: var(--dsw-alias-label-secondary); font-size: 12px; padding: 18px 4px;
  text-align: center; }
.cnc-banner { display: flex; align-items: center; gap: 10px; margin-bottom: 12px;
  padding: 8px 12px; border-radius: 8px; font-size: 12px;
  background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary); }
.cnc-banner-close { margin-left: auto; border: 0; background: none; cursor: pointer;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 14px; line-height: 1; }
.cnc-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.cnc-table th { text-align: left; font-weight: 500; color: var(--dsw-alias-label-secondary);
  padding: 4px 8px 6px 0; }
.cnc-table td { padding: 5px 8px 5px 0; vertical-align: top;
  border-top: 1px solid var(--dsw-alias-border-l1); }
.cnc-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
.cnc-leads { margin-top: 6px; font-size: 11px; color: var(--dsw-alias-state-warn-primary);
  display: flex; gap: 4px; align-items: baseline; flex-wrap: wrap; }
.cnc-leads-label { font-weight: 600; }
.cnc-id { font-family: var(--dsw-font-mono, monospace); font-size: 11px; opacity: .8; }
`

    // ------------------------------------------------------------- the view
    /**
     * The panel's pure view: snapshot + local UI state in, element tree out.
     *
     * Kept free of fetching so the whole rendering path is testable and so the container
     * below owns exactly one lifecycle.
     */
    function PanelView({ snapshot, ui }) {
      const view = normalizeSnapshot(snapshot)
      const filter = ui?.filter ?? 'attention'
      const range = ui?.range ?? 'all'
      const dismissed = ui?.bannerDismissed === true
      const expanded = ui?.expanded ?? {}
      const openCharts = ui?.chartsOpen !== false
      const openDetail = ui?.detailOpen ?? {}

      const rows = applyFilter(view.tickets, filter)
      const hot = view.kpi.needsAttention > 0

      return h('div', { className: 'cnc-root' },
        // ---------------------------------------------------- title row
        h('div', { className: 'cnc-head' },
          h('span', { className: 'cnc-head-title' }, '代理管家'),
          h('span', { className: 'cnc-head-sub' },
            `执行中 ${view.kpi.running}/${view.kpi.slotLimit} · 策略 v${view.policy.revision}`),
          h('div', { className: 'cnc-range', role: 'group', 'aria-label': '时间范围' },
            ...Object.keys(RANGE_LABEL).map(key => h('button', {
              key,
              type: 'button',
              'aria-pressed': range === key ? 'true' : 'false',
              onClick: () => ui?.onRange?.(key),
            }, RANGE_LABEL[key])))),

        // --------------------------------------------------- dismissible banner
        dismissed ? null : h('div', { className: 'cnc-banner' },
          h('span', null, hot
            ? `有 ${view.kpi.needsAttention} 件事需要你处理。`
            : '一切正常：没有需要你处理的事。'),
          h('button', {
            type: 'button', className: 'cnc-banner-close', 'aria-label': '关闭提示',
            onClick: () => ui?.onDismissBanner?.(),
          }, '×')),

        // -------------------------------------------------------- KPI row
        h('div', { className: 'cnc-kpis' },
          kpiCard({ label: '需要处理', value: view.kpi.needsAttention,
            tone: hot ? 'cnc-kpi-hot' : undefined, active: filter === 'attention',
            disabled: !hot, onClick: () => ui?.onFilter?.('attention') }),
          kpiCard({ label: '执行中', value: `${view.kpi.running}/${view.kpi.slotLimit}`, disabled: true }),
          kpiCard({ label: '排队', value: view.kpi.queued, disabled: true }),
          kpiCard({ label: '今日完成', value: view.kpi.doneToday, disabled: true }),
          kpiCard({ label: '今日失败', value: view.kpi.failedToday,
            tone: view.kpi.failedToday > 0 ? 'cnc-kpi-bad' : undefined, disabled: true }),
          kpiCard({ label: '投递积压', value: view.kpi.deliveryBacklog,
            tone: view.kpi.deliveryBacklog > 0 ? 'cnc-kpi-hot' : undefined, disabled: true })),

        // --------------------------------------------------------- charts
        h('section', { className: 'cnc-card' },
          h('button', {
            type: 'button', className: 'cnc-fold', 'aria-expanded': openCharts ? 'true' : 'false',
            onClick: () => ui?.onToggleCharts?.(),
          },
          h('span', null, '趋势与分布'),
          h('span', { className: 'cnc-card-sub' }, openCharts ? '收起' : '展开')),
          openCharts ? h('div', { className: 'cnc-charts', style: { marginTop: '12px' } },
            h('div', { className: 'cnc-chart' },
              h('div', { className: 'cnc-card-sub', style: { marginBottom: '8px' } }, '近 7 天工单流向'),
              flowBars(view.charts.flow),
              h('div', { className: 'cnc-legend' },
                legendItem('cnc-bar-created', '新建'),
                legendItem('cnc-bar-completed', '完成'),
                legendItem('cnc-bar-failed', '失败'))),
            h('div', { className: 'cnc-chart' },
              h('div', { className: 'cnc-card-sub', style: { marginBottom: '8px' } }, '工单状态'),
              donut(view.charts.status, BUCKET, '工单'),
              legendList(view.charts.status, BUCKET)),
            h('div', { className: 'cnc-chart' },
              h('div', { className: 'cnc-card-sub', style: { marginBottom: '8px' } }, '语义判决'),
              donut(view.charts.verdicts, VERDICT, '判决'),
              legendList(view.charts.verdicts, VERDICT))) : null),

        // ------------------------------------------------------ ticket list
        h('div', { className: 'cnc-filters', role: 'group', 'aria-label': '过滤' },
          ...Object.keys(FILTER_LABEL).map(key => h('button', {
            key,
            type: 'button',
            className: 'cnc-chip',
            'aria-pressed': filter === key ? 'true' : 'false',
            onClick: () => ui?.onFilter?.(key),
          }, FILTER_LABEL[key]))),
        rows.length === 0
          ? h('div', { className: 'cnc-empty' }, emptyText(filter))
          : rows.map(row => ticketRow(row, expanded[row.id] === true, ui)),

        // ------------------------------------------------------ detail rows
        foldSection('detail:sources', '来源健康', openDetail, ui,
          view.sources.length === 0
            ? h('div', { className: 'cnc-empty' }, '还没有配置来源。用 scripts/source.mjs 添加。')
            : sourceTable(view.sources)),
        foldSection('detail:decisions', '语义决策', openDetail, ui,
          view.decisions.length === 0
            ? h('div', { className: 'cnc-empty' }, '还没有需要评估的消息。')
            : decisionTable(view.decisions)),
        foldSection('detail:channels', '投递队列', openDetail, ui,
          detailChannel(view.channels)))
    }

    /** Fill in anything an older Host may not send, so a section never breaks rendering. */
    function normalizeSnapshot(snapshot) {
      const kpi = snapshot.kpi ?? {}
      return {
        attention: Array.isArray(snapshot.attention) ? snapshot.attention : [],
        kpi: {
          needsAttention: Number(kpi.needsAttention ?? 0),
          running: Number(kpi.running ?? 0),
          slotLimit: Number(kpi.slotLimit ?? 0),
          queued: Number(kpi.queued ?? 0),
          doneToday: Number(kpi.doneToday ?? 0),
          failedToday: Number(kpi.failedToday ?? 0),
          deliveryBacklog: Number(kpi.deliveryBacklog ?? 0),
        },
        charts: {
          flow: snapshot.charts?.flow?.days ?? [],
          status: snapshot.charts?.status ?? [],
          verdicts: snapshot.charts?.verdicts ?? [],
        },
        tickets: Array.isArray(snapshot.tickets) ? snapshot.tickets : [],
        sources: Array.isArray(snapshot.sources) ? snapshot.sources : [],
        decisions: Array.isArray(snapshot.decisions) ? snapshot.decisions : [],
        channels: {
          pending: Array.isArray(snapshot.channels?.pending) ? snapshot.channels.pending : [],
          dropped: Array.isArray(snapshot.channels?.dropped) ? snapshot.channels.dropped : [],
        },
        policy: snapshot.policy ?? { revision: 0, origin: 'builtin' },
      }
    }

    /**
     * The list filter.
     *
     * The Host classifies each row once and sends `lists`; the client only reads that. An
     * earlier version re-derived the rule here (hide test tickets, then keep `needs`), and
     * it drifted from the KPI count the Host computed — a card said "1" while its own
     * filter showed nothing. One predicate, computed once, is the fix.
     */
    function applyFilter(tickets, filter) {
      return tickets.filter(ticket => Array.isArray(ticket.lists) && ticket.lists.includes(filter))
    }

    /** Empty-state text, one per filter: it says what is absent, not that data is missing. */
    function emptyText(filter) {
      if (filter === 'attention') return '没有需要你处理的事'
      if (filter === 'test') return '没有测试工单'
      return '还没有工单。用 superagent_ask 提交一个请求。'
    }

    function kpiCard({ label, value, tone, active, disabled, onClick }) {
      return h('button', {
        type: 'button',
        className: `cnc-kpi${tone ? ` ${tone}` : ''}${active ? ' cnc-kpi-on' : ''}`,
        disabled: disabled === true || typeof onClick !== 'function',
        onClick,
        'aria-pressed': active === undefined ? undefined : active ? 'true' : 'false',
      },
      h('div', { className: 'cnc-kpi-label' }, label),
      h('div', { className: 'cnc-kpi-value' }, String(value)))
    }

    function legendItem(swatch, text) {
      return h('span', { className: 'cnc-legend-item' },
        h('span', { className: `cnc-swatch ${swatch}` }), text)
    }

    /** A seven-day stacked bar chart, drawn with divs rather than an SVG scene. */
    function flowBars(days) {
      const peak = Math.max(1, ...days.flatMap(day => [day.created, day.completed, day.failed]))
      const heightOf = value => Math.max(2, Math.round((value / peak) * 96))
      return h('div', { className: 'cnc-bars' },
        ...days.map(day => h('div', { key: day.label, className: 'cnc-bar-group' },
          h('div', { className: 'cnc-bar-stack' },
            h('div', { className: 'cnc-bar cnc-bar-created', style: { height: `${heightOf(day.created)}px` }, title: `新建 ${day.created}` }),
            h('div', { className: 'cnc-bar cnc-bar-completed', style: { height: `${heightOf(day.completed)}px` }, title: `完成 ${day.completed}` }),
            h('div', { className: 'cnc-bar cnc-bar-failed', style: { height: `${heightOf(day.failed)}px` }, title: `失败 ${day.failed}` })),
          h('div', { className: 'cnc-bar-label' }, day.label))))
    }

    /** Palette for both rings, from the host's state tokens. */
    const RING_COLORS = {
      queued: 'var(--dsw-alias-state-idle-primary)',
      running: 'var(--dsw-alias-brand-primary)',
      completed: 'var(--dsw-alias-state-success-primary)',
      failed: 'var(--dsw-alias-state-error-primary)',
      accept: 'var(--dsw-alias-state-success-primary)',
      ignore: 'var(--dsw-alias-state-idle-primary)',
      need_context: 'var(--dsw-alias-state-warn-primary)',
      deferred: 'var(--dsw-alias-brand-primary)',
    }

    /**
     * A donut, drawn the way the reference plugin draws it: one circle per slice whose
     * `strokeDasharray` is its share of the 100-unit circumference.
     */
    function donut(slices, labels, unitLabel) {
      const total = slices.reduce((sum, slice) => sum + (slice.value ?? 0), 0)
      let offset = 0
      const segments = slices
        .filter(slice => (slice.value ?? 0) > 0)
        .map(slice => {
          const share = (slice.value / total) * 100
          const segment = { ...slice, share, offset: 100 - offset }
          offset += share
          return segment
        })
      return h('div', { className: 'cnc-donut' },
        h('svg', { viewBox: '0 0 42 42', width: 120, height: 120, 'aria-hidden': 'true' },
          h('circle', {
            cx: 21, cy: 21, r: 15.9155, fill: 'none', strokeWidth: 4,
            stroke: 'var(--dsw-alias-bg-layer-2)',
          }),
          ...segments.map(segment => h('circle', {
            key: segment.key,
            cx: 21, cy: 21, r: 15.9155, fill: 'none', strokeWidth: 4,
            stroke: RING_COLORS[segment.key] ?? 'var(--dsw-alias-border-l2)',
            strokeDasharray: `${segment.share} ${100 - segment.share}`,
            strokeDashoffset: segment.offset,
          }))),
        h('div', { className: 'cnc-donut-center' },
          h('span', { className: 'cnc-donut-total' }, String(total)),
          h('span', { className: 'cnc-donut-sub' }, total === 0 ? `暂无${unitLabel}` : unitLabel)))
    }

    function legendList(slices, labels) {
      return h('div', { className: 'cnc-legend' },
        ...slices.map(slice => h('span', { key: slice.key, className: 'cnc-legend-item' },
          h('span', { className: 'cnc-swatch', style: { background: RING_COLORS[slice.key] ?? 'var(--dsw-alias-border-l2)' } }),
          `${labels[slice.key] ?? slice.key} ${slice.value ?? 0}`)))
    }

    /** One ticket as a two-line card; the debug detail is behind a disclosure. */
    function ticketRow(ticket, isOpen, ui) {
      const statusLabel = TICKET_STATUS[ticket.status] ?? ticket.status
      const badgeClass = ticket.needs
        ? `cnc-badge-${ticket.needs === 'failed' ? 'failed' : 'blocked'}`
        : ticket.status === 'done' ? 'cnc-badge-done'
          : ticket.status === 'running' ? 'cnc-badge-running' : ''
      return h('div', { key: ticket.id, className: `cnc-row${ticket.needs ? ' cnc-row-hot' : ''}` },
        h('div', { className: 'cnc-row-line' },
          h('span', { className: 'cnc-row-title', title: ticket.title }, ticket.title),
          ticket.needs ? h('span', { className: `cnc-badge ${badgeClass}` }, needsLabel(ticket)) : null,
          h('span', { className: `cnc-badge ${badgeClass}` }, statusLabel),
          h('span', { className: 'cnc-row-time' }, relative(ticket.updatedAt))),
        ticket.summary
          ? h('div', { className: 'cnc-row-summary', title: ticket.summary }, ticket.summary)
          : h('div', { className: 'cnc-row-summary' }, '还没有汇报'),
        h('button', {
          type: 'button', className: 'cnc-row-more', 'aria-expanded': isOpen ? 'true' : 'false',
          onClick: () => ui?.onToggleRow?.(ticket.id),
        }, isOpen ? '收起细节' : '展开细节'),
        isOpen ? h('div', { className: 'cnc-detail' }, detailLines(ticket).join('\n')) : null,
        // A reopened ticket rests on a guess. Say so in the collapsed row, not only in the
        // detail, so an operator skimming the list cannot mistake it for verified work.
        Array.isArray(ticket.leads) && ticket.leads.length > 0
          ? h('div', { className: 'cnc-leads' },
            h('span', { className: 'cnc-leads-label' }, '【待核实线索】'),
            ` ${ticket.leads.length} 条上游观察，新 worker 须先复现核实`)
          : null,
        ticket.reopenedFrom
          ? h('div', { className: 'cnc-leads' },
            h('span', { className: 'cnc-leads-label' }, '重开工单'),
            ` 来自 ${ticket.reopenedFrom}`)
          : null)
    }

    /** The detail body: the facts an operator needs when something looks wrong. */
    function detailLines(ticket) {
      const lines = [
        `工单 ${ticket.id}`,
        `状态 ${TICKET_STATUS[ticket.status] ?? ticket.status}` +
          (ticket.report ? ` · 最近汇报 ${REPORT_STATE[ticket.report] ?? ticket.report}` : ' · 还没有汇报'),
        `轮次 ${ticket.rounds ?? 0}`,
      ]
      if (ticket.blockedRetries > 0) lines.push(`受阻次数 ${ticket.blockedRetries}`)
      if (ticket.failure) lines.push(`失败原因 ${ticket.failure}`)
      if (ticket.detail?.next) lines.push(`下一步 ${ticket.detail.next}`)
      if (ticket.detail?.workspace) lines.push(`工作区 ${ticket.detail.workspace}`)
      if (ticket.test) lines.push('分类 测试工单')
      return lines
    }

    /** A collapsed section: the header is the only thing shown until asked. */
    function foldSection(key, title, openMap, ui, body) {
      const open = openMap[key] === true
      return h('section', { key, className: 'cnc-card' },
        h('button', {
          type: 'button', className: 'cnc-fold', 'aria-expanded': open ? 'true' : 'false',
          onClick: () => ui?.onToggleDetail?.(key),
        },
        h('span', null, title),
        h('span', { className: 'cnc-card-sub' }, open ? '收起' : '展开')),
        open ? h('div', { style: { marginTop: '10px' } }, body) : null)
    }

    function sourceTable(sources) {
      return h('table', { className: 'cnc-table' },
        h('thead', null, h('tr', null,
          h('th', null, '来源'), h('th', null, '状态'), h('th', null, '游标'),
          h('th', null, '令牌'), h('th', null, '最近'))),
        h('tbody', null, ...sources.map(row => h('tr', { key: row.id },
          h('td', null, h('span', { className: 'cnc-id' }, row.id), ' ', row.kind),
          h('td', null,
            h('span', { className: 'cnc-dot', style: { background: row.enabled ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-idle-primary)' } }),
            ' ', row.enabled ? '启用' : '停用',
            row.health?.state ? ` · ${row.health.state === 'error' ? '异常' : '正常'}` : ''),
          h('td', null, row.cursor ?? '—'),
          h('td', null, row.token ?? '无'),
          h('td', null, row.recent.length === 0 ? '—' : row.recent
            .map(trigger => `${DISPOSITION[trigger.disposition] ?? trigger.disposition}${trigger.reason ? `（${trigger.reason}）` : ''}`)
            .join('、'))))))
    }

    function decisionTable(decisions) {
      return h('table', { className: 'cnc-table' },
        h('thead', null, h('tr', null,
          h('th', null, '消息'), h('th', null, '判决'), h('th', null, '理由'), h('th', null, '策略'))),
        h('tbody', null, ...decisions.map(decision => h('tr', { key: decision.trigger },
          h('td', null, h('span', { className: 'cnc-id' }, String(decision.trigger).split(':').pop())),
          h('td', null, decision.verdict
            ? (VERDICT[decision.verdict] ?? decision.verdict)
            : (DECISION_STATE[decision.state] ?? decision.state)),
          h('td', null, decision.reason ?? '—',
            decision.deferrals > 0 ? `（已暂缓 ${decision.deferrals} 次）` : ''),
          h('td', null, decision.policyRevision === null ? '—' : `v${decision.policyRevision}`)))))
    }

    function detailChannel(queue) {
      if (queue.pending.length === 0 && queue.dropped.length === 0) {
        return h('div', { className: 'cnc-empty' }, '投递队列是空的')
      }
      return h('table', { className: 'cnc-table' },
        h('thead', null, h('tr', null,
          h('th', null, '消息'), h('th', null, '工单'), h('th', null, '状态'), h('th', null, '说明'))),
        h('tbody', null,
          ...queue.pending.map(row => h('tr', { key: row.id },
            h('td', null, h('span', { className: 'cnc-id' }, row.id)),
            h('td', null, row.ticket),
            h('td', null, `待投递 · 第 ${row.attempts} 次`),
            h('td', null, row.reason ?? '—'))),
          ...queue.dropped.map(row => h('tr', { key: row.id },
            h('td', null, h('span', { className: 'cnc-id' }, row.id)),
            h('td', null, row.ticket),
            h('td', null, '已丢弃'),
            h('td', null, row.reason ?? '—')))))
    }

    // ----------------------------------------------------------- container
    function Panel() {
      const [snapshot, setSnapshot] = React.useState(undefined)
      const [error, setError] = React.useState(undefined)
      const [range, setRange] = React.useState('all')
      const [filter, setFilter] = React.useState('attention')
      const [bannerDismissed, setBannerDismissed] = React.useState(() => readBanner())
      const [expanded, setExpanded] = React.useState({})
      const [chartsOpen, setChartsOpen] = React.useState(true)
      const [detailOpen, setDetailOpen] = React.useState({})

      React.useEffect(() => {
        const controller = new AbortController()
        const load = () => {
          fetch(`${PANEL_PATH}?range=${range}`, { headers: { accept: 'application/json' }, signal: controller.signal })
            .then(response => {
              if (!response.ok) throw new Error(`接口返回 ${response.status}`)
              return response.json()
            })
            .then(value => { setSnapshot(value); setError(undefined) })
            .catch(cause => {
              if (cause?.name === 'AbortError') return
              setError(String(cause?.message ?? cause))
            })
        }
        load()
        const timer = setInterval(load, 15000)
        return () => { clearInterval(timer); controller.abort() }
      }, [range])

      const dismissBanner = () => {
        writeBanner(true)
        setBannerDismissed(true)
      }

      if (error !== undefined) {
        return h('div', { className: 'cnc-root' },
          h('div', { className: 'cnc-head' }, h('span', { className: 'cnc-head-title' }, '代理管家')),
          h('div', { className: 'cnc-empty' }, `读取失败：${error}`))
      }
      if (snapshot === undefined) {
        return h('div', { className: 'cnc-root' }, h('div', { className: 'cnc-empty' }, '加载中…'))
      }

      return h(PanelView, {
        snapshot,
        ui: {
          range,
          filter,
          bannerDismissed,
          expanded,
          chartsOpen,
          detailOpen,
          onRange: next => setRange(next),
          onFilter: next => setFilter(next),
          onDismissBanner: dismissBanner,
          onToggleCharts: () => setChartsOpen(value => !value),
          onToggleRow: id => setExpanded(current => ({ ...current, [id]: current[id] !== true })),
          onToggleDetail: key => setDetailOpen(current => ({ ...current, [key]: current[key] !== true })),
        },
      })
    }

    /** The banner's dismissal is remembered across sessions; storage may be unavailable. */
    function readBanner() {
      try { return globalThis.localStorage?.getItem(BANNER_KEY) === '1' } catch { return false }
    }
    function writeBanner(value) {
      try { globalThis.localStorage?.setItem(BANNER_KEY, value ? '1' : '0') } catch { /* private mode */ }
    }

    /** The sidebar icon: a hub with three worker lanes, matching the bundle icon. */
    function Icon({ size = 18 }) {
      return h('svg', {
        viewBox: '0 0 64 64', width: size, height: size, 'aria-hidden': true,
        style: { display: 'block' },
      },
      h('circle', { cx: 32, cy: 16, r: 8, fill: 'currentColor', opacity: 0.9 }),
      h('path', { d: 'M32 24v6M32 30H15v8M32 30v8M32 30h17v8', stroke: 'currentColor', strokeWidth: 2, fill: 'none', opacity: 0.5 }),
      h('rect', { x: 8, y: 38, width: 14, height: 14, rx: 4, fill: 'currentColor', opacity: 0.7 }),
      h('rect', { x: 25, y: 38, width: 14, height: 14, rx: 4, fill: 'currentColor', opacity: 0.85 }),
      h('rect', { x: 42, y: 38, width: 14, height: 14, rx: 4, fill: 'currentColor', opacity: 0.7 }))
    }

    return {
      // Exposed for tests and for a future detail view: the pure renderer, no lifecycle.
      view: PanelView,
      maps: { TICKET_STATUS, BUCKET, REPORT_STATE, VERDICT, DISPOSITION, DECISION_STATE, RANGE_LABEL, FILTER_LABEL },
      helpers: { applyFilter, emptyText, relative, needsLabel, normalizeSnapshot },
      inject: ['slots', 'locale'],
      apply(ctx) {
        // Panel-local styles, removed with the fiber.
        ctx.effect(() => {
          const node = document.createElement('style')
          node.dataset.concierge = 'panel'
          node.textContent = STYLE
          document.head.appendChild(node)
          return () => { node.remove() }
        }, 'concierge/panel-style')

        // The central panel, keyed by the same id the sidebar entry dispatches.
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: ENTRY_ID,
          locale: 'concierge',
        }, Panel))

        // The sidebar entry itself.
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: ENTRY_ID,
          order: 60,
          label: () => '代理管家',
          locale: 'concierge',
        }, props => h(Icon, { size: typeof props?.size === 'number' ? props.size : 18 })))
      },
    }
  },
})
