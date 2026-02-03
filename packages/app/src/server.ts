import { networkInterfaces, platform } from 'os'
import { dirname, join } from 'path'
import { existsSync } from 'fs'
import { fileURLToPath } from 'url'
import qrcode from 'qrcode-terminal'
import type { AppServerOptions, InstanceInfo } from '@vforsh/browsey-shared'

// UI bundle will be injected by build script
declare const UI_HTML: string
declare const UI_CSS: string
declare const UI_JS: string
declare const UI_MANIFEST: string
declare const UI_ICON_192_B64: string
declare const UI_ICON_512_B64: string
declare const UI_MASKABLE_192_B64: string
declare const UI_MASKABLE_512_B64: string
declare const UI_APPLE_TOUCH_ICON_B64: string
declare const UI_SCREENSHOT_WIDE_B64: string
declare const UI_SCREENSHOT_MOBILE_B64: string

// Check if running in dev mode (UI constants not defined)
function isDevMode(): boolean {
  return typeof UI_HTML === 'undefined'
}

// Get UI directory path for dev mode
function getUiDir(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  return join(__dirname, 'ui')
}

// Dev mode: load UI files from disk
async function loadUIFromDisk(): Promise<{ html: string; css: string; js: string }> {
  const uiDir = getUiDir()

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

// Load UI content (from build constants or dev files)
async function getUIContent(): Promise<{ html: string; css: string; js: string }> {
  if (!isDevMode()) {
    return { html: UI_HTML, css: UI_CSS, js: UI_JS }
  }
  return loadUIFromDisk()
}

type PwaAssets = {
  manifest: string
  icons: Record<string, ArrayBuffer>
  screenshots: Record<string, ArrayBuffer>
}

function decodeBase64ToBuffer(base64: string): ArrayBuffer {
  const buffer = Buffer.from(base64, 'base64')
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
}

async function getPwaAssets(): Promise<PwaAssets> {
  if (typeof UI_MANIFEST !== 'undefined') {
    return {
      manifest: UI_MANIFEST,
      icons: {
        'icon-192.png': decodeBase64ToBuffer(UI_ICON_192_B64),
        'icon-512.png': decodeBase64ToBuffer(UI_ICON_512_B64),
        'maskable-192.png': decodeBase64ToBuffer(UI_MASKABLE_192_B64),
        'maskable-512.png': decodeBase64ToBuffer(UI_MASKABLE_512_B64),
        'apple-touch-icon.png': decodeBase64ToBuffer(UI_APPLE_TOUCH_ICON_B64),
      },
      screenshots: {
        'screenshot-wide.png': decodeBase64ToBuffer(UI_SCREENSHOT_WIDE_B64),
        'screenshot-mobile.png': decodeBase64ToBuffer(UI_SCREENSHOT_MOBILE_B64),
      },
    }
  }

  const __dirname = dirname(fileURLToPath(import.meta.url))
  const pwaDir = join(__dirname, 'ui', 'pwa')
  const iconsDir = join(pwaDir, 'icons')

  const manifest = await Bun.file(join(pwaDir, 'manifest.webmanifest')).text()
  const [icon192, icon512, maskable192, maskable512, appleTouch, screenshotWide, screenshotMobile] = await Promise.all([
    Bun.file(join(iconsDir, 'icon-192.png')).arrayBuffer(),
    Bun.file(join(iconsDir, 'icon-512.png')).arrayBuffer(),
    Bun.file(join(iconsDir, 'maskable-192.png')).arrayBuffer(),
    Bun.file(join(iconsDir, 'maskable-512.png')).arrayBuffer(),
    Bun.file(join(iconsDir, 'apple-touch-icon.png')).arrayBuffer(),
    Bun.file(join(pwaDir, 'screenshots', 'screenshot-wide.png')).arrayBuffer(),
    Bun.file(join(pwaDir, 'screenshots', 'screenshot-mobile.png')).arrayBuffer(),
  ])

  return {
    manifest,
    icons: {
      'icon-192.png': icon192,
      'icon-512.png': icon512,
      'maskable-192.png': maskable192,
      'maskable-512.png': maskable512,
      'apple-touch-icon.png': appleTouch,
    },
    screenshots: {
      'screenshot-wide.png': screenshotWide,
      'screenshot-mobile.png': screenshotMobile,
    },
  }
}

export type AppServerCallbacks = {
  register: (info: InstanceInfo) => void
  deregister: (pid: number) => void
}

export async function startAppServer(
  options: AppServerOptions,
  callbacks: AppServerCallbacks
): Promise<{ shutdown: () => void }> {
  const listenHost = normalizeHost(options.host)
  const watchMode = options.watch && isDevMode()

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

  // Load UI content (from build constants or dev files)
  // In watch mode, we'll reload on each request
  let ui = await getUIContent()
  const pwa = await getPwaAssets()

  // Live reload SSE clients
  const liveReloadClients = new Set<ReadableStreamDefaultController<Uint8Array>>()

  // File watcher for live reload
  let watcher: ReturnType<typeof import('fs').watch> | null = null
  if (watchMode) {
    const fs = await import('fs')
    const uiDir = getUiDir()
    let debounceTimer: ReturnType<typeof setTimeout> | null = null

    watcher = fs.watch(uiDir, { recursive: true }, (eventType, filename) => {
      if (!filename) return
      // Ignore non-source files
      if (!filename.endsWith('.ts') && !filename.endsWith('.css') && !filename.endsWith('.html')) return

      // Debounce to avoid multiple reloads
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        console.log(`  \x1b[2m[watch] File changed: ${filename}\x1b[0m`)
        // Notify all connected clients to reload
        const message = new TextEncoder().encode('data: reload\n\n')
        for (const controller of liveReloadClients) {
          try {
            controller.enqueue(message)
          } catch {
            liveReloadClients.delete(controller)
          }
        }
      }, 100)
    })
  }

  // Helper to get current HTML with API base and live reload script injected
  async function getHtml(): Promise<string> {
    if (watchMode) {
      ui = await loadUIFromDisk()
    }
    const apiBaseUrl = options.apiUrl ? options.apiUrl.replace(/\/$/, '') : ''
    let html = apiBaseUrl
      ? ui.html.replace(
          'window.__BROWSEY_API_BASE__ = ""',
          `window.__BROWSEY_API_BASE__ = ${JSON.stringify(apiBaseUrl)}`
        )
      : ui.html

    // Inject live reload script in watch mode
    if (watchMode) {
      const liveReloadScript = `<script>
(function() {
  var es = new EventSource('/__live-reload');
  es.onmessage = function() { location.reload(); };
  es.onerror = function() { es.close(); setTimeout(function() { location.reload(); }, 1000); };
})();
</script>`
      html = html.replace('</body>', liveReloadScript + '</body>')
    }
    return html
  }

  const server = Bun.serve({
    port: options.port,
    hostname: listenHost,
    tls: tlsConfig,
    fetch: async (req) => {
      const url = new URL(req.url)

      // Live reload SSE endpoint
      if (url.pathname === '/__live-reload' && watchMode) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            liveReloadClients.add(controller)
          },
          cancel(controller) {
            liveReloadClients.delete(controller)
          },
        })
        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          },
        })
      }

      if (url.pathname === '/') {
        const html = await getHtml()
        return new Response(html, { headers: { 'Content-Type': 'text/html' } })
      }
      if (url.pathname === '/styles.css') {
        if (watchMode) ui = await loadUIFromDisk()
        return new Response(ui.css, { headers: { 'Content-Type': 'text/css' } })
      }
      if (url.pathname === '/app.js') {
        if (watchMode) ui = await loadUIFromDisk()
        return new Response(ui.js, { headers: { 'Content-Type': 'application/javascript' } })
      }
      if (url.pathname === '/manifest.webmanifest') {
        return new Response(pwa.manifest, {
          headers: { 'Content-Type': 'application/manifest+json' },
        })
      }
      if (url.pathname.startsWith('/icons/')) {
        const iconName = url.pathname.slice('/icons/'.length)
        const icon = pwa.icons[iconName]
        if (icon) {
          return new Response(icon, { headers: { 'Content-Type': 'image/png' } })
        }
      }
      if (url.pathname.startsWith('/screenshots/')) {
        const screenshotName = url.pathname.slice('/screenshots/'.length)
        const screenshot = pwa.screenshots[screenshotName]
        if (screenshot) {
          return new Response(screenshot, { headers: { 'Content-Type': 'image/png' } })
        }
      }

      // SPA fallback
      const html = await getHtml()
      return new Response(html, { headers: { 'Content-Type': 'text/html' } })
    },
  })

  const localUrl = getLocalUrl(listenHost, options.port, options.https)
  const networkUrl = getNetworkUrl(listenHost, options.port, options.https)

  const apiBaseUrl = options.apiUrl ? options.apiUrl.replace(/\/$/, '') : ''

  if (!options.quiet) {
    console.log()
    console.log('  \x1b[1mBrowsey App\x1b[0m is running!')
    if (watchMode) {
      console.log('  \x1b[33m[watch mode]\x1b[0m Live reload enabled')
    }
    console.log()
    console.log(`  \x1b[2mLocal:\x1b[0m   ${localUrl}`)
    if (networkUrl) {
      console.log(`  \x1b[2mNetwork:\x1b[0m ${networkUrl}`)
    }
    console.log()

    if (options.showQR && networkUrl) {
      console.log('  \x1b[2mScan QR code to open on mobile:\x1b[0m')
      console.log()
      qrcode.generate(networkUrl, { small: true })
      console.log()
    }

    console.log('  \x1b[2mPress Ctrl+C to stop\x1b[0m')
    console.log()
  }

  // Register this instance
  callbacks.register({
    pid: process.pid,
    port: options.port,
    host: options.host,
    kind: 'app',
    rootPath: '',
    apiUrl: apiBaseUrl || undefined,
    startedAt: new Date().toISOString(),
    readonly: true,
    version: options.version,
    https: options.https,
    httpsCert: options.httpsCert,
    httpsKey: options.httpsKey,
    showQR: options.showQR,
  })

  if (options.open) {
    openBrowser(networkUrl ?? localUrl)
  }

  const shutdown = () => {
    if (watcher) watcher.close()
    callbacks.deregister(process.pid)
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
