import { execFileSync, spawn } from 'child_process'
import {
  accessSync,
  closeSync,
  constants,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import type { AgentLaunchFailureReason, AgentLaunchPhase } from '@vforsh/browsey-shared'

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
 *
 * Claude Code also asks whether a workspace is trusted before registering. It
 * has no launch flag for that decision, so output is watched and the launch
 * fails with an actionable reason instead of impersonating a Remote Control
 * timeout. Trust itself remains a separate, affirmative API action.
 */

/** BSD script, which takes the command as argv after the typescript file. */
const SCRIPT_BIN = '/usr/bin/script'

/**
 * Claude writes one file per live session here, keyed by pid, the moment the
 * session starts — well before the transcript under `~/.claude/projects`
 * exists. It is the only place `bridgeSessionId` can be read at launch time.
 */
const SESSIONS_DIR = join(homedir(), '.claude', 'sessions')

/** An initial prompt can run project hooks for minutes before Claude writes its session file. */
const REGISTER_TIMEOUT_MS = 5 * 60_000

/**
 * The state file is written before Remote Control finishes registering, so the
 * link can show up well after the session does. Waiting for it is what lets a
 * launch answer with a link instead of making the client poll for one.
 */
const BRIDGE_TIMEOUT_MS = 2 * 60_000
const POLL_INTERVAL_MS = 500

export class ClaudeRemoteControlError extends Error {
  constructor(
    message: string,
    public reason?: AgentLaunchFailureReason
  ) {
    super(message)
    this.name = 'ClaudeRemoteControlError'
  }
}

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

/** Enough to cover the complete trust screen without rereading an unbounded log. */
const REGISTRATION_OUTPUT_BYTES = 64 * 1024

/** Ink lays text out with cursor-position escapes instead of spaces. */
function compactTerminalOutput(output: string): string {
  return output
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\s/g, '')
}

export function hasClaudeWorkspaceTrustPrompt(output: string): boolean {
  return compactTerminalOutput(output).toLowerCase().includes(
    'quicksafetycheck:isthisaprojectyoucreatedoroneyoutrust?'
  )
}

function registrationOutput(logPath: string): string {
  try {
    const { size } = statSync(logPath)
    if (size === 0) return ''
    const start = Math.max(0, size - REGISTRATION_OUTPUT_BYTES)
    const fd = openSync(logPath, 'r')
    try {
      const buffer = Buffer.alloc(size - start)
      readSync(fd, buffer, 0, buffer.length, start)
      return buffer.toString('utf-8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}

type ProcessInfo = { parentPid: number; groupId: number }

/** `script(1)` puts Claude in a *different* process group, but keeps it as a child. */
function processTable(): Map<number, ProcessInfo> | null {
  try {
    const output = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid='], {
      encoding: 'utf-8',
      maxBuffer: 4 * 1024 * 1024,
    })
    const table = new Map<number, ProcessInfo>()
    for (const line of output.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line)
      if (match) {
        table.set(Number(match[1]), {
          parentPid: Number(match[2]),
          groupId: Number(match[3]),
        })
      }
    }
    return table
  } catch {
    return null
  }
}

/** A cwd can have aliases and concurrent launches; the wrapper PID is unique. */
async function awaitRegistration(
  wrapperPid: number,
  known: Set<string>,
  logPath: string,
  onPhase?: PhaseReporter
): Promise<StartedClaudeSession> {
  const deadline = Date.now() + REGISTER_TIMEOUT_MS
  let session: ClaudeSession | null = null

  while (Date.now() < deadline && !session) {
    if (hasClaudeWorkspaceTrustPrompt(registrationOutput(logPath))) {
      throw new ClaudeRemoteControlError(
        "This folder isn't trusted by Claude Code yet. Trust it, then launch again.",
        'workspace-untrusted'
      )
    }
    const candidates = listClaudeSessions().filter((candidate) => !known.has(candidate.sessionId))
    if (candidates.length > 0) {
      const processes = processTable()
      session =
        candidates.find((candidate) => processes?.get(candidate.pid)?.parentPid === wrapperPid) ??
        null
    }
    if (!session && !isAlive(wrapperPid)) {
      throw new ClaudeRemoteControlError('Claude exited before its Remote Control session could be identified')
    }
    if (!session) await delay(POLL_INTERVAL_MS)
  }

  if (!session) {
    throw new ClaudeRemoteControlError(
      isAlive(wrapperPid)
        ? 'Could not identify the Claude session in time. The process was left running; check Claude before launching again.'
        : 'Claude exited before its Remote Control session could be identified.'
    )
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

  if (!isAlive(session.pid)) {
    throw new ClaudeRemoteControlError('Claude exited while its Remote Control link was starting')
  }
  return { session }
}

export type StartedClaudeSession = { session: ClaudeSession }

/** Only a known trust refusal is stopped; a timeout may hide an active session. */
function stopUntrustedLaunch(wrapperPid: number): void {
  const processes = processTable()
  for (const [pid, info] of processes ?? []) {
    if (info.parentPid !== wrapperPid) continue
    try {
      process.kill(info.groupId === pid ? -pid : pid, 'SIGTERM')
    } catch {
      // The child already exited.
    }
  }
  try {
    process.kill(wrapperPid, 'SIGTERM')
  } catch {
    // The wrapper already exited.
  }
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
  logPath,
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
  /** Same file as `logFd`, read while waiting for registration prompts. */
  logPath: string
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
  // Spawn errors are emitted asynchronously; without a listener they crash the API.
  child.on('error', (error) => console.warn(`Claude terminal failed: ${error.message}`))

  try {
    if (!child.pid) throw new ClaudeRemoteControlError('Could not start the Claude terminal')
    return await awaitRegistration(child.pid, known, logPath, onPhase)
  } catch (error) {
    if (
      child.pid &&
      error instanceof ClaudeRemoteControlError &&
      error.reason === 'workspace-untrusted'
    ) {
      stopUntrustedLaunch(child.pid)
    }
    throw error
  } finally {
    child.unref()
  }
}
