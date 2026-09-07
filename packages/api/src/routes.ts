import { promises as fs } from 'fs'
import { createHash, randomUUID } from 'crypto'
import os from 'os'
import { basename, dirname, extname, join, relative } from 'path'
import {
  getMimeType,
  getFileExtension,
  resolveSafePath,
  createIgnoreMatcher,
  extractToken,
  validateToken,
  unauthorizedResponse,
} from '@vforsh/browsey-shared'
import type { IgnoreMatcher } from '@vforsh/browsey-shared'
import { findGitRoot, getGitStatus, getGitLog, getGitCommit, getGitChanges, revertGitFile, GitOperationError } from './git.js'
import { entryExtension, readDirectoryItems, readSymlinkTarget, toServedPath } from './directory-listing.js'
import { conditionalJsonResponse } from './conditional.js'
import {
  AgentLaunchError,
  buildThreadPrompt,
  getAgentCapabilities,
  isAgentId,
  refreshAgentModels,
  resolveThreadCwd,
  spawnAgentThread,
  trustAgentWorkspace,
  validateLaunchRequest,
} from './agents.js'
import type { CapabilitiesTarget } from './agents.js'
import {
  appendLaunchEvent,
  eventsSince,
  getLaunch,
  isTerminalLaunchEvent,
  isValidLaunchId,
  registerLaunch,
  subscribeToLaunch,
} from './launch-registry.js'
import type { LaunchEntry } from './launch-registry.js'
import { listAgentSkills, skillLookupDir } from './agent-skills.js'
import { stopClaudeSession } from './claude-remote-control.js'
import type { ApiRoutesOptions, FileItem, ListResponse, SyncManifestDirectory, SyncManifestResponse, SearchResult, SearchResponse, GitStatusResponse, GitLogResponse, GitCommitResponse, GitCommitFile, GitChangesResponse, GitRevertResponse, HealthResponse, ViewResponse, SaveTextResponse, AgentLaunchEvent, AgentLaunchEventBody, AgentLaunchFailureReason, AgentLaunchRequest, AgentLaunchResponse, AgentLaunchStreamLine, AgentStopRequest, AgentStopResponse, AgentTrustRequest, AgentTrustResponse } from '@vforsh/browsey-shared'

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
  'ejs', 'erb', 'hbs', 'handlebars', 'mustache', 'pug', 'jade', 'njk', 'jinja', 'jinja2', 'twig',
])

const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif',
])

const VIDEO_EXTENSIONS = new Set([
  'mp4', 'mov', 'webm',
])

// Max file size for viewing (5MB for text, 20MB for images; videos stream via /api/file)
const MAX_TEXT_SIZE = 5 * 1024 * 1024
const MAX_IMAGE_SIZE = 20 * 1024 * 1024

type ViewableType = 'text' | 'image' | 'video' | null

type ByteRange = {
  start: number
  end: number
}

type SaveTextBody = {
  path?: unknown
  content?: unknown
  baseModified?: unknown
  baseSize?: unknown
}

function getViewableType(extension: string | null, size: number): ViewableType {
  if (!extension) return null
  const ext = extension.toLowerCase()

  if (TEXT_EXTENSIONS.has(ext) && size <= MAX_TEXT_SIZE) {
    return 'text'
  }
  if (IMAGE_EXTENSIONS.has(ext) && size <= MAX_IMAGE_SIZE) {
    return 'image'
  }
  if (VIDEO_EXTENSIONS.has(ext)) {
    return 'video'
  }
  return null
}

function parseByteRange(rangeHeader: string | null, size: number): ByteRange | null | 'invalid' {
  if (!rangeHeader) return null
  if (size <= 0) return 'invalid'

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
  if (!match) return 'invalid'

  const [, startRaw, endRaw] = match
  if (!startRaw && !endRaw) return 'invalid'

  if (!startRaw) {
    const suffixLength = Number(endRaw)
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return 'invalid'
    return {
      start: Math.max(size - suffixLength, 0),
      end: size - 1,
    }
  }

  const start = Number(startRaw)
  const requestedEnd = endRaw ? Number(endRaw) : size - 1
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= size
  ) {
    return 'invalid'
  }

  return {
    start,
    end: Math.min(requestedEnd, size - 1),
  }
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

function isTextEditable(extension: string | null): boolean {
  return extension !== null && TEXT_EXTENSIONS.has(extension.toLowerCase())
}

