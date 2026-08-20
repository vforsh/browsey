import { spawn } from 'child_process'
import {
  accessSync,
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from 'fs'
import { homedir } from 'os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { findGitRoot } from './git.js'
import { CodexAppServerError, startCodexThread } from './codex-app-server.js'
import { nameCodexThread } from './codex-thread-title.js'
import {
  FALLBACK_EFFORT_IDS,
  cachedEffortCatalogue,
  effortOption,
  type EffortCatalogue,
} from './codex-model-catalogue.js'
import {
  ClaudeRemoteControlError,
  listClaudeSessions,
  startClaudeSession,
} from './claude-remote-control.js'
import type {
  AgentDescriptor,
  AgentEffortOption,
  AgentLaunchMode,
  AgentSession,
  AgentFailure,
  AgentCapabilitiesResponse,
  AgentId,
  AgentLaunchRequest,
  AgentLaunchTarget,
  AgentModelOption,
  AgentTargetKind,
} from '@vforsh/browsey-shared'

export const MAX_PROMPT_LENGTH = 100_000
export const MAX_SELECTION_LENGTH = 32 * 1024

/** Bytes of the run log read back to explain a fast failure. */
const LOG_TAIL_BYTES = 2_000

/** Extra PATH entries — the launchd-managed instance inherits a bare PATH. */
const EXTRA_PATH_ENTRIES = ['/opt/homebrew/bin', join(homedir(), '.local/bin')]

/**
 * Last non-zero exit per agent, in memory only — it describes the machine's
 * current state (logged out, out of quota), so losing it on restart is fine.
 */
const lastFailures = new Map<AgentId, AgentFailure>()

export class AgentLaunchError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
    this.name = 'AgentLaunchError'
  }
}

/** Levels `claude --effort` accepts. Flat: the CLI takes the same set always. */
const CLAUDE_EFFORT_IDS = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * Claude Code stores no effort anywhere and documents no default, so unlike
 * Codex there is nothing to read — this is a choice, not a reading. Middle of
 * the five, matching what every model in Codex's catalogue defaults to.
 */
const CLAUDE_DEFAULT_EFFORT = 'medium'

type CuratedModel = { id: string; label: string }

type EffortContext = {
  /** Null until the CLI's catalogue has been read at least once. */
  catalogue: EffortCatalogue | null
  /** Stands in for an omitted model flag, which an older client may still send. */
  defaultModel: string | null
}

type AgentDefinition = {
  id: AgentId
  name: string
  /** Env var that overrides binary resolution (settable in the launchd plist). */
  binEnvVar: string
  /** Stable install locations, checked before falling back to PATH. */
  knownBinPaths: string[]
  command: string
  /** Curated model list, joined by the CLI's own default when that is not on it. */
  models: CuratedModel[]
  /** Levels to offer for one model, from whatever the catalogue could supply. */
  resolveEfforts: (modelId: string, context: EffortContext) => AgentEffortOption[]
  /** Reads what the CLI advertises per model. Cached, and never awaited. */
  loadEffortCatalogue?: (
    binary: string | null,
    env: NodeJS.ProcessEnv
  ) => EffortCatalogue | null
  /** Config file read (best effort) to label the default model. */
  defaultModelFile: string
  readDefaultModel: (contents: string) => string | null
  /** Same file, for the level the CLI falls back on. Null when it says nothing. */
  readDefaultEffort: (contents: string) => string | null
  /** Env forced on every run of this agent, overriding anything inherited. */
  env?: Record<string, string>
  launchMode: AgentLaunchMode
  /** Only `session` agents have anything to list. */
  listSessions?: () => AgentSession[]
}

/** A bare `key = "value"` in a TOML file's preamble, before any [section]. */
function readTopLevelString(contents: string, key: string): string | null {
  const pattern = new RegExp(`^${key}\\s*=\\s*["'](.+?)["']\\s*$`)
  for (const line of contents.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('[')) break
    const match = pattern.exec(trimmed)
    if (match?.[1]) return match[1]
  }
  return null
}

