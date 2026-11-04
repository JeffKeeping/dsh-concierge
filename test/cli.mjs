/**
 * The Source management CLI's argument handling.
 *
 * A shell that rewrites a leading slash (`git-bash` on Windows turns `/concierge/webhook/ops`
 * into `/c/concierge/webhook/ops`) must not silently create an instance with a wrong route.
 *
 * Run: node test/cli.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const results = []
function check(name, condition, detail = undefined) {
  results.push({ name, pass: Boolean(condition), detail })
  if (!condition) console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  else console.log(`ok    ${name}`)
}

const dir = await mkdtemp(join(tmpdir(), 'concierge-cli-'))
const env = { ...process.env, DSH_HOME: dir }
const cli = file => join(process.cwd(), 'scripts', 'source.mjs')

try {
  // A leading-slash route survives the shell: the mangled form is repaired.
  const added = await run(process.execPath, [
    cli(), 'add', '--id', 'wh-1',
    '--endpoint', '/c/concierge/webhook/ops',
    '--reply', 'http://127.0.0.1:9/reply',
    '--allow', 'alice',
    '--listen', 'ops=all',
  ], { env })
  const created = JSON.parse(added.stdout)
  check('add creates the instance', created.ok === true && created.source.id === 'wh-1')
  check('a shell-mangled endpoint is repaired', created.source.config.endpoint === '/concierge/webhook/ops', created.source.config.endpoint)
  check('the allowed list is stored', created.source.config.policy.allowed[0].id === 'alice')
  check('the listen scope is stored', created.source.config.conversations.ops === 'all')

  // The drive-letter form a Windows shell actually produces for a leading slash.
  const driveForm = await run(process.execPath, [
    cli(), 'add', '--id', 'wh-drive',
    '--endpoint', 'C:/concierge/webhook/drive',
    '--reply', 'http://127.0.0.1:9/reply',
  ], { env })
  const driveCreated = JSON.parse(driveForm.stdout)
  check('a drive-letter endpoint is repaired', driveCreated.source.config.endpoint === '/concierge/webhook/drive', driveCreated.source.config.endpoint)

  // A route that already looks like a route is left alone.
  const plainForm = await run(process.execPath, [
    cli(), 'add', '--id', 'wh-plain',
    '--endpoint', '/concierge/webhook/plain',
    '--reply', 'http://127.0.0.1:9/reply',
  ], { env })
  check('a plain route is not rewritten', JSON.parse(plainForm.stdout).source.config.endpoint === '/concierge/webhook/plain')

  const listed = JSON.parse((await run(process.execPath, [cli(), 'list'], { env })).stdout)
  check('list shows every instance', listed.length === 3 && listed.some(row => row.id === 'wh-1'), String(listed.length))

  const disabled = JSON.parse((await run(process.execPath, [cli(), 'disable', '--id', 'wh-1'], { env })).stdout)
  check('disable flips the switch', disabled.enabled === false)
  const afterDisable = JSON.parse((await run(process.execPath, [cli(), 'list'], { env })).stdout)
  check('the switch persists', afterDisable.find(row => row.id === 'wh-1')?.enabled === false)

  const removed = JSON.parse((await run(process.execPath, [cli(), 'remove', '--id', 'wh-1'], { env })).stdout)
  check('remove deletes the instance', removed.ok === true)
  const afterRemove = JSON.parse((await run(process.execPath, [cli(), 'list'], { env })).stdout)
  check('a removed instance is gone', afterRemove.every(row => row.id !== 'wh-1'), String(afterRemove.length))

  // A bad configuration is refused, not coerced.
  let failed = false
  try {
    await run(process.execPath, [cli(), 'add', '--id', 'wh-2', '--endpoint', '/x'], { env })
  } catch (error) {
    failed = String(error.stderr ?? error).includes('replyUrl is required')
  }
  check('a config without replyUrl is refused', failed)
} finally {
  await rm(dir, { recursive: true, force: true })
}

const failed = results.filter(result => !result.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exitCode = 1
