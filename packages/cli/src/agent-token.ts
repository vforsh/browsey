import { homedir } from 'os'
import { dirname, join } from 'path'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { generateToken } from '@vforsh/browsey-shared'

const TOKEN_FILE = join(homedir(), '.browsey', 'agent-token')

export function getAgentTokenPath(): string {
  return TOKEN_FILE
}

export function readAgentToken(): string | null {
  try {
    const token = readFileSync(TOKEN_FILE, 'utf-8').trim()
    return token || null
  } catch {
    return null
  }
}

/**
 * Generated once and reused across restarts so a paired phone keeps working.
 * Mode 0600 — this token is arbitrary code execution on the machine.
 */
export function readOrCreateAgentToken(): string {
  const existing = readAgentToken()
  if (existing) return existing

  const token = generateToken()
  mkdirSync(dirname(TOKEN_FILE), { recursive: true })
  writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 })
  chmodSync(TOKEN_FILE, 0o600)
  return token
}
