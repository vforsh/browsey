import { spawn } from 'child_process'
import { accessSync, constants, readFileSync, readdirSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import type { AgentLaunchPhase } from '@vforsh/browsey-shared'

/**
 * Claude threads are opened as live Remote Control sessions instead of headless
 * `-p` runs, because the Code section of the Claude phone app lists live
 * sessions and nothing else — a `-p` transcript never appears there.
 *
 * Remote Control needs a controlling terminal, which `script(1)` provides
 * without pulling in a native pty module. Spawning rules are unchanged: argv
 * only, never a shell.
 *
 * `--permission-mode` is passed explicitly because without it the first run
 * stops on the "Make auto mode your default permission mode?" prompt, and a
 * session that is waiting on that prompt never registers.
 */

/** BSD script, which takes the command as argv after the typescript file. */
const SCRIPT_BIN = '/usr/bin/script'

/**
 * Claude writes one file per live session here, keyed by pid, the moment the
 * session starts — well before the transcript under `~/.claude/projects`
 * exists. It is the only place `bridgeSessionId` can be read at launch time.
 */
const SESSIONS_DIR = join(homedir(), '.claude', 'sessions')

/** Registration lands about a second after spawn; the rest is slack. */
const REGISTER_TIMEOUT_MS = 15_000

/**
 * The state file is written before Remote Control finishes registering, so the
 * link shows up a beat after the session does. Waiting for it is what lets a
 * launch answer with a link instead of making the client poll for one.
 */
const BRIDGE_TIMEOUT_MS = 8_000
const POLL_INTERVAL_MS = 150

export class ClaudeRemoteControlError extends Error {}

export type ClaudeSession = {
  sessionId: string
  /** The `claude` process itself, not the `script` wrapper. */
  pid: number
  cwd: string
  status: string | null
  startedAt: number | null
  /** Opens this exact session in the phone app; null until Remote Control registers. */
  url: string | null
}

type SessionFile = Partial<{
  pid: number
  sessionId: string
  cwd: string
  status: string
  startedAt: number
  bridgeSessionId: string
}>

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Signal 0 only asks whether the pid exists. `EPERM` means it does and belongs
 * to somebody else, which still counts as alive.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * The phone app resolves this to the session behind `bridgeSessionId`. Verified
 * against a session with no messages in it, which is what a fresh launch is.
 */
function sessionUrl(bridgeSessionId: string | undefined): string | null {
  return bridgeSessionId ? `https://claude.ai/code/${bridgeSessionId}` : null
}

function readSessionFile(name: string): ClaudeSession | null {
  let parsed: SessionFile
  try {
    parsed = JSON.parse(readFileSync(join(SESSIONS_DIR, name), 'utf-8')) as SessionFile
  } catch {
    // A half-written or stale file is simply not a session.
    return null
  }

  const { pid, sessionId, cwd } = parsed
  if (typeof pid !== 'number' || typeof sessionId !== 'string' || typeof cwd !== 'string') {
    return null
  }

  return {
    sessionId,
    pid,
    cwd,
    status: typeof parsed.status === 'string' ? parsed.status : null,
    startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : null,
    url: sessionUrl(parsed.bridgeSessionId),
  }
}

/**
 * Live sessions, from Claude's own state directory rather than from anything
 * this process remembers — so sessions that outlived a browsey restart are
 * still listed, and still stoppable.
 *
 * Files are left behind when a session dies, so the pid check is what makes the
 * list truthful.
 */
export function listClaudeSessions(): ClaudeSession[] {
  let names: string[]
  try {
    names = readdirSync(SESSIONS_DIR)
  } catch {
    return []
  }

  const sessions: ClaudeSession[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const session = readSessionFile(name)
    if (session && isAlive(session.pid)) sessions.push(session)
  }

  return sessions.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
}

/**
 * Ends a session by signalling the `claude` process; the `script` wrapper exits
 * once its child does. Returns false when the session is already gone.
 */
export function stopClaudeSession(sessionId: string): boolean {
  const session = listClaudeSessions().find((candidate) => candidate.sessionId === sessionId)
  if (!session) return false

  try {
    process.kill(session.pid, 'SIGTERM')
    return true
  } catch {
    return false
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * The spawned child is `script`, whose pid is not the session's — so the new
 * session is identified by cwd plus not having existed a moment ago.
 */
async function awaitRegistration(
  cwd: string,
  known: Set<string>,
  onPhase?: PhaseReporter
): Promise<ClaudeSession> {
  const deadline = Date.now() + REGISTER_TIMEOUT_MS
  let session: ClaudeSession | null = null

  while (Date.now() < deadline && !session) {
    session =
      listClaudeSessions().find(
        (candidate) => candidate.cwd === cwd && !known.has(candidate.sessionId)
      ) ?? null
    if (!session) await delay(POLL_INTERVAL_MS)
  }

  if (!session) {
    throw new ClaudeRemoteControlError('Claude did not register a Remote Control session in time')
  }

  // A session that never grew a link is still handed back: everything except
  // the phone button works, and failing the launch over it would be worse.
  const { sessionId } = session
  // Reported only once the session exists, so the phase means what it says: the
  // session is up and this is the wait for its link. Skipped entirely when the
  // link was already there, which is why this sits after the first read.
  if (!session.url) onPhase?.('linking')
  const linkDeadline = Date.now() + BRIDGE_TIMEOUT_MS
  while (!session.url && Date.now() < linkDeadline) {
    await delay(POLL_INTERVAL_MS)
    session = listClaudeSessions().find((candidate) => candidate.sessionId === sessionId) ?? session
  }

  return session
}

export type StartedClaudeSession = {
  session: ClaudeSession
}

/**
 * Called as the launch crosses from one phase into the next. Every phase this
 * module reports is one it is itself waiting on, so a caller can narrate the
 * wait without knowing how a Remote Control session comes up.
 */
export type PhaseReporter = (phase: AgentLaunchPhase) => void

/**
 * Output goes to the run log rather than a pipe, and the child is detached, so
 * a session outlives the browsey process that started it. That is deliberate:
 * a server restart should not close sessions somebody is talking to from their
 * phone, and `listClaudeSessions` reads Claude's state directly, so nothing is
 * orphaned from browsey's point of view.
 */
export async function startClaudeSession({
  binary,
  cwd,
  name,
  prompt,
  model,
  effort,
  logFd,
  env,
  onPhase,
}: {
  binary: string
  cwd: string
  /**
   * What the phone lists this session as, permanently.
   *
   * Claude generates its own title from the first message, but that title never
   * leaves the Mac once a name is passed here: the name is what the session
   * registers with, and the code that would replace it with the generated one
   * bails whenever a name was given. Verified against the session record the
   * phone actually reads — so this argument is the only title there will be, and
   * an empty string is worse than a boring one.
   */
  name: string
  /**
   * Claude's positional prompt: the session starts working on it the moment it
   * registers. Empty string opens the session idle instead, which is what a
   * launch with no instructions asks for.
   */
  prompt: string
  model: string
  /** Empty string omits the flag, leaving the level to Claude's own config. */
  effort: string
  logFd: number
  env: NodeJS.ProcessEnv
  onPhase?: PhaseReporter
}): Promise<StartedClaudeSession> {
  if (!isExecutable(SCRIPT_BIN)) {
    throw new ClaudeRemoteControlError(`${SCRIPT_BIN} not found; Remote Control needs a pty`)
  }

  onPhase?.('starting')
  const known = new Set(listClaudeSessions().map((session) => session.sessionId))

  const argv = [
    SCRIPT_BIN,
    '-q',
    '/dev/null',
    binary,
    '--remote-control',
    name || basename(cwd) || 'browsey',
    '--permission-mode',
    'bypassPermissions',
    ...(model ? ['--model', model] : []),
    ...(effort ? ['--effort', effort] : []),
    // Last, so it lands on the positional `prompt` argument rather than being
    // swallowed by `--remote-control`, whose own name argument is optional.
    ...(prompt ? [prompt] : []),
  ]

  const child = spawn(argv[0]!, argv.slice(1), {
    cwd,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env,
  })

  try {
    const session = await awaitRegistration(cwd, known, onPhase)
    child.unref()
    return { session }
  } catch (error) {
    // A session that never registered is invisible on the phone and would only
    // sit there burning a process.
    try {
      child.kill('SIGTERM')
    } catch {
      // Already gone.
    }
    throw error
  }
}
