import { openAppServer } from './codex-app-server.js'
import type { AgentEffortOption } from '@vforsh/browsey-shared'

/**
 * Which reasoning levels a Codex model accepts is the model's own business —
 * `ultra` exists only on the newest, older ones stop at `xhigh` — and the
 * catalogue is the only thing that actually knows. Offering a level a model
 * has never heard of is a rejected launch, so the list is read from
 * `model/list` rather than guessed.
 *
 * The catch is cost: reading it means an app server, and a cold one takes tens
 * of seconds. The sheet cannot wait for that, so nothing here is ever awaited
 * on the request path. Callers take whatever is cached — the curated fallback
 * on a cold start — and a refresh runs behind them for the next call.
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

const LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
  ultra: 'Ultra',
}

/** Model id to the levels it advertises, in the catalogue's own order. */
export type EffortCatalogue = Map<string, AgentEffortOption[]>

type CatalogueModel = {
  id?: unknown
  supportedReasoningEfforts?: unknown
}

let cached: { at: number; catalogue: EffortCatalogue } | null = null
let lastFailureAt = 0
let inFlight: Promise<void> | null = null

export function effortLabel(id: string): string {
  return LABELS[id] ?? `${id.charAt(0).toUpperCase()}${id.slice(1)}`
}

export function effortOption(id: string, description?: string): AgentEffortOption {
  return { id, label: effortLabel(id), ...(description ? { description } : {}) }
}

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

async function fetchCatalogue(binary: string, env: NodeJS.ProcessEnv): Promise<EffortCatalogue> {
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
    const catalogue: EffortCatalogue = new Map()
    let cursor: string | null = null

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await server.request(
        'model/list',
        cursor ? { cursor } : {},
        LIST_TIMEOUT_MS
      )
      for (const model of (result.data as CatalogueModel[] | undefined) ?? []) {
        const efforts = readEfforts(model.supportedReasoningEfforts)
        if (typeof model.id === 'string' && efforts.length > 0) {
          catalogue.set(model.id, efforts)
        }
      }
      const next = result.nextCursor
      if (typeof next !== 'string' || next.length === 0) break
      cursor = next
    }

    return catalogue
  } finally {
    server.endStdin()
  }
}

/**
 * What is known right now, or null before the catalogue has ever been read.
 * Never blocks; a stale or absent entry only schedules the refresh.
 */
export function cachedEffortCatalogue(binary: string | null, env: NodeJS.ProcessEnv) {
  const fresh = cached !== null && Date.now() - cached.at < CACHE_TTL_MS
  if (!fresh && binary) scheduleRefresh(binary, env)
  return cached?.catalogue ?? null
}

function scheduleRefresh(binary: string, env: NodeJS.ProcessEnv): void {
  if (inFlight) return
  if (Date.now() - lastFailureAt < RETRY_AFTER_FAILURE_MS) return

  inFlight = fetchCatalogue(binary, env)
    .then((catalogue) => {
      // An empty answer is not an answer; keeping the old one beats caching a
      // blank for six hours.
      if (catalogue.size > 0) cached = { at: Date.now(), catalogue }
      else lastFailureAt = Date.now()
    })
    .catch((error) => {
      lastFailureAt = Date.now()
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`Warning: could not read the codex model catalogue: ${message}`)
    })
    .finally(() => {
      inFlight = null
    })
}
