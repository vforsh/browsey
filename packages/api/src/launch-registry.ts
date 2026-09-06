import type { AgentLaunchEvent, AgentLaunchEventBody } from '@vforsh/browsey-shared'

/**
 * Recent agent launches, kept in memory so a client that lost its stream can
 * ask again for what it missed.
 *
 * The launch stream is narration for work that is already running: the terminal
 * `launched` event is the only place a `sessionId` and a deep link ever appear,
 * and a dropped connection used to throw it away — the agent kept going and the
 * phone never learned where it went. Over a tunnel on a cell link that is not a
 * rare case, so every event is buffered here under an id the client minted
 * before it sent the launch.
 *
 * Losing all of this on restart is fine, exactly as it is for `lastFailures`:
 * it describes what happened in the last few minutes, not what exists.
 */

/** Launches tracked at once. Oldest is evicted first past this. */
export const MAX_TRACKED_LAUNCHES = 32

/** How long a finished launch stays replayable after its terminal event. */
export const FINISHED_LAUNCH_TTL_MS = 10 * 60 * 1000

/**
 * A launch id is opaque to the server — the client mints it (a UUID, in
 * practice) and the server only ever compares it. Restricting it to this
 * alphabet keeps it safe to log and to put in a query string.
 */
const LAUNCH_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

export type LaunchEventListener = (event: AgentLaunchEvent) => void

export type LaunchEntry = {
  readonly id: string
  /** Every stamped event so far, in `seq` order: the replay buffer. */
  readonly events: AgentLaunchEvent[]
  /** A terminal event has been recorded; nothing more will ever be appended. */
  done: boolean
  /** When `done` flipped, which is what the TTL is measured from. */
  finishedAt?: number
  readonly startedAt: number
  /** Streams currently following this launch live. */
  readonly listeners: Set<LaunchEventListener>
  nextSeq: number
}

const launches = new Map<string, LaunchEntry>()

export function isValidLaunchId(value: string): boolean {
  return LAUNCH_ID_PATTERN.test(value)
}

export function isTerminalLaunchEvent(event: AgentLaunchEventBody): boolean {
  return event.event === 'launched' || event.event === 'failed'
}

/**
 * Registers `id`, or hands back the entry already under it.
 *
 * `created: false` is the whole reattach story on the POST side: an id the
 * server has seen means the agent is already running (or already done), and
 * launching a second one would be the worst possible answer to a retry.
 */
export function registerLaunch(id: string, now = Date.now()): { entry: LaunchEntry; created: boolean } {
  sweepLaunches(now)

  const existing = launches.get(id)
  if (existing) return { entry: existing, created: false }

  const entry: LaunchEntry = {
    id,
    events: [],
    done: false,
    startedAt: now,
    listeners: new Set(),
    nextSeq: 1,
  }
  launches.set(id, entry)
  evictOverflow()
  return { entry, created: true }
}

export function getLaunch(id: string, now = Date.now()): LaunchEntry | null {
  sweepLaunches(now)
  return launches.get(id) ?? null
}

/**
 * Stamps the event with the launch's next `seq`, buffers it, and hands it to
 * every live follower. The returned object is the one that was stored, so a
 * replay of it serializes byte for byte the same as the original line.
 */
export function appendLaunchEvent(
  entry: LaunchEntry,
  body: AgentLaunchEventBody,
  now = Date.now()
): AgentLaunchEvent {
  const event = { ...body, seq: entry.nextSeq++ } as AgentLaunchEvent
  entry.events.push(event)
  // Marked done before anyone is told, so a follower reacting to the terminal
  // event sees a finished entry rather than one about to finish.
  if (isTerminalLaunchEvent(event)) finishLaunch(entry, now)
  for (const listener of [...entry.listeners]) listener(event)
  return event
}

export function finishLaunch(entry: LaunchEntry, now = Date.now()): void {
  if (entry.done) return
  entry.done = true
  entry.finishedAt = now
}

/** Buffered events a reattaching client has not seen. `since = 0` is all of them. */
export function eventsSince(entry: LaunchEntry, since: number): AgentLaunchEvent[] {
  return entry.events.filter((event) => event.seq > since)
}

export function subscribeToLaunch(entry: LaunchEntry, listener: LaunchEventListener): () => void {
  entry.listeners.add(listener)
  return () => {
    entry.listeners.delete(listener)
  }
}

/**
 * Drops launches that finished long enough ago to be of no use to anybody.
 * Swept lazily on every lookup rather than on a timer — the registry is only
 * ever interesting while somebody is asking about it.
 */
export function sweepLaunches(now = Date.now()): void {
  for (const [id, entry] of launches) {
    if (entry.done && now - (entry.finishedAt ?? entry.startedAt) >= FINISHED_LAUNCH_TTL_MS) {
      launches.delete(id)
    }
  }
}

/**
 * A launch whose stream never terminates (a spawn that hangs forever) has no
 * TTL to expire under, so the count is the backstop. Insertion order is age
 * order, which makes the oldest the first key.
 */
function evictOverflow(): void {
  while (launches.size > MAX_TRACKED_LAUNCHES) {
    const oldest = launches.keys().next()
    if (oldest.done) return
    launches.delete(oldest.value)
  }
}

export function trackedLaunchCount(): number {
  return launches.size
}

/** Test hook: the registry is module state, and a test should not inherit it. */
export function resetLaunchRegistry(): void {
  launches.clear()
}
