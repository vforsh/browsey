export type ApiServerOptions = {
  root: string
  port: number
  host: string
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
  corsOrigin: string
}

export type AppServerOptions = {
  port: number
  host: string
  apiUrl: string
  showQR: boolean
  version: string
  https: boolean
  httpsCert?: string
  httpsKey?: string
  open: boolean
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
  pid: number
  port: number
  host: string
  kind: 'api' | 'app'
  rootPath: string      // For api: directory being served. For app: not used
  apiUrl?: string       // For app: the --api URL
  startedAt: string
  readonly: boolean
  bonjour: boolean
  version: string
}

export interface RegistryFile {
  version: 1
  instances: InstanceInfo[]
}

export type SearchResult = {
  name: string
  path: string
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
  path: string
  indexStatus: string
  workTreeStatus: string
}

export type GitChangesResponse = {
  staged: GitChangeFile[]
  unstaged: GitChangeFile[]
  untracked: GitChangeFile[]
}
