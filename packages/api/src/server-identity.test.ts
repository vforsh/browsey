import { afterEach, expect, test } from 'bun:test'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getServerId } from './server-identity.js'
import { handleApiRequest } from './routes.js'

const fixtures: string[] = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(path => fs.rm(path, { recursive: true, force: true })))
})
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'browsey-identity-test-'))
  fixtures.push(root)
  return { root, directory: join(root, 'identities') }
}
test('identity survives restarts and concurrent initialization', async () => {
  const { root, directory } = await fixture()
  const ids = await Promise.all(Array.from({ length: 20 }, () => getServerId(root, 4200, directory)))
  expect(new Set(ids).size).toBe(1)
  expect(await getServerId(root, 4200, directory)).toBe(ids[0]!)
  expect(await fs.readdir(directory)).toHaveLength(1)
})
test('canonical root, different ports, roots and installations', async () => {
  const { root, directory } = await fixture()
  const id = await getServerId(root, 4200, directory)
  const alias = join(root, 'alias')
  await fs.symlink(root, alias)
  expect(await getServerId(alias, 4200, directory)).toBe(id)
  expect(await getServerId(root, 4201, directory)).not.toBe(id)
  expect(await getServerId(directory, 4200, directory)).not.toBe(id)
  expect(await getServerId(root, 4200, join(root, 'other-install'))).not.toBe(id)
})
test('corrupt identity is not silently replaced', async () => {
  const { root, directory } = await fixture()
  await getServerId(root, 4200, directory)
  const path = join(directory, (await fs.readdir(directory))[0]!)
  await fs.writeFile(path, 'broken')
  await expect(getServerId(root, 4200, directory)).rejects.toThrow()
  expect(await fs.readFile(path, 'utf8')).toBe('broken')
})
test('health exposes the supplied identity without requiring agent authorization', async () => {
  const { root, directory } = await fixture()
  const serverId = await getServerId(root, 4200, directory)
  const response = await handleApiRequest(new Request('http://localhost/api/health'), {
    root, serverId, readonly: true, showHidden: false, ignorePatterns: [],
    agents: { enabled: true, token: 'never-public' },
  })
  const body = await response!.json()
  expect(body.serverId).toBe(serverId)
  expect(JSON.stringify(body)).not.toContain('never-public')
})
