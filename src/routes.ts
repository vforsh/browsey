import { promises as fs } from 'fs'
import { basename, extname, join } from 'path'
import { getMimeType } from './utils/mime.js'
import { createIgnoreMatcher } from './ignore.js'
import { resolveSafePath } from './security.js'
import type { ApiRoutesOptions, FileItem, ListResponse } from './types.js'

const JSON_HEADERS = {
  'Content-Type': 'application/json',
}

function jsonResponse(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      ...JSON_HEADERS,
      ...(init?.headers ?? {}),
    },
  })
}

export async function handleApiRequest(
  req: Request,
  options: ApiRoutesOptions
): Promise<Response | null> {
  const url = new URL(req.url)
  if (!url.pathname.startsWith('/api/')) {
    return null
  }

  const route = url.pathname.slice('/api'.length)
  if (route === '/list') {
    return handleList(url, options)
  }
  if (route === '/file') {
    return handleFile(url, options)
  }
  if (route === '/stat') {
    return handleStat(url, options)
  }

  return jsonResponse({ error: 'Not found' }, { status: 404 })
}

async function handleList(url: URL, options: ApiRoutesOptions): Promise<Response> {
  const requestPath = url.searchParams.get('path') || '/'
  const safePath = resolveSafePath(options.root, requestPath)

  if (!safePath) {
    return jsonResponse({ error: 'Access denied: Invalid path' }, { status: 403 })
  }

  try {
    const stat = await fs.stat(safePath.fullPath)
    if (!stat.isDirectory()) {
      return jsonResponse({ error: 'Path is not a directory' }, { status: 400 })
    }

    const entries = await fs.readdir(safePath.fullPath, { withFileTypes: true })
    const ignore = createIgnoreMatcher(options.ignorePatterns)
    const items: FileItem[] = []

    for (const entry of entries) {
      if (!options.showHidden && entry.name.startsWith('.')) {
        continue
      }

      if (ignore(entry.name)) {
        continue
      }

      const entryPath = join(safePath.fullPath, entry.name)
      try {
        const entryStat = await fs.stat(entryPath)
        items.push({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file',
          size: entryStat.size,
          modified: entryStat.mtime.toISOString(),
          extension: entry.isFile() ? extname(entry.name).slice(1) || null : null,
          absolutePath: entryPath,
        })
      } catch {
        // Skip entries we can't stat
      }
    }

    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })

    const response: ListResponse = {
      path: safePath.relativePath ? `/${safePath.relativePath}` : '/',
      items,
    }

    return jsonResponse(response)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return jsonResponse({ error: 'Directory not found' }, { status: 404 })
    }
    if (code === 'EACCES') {
      return jsonResponse({ error: 'Permission denied' }, { status: 403 })
    }
    return jsonResponse({ error: 'Internal server error' }, { status: 500 })
  }
}

async function handleFile(url: URL, options: ApiRoutesOptions): Promise<Response> {
  const requestPath = url.searchParams.get('path')
  if (!requestPath) {
    return jsonResponse({ error: 'Path required' }, { status: 400 })
  }

  const safePath = resolveSafePath(options.root, requestPath)
  if (!safePath) {
    return jsonResponse({ error: 'Access denied: Invalid path' }, { status: 403 })
  }

  try {
    const stat = await fs.stat(safePath.fullPath)
    if (stat.isDirectory()) {
      return jsonResponse({ error: 'Cannot download directory' }, { status: 400 })
    }

    const filename = basename(safePath.fullPath)
    const file = Bun.file(safePath.fullPath)

    return new Response(file, {
      headers: {
        'Content-Type': getMimeType(safePath.fullPath),
        'Content-Length': stat.size.toString(),
        'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
      },
    })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return jsonResponse({ error: 'File not found' }, { status: 404 })
    }
    if (code === 'EACCES') {
      return jsonResponse({ error: 'Permission denied' }, { status: 403 })
    }
    return jsonResponse({ error: 'Internal server error' }, { status: 500 })
  }
}

async function handleStat(url: URL, options: ApiRoutesOptions): Promise<Response> {
  const requestPath = url.searchParams.get('path')
  if (!requestPath) {
    return jsonResponse({ error: 'Path required' }, { status: 400 })
  }

  const safePath = resolveSafePath(options.root, requestPath)
  if (!safePath) {
    return jsonResponse({ error: 'Access denied: Invalid path' }, { status: 403 })
  }

  try {
    const stat = await fs.stat(safePath.fullPath)

    return jsonResponse({
      name: basename(safePath.fullPath),
      type: stat.isDirectory() ? 'directory' : 'file',
      size: stat.size,
      modified: stat.mtime.toISOString(),
      created: stat.birthtime.toISOString(),
      extension: stat.isFile() ? extname(safePath.fullPath).slice(1) || null : null,
    })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return jsonResponse({ error: 'Path not found' }, { status: 404 })
    }
    if (code === 'EACCES') {
      return jsonResponse({ error: 'Permission denied' }, { status: 403 })
    }
    return jsonResponse({ error: 'Internal server error' }, { status: 500 })
  }
}
