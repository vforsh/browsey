/**
 * Server-wide origin secret header. Exact case matters — it is the contract the
 * mobile client sends and the CLI's own probes must reproduce.
 *
 * Distinct from `Authorization: Bearer <agent-token>`, which stays a narrower
 * privilege on `/api/agents/*`. A protected server requires both there.
 */
export const ACCESS_TOKEN_HEADER = 'X-Browsey-Access-Token'

/**
 * One banner line, on or off, never the value — a token printed at startup ends
 * up in launchd logs and terminal scrollback for the rest of its life.
 */
export function describeAccessProtection(accessToken: string | undefined): string {
  return accessToken
    ? `protected — ${ACCESS_TOKEN_HEADER} required on every /api/ request`
    : 'off — anyone who can reach this port can use the API'
}

export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

export function extractToken(req: Request): string | null {
  const authHeader = req.headers.get('Authorization')
  if (authHeader) {
    const match = authHeader.match(/^Bearer\s+(.+)$/i)
    if (match && match[1]) {
      return match[1]
    }
  }

  const url = new URL(req.url)
  const queryToken = url.searchParams.get('token')
  if (queryToken) {
    return queryToken
  }

  return null
}

/**
 * Constant-time equality. Length is compared first and short-circuits, which
 * leaks the expected length — acceptable for fixed-width generated tokens and
 * unavoidable without a fixed-size digest step.
 */
export function validateToken(provided: string | null, expected: string): boolean {
  if (!provided) return false
  if (provided.length !== expected.length) return false

  let result = 0
  for (let i = 0; i < provided.length; i++) {
    result |= provided.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return result === 0
}

export function unauthorizedResponse(): Response {
  return new Response(
    JSON.stringify({ error: 'Unauthorized', message: 'Valid API token required' }),
    {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer realm="Browsey API"',
      },
    }
  )
}
