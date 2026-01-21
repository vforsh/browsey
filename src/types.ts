export type ServerOptions = {
  root: string
  port: number
  host: string
  open: boolean
  readonly: boolean
  showHidden: boolean
  showQR: boolean
  ignorePatterns: string[]
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