async function writeTextFileAtomically(filePath: string, content: string, mode: number): Promise<void> {
  const dir = dirname(filePath)
  const name = basename(filePath)
  const tempPath = join(dir, `.${name}.browsey-${process.pid}-${randomUUID()}.tmp`)

  try {
    await fs.writeFile(tempPath, content, { encoding: 'utf-8', mode })
    await fs.rename(tempPath, filePath)
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
}

function getHealthResponse(readonly: boolean, serverId?: string): HealthResponse {
  const runtime = typeof Bun !== 'undefined' ? 'bun' : 'node'
  const runtimeVersion = runtime === 'bun' ? Bun.version : process.version

  return {
    ok: true,
    ...(serverId ? { serverId } : {}),
    readonly,
    host: {
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      runtime,
      runtimeVersion,
      uptimeSeconds: Math.floor(process.uptime()),
    },
  }
}

function joinServedPath(basePath: string, filePath: string): string {
  const normalizedBase = basePath.replace(/\/$/, '')
  const normalizedFile = filePath.replace(/^\/+/, '')
  return `${normalizedBase || ''}/${normalizedFile}`
}

async function withWorkingTreePaths(
  files: GitCommitFile[],
  repoPath: string | null,
  root: string
): Promise<GitCommitFile[]> {
  if (!repoPath) return files

  return Promise.all(files.map(async (file) => {
    const workingTreePath = joinServedPath(repoPath, file.path)
    const safeFilePath = resolveSafePath(root, workingTreePath)
    if (!safeFilePath) return file

    try {
      await fs.access(safeFilePath.fullPath)
      return { ...file, workingTreePath }
    } catch {
      return file
    }
  }))
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

  if (route === '/health') {
    return jsonResponse(getHealthResponse(options.readonly, options.serverId))
  }
  if (route === '/list') {
    return handleList(req, url, options)
  }
  if (route === '/sync/manifest') {
    return handleSyncManifest(url, options)
  }
  if (route === '/file') {
    return handleFile(req, url, options)
  }
  if (route === '/view') {
    return handleView(req, url, options)
  }
  if (route === '/stat') {
    return handleStat(url, options)
  }
  if (route === '/search') {
    return handleSearch(url, options)
  }
  if (route === '/git') {
    return handleGit(url, options)
  }
  if (route === '/git/log') {
    return handleGitLog(url, options)
  }
  if (route === '/git/commit') {
    return handleGitCommit(url, options)
  }
  if (route === '/git/changes') {
    return handleGitChanges(url, options)
  }
  if (route === '/git/revert' && req.method === 'POST') {
    return handleGitRevert(req, options)
  }
  if (route === '/save' && req.method === 'POST') {
    return handleSaveText(req, options)
  }
  if (route === '/rename' && req.method === 'POST') {
    return handleRename(req, options)
  }
  if (route === '/delete' && req.method === 'POST') {
    return handleDelete(req, options)
  }
  if (route === '/move' && req.method === 'POST') {
    return handleMove(req, options)
  }
  if (route === '/copy' && req.method === 'POST') {
    return handleCopy(req, options)
  }
  if (route === '/agents' || route.startsWith('/agents/')) {
    return handleAgentRoute(req, route, url, options)
  }

  return jsonResponse({ error: 'Not found' }, { status: 404 })
}

/**
 * Agent routes are gated by their own flag plus a bearer token — `readonly`
 * deliberately does not apply, since it protects Browsey's own file mutations
 * while agents run under their own opt-in.
 */
async function handleAgentRoute(
  req: Request,
  route: string,
  url: URL,
  options: ApiRoutesOptions
): Promise<Response> {
  if (!options.agents.enabled) {
    return jsonResponse({ error: 'Agent endpoints are disabled' }, { status: 404 })
  }
  if (!validateToken(extractToken(req), options.agents.token)) {
    return unauthorizedResponse()
  }

  if (route === '/agents' && req.method === 'GET') {
    return handleAgentCapabilities(req, options)
  }
  if (route === '/agents/models/refresh' && req.method === 'POST') {
    return handleAgentModelRefresh(req, options)
  }
  if (route === '/agents/skills' && req.method === 'GET') {
    return handleAgentSkills(req, options)
  }
  if (route === '/agents/launch' && req.method === 'POST') {
    return handleAgentLaunch(req, options)
  }
  if (route === '/agents/launch/events' && req.method === 'GET') {
    return handleAgentLaunchEvents(url)
  }
  if (route === '/agents/trust' && req.method === 'POST') {
    return handleAgentTrust(req, options)
  }
  if (route === '/agents/stop' && req.method === 'POST') {
    return handleAgentStop(req)
  }

  return jsonResponse({ error: 'Not found' }, { status: 404 })
}

/**
 * `path` is optional and only sharpens the answer: given one, every agent also
 * reports the cwd a launch would land in, which is what lets the client notice
 * that a session is already open there. An unusable path is ignored rather than
 * rejected — the capabilities list is still worth returning.
 */
async function handleAgentCapabilities(
  req: Request,
  options: ApiRoutesOptions
): Promise<Response> {
  const requestPath = new URL(req.url).searchParams.get('path')
  return jsonResponse(await getAgentCapabilities(await readCapabilitiesTarget(requestPath, options)))
}

/**
 * The skills a prompt for `path` may name. `agent` is required because the two
 * CLIs read different folders; `path` is optional and, as on the capabilities
 * read, an unusable one is ignored rather than rejected — the global skills are
 * still worth listing.
 */
async function handleAgentSkills(req: Request, options: ApiRoutesOptions): Promise<Response> {
  const url = new URL(req.url)
  const agent = url.searchParams.get('agent')
  if (!isAgentId(agent)) {
    return jsonResponse({ error: 'agent must be claude-code or codex' }, { status: 400 })
  }
  const target = await readCapabilitiesTarget(url.searchParams.get('path'), options)
  const lookupDir = target ? skillLookupDir(target.absPath, target.isDirectory) : null
  return jsonResponse(await listAgentSkills(agent, lookupDir))
}

/** Shared by the capabilities read and the refresh that answers with one. */
async function readCapabilitiesTarget(
  requestPath: string | null | undefined,
  options: ApiRoutesOptions
): Promise<CapabilitiesTarget | undefined> {
  if (!requestPath) return undefined

  const safePath = resolveSafePath(options.root, requestPath)
  if (!safePath) return undefined

  try {
    const stat = await fs.stat(safePath.fullPath)
    return { absPath: safePath.fullPath, isDirectory: stat.isDirectory() }
  } catch {
    // Path vanished between listing and asking; answer without it.
    return undefined
  }
}

/**
 * Re-reads the model lists and answers with the capabilities that result, so a
 * client updates from one round trip instead of having to sequence a refresh
 * against a fetch.
 *
 * A failure is reported rather than swallowed, because the caller is a person
 * who pressed a button and "nothing new" has to be distinguishable from "could
 * not look". The lists stay usable either way: a failed refresh leaves the last
 * good answer in place, or the curated one.
 */
async function handleAgentModelRefresh(
  req: Request,
  options: ApiRoutesOptions
): Promise<Response> {
  // `path` plays the same part it does on the GET, and is just as optional — a
  // body-less refresh is a valid request for "the list, wherever I am".
  let body: unknown
  try {
    body = await req.json()
  } catch {
    body = {}
  }
  const { path } = (body ?? {}) as { path?: unknown }

  try {
    await refreshAgentModels()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return jsonResponse({ error: `Could not refresh the model list: ${message}` }, { status: 502 })
  }

  const target = await readCapabilitiesTarget(typeof path === 'string' ? path : null, options)
  return jsonResponse(await getAgentCapabilities(target))
}

async function handleAgentStop(req: Request): Promise<Response> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { sessionId } = (body ?? {}) as Partial<AgentStopRequest>
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return jsonResponse({ error: 'sessionId is required' }, { status: 400 })
  }

  const response: AgentStopResponse = { stopped: stopClaudeSession(sessionId) }
  return jsonResponse(response)
}

