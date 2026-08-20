import { spawn } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { generationPrompt, promptTitle, sanitizeGeneratedTitle } from './thread-title.js'

/**
 * Titles a Claude session before it exists, because afterwards is too late: the
 * name given to `--remote-control` is the only title the phone will ever show
 * and there is no rename we can reach. So unlike Codex — which launches
 * instantly and renames itself a few seconds later — this runs on the launch's
 * critical path and the user waits for it.
 *
 * That cost is the whole design constraint. A one-shot `claude -p` against the
 * smallest model is around three seconds of startup before it reads a token, and
 * the flags below exist to keep the rest close to nothing:
 *
 *  - `--system-prompt` replaces Claude Code's own, which is long, irrelevant to
 *    writing six words, and worth about three seconds on its own;
 *  - `--strict-mcp-config` skips every configured MCP server, none of which a
 *    title needs;
 *  - `--no-session-persistence` keeps a throwaway turn out of the session list
 *    the phone reads.
 *
 * Not `--bare`: it skips the keychain, so the run fails with "Not logged in".
 *
 * The turn runs in an empty temp directory rather than the project, so project
 * hooks, settings and CLAUDE.md files cannot slow it down, change the answer, or
 * run anything on a launch nobody asked to run anything on. `-p` is also what
 * gets past the workspace trust prompt an unfamiliar directory would otherwise
 * raise.
 */

/** Smallest and fastest; a title is not a reasoning problem. */
const TITLE_MODEL = 'haiku'

/**
 * Slack over the ~6s a warm run takes. Past this the prompt slice is the better
 * title, because the fastest title is the one that does not delay the launch.
 */
const GENERATION_TIMEOUT_MS = 15_000

const SYSTEM_PROMPT = 'You write short titles. Answer with the title and nothing else.'

/** Enough for a title; a model that keeps talking is a model we stop reading. */
const MAX_OUTPUT_CHARS = 4_000

function runTitleTurn({
  binary,
  prompt,
  env,
}: {
  binary: string
  prompt: string
  env: NodeJS.ProcessEnv
}): Promise<string | null> {
  const cwd = mkdtempSync(join(tmpdir(), 'browsey-title-'))

  const argv = [
    '-p',
    '--model',
    TITLE_MODEL,
    '--strict-mcp-config',
    '--no-session-persistence',
    '--system-prompt',
    SYSTEM_PROMPT,
    // Last, as on every agent argv: the positional prompt must not be reachable
    // by a preceding flag's optional value.
    generationPrompt(prompt),
  ]

  return new Promise((resolve) => {
    const child = spawn(binary, argv, { cwd, stdio: ['ignore', 'pipe', 'ignore'], env })

    let output = ''
    let settled = false

    const finish = (title: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(watchdog)
      try {
        rmSync(cwd, { recursive: true, force: true })
      } catch {
        // A leftover temp directory is not worth failing a launch over.
      }
      resolve(title)
    }

    const watchdog = setTimeout(() => {
      child.kill('SIGKILL')
      finish(null)
    }, GENERATION_TIMEOUT_MS)
    watchdog.unref?.()

    child.stdout.setEncoding('utf-8')
    child.stdout.on('data', (chunk: string) => {
      if (output.length < MAX_OUTPUT_CHARS) output += chunk
    })

    // Anything other than a clean exit means there is no title to trust — a
    // login that expired, a model that is gone, a binary that moved.
    child.on('close', (code) => finish(code === 0 ? sanitizeGeneratedTitle(output) : null))
    child.on('error', () => finish(null))
  })
}

/**
 * What to name the session Browsey is about to start. Never throws and never
 * returns an empty string for a prompt that had words in it: generation is the
 * nice-to-have, the prompt slice is the guarantee.
 *
 * Empty string only when there was no prompt at all, which leaves the naming to
 * the caller's own fallback.
 */
export async function claudeThreadTitle({
  binary,
  prompt,
  env,
}: {
  binary: string
  prompt: string
  env: NodeJS.ProcessEnv
}): Promise<string> {
  const fallback = promptTitle(prompt)
  if (!fallback) return ''

  try {
    return (await runTitleTurn({ binary, prompt, env })) ?? fallback
  } catch {
    return fallback
  }
}
