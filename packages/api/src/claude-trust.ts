import { promises as fs } from 'fs'
import { homedir } from 'os'
import { basename, dirname, join } from 'path'
import { randomUUID } from 'crypto'

const CLAUDE_CONFIG_PATH = join(homedir(), '.claude.json')

type JsonProperty = {
  key: string
  keyStart: number
  valueStart: number
  valueEnd: number
}

export class ClaudeTrustError extends Error {}

function skipWhitespace(contents: string, from: number): number {
  let cursor = from
  while (/\s/.test(contents[cursor] ?? '')) cursor += 1
  return cursor
}

function readStringEnd(contents: string, from: number): number {
  if (contents[from] !== '"') throw new ClaudeTrustError('Claude config contains invalid JSON')

  let escaped = false
  for (let cursor = from + 1; cursor < contents.length; cursor += 1) {
    const char = contents[cursor]
    if (escaped) {
      escaped = false
    } else if (char === '\\') {
      escaped = true
    } else if (char === '"') {
      return cursor + 1
    }
  }
  throw new ClaudeTrustError('Claude config contains an unterminated string')
}

/** End-exclusive range of one valid JSON value, without reserializing it. */
function readValueEnd(contents: string, from: number): number {
  const first = contents[from]
  if (first === '"') return readStringEnd(contents, from)

  if (first === '{' || first === '[') {
    const closing = first === '{' ? '}' : ']'
    const stack = [closing]
    let cursor = from + 1
    while (cursor < contents.length && stack.length > 0) {
      const char = contents[cursor]
      if (char === '"') {
        cursor = readStringEnd(contents, cursor)
        continue
      }
      if (char === '{') stack.push('}')
      else if (char === '[') stack.push(']')
      else if (char === stack.at(-1)) stack.pop()
      cursor += 1
    }
    if (stack.length > 0) throw new ClaudeTrustError('Claude config contains invalid JSON')
    return cursor
  }

  let cursor = from
  while (cursor < contents.length && !',}]'.includes(contents[cursor]!)) cursor += 1
  let end = cursor
  while (end > from && /\s/.test(contents[end - 1]!)) end -= 1
  return end
}

/** Direct properties of an object, with byte ranges into the original text. */
function objectProperties(contents: string, objectStart: number): {
  properties: JsonProperty[]
  objectEnd: number
} {
  if (contents[objectStart] !== '{') {
    throw new ClaudeTrustError('Claude config contains an invalid object')
  }

  const properties: JsonProperty[] = []
  let cursor = skipWhitespace(contents, objectStart + 1)
  while (contents[cursor] !== '}') {
    const keyStart = cursor
    const keyEnd = readStringEnd(contents, keyStart)
    const key = JSON.parse(contents.slice(keyStart, keyEnd)) as unknown
    if (typeof key !== 'string') throw new ClaudeTrustError('Claude config contains an invalid key')

    cursor = skipWhitespace(contents, keyEnd)
    if (contents[cursor] !== ':') throw new ClaudeTrustError('Claude config contains invalid JSON')
    const valueStart = skipWhitespace(contents, cursor + 1)
    const valueEnd = readValueEnd(contents, valueStart)
    properties.push({ key, keyStart, valueStart, valueEnd })

    cursor = skipWhitespace(contents, valueEnd)
    if (contents[cursor] === ',') {
      cursor = skipWhitespace(contents, cursor + 1)
      continue
    }
    if (contents[cursor] !== '}') throw new ClaudeTrustError('Claude config contains invalid JSON')
  }

  return { properties, objectEnd: cursor + 1 }
}

function lineIndent(contents: string, at: number): string {
  const lineStart = contents.lastIndexOf('\n', at - 1) + 1
  return contents.slice(lineStart, at).match(/^\s*/)?.[0] ?? ''
}

/** Adds one property while preserving every existing byte in the object. */
function insertObjectProperty(
  contents: string,
  objectStart: number,
  objectEnd: number,
  key: string,
  value: string
): string {
  const close = objectEnd - 1
  let bodyEnd = close
  while (bodyEnd > objectStart + 1 && /\s/.test(contents[bodyEnd - 1]!)) bodyEnd -= 1

  const hasProperties = contents.slice(objectStart + 1, bodyEnd).trim().length > 0
  const multiline = contents.slice(objectStart, objectEnd).includes('\n')
  const property = `${JSON.stringify(key)}: ${value}`
  let insertion: string

  if (multiline) {
    const closeIndent = lineIndent(contents, close)
    const { properties } = objectProperties(contents, objectStart)
    const propertyIndent = properties[0]
      ? lineIndent(contents, properties[0].keyStart)
      : `${closeIndent}  `
    insertion = `${hasProperties ? ',' : ''}\n${propertyIndent}${property}\n${closeIndent}`
  } else {
    insertion = `${hasProperties ? ', ' : ''}${property}`
  }

  return `${contents.slice(0, bodyEnd)}${insertion}${contents.slice(close)}`
}