/**
 * Trust is deliberately its own authenticated action, never a launch side
 * effect. The cwd is resolved exactly as launch resolves it, so the affirmative
 * choice applies to the folder Claude will actually enter rather than merely
 * the item the user long-pressed.
 */
async function handleAgentTrust(req: Request, options: ApiRoutesOptions): Promise<Response> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { agent, target } = (body ?? {}) as Partial<AgentTrustRequest>
  if (agent !== 'claude-code' && agent !== 'codex') {
    return jsonResponse({ error: 'Unknown agent' }, { status: 400 })
  }
  if (!target || typeof target !== 'object') {
    return jsonResponse({ error: 'target is required' }, { status: 400 })
  }
  if (
    target.kind !== 'directory' &&
    target.kind !== 'file' &&
    target.kind !== 'selection'
  ) {
    return jsonResponse({ error: 'target.kind must be directory, file or selection' }, { status: 400 })
  }
  if (typeof target.path !== 'string') {
    return jsonResponse({ error: 'target.path is required' }, { status: 400 })
  }

  const safePath = resolveSafePath(options.root, target.path)
  if (!safePath) return jsonResponse({ error: 'Access denied: Invalid path' }, { status: 403 })

  let stat: Awaited<ReturnType<typeof fs.stat>>
  try {
    stat = await fs.stat(safePath.fullPath)
  } catch {
    return jsonResponse({ error: 'Target path not found' }, { status: 404 })
  }
  if (target.kind === 'directory' && !stat.isDirectory()) {
    return jsonResponse({ error: 'Target path is not a directory' }, { status: 400 })
  }
  if (target.kind !== 'directory' && stat.isDirectory()) {
    return jsonResponse({ error: 'Target path is not a file' }, { status: 400 })
  }

  try {
    const { cwd } = await resolveThreadCwd(safePath.fullPath, stat.isDirectory(), agent)
    const { changed } = await trustAgentWorkspace(agent, cwd)
    const response: AgentTrustResponse = { trusted: true, agent, cwd, changed }
    return jsonResponse(response)
  } catch (error) {
    return launchErrorResponse(error)
  }
}

/** Everything a launch needs, once the request has been found sound. */
type LaunchPlan = Parameters<typeof spawnAgentThread>[0] & { reused: boolean }

/**
 * Media type that turns a launch from one JSON object into a stream of them.
 * Negotiated rather than given its own route: the work and the result are
 * identical either way, only the delivery differs, and a second route would be a
 * second copy of the validation below.
 */
const LAUNCH_STREAM_MIME = 'application/x-ndjson'

/**
 * Validates a launch and resolves where it would land, without starting it.
 *
 * Split out because it is the half that can still fail properly: everything here
 * answers with a real status code, whereas anything that goes wrong after the
 * agent is spawning has to be reported inside an already-200 stream.
 */
async function planLaunch(
  body: unknown,
  options: ApiRoutesOptions
): Promise<{ plan: LaunchPlan } | { failure: LaunchFailure }> {
  /** A launch that never started, so it can still be refused with a status. */
  const reject = (message: string, status: number) => ({
    failure: { error: message, status },
  })

  try {
    const { agent, prompt, model, effort, target } = validateLaunchRequest(body)

    // The target still has to sit inside the served root even though the
    // resolved cwd may legitimately land above it.
    const safePath = resolveSafePath(options.root, target.path)
    if (!safePath) {
      return reject('Access denied: Invalid path', 403)
    }

    let stat: Awaited<ReturnType<typeof fs.stat>>
    try {
      stat = await fs.stat(safePath.fullPath)
    } catch {
      return reject('Target path not found', 404)
    }
    if (target.kind === 'directory' && !stat.isDirectory()) {
      return reject('Target path is not a directory', 400)
    }
    if (target.kind !== 'directory' && stat.isDirectory()) {
      return reject('Target path is not a file', 400)
    }

    const { cwd, reused } = await resolveThreadCwd(safePath.fullPath, stat.isDirectory(), agent)
    const finalPrompt = buildThreadPrompt({
      kind: target.kind,
      prompt,
      cwd,
      targetAbs: safePath.fullPath,
      selection: target.selection,
    })

    return { plan: { agent, cwd, prompt, finalPrompt, model, effort, reused } }
  } catch (error) {
    return { failure: launchFailure(error) }
  }
}

/** A refusal, said the same way whether it lands in a status line or a stream. */
type LaunchFailure = {
  error: string
  status: number
  reason?: AgentLaunchFailureReason
}

/**
 * How a launch failure reads, before it is decided whether that goes in the
 * status line or in the stream. Only `AgentLaunchError` is trusted to describe
 * itself; anything else is a bug and says nothing.
 */
function launchFailure(error: unknown): LaunchFailure {
  if (error instanceof AgentLaunchError) {
    return {
      error: error.message,
      status: error.status,
      ...(error.reason ? { reason: error.reason } : {}),
    }
  }
  return { error: 'Internal server error', status: 500 }
}

function launchErrorResponse(error: unknown): Response {
  const { error: message, status } = launchFailure(error)
  return jsonResponse({ error: message }, { status })
}

function launchResult(plan: LaunchPlan, sessionId?: string, url?: string): AgentLaunchResponse {
  return {
    launched: true,
    agent: plan.agent,
    cwd: plan.cwd,
    reusedProject: plan.reused,
    ...(sessionId ? { sessionId } : {}),
    ...(url ? { url } : {}),
  }
}

const launchEncoder = new TextEncoder()

/**
 * The single place a launch line becomes bytes. Replay goes through it too, so
 * an event a reattaching client receives is byte for byte the one it missed.
 */
function encodeLaunchLine(line: AgentLaunchStreamLine): Uint8Array {
  return launchEncoder.encode(`${JSON.stringify(line)}\n`)
}

/** Cloudflare cuts an idle tunnel connection at 100 s; a cold start can outlast it. */
const LAUNCH_HEARTBEAT_MS = 15_000

const launchStreamHeaders = {
  'Content-Type': LAUNCH_STREAM_MIME,
  'Cache-Control': 'no-store',
}

/**
 * Echoes the id a registered launch can be reattached by.
 *
 * A `seq` on the wire already proves the server speaks this protocol, but only
 * once an event has arrived — and the drop worth chasing hardest is the one
 * that happens before the first byte, where the client has a launch it cannot
 * name and the agent is already spawning. The header lands with the response
 * headers, so it is there even when the body never is.
 */
