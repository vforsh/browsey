import { networkInterfaces, platform } from 'os'
import { resolve, dirname, join } from 'path'
import { existsSync } from 'fs'
import { fileURLToPath } from 'url'
import qrcode from 'qrcode-terminal'
import { handleApiRequest } from './routes.js'
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

  const [html, css, tsCode] = await Promise.all([
    Bun.file(join(uiDir, 'index.html')).text(),
    Bun.file(join(uiDir, 'styles.css')).text(),
    Bun.file(join(uiDir, 'app.ts')).text(),
  ])

  // Transpile TypeScript to JavaScript
  const transpiler = new Bun.Transpiler({ loader: 'ts' })
  const js = transpiler.transformSync(tsCode)

  return { html, css, js }
}

export async function startServer(options: ServerOptions): Promise<void> {
  const rootPath = resolve(options.root)

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
    hostname: options.host,
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

      return new Response('Not found', { status: 404 })
    },
  })

  const localUrl = `http://localhost:${options.port}`
  const networkUrl = getNetworkUrl(options.host, options.port)

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

  console.log('  \x1b[2mPress Ctrl+C to stop\x1b[0m')
  console.log()

  if (options.open) {
    openBrowser(localUrl)
  }

  const shutdown = () => {
    console.log('\n  Shutting down...')
    server.stop()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
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
