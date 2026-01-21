import { resolve, relative, isAbsolute } from 'path'

export type SafePath = {
  relativePath: string
  fullPath: string
}

export function resolveSafePath(rootPath: string, requestPath: string): SafePath | null {
  if (requestPath.includes('\0')) {
    return null
  }

  const cleaned = requestPath.replace(/\\/g, '/')
  const normalized = cleaned.replace(/\/+/g, '/')
  const segments = normalized.split('/').filter(Boolean)

  if (segments.some((segment) => segment === '..')) {
    return null
  }

  const relativePath = segments.join('/')
  const fullPath = resolve(rootPath, relativePath)
  const rel = relative(rootPath, fullPath)

  if (rel.startsWith('..') || isAbsolute(rel)) {
    return null
  }

  return {
    relativePath,
    fullPath,
  }
}
