export type AgentsOptions = {
  /** When false, every `/api/agents/*` route answers 404. */
  enabled: boolean
  /** Bearer token required by every `/api/agents/*` route. */
  token: string
}

export type ApiServerOptions = {
  root: string
  port: number
  host: string
  bonjour: boolean
  readonly: boolean
  showHidden: boolean
  showQR: boolean
  ignorePatterns: string[]
  version: string
  https: boolean
  httpsCert?: string
  httpsKey?: string
  watch: boolean
  corsOrigin: string
  agents: AgentsOptions
  /**
   * Server-wide origin secret. When set, every `/api/*` request must carry it in
   * `X-Browsey-Access-Token`; absent, the server is unprotected as before.
   * Deliberately separate from `agents.token`, which is a narrower privilege on
   * `/api/agents/*` and travels in `Authorization`.
   */
  accessToken?: string
  /**
   * Where `accessToken` came from, recorded so a reload can resolve the *same*
   * secret instead of minting a fresh one. Paths and flags only — never a value.
   */
  accessTokenFile?: string
  accessTokenFromEnv?: boolean
  quiet?: boolean
}

export type AppServerOptions = {
  port: number
  host: string
  showQR: boolean
  version: string
  https: boolean
  httpsCert?: string
  httpsKey?: string
  open: boolean
  openUrl?: string
  quiet?: boolean
  watch?: boolean
}

type FileEntryBase = {
  name: string
  size: number
  modified: string
  absolutePath: string
}

export type FileItem =
  | (FileEntryBase & {
      type: 'file'
      extension: string | null
    })
  | (FileEntryBase & {
      type: 'directory'
      extension: null
    })
  | (FileEntryBase & {
      type: 'symlink'
      extension: string | null
      linkTarget: string
      targetPath: string | null
      targetAbsolutePath: string
      targetType: 'file' | 'directory' | null
      linkBroken: boolean
    })

export type ListResponse = {
  path: string
  absolutePath: string
  items: FileItem[]
}

export type SyncManifestDirectory = {
  path: string
  absolutePath: string
  /** Listing returned by `hidden=1`. */
  items: FileItem[]
}

export type SyncManifestResponse =
  | {
      path: string
      revision: string
      unchanged: true
    }
  | {
      path: string
      revision: string
      unchanged: false
      showHidden: boolean
      directories: SyncManifestDirectory[]
    }

export type ViewResponse =
  | {
      type: 'text'
      filename: string
      extension: string | null
      content: string
      size: number
      modified: string
    }
  | {
      type: 'image'
      filename: string
      extension: string | null
      url: string
      size: number
    }
  | {
      type: 'video'
      filename: string
      extension: string | null
      url: string
      size: number
    }

export type SaveTextResponse = {
  ok: true
  modified: string
  size: number
}

export type ApiRoutesOptions = {
  serverId?: string
  root: string
  readonly: boolean
  showHidden: boolean
  ignorePatterns: string[]
  agents: AgentsOptions
}

export interface InstanceInfo {
  pid: number
  port: number
  host: string
  kind: 'api' | 'app'
  rootPath: string      // For api: directory being served. For app: not used
  startedAt: string
  readonly: boolean
  version: string
  // Launch options for restart capability
  https?: boolean
  httpsCert?: string
  httpsKey?: string
  showQR?: boolean
  // API-specific options
  bonjour?: boolean
  showHidden?: boolean
  ignorePatterns?: string[]
  watch?: boolean
  corsOrigin?: string
  /** Agent launch endpoints. Absent on registry entries written before agents existed. */
  agents?: boolean
  /**
   * Whether this instance requires `X-Browsey-Access-Token`. A flag, never the
   * value — the registry is a plain-text file. `accessTokenFile` and
   * `accessTokenFromEnv` record *where* the value came from so a reload can
   * resolve the same one; a reload that cannot must refuse rather than mint a
   * different secret and lock out every paired phone.
   */
  accessToken?: boolean
  accessTokenFile?: string
  accessTokenFromEnv?: boolean
}

export interface RegistryFile {
  version: 1
  instances: InstanceInfo[]
}

type SearchResultBase = {
  name: string
  path: string
  absolutePath: string
  score: number
}

export type SearchResult =
  | (SearchResultBase & {
      type: 'file'
      extension: string | null
    })
  | (SearchResultBase & {
      type: 'directory'
      extension: null
    })
  | (SearchResultBase & {
      type: 'symlink'
      extension: string | null
      linkTarget: string
      targetPath: string | null
      targetAbsolutePath: string
      targetType: 'file' | 'directory' | null
      linkBroken: boolean
    })

