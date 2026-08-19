import { afterEach, describe, expect, test } from 'bun:test'
import { promises as fs } from 'fs'
import { join } from 'path'
import { handleApiRequest } from './routes.js'
import type { ApiRoutesOptions, SyncManifestResponse } from '@vforsh/browsey-shared'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{ root: string; options: ApiRoutesOptions }> {
  const root = await fs.mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'browsey-manifest-'))
  roots.push(root)
  await fs.mkdir(join(root, 'pin', 'sub'), { recursive: true })
  await fs.mkdir(join(root, 'pin', '.private'), { recursive: true })
  await fs.writeFile(join(root, 'pin', 'note.md'), 'one')
  await fs.writeFile(join(root, 'pin', '.hidden'), 'secret')
  await fs.writeFile(join(root, 'pin', 'sub', 'nested.txt'), 'nested')
  await fs.writeFile(join(root, 'pin', '.private', 'ignored.txt'), 'ignored')
  return {
    root,
    options: {
      root,
      readonly: true,
      showHidden: false,
      ignorePatterns: [],
      agents: { enabled: false, token: '' },
    },
  }
}

async function manifest(
  options: ApiRoutesOptions,
  revision?: string,
): Promise<SyncManifestResponse> {
  const url = new URL('http://localhost/api/sync/manifest')
  url.searchParams.set('path', '/pin')
  if (revision) url.searchParams.set('revision', revision)
  const response = await handleApiRequest(new Request(url), options)
  expect(response?.status).toBe(200)
  return response!.json() as Promise<SyncManifestResponse>
}

describe('sync manifest', () => {
  test('returns one recursive snapshot without following hidden directories', async () => {
    const { options } = await fixture()
    const response = await manifest(options)
    expect(response.unchanged).toBe(false)
    if (response.unchanged) return

    expect(response.directories.map((directory) => directory.path)).toEqual([
      '/pin',
      '/pin/sub',
    ])
    const root = response.directories[0]!
    expect(root.items.some((item) => item.name === '.hidden')).toBe(true)
    expect(response.showHidden).toBe(false)
  })

  test('elides unchanged snapshots and changes revision after deletion', async () => {
    const { root, options } = await fixture()
    const first = await manifest(options)
    if (first.unchanged) throw new Error('Expected a complete snapshot')

    expect((await manifest(options, first.revision)).unchanged).toBe(true)
    await fs.rm(join(root, 'pin', 'sub', 'nested.txt'))

    const changed = await manifest(options, first.revision)
    expect(changed.unchanged).toBe(false)
    expect(changed.revision).not.toBe(first.revision)
    if (!changed.unchanged) {
      expect(
        changed.directories
          .flatMap((directory) => directory.items)
          .some((item) => item.name === 'nested.txt'),
      ).toBe(false)
    }
  })
})
