import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import { tmpdir } from 'os'
import { handleApiRequest } from './routes.js'
import {
  FINISHED_LAUNCH_TTL_MS,
  MAX_TRACKED_LAUNCHES,
  appendLaunchEvent,
  eventsSince,
  getLaunch,
  isValidLaunchId,
  registerLaunch,
  resetLaunchRegistry,
  trackedLaunchCount,
} from './launch-registry.js'
import type { AgentLaunchResponse, ApiRoutesOptions } from '@vforsh/browsey-shared'

const AGENT_TOKEN = 'launch-resume-test-token'

const options: ApiRoutesOptions = {
  root: tmpdir(),
  readonly: false,
  showHidden: false,
  ignorePatterns: [],
  agents: { enabled: true, token: AGENT_TOKEN },
}

const RESULT: AgentLaunchResponse = {
  launched: true,
  agent: 'claude-code',
  cwd: '/work',
  reusedProject: false,
  sessionId: 'session-1',
  url: 'claudecode://session/session-1',
}

function authorized(url: string, init?: RequestInit): Request {
  return new Request(`http://localhost${url}`, {
    ...init,
    headers: { Authorization: `Bearer ${AGENT_TOKEN}`, ...(init?.headers ?? {}) },
  })
}

function launchRequest(body: unknown): Request {
  return authorized('/api/agents/launch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Only safe on a stream that is going to close: a live one never ends. */
async function readAll(response: Response): Promise<unknown[]> {
  const text = await response.text()
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown)
}

beforeEach(() => {
  resetLaunchRegistry()
})

afterEach(() => {
  resetLaunchRegistry()
})

describe('launch registry', () => {
  test('accepts an opaque id and refuses anything that is not one', () => {
    expect(isValidLaunchId('0f8b6a2c-4d1e-4a7b-9c3d-2f5e6a7b8c9d')).toBe(true)
    expect(isValidLaunchId('a')).toBe(true)
    expect(isValidLaunchId('a'.repeat(128))).toBe(true)
    expect(isValidLaunchId('')).toBe(false)
    expect(isValidLaunchId('a'.repeat(129))).toBe(false)
    expect(isValidLaunchId('has space')).toBe(false)
    expect(isValidLaunchId('../etc/passwd')).toBe(false)
    expect(isValidLaunchId('id\n')).toBe(false)
  })

  test('numbers events monotonically from 1', () => {
    const { entry } = registerLaunch('seq-1')

    expect(appendLaunchEvent(entry, { event: 'phase', phase: 'naming' }).seq).toBe(1)
    expect(appendLaunchEvent(entry, { event: 'phase', phase: 'starting' }).seq).toBe(2)
    expect(appendLaunchEvent(entry, { event: 'launched', result: RESULT }).seq).toBe(3)
    expect(entry.events.map((event) => event.seq)).toEqual([1, 2, 3])
  })

  test('a terminal event finishes the entry', () => {
    const { entry } = registerLaunch('done-1', 1_000)
    appendLaunchEvent(entry, { event: 'phase', phase: 'starting' }, 1_100)
    expect(entry.done).toBe(false)

    appendLaunchEvent(entry, { event: 'failed', error: 'nope', status: 500 }, 1_200)
    expect(entry.done).toBe(true)
    expect(entry.finishedAt).toBe(1_200)
  })

  test('a second registration of the same id hands back the same entry', () => {
    const first = registerLaunch('same-1')
    appendLaunchEvent(first.entry, { event: 'phase', phase: 'naming' })

    const second = registerLaunch('same-1')
    expect(second.created).toBe(false)
    expect(second.entry).toBe(first.entry)
    expect(trackedLaunchCount()).toBe(1)
  })

  test('evicts the oldest launch past the bound', () => {
    for (let index = 0; index <= MAX_TRACKED_LAUNCHES; index++) {
      registerLaunch(`overflow-${index}`)
    }

    expect(trackedLaunchCount()).toBe(MAX_TRACKED_LAUNCHES)
    expect(getLaunch('overflow-0')).toBeNull()
    expect(getLaunch('overflow-1')).not.toBeNull()
    expect(getLaunch(`overflow-${MAX_TRACKED_LAUNCHES}`)).not.toBeNull()
  })

  test('drops a finished launch once its TTL is up, and never an unfinished one', () => {
    const start = 10_000
    const { entry } = registerLaunch('ttl-1', start)
    appendLaunchEvent(entry, { event: 'launched', result: RESULT }, start)
    registerLaunch('ttl-live', start)

    expect(getLaunch('ttl-1', start + FINISHED_LAUNCH_TTL_MS - 1)).not.toBeNull()
    expect(getLaunch('ttl-1', start + FINISHED_LAUNCH_TTL_MS)).toBeNull()
    expect(getLaunch('ttl-live', start + FINISHED_LAUNCH_TTL_MS * 5)).not.toBeNull()
  })

  test('eventsSince returns the tail after a seq, and everything for 0', () => {
    const { entry } = registerLaunch('tail-1')
    appendLaunchEvent(entry, { event: 'phase', phase: 'naming' })
    appendLaunchEvent(entry, { event: 'phase', phase: 'starting' })
    appendLaunchEvent(entry, { event: 'launched', result: RESULT })

    expect(eventsSince(entry, 0).map((event) => event.seq)).toEqual([1, 2, 3])
    expect(eventsSince(entry, 2).map((event) => event.seq)).toEqual([3])
    expect(eventsSince(entry, 3)).toEqual([])
  })
})

describe('GET /api/agents/launch/events', () => {
  test('404s an id the server has never seen', async () => {
    const response = await handleApiRequest(
      authorized('/api/agents/launch/events?id=missing-1&since=0'),
      options
    )

    expect(response?.status).toBe(404)
    expect(await response?.json()).toEqual({ error: 'Unknown launch' })
  })

  test('404s an id that is not a legal launch id', async () => {
    const response = await handleApiRequest(
      authorized('/api/agents/launch/events?id=../secrets&since=0'),
      options
    )

    expect(response?.status).toBe(404)
  })

  test('replays a finished launch in full and closes', async () => {
    const { entry } = registerLaunch('replay-1')
    appendLaunchEvent(entry, { event: 'phase', phase: 'naming' })
    appendLaunchEvent(entry, { event: 'phase', phase: 'starting' })
    appendLaunchEvent(entry, { event: 'launched', result: RESULT })

    const response = await handleApiRequest(
      authorized('/api/agents/launch/events?id=replay-1&since=0'),
      options
    )

    expect(response?.status).toBe(200)
    expect(response?.headers.get('Content-Type')).toBe('application/x-ndjson')
    expect(await readAll(response!)).toEqual([
      { event: 'phase', phase: 'naming', seq: 1 },
      { event: 'phase', phase: 'starting', seq: 2 },
      { event: 'launched', result: RESULT, seq: 3 },
    ])
  })

  test('sends exactly what a client missed, with no duplicates', async () => {
    const { entry } = registerLaunch('replay-2')
    appendLaunchEvent(entry, { event: 'phase', phase: 'naming' })
    appendLaunchEvent(entry, { event: 'phase', phase: 'starting' })
    appendLaunchEvent(entry, { event: 'phase', phase: 'linking' })
    appendLaunchEvent(entry, { event: 'launched', result: RESULT })

    const response = await handleApiRequest(
      authorized('/api/agents/launch/events?id=replay-2&since=2'),
      options
    )

    expect(await readAll(response!)).toEqual([
      { event: 'phase', phase: 'linking', seq: 3 },
      { event: 'launched', result: RESULT, seq: 4 },
    ])
  })

  test('replays, then follows live, then closes on the terminal event', async () => {
    const { entry } = registerLaunch('live-1')
    appendLaunchEvent(entry, { event: 'phase', phase: 'naming' })

    const response = await handleApiRequest(
      authorized('/api/agents/launch/events?id=live-1&since=0'),
      options
    )
    const reader = response!.body!.getReader()
    const decoder = new TextDecoder()
    const nextLine = async () => decoder.decode((await reader.read()).value)

    // Byte-for-byte the line the original stream wrote, since both go through
    // the same encoder over the same stored object.
    expect(await nextLine()).toBe('{"event":"phase","phase":"naming","seq":1}\n')

    appendLaunchEvent(entry, { event: 'phase', phase: 'starting' })
    expect(await nextLine()).toBe('{"event":"phase","phase":"starting","seq":2}\n')

    appendLaunchEvent(entry, { event: 'launched', result: RESULT })
    expect(JSON.parse(await nextLine())).toEqual({ event: 'launched', result: RESULT, seq: 3 })

    expect((await reader.read()).done).toBe(true)
  })

  test('heartbeats go on the wire but never into the registry', async () => {
    jest.useFakeTimers()
    try {
      const { entry } = registerLaunch('heartbeat-1')

      const response = await handleApiRequest(
        authorized('/api/agents/launch/events?id=heartbeat-1&since=0'),
        options
      )
      const reader = response!.body!.getReader()

      jest.advanceTimersByTime(15_000)
      const line = new TextDecoder().decode((await reader.read()).value)

      expect(line).toBe('{"event":"heartbeat"}\n')
      expect(entry.events).toEqual([])
      expect(entry.nextSeq).toBe(1)

      await reader.cancel()
    } finally {
      jest.useRealTimers()
    }
  })
})

describe('POST /api/agents/launch with a launchId', () => {
  test('refuses an id that is not opaque and safe', async () => {
    const response = await handleApiRequest(
      launchRequest({ launchId: 'not a launch id', agent: 'claude-code', target: { kind: 'directory', path: '/' } }),
      options
    )

    expect(response?.status).toBe(400)
    expect(await response?.json()).toEqual({
      error: 'launchId must be 1-128 characters of [A-Za-z0-9_-]',
    })
    expect(trackedLaunchCount()).toBe(0)
  })

  test('reattaches instead of launching a second agent for a known id', async () => {
    const { entry } = registerLaunch('known-1')
    appendLaunchEvent(entry, { event: 'phase', phase: 'starting' })
    appendLaunchEvent(entry, { event: 'launched', result: RESULT })

    // A body that would be refused outright if it ever reached validation, so a
    // 200 stream of the buffered events is proof the launch path was skipped.
    const response = await handleApiRequest(
      launchRequest({ launchId: 'known-1', agent: 'not-an-agent', target: { kind: 'directory', path: '/' } }),
      options
    )

    expect(response?.status).toBe(200)
    expect(response?.headers.get('Content-Type')).toBe('application/x-ndjson')
    expect(await readAll(response!)).toEqual([
      { event: 'phase', phase: 'starting', seq: 1 },
      { event: 'launched', result: RESULT, seq: 2 },
    ])
    expect(trackedLaunchCount()).toBe(1)
    expect(entry.events).toHaveLength(2)
  })

  test('registers before validating, and records the refusal so a reattach ends', async () => {
    const response = await handleApiRequest(
      launchRequest({ launchId: 'rejected-1', agent: 'not-an-agent', target: { kind: 'directory', path: '/' } }),
      options
    )

    expect(response?.status).toBe(400)
    expect(await response?.json()).toEqual({ error: 'Unknown agent' })

    const entry = getLaunch('rejected-1')
    expect(entry?.done).toBe(true)
    expect(entry?.events).toEqual([{ event: 'failed', error: 'Unknown agent', status: 400, seq: 1 }])

    const reattached = await handleApiRequest(
      authorized('/api/agents/launch/events?id=rejected-1&since=0'),
      options
    )
    expect(await readAll(reattached!)).toEqual([
      { event: 'failed', error: 'Unknown agent', status: 400, seq: 1 },
    ])
  })

  test('leaves nothing behind when the client mints no id', async () => {
    const response = await handleApiRequest(
      launchRequest({ agent: 'not-an-agent', target: { kind: 'directory', path: '/' } }),
      options
    )

    expect(response?.status).toBe(400)
    expect(trackedLaunchCount()).toBe(0)
  })
})
