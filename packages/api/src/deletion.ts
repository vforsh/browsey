import { promises as fs } from 'fs'
import { randomUUID } from 'crypto'
import { basename, join } from 'path'

/**
 * Staging area for deletes, at the root of the served tree. It is hidden from
 * every listing through the ignore patterns, and it is never removed: git does
 * not report an empty directory, and removing it would race a delete that is
 * about to rename into it.
 */
export const TRASH_DIR_NAME = '.browsey-trash'

/**
 * Deletes `fullPath` without making the caller wait for the filesystem.
 *
 * A recursive `rm` of a large tree takes as long as the tree is big, and a
 * client on the other end of a tunnel gives up long before it finishes — then
 * reports a failure for a delete that went on to succeed. A rename into the
 * staging area is one metadata operation whatever the size, so the path is
 * gone by the time this resolves and the purge runs on its own.
 *
 * Anything the rename cannot do — a mount point under the root, a root that is
 * not writable — falls back to deleting in place, which is the old behaviour.
 * Throws the filesystem's error (with its `code`) when the path is missing or
 * cannot be deleted at all.
 */
export async function deletePath(root: string, fullPath: string): Promise<void> {
  // Distinguishes "nothing to delete" from a rename that failed for its own
  // reasons; only the second one is worth a fallback.
  await fs.lstat(fullPath)

  const trashDir = join(root, TRASH_DIR_NAME)
  const staged = join(trashDir, `${randomUUID()}-${basename(fullPath)}`)
  try {
    await fs.mkdir(trashDir, { recursive: true })
    await fs.rename(fullPath, staged)
  } catch {
    await fs.rm(fullPath, { recursive: true })
    return
  }

  void purge(staged)
}

/** Removes whatever a previous run left staged — a crash or restart mid-purge. */
export async function purgeTrash(root: string): Promise<void> {
  const trashDir = join(root, TRASH_DIR_NAME)
  let entries: string[]
  try {
    entries = await fs.readdir(trashDir)
  } catch {
    return
  }
  await Promise.all(entries.map((entry) => purge(join(trashDir, entry))))
}

async function purge(staged: string): Promise<void> {
  try {
    await fs.rm(staged, { recursive: true, force: true })
  } catch (error) {
    console.error(`[browsey] Failed to purge ${staged}:`, error)
  }
}
