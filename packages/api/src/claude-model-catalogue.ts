import { spawn } from 'child_process'
import { effortOption } from './effort.js'
import type { AgentEffortOption, AgentModelOption } from '@vforsh/browsey-shared'

/**
 * Claude Code cannot be asked what models it accepts. There is no subcommand,
 * no catalogue cached on disk, and no JSON-RPC equivalent of Codex's
 * `model/list`; its own `/model` picker is fed by a private endpoint, and
 * `--help` documents the `--model` flag without enumerating anything.
 *
 * The account's catalogue at `GET /v1/models` is the next best source, and for
 * this purpose a better one than the CLI would be: listing is not token-billed,
 * one request covers every model, and each entry carries the `display_name` and
 * `created_at` that the picker used to hardcode. A label that arrives alongside
 * its own id cannot drift out of sync with it, which is the whole bug this
 * replaces — the list had accumulated labels like "Sonnet 4.6" on an id that
 * had long since started resolving to Sonnet 5.
 *
 * Bare aliases (`opus`, `fable`, `sonnet`) are deliberately absent from what
 * this produces. They are the only ids whose meaning moves under you, so they
 * are exactly what a self-maintaining list must not contain.
 */

const MODELS_URL = 'https://api.anthropic.com/v1/models?limit=100'
const ANTHROPIC_VERSION = '2023-06-01'

/** Model catalogues change on release day, not on the hour. */
const CACHE_TTL_MS = 6 * 60 * 60_000
/** Keeps a logged-out or offline machine from re-fetching on every sheet open. */
const RETRY_AFTER_FAILURE_MS = 60_000
const FETCH_TIMEOUT_MS = 10_000
const KEYCHAIN_TIMEOUT_MS = 3_000

/**
 * Canonical order for the effort row. The response nests each level as its own
 * key, and object key order is not a contract worth depending on.
 */
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max']

const KEYCHAIN_SERVICE = 'Claude Code-credentials'

/** Newest first. Shaped as the picker's own row: nothing here needs mapping. */
export type ClaudeCatalogue = AgentModelOption[]

let cached: { at: number; catalogue: ClaudeCatalogue } | null = null
let lastFailureAt = 0
let inFlight: Promise<void> | null = null

/** Chips are narrow and every display name starts with the same seven characters. */
function chipLabel(displayName: string): string {
  return displayName.replace(/^Claude\s+/, '')
}

function readEfforts(capabilities: unknown): AgentEffortOption[] {
  const effort = (capabilities as { effort?: Record<string, unknown> } | null)?.effort
  if (!effort || effort.supported !== true) return []
  return EFFORT_ORDER.filter(
    (id) => (effort[id] as { supported?: unknown } | undefined)?.supported === true
  ).map((id) => effortOption(id))
}

function readModels(body: unknown): ClaudeCatalogue {
  const data = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return []

  const models: { model: AgentModelOption; createdAt: string }[] = []
  for (const entry of data) {
    const {
      id,
      display_name: displayName,
      created_at: createdAt,
      capabilities,
    } = (entry ?? {}) as {
      id?: unknown
      display_name?: unknown
      created_at?: unknown
      capabilities?: unknown
    }
    if (typeof id !== 'string' || id.length === 0) continue
    models.push({
      model: {
        id,
        label: chipLabel(typeof displayName === 'string' && displayName ? displayName : id),
        efforts: readEfforts(capabilities),
      },
      createdAt: typeof createdAt === 'string' ? createdAt : '',
    })
  }

  // The endpoint documents no ordering. Newest first is the only order where the
  // model someone actually wants is not halfway along a scrolling row.
  models.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return models.map((entry) => entry.model)
}

/** Resolves to trimmed stdout, or null on any failure at all. */
function runCapture(command: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    let stdout = ''
    const timer = setTimeout(() => child.kill(), timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.once('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0 ? stdout.trim() : null)
    })
  })
}

async function readKeychainToken(): Promise<string | null> {
  const raw = await runCapture(
    'security',
    ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
    KEYCHAIN_TIMEOUT_MS
  )
  if (!raw) return null

  try {
    const { claudeAiOauth } = JSON.parse(raw) as {
      claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown }
    }
    const token = claudeAiOauth?.accessToken
    const expiresAt = claudeAiOauth?.expiresAt
    // An expired token is worse than no token: it 401s, and a 401 is
    // indistinguishable here from a real outage, so it would sit in the failure
    // backoff instead of falling straight through to the curated list.
    if (typeof expiresAt === 'number' && expiresAt <= Date.now()) return null
    return typeof token === 'string' && token.length > 0 ? token : null
  } catch {
    return null
  }
}

/**
 * Most explicit credential first. An API key is the documented way into
 * `/v1/models` and the only one that survives a logged-out CLI, but a machine on
 * a subscription never has one — Claude Code writes an OAuth token to the login
 * keychain instead. Pairing that token with this endpoint is undocumented and
 * may stop working, which is why it is the fallback and not the path, and why
 * every caller here still has a curated list to fall back to.
 */
async function readCredential(
  env: NodeJS.ProcessEnv
): Promise<{ header: string; value: string } | null> {
  const key = env.ANTHROPIC_API_KEY?.trim()
  if (key) return { header: 'x-api-key', value: key }

  const token = await readKeychainToken()
  return token ? { header: 'authorization', value: `Bearer ${token}` } : null
}

async function fetchCatalogue(env: NodeJS.ProcessEnv): Promise<ClaudeCatalogue> {
  const credential = await readCredential(env)
  if (!credential) {
    throw new Error('no ANTHROPIC_API_KEY, and no Claude Code credentials in the keychain')
  }

  const response = await fetch(MODELS_URL, {
    headers: {
      [credential.header]: credential.value,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`GET /v1/models answered ${response.status} ${response.statusText}`)
  }

  return readModels(await response.json())
}

function scheduleRefresh(env: NodeJS.ProcessEnv): void {
  if (inFlight) return
  if (Date.now() - lastFailureAt < RETRY_AFTER_FAILURE_MS) return

  inFlight = fetchCatalogue(env)
    .then((catalogue) => {
      // An empty answer is not an answer; keeping the previous one, or the
      // curated list, beats caching a blank for six hours.
      if (catalogue.length > 0) cached = { at: Date.now(), catalogue }
      else lastFailureAt = Date.now()
    })
    .catch((error: unknown) => {
      lastFailureAt = Date.now()
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`Warning: could not read the Claude model catalogue: ${message}`)
    })
    .finally(() => {
      inFlight = null
    })
}

/**
 * What is known right now, or null before the catalogue has ever been read.
 * Never blocks: a stale or absent entry only schedules the refresh behind the
 * caller, which takes the curated list this once and the real one next time.
 */
export function cachedClaudeCatalogue(env: NodeJS.ProcessEnv): ClaudeCatalogue | null {
  const fresh = cached !== null && Date.now() - cached.at < CACHE_TTL_MS
  if (!fresh) scheduleRefresh(env)
  return cached?.catalogue ?? null
}

/**
 * Awaited, unlike the background path, because this one has a user waiting on
 * it: a model shipped today should reach the picker when asked, not up to six
 * hours later. It also ignores the failure backoff — the button *is* the retry —
 * and it throws, so "nothing changed" can be told apart from "could not look".
 */
export async function refreshClaudeCatalogue(env: NodeJS.ProcessEnv): Promise<ClaudeCatalogue> {
  const catalogue = await fetchCatalogue(env)
  if (catalogue.length === 0) throw new Error('GET /v1/models returned no models')

  cached = { at: Date.now(), catalogue }
  lastFailureAt = 0
  return catalogue
}
