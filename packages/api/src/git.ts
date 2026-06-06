import { spawn } from 'child_process'
import { rm } from 'fs/promises'
import { isAbsolute, relative, resolve, sep } from 'path'
import type { GitChangeFile, GitChangesResponse, GitCommitDetails, GitCommitFile, GitCommitStats } from '@vforsh/browsey-shared'

export type GitStatus = {
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

type GitCommandResult = {
  ok: boolean
  stdout: string
  stderr: string
}

export class GitOperationError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
    this.name = 'GitOperationError'
  }
}

async function runGitCommandResult(cwd: string, args: string[]): Promise<GitCommandResult> {
  return new Promise((resolve) => {
    const proc = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    })

    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (data) => {
      stdout += data.toString()
    })
    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      resolve({
        ok: code === 0,
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
      })
    })

    proc.on('error', () => {
      resolve({ ok: false, stdout: '', stderr: 'Failed to start git' })
    })
  })
}

async function runGitCommand(cwd: string, args: string[]): Promise<string | null> {
  const result = await runGitCommandResult(cwd, args)
  return result.ok ? result.stdout : null
}

function resolveRepoFilePath(repoRoot: string, filePath: string): string | null {
  if (!filePath || filePath.includes('\0') || isAbsolute(filePath)) return null

  const fullPath = resolve(repoRoot, filePath)
  const relativePath = relative(repoRoot, fullPath)
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    return null
  }
  return fullPath
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => !!value))]
}

export async function findGitRoot(path: string): Promise<string | null> {
  const result = await runGitCommand(path, ['rev-parse', '--show-toplevel'])
  return result
}

export async function isGitRepo(path: string): Promise<boolean> {
  const root = await findGitRoot(path)
  return root !== null
}

export type CommitInfo = {
  hash: string
  shortHash: string
  author: string
  date: string
  message: string
}

export type GitLogResult = {
  commits: CommitInfo[]
  hasMore: boolean
}

const COMMIT_HASH_RE = /^[0-9a-fA-F]{7,64}$/
const LOG_FORMAT = '%H%n%h%n%an%n%aI%n%s'

type GitCommitMetadata = Omit<GitCommitDetails, 'files' | 'previousCommit' | 'nextCommit' | 'stats'>

function parseCommitMetadata(output: string): GitCommitMetadata {
  const [
    hash,
    shortHash,
    author,
    authorEmail,
    date,
    committer,
    committerEmail,
    commitDate,
    message,
    body = '',
  ] = output.split('\0')

  if (!hash || !shortHash || !author || !date || message === undefined) {
    throw new GitOperationError(500, 'Failed to parse commit details')
  }

  return {
    hash,
    shortHash,
    author,
    authorEmail: authorEmail ?? '',
    date,
    committer: committer ?? '',
    committerEmail: committerEmail ?? '',
    commitDate: commitDate ?? date,
    message,
    body: body.trimEnd(),
  }
}

function parseCommitFiles(output: string): GitCommitFile[] {
  if (!output) return []

  const tokens = output.split('\0').filter(Boolean)
  const files: GitCommitFile[] = []

  for (let i = 0; i < tokens.length;) {
    const rawStatus = tokens[i++]
    if (!rawStatus) break

    const status = rawStatus[0] ?? ''
    if (status === 'R' || status === 'C') {
      const originalPath = tokens[i++]
      const path = tokens[i++]
      if (originalPath && path) {
        files.push({ path, originalPath, status, workingTreePath: null })
      }
      continue
    }

    const path = tokens[i++]
    if (path) {
      files.push({ path, status, workingTreePath: null })
    }
  }

  return files
}

function parseCommitStats(output: string): GitCommitStats {
  if (!output) {
    return { files: 0, additions: 0, deletions: 0 }
  }

  return output.split('\0').filter(Boolean).reduce<GitCommitStats>(
    (stats, line) => {
      const [additions, deletions] = line.split('\t')
      return {
        files: stats.files + 1,
        additions: stats.additions + parseNumstatCount(additions),
        deletions: stats.deletions + parseNumstatCount(deletions),
      }
    },
    { files: 0, additions: 0, deletions: 0 }
  )
}

function parseNumstatCount(value: string | undefined): number {
  if (!value || value === '-') return 0
  const count = Number.parseInt(value, 10)
  return Number.isFinite(count) ? count : 0
}

function parseCommitLog(output: string): CommitInfo[] {
  const lines = output.split('\n')
  const commits: CommitInfo[] = []

  for (let i = 0; i + 4 < lines.length; i += 5) {
    const hash = lines[i]
    const shortHash = lines[i + 1]
    const author = lines[i + 2]
    const date = lines[i + 3]
    const message = lines[i + 4]

    if (hash && shortHash && author && date && message !== undefined) {
      commits.push({ hash, shortHash, author, date, message })
    }
  }

  return commits
}

