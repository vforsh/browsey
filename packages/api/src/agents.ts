import { spawn } from 'child_process'
import { accessSync, closeSync, constants, mkdirSync, openSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { randomUUID } from 'crypto'
import { findGitRoot } from './git.js'
import type {
  AgentDescriptor,
  AgentCapabilitiesResponse,
  AgentId,
  AgentLaunchRequest,
  AgentLaunchTarget,
  AgentModelOption,
  AgentTargetKind,
} from '@vforsh/browsey-shared'

export const MAX_PROMPT_LENGTH = 100_000
export const MAX_SELECTION_LENGTH = 32 * 1024

/** Spawn is reported as successful once no `error` event arrives within this window. */
const SPAWN_GRACE_MS = 200

/** Extra PATH entries — the launchd-managed instance inherits a bare PATH. */
const EXTRA_PATH_ENTRIES = ['/opt/homebrew/bin', join(homedir(), '.local/bin')]

export class AgentLaunchError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
    this.name = 'AgentLaunchError'
  }
}

type AgentDefinition = {
  id: AgentId
  name: string
  /** Env var that overrides binary resolution (settable in the launchd plist). */
  binEnvVar: string
  /** Stable install locations, checked before falling back to PATH. */
  knownBinPaths: string[]
  command: string
  /** Curated model list. The leading empty id means "omit the model flag". */
  models: AgentModelOption[]
  /** Config file read (best effort) to label the default model. */
  defaultModelFile: string
  readDefaultModel: (contents: string) => string | null
}

