export type ServerOptions = {
  root: string
  port: number
  host: string
  open: boolean
  readonly: boolean
  showHidden: boolean
  showQR: boolean
  bonjour: boolean
  ignorePatterns: string[]
  version: string
  https: boolean
  httpsCert?: string
  httpsKey?: string
  watch: boolean
}

export type FileItem = {
  name: string
  type: 'file' | 'directory'
  size: number
  modified: string
  extension: string | null
  absolutePath: string
}

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
  pid: number           // Process ID (primary identifier)
  port: number          // Listening port
  host: string          // Bound host (0.0.0.0, localhost, etc.)
  rootPath: string      // Absolute path being served
  startedAt: string     // ISO 8601 timestamp
  readonly: boolean     // Read-only mode flag
  bonjour: boolean      // Bonjour advertising enabled
  version: string       // Browsey version
}

export interface RegistryFile {
  version: 1            // Schema version for migrations
  instances: InstanceInfo[]
}

export type SearchResult = {
  name: string
  path: string           // Relative path from search root
  absolutePath: string
  type: 'file' | 'directory'
  score: number
  extension: string | null
}

export type SearchResponse = {
  query: string
  results: SearchResult[]
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

export type GitChangeFile = {
  path: string           // relative to repo root
  indexStatus: string    // 'M', 'A', 'D', 'R', '?', ' '
  workTreeStatus: string // 'M', 'D', '?', ' '
}

export type GitChangesResponse = {
  staged: GitChangeFile[]
  unstaged: GitChangeFile[]
  untracked: GitChangeFile[]
}