/**
 * Changes only the trust bit for one exact cwd. Claude's config contains a lot
 * of unrelated live state, so parsing and stringifying the whole file would be
 * a needlessly destructive rewrite; the small scanner above keeps every other
 * byte exactly as Claude wrote it.
 */
function withWorkspaceTrusted(contents: string, cwd: string): {
  contents: string
  changed: boolean
} {
  try {
    JSON.parse(contents)
  } catch {
    throw new ClaudeTrustError('Claude config is not valid JSON; refusing to change it')
  }

  const rootStart = skipWhitespace(contents, 0)
  const root = objectProperties(contents, rootStart)
  const projects = root.properties.find((property) => property.key === 'projects')
  if (!projects || contents[projects.valueStart] !== '{') {
    throw new ClaudeTrustError('Claude config has no valid projects object; refusing to change it')
  }

  const projectObject = objectProperties(contents, projects.valueStart)
  const project = projectObject.properties.find((property) => property.key === cwd)
  if (!project) {
    return {
      contents: insertObjectProperty(
        contents,
        projects.valueStart,
        projectObject.objectEnd,
        cwd,
        '{"hasTrustDialogAccepted": true}'
      ),
      changed: true,
    }
  }
  if (contents[project.valueStart] !== '{') {
    throw new ClaudeTrustError(`Claude project entry for ${cwd} is not an object`)
  }

  const settings = objectProperties(contents, project.valueStart)
  const trust = settings.properties.find((property) => property.key === 'hasTrustDialogAccepted')
  if (!trust) {
    return {
      contents: insertObjectProperty(
        contents,
        project.valueStart,
        settings.objectEnd,
        'hasTrustDialogAccepted',
        'true'
      ),
      changed: true,
    }
  }

  const current = contents.slice(trust.valueStart, trust.valueEnd).trim()
  if (current === 'true') return { contents, changed: false }
  if (current !== 'false') {
    throw new ClaudeTrustError(`Claude project trust flag for ${cwd} is not a boolean`)
  }
  return {
    contents: `${contents.slice(0, trust.valueStart)}true${contents.slice(trust.valueEnd)}`,
    changed: true,
  }
}

async function writeFileAtomically(path: string, contents: string, mode: number): Promise<void> {
  const tempPath = join(dirname(path), `.${basename(path)}.browsey-${process.pid}-${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null
  try {
    handle = await fs.open(tempPath, 'wx', mode)
    await handle.writeFile(contents, 'utf-8')
    await handle.sync()
    await handle.close()
    handle = null
    await fs.rename(tempPath, path)
  } catch (error) {
    await handle?.close().catch(() => {})
    await fs.rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * Grants Claude trust for one resolved launch directory, as an explicit user
 * action. The first mutation hard-links a byte-for-byte backup before the
 * atomic replacement; a concurrent Claude write is detected rather than lost.
 */
export async function trustClaudeWorkspace(
  cwd: string,
  configPath = CLAUDE_CONFIG_PATH
): Promise<{ changed: boolean }> {
  let before: string
  let stat: Awaited<ReturnType<typeof fs.stat>>
  try {
    ;[before, stat] = await Promise.all([fs.readFile(configPath, 'utf-8'), fs.stat(configPath)])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ClaudeTrustError(`Could not read Claude config: ${message}`)
  }

  const updated = withWorkspaceTrusted(before, cwd)
  if (!updated.changed) return { changed: false }

  const backupPath = `${configPath}.browsey-backup`
  try {
    await fs.link(configPath, backupPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      const message = error instanceof Error ? error.message : String(error)
      throw new ClaudeTrustError(`Could not back up Claude config: ${message}`)
    }
  }

  // Claude also writes this file. If it changed while Browsey prepared the
  // replacement, make the user retry instead of erasing the newer state.
  if ((await fs.readFile(configPath, 'utf-8')) !== before) {
    throw new ClaudeTrustError('Claude config changed while trust was being granted; try again')
  }

  try {
    await writeFileAtomically(configPath, updated.contents, stat.mode & 0o777)
  } catch (error) {
    if (error instanceof ClaudeTrustError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new ClaudeTrustError(`Could not update Claude config: ${message}`)
  }

  return { changed: true }
}