export type SearchResponse = {
  query: string
  results: SearchResult[]
}

export type HealthHostInfo = {
  hostname: string
  platform: string
  arch: string
  osRelease: string
  runtime: 'bun' | 'node'
  runtimeVersion: string
  uptimeSeconds: number
}

export type HealthResponse = {
  serverId?: string
  ok: boolean
  readonly: boolean
  host: HealthHostInfo
}

export type GitStatusResponse = {
  isRepo: boolean
  branch: string | null
  isDirty: boolean
  staged: number
  unstaged: number
  untracked: number
  lastCommit: {
    hash: string
    shortHash: string
    author: string
    date: string
    message: string
  } | null
  remoteUrl: string | null
  repoRoot: string | null
  ahead: number | null
  behind: number | null
}

export type CommitInfo = {
  hash: string
  shortHash: string
  author: string
  date: string
  message: string
}

export type GitLogResponse = {
  commits: CommitInfo[]
  hasMore: boolean
}

export type GitCommitFile = {
  path: string
  originalPath?: string
  status: string
  workingTreePath: string | null
}

export type GitCommitStats = {
  files: number
  additions: number
  deletions: number
}

export type GitCommitDetails = CommitInfo & {
  body: string
  authorEmail: string
  committer: string
  committerEmail: string
  commitDate: string
  previousCommit: CommitInfo | null
  nextCommit: CommitInfo | null
  stats: GitCommitStats
  files: GitCommitFile[]
}

export type GitCommitResponse = {
  commit: GitCommitDetails
}

export type GitChangeFile = {
  path: string
  originalPath?: string
  indexStatus: string
  workTreeStatus: string
}

export type GitChangesResponse = {
  repoPath: string | null
  staged: GitChangeFile[]
  unstaged: GitChangeFile[]
  untracked: GitChangeFile[]
}

export type GitRevertResponse = {
  ok: true
}

export type AgentId = 'claude-code' | 'codex'

export type AgentEffortOption = {
  id: string
  label: string
  /** The catalogue's own one-liner for the level, when it offers one. */
  description?: string
}

export type AgentModelOption = {
  id: string
  label: string
  /**
   * Reasoning levels this model accepts. Deliberately per model rather than per
   * agent: Codex models advertise different sets, and offering one a model does
   * not know is a rejected launch.
   */
  efforts: AgentEffortOption[]
}

export type AgentFailure = {
  /** ISO timestamp of the failed run. */
  at: string
  /** Last line the agent printed before exiting non-zero. */
  reason: string
}

/**
 * `prompt` composes a one-shot thread from a prompt and its file context.
 * `session` opens a live session in a directory and hands it over. Both take a
 * prompt and compose it the same way; the difference is that a session is also
 * happy without one, and then opens idle waiting to be talked to.
 */
export type AgentLaunchMode = 'prompt' | 'session'

/** A live session an agent is currently holding open. */
export type AgentSession = {
  sessionId: string
  /** The agent process, so a stop request does not depend on server bookkeeping. */
  pid: number
  cwd: string
  status: string | null
  startedAt: number | null
  /** Opens this exact session in the agent's phone app, when it has one. */
  url: string | null
}

export type AgentDescriptor = {
  id: AgentId
  name: string
  /** The CLI binary was found and is executable on the server. */
  installed: boolean
  models: AgentModelOption[]
  /**
   * What to preselect when the client remembers nothing. Both lists are
   * explicit — there is no "let the CLI decide" option — so these carry what
   * the CLI itself is configured to use, and are always on the lists above.
   */
  defaultModel: string | null
  defaultEffort: string | null
  /** Why this agent's most recent run died, if it did. Cleared by a clean run. */
  lastFailure: AgentFailure | null
  launchMode: AgentLaunchMode
  /** Live sessions. Always empty for `prompt` agents, which keep none. */
  sessions: AgentSession[]
  /**
   * Where a launch for the `path` asked about would land, so the client can tell
   * whether a session is already open there. Null when no path was requested.
   */
  targetCwd: string | null
}

export type AgentCapabilitiesResponse = {
  enabled: boolean
  agents: AgentDescriptor[]
}

export type AgentTargetKind = 'directory' | 'file' | 'selection'

export type AgentLaunchTarget = {
  kind: AgentTargetKind
  /** Root-relative path, validated with `resolveSafePath`. */
  path: string
  /** Required when `kind === 'selection'`. */
  selection?: string
}