const AGENT_DEFINITIONS: Record<AgentId, AgentDefinition> = {
  'claude-code': {
    id: 'claude-code',
    name: 'Claude Code',
    binEnvVar: 'BROWSEY_CLAUDE_BIN',
    knownBinPaths: [join(homedir(), '.local/bin/claude')],
    command: 'claude',
    models: [
      { id: '', label: 'Default' },
      { id: 'sonnet', label: 'Sonnet' },
      { id: 'opus', label: 'Opus' },
      { id: 'fable', label: 'Fable' },
      { id: 'haiku', label: 'Haiku' },
    ],
    defaultModelFile: join(homedir(), '.claude/settings.json'),
    readDefaultModel: (contents) => {
      const parsed = JSON.parse(contents) as { model?: unknown }
      return typeof parsed.model === 'string' ? parsed.model : null
    },
  },
  codex: {
    id: 'codex',
    name: 'Codex',
    binEnvVar: 'BROWSEY_CODEX_BIN',
    knownBinPaths: ['/opt/homebrew/bin/codex'],
    command: 'codex',
    models: [
      { id: '', label: 'Default' },
      { id: 'gpt-5.6-sol', label: 'gpt-5.6-sol' },
      { id: 'gpt-5.6-terra', label: 'gpt-5.6-terra' },
      { id: 'gpt-5.6-luna', label: 'gpt-5.6-luna' },
      { id: 'gpt-5.5', label: 'gpt-5.5' },
    ],
    defaultModelFile: join(homedir(), '.codex/config.toml'),
    readDefaultModel: (contents) => {
      // Top-level `model = "..."`, before any [section] header.
      for (const line of contents.split('\n')) {
        const trimmed = line.trim()
        if (trimmed.startsWith('[')) break
        const match = /^model\s*=\s*["'](.+?)["']\s*$/.exec(trimmed)
        if (match?.[1]) return match[1]
      }
      return null
    },
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

function defaultModelLabel(definition: AgentDefinition): string {
  try {
    const model = definition.readDefaultModel(readFileSync(definition.defaultModelFile, 'utf-8'))
    return model ? `Default (${model})` : 'Default'
  } catch {
    return 'Default'
  }
}

function describeAgent(definition: AgentDefinition): AgentDescriptor {
  const models = definition.models.map((model) =>
    model.id === '' ? { id: '', label: defaultModelLabel(definition) } : model
  )

  return {
    id: definition.id,
    name: definition.name,
    installed: resolveAgentBinary(definition.id) !== null,
    models,
  }
}

export function getAgentCapabilities(): AgentCapabilitiesResponse {
  return {
    enabled: true,
    agents: [describeAgent(AGENT_DEFINITIONS['claude-code']), describeAgent(AGENT_DEFINITIONS.codex)],
  }
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
  target: AgentLaunchTarget
}

export function validateLaunchRequest(body: unknown): ValidatedLaunchRequest {
  if (!body || typeof body !== 'object') {
    throw new AgentLaunchError(400, 'Invalid request body')
  }

  const { agent, prompt, model, target } = body as Partial<AgentLaunchRequest>

  if (!isAgentId(agent)) {
    throw new AgentLaunchError(400, 'Unknown agent')
  }
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new AgentLaunchError(400, 'prompt is required')
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new AgentLaunchError(400, `prompt exceeds ${MAX_PROMPT_LENGTH} characters`)
  }

  const resolvedModel = model ?? ''
  if (typeof resolvedModel !== 'string') {
    throw new AgentLaunchError(400, 'model must be a string')
  }
  if (resolvedModel && !AGENT_DEFINITIONS[agent].models.some((m) => m.id === resolvedModel)) {
    throw new AgentLaunchError(400, `Unknown model "${resolvedModel}" for ${agent}`)
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
    prompt: prompt.trim(),
    model: resolvedModel,
    target: { kind, path, ...(kind === 'selection' ? { selection } : {}) },
  }
}

function buildArgv(
  agent: AgentId,
  binary: string,
  finalPrompt: string,
  model: string,
  sessionId: string | null
): string[] {
  if (agent === 'claude-code') {
    return [
      binary,
      '-p',
      finalPrompt,
      '--dangerously-skip-permissions',
      ...(sessionId ? ['--session-id', sessionId] : []),
      ...(model ? ['--model', model] : []),
    ]
  }

  return [
    binary,
    'exec',
    '--dangerously-bypass-approvals-and-sandbox',
    ...(model ? ['-m', model] : []),
    finalPrompt,
  ]
}

/** Sole purpose is debugging failed runs; stdout is otherwise discarded. */
function openRunLog(agent: AgentId): number {
  const directory = join(homedir(), '.browsey', 'agent-runs')
  mkdirSync(directory, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return openSync(join(directory, `${stamp}-${agent}.log`), 'a')
}

export type SpawnedThread = {
  sessionId?: string
}

/**
 * Detached and unref'd so threads survive browsey restarts. Argv is passed as an
 * array (never a shell), so prompt and selection carry no injection surface.
 */
export async function spawnAgentThread({
  agent,
  cwd,
  finalPrompt,
  model,
}: {
  agent: AgentId
  cwd: string
  finalPrompt: string
  model: string
}): Promise<SpawnedThread> {
  const binary = resolveAgentBinary(agent)
  if (!binary) {
    throw new AgentLaunchError(422, `${AGENT_DEFINITIONS[agent].command} CLI not found on server`)
  }

  // Minting the session id keeps the run resumable with `claude --resume <uuid>`
  // even though stdout is discarded. Codex has no equivalent flag.
  const sessionId = agent === 'claude-code' ? randomUUID() : null
  const argv = buildArgv(agent, binary, finalPrompt, model, sessionId)
  const logFd = openRunLog(agent)

  try {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, PATH: augmentedPath() },
    })

    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      const onError = (error: Error) => {
        clearTimeout(timer)
        rejectSpawn(error)
      }
      const timer = setTimeout(() => {
        child.removeListener('error', onError)
        resolveSpawn()
      }, SPAWN_GRACE_MS)
      child.once('error', onError)
    })

    child.unref()
    return sessionId ? { sessionId } : {}
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new AgentLaunchError(500, `Failed to start ${agent}: ${message}`)
  } finally {
    closeSync(logFd)
  }
}
