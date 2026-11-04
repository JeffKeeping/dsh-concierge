/**
 * Small text helpers shared by the state layer, the tool surface and the watchdog.
 * Pure functions only; no I/O, no framework imports.
 */
import { createHash } from 'node:crypto'

/** Collapse all whitespace so two renderings of the same output compare equal. */
export function norm(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/** Short stable digest used to spot a worker repeating itself. */
export function digest(value) {
  return createHash('sha1').update(String(value ?? '')).digest('hex').slice(0, 16)
}

/** Byte length of a string in UTF-8, the same unit the spill threshold uses. */
export function bytes(value) {
  return Buffer.byteLength(String(value ?? ''), 'utf8')
}

/**
 * Cut `value` to at most `max` UTF-16 code units.
 * @returns {{ text: string, clipped: boolean, bytes: number }} the clip result and the original size.
 */
export function clip(value, max) {
  const text = String(value ?? '')
  const size = bytes(text)
  if (text.length <= max) return { text, clipped: false, bytes: size }
  return { text: text.slice(0, max), clipped: true, bytes: size }
}

/** A single-line summary for inline context: first non-empty line, clipped. */
export function summarize(value, max = 160) {
  const flat = norm(value)
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(0, max - 1))}…`
}

/** Join the text blocks of a message content array. */
export function blocksText(content) {
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out
}

/** Render the ticket directory name: filesystem safe, stable per ticket id. */
export function safeSegment(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64)
}
