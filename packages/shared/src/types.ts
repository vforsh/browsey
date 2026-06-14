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

export type ApiRoutesOptions = {
  root: string
  readonly: boolean
  showHidden: boolean
  ignorePatterns: string[]
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
