import { spawn } from 'child_process'
import { access, constants } from 'fs/promises'
import { join, dirname } from 'path'

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

async function runGitCommand(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    })

    let stdout = ''
    proc.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim())
      } else {
        resolve(null)
      }
    })

    proc.on('error', () => {
      resolve(null)
    })
  })
}

/**
 * Find the git repository root for a given path.
 * Returns null if the path is not inside a git repository.
 */
export async function findGitRoot(path: string): Promise<string | null> {
  const result = await runGitCommand(path, ['rev-parse', '--show-toplevel'])
  return result
}

/**
 * Check if a path is inside a git repository.
 */
export async function isGitRepo(path: string): Promise<boolean> {
  const root = await findGitRoot(path)
  return root !== null
}

/**
 * Get comprehensive git status for a directory.
 */
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

/**
 * Get git commit log for a directory.
 */
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
    `--format=%H%n%h%n%an%n%aI%n%s`,
    `-n`,
    String(limit + 1),
    `--skip=${skip}`,
  ])

  if (!logOutput) {
    return { commits: [], hasMore: false }
  }

  const lines = logOutput.split('\n')
  const commits: CommitInfo[] = []

  // Each commit is 5 lines: hash, shortHash, author, date, message
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

  // Check if we got more than limit (meaning there are more)
  const hasMore = commits.length > limit
  if (hasMore) {
    commits.pop() // Remove the extra one we fetched
  }

  return { commits, hasMore }
}

/**
 * Get comprehensive git status for a directory.
 */
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
