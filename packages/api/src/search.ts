import { randomUUID } from 'crypto'
import { constants } from 'fs'
import { promises as fs } from 'fs'
import { basename, join, relative, sep } from 'path'
import { getFileExtension, resolveSafePath, createIgnoreMatcher } from '@vforsh/browsey-shared'
import type { ApiRoutesOptions, IgnoreMatcher, SearchMode, SearchResponse, SearchResult } from '@vforsh/browsey-shared'
import { entryExtension, readSymlinkTarget } from './directory-listing.js'

type ContentMatch = { line: number; snippet: string }
type Candidate = {
  name: string; fullPath: string; path: string; type: 'file' | 'directory' | 'symlink'; score: number
  contentMatch?: ContentMatch
}
type Job = {
  id: string
  root: string
  realRoot: string
  searchRoot: string
  query: string
  queryLower: string
  mode: SearchMode
  hidden: boolean
  ignore: IgnoreMatcher
  candidates: Map<string, Candidate>
  results: Candidate[] | null
  controller: AbortController
  done: Promise<void>
  error: string | null
  skippedDirectories: number
  skippedLargeFiles: number
  skippedBinaryFiles: number
  skippedUnreadableFiles: number
  touched: number
}

const jobs = new Map<string, Job>()
const JOB_TTL_MS = 5 * 60_000
const SCAN_CONCURRENCY = 16
const CONTENT_CONCURRENCY = 4
const MAX_CONTENT_BYTES = 1024 * 1024

function expireJob(job: Job): void {
  const remaining = JOB_TTL_MS - (Date.now() - job.touched)
  if (remaining > 0) {
    setTimeout(() => expireJob(job), remaining).unref()
    return
  }
  job.controller.abort()
  jobs.delete(job.id)
}

function scoreName(name: string, pattern: string): number {
  if (!pattern || pattern.length > name.length) return 0
  const text = name.toLowerCase()
  if (text === pattern) return 4000
  if (text.startsWith(pattern)) return 3000 - text.length
  const substring = text.indexOf(pattern)
  if (substring !== -1) return 2000 - substring * 2 - text.length / 100
  let at = 0
  let score = 0
  let last = -2
  for (let i = 0; i < text.length && at < pattern.length; i++) {
    if (text[i] !== pattern[at]) continue
    score += i === last + 1 ? 3 : 1
    if (i === 0 || /[\s_.-]/.test(text[i - 1]!)) score += 3
    last = i
    at++
  }
  return at === pattern.length ? Math.min(score, 1000) : 0
}

function compareCandidates(a: Candidate, b: Candidate): number {
  return b.score - a.score || a.name.localeCompare(b.name) || a.path.localeCompare(b.path)
}

function candidateType(entry: { isSymbolicLink(): boolean; isDirectory(): boolean }): Candidate['type'] {
  if (entry.isSymbolicLink()) return 'symlink'
  if (entry.isDirectory()) return 'directory'
  return 'file'
}

function isOutsideRoot(relativePath: string): boolean {
  return relativePath === '..' || relativePath.startsWith(`..${sep}`) || relativePath.startsWith(sep)
}

function allowedPath(job: Job, fullPath: string): boolean {
  const rel = relative(job.searchRoot, fullPath)
  if (rel === '' || isOutsideRoot(rel)) return false
  return rel.split(sep).every((part) => (job.hidden || !part.startsWith('.')) && !job.ignore(part))
}

function addCandidate(job: Job, fullPath: string, type: Candidate['type']): void {
  if (!allowedPath(job, fullPath)) return
  const name = basename(fullPath)
  const score = scoreName(name, job.queryLower)
  if (!score) return
  const path = '/' + relative(job.searchRoot, fullPath).split(sep).join('/')
  job.candidates.set(path, { name, fullPath, path, type, score })
}

