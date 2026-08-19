import { spawn } from 'child_process'
import { writeSync } from 'fs'

/**
 * Codex threads are created over the app-server protocol rather than with
 * `codex exec`, because the Desktop app only lists threads whose recorded
 * source is an app-server client — an `exec` run is filed as automation and
 * stays invisible there no matter what else is set.
 *
 * Same shape as the rest of our spawning: one child process, argv only, no
 * shell. The difference is that the request goes in over stdin as
 * newline-delimited JSON-RPC instead of as flags.
 */

const INITIALIZE_TIMEOUT_MS = 15_000
const THREAD_TIMEOUT_MS = 30_000

/** Stop-loss for a `turn/completed` that never arrives; see endOnTurnCompletion. */
const TURN_ABANDON_MS = 30 * 60_000

/**
 * Names this client in the transcript's `originator`, which is the field that
 * actually identifies the tool. The sibling `source` field is not ours to pick —
 * it labels the transport, and Codex calls every app-server client `vscode` for
 * historical reasons (the VS Code extension was the first one). Codex Desktop
 * and the official iOS client carry the same `vscode` value.
 */
const CLIENT_NAME = 'browsey'

type JsonRpcMessage = {
  id?: number
  method?: string
  params?: unknown
  result?: unknown
  error?: { message?: string }
}

export type NotificationHandler = (params: unknown) => void

export type StartedCodexThread = {
  threadId: string
  /** Resolves when the child exits; used to record why a run died. */
  child: ReturnType<typeof spawn>
}

export class CodexAppServerError extends Error {}

/**
 * Reads newline-delimited JSON from the child and hands whole messages to
 * whoever is waiting. Draining continues after the handshake: an unread stdout
 * pipe would eventually fill and stall the run.
 */
function createReader(
  stdout: NonNullable<ReturnType<typeof spawn>['stdout']>,
  logFd: number | null
) {
  /** Responses that arrived before anyone awaited them. */
  const unclaimed = new Map<number, JsonRpcMessage>()
  const waiting = new Map<number, (message: JsonRpcMessage) => void>()
  const notificationHandlers = new Map<string, NotificationHandler>()
  let buffer = ''

  const deliver = (message: JsonRpcMessage) => {
    // Notifications are dispatched and dropped, so a long run cannot accumulate
    // them; responses wait to be claimed by id.
    if (message.id === undefined) {
      if (message.method) notificationHandlers.get(message.method)?.(message.params)
      return
    }
    const waiter = waiting.get(message.id)
    if (waiter) {
      waiting.delete(message.id)
      waiter(message)
    } else {
      unclaimed.set(message.id, message)
    }
  }

  stdout.on('data', (chunk: Buffer) => {
    try {
      if (logFd !== null) writeSync(logFd, chunk)
    } catch {
      // The log is a debugging aid; losing it must not kill the run.
    }

    buffer += chunk.toString('utf-8')
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        deliver(JSON.parse(line) as JsonRpcMessage)
      } catch {
        // Non-JSON diagnostics land in the log and are otherwise ignored.
      }
    }
  })

  return {
    awaitResponse(id: number, timeoutMs: number): Promise<JsonRpcMessage> {
      const already = unclaimed.get(id)
      if (already) {
        unclaimed.delete(id)
        return Promise.resolve(already)
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(id)
          reject(new CodexAppServerError(`codex app-server did not answer request ${id} in time`))
        }, timeoutMs)
        waiting.set(id, (message) => {
          clearTimeout(timer)
          resolve(message)
        })
      })
    },
    onNotification(method: string, handler: NotificationHandler) {
      notificationHandlers.set(method, handler)
    },
  }
}

function resultOf(message: JsonRpcMessage, what: string): Record<string, unknown> {
  if (message.error) {
    throw new CodexAppServerError(message.error.message || `codex rejected ${what}`)
  }
  if (!message.result || typeof message.result !== 'object') {
    throw new CodexAppServerError(`codex returned no result for ${what}`)
  }
  return message.result as Record<string, unknown>
}

