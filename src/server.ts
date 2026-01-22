import { networkInterfaces, platform } from 'os'
import { resolve, dirname, join } from 'path'
import { existsSync } from 'fs'
import { fileURLToPath } from 'url'
import qrcode from 'qrcode-terminal'
import { handleApiRequest } from './routes.js'
import { advertiseService } from './bonjour.js'
import { register, deregister } from './registry.js'
import type { ServerOptions } from './types.js'

// UI bundle will be injected by build script
declare const UI_HTML: string
declare const UI_CSS: string
declare const UI_JS: string

// Dev mode: load UI files from disk if constants aren't defined
async function getUIContent(): Promise<{ html: string; css: string; js: string }> {
  // Check if we're in production (constants injected by build)
  if (typeof UI_HTML !== 'undefined') {
    return { html: UI_HTML, css: UI_CSS, js: UI_JS }
  }

  // Dev mode: load from src/ui directory
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const uiDir = join(__dirname, 'ui')

  const [html, css] = await Promise.all([
    Bun.file(join(uiDir, 'index.html')).text(),
    Bun.file(join(uiDir, 'styles.css')).text(),
  ])

  const clientResult = await Bun.build({
    entrypoints: [join(uiDir, 'app.ts')],
    minify: false,
    format: 'iife',
    target: 'browser',
    write: false,
  } as Bun.BuildConfig & { write?: boolean })

  if (!clientResult.success) {
    throw new Error('Failed to build client UI in dev mode')
  }

  const clientOutput = clientResult.outputs[0]
  if (!clientOutput) {
    throw new Error('Missing client UI output in dev mode')
  }

  const js = await clientOutput.text()

  return { html, css, js }
}

export async function startServer(options: ServerOptions): Promise<void> {
  const rootPath = resolve(options.root)
  const listenHost = normalizeHost(options.host)

  // Validate root path exists
  if (!existsSync(rootPath)) {
    console.error(`Error: Directory does not exist: ${rootPath}`)
    process.exit(1)
  }

  // Load UI content (from build constants or dev files)
  const ui = await getUIContent()

  const apiOptions = {
    root: rootPath,
    readonly: options.readonly,
    showHidden: options.showHidden,
    ignorePatterns: options.ignorePatterns,
  }

  const server = Bun.serve({
    port: options.port,
    hostname: listenHost,
    fetch: async (req) => {
      const url = new URL(req.url)

      if (url.pathname === '/') {
        return new Response(ui.html, { headers: { 'Content-Type': 'text/html' } })
      }
      if (url.pathname === '/styles.css') {
        return new Response(ui.css, { headers: { 'Content-Type': 'text/css' } })
      }
      if (url.pathname === '/app.js') {
        return new Response(ui.js, { headers: { 'Content-Type': 'application/javascript' } })
      }

      const apiResponse = await handleApiRequest(req, apiOptions)
      if (apiResponse) {
        return apiResponse
      }

      return new Response(ui.html, { headers: { 'Content-Type': 'text/html' } })
    },
  })

  const localUrl = getLocalUrl(listenHost, options.port)
  const networkUrl = getNetworkUrl(listenHost, options.port)

  console.log()
  console.log('  \x1b[1mBrowsey\x1b[0m is running!')
  console.log()
  console.log(`  \x1b[2mLocal:\x1b[0m   ${localUrl}`)
  if (networkUrl) {
    console.log(`  \x1b[2mNetwork:\x1b[0m ${networkUrl}`)
  }
  console.log()
  console.log(`  \x1b[2mServing:\x1b[0m ${rootPath}`)
  console.log(`  \x1b[2mMode:\x1b[0m    ${options.readonly ? 'read-only' : 'read-write'}`)
  console.log()

  if (options.showQR && networkUrl) {
    console.log('  \x1b[2mScan QR code to open on mobile:\x1b[0m')
    console.log()
    qrcode.generate(networkUrl, { small: true })
    console.log()
  }

  // Start Bonjour advertising for iOS app discovery
  let stopBonjour: (() => void) | null = null
  if (options.bonjour) {
    try {
      stopBonjour = advertiseService(options.port, rootPath)
      console.log('  \x1b[2mBonjour:\x1b[0m  Advertising as _browsey._tcp')
      console.log()
    } catch {
      console.log('  \x1b[33mWarning:\x1b[0m  Could not start Bonjour advertising')
      console.log()
    }
  }

  console.log('  \x1b[2mPress Ctrl+C to stop\x1b[0m')
  console.log()

  // Register this instance
  register({
    pid: process.pid,
    port: options.port,
    host: options.host,
    rootPath,
    startedAt: new Date().toISOString(),
    readonly: options.readonly,
    bonjour: options.bonjour,
    version: options.version,
  })

  if (options.open) {
    openBrowser(networkUrl ?? localUrl)
  }

  const shutdown = () => {
    console.log('\n  Shutting down...')
    deregister(process.pid)
    if (stopBonjour) {
      stopBonjour()
    }
    server.stop()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

function normalizeHost(host: string): string {
  if (host === '0.0.0.0') {
    // Use dual-stack so localhost IPv6 still reaches the server.
    return '::'
  }
  return host
}

function getLocalUrl(host: string, port: number): string {
  if (host === '0.0.0.0' || host === '::') {
    return `http://127.0.0.1:${port}`
  }
  if (host === '::1') {
    return `http://[::1]:${port}`
  }
  return `http://${host}:${port}`
}

function getNetworkUrl(host: string, port: number): string | null {
  if (host !== '0.0.0.0' && host !== '::') {
    return null
  }

  const interfaces = networkInterfaces()
  for (const iface of Object.values(interfaces)) {
    for (const config of iface ?? []) {
      if (config.family === 'IPv4' && !config.internal) {
        return `http://${config.address}:${port}`
      }
    }
  }
  return null
}

function openBrowser(url: string): void {
  const plat = platform()
  const cmd =
    plat === 'darwin'
      ? ['open', url]
      : plat === 'win32'
        ? ['cmd', '/c', 'start', '""', url]
        : ['xdg-open', url]

  try {
    Bun.spawn(cmd, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
  } catch {
    // Ignore errors
  }
}