const AGENT_DEFINITIONS: Record<AgentId, AgentDefinition> = {
  'claude-code': {
    id: 'claude-code',
    name: 'Claude Code',
    binEnvVar: 'BROWSEY_CLAUDE_BIN',
    knownBinPaths: [join(homedir(), '.local/bin/claude')],
    command: 'claude',
    // Claude opens a live Remote Control session rather than composing a thread:
    // the phone app's Code section lists live sessions and nothing else.
    launchMode: 'session',
    listSessions: listClaudeSessions,
    // Claude Code tags each session with the surface it came from, and the
    // desktop app only lists sessions tagged `claude-desktop`. Forcing it stops
    // the value depending on whatever env browsey happened to be started with —
    // a shell running inside Claude Code exports it, a launchd job does not.
    env: { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' },
    // Labels carry the version each id resolves to today, because "Opus" next
    // to "Opus 5" says nothing about which is which. That makes them a
    // maintenance cost: `--model` documents the bare words as aliases for "the
    // latest model", so every label but `claude-opus-5`'s is a snapshot and
    // goes wrong the day an alias moves. Verify with
    // `claude -p x --model <id> --output-format json` and read `modelUsage`.
    models: [
      { id: 'claude-opus-5[1m]', label: 'Opus 5 1M' },
      { id: 'claude-opus-5', label: 'Opus 5' },
      { id: 'opus[1m]', label: 'Opus 4.8 1M' },
      { id: 'opus', label: 'Opus 4.8' },
      { id: 'fable', label: 'Fable 5' },
      { id: 'sonnet', label: 'Sonnet 4.6' },
    ],
    // Claude advertises nothing per model; `--effort` documents the whole set.
    resolveEfforts: () => CLAUDE_EFFORT_IDS.map((id) => effortOption(id)),
    defaultModelFile: join(homedir(), '.claude/settings.json'),
    readDefaultModel: (contents) => {
      const parsed = JSON.parse(contents) as { model?: unknown }
      return typeof parsed.model === 'string' ? parsed.model : null
    },
    readDefaultEffort: () => CLAUDE_DEFAULT_EFFORT,
  },
  codex: {
    id: 'codex',
    name: 'Codex',
    binEnvVar: 'BROWSEY_CODEX_BIN',
    knownBinPaths: ['/opt/homebrew/bin/codex'],
    command: 'codex',
    launchMode: 'prompt',
    models: [
      { id: 'gpt-5.6-sol', label: 'gpt-5.6-sol' },
      { id: 'gpt-5.6-terra', label: 'gpt-5.6-terra' },
      { id: 'gpt-5.6-luna', label: 'gpt-5.6-luna' },
    ],
    // Each model advertises its own levels, and they differ — `ultra` is not on
    // all of them. Before the catalogue has been read, the set every model has
    // in common stands in, so the row is never empty and never wrong.
    resolveEfforts: (modelId, { catalogue, defaultModel }) => {
      const resolved = modelId || defaultModel
      const advertised = resolved ? catalogue?.get(resolved) : null
      return advertised ?? FALLBACK_EFFORT_IDS.map((id) => effortOption(id))
    },
    loadEffortCatalogue: cachedEffortCatalogue,
    defaultModelFile: join(homedir(), '.codex/config.toml'),
    readDefaultModel: (contents) => readTopLevelString(contents, 'model'),
    readDefaultEffort: (contents) => readTopLevelString(contents, 'model_reasoning_effort'),
  },
}

export function isAgentId(value: unknown): value is AgentId {
  return value === 'claude-code' || value === 'codex'
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** PATH with the stable install dirs appended, used for spawning and `Bun.which`. */
function augmentedPath(): string {
  return [process.env.PATH, ...EXTRA_PATH_ENTRIES].filter(Boolean).join(':')
}

/**
 * First hit wins: env override, then stable known paths, then PATH lookup.
 * The interactive-shell `which` result is deliberately not a default — on this
 * machine it points into a volatile fnm multishell directory.
 */
export function resolveAgentBinary(agent: AgentId): string | null {
  const definition = AGENT_DEFINITIONS[agent]

  const override = process.env[definition.binEnvVar]
  if (override && isExecutable(override)) return override

  for (const candidate of definition.knownBinPaths) {
    if (isExecutable(candidate)) return candidate
  }

  const found = Bun.which(definition.command, { PATH: augmentedPath() })
  return found && isExecutable(found) ? found : null
}

/** Env every child of this agent gets, and that reading its config needs too. */
function agentEnv(definition: AgentDefinition): NodeJS.ProcessEnv {
  return { ...process.env, PATH: augmentedPath(), ...definition.env }
}

/** A malformed or missing config must not cost us the whole list. */
function bestEffort(reader: () => string | null): string | null {
  try {
    return reader()
  } catch {
    return null
  }
}

/**
 * What to preselect when the client has nothing remembered: the CLI's own
 * configured choice, so a fresh install launches exactly as the CLI would.
 */
function readDefaults(definition: AgentDefinition): {
  model: string | null
  effort: string | null
} {
  const contents = bestEffort(() => readFileSync(definition.defaultModelFile, 'utf-8')) ?? ''
  return {
    model: bestEffort(() => definition.readDefaultModel(contents)),
    effort: bestEffort(() => definition.readDefaultEffort(contents)),
  }
}

/**
 * Effort lists hang off each model rather than the agent, because that is where
 * they actually differ. Building them is deliberately cheap — the catalogue read
 * behind `loadEffortCatalogue` is cached and never awaited, so a capabilities
 * call stays as fast as it was before any of this existed.
 */
function describeModels(
  definition: AgentDefinition,
  binary: string | null,
  defaultModel: string | null
): AgentModelOption[] {
  const context: EffortContext = {
    catalogue: definition.loadEffortCatalogue?.(binary, agentEnv(definition)) ?? null,
    defaultModel,
  }

  // The list is curated, but whatever the CLI is configured to use always
  // belongs on it: that is what a launch used to get by sending no model at
  // all, and a config can name something the list does not — a pinned full
  // model name, or a context variant. Leaving it off would quietly swap the
  // user's own default for the nearest chip that happens to look like it.
  const curated = definition.models
  const models =
    defaultModel && !curated.some((model) => model.id === defaultModel)
      ? [{ id: defaultModel, label: defaultModel }, ...curated]
      : curated

  return models.map((model) => ({
    ...model,
    efforts: definition.resolveEfforts(model.id, context),
  }))
}

function describeAgent(definition: AgentDefinition, targetCwd: string | null): AgentDescriptor {
  const binary = resolveAgentBinary(definition.id)
  const defaults = readDefaults(definition)

  return {
    id: definition.id,
    name: definition.name,
    installed: binary !== null,
    models: describeModels(definition, binary, defaults.model),
    defaultModel: defaults.model,
    defaultEffort: defaults.effort,
    lastFailure: lastFailures.get(definition.id) ?? null,
    launchMode: definition.launchMode,
    sessions: definition.listSessions?.() ?? [],
    targetCwd,
  }
}

export type CapabilitiesTarget = {
  absPath: string
  isDirectory: boolean
}

/**
 * `target` is optional. With it, each agent also reports the cwd a launch would
 * resolve to, which is the only way a client can tell whether one of the listed
 * sessions is already open on the thing the user is looking at.
 */
export async function getAgentCapabilities(
  target?: CapabilitiesTarget
): Promise<AgentCapabilitiesResponse> {
  const agents = await Promise.all(
    (['claude-code', 'codex'] as const).map(async (id) => {
      const targetCwd = target
        ? (await resolveThreadCwd(target.absPath, target.isDirectory, id)).cwd
        : null
      return describeAgent(AGENT_DEFINITIONS[id], targetCwd)
    })
  )

  return { enabled: true, agents }
}

function normalizeDir(path: string): string {
  const resolved = resolve(path)
  return resolved.length > 1 && resolved.endsWith(sep) ? resolved.slice(0, -1) : resolved
}

/**
 * Directories each CLI already keys project state by. Both tools decide
 * "reuse vs create fresh" purely from cwd, so this list is all the bookkeeping
 * the reuse logic needs.
 */
function knownProjectDirs(agent: AgentId): Set<string> {
  const dirs = new Set<string>()

  try {
    if (agent === 'claude-code') {
      const parsed = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf-8')) as {
        projects?: unknown
      }
      const projects = parsed.projects
      if (projects && typeof projects === 'object') {
        for (const key of Object.keys(projects)) dirs.add(normalizeDir(key))
      }
    } else {
      const contents = readFileSync(join(homedir(), '.codex/config.toml'), 'utf-8')
      for (const line of contents.split('\n')) {
        const match = /^\[projects\."(.+)"\]/.exec(line.trim())
        if (match?.[1]) dirs.add(normalizeDir(match[1]))
      }
    }
  } catch {
    // A missing or unparseable config just means "no known projects".
  }

  return dirs
}

/** Ancestors of `dir` from `dir` up to and including `gitRoot`, nearest first. */
function ancestorsUpTo(dir: string, gitRoot: string): string[] {
  const relativePath = relative(gitRoot, dir)
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return [dir]
  }

  const window: string[] = []
  let current = dir
  while (true) {
    window.push(current)
    if (current === gitRoot) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return window
}

export type ResolvedThreadCwd = {
  cwd: string
  reused: boolean
}

/**
 * Nearest known agent project, else the git root, else the directory itself.
 *
 * The walk-up window is bounded by the git root on purpose: umbrella entries
 * like `~/dev` or `/` are trusted by the CLIs but must never become the cwd.
 * The window may legitimately reach above the served root — the user's intent
 * is "land in the real project", and agents run with full access anyway.
 */
export async function resolveThreadCwd(
  targetAbs: string,
  isDirectory: boolean,
  agent: AgentId
): Promise<ResolvedThreadCwd> {
  const dir = normalizeDir(isDirectory ? targetAbs : dirname(targetAbs))
  const gitRootRaw = await findGitRoot(dir)
  const gitRoot = gitRootRaw ? normalizeDir(gitRootRaw) : null
  const window = gitRoot ? ancestorsUpTo(dir, gitRoot) : [dir]

  const known = knownProjectDirs(agent)
  const blacklist = new Set([normalizeDir('/'), normalizeDir(homedir())])

  for (const candidate of window) {
    if (known.has(candidate) && !blacklist.has(candidate)) {
      return { cwd: candidate, reused: true }
    }
  }

  return { cwd: gitRoot ?? dir, reused: false }
}

/** Path of the target relative to the resolved cwd, POSIX-style. */
function relativeToCwd(cwd: string, targetAbs: string): string {
  const relativePath = relative(cwd, targetAbs)
  return relativePath === '' ? '.' : relativePath.split(sep).join('/')
}

export function buildThreadPrompt({
  kind,
  prompt,
  cwd,
  targetAbs,
  selection,
}: {
  kind: AgentTargetKind
  prompt: string
  cwd: string
  targetAbs: string
  selection?: string
}): string {
  const relativePath = relativeToCwd(cwd, targetAbs)

  if (kind === 'selection') {
    return `File: ${relativePath}\n\nSelected excerpt:\n\`\`\`\n${selection ?? ''}\n\`\`\`\n\n${prompt}`
  }
  if (kind === 'file') {
    return `File: ${relativePath}\n\n${prompt}`
  }
  if (relativePath === '.') {
    return prompt
  }
  return `Work within the subdirectory: ${relativePath}/\n\n${prompt}`
}

export type ValidatedLaunchRequest = {
  agent: AgentId
  prompt: string
  model: string
  effort: string
  target: AgentLaunchTarget
}

export function validateLaunchRequest(body: unknown): ValidatedLaunchRequest {
  if (!body || typeof body !== 'object') {
    throw new AgentLaunchError(400, 'Invalid request body')
  }

  const { agent, prompt, model, effort, target } = body as Partial<AgentLaunchRequest>

  if (!isAgentId(agent)) {
    throw new AgentLaunchError(400, 'Unknown agent')
  }

  // A `session` agent opens an empty session and hands it over, so a prompt is
  // not merely optional — there is nowhere to put one.
  const wantsPrompt = AGENT_DEFINITIONS[agent].launchMode === 'prompt'
  const rawPrompt = typeof prompt === 'string' ? prompt : ''
  if (wantsPrompt) {
    if (rawPrompt.trim().length === 0) {
      throw new AgentLaunchError(400, 'prompt is required')
    }
    if (rawPrompt.length > MAX_PROMPT_LENGTH) {
      throw new AgentLaunchError(400, `prompt exceeds ${MAX_PROMPT_LENGTH} characters`)
    }
  }

  const resolvedModel = model ?? ''
  if (typeof resolvedModel !== 'string') {
    throw new AgentLaunchError(400, 'model must be a string')
  }
  const resolvedEffort = effort ?? ''
  if (typeof resolvedEffort !== 'string') {
    throw new AgentLaunchError(400, 'effort must be a string')
  }

  // Both are checked against what `/api/agents` actually offered, which is wider
  // than the curated list — it also carries the CLI's configured default. An
  // omitted value stays legal so a client built before the picker still works.
  const offered = describeAgent(AGENT_DEFINITIONS[agent], null)
  if (resolvedModel && !offered.models.some((option) => option.id === resolvedModel)) {
    throw new AgentLaunchError(400, `Unknown model "${resolvedModel}" for ${agent}`)
  }
  // Effort is checked against the chosen model, not the agent: a level one model
  // advertises is not one another accepts, and the CLI would reject it later and
  // worse. An omitted model is the configured one, so its levels are the test.
  if (resolvedEffort) {
    const against = resolvedModel || offered.defaultModel
    const chosen = offered.models.find((option) => option.id === against)
    if (!chosen?.efforts.some((option) => option.id === resolvedEffort)) {
      throw new AgentLaunchError(
        400,
        `Unknown effort "${resolvedEffort}" for ${agent} ${resolvedModel || 'default model'}`
      )
    }
  }

  if (!target || typeof target !== 'object') {
    throw new AgentLaunchError(400, 'target is required')
  }
  const { kind, path, selection } = target as Partial<AgentLaunchTarget>
  if (kind !== 'directory' && kind !== 'file' && kind !== 'selection') {
    throw new AgentLaunchError(400, 'target.kind must be directory, file or selection')
  }
  if (typeof path !== 'string') {
    throw new AgentLaunchError(400, 'target.path is required')
  }
  if (kind === 'selection') {
    if (typeof selection !== 'string' || selection.length === 0) {
      throw new AgentLaunchError(400, 'target.selection is required for selection targets')
    }
    if (selection.length > MAX_SELECTION_LENGTH) {
      throw new AgentLaunchError(400, `target.selection exceeds ${MAX_SELECTION_LENGTH} characters`)
    }
  }

  return {
    agent,
    prompt: wantsPrompt ? rawPrompt.trim() : '',
    model: resolvedModel,
    effort: resolvedEffort,
    target: { kind, path, ...(kind === 'selection' ? { selection } : {}) },
  }
}

/** Sole purpose is debugging failed runs; stdout is otherwise discarded. */
function openRunLog(agent: AgentId): { fd: number; path: string } {
  const directory = join(homedir(), '.browsey', 'agent-runs')
  mkdirSync(directory, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const path = join(directory, `${stamp}-${agent}.log`)
  return { fd: openSync(path, 'a'), path }
}

/** Last meaningful line the agent printed, used as the client-facing reason. */
function readFailureReason(logPath: string): string | null {
  try {
    const { size } = statSync(logPath)
    if (size === 0) return null

    const start = Math.max(0, size - LOG_TAIL_BYTES)
    const fd = openSync(logPath, 'r')
    try {
      const buffer = Buffer.alloc(size - start)
      readSync(fd, buffer, 0, buffer.length, start)
      const lines = buffer.toString('utf-8').split('\n').map((line) => line.trim())
      return lines.filter(Boolean).pop() ?? null
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

function toLaunchError(error: unknown, command: string): AgentLaunchError {
  if (error instanceof AgentLaunchError) return error
  if (error instanceof CodexAppServerError) return new AgentLaunchError(422, error.message)
  if (error instanceof ClaudeRemoteControlError) return new AgentLaunchError(422, error.message)
  const message = error instanceof Error ? error.message : String(error)
  return new AgentLaunchError(500, `Failed to start ${command}: ${message}`)
}

export type SpawnedThread = {
  /** Claude: the live session's id. Codex: the app-server thread id. */
  sessionId: string
  /** Deep link that continues this thread on the phone, when one exists. */
  url?: string
}

/**
 * Argv is passed as an array (never a shell), so prompt and selection carry no
 * injection surface. Claude opens a detached Remote Control session that
 * outlives browsey; Codex is driven over the app-server protocol, so its thread
 * is tied to this process for the duration of the turn — the cost of being
 * visible in Codex Desktop, which ignores `codex exec` runs entirely.
 */
export async function spawnAgentThread({
  agent,
  cwd,
  finalPrompt,
  model,
  effort,
}: {
  agent: AgentId
  cwd: string
  finalPrompt: string
  model: string
  /** Empty string leaves the level to the CLI's own configuration. */
  effort: string
}): Promise<SpawnedThread> {
  const binary = resolveAgentBinary(agent)
  if (!binary) {
    throw new AgentLaunchError(422, `${AGENT_DEFINITIONS[agent].command} CLI not found on server`)
  }

  const { fd: logFd, path: logPath } = openRunLog(agent)
  const command = AGENT_DEFINITIONS[agent].command
  const env = agentEnv(AGENT_DEFINITIONS[agent])

  // Both the exit handler and the failure path want to close the log, and only
  // one of them may actually do it.
  let logClosed = false
  const closeLog = () => {
    if (logClosed) return
    logClosed = true
    try {
      closeSync(logFd)
    } catch {
      // Nothing left to do if the descriptor is already gone.
    }
  }

  /**
   * The launch stays fire-and-forget, but the outcome is not thrown away:
   * whatever the run reports on the way out is remembered for the next
   * capabilities call, so a stale login shows up where the agent is chosen
   * instead of silently producing threads that never ran.
   */
  const watchOutcome = (child: ReturnType<typeof spawn>) => {
    child.once('exit', (code) => {
      if (code === 0) {
        lastFailures.delete(agent)
      } else {
        lastFailures.set(agent, {
          at: new Date().toISOString(),
          reason:
            readFailureReason(logPath) ?? `${command} exited with code ${code ?? 'unknown'}`,
        })
      }
      closeLog()
    })
  }

  try {
    if (agent === 'codex') {
      const { threadId, child } = await startCodexThread({
        binary,
        cwd,
        prompt: finalPrompt,
        model,
        effort,
        logFd,
        env,
      })
      watchOutcome(child)
      child.unref()

      // Not awaited: titling takes seconds and the phone is waiting on this
      // response. It also must not be able to fail the launch — the thread is
      // already running by now, with or without a name.
      void nameCodexThread({ binary, cwd, threadId, prompt: finalPrompt, env }).catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`Warning: could not name codex thread ${threadId}: ${message}`)
      })

      return { sessionId: threadId }
    }

    // No exit is watched: the session is meant to sit idle until somebody talks
    // to it, so an exit code says nothing about its health. A session that never
    // registers throws instead, and that surfaces at the launch call.
    const { session } = await startClaudeSession({ binary, cwd, model, effort, logFd, env })
    closeLog()
    return { sessionId: session.sessionId, url: session.url ?? undefined }
  } catch (error) {
    closeLog()
    throw toLaunchError(error, command)
  }
}
