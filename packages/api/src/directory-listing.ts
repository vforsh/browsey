import { promises as fs, type Dirent } from 'fs'
import { dirname, join, relative, resolve } from 'path'
import { getFileExtension } from '@vforsh/browsey-shared'
import type { FileItem, IgnoreMatcher } from '@vforsh/browsey-shared'

export function toServedPath(root: string, fullPath: string): string | null {
  const relativePath = relative(root, fullPath)
  if (relativePath && !relativePath.startsWith('..') && !relativePath.startsWith('/')) {
    return '/' + relativePath.replace(/\\/g, '/')
  }
  return relativePath === '' ? '/' : null
}

export async function readSymlinkTarget(root: string, linkPath: string): Promise<{
  linkTarget: string
  targetPath: string | null
  targetAbsolutePath: string
  targetType: 'file' | 'directory' | null
  linkBroken: boolean
  targetSize: number
}> {
  const linkTarget = await fs.readlink(linkPath)
  const targetAbsolutePath = resolve(dirname(linkPath), linkTarget)
  const linkServedPath = toServedPath(root, linkPath)

  try {
    const targetStat = await fs.stat(linkPath)
    return {
      linkTarget,
      targetPath: toServedPath(root, targetAbsolutePath) ?? linkServedPath,
      targetAbsolutePath,
      targetType: targetStat.isDirectory() ? 'directory' : 'file',
      linkBroken: false,
      targetSize: targetStat.size,
    }
  } catch {
    return {
      linkTarget,
      targetPath: null,
      targetAbsolutePath,
      targetType: null,
      linkBroken: true,
      targetSize: 0,
    }
  }
}

export function entryExtension(
  entryName: string,
  targetType: 'file' | 'directory' | null,
  isFile: boolean
): string | null {
  return isFile || targetType === 'file' ? getFileExtension(entryName) : null
}

function sortFileItems(items: FileItem[]): void {
  items.sort((a, b) => {
    const aIsDirectory = a.type === 'directory' || (a.type === 'symlink' && a.targetType === 'directory')
    const bIsDirectory = b.type === 'directory' || (b.type === 'symlink' && b.targetType === 'directory')
    if (aIsDirectory !== bIsDirectory) return aIsDirectory ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

/**
 * Stats are independent, so they run concurrently instead of one round trip
 * to the thread pool per entry — the difference between a snappy and a sluggish
 * `node_modules`. The cap keeps a huge directory from exhausting descriptors.
 */
const STAT_CONCURRENCY = 32

async function mapConcurrently<T, R>(
  values: T[],
  limit: number,
  work: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next++
      results[index] = await work(values[index]!)
    }
  })
  await Promise.all(workers)
  return results
}

async function readEntryItem(
  root: string,
  directoryPath: string,
  entry: Dirent,
  strict: boolean
): Promise<FileItem | null> {
  const entryPath = join(directoryPath, entry.name)
  try {
    const entryStat = entry.isSymbolicLink() ? await fs.lstat(entryPath) : await fs.stat(entryPath)

    if (entry.isSymbolicLink()) {
      const target = await readSymlinkTarget(root, entryPath)
      return {
        name: entry.name,
        type: 'symlink',
        size: target.linkBroken ? entryStat.size : target.targetSize,
        modified: entryStat.mtime.toISOString(),
        extension: entryExtension(entry.name, target.targetType, false),
        absolutePath: entryPath,
        ...target,
      }
    }
    if (entry.isDirectory()) {
      return {
        name: entry.name,
        type: 'directory',
        size: entryStat.size,
        modified: entryStat.mtime.toISOString(),
        extension: null,
        absolutePath: entryPath,
      }
    }
    return {
      name: entry.name,
      type: 'file',
      size: entryStat.size,
      modified: entryStat.mtime.toISOString(),
      extension: getFileExtension(entry.name),
      absolutePath: entryPath,
    }
  } catch (error) {
    if (strict) throw error
    // A disappearing or unreadable child should not hide the rest of a listing.
    return null
  }
}

/** Reads one directory using the same item contract as `/api/list`. */
export async function readDirectoryItems(
  root: string,
  directoryPath: string,
  showHidden: boolean,
  ignore: IgnoreMatcher,
  strict = false
): Promise<FileItem[]> {
  const entries = (await fs.readdir(directoryPath, { withFileTypes: true })).filter((entry) => {
    if (!showHidden && entry.name.startsWith('.')) return false
    return !ignore(entry.name)
  })
  const read = await mapConcurrently(entries, STAT_CONCURRENCY, (entry) =>
    readEntryItem(root, directoryPath, entry, strict)
  )
  const items = read.filter((item): item is FileItem => item !== null)

  sortFileItems(items)
  return items
}
