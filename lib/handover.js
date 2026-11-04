/**
 * The handover when a ticket is reopened.
 *
 * A reopened ticket is where a wrong conclusion does lasting damage. In the incident this
 * module exists for, a worker finished its artifact but never reported; the Router decided
 * it was gone, verified the artifact itself, got it wrong, and wrote that wrong conclusion
 * into the new ticket — where a fresh worker trusted it and acted on it.
 *
 * So a handover has exactly two blocks, and they are never mixed:
 *
 *   1. **Facts** — the previous worker's artifact paths. These are things that exist.
 *   2. **待核实线索** — everything the Router believes but has not proven. Explicitly marked
 *      untrusted, and paired with the standing instruction to reproduce before acting.
 *
 * The two workers' directories stay separate; the new one never inherits the old one's
 * files, only their paths.
 */

/** The sentence every reopened ticket carries. It is not optional. */
export const VERIFY_FIRST = '上游结论可能错误，动手前先自行复现核实。'

/** The label the panel and the ticket body use for unverified claims. */
export const LEADS_LABEL = '【待核实线索】'

/** The label for what the worker must deliver. */
export const CONTRACT_LABEL = '【交付约束】'

/**
 * The worker brief template, appended to every dispatch and every reopen.
 *
 * Three things it must accomplish, each aimed at a failure that actually happened:
 *   - `superagent_report` is the only exit, so a finished worker never just stops;
 *   - a first `progress` report, so the watchdog has something to compare from minute one;
 *   - evidence named in the report, so "done" is checkable rather than asserted.
 */
export const WORKER_RULES = Object.freeze([
  '`superagent_report` 是你唯一的退出通道。完成用 `done`，受阻用 `blocked`，做不下去用 `failed`。不调用它，你就等于没有完成工作——系统只会看到你失联。',
  '接单后**立刻**先回一条 `progress`（确认接单），然后开始干活。巡检从这一刻起才有状态可比。',
  '交付类任务必须附带可核查的证据：截图、测试输出、命令回显。把证据文件名写进 report 的 summary，例如「已生成 out/index.html，截图 evidence/shot.png」。',
  '只回产物、不回 report，不算完成。产物在目录里，但没有人知道它做完了。',
])

/**
 * Build a reopened ticket's task text.
 *
 * @param {{
 *   title: string,
 *   task: string,
 *   artifacts: Array<{ path: string, files?: string[] }>,
 *   leads: string[],
 *   previousTicketId: string,
 * }} input
 * @returns {string} the text a fresh worker receives
 */
export function reopenedTaskText({ title, task, artifacts = [], leads = [], previousTicketId }) {
  const lines = [
    `# 重开工单：${title}`,
    '',
    `上一张工单 ${previousTicketId} 没有完成交付（它可能完成了产物但没有汇报，也可能中途失联）。`,
    '你现在拿到的是交接信息，**不是**已验证的结论。',
    '',
    '## 任务',
    '',
    String(task ?? '').trim(),
    '',
    '## 上一 worker 的产物（事实）',
    '',
  ]
  if (artifacts.length === 0) {
    lines.push('（上一 worker 没有留下可识别的产物文件）')
  } else {
    for (const artifact of artifacts) {
      lines.push(`- 目录：${artifact.path}`)
      for (const file of (artifact.files ?? []).slice(0, 20)) lines.push(`  - ${file}`)
      if ((artifact.files ?? []).length > 20) lines.push(`  - ……另有 ${artifact.files.length - 20} 个文件`)
    }
    lines.push('', '这些文件可能存在、可能不完整、可能是中间状态。目录与你自己的工作目录隔离，请用自己的目录重新产出。')
  }

  lines.push('', `## ${LEADS_LABEL}（不可信，须先复现）`, '')
  if (leads.length === 0) {
    lines.push('（上游没有提供线索）')
  } else {
    for (const lead of leads) lines.push(`- ${lead}`)
    lines.push('', '以上均为**未核实**的观察，可能完全错误。不要把任何一条当成需求或事实。')
  }

  lines.push('', `## ${CONTRACT_LABEL}`, '')
  lines.push(`1. ${VERIFY_FIRST}`)
  lines.push('2. 用你自己的判断独立完成上面「任务」一节的要求。')
  lines.push('3. 完成后调用 superagent_report 报 `done`，并在 summary 里写明证据文件名。')
  lines.push('4. 接单后先回一条 `progress` 再动手。')

  return lines.join('\n')
}

/**
 * Whether a ticket body already carries the reopen marker, so a reopen is not applied twice.
 */
export function isReopened(text) {
  return String(text ?? '').includes(LEADS_LABEL) || String(text ?? '').includes(CONTRACT_LABEL)
}
