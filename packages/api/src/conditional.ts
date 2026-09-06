/**
 * Strong `ETag` + `If-None-Match` handling for the read routes.
 *
 * The tag hashes the exact serialized response body, never the directory's
 * mtime: a directory's mtime does not move when a child file's contents
 * change, so an mtime-based tag would answer `304` while the sizes and
 * timestamps the client is displaying are already stale. Hashing the payload
 * the handler has just built costs a few microseconds and is strictly correct
 * — the tag changes whenever anything the client can see changes.
 *
 * Over a Cloudflare Tunnel on LTE this is the difference between a folder that
 * opens instantly (one RTT, no body) and one that stalls on a full re-download.
 */

const JSON_CONTENT_TYPE = 'application/json'

/**
 * Strong, quoted tag. `Bun.hash` (wyhash) is not cryptographic, which is fine:
 * a collision here shows a stale listing, it is not a security boundary.
 */
export function computeETag(body: string): string {
  const digest = Bun.hash(body)
  return `"${(typeof digest === 'bigint' ? digest : BigInt(digest)).toString(16)}"`
}

/** The opaque part of a tag: surrounding whitespace and a `W/` prefix dropped. */
function opaqueTag(tag: string): string {
  const trimmed = tag.trim()
  return trimmed.startsWith('W/') ? trimmed.slice(2).trim() : trimmed
}

/**
 * `If-None-Match` matching: `*`, a single tag, or a comma-separated list.
 * A client may send its tag weakly (`W/"abc"`); compare the opaque part.
 */
export function ifNoneMatchSatisfied(header: string | null | undefined, etag: string): boolean {
  if (!header) return false

  const wanted = opaqueTag(etag)
  for (const candidate of header.split(',')) {
    const tag = candidate.trim()
    if (!tag) continue
    if (tag === '*') return true
    if (opaqueTag(tag) === wanted) return true
  }
  return false
}

/**
 * Serializes `payload` **once**, tags it, and returns either a bodyless `304`
 * carrying only the `ETag` (no `Content-Type`) or the usual `200` JSON
 * response with the tag attached. Response fields are byte-identical to what
 * `jsonResponse` would have produced.
 */
export function conditionalJsonResponse(req: Request, payload: unknown): Response {
  const body = JSON.stringify(payload)
  const etag = computeETag(body)

  if (ifNoneMatchSatisfied(req.headers.get('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers: { ETag: etag } })
  }

  return new Response(body, {
    headers: {
      'Content-Type': JSON_CONTENT_TYPE,
      ETag: etag,
    },
  })
}
