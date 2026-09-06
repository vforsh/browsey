import { afterEach, describe, expect, test } from 'bun:test'
import { promises as fs } from 'fs'
import { join } from 'path'
import { handleApiRequest } from './routes.js'
import { computeETag, ifNoneMatchSatisfied } from './conditional.js'
import type { ApiRoutesOptions } from '@vforsh/browsey-shared'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{ root: string; options: ApiRoutesOptions }> {
  const root = await fs.mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'browsey-etag-'))
  roots.push(root)
  await fs.mkdir(join(root, 'docs'), { recursive: true })
  await fs.writeFile(join(root, 'docs', 'note.md'), 'one')
  await fs.writeFile(join(root, 'docs', '.hidden'), 'secret')
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

function listUrl(options: { hidden?: boolean } = {}): URL {
  const url = new URL('http://localhost/api/list')
  url.searchParams.set('path', '/docs')
  if (options.hidden) url.searchParams.set('hidden', '1')
  return url
}

function viewUrl(): URL {
  const url = new URL('http://localhost/api/view')
  url.searchParams.set('path', '/docs/note.md')
  return url
}

async function request(
  url: URL,
  options: ApiRoutesOptions,
  ifNoneMatch?: string,
): Promise<Response> {
  const headers = ifNoneMatch ? { 'If-None-Match': ifNoneMatch } : undefined
  const response = await handleApiRequest(new Request(url, headers ? { headers } : undefined), options)
  if (!response) throw new Error('Expected the API to handle this route')
  return response
}

async function tagOf(url: URL, options: ApiRoutesOptions): Promise<string> {
  const response = await request(url, options)
  expect(response.status).toBe(200)
  const etag = response.headers.get('etag')
  if (!etag) throw new Error('Expected an ETag header')
  return etag
}

describe('If-None-Match parsing', () => {
  const etag = computeETag('payload')

  test('matches exactly, in a list, and on "*"', () => {
    expect(ifNoneMatchSatisfied(etag, etag)).toBe(true)
    expect(ifNoneMatchSatisfied(`"other", ${etag} , "another"`, etag)).toBe(true)
    expect(ifNoneMatchSatisfied('*', etag)).toBe(true)
    expect(ifNoneMatchSatisfied('"other"', etag)).toBe(false)
    expect(ifNoneMatchSatisfied(null, etag)).toBe(false)
    expect(ifNoneMatchSatisfied('', etag)).toBe(false)
  })

  test('tolerates whitespace and a W/ prefix on the client tag', () => {
    expect(ifNoneMatchSatisfied(`  ${etag}  `, etag)).toBe(true)
    expect(ifNoneMatchSatisfied(`W/${etag}`, etag)).toBe(true)
    expect(ifNoneMatchSatisfied(`W/ ${etag}`, etag)).toBe(true)
    expect(ifNoneMatchSatisfied(`"other", W/${etag}`, etag)).toBe(true)
  })

  test('emits a strong, quoted tag', () => {
    expect(etag).toMatch(/^"[0-9a-f]+"$/)
    expect(computeETag('payload')).toBe(etag)
    expect(computeETag('payload ')).not.toBe(etag)
  })
})

describe('GET /api/list conditional requests', () => {
  test('is stable across two identical calls', async () => {
    const { options } = await fixture()
    expect(await tagOf(listUrl(), options)).toBe(await tagOf(listUrl(), options))
  })

  test('changes when a listed file\'s contents change, which the directory mtime misses', async () => {
    const { root, options } = await fixture()
    const directory = join(root, 'docs')
    const before = await tagOf(listUrl(), options)
    const directoryMtimeBefore = (await fs.stat(directory)).mtimeMs

    await fs.writeFile(join(directory, 'note.md'), 'a considerably longer body than before')

    // The whole point of hashing the body: rewriting a child leaves the
    // directory's own mtime alone, so an mtime-based tag would answer 304
    // while the size and timestamp the client shows are already stale.
    expect((await fs.stat(directory)).mtimeMs).toBe(directoryMtimeBefore)
    expect(await tagOf(listUrl(), options)).not.toBe(before)
  })

  test('changes when a file is added', async () => {
    const { root, options } = await fixture()
    const before = await tagOf(listUrl(), options)
    await fs.writeFile(join(root, 'docs', 'extra.txt'), 'new')
    expect(await tagOf(listUrl(), options)).not.toBe(before)
  })

  test('returns 304 with no body and no Content-Type for the current tag', async () => {
    const { options } = await fixture()
    const etag = await tagOf(listUrl(), options)

    const response = await request(listUrl(), options, etag)
    expect(response.status).toBe(304)
    expect(response.headers.get('etag')).toBe(etag)
    expect(response.headers.get('content-type')).toBeNull()
    expect(await response.text()).toBe('')
  })

  test('returns the full payload for a stale tag', async () => {
    const { root, options } = await fixture()
    const stale = await tagOf(listUrl(), options)
    await fs.writeFile(join(root, 'docs', 'extra.txt'), 'new')

    const response = await request(listUrl(), options, stale)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(response.headers.get('etag')).not.toBe(stale)

    const body = await response.json() as { path: string; items: { name: string }[] }
    expect(body.path).toBe('/docs')
    expect(body.items.map((item) => item.name)).toContain('extra.txt')
  })

  test('gives the same directory a different tag when hidden files are shown', async () => {
    const { options } = await fixture()
    const visible = await tagOf(listUrl(), options)
    const withHidden = await tagOf(listUrl({ hidden: true }), options)
    expect(withHidden).not.toBe(visible)

    const response = await request(listUrl({ hidden: true }), options, visible)
    expect(response.status).toBe(200)
  })
})

describe('GET /api/view conditional requests', () => {
  test('tags a text file, revalidates it, and re-sends it once it changes', async () => {
    const { root, options } = await fixture()
    const etag = await tagOf(viewUrl(), options)
    expect(await tagOf(viewUrl(), options)).toBe(etag)

    const notModified = await request(viewUrl(), options, etag)
    expect(notModified.status).toBe(304)
    expect(notModified.headers.get('etag')).toBe(etag)
    expect(notModified.headers.get('content-type')).toBeNull()
    expect(await notModified.text()).toBe('')

    await fs.writeFile(join(root, 'docs', 'note.md'), 'two, and then some more text')

    const response = await request(viewUrl(), options, etag)
    expect(response.status).toBe(200)
    expect(response.headers.get('etag')).not.toBe(etag)

    const body = await response.json() as { type: string; filename: string; content: string }
    expect(body.type).toBe('text')
    expect(body.filename).toBe('note.md')
    expect(body.content).toBe('two, and then some more text')
  })
})
