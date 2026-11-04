/**
 * Thread-matching contract for the v1 Router.
 *
 * The rule that matters: two requests are one thread only when they name the same
 * concrete artefact. Sharing ordinary words is not enough — otherwise independent
 * file-creation tasks collapse into one ticket and only the first ever runs.
 *
 * Run: node test/routing.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { State } from '../lib/state.js'
import { Router } from '../lib/router.js'

const results = []
function check(name, condition, detail = undefined) {
  results.push({ name, pass: Boolean(condition), detail })
  if (!condition) console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  else console.log(`ok    ${name}`)
}

const dir = await mkdtemp(join(tmpdir(), 'concierge-routing-'))
const state = new State({ dbPath: join(dir, 'routing.sqlite'), inlineChars: 2000 })
const stubSupervisor = { send: async () => ({ ok: true, delivery: 'delivered' }), pump() {}, openSlots: 3, slots: new Map() }
const router = new Router({ state, supervisor: stubSupervisor, config: { routerBatchMs: 0 }, logger: { debug() {}, warn() {} } })

try {
  // Four independent file-creation tasks: each must be its own ticket.
  const tasks = [
    '在 D:/work/probe 创建 cA.txt，内容 A',
    '在 D:/work/probe 创建 cB.txt，内容 B',
    '在 D:/work/probe 创建 cC.txt，内容 C',
    '在 D:/work/probe 创建 cD.txt，内容 D',
  ]
  const ids = []
  for (const text of tasks) {
    const result = await router.ask({ text, caller: 'router-session' })
    ids.push(result.ticket_id)
  }
  check('four distinct artefacts open four tickets', new Set(ids).size === 4, JSON.stringify(ids))

  // A follow-up on the same artefact joins that ticket.
  const followUp = await router.ask({ text: 'Make sure cB.txt ends with a newline', caller: 'router-session' })
  check('same artefact joins the existing thread', followUp.routed === 'thread' && followUp.ticket_id === ids[1], JSON.stringify(followUp))

  // The same artefact named by full path joins too, because the final segment agrees.
  const byPath = await router.ask({ text: 'Recheck D:/work/probe/cC.txt content', caller: 'router-session' })
  check('full path matches its bare filename', byPath.routed === 'thread' && byPath.ticket_id === ids[2], JSON.stringify(byPath))

  // Requests with no concrete artefact never merge by vocabulary alone.
  const vague = await router.ask({ text: 'Please fix the flaky test in the login module', caller: 'router-session' })
  const vagueAgain = await router.ask({ text: 'Please fix the flaky test in the login module again', caller: 'router-session' })
  check('requests without a named artefact open separate tickets', vague.routed === 'new-ticket' && vagueAgain.routed === 'new-ticket', JSON.stringify([vague.routed, vagueAgain.routed]))

  // An issue id is an artefact too.
  const issue = await router.ask({ text: 'Look at issue #123 and summarise it', caller: 'router-session' })
  const issueFollow = await router.ask({ text: 'Add a comment to #123', caller: 'router-session' })
  check('issue ids form threads', issue.routed === 'new-ticket' && issueFollow.routed === 'thread' && issueFollow.ticket_id === issue.ticket_id, JSON.stringify([issue, issueFollow]))
} finally {
  state.close()
  await rm(dir, { recursive: true, force: true })
}

const failed = results.filter(result => !result.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exitCode = 1
