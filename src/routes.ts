import { promises as fs } from 'fs'
import { basename, extname, join } from 'path'
import { getMimeType } from './utils/mime.js'
import { createIgnoreMatcher } from './ignore.js'
import { resolveSafePath } from './security.js'
import type { ApiRoutesOptions, FileItem, ListResponse } from './types.js'

const JSON_HEADERS = {
  'Content-Type': 'application/json',
}

// File extensions that can be viewed in the browser
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
  'html', 'htm', 'css', 'scss', 'sass', 'less',
  'xml', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'py', 'rb', 'php', 'pl', 'pm', 'lua', 'r', 'R',
  'go', 'rs', 'java', 'kt', 'kts', 'scala', 'clj', 'cljs',
  'c', 'cpp', 'cc', 'cxx', 'h', 'hpp', 'hxx', 'cs', 'fs', 'fsx',
  'swift', 'mm', 'm', 'zig', 'nim', 'v', 'odin',
  'sql', 'graphql', 'gql',
  'env', 'envrc', 'gitignore', 'gitattributes', 'dockerignore', 'editorconfig',
  'dockerfile', 'makefile', 'cmake', 'gradle', 'properties',
  'log', 'diff', 'patch',
  'vue', 'svelte', 'astro',
])

const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif',
])

// Max file size for viewing (5MB for text, 20MB for images)
const MAX_TEXT_SIZE = 5 * 1024 * 1024
const MAX_IMAGE_SIZE = 20 * 1024 * 1024

type ViewableType = 'text' | 'image' | null

function getViewableType(extension: string | null, size: number): ViewableType {
  if (!extension) return null
  const ext = extension.toLowerCase()

  if (TEXT_EXTENSIONS.has(ext) && size <= MAX_TEXT_SIZE) {
    return 'text'
  }
  if (IMAGE_EXTENSIONS.has(ext) && size <= MAX_IMAGE_SIZE) {
    return 'image'
  }
  return null
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
  if (route === '/view') {
    return handleView(url, options)
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

  const download = url.searchParams.get('download') !== 'false'

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

    const headers: Record<string, string> = {
      'Content-Type': getMimeType(safePath.fullPath),
      'Content-Length': stat.size.toString(),
    }

    if (download) {
      headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(filename)}"`
    }

    return new Response(file, { headers })
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

async function handleView(url: URL, options: ApiRoutesOptions): Promise<Response> {
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
      return jsonResponse({ error: 'Cannot view directory' }, { status: 400 })
    }

    const extension = extname(safePath.fullPath).slice(1) || null
    const viewableType = getViewableType(extension, stat.size)

    if (!viewableType) {
      return jsonResponse({ error: 'File type not viewable' }, { status: 400 })
    }

    const filename = basename(safePath.fullPath)

    if (viewableType === 'text') {
      const content = await fs.readFile(safePath.fullPath, 'utf-8')
      return jsonResponse({
        type: 'text',
        filename,
        extension,
        content,
        size: stat.size,
      })
    }

    // For images, return the URL to fetch the image directly (inline, not download)
    return jsonResponse({
      type: 'image',
      filename,
      extension,
      url: `/api/file?path=${encodeURIComponent(requestPath)}&download=false`,
      size: stat.size,
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