async function getAdjacentCommits(
  repoRoot: string,
  hash: string
): Promise<Pick<GitCommitDetails, 'previousCommit' | 'nextCommit'>> {
  const logOutput = await runGitCommand(repoRoot, ['log', `--format=${LOG_FORMAT}`])
  const commits = logOutput ? parseCommitLog(logOutput) : []
  const index = commits.findIndex((commit) => commit.hash === hash)

  if (index === -1) {
    return { previousCommit: null, nextCommit: null }
  }

  return {
    previousCommit: commits[index - 1] ?? null,
    nextCommit: commits[index + 1] ?? null,
  }
}

export async function getGitLog(
  path: string,
  limit: number = 25,
  skip: number = 0
): Promise<GitLogResult> {
  const repoRoot = await findGitRoot(path)

  if (!repoRoot) {
    return { commits: [], hasMore: false }
  }

  // Fetch limit+1 to detect if there are more commits
  const logOutput = await runGitCommand(path, [
    'log',
    `--format=${LOG_FORMAT}`,
    `-n`,
    String(limit + 1),
    `--skip=${skip}`,
  ])

  if (!logOutput) {
    return { commits: [], hasMore: false }
  }

  const commits = parseCommitLog(logOutput)

  // Check if we got more than limit (meaning there are more)
  const hasMore = commits.length > limit
  if (hasMore) {
    commits.pop() // Remove the extra one we fetched
  }

  return { commits, hasMore }
}

export async function getGitCommit(path: string, hash: string): Promise<GitCommitDetails> {
  const repoRoot = await findGitRoot(path)

  if (!repoRoot) {
    throw new GitOperationError(404, 'Not a git repository')
  }

  if (!COMMIT_HASH_RE.test(hash)) {
    throw new GitOperationError(400, 'Invalid commit hash')
  }

  const metadata = await runGitCommandResult(repoRoot, [
    'show',
    '-s',
    '--format=%H%x00%h%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%s%x00%b',
    hash,
  ])

  if (!metadata.ok || !metadata.stdout) {
    throw new GitOperationError(404, metadata.stderr || 'Commit not found')
  }

  const commit = parseCommitMetadata(metadata.stdout)
  const [filesResult, statsResult, adjacentCommits] = await Promise.all([
    runGitCommandResult(repoRoot, [
      'show',
      '--format=',
      '--name-status',
      '--find-renames',
      '--root',
      '-z',
      hash,
    ]),
    runGitCommandResult(repoRoot, [
      'show',
      '--format=',
      '--numstat',
      '--find-renames',
      '--root',
      '-z',
      hash,
    ]),
    getAdjacentCommits(repoRoot, commit.hash),
  ])

  if (!filesResult.ok) {
    throw new GitOperationError(500, filesResult.stderr || 'Failed to read commit files')
  }
  if (!statsResult.ok) {
    throw new GitOperationError(500, statsResult.stderr || 'Failed to read commit stats')
  }

  return {
    ...commit,
    ...adjacentCommits,
    stats: parseCommitStats(statsResult.stdout),
    files: parseCommitFiles(filesResult.stdout),
  }
}

export async function getGitStatus(path: string): Promise<GitStatus> {
  const repoRoot = await findGitRoot(path)

  if (!repoRoot) {
    return {
      isRepo: false,
      branch: null,
      isDirty: false,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      lastCommit: null,
      remoteUrl: null,
      repoRoot: null,
    }
  }

  // Get current branch
  const branch = await runGitCommand(path, ['rev-parse', '--abbrev-ref', 'HEAD'])

  // Get status (porcelain format for parsing)
  const statusOutput = await runGitCommand(path, ['status', '--porcelain'])
  let staged = 0
  let unstaged = 0
  let untracked = 0

  if (statusOutput) {
    const lines = statusOutput.split('\n').filter(Boolean)
    for (const line of lines) {
      const indexStatus = line[0]
      const workTreeStatus = line[1]

      if (indexStatus === '?') {
        untracked++
      } else {
        if (indexStatus && indexStatus !== ' ') {
          staged++
        }
        if (workTreeStatus && workTreeStatus !== ' ') {
          unstaged++
        }
      }
    }
  }

  const isDirty = staged > 0 || unstaged > 0 || untracked > 0

  // Get last commit info
  let lastCommit: GitStatus['lastCommit'] = null
  const commitInfo = await runGitCommand(path, [
    'log',
    '-1',
    '--format=%H%n%h%n%an%n%aI%n%s',
  ])

  if (commitInfo) {
    const [hash, shortHash, author, date, ...messageParts] = commitInfo.split('\n')
    if (hash && shortHash && author && date) {
      lastCommit = {
        hash,
        shortHash,
        author,
        date,
        message: messageParts.join('\n'),
      }
    }
  }

  // Get remote URL
  const remoteUrl = await runGitCommand(path, ['remote', 'get-url', 'origin'])

  return {
    isRepo: true,
    branch,
    isDirty,
    staged,
    unstaged,
    untracked,
    lastCommit,
    remoteUrl,
    repoRoot,
  }
}