function launchHeaders(entry: LaunchEntry | null): Record<string, string> {
  return entry
    ? { ...launchStreamHeaders, 'X-Browsey-Launch-Id': entry.id }
    : launchStreamHeaders
}

/**
 * A writer onto a launch stream that has stopped caring whether anyone is
 * listening: a client that navigated away (or a tunnel that dropped) leaves
 * nothing to write to, and the launch itself is deliberately allowed to finish
 * regardless — the session it started is real whether or not anyone heard about
 * it, which is exactly why the registry keeps the events.
 */
function launchWriter(controller: ReadableStreamDefaultController<Uint8Array>) {
  let open = true
  const write = (line: AgentLaunchStreamLine) => {
    if (!open) return
    try {
      controller.enqueue(encodeLaunchLine(line))
    } catch {
      open = false
    }
  }

  const heartbeat = setInterval(() => write({ event: 'heartbeat' }), LAUNCH_HEARTBEAT_MS)
  const stop = () => {
    clearInterval(heartbeat)
    open = false
  }

  return {
    write,
    /** Ends the stream, if it is still there to end. Safe to call twice. */
    close: () => {
      const wasOpen = open
      stop()
      if (wasOpen) {
        try {
          controller.close()
        } catch {
          // Already torn down by the runtime; nothing left to do.
        }
      }
    },
    /** The consumer went away: drop the timer, leave the launch running. */
    abandon: stop,
  }
}

/**
 * Runs the launch, reporting each phase as its own NDJSON line so a client can
 * narrate a wait that is mostly one slow step. Exactly one terminal event is
 * written, and the response is committed to 200 the moment the first line goes
 * out — which is why a failure is an event here rather than a status.
 *
 * Every event is numbered and, when the client minted a `launchId`, buffered in
 * the registry — a launch whose stream dies is resumed rather than lost.
 */
function streamLaunch(plan: LaunchPlan, entry: LaunchEntry | null): Response {
  let writer: ReturnType<typeof launchWriter> | null = null

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const out = launchWriter(controller)
      writer = out

      // Numbering is the stream's job either way; only the buffering needs an
      // entry, which is why an older client without a `launchId` still gets a
      // `seq` — it simply has nothing to reattach to.
      let localSeq = 0
      const send = (body: AgentLaunchEventBody) => {
        const event = entry
          ? appendLaunchEvent(entry, body)
          : ({ ...body, seq: ++localSeq } as AgentLaunchEvent)
        out.write(event)
      }

      try {
        const { sessionId, url } = await spawnAgentThread({
          ...plan,
          onPhase: (phase) => send({ event: 'phase', phase }),
        })
        send({ event: 'launched', result: launchResult(plan, sessionId, url) })
      } catch (error) {
        send({ event: 'failed', ...launchFailure(error) })
      } finally {
        out.close()
      }
    },
    cancel() {
      // Nothing to unwind: the spawn is fire-and-forget by design. Only the
      // heartbeat has to go, or it ticks against a stream nobody holds.
      writer?.abandon()
    },
  })

  return new Response(stream, { headers: launchHeaders(entry) })
}

/**
 * Replays what a launch has already said, then follows it live until it ends.
 *
 * This is the whole point of the registry: the terminal event is the only place
 * a `sessionId` and a deep link ever appear, so a client that lost its POST
 * stream comes back here with the highest `seq` it applied and picks up exactly
 * where it stopped. A launch that has already finished replays and closes at
 * once.
 */
function streamReattach(entry: LaunchEntry, since: number): Response {
  let detach: (() => void) | null = null
  let writer: ReturnType<typeof launchWriter> | null = null

  const stream = new ReadableStream<Uint8Array>({
    // Deliberately synchronous: nothing may be appended between the replay and
    // the subscription, or the event that landed in the gap is lost.
    start(controller) {
      const out = launchWriter(controller)
      writer = out

      for (const event of eventsSince(entry, since)) out.write(event)

      if (entry.done) {
        out.close()
        return
      }

      detach = subscribeToLaunch(entry, (event) => {
        out.write(event)
        if (isTerminalLaunchEvent(event)) {
          detach?.()
          detach = null
          out.close()
        }
      })
    },
    cancel() {
      detach?.()
      detach = null
      writer?.abandon()
    },
  })

  return new Response(stream, { headers: launchStreamHeaders })
}

/**
 * The client's own id for this launch, if it minted one.
 *
 * Validated here rather than in `validateLaunchRequest` because the registry
 * owns what an id may look like, and because this has to be read before the
 * rest of the body is trusted at all.
 */
function readLaunchId(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const { launchId } = body as Partial<AgentLaunchRequest>
  if (launchId === undefined || launchId === null) return null
  if (typeof launchId !== 'string' || !isValidLaunchId(launchId)) {
    throw new AgentLaunchError(400, 'launchId must be 1-128 characters of [A-Za-z0-9_-]')
  }
  return launchId
}

async function handleAgentLaunch(req: Request, options: ApiRoutesOptions): Promise<Response> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, { status: 400 })
  }

  let launchId: string | null
  try {
    launchId = readLaunchId(body)
  } catch (error) {
    return launchErrorResponse(error)
  }

  // Registered before the request is validated, so a client that drops and
  // comes back a moment later always finds the id it minted — and so a retry of
  // a launch already running reattaches instead of starting a second agent.
  let entry: LaunchEntry | null = null
  if (launchId) {
    const registered = registerLaunch(launchId)
    if (!registered.created) return streamReattach(registered.entry, 0)
    entry = registered.entry
  }

  const planned = await planLaunch(body, options)
  if ('failure' in planned) {
    // The refusal goes in the status line as it always has, and into the entry
    // as well: an id that was registered must never be left hanging with a
    // reattach that would wait forever for a launch that never started.
    if (entry) appendLaunchEvent(entry, { event: 'failed', ...planned.failure })
    return jsonResponse({ error: planned.failure.error }, { status: planned.failure.status })
  }

  if ((req.headers.get('accept') ?? '').includes(LAUNCH_STREAM_MIME)) {
    return streamLaunch(planned.plan, entry)
  }

  try {
    const { sessionId, url } = await spawnAgentThread(planned.plan)
    const result = launchResult(planned.plan, sessionId, url)
    if (entry) appendLaunchEvent(entry, { event: 'launched', result })
    return jsonResponse(result)
  } catch (error) {
    const failure = launchFailure(error)
    if (entry) appendLaunchEvent(entry, { event: 'failed', ...failure })
    return jsonResponse({ error: failure.error }, { status: failure.status })
  }
}

