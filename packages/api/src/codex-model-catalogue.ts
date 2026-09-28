import { openAppServer } from './codex-app-server.js'
import { effortOption } from './effort.js'
import type { AgentEffortOption, AgentModelOption } from '@vforsh/browsey-shared'

/**
 * Codex's `model/list` supplies both the models available to this account and
 * the reasoning levels each accepts. The catalogue is the source of truth for
 * the picker; a small fallback only covers a cold start or failed read.
 *
 * The catch is cost: reading it means an app server, and a cold one takes tens
 * of seconds. The sheet cannot wait for that, so nothing here is ever awaited
 * on the request path. Callers take whatever is cached — or the fallback on a
 * cold start — and a refresh runs behind them for the next call.
 */

/** Model catalogues change on release day, not on the hour. */
const CACHE_TTL_MS = 6 * 60 * 60_000
/** Keeps a broken or logged-out codex from spawning a server per sheet open. */
const RETRY_AFTER_FAILURE_MS = 60_000
const LIST_TIMEOUT_MS = 30_000
/** Paranoia against a cursor that never ends; the real catalogue is one page. */
const MAX_PAGES = 5

/** Levels every model in the catalogue has advertised, used until it is read. */
export const FALLBACK_EFFORT_IDS = ['low', 'medium', 'high', 'xhigh']

export type CodexCatalogue = {
  models: AgentModelOption[]
  hiddenIds: Set<string>
}

type CatalogueModel = {
  id?: unknown
  displayName?: unknown
  hidden?: unknown
  supportedReasoningEfforts?: unknown
}

let cached: { at: number; catalogue: CodexCatalogue } | null = null
let lastFailureAt = 0
let inFlight: Promise<CodexCatalogue> | null = null

function readEfforts(raw: unknown): AgentEffortOption[] {
  if (!Array.isArray(raw)) return []
  const options: AgentEffortOption[] = []
  for (const entry of raw) {
    const { reasoningEffort, description } = (entry ?? {}) as {
      reasoningEffort?: unknown
      description?: unknown
    }
    if (typeof reasoningEffort !== 'string' || reasoningEffort.length === 0) continue
    options.push(
      effortOption(reasoningEffort, typeof description === 'string' ? description : undefined)
    )
  }
  return options
}

async function fetchCatalogue(binary: string, env: NodeJS.ProcessEnv): Promise<CodexCatalogue> {
  // Home rather than a project directory: the catalogue is account-wide, and a
  // cwd would only pull in project config that cannot change the answer.
  const server = await openAppServer({
    binary,
    cwd: env.HOME || process.cwd(),
    logFd: null,
    env,
    detached: false,
  })

  try {
    const models: AgentModelOption[] = []
    const hiddenIds = new Set<string>()
    const seen = new Set<string>()
    let cursor: string | null = null

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await server.request(
        'model/list',
        cursor ? { cursor } : {},
        LIST_TIMEOUT_MS
      )
      for (const model of (result.data as CatalogueModel[] | undefined) ?? []) {
        const id = model.id
        if (typeof id !== 'string' || !id || seen.has(id)) continue
        seen.add(id)
        if (model.hidden === true) {
          hiddenIds.add(id)
          continue
        }
        const displayName = model.displayName
        models.push({
          id,
          label: typeof displayName === 'string' && displayName.trim() ? displayName : id,
          efforts: readEfforts(model.supportedReasoningEfforts),
        })
      }
      const next = result.nextCursor
      if (typeof next !== 'string' || next.length === 0) break
      cursor = next
    }

    if (models.length === 0) throw new Error('Codex model/list returned no visible models')
    return { models, hiddenIds }
  } finally {
    server.endStdin()
  }
}

/**
 * What is known right now, or null before the catalogue has ever been read.
 * Never blocks; a stale or absent entry only schedules the refresh.
 */
export function cachedCodexCatalogue(binary: string | null, env: NodeJS.ProcessEnv) {
  const fresh = cached !== null && Date.now() - cached.at < CACHE_TTL_MS
  if (!fresh && binary) scheduleRefresh(binary, env)
  return cached?.catalogue ?? null
}

function scheduleRefresh(binary: string, env: NodeJS.ProcessEnv): void {
  if (inFlight) return
  if (Date.now() - lastFailureAt < RETRY_AFTER_FAILURE_MS) return

  void readAndCache(binary, env)
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`Warning: could not read the codex model catalogue: ${message}`)
    })
}

function readAndCache(binary: string, env: NodeJS.ProcessEnv): Promise<CodexCatalogue> {
  if (inFlight) return inFlight
  inFlight = fetchCatalogue(binary, env)
    .then((catalogue) => {
      cached = { at: Date.now(), catalogue }
      lastFailureAt = 0
      return catalogue
    })
    .catch((error: unknown) => {
      lastFailureAt = Date.now()
      throw error
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

/** A button press bypasses the cache age and failure backoff. */
export function refreshCodexCatalogue(
  binary: string,
  env: NodeJS.ProcessEnv
): Promise<CodexCatalogue> {
  return readAndCache(binary, env)
}
