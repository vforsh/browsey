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