/**
 * Reattach to a launch already in flight. A GET, not a re-POST, so there is no
 * request body that could be mistaken for a second launch.
 */
function handleAgentLaunchEvents(url: URL): Response {
  const id = url.searchParams.get('id') ?? ''
  const entry = id && isValidLaunchId(id) ? getLaunch(id) : null
  if (!entry) {
    return jsonResponse({ error: 'Unknown launch' }, { status: 404 })
  }

  // A junk `since` replays everything, which is the safe direction: the client
  // drops events it has already applied.
  const since = Number.parseInt(url.searchParams.get('since') ?? '', 10)
  return streamReattach(entry, Number.isFinite(since) && since > 0 ? since : 0)
}

async function handleList(req: Request, url: URL, options: ApiRoutesOptions): Promise<Response> {
  const requestPath = url.searchParams.get('path') || '/'
  // Allow client to override showHidden via query param (only to show, not to hide if server allows)
  const showHiddenParam = url.searchParams.get('hidden')
  const showHidden = showHiddenParam === '1' || options.showHidden

  const safePath = resolveSafePath(options.root, requestPath)

  if (!safePath) {
    return jsonResponse({ error: 'Access denied: Invalid path' }, { status: 403 })
  }

  try {
    const stat = await fs.stat(safePath.fullPath)
    if (!stat.isDirectory()) {
      return jsonResponse({ error: 'Path is not a directory' }, { status: 400 })
    }

    const ignore = createIgnoreMatcher(options.ignorePatterns)
    const items = await readDirectoryItems(options.root, safePath.fullPath, showHidden, ignore)

    const response: ListResponse = {
      path: safePath.relativePath ? `/${safePath.relativePath}` : '/',
      absolutePath: safePath.fullPath,
      items,
    }

    return conditionalJsonResponse(req, response)
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

async function handleSyncManifest(url: URL, options: ApiRoutesOptions): Promise<Response> {
  const requestPath = url.searchParams.get('path') || '/'
  const knownRevision = url.searchParams.get('revision')
  const safePath = resolveSafePath(options.root, requestPath)

  if (!safePath) {
    return jsonResponse({ error: 'Access denied: Invalid path' }, { status: 403 })
  }

  try {
    const stat = await fs.stat(safePath.fullPath)
    if (!stat.isDirectory()) {
      return jsonResponse({ error: 'Path is not a directory' }, { status: 400 })
    }

    const rootPath = safePath.relativePath ? `/${safePath.relativePath}` : '/'
    const ignore = createIgnoreMatcher(options.ignorePatterns)
    const directories: SyncManifestDirectory[] = []
    const queue = [{ path: rootPath, absolutePath: safePath.fullPath }]

    for (let index = 0; index < queue.length; index++) {
      const directory = queue[index]!
      const items = await readDirectoryItems(options.root, directory.absolutePath, true, ignore, true)
      directories.push({
        ...directory,
        items,
      })

      for (const item of items) {
        // Match mobile pin semantics: dot-directories and symlinks are listed,
        // but never followed (symlinks may form cycles).
        if (item.type !== 'directory' || item.name.startsWith('.')) continue
        queue.push({
          path: joinServedPath(directory.path, item.name),
          absolutePath: item.absolutePath,
        })
      }
    }

    const revision = createHash('sha256')
      .update(JSON.stringify({ showHidden: options.showHidden, directories }))
      .digest('hex')
    const response: SyncManifestResponse = knownRevision === revision
      ? { path: rootPath, revision, unchanged: true }
      : {
          path: rootPath,
          revision,
          unchanged: false,
          showHidden: options.showHidden,
          directories,
        }
    return jsonResponse(response)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return jsonResponse({ error: 'Directory not found' }, { status: 404 })
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return jsonResponse({ error: 'Access denied' }, { status: 403 })
    }
    return jsonResponse({ error: 'Failed to build sync manifest' }, { status: 500 })
  }
}

async function handleFile(req: Request, url: URL, options: ApiRoutesOptions): Promise<Response> {
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
      'Accept-Ranges': 'bytes',
    }

    if (download) {
      headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(filename)}"`
    }

    const range = parseByteRange(req.headers.get('range'), stat.size)
    if (range === 'invalid') {
      return new Response(null, {
        status: 416,
        headers: {
          ...headers,
          'Content-Range': `bytes */${stat.size}`,
          'Content-Length': '0',
        },
      })
    }

    if (range) {
      const length = range.end - range.start + 1
      const body = await file.slice(range.start, range.end + 1).arrayBuffer()
      return new Response(body, {
        status: 206,
        headers: {
          ...headers,
          'Content-Length': length.toString(),
          'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
        },
      })
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

async function handleView(req: Request, url: URL, options: ApiRoutesOptions): Promise<Response> {
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

    const extension = getFileExtension(basename(safePath.fullPath))
    const viewableType = getViewableType(extension, stat.size)

    if (!viewableType) {
      return jsonResponse({ error: 'File type not viewable' }, { status: 400 })
    }

    const filename = basename(safePath.fullPath)

    if (viewableType === 'text') {
      const content = await fs.readFile(safePath.fullPath, 'utf-8')
      return conditionalJsonResponse(req, {
        type: 'text',
        filename,
        extension,
        content,
        size: stat.size,
        modified: stat.mtime.toISOString(),
      } satisfies ViewResponse)
    }

    // For binary previews, return the URL to fetch the file directly (inline, not download).
    return conditionalJsonResponse(req, {
      type: viewableType,
      filename,
      extension,
      url: `/api/file?path=${encodeURIComponent(requestPath)}&download=false`,
      size: stat.size,
    } satisfies ViewResponse)
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

async function handleSaveText(req: Request, options: ApiRoutesOptions): Promise<Response> {
  if (options.readonly) {
    return jsonResponse({ error: 'Server is in read-only mode' }, { status: 403 })
  }

  let body: SaveTextBody
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { path: requestPath, content, baseModified, baseSize } = body
  if (typeof requestPath !== 'string' || typeof content !== 'string') {
    return jsonResponse({ error: 'path and content are required' }, { status: 400 })
  }
  if (typeof baseModified !== 'string' || typeof baseSize !== 'number' || !Number.isSafeInteger(baseSize)) {
    return jsonResponse({ error: 'baseModified and baseSize are required' }, { status: 400 })
  }

  const safePath = resolveSafePath(options.root, requestPath)
  if (!safePath) {
    return jsonResponse({ error: 'Access denied: Invalid path' }, { status: 403 })
  }

  try {
    const stat = await fs.lstat(safePath.fullPath)
    if (!stat.isFile()) {
      return jsonResponse({ error: 'Can only save regular files' }, { status: 400 })
    }

    const extension = getFileExtension(basename(safePath.fullPath))
    if (!isTextEditable(extension)) {
      return jsonResponse({ error: 'File type is not editable as text' }, { status: 400 })
    }

    if (Buffer.byteLength(content, 'utf-8') > MAX_TEXT_SIZE) {
      return jsonResponse({ error: 'File is too large to save as text' }, { status: 413 })
    }

    if (stat.mtime.toISOString() !== baseModified || stat.size !== baseSize) {
      return jsonResponse({
        error: 'File changed on server',
        modified: stat.mtime.toISOString(),
        size: stat.size,
      }, { status: 409 })
    }

    await writeTextFileAtomically(safePath.fullPath, content, stat.mode)
    const nextStat = await fs.stat(safePath.fullPath)
    return jsonResponse({
      ok: true,
      modified: nextStat.mtime.toISOString(),
      size: nextStat.size,
    } satisfies SaveTextResponse)
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
    const stat = await fs.lstat(safePath.fullPath)

    if (stat.isSymbolicLink()) {
      const target = await readSymlinkTarget(options.root, safePath.fullPath)
      return jsonResponse({
        name: basename(safePath.fullPath),
        type: 'symlink',
        size: target.linkBroken ? stat.size : target.targetSize,
        modified: stat.mtime.toISOString(),
        created: stat.birthtime.toISOString(),
        extension: entryExtension(basename(safePath.fullPath), target.targetType, false),
        ...target,
      })
    }

    return jsonResponse({
      name: basename(safePath.fullPath),
      type: stat.isDirectory() ? 'directory' : 'file',
      size: stat.size,
      modified: stat.mtime.toISOString(),
      created: stat.birthtime.toISOString(),
      extension: stat.isFile() ? getFileExtension(basename(safePath.fullPath)) : null,
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

/**
 * Fuzzy matching algorithm (fzf-style)
 * Returns score > 0 if matches, 0 if no match
 * Higher score = better match
 */
function fuzzyScore(text: string, pattern: string): number {
  if (pattern.length === 0) return 0
  if (text.length === 0) return 0

  const lowerText = text.toLowerCase()
  const lowerPattern = pattern.toLowerCase()

  // Quick check: text must contain all pattern characters in order
  let patternIdx = 0
  for (let i = 0; i < lowerText.length && patternIdx < lowerPattern.length; i++) {
    if (lowerText[i] === lowerPattern[patternIdx]) {
      patternIdx++
    }
  }
  if (patternIdx !== lowerPattern.length) return 0

  // Exact substring match gets highest score
  if (lowerText.includes(lowerPattern)) {
    return 100 + lowerPattern.length * 2
  }

  // Calculate fuzzy score
  let score = 0
  let patternIndex = 0
  let prevMatchIndex = -2
  let consecutiveBonus = 0

  for (let i = 0; i < lowerText.length && patternIndex < lowerPattern.length; i++) {
    if (lowerText[i] === lowerPattern[patternIndex]) {
      score += 1

      // Consecutive match bonus
      if (i === prevMatchIndex + 1) {
        consecutiveBonus += 2
        score += consecutiveBonus
      } else {
        consecutiveBonus = 0
      }

      // Start of word bonus
      if (i === 0 || /[\s\-_./]/.test(lowerText[i - 1]!)) {
        score += 3
      }

      prevMatchIndex = i
      patternIndex++
    }
  }

  return score
}

async function searchRecursive(
  servedRoot: string,
  searchRootPath: string,
  currentPath: string,
  query: string,
  showHidden: boolean,
  ignore: IgnoreMatcher,
  limit: number,
  results: SearchResult[] = [],
  depth: number = 0
): Promise<SearchResult[]> {
  // Limit recursion depth for performance
  if (depth > 20 || results.length >= limit * 2) {
    return results
  }

  try {
    const entries = await fs.readdir(currentPath, { withFileTypes: true })

    for (const entry of entries) {
      if (!showHidden && entry.name.startsWith('.')) continue
      if (ignore(entry.name)) continue

      const entryPath = join(currentPath, entry.name)
      const relativePath = relative(searchRootPath, entryPath)

      // Score the file name against the query
      const score = fuzzyScore(entry.name, query)
      const isSymlink = entry.isSymbolicLink()
      const target = isSymlink ? await readSymlinkTarget(servedRoot, entryPath) : null

      if (score > 0) {
        const resultPath = '/' + relativePath.replace(/\\/g, '/')
        if (target) {
          results.push({
            name: entry.name,
            path: resultPath,
            absolutePath: entryPath,
            type: 'symlink',
            score,
            extension: entryExtension(entry.name, target.targetType, false),
            ...target,
          })
        } else if (entry.isDirectory()) {
          results.push({
            name: entry.name,
            path: resultPath,
            absolutePath: entryPath,
            type: 'directory',
            score,
            extension: null,
          })
        } else {
          results.push({
            name: entry.name,
            path: resultPath,
            absolutePath: entryPath,
            type: 'file',
            score,
            extension: getFileExtension(entry.name),
          })
        }
      }

      // Recurse into directories
      if (entry.isDirectory() || target?.targetType === 'directory') {
        await searchRecursive(servedRoot, searchRootPath, entryPath, query, showHidden, ignore, limit, results, depth + 1)
      }
    }
  } catch {
    // Skip directories we can't read
  }

  return results
}

async function handleSearch(url: URL, options: ApiRoutesOptions): Promise<Response> {
  const requestPath = url.searchParams.get('path') || '/'
  const query = url.searchParams.get('q') || ''
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200)

  if (!query || query.length < 1) {
    return jsonResponse({ query: '', results: [] } satisfies SearchResponse)
  }

  const safePath = resolveSafePath(options.root, requestPath)
  if (!safePath) {
    return jsonResponse({ error: 'Access denied: Invalid path' }, { status: 403 })
  }

  try {
    const ignore = createIgnoreMatcher(options.ignorePatterns)
    const results = await searchRecursive(
      options.root,
      safePath.fullPath,
      safePath.fullPath,
      query,
      options.showHidden,
      ignore,
      limit
    )

    // Sort by fuzzy score (higher is better)
    results.sort((a, b) => b.score - a.score)

    const response: SearchResponse = {
      query,
      results: results.slice(0, limit),
    }

    return jsonResponse(response)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return jsonResponse({ error: 'Directory not found' }, { status: 404 })
    }
    return jsonResponse({ error: 'Internal server error' }, { status: 500 })
  }
}

async function handleGit(url: URL, options: ApiRoutesOptions): Promise<Response> {
  const requestPath = url.searchParams.get('path') || '/'
  const safePath = resolveSafePath(options.root, requestPath)

  if (!safePath) {
    return jsonResponse({ error: 'Access denied: Invalid path' }, { status: 403 })
  }

  try {
    const status = await getGitStatus(safePath.fullPath)
    const response: GitStatusResponse = status
    return jsonResponse(response)
  } catch {
    return jsonResponse({ error: 'Internal server error' }, { status: 500 })
  }
}

async function handleGitLog(url: URL, options: ApiRoutesOptions): Promise<Response> {
  const requestPath = url.searchParams.get('path') || '/'
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '25', 10), 1), 100)
  const skip = Math.max(parseInt(url.searchParams.get('skip') || '0', 10), 0)

  const safePath = resolveSafePath(options.root, requestPath)

  if (!safePath) {
    return jsonResponse({ error: 'Access denied: Invalid path' }, { status: 403 })
  }

  try {
    const result = await getGitLog(safePath.fullPath, limit, skip)
    const response: GitLogResponse = result
    return jsonResponse(response)
  } catch {
    return jsonResponse({ error: 'Internal server error' }, { status: 500 })
  }
}

async function handleGitCommit(url: URL, options: ApiRoutesOptions): Promise<Response> {
  const requestPath = url.searchParams.get('path') || '/'
  const hash = url.searchParams.get('hash') || ''
  const includeAdjacent = url.searchParams.get('includeAdjacent') !== '0'

  if (!hash) {
    return jsonResponse({ error: 'hash is required' }, { status: 400 })
  }

  const safePath = resolveSafePath(options.root, requestPath)

  if (!safePath) {
    return jsonResponse({ error: 'Access denied: Invalid path' }, { status: 403 })
  }

  try {
    const [commit, repoRoot] = await Promise.all([
      getGitCommit(safePath.fullPath, hash, { includeAdjacent }),
      findGitRoot(safePath.fullPath),
    ])
    const repoPath = repoRoot ? toServedPath(options.root, repoRoot) : null
    const files = await withWorkingTreePaths(commit.files, repoPath, options.root)
    const response: GitCommitResponse = { commit: { ...commit, files } }
    return jsonResponse(response)
  } catch (error) {
    if (error instanceof GitOperationError) {
      return jsonResponse({ error: error.message }, { status: error.status })
    }
    return jsonResponse({ error: 'Internal server error' }, { status: 500 })
  }
}

async function handleGitChanges(url: URL, options: ApiRoutesOptions): Promise<Response> {
  const requestPath = url.searchParams.get('path') || '/'
  const safePath = resolveSafePath(options.root, requestPath)

  if (!safePath) {
    return jsonResponse({ error: 'Access denied: Invalid path' }, { status: 403 })
  }

  try {
    const result = await getGitChanges(safePath.fullPath)
    const repoPath = result.repoPath ? toServedPath(options.root, result.repoPath) : null
    const response: GitChangesResponse = {
      ...result,
      repoPath,
    }
    return jsonResponse(response)
  } catch {
    return jsonResponse({ error: 'Internal server error' }, { status: 500 })
  }
}

async function handleGitRevert(req: Request, options: ApiRoutesOptions): Promise<Response> {
  if (options.readonly) {
    return jsonResponse({ error: 'Server is in read-only mode' }, { status: 403 })
  }

  let body: { path?: string; filePath?: string }
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { path: requestPath, filePath } = body
  if (!requestPath || !filePath) {
    return jsonResponse({ error: 'path and filePath are required' }, { status: 400 })
  }

  const safePath = resolveSafePath(options.root, requestPath)
  if (!safePath) {
    return jsonResponse({ error: 'Access denied: Invalid path' }, { status: 403 })
  }

  try {
    await revertGitFile(safePath.fullPath, filePath)
    return jsonResponse({ ok: true } satisfies GitRevertResponse)
  } catch (error) {
    if (error instanceof GitOperationError) {
      return jsonResponse({ error: error.message }, { status: error.status })
    }
    return jsonResponse({ error: 'Internal server error' }, { status: 500 })
  }
}

async function handleRename(req: Request, options: ApiRoutesOptions): Promise<Response> {
  if (options.readonly) {
    return jsonResponse({ error: 'Server is in read-only mode' }, { status: 403 })
  }

  let body: { path?: string; newName?: string }
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { path: requestPath, newName } = body
  if (!requestPath || !newName) {
    return jsonResponse({ error: 'path and newName are required' }, { status: 400 })
  }

  if (newName.includes('/') || newName.includes('\\') || newName === '..' || newName.includes('\0')) {
    return jsonResponse({ error: 'Invalid file name' }, { status: 400 })
  }

  const safePath = resolveSafePath(options.root, requestPath)
  if (!safePath) {
    return jsonResponse({ error: 'Access denied: Invalid path' }, { status: 403 })
  }

  const parentDir = dirname(safePath.fullPath)
  const targetPath = join(parentDir, newName)

  // Ensure target stays within root
  const targetRelative = relative(options.root, targetPath)
  if (targetRelative.startsWith('..') || targetRelative.startsWith('/')) {
    return jsonResponse({ error: 'Access denied: Invalid target path' }, { status: 403 })
  }

  try {
    await fs.access(targetPath)
    return jsonResponse({ error: 'A file or folder with that name already exists' }, { status: 409 })
  } catch {
    // Target doesn't exist — good
  }

  try {
    await fs.rename(safePath.fullPath, targetPath)
    const newRelativePath = '/' + targetRelative.replace(/\\/g, '/')
    return jsonResponse({ ok: true, newPath: newRelativePath })
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

async function handleDelete(req: Request, options: ApiRoutesOptions): Promise<Response> {
  if (options.readonly) {
    return jsonResponse({ error: 'Server is in read-only mode' }, { status: 403 })
  }

  let body: { path?: string }
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { path: requestPath } = body
  if (!requestPath) {
    return jsonResponse({ error: 'path is required' }, { status: 400 })
  }

  const safePath = resolveSafePath(options.root, requestPath)
  if (!safePath) {
    return jsonResponse({ error: 'Access denied: Invalid path' }, { status: 403 })
  }

  if (safePath.fullPath === options.root) {
    return jsonResponse({ error: 'Cannot delete root directory' }, { status: 403 })
  }

  try {
    await fs.rm(safePath.fullPath, { recursive: true })
    return jsonResponse({ ok: true })
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

async function handleMove(req: Request, options: ApiRoutesOptions): Promise<Response> {
  if (options.readonly) {
    return jsonResponse({ error: 'Server is in read-only mode' }, { status: 403 })
  }

  let body: { path?: string; destination?: string }
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { path: requestPath, destination } = body
  if (!requestPath || !destination) {
    return jsonResponse({ error: 'path and destination are required' }, { status: 400 })
  }

  const safePath = resolveSafePath(options.root, requestPath)
  if (!safePath) {
    return jsonResponse({ error: 'Access denied: Invalid path' }, { status: 403 })
  }

  if (safePath.fullPath === options.root) {
    return jsonResponse({ error: 'Cannot move root directory' }, { status: 403 })
  }

  const safeDest = resolveSafePath(options.root, destination)
  if (!safeDest) {
    return jsonResponse({ error: 'Access denied: Invalid destination path' }, { status: 403 })
  }

  // Destination must be a directory
  try {
    const destStat = await fs.stat(safeDest.fullPath)
    if (!destStat.isDirectory()) {
      return jsonResponse({ error: 'Destination is not a directory' }, { status: 400 })
    }
  } catch {
    return jsonResponse({ error: 'Destination directory not found' }, { status: 404 })
  }

  // Prevent moving into itself or a subdirectory of itself
  const sourceName = basename(safePath.fullPath)
  const targetPath = join(safeDest.fullPath, sourceName)
  if (targetPath === safePath.fullPath || safeDest.fullPath.startsWith(safePath.fullPath + '/')) {
    return jsonResponse({ error: 'Cannot move a folder into itself' }, { status: 400 })
  }

  // Check target doesn't already exist
  try {
    await fs.access(targetPath)
    return jsonResponse({ error: 'A file or folder with that name already exists in the destination' }, { status: 409 })
  } catch {
    // Target doesn't exist — good
  }

  try {
    await fs.rename(safePath.fullPath, targetPath)
    const newRelative = relative(options.root, targetPath)
    const newPath = '/' + newRelative.replace(/\\/g, '/')
    return jsonResponse({ ok: true, newPath })
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

async function getUniquePath(destDir: string, sourceName: string): Promise<string> {
  let targetPath = join(destDir, sourceName)
  try {
    await fs.access(targetPath)
  } catch {
    return targetPath
  }

  const ext = extname(sourceName)
  const base = ext ? sourceName.slice(0, -ext.length) : sourceName

  targetPath = join(destDir, `${base} (copy)${ext}`)
  try {
    await fs.access(targetPath)
  } catch {
    return targetPath
  }

  for (let i = 2; i <= 100; i++) {
    targetPath = join(destDir, `${base} (copy ${i})${ext}`)
    try {
      await fs.access(targetPath)
    } catch {
      return targetPath
    }
  }

  throw new Error('Too many copies exist')
}

async function handleCopy(req: Request, options: ApiRoutesOptions): Promise<Response> {
  if (options.readonly) {
    return jsonResponse({ error: 'Server is in read-only mode' }, { status: 403 })
  }

  let body: { path?: string; destination?: string }
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { path: requestPath, destination } = body
  if (!requestPath || !destination) {
    return jsonResponse({ error: 'path and destination are required' }, { status: 400 })
  }

  const safePath = resolveSafePath(options.root, requestPath)
  if (!safePath) {
    return jsonResponse({ error: 'Access denied: Invalid path' }, { status: 403 })
  }

  const safeDest = resolveSafePath(options.root, destination)
  if (!safeDest) {
    return jsonResponse({ error: 'Access denied: Invalid destination path' }, { status: 403 })
  }

  try {
    const destStat = await fs.stat(safeDest.fullPath)
    if (!destStat.isDirectory()) {
      return jsonResponse({ error: 'Destination is not a directory' }, { status: 400 })
    }
  } catch {
    return jsonResponse({ error: 'Destination directory not found' }, { status: 404 })
  }

  try {
    const sourceStat = await fs.stat(safePath.fullPath)
    if (sourceStat.isDirectory() && safeDest.fullPath.startsWith(safePath.fullPath + '/')) {
      return jsonResponse({ error: 'Cannot copy a folder into itself' }, { status: 400 })
    }
  } catch {
    return jsonResponse({ error: 'File not found' }, { status: 404 })
  }

  try {
    const sourceName = basename(safePath.fullPath)
    const targetPath = await getUniquePath(safeDest.fullPath, sourceName)
    await fs.cp(safePath.fullPath, targetPath, { recursive: true })
    const newRelative = relative(options.root, targetPath)
    const newPath = '/' + newRelative.replace(/\\/g, '/')
    return jsonResponse({ ok: true, newPath })
  } catch (error) {
    if (error instanceof Error && error.message === 'Too many copies exist') {
      return jsonResponse({ error: 'Too many copies already exist' }, { status: 409 })
    }
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
