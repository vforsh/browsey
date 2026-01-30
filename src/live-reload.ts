import { watch, type FSWatcher } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

export type ReloadEventType = 'reload' | 'css'

export type LiveReloadClient = {
  id: number
  controller: ReadableStreamDefaultController<string>
}

let clients: LiveReloadClient[] = []
let clientIdCounter = 0
let watcher: FSWatcher | null = null

/**
 * Create an SSE response for live reload
 */
export function createReloadSSEResponse(): Response {
  const clientId = ++clientIdCounter

  const stream = new ReadableStream<string>({
    start(controller) {
      const client: LiveReloadClient = { id: clientId, controller }
      clients.push(client)

      // Send initial connection message
      controller.enqueue('event: connected\ndata: {}\n\n')
    },
    cancel() {
      clients = clients.filter((c) => c.id !== clientId)
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    },
  })
}

/**
 * Broadcast reload event to all connected clients
 */
export function broadcastReload(eventType: ReloadEventType = 'reload'): void {
  const message = `event: ${eventType}\ndata: {"time":${Date.now()}}\n\n`

  for (const client of clients) {
    try {
      client.controller.enqueue(message)
    } catch {
      // Client disconnected, will be cleaned up
    }
  }
}

/**
 * Start watching UI files for changes
 */
export function startWatcher(): void {
  if (watcher) return

  const __dirname = dirname(fileURLToPath(import.meta.url))
  const uiDir = join(__dirname, 'ui')

  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  watcher = watch(uiDir, { recursive: true }, (eventType, filename) => {
    if (!filename) return

    // Debounce rapid changes
    if (debounceTimer) {
      clearTimeout(debounceTimer)
    }

    debounceTimer = setTimeout(() => {
      debounceTimer = null

      // Determine event type based on file extension
      const reloadType: ReloadEventType = filename.endsWith('.css') ? 'css' : 'reload'

      console.log(`  \x1b[2m[watch]\x1b[0m ${filename} changed, sending ${reloadType}`)
      broadcastReload(reloadType)
    }, 100)
  })

  console.log('  \x1b[2mWatch:\x1b[0m   Live reload enabled')
}

/**
 * Stop the file watcher
 */
export function stopWatcher(): void {
  if (watcher) {
    watcher.close()
    watcher = null
  }

  // Close all SSE connections
  for (const client of clients) {
    try {
      client.controller.close()
    } catch {
      // Ignore
    }
  }
  clients = []
}

/**
 * Get number of connected clients
 */
export function getClientCount(): number {
  return clients.length
}
