import { homedir } from 'os'
import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'fs'
import type { InstanceInfo, RegistryFile } from './types.js'

const REGISTRY_DIR = join(homedir(), '.browsey')
const REGISTRY_FILE = join(REGISTRY_DIR, 'instances.json')

export function getRegistryPath(): string {
  return REGISTRY_FILE
}

export function ensureRegistryDir(): void {
  if (!existsSync(REGISTRY_DIR)) {
    mkdirSync(REGISTRY_DIR, { recursive: true })
  }
}

function createEmptyRegistry(): RegistryFile {
  return { version: 1, instances: [] }
}

export function readRegistry(): RegistryFile {
  ensureRegistryDir()

  if (!existsSync(REGISTRY_FILE)) {
    return createEmptyRegistry()
  }

  try {
    const content = readFileSync(REGISTRY_FILE, 'utf-8')
    const data = JSON.parse(content) as RegistryFile
    if (data.version !== 1 || !Array.isArray(data.instances)) {
      console.error('Warning: Registry file corrupted, resetting')
      return createEmptyRegistry()
    }
    return data
  } catch {
    console.error('Warning: Could not parse registry file, resetting')
    return createEmptyRegistry()
  }
}

export function writeRegistry(registry: RegistryFile): void {
  ensureRegistryDir()

  // Atomic write: write to temp file then rename
  const tempFile = `${REGISTRY_FILE}.tmp`
  try {
    writeFileSync(tempFile, JSON.stringify(registry, null, 2))
    // Rename is atomic on most systems
    const { renameSync } = require('fs')
    renameSync(tempFile, REGISTRY_FILE)
  } catch (error) {
    // Fallback to direct write if rename fails
    try {
      unlinkSync(tempFile)
    } catch {
      // Ignore cleanup errors
    }
    writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2))
  }
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException
    // EPERM means process exists but we don't have permission
    if (err.code === 'EPERM') {
      return true
    }
    // ESRCH means no such process
    return false
  }
}

function pruneStaleInstances(registry: RegistryFile): RegistryFile {
  const liveInstances = registry.instances.filter((instance) => isProcessRunning(instance.pid))
  return { ...registry, instances: liveInstances }
}

export function register(info: InstanceInfo): void {
  let registry = readRegistry()
  // Prune stale instances first
  registry = pruneStaleInstances(registry)
  // Remove any existing entry for this PID (in case of restart)
  registry.instances = registry.instances.filter((i) => i.pid !== info.pid)
  registry.instances.push(info)
  writeRegistry(registry)
}

export function deregister(pid: number): void {
  const registry = readRegistry()
  registry.instances = registry.instances.filter((i) => i.pid !== pid)
  writeRegistry(registry)
}

export function listInstances(): InstanceInfo[] {
  let registry = readRegistry()
  const before = registry.instances.length
  registry = pruneStaleInstances(registry)
  // Write back if we pruned anything
  if (registry.instances.length !== before) {
    writeRegistry(registry)
  }
  return registry.instances
}

export type FindTarget = {
  type: 'pid' | 'port' | 'path'
  value: number | string
}

export function parseTarget(target: string): FindTarget {
  // :8080 → port only
  if (target.startsWith(':')) {
    const port = parseInt(target.slice(1), 10)
    if (!isNaN(port)) {
      return { type: 'port', value: port }
    }
  }

  // Pure number → try PID first, then port
  const num = parseInt(target, 10)
  if (!isNaN(num) && target === num.toString()) {
    return { type: 'pid', value: num }
  }

  // String → path substring
  return { type: 'path', value: target }
}

export function findInstance(target: string): InstanceInfo | null {
  const instances = listInstances()
  const parsed = parseTarget(target)

  if (parsed.type === 'port') {
    return instances.find((i) => i.port === parsed.value) ?? null
  }

  if (parsed.type === 'pid') {
    // Try PID first
    const byPid = instances.find((i) => i.pid === parsed.value)
    if (byPid) return byPid
    // Fall back to port
    return instances.find((i) => i.port === parsed.value) ?? null
  }

  // Path substring match (case-insensitive)
  const searchStr = (parsed.value as string).toLowerCase()
  return instances.find((i) => i.rootPath.toLowerCase().includes(searchStr)) ?? null
}

export function findAllMatchingInstances(target: string): InstanceInfo[] {
  const instances = listInstances()
  const parsed = parseTarget(target)

  if (parsed.type === 'port') {
    return instances.filter((i) => i.port === parsed.value)
  }

  if (parsed.type === 'pid') {
    // Try PID first
    const byPid = instances.filter((i) => i.pid === parsed.value)
    if (byPid.length > 0) return byPid
    // Fall back to port
    return instances.filter((i) => i.port === parsed.value)
  }

  // Path substring match (case-insensitive)
  const searchStr = (parsed.value as string).toLowerCase()
  return instances.filter((i) => i.rootPath.toLowerCase().includes(searchStr))
}

export function stopInstance(pid: number, force: boolean = false): boolean {
  const signal = force ? 'SIGKILL' : 'SIGTERM'
  try {
    process.kill(pid, signal)
    // Give it a moment, then deregister
    deregister(pid)
    return true
  } catch {
    // Process may already be dead
    deregister(pid)
    return false
  }
}