/** Spotlight supplies early matches on macOS. The filesystem walk remains authoritative. */
async function spotlight(job: Job): Promise<void> {
  if (job.mode !== 'name' || process.platform !== 'darwin' || job.query.length < 3) return
  const escaped = job.query.replace(/[\\"*]/g, '\\$&')
  try {
    const child = Bun.spawn(['/usr/bin/mdfind', '-onlyin', job.searchRoot, `kMDItemFSName == "*${escaped}*"cd`], {
      stdout: 'pipe', stderr: 'ignore',
    })
    job.controller.signal.addEventListener('abort', () => child.kill(), { once: true })
    if (!child.stdout || typeof child.stdout === 'number') return
    const output = await new Response(child.stdout).text()
    await child.exited
    if (job.controller.signal.aborted) return
    // mdfind canonicalizes paths. Map them back through the selected root's
    // real path so a served symlinked root still produces browseable paths.
    const realRoot = await fs.realpath(job.searchRoot)
    for (const found of output.split('\n')) {
      if (!found) continue
      const rel = relative(realRoot, found)
      if (isOutsideRoot(rel)) continue
      const servedPath = join(job.searchRoot, rel)
      if (!allowedPath(job, servedPath)) continue
      const stat = await fs.lstat(servedPath).catch(() => null)
      if (!stat) continue
      addCandidate(job, servedPath, candidateType(stat))
    }
  } catch {
    // An unavailable or stale Spotlight index only delays the first result.
  }
}

/** Read one regular UTF-8 file within the search budget, without following its final symlink. */
async function readSearchableText(job: Job, fullPath: string): Promise<string | null> {
  const file = await fs.open(fullPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile()) return null
    if (stat.size > MAX_CONTENT_BYTES) {
      job.skippedLargeFiles++
      return null
    }
    // One extra byte detects a file that grew during the scan without
    // allocating a full MiB for every small file.
    const bytes = Buffer.alloc(stat.size + 1)
    let bytesRead = 0
    while (bytesRead < bytes.length && !job.controller.signal.aborted) {
      const part = await file.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead)
      if (part.bytesRead === 0) break
      bytesRead += part.bytesRead
    }
    if (job.controller.signal.aborted) return null
    if (bytesRead > MAX_CONTENT_BYTES) {
      job.skippedLargeFiles++
      return null
    }
    if (bytesRead > stat.size) {
      job.skippedUnreadableFiles++
      return null
    }
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead))
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content)) {
      job.skippedBinaryFiles++
      return null
    }
    return content
  } finally {
    await file.close()
  }
}

function firstContentMatch(content: string, query: string, queryLower: string): ContentMatch | null {
  const index = content.toLowerCase().indexOf(queryLower)
  if (index < 0) return null
  const start = content.lastIndexOf('\n', index - 1) + 1
  const end = content.indexOf('\n', index)
  const lineEnd = end < 0 ? content.length : end
  const line = content.slice(start, lineEnd).replace(/\r$/, '').replace(/\t/g, ' ')
  const matchColumn = index - start
  const snippetStart = Math.max(0, matchColumn - 60)
  const snippetLength = Math.max(180, query.length + 80)
  const excerpt = line.slice(snippetStart, snippetStart + snippetLength).trimEnd()
  const before = snippetStart ? '…' : ''
  const after = snippetStart + snippetLength < line.length ? '…' : ''
  const lineNumber = content.slice(0, index).split('\n').length
  return { line: lineNumber, snippet: `${before}${excerpt}${after}` }
}

async function searchContentFile(job: Job, fullPath: string): Promise<void> {
  if (job.controller.signal.aborted) return
  try {
    const realPath = await fs.realpath(fullPath)
    if (isOutsideRoot(relative(job.realRoot, realPath))) return
    const content = await readSearchableText(job, fullPath)
    if (content === null || job.controller.signal.aborted) return
    const contentMatch = firstContentMatch(content, job.query, job.queryLower)
    if (!contentMatch) return
    const path = '/' + relative(job.searchRoot, fullPath).split(sep).join('/')
    job.candidates.set(path, {
      name: basename(fullPath), fullPath, path, type: 'file', score: 0, contentMatch,
    })
  } catch (error) {
    if (error instanceof TypeError) job.skippedBinaryFiles++ // Invalid UTF-8.
    else job.skippedUnreadableFiles++
  }
}

