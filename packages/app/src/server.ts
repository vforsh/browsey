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

// Dev mode: load UI files from disk if constants aren't defined
async function getUIContent(): Promise<{ html: string; css: string; js: string }> {
  if (typeof UI_HTML !== 'undefined') {
    return { html: UI_HTML, css: UI_CSS, js: UI_JS }
  }

  // Dev mode: load from packages/app/src/ui directory
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
  const ui = await getUIContent()
  const pwa = await getPwaAssets()

  // Inject the API base URL into HTML (if provided)
  const apiBaseUrl = options.apiUrl ? options.apiUrl.replace(/\/$/, '') : ''
  const htmlWithApi = apiBaseUrl
    ? ui.html.replace(
        'window.__BROWSEY_API_BASE__ = ""',
        `window.__BROWSEY_API_BASE__ = ${JSON.stringify(apiBaseUrl)}`
      )
    : ui.html

  const server = Bun.serve({
    port: options.port,
    hostname: listenHost,
    tls: tlsConfig,
    fetch: async (req) => {
      const url = new URL(req.url)

      if (url.pathname === '/') {
        return new Response(htmlWithApi, { headers: { 'Content-Type': 'text/html' } })
      }
      if (url.pathname === '/styles.css') {
        return new Response(ui.css, { headers: { 'Content-Type': 'text/css' } })
      }
      if (url.pathname === '/app.js') {
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
      return new Response(htmlWithApi, { headers: { 'Content-Type': 'text/html' } })
    },
  })

  const localUrl = getLocalUrl(listenHost, options.port, options.https)
  const networkUrl = getNetworkUrl(listenHost, options.port, options.https)

  if (!options.quiet) {
    console.log()
    console.log('  \x1b[1mBrowsey App\x1b[0m is running!')
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
  })

  if (options.open) {
    openBrowser(networkUrl ?? localUrl)
  }

  const shutdown = () => {
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
