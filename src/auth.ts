/**
 * Authentication utilities for Browsey
 *
 * Provides token generation and validation for API route protection.
 * Tokens are 32-byte cryptographically random values encoded as base64url.
 */

export type AuthConfig = {
  enabled: boolean
  token: string | null
}

/**
 * Generate a cryptographically secure random token.
 * Uses 32 bytes (256 bits) encoded as base64url for URL-safe usage.
 */
export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  // Convert to base64url (URL-safe base64 without padding)
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/**
 * Extract token from a request.
 * Checks:
 * 1. Authorization header (Bearer token)
 * 2. Query parameter (?token=xxx)
 *
 * Returns null if no token found.
 */
export function extractToken(req: Request): string | null {
  // Check Authorization header first (preferred)
  const authHeader = req.headers.get('Authorization')
  if (authHeader) {
    const match = authHeader.match(/^Bearer\s+(.+)$/i)
    if (match && match[1]) {
      return match[1]
    }
  }

  // Fall back to query parameter (for mobile/browser convenience)
  const url = new URL(req.url)
  const queryToken = url.searchParams.get('token')
  if (queryToken) {
    return queryToken
  }

  return null
}

/**
 * Validate a token against the expected value.
 * Uses constant-time comparison to prevent timing attacks.
 */
export function validateToken(provided: string | null, expected: string): boolean {
  if (!provided) return false

  // Constant-time comparison
  if (provided.length !== expected.length) return false

  let result = 0
  for (let i = 0; i < provided.length; i++) {
    result |= provided.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return result === 0
}

/**
 * Create an authentication configuration based on CLI options.
 */
export function createAuthConfig(options: { auth?: boolean; token?: string }): AuthConfig {
  if (!options.auth && !options.token) {
    return { enabled: false, token: null }
  }

  // Use provided token or generate a new one
  const token = options.token || generateToken()

  return { enabled: true, token }
}

/**
 * Check if a request is authenticated.
 * Returns true if auth is disabled or token is valid.
 */
export function isAuthenticated(req: Request, config: AuthConfig): boolean {
  if (!config.enabled || !config.token) {
    return true // Auth disabled
  }

  const provided = extractToken(req)
  return validateToken(provided, config.token)
}

/**
 * Create a 401 Unauthorized response.
 */
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
