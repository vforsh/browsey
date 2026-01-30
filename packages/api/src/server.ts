import { networkInterfaces } from 'os'
import { resolve } from 'path'
import { existsSync } from 'fs'
import qrcode from 'qrcode-terminal'
import { handleApiRequest } from './routes.js'
import { advertiseService } from './bonjour.js'
import { createReloadSSEResponse, startWatcher, stopWatcher } from './live-reload.js'
import { withCors, corsPreflightResponse } from '@vforsh/browsey-shared'
import type { ApiServerOptions, InstanceInfo } from '@vforsh/browsey-shared'

export type ApiServerCallbacks = {
  register: (info: InstanceInfo) => void
  deregister: (pid: number) => void
}

export async function startApiServer(
  options: ApiServerOptions,
  callbacks: ApiServerCallbacks
): Promise<{ shutdown: () => void }> {
  const rootPath = resolve(options.root)
  const listenHost = normalizeHost(options.host)

  if (!existsSync(rootPath)) {
    console.error(`Error: Directory does not exist: ${rootPath}`)
    process.exit(1)
  }

  if (options.https && (!options.httpsCert || !options.httpsKey)) {
    console.error('Error: HTTPS requires both cert and key paths')
    process.exit(1)
  }

  let tlsConfig: { cert: string; key: string } | undefined
  if (options.https && options.httpsCert && options.httpsKey) {
    if (!existsSync(options.httpsCert)) {
      console.error(`Error: TLS cert not found: ${options.httpsCert}`)
      process.exit(1)
    }
    if (!existsSync(options.httpsKey)) {
      console.error(`Error: TLS key not found: ${options.httpsKey}`)
      process.exit(1)
    }

    const [cert, key] = await Promise.all([
      Bun.file(options.httpsCert).text(),
      Bun.file(options.httpsKey).text(),
    ])
    tlsConfig = { cert, key }
  }

  const corsOrigin = options.corsOrigin

  const apiOptions = {
    root: rootPath,
    readonly: options.readonly,
    showHidden: options.showHidden,
    ignorePatterns: options.ignorePatterns,
  }

  // Start file watcher if enabled
  if (options.watch) {
    startWatcher()
  }

  const server = Bun.serve({
    port: options.port,
    hostname: listenHost,
    tls: tlsConfig,
    idleTimeout: 255, // max value — needed for SSE live reload connections
    fetch: async (req) => {
      const url = new URL(req.url)

      // Handle CORS preflight
      if (req.method === 'OPTIONS') {
        return corsPreflightResponse(corsOrigin)
      }

      // SSE endpoint for live reload
      if (url.pathname === '/api/reload') {
        return withCors(createReloadSSEResponse(), corsOrigin)
      }

      const apiResponse = await handleApiRequest(req, apiOptions)
      if (apiResponse) {
        return withCors(apiResponse, corsOrigin)
      }

      return withCors(
        new Response(JSON.stringify({ error: 'Not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
        corsOrigin
      )
    },
  })

  const localUrl = getLocalUrl(listenHost, options.port, options.https)
  const networkUrl = getNetworkUrl(listenHost, options.port, options.https)

  if (!options.quiet) {
    console.log()
    console.log('  \x1b[1mBrowsey API\x1b[0m is running!')
    console.log()
    console.log(`  \x1b[2mLocal:\x1b[0m   ${localUrl}`)
    if (networkUrl) {
      console.log(`  \x1b[2mNetwork:\x1b[0m ${networkUrl}`)
    }
    console.log()
    console.log(`  \x1b[2mServing:\x1b[0m ${rootPath}`)
    console.log(`  \x1b[2mMode:\x1b[0m    ${options.readonly ? 'read-only' : 'read-write'}`)
    console.log(`  \x1b[2mCORS:\x1b[0m    ${corsOrigin}`)
    console.log()

    if (options.showQR && networkUrl) {
      console.log('  \x1b[2mAPI URL QR code:\x1b[0m')
      console.log()
      qrcode.generate(networkUrl, { small: true })
      console.log()
    }
  }

  // Start Bonjour advertising for iOS app discovery
  let stopBonjour: (() => void) | null = null
  if (options.bonjour) {
    try {
      stopBonjour = advertiseService(options.port, rootPath)
      if (!options.quiet) {
        console.log('  \x1b[2mBonjour:\x1b[0m  Advertising as _browsey._tcp')
        console.log()
      }
    } catch {
      if (!options.quiet) {
        console.log('  \x1b[33mWarning:\x1b[0m  Could not start Bonjour advertising')
        console.log()
      }
    }
  }

  if (!options.quiet) {
    console.log('  \x1b[2mPress Ctrl+C to stop\x1b[0m')
    console.log()
  }

  // Register this instance
  callbacks.register({
    pid: process.pid,
    port: options.port,
    host: options.host,
    kind: 'api',
    rootPath,
    startedAt: new Date().toISOString(),
    readonly: options.readonly,
    bonjour: options.bonjour,
    version: options.version,
  })

  const shutdown = () => {
    callbacks.deregister(process.pid)
    if (stopBonjour) {
      stopBonjour()
    }
    if (options.watch) {
      stopWatcher()
    }
    server.stop()
  }

  return { shutdown }
}

function normalizeHost(host: string): string {
  if (host === '0.0.0.0') {
    return '::'
  }
  return host
}

function getLocalUrl(host: string, port: number, https: boolean): string {
  const protocol = https ? 'https' : 'http'
  if (host === '0.0.0.0' || host === '::') {
    return `${protocol}://127.0.0.1:${port}`
  }
  if (host === '::1') {
    return `${protocol}://[::1]:${port}`
  }
  return `${protocol}://${host}:${port}`
}

function getNetworkUrl(host: string, port: number, https: boolean): string | null {
  if (host !== '0.0.0.0' && host !== '::') {
    return null
  }

  const protocol = https ? 'https' : 'http'
  const interfaces = networkInterfaces()
  for (const iface of Object.values(interfaces)) {
    for (const config of iface ?? []) {
      if (config.family === 'IPv4' && !config.internal) {
        return `${protocol}://${config.address}:${port}`
      }
    }
  }
  return null
}
