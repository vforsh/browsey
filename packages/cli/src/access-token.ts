import { homedir } from 'os'
import { dirname, join } from 'path'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { generateToken } from '@vforsh/browsey-shared'

const TOKEN_FILE = join(homedir(), '.browsey', 'access-token')

export function getAccessTokenPath(): string {
  return TOKEN_FILE
}

/**
 * A token file, wherever it lives. Trailing newline trimmed, because the natural
 * way to make one of these is `echo secret > file`.
 */
export function readAccessTokenFile(path: string): string | null {
  try {
    const token = readFileSync(path, 'utf-8').trim()
    return token || null
  } catch {
    return null
  }
}

export function readAccessToken(): string | null {
  return readAccessTokenFile(TOKEN_FILE)
}

/**
 * Generated once and reused across restarts, so a paired phone keeps working.
 * Mode 0600 — this token is the origin's whole defence once the API is published
 * through a tunnel.
 */
export function readOrCreateAccessToken(): string {
  const existing = readAccessToken()
  if (existing) return existing

  const token = generateToken()
  mkdirSync(dirname(TOKEN_FILE), { recursive: true })
  writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 })
  chmodSync(TOKEN_FILE, 0o600)
  return token
}