export async function getGitChanges(path: string): Promise<GitChangesResponse> {
  const repoRoot = await findGitRoot(path)

  if (!repoRoot) {
    return { repoPath: null, staged: [], unstaged: [], untracked: [] }
  }

  const statusOutput = await runGitCommand(repoRoot, ['status', '--porcelain'])

  if (!statusOutput) {
    return { repoPath: null, staged: [], unstaged: [], untracked: [] }
  }

  const staged: GitChangeFile[] = []
  const unstaged: GitChangeFile[] = []
  const untracked: GitChangeFile[] = []

  const lines = statusOutput.split('\n').filter(Boolean)
  for (const line of lines) {
    const indexStatus = line[0] ?? ' '
    const workTreeStatus = line[1] ?? ' '
    let filePath = line.substring(3)

    let originalPath: string | undefined

    // Handle renames: "R  old -> new"
    if (indexStatus === 'R' || workTreeStatus === 'R') {
      const arrowIndex = filePath.indexOf(' -> ')
      if (arrowIndex !== -1) {
        originalPath = filePath.substring(0, arrowIndex)
        filePath = filePath.substring(arrowIndex + 4)
      }
    }

    if (indexStatus === '?') {
      untracked.push({ path: filePath, indexStatus, workTreeStatus, originalPath })
    } else {
      if (indexStatus !== ' ') {
        staged.push({ path: filePath, indexStatus, workTreeStatus, originalPath })
      }
      if (workTreeStatus !== ' ') {
        unstaged.push({ path: filePath, indexStatus, workTreeStatus, originalPath })
      }
    }
  }

  return { repoPath: repoRoot, staged, unstaged, untracked }
}

export async function revertGitFile(path: string, filePath: string): Promise<void> {
  const repoRoot = await findGitRoot(path)
  if (!repoRoot) {
    throw new GitOperationError(404, 'Not a git repository')
  }

  const targetPath = resolveRepoFilePath(repoRoot, filePath)
  if (!targetPath) {
    throw new GitOperationError(400, 'Invalid file path')
  }

  const changes = await getGitChanges(repoRoot)
  const allChanges = [...changes.staged, ...changes.unstaged, ...changes.untracked]
  const matchingChanges = allChanges.filter(
    (file) => file.path === filePath || file.originalPath === filePath
  )

  if (matchingChanges.length === 0) {
    throw new GitOperationError(404, 'File has no git changes')
  }

  const untrackedPaths = unique(
    matchingChanges
      .filter((file) => file.indexStatus === '?')
      .map((file) => file.path)
  )
  const addedPaths = unique(
    matchingChanges
      .filter((file) => file.indexStatus === 'A')
      .flatMap((file) => [file.originalPath, file.path])
  )
  const trackedPathspecs = unique(
    matchingChanges
      .filter((file) => file.indexStatus !== '?' && file.indexStatus !== 'A')
      .flatMap((file) => [file.originalPath, file.path])
  )

  if (trackedPathspecs.length > 0) {
    const result = await runGitCommandResult(repoRoot, [
      'restore',
      '--staged',
      '--worktree',
      '--',
      ...trackedPathspecs,
    ])
    if (!result.ok) {
      throw new GitOperationError(500, result.stderr || 'Failed to revert tracked file')
    }
  }

  if (addedPaths.length > 0) {
    const result = await runGitCommandResult(repoRoot, [
      'restore',
      '--staged',
      '--',
      ...addedPaths,
    ])
    if (!result.ok) {
      throw new GitOperationError(500, result.stderr || 'Failed to unstage added file')
    }
    for (const addedPath of addedPaths) {
      const fullPath = resolveRepoFilePath(repoRoot, addedPath)
      if (!fullPath) {
        throw new GitOperationError(400, 'Invalid added file path')
      }
      await rm(fullPath, { recursive: true, force: true })
    }
  }

  for (const untrackedPath of untrackedPaths) {
    const fullPath = resolveRepoFilePath(repoRoot, untrackedPath)
    if (!fullPath) {
      throw new GitOperationError(400, 'Invalid untracked file path')
    }
    await rm(fullPath, { recursive: true, force: true })
  }
}
