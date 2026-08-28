import { createHash, randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/** One immutable record per configuration; hard-link publication is atomic and
 * cannot replace a winner from another process. No stale lock to recover. */
export async function getServerId(
  root: string,
  port: number,
  directory = join(homedir(), '.browsey', 'server-identities'),
): Promise<string> {
  const configuration = JSON.stringify([await fs.realpath(root), port])
  const key = createHash('sha256').update(configuration).digest('hex')
  const target = join(directory, `${key}.json`)
  const read = async (): Promise<string> => {
    const value: unknown = JSON.parse(await fs.readFile(target, 'utf8'))
    if (!value || typeof value !== 'object' || !('id' in value) ||
        typeof value.id !== 'string' || !/^[0-9a-f-]{36}$/.test(value.id) ||
        !('configuration' in value) || value.configuration !== configuration) {
      throw new Error(`Invalid server identity at ${target}; restore this file from backup.`)
    }
    return value.id
  }
  try {
    return await read()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `.${randomUUID()}.tmp`)
  const file = await fs.open(temporary, 'wx', 0o600)
  try {
    await file.writeFile(JSON.stringify({ id: randomUUID(), configuration }))
    await file.sync()
  } finally {
    await file.close()
  }
  try {
    await fs.link(temporary, target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  } finally {
    await fs.unlink(temporary)
  }
  return read()
}