export type AgentLaunchRequest = {
  agent: AgentId
  /** Required for `prompt` agents, optional for `session` ones. */
  prompt?: string
  /**
   * One of the ids `/api/agents` offered. Omitting it falls back on the CLI's
   * own configured model, which is what clients built before the picker do.
   */
  model?: string
  /** One of the levels the chosen model advertises. Omittable, same as above. */
  effort?: string
  target: AgentLaunchTarget
  /**
   * An opaque id the client mints *before* it sends the launch, which is what
   * makes the launch addressable before a single byte comes back: a client
   * whose stream dies mid-launch reattaches to it with
   * `GET /api/agents/launch/events`. At most 128 characters of `[A-Za-z0-9_-]`.
   * Omitting it is legal and is what clients built before resume do — they
   * simply cannot reattach.
   */
  launchId?: string
}

/** Why a launch failed when the client can offer a specific recovery action. */
export type AgentLaunchFailureReason = 'workspace-untrusted'

export type AgentLaunchResponse = {
  launched: true
  agent: AgentId
  /** Absolute directory the agent was spawned in. */
  cwd: string
  /** The cwd matched a project the agent already knows about. */
  reusedProject: boolean
  /** Claude: the live session's id. Codex: the app-server thread id. */
  sessionId?: string
  /** Where to pick the thread up on the phone, when the agent offers such a link. */
  url?: string
}

/**
 * What a launch is busy with right now.
 *
 * Only ever the phases the chosen agent actually has, never a fixed script:
 * Claude has to name a session before it can start one, so it reports `naming`
 * first and that is the bulk of the wait; Codex names its thread afterwards and
 * never reports `naming` at all. `linking` is the wait for a link the phone can
 * open, which is also the one phase allowed to time out without failing.
 */
export type AgentLaunchPhase = 'naming' | 'starting' | 'linking'

/**
 * What one NDJSON line of a streaming launch says, before the stream numbers
 * it. Requested with `Accept: application/x-ndjson`.
 *
 * A stream always ends in exactly one terminal event. `failed` carries the
 * status the plain-JSON route would have answered with, because by the time a
 * phase has gone out the response is already committed to 200 and the code can
 * no longer be said in the status line.
 */
export type AgentLaunchEventBody =
  | { event: 'phase'; phase: AgentLaunchPhase }
  | { event: 'launched'; result: AgentLaunchResponse }
  | {
      event: 'failed'
      error: string
      status: number
      reason?: AgentLaunchFailureReason
    }

/**
 * A launch event as it goes on the wire, numbered from 1 per launch.
 *
 * `seq` is what makes a dropped stream recoverable: a client reattaches with
 * `GET /api/agents/launch/events?id=&since=<highest seq seen>` and is sent the
 * rest, so an event with a `seq` it has already applied can simply be dropped
 * and a full replay is idempotent. A server built before resume sends no `seq`
 * at all, which is why a client must treat it as optional.
 */
export type AgentLaunchEvent = AgentLaunchEventBody & { seq: number }

/**
 * Transport-level keepalive, written every 15 s while a launch stream is open —
 * Cloudflare cuts an idle tunnel connection at 100 s and a cold start can run
 * well past that. Deliberately carries no `seq`: it is never buffered for
 * replay and never surfaced as a thread event.
 */
export type AgentLaunchHeartbeat = { event: 'heartbeat' }

/** Anything a launch stream may write, event or keepalive. */
export type AgentLaunchStreamLine = AgentLaunchEvent | AgentLaunchHeartbeat

/** An explicit request to grant the chosen agent trust for a launch target. */
export type AgentTrustRequest = {
  agent: AgentId
  target: Pick<AgentLaunchTarget, 'kind' | 'path'>
}

export type AgentTrustResponse = {
  trusted: true
  agent: AgentId
  /** Absolute directory that future launches for this target resolve to. */
  cwd: string
  /** False when the agent already trusted this exact directory. */
  changed: boolean
}

/** Where a skill was found: the agent's home config or the target project. */
export type AgentSkillSource = 'global' | 'project'

/**
 * One installed skill, as its `SKILL.md` frontmatter describes it. `name` is
 * what a prompt refers to it by, so it is what the client inserts and matches.
 */
export type AgentSkill = {
  name: string
  description: string
  source: AgentSkillSource
  /** Absolute path of the skill directory on the server, for display only. */
  path: string
}

export type AgentSkillsResponse = {
  agent: AgentId
  /**
   * The directory whose project skills were included, walked up to the git
   * root. Null when no `path` was asked about and only global skills are listed.
   */
  cwd: string | null
  /** Sorted by name; a project skill shadows a global one of the same name. */
  skills: AgentSkill[]
}

export type AgentStopRequest = {
  sessionId: string
}

export type AgentStopResponse = {
  stopped: boolean
}
