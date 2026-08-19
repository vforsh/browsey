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

/** Names this client in the transcript's `originator`, so runs are attributable. */
const CLIENT_NAME = 'browsey'

type JsonRpcMessage = {
  id?: number
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
          pending.push(JSON.parse(line) as JsonRpcMessage)
        } catch {
          // Non-JSON diagnostics land in the log and are otherwise ignored.
        }
      }
      newline = buffer.indexOf('\n')
    }
    waiter?.()
  })

  return async function awaitResponse(id: number, timeoutMs: number): Promise<JsonRpcMessage> {
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

  const awaitResponse = createReader(child.stdout, logFd)
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

  return { threadId, child }
}
