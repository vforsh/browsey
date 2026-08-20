import {
  INITIALIZE_TIMEOUT_MS,
  openAppServer,
  type CodexAppServer,
} from './codex-app-server.js'
import {
  MAX_TITLE_CHARS,
  generationPrompt,
  promptTitle,
  sanitizeGeneratedTitle,
} from './thread-title.js'

/**
 * Codex itself never titles a thread. `Thread.name` stays null unless a client
 * sets it, and every UI that looks empty is really showing `Thread.preview` —
 * the raw first user message. Desktop and the iOS app fill the name in
 * themselves, with a small model, over the same app-server protocol we use; this
 * is that behaviour, so threads launched from the phone read the same way.
 *
 * Two phases, as Desktop does it:
 *  1. a truncated slice of the prompt, written immediately, so the thread is
 *     never unlabeled and there is a known value to compare against later;
 *  2. a generated title that replaces phase one only if it is still there —
 *     anything else means the thread was renamed in the meantime and the
 *     generated title is already stale.
 *
 * None of it is allowed to affect the launch: a failure here leaves the thread
 * exactly as it would have been before any of this existed.
 */

/** Small, fast, and cheap. Independent of the model the thread itself runs. */
const TITLE_MODEL = 'gpt-5.6-luna'
const TITLE_EFFORT = 'high'

const REQUEST_TIMEOUT_MS = 30_000
const GENERATION_TIMEOUT_MS = 60_000

/**
 * A thread's name lives in the rollout on disk, which Codex only writes once the
 * first turn is under way — so the first rename attempts race the launch and are
 * expected to fail.
 */
const ROLLOUT_WAIT_ATTEMPTS = 10
const ROLLOUT_WAIT_MS = 500
const ROLLOUT_MISSING = 'no rollout found'

const TITLE_SCHEMA = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: `A ${MAX_TITLE_CHARS}-character-or-shorter title for the thread.`,
    },
  },
  required: ['title'],
  additionalProperties: false,
}

async function setName(server: CodexAppServer, threadId: string, name: string): Promise<void> {
  await server.request('thread/name/set', { threadId, name }, REQUEST_TIMEOUT_MS)
}

async function readName(server: CodexAppServer, threadId: string): Promise<string | null> {
  const result = await server.request('thread/read', { threadId }, REQUEST_TIMEOUT_MS)
  const thread = result.thread as { name?: unknown } | undefined
  return typeof thread?.name === 'string' ? thread.name : null
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref?.()
  })

/** Retries only the one failure that time fixes; anything else is a real error. */
async function setNameOnceWritable(
  server: CodexAppServer,
  threadId: string,
  name: string
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await setName(server, threadId, name)
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (attempt >= ROLLOUT_WAIT_ATTEMPTS - 1 || !message.includes(ROLLOUT_MISSING)) {
        throw error
      }
      await delay(ROLLOUT_WAIT_MS)
    }
  }
}

/**
 * Runs the naming turn on a throwaway thread. Ephemeral keeps it off disk and
 * out of every thread list, and read-only means a title can never cost a write.
 */
async function generateTitle(server: CodexAppServer, prompt: string): Promise<string | null> {
  const started = await server.request(
    'thread/start',
    { ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never' },
    REQUEST_TIMEOUT_MS
  )
  const thread = started.thread as { id?: unknown } | undefined
  if (typeof thread?.id !== 'string') return null

  // The turn's answer arrives as a notification, so it is collected rather than
  // returned: the last agent message is the schema-shaped one.
  const captured: { answer: string | null } = { answer: null }
  server.onNotification('item/completed', (params) => {
    const item = (params as { item?: { type?: unknown; text?: unknown } } | undefined)?.item
    if (item?.type === 'agentMessage' && typeof item.text === 'string') captured.answer = item.text
  })

  const completed = new Promise<void>((resolve) => {
    server.onNotification('turn/completed', () => resolve())
    delay(GENERATION_TIMEOUT_MS).then(resolve)
  })

  await server.request(
    'turn/start',
    {
      threadId: thread.id,
      input: [{ type: 'text', text: generationPrompt(prompt) }],
      model: TITLE_MODEL,
      effort: TITLE_EFFORT,
      sandboxPolicy: { type: 'readOnly' },
      outputSchema: TITLE_SCHEMA,
    },
    REQUEST_TIMEOUT_MS
  )
  await completed

  if (captured.answer === null) return null
  try {
    return sanitizeGeneratedTitle((JSON.parse(captured.answer) as { title?: unknown }).title)
  } catch {
    // Without the schema honoured there is nothing to salvage; the fallback stands.
    return null
  }
}

/**
 * Titles a thread that has just been launched.
 *
 * Deliberately its own app server rather than the launch's: that one closes
 * stdin on the first `turn/completed` it sees, so a naming turn sharing the
 * connection would cut the real thread off before it had answered.
 *
 * Takes several seconds, so callers should not await it before responding.
 */
export async function nameCodexThread({
  binary,
  cwd,
  threadId,
  prompt,
  env,
}: {
  binary: string
  cwd: string
  threadId: string
  prompt: string
  env: NodeJS.ProcessEnv
}): Promise<void> {
  const fallback = promptTitle(prompt)
  if (!fallback) return

  // No log fd: the run log's tail is read back as the reason a launch failed, and
  // a second stream of protocol chatter in it would make that reason a lie.
  const server = await openAppServer({ binary, cwd, logFd: null, env, detached: false })

  // Never cleared: closing stdin is the polite exit, and this is what happens when
  // the child ignores it. Killing an already-exited child is a no-op.
  const watchdog = setTimeout(
    () => server.child.kill('SIGKILL'),
    INITIALIZE_TIMEOUT_MS + GENERATION_TIMEOUT_MS
  )
  watchdog.unref?.()

  try {
    await setNameOnceWritable(server, threadId, fallback)

    const generated = await generateTitle(server, prompt)
    if (!generated || generated === fallback) return

    // A rename by hand between the two phases wins: it is a deliberate choice and
    // the generated title is an old guess about a thread that has moved on.
    if ((await readName(server, threadId)) !== fallback) return
    await setName(server, threadId, generated)
  } finally {
    server.endStdin()
  }
}