async function scan(job: Job): Promise<void> {
  const queue = [job.searchRoot]
  let nextDirectory = 0
  const active = new Set<Promise<void>>()
  const activeFiles = new Set<Promise<void>>()
  while ((nextDirectory < queue.length || active.size || activeFiles.size) && !job.controller.signal.aborted) {
    while (nextDirectory < queue.length && active.size < SCAN_CONCURRENCY && !job.controller.signal.aborted) {
      const dir = queue[nextDirectory++]!
      const work = (async () => {
        try {
          const entries = await fs.readdir(dir, { withFileTypes: true })
          for (const entry of entries) {
            if (job.controller.signal.aborted) return
            if ((!job.hidden && entry.name.startsWith('.')) || job.ignore(entry.name)) continue
            const isDirectory = entry.isDirectory()
            const nameMatches = job.mode === 'name' && scoreName(entry.name, job.queryLower) > 0
            const isContentFile = job.mode === 'content' && entry.isFile()
            if (!isDirectory && !nameMatches && !isContentFile) continue
            const fullPath = join(dir, entry.name)
            if (nameMatches) {
              addCandidate(job, fullPath, candidateType(entry))
            }
            if (isContentFile) {
              while (activeFiles.size >= CONTENT_CONCURRENCY && !job.controller.signal.aborted) {
                await Promise.race(activeFiles)
              }
              if (job.controller.signal.aborted) return
              const fileWork = searchContentFile(job, fullPath)
              activeFiles.add(fileWork)
              void fileWork.finally(() => activeFiles.delete(fileWork))
            }
            // Directory symlinks are search results, never traversal edges.
            // This avoids loops and leaving the served tree.
            if (isDirectory) queue.push(fullPath)
          }
        } catch {
          job.skippedDirectories++
        }
      })()
      active.add(work)
      void work.finally(() => active.delete(work))
    }
    if (active.size || activeFiles.size) await Promise.race([...active, ...activeFiles])
  }
}

function createJob(root: string, realRoot: string, searchRoot: string, query: string, mode: SearchMode, hidden: boolean, ignorePatterns: string[]): Job {
  const job: Job = {
    id: randomUUID(), root, realRoot, searchRoot, query, queryLower: query.toLowerCase(), mode, hidden,
    ignore: createIgnoreMatcher(ignorePatterns), candidates: new Map(), results: null,
    controller: new AbortController(), done: Promise.resolve(), error: null, touched: Date.now(),
    skippedDirectories: 0, skippedLargeFiles: 0, skippedBinaryFiles: 0, skippedUnreadableFiles: 0,
  }
  jobs.set(job.id, job)
  setTimeout(() => expireJob(job), JOB_TTL_MS).unref()
  job.done = Promise.all([spotlight(job), scan(job)]).then(() => {
    if (!job.controller.signal.aborted) {
      job.results = [...job.candidates.values()].sort(compareCandidates)
      job.candidates.clear()
    }
  }).catch((error: unknown) => { job.error = error instanceof Error ? error.message : 'Search failed' })
  return job
}

async function materialize(job: Job, candidate: Candidate): Promise<SearchResult> {
  const base = { name: candidate.name, path: candidate.path, absolutePath: candidate.fullPath, score: candidate.score }
  if (candidate.type === 'directory') return { ...base, type: 'directory', extension: null }
  if (candidate.type === 'file') return { ...base, type: 'file', extension: getFileExtension(candidate.name),
    ...(candidate.contentMatch ? { contentMatch: candidate.contentMatch } : {}) }
  try {
    const target = await readSymlinkTarget(job.root, candidate.fullPath)
    return { ...base, type: 'symlink', extension: entryExtension(candidate.name, target.targetType, false), ...target }
  } catch {
    return { ...base, type: 'file', extension: getFileExtension(candidate.name) }
  }
}

