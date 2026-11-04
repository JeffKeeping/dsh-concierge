/**
 * Minimal HTTP helpers for the webhook Source.
 *
 * Only what an intake route needs: read a bounded JSON body and answer with JSON. No
 * router, no middleware, no framework — the Host owns the listener and the routing table.
 */

/** Read and parse one JSON body, bounded so a huge request cannot exhaust memory. */
export async function readBody(req, maxBytes = 1_000_000) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > maxBytes) throw new Error(`request body exceeds ${maxBytes} bytes`)
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  return JSON.parse(text)
}

/** Answer with JSON; the route owns the whole response lifecycle. */
export function sendJson(res, status, value) {
  if (res.headersSent) return
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}
