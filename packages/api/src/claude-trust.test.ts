import { afterEach, describe, expect, test } from 'bun:test'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { hasClaudeWorkspaceTrustPrompt } from './claude-remote-control.js'
import { ClaudeTrustError, trustClaudeWorkspace } from './claude-trust.js'

const tempDirs: string[] = []

async function configFile(contents: string): Promise<string> {
  const directory = await fs.mkdtemp(join(tmpdir(), 'browsey-claude-trust-'))
  tempDirs.push(directory)
  const path = join(directory, '.claude.json')
  await fs.writeFile(path, contents, { encoding: 'utf-8', mode: 0o600 })
  return path
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true })))
})

describe('trustClaudeWorkspace', () => {
  test('flips only the existing false value and backs up the original bytes', async () => {
    const cwd = '/Volumes/ExternalSSD/dev/example'
    const before = `{
  "theme": "dark",
  "projects": {
    ${JSON.stringify(cwd)}: {
      "allowedTools": ["Read", "Edit"],
      "hasTrustDialogAccepted": false,
      "lastCost": 1.25
    }
  },
  "unrelated": { "leave": "exactly alone" }
}
`
    const path = await configFile(before)

    expect(await trustClaudeWorkspace(cwd, path)).toEqual({ changed: true })
    expect(await fs.readFile(path, 'utf-8')).toBe(before.replace('false', 'true'))
    expect(await fs.readFile(`${path}.browsey-backup`, 'utf-8')).toBe(before)
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600)
  })

  test('adds a missing flag without reserializing the project entry', async () => {
    const cwd = '/Users/vlad/dev/example'
    const before = `{
  "projects": {
    ${JSON.stringify(cwd)}: {
      "history": [1, {"nested": true}]
    }
  }
}`
    const path = await configFile(before)

    await trustClaudeWorkspace(cwd, path)

    expect(await fs.readFile(path, 'utf-8')).toBe(`{
  "projects": {
    ${JSON.stringify(cwd)}: {
      "history": [1, {"nested": true}],
      "hasTrustDialogAccepted": true
    }
  }
}`)
  })

  test('adds an exact-path project and leaves siblings untouched', async () => {
    const cwd = '/Users/vlad/dev/new-project'
    const before = '{"projects":{"/existing":{"hasTrustDialogAccepted":false}},"state":[3,2,1]}'
    const path = await configFile(before)

    await trustClaudeWorkspace(cwd, path)

    expect(await fs.readFile(path, 'utf-8')).toBe(
      `{"projects":{"/existing":{"hasTrustDialogAccepted":false}, ${JSON.stringify(cwd)}: {"hasTrustDialogAccepted": true}},"state":[3,2,1]}`
    )
  })

  test('does not mutate or create a backup when trust is already true', async () => {
    const cwd = '/Users/vlad/dev/trusted'
    const before = `{"projects":{${JSON.stringify(cwd)}:{"hasTrustDialogAccepted":true}}}`
    const path = await configFile(before)

    expect(await trustClaudeWorkspace(cwd, path)).toEqual({ changed: false })
    expect(await fs.readFile(path, 'utf-8')).toBe(before)
    await expect(fs.access(`${path}.browsey-backup`)).rejects.toBeTruthy()
  })

  test('refuses malformed state before creating a backup', async () => {
    const path = await configFile('{"projects": null}')

    await expect(trustClaudeWorkspace('/tmp/project', path)).rejects.toBeInstanceOf(
      ClaudeTrustError
    )
    await expect(fs.access(`${path}.browsey-backup`)).rejects.toBeTruthy()
  })
})

describe('hasClaudeWorkspaceTrustPrompt', () => {
  test('recognizes the Ink-rendered trust screen through cursor escapes', () => {
    const output =
      '\x1b[2GQuick\x1b[8Gsafety\x1b[15Gcheck:\x1b[22GIs\x1b[25Gthis' +
      '\x1b[30Ga\x1b[32Gproject\x1b[40Gyou\x1b[44Gcreated\x1b[52Gor' +
      '\x1b[55Gone\x1b[59Gyou\x1b[63Gtrust?\r\n\x1b[4GYes, I trust this folder'

    expect(hasClaudeWorkspaceTrustPrompt(output)).toBe(true)
  })

  test('does not mistake ordinary startup output for the gate', () => {
    expect(hasClaudeWorkspaceTrustPrompt('Claude Code v2.1.258\nRemote Control active')).toBe(false)
  })
})
