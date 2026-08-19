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

/**
 * The turn has to be seen through to a clean shutdown. Killing the app server
 * early truncates the thread — it keeps the user's message and loses the answer —
 * and never closing it leaks one process per launch. So the run ends on
 * `turn/completed` by closing stdin, with a long stop-loss in case that
 * notification never arrives.
 */
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
  result?: unknown
  error?: { message?: string }
}

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
  logFd: number
) {
  const pending: JsonRpcMessage[] = []
  const notificationHandlers = new Map<string, () => void>()
  let waiter: (() => void) | null = null
  let buffer = ''

  stdout.on('data', (chunk: Buffer) => {
    try {
      writeSync(logFd, chunk)
    } catch {
      // The log is a debugging aid; losing it must not kill the run.
    }
    buffer += chunk.toString('utf-8')
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) {
        try {
          const message = JSON.parse(line) as JsonRpcMessage
          // Responses are awaited by id; notifications are dispatched and
          // dropped, so a long run cannot accumulate them.
          if (message.id !== undefined) pending.push(message)
          else if (message.method) notificationHandlers.get(message.method)?.()
        } catch {
          // Non-JSON diagnostics land in the log and are otherwise ignored.
        }
      }
      newline = buffer.indexOf('\n')
    }
    waiter?.()
  })

  async function awaitResponse(id: number, timeoutMs: number): Promise<JsonRpcMessage> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const index = pending.findIndex((message) => message.id === id)
      if (index !== -1) return pending.splice(index, 1)[0]!

      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        throw new CodexAppServerError(`codex app-server did not answer request ${id} in time`)
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining)
        waiter = () => {
          clearTimeout(timer)
          waiter = null
          resolve()
        }
      })
    }
  }

  return {
    awaitResponse,
    onNotification(method: string, handler: () => void) {
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
  const child = spawn(binary, ['app-server'], {
    cwd,
    detached: true,
    stdio: ['pipe', 'pipe', logFd],
    env,
  })

  if (!child.stdin || !child.stdout) {
    throw new CodexAppServerError('codex app-server gave no stdio pipes')
  }

  const { awaitResponse, onNotification } = createReader(child.stdout, logFd)
  const send = (message: Record<string, unknown>) => {
    child.stdin!.write(`${JSON.stringify(message)}\n`)
  }

  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { clientInfo: { name: CLIENT_NAME, title: 'Browsey', version: '1' } },
  })
  resultOf(await awaitResponse(1, INITIALIZE_TIMEOUT_MS), 'initialize')
  send({ jsonrpc: '2.0', method: 'initialized', params: {} })

  // Mirrors `--dangerously-bypass-approvals-and-sandbox`: threads launched from
  // the phone get the same full access the CLI path gave them.
  send({
    jsonrpc: '2.0',
    id: 2,
    method: 'thread/start',
    params: {
      cwd,
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
      // These are person-initiated threads, not subagent spawns — same value the
      // Desktop and iOS clients record for a thread someone started by hand.
      threadSource: 'user',
      ...(model ? { model } : {}),
    },
  })
  const started = resultOf(await awaitResponse(2, THREAD_TIMEOUT_MS), 'thread/start')
  const thread = started.thread as { id?: unknown } | undefined
  const threadId = typeof thread?.id === 'string' ? thread.id : null
  if (!threadId) {
    throw new CodexAppServerError('codex started a thread without an id')
  }

  send({
    jsonrpc: '2.0',
    id: 3,
    method: 'turn/start',
    params: { threadId, input: [{ type: 'text', text: prompt }] },
  })
  resultOf(await awaitResponse(3, THREAD_TIMEOUT_MS), 'turn/start')

  // The reply goes back to the phone now; the shutdown is seen through here.
  let closed = false
  const closeStdin = () => {
    if (closed) return
    closed = true
    try {
      child.stdin?.end()
    } catch {
      // Already gone; the exit handler still runs.
    }
  }
  const abandon = setTimeout(closeStdin, TURN_ABANDON_MS)
  abandon.unref?.()
  onNotification('turn/completed', () => {
    clearTimeout(abandon)
    closeStdin()
  })
  child.once('exit', () => clearTimeout(abandon))

  return { threadId, child }
}
