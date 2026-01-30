export type AuthConfig = {
  enabled: boolean
  token: string | null
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

export function validateToken(provided: string | null, expected: string): boolean {
  if (!provided) return false
  if (provided.length !== expected.length) return false

  let result = 0
  for (let i = 0; i < provided.length; i++) {
    result |= provided.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return result === 0
}

export function createAuthConfig(options: { auth?: boolean; token?: string }): AuthConfig {
  if (!options.auth && !options.token) {
    return { enabled: false, token: null }
  }

  const token = options.token || generateToken()
  return { enabled: true, token }
}

export function isAuthenticated(req: Request, config: AuthConfig): boolean {
  if (!config.enabled || !config.token) {
    return true
  }

  const provided = extractToken(req)
  return validateToken(provided, config.token)
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
