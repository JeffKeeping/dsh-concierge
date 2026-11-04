/**
 * Secrets handling for Source configuration.
 *
 * A webhook token is a shared secret. It is read from a file or the environment and is
 * **never** stored in SQLite: the database keeps only a fingerprint (first four characters
 * plus a hash) so an operator can tell two tokens apart and confirm the right one is in
 * use, without the store being able to leak the value.
 *
 * The full value is resolved at send/receive time through a resolver held in memory, so a
 * process restart re-reads the file rather than the database.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

/** How much of the token is kept in the clear, for recognition only. */
export const PREFIX_LENGTH = 4

/**
 * A fingerprint safe to store and display: `s3cr…9f2a1c0b`.
 * @param {string} token
 * @returns {string}
 */
export function fingerprint(token) {
  const value = String(token ?? '')
  if (value === '') return ''
  const hash = createHash('sha256').update(value).digest('hex').slice(0, 8)
  const prefix = value.slice(0, PREFIX_LENGTH)
  return `${prefix}…${hash}`
}

/** Whether a presented token matches a known one, in constant time on the hash. */
export function tokenMatches(presented, expected) {
  if (typeof expected !== 'string' || expected === '') return false
  if (typeof presented !== 'string' || presented === '') return false
  const a = createHash('sha256').update(presented).digest()
  const b = createHash('sha256').update(expected).digest()
  // Both digests are the same length, so a plain comparison leaks only the first mismatch.
  let diff = 0
  for (let index = 0; index < a.length; index++) diff |= a[index] ^ b[index]
  return diff === 0
}

/**
 * Resolve a token from its declared source.
 *
 * Order of precedence, highest first: an explicit value (tests only), a file, an
 * environment variable. A missing file or variable is a configuration error, reported
 * without echoing any secret.
 *
 * @param {{ tokenFile?: string, tokenEnv?: string, token?: string }} spec
 * @returns {{ token: string | undefined, source: string }}
 */
export function resolveToken(spec = {}) {
  if (typeof spec.token === 'string' && spec.token !== '') {
    return { token: spec.token, source: 'inline' }
  }
  if (typeof spec.tokenFile === 'string' && spec.tokenFile !== '') {
    try {
      const value = readFileSync(spec.tokenFile, 'utf8').trim()
      if (value === '') throw new Error('token file is empty')
      return { token: value, source: `file:${spec.tokenFile}` }
    } catch (error) {
      throw new Error(`cannot read token file ${spec.tokenFile}: ${error?.code ?? error?.message ?? error}`)
    }
  }
  if (typeof spec.tokenEnv === 'string' && spec.tokenEnv !== '') {
    const value = process.env[spec.tokenEnv]
    if (value === undefined || value === '') {
      throw new Error(`environment variable ${spec.tokenEnv} is not set`)
    }
    return { token: value.trim(), source: `env:${spec.tokenEnv}` }
  }
  return { token: undefined, source: 'none' }
}

/**
 * Replace a secret in a string before it reaches a log or a view.
 * Used as a last line of defence; call sites never pass the token around in text.
 */
export function redact(text, secrets) {
  let out = String(text ?? '')
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= PREFIX_LENGTH) out = out.split(secret).join('***')
  }
  return out
}

/** The display form stored in a Source row: fingerprint only, never the value. */
export function tokenDisplay(token) {
  return token ? fingerprint(token) : null
}