async function responseFor(job: Job, limit: number, cursor: number): Promise<Response> {
  job.touched = Date.now()
  if (job.error) return Response.json({ error: job.error }, { status: 500 })
  const complete = job.results !== null
  const ranked = job.results ?? [...job.candidates.values()].sort(compareCandidates)
  const page = ranked.slice(complete ? cursor : 0, complete ? cursor + limit : limit)
  const results = await Promise.all(page.map((candidate) => materialize(job, candidate)))
  const hasMore = complete && cursor + limit < ranked.length
  const response: SearchResponse = {
    query: job.query, mode: job.mode, results, status: complete ? 'complete' : 'searching', hasMore,
    nextCursor: hasMore ? String(cursor + limit) : null,
    jobId: job.id,
    skippedDirectories: job.skippedDirectories,
    skippedLargeFiles: job.skippedLargeFiles,
    skippedBinaryFiles: job.skippedBinaryFiles,
    skippedUnreadableFiles: job.skippedUnreadableFiles,
    hidden: job.hidden,
  }
  return Response.json(response)
}

function searchLimit(url: URL): number {
  return Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200)
}

export async function handleSearch(req: Request, url: URL, options: ApiRoutesOptions): Promise<Response> {
  const id = url.searchParams.get('jobId')
  if (id) {
    const job = jobs.get(id)
    if (!job) return Response.json({ error: 'Search expired; retry' }, { status: 404 })
    if (req.method === 'DELETE') {
      job.controller.abort()
      jobs.delete(id)
      return Response.json({ ok: true })
    }
    const limit = searchLimit(url)
    const cursor = Math.max(Number(url.searchParams.get('cursor')) || 0, 0)
    return responseFor(job, limit, cursor)
  }

  const mode = url.searchParams.get('mode') || 'name'
  if (mode !== 'name' && mode !== 'content') return Response.json({ error: 'Invalid search mode' }, { status: 400 })
  const query = (url.searchParams.get('q') || '').trim()
  if (mode === 'content' && query.length > 512) return Response.json({ error: 'Content query is too long' }, { status: 400 })
  if (!query) return Response.json({ query: '', results: [], status: 'complete', hasMore: false, nextCursor: null } satisfies SearchResponse)
  const requestPath = url.searchParams.get('path') || '/'
  const safePath = resolveSafePath(options.root, requestPath)
  if (!safePath) return Response.json({ error: 'Access denied: Invalid path' }, { status: 403 })
  const stat = await fs.stat(safePath.fullPath).catch(() => null)
  if (!stat) return Response.json({ error: 'Directory not found' }, { status: 404 })
  if (!stat.isDirectory()) return Response.json({ error: 'Search path is not a directory' }, { status: 400 })
  const [realRoot, realSearchRoot] = await Promise.all([fs.realpath(options.root), fs.realpath(safePath.fullPath)])
  const realRelative = relative(realRoot, realSearchRoot)
  if (isOutsideRoot(realRelative)) {
    return Response.json({ error: 'Access denied: Invalid path' }, { status: 403 })
  }
  const hidden = options.showHidden || url.searchParams.get('hidden') === '1'
  const limit = searchLimit(url)
  const job = createJob(options.root, realRoot, safePath.fullPath, query, mode, hidden, options.ignorePatterns)
  if (url.searchParams.get('progressive') !== '1') {
    req.signal.addEventListener('abort', () => job.controller.abort(), { once: true })
  }
  for (const [key, old] of jobs) {
    if (key !== job.id && Date.now() - old.touched > JOB_TTL_MS) {
      old.controller.abort()
      jobs.delete(key)
    }
  }
  if (url.searchParams.get('progressive') !== '1') await job.done
  return responseFor(job, limit, 0)
}