export type CodexAppServer = {
  child: ReturnType<typeof spawn>
  request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number
  ): Promise<Record<string, unknown>>
  onNotification(method: string, handler: NotificationHandler): void
  /** Lets the server shut itself down cleanly once its work is done. */
  endStdin(): void
}

/**
 * Spawns an app server and gets it through the handshake, so callers only deal
 * in requests. `logFd` doubles as the child's stderr; pass null to discard both
 * it and the stdout mirror — a run log that matters is one nobody else writes to.
 */
export async function openAppServer({
  binary,
  cwd,
  logFd,
  env,
  detached,
}: {
  binary: string
  cwd: string
  logFd: number | null
  env: NodeJS.ProcessEnv
  detached: boolean
}): Promise<CodexAppServer> {
  const child = spawn(binary, ['app-server'], {
    cwd,
    detached,
    stdio: ['pipe', 'pipe', logFd ?? 'ignore'],
    env,
  })

  if (!child.stdin || !child.stdout) {
    throw new CodexAppServerError('codex app-server gave no stdio pipes')
  }

  const stdin = child.stdin
  const { awaitResponse, onNotification } = createReader(child.stdout, logFd)

  let nextId = 0
  const send = (message: Record<string, unknown>) => {
    stdin.write(`${JSON.stringify(message)}\n`)
  }
  const request = async (
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number
  ): Promise<Record<string, unknown>> => {
    const id = ++nextId
    send({ jsonrpc: '2.0', id, method, params })
    return resultOf(await awaitResponse(id, timeoutMs), method)
  }

  await request(
    'initialize',
    { clientInfo: { name: CLIENT_NAME, title: 'Browsey', version: '1' } },
    INITIALIZE_TIMEOUT_MS
  )
  send({ jsonrpc: '2.0', method: 'initialized', params: {} })

  return {
    child,
    request,
    onNotification,
    endStdin() {
      try {
        stdin.end()
      } catch {
        // Already gone; the caller's exit handling still runs.
      }
    },
  }
}

/**
 * Ends the app server once the turn is done. Killing it early truncates the
 * thread — it keeps the user's message and loses the answer — and never closing
 * it leaks one process per launch, so both the notification and a stop-loss
 * timer lead to the same clean stdin close.
 */
function endOnTurnCompletion(server: CodexAppServer) {
  const { child, onNotification } = server
  let closed = false
  const closeStdin = () => {
    if (closed) return
    closed = true
    server.endStdin()
  }

  const stopLoss = setTimeout(closeStdin, TURN_ABANDON_MS)
  stopLoss.unref?.()
  onNotification('turn/completed', () => {
    clearTimeout(stopLoss)
    closeStdin()
  })
  child.once('exit', () => clearTimeout(stopLoss))
}

export async function startCodexThread({
  binary,
  cwd,
  prompt,
  model,
  logFd,
  env,
}: {
  binary: string
  cwd: string
  prompt: string
  /** Empty string leaves the model to the CLI's own configuration. */
  model: string
  logFd: number
  env: NodeJS.ProcessEnv
}): Promise<StartedCodexThread> {
  const server = await openAppServer({ binary, cwd, logFd, env, detached: true })
  const { child, request } = server

  const started = await request(
    'thread/start',
    {
      cwd,
      // Mirrors `--dangerously-bypass-approvals-and-sandbox`: threads launched
      // from the phone get the same full access the CLI path gave them.
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
      // These are person-initiated threads, not subagent spawns — same value the
      // Desktop and iOS clients record for a thread someone started by hand.
      threadSource: 'user',
      ...(model ? { model } : {}),
    },
    THREAD_TIMEOUT_MS
  )

  const thread = started.thread as { id?: unknown } | undefined
  const threadId = typeof thread?.id === 'string' ? thread.id : null
  if (!threadId) {
    throw new CodexAppServerError('codex started a thread without an id')
  }

  await request('turn/start', { threadId, input: [{ type: 'text', text: prompt }] }, THREAD_TIMEOUT_MS)

  endOnTurnCompletion(server)

  return { threadId, child }
}
