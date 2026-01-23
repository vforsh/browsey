import { chmodSync, mkdirSync } from 'fs'
import { resolve } from 'path'

const rootDir = resolve(import.meta.dir, '..')
const distDir = resolve(rootDir, 'dist')

console.log('Building browsey...')

mkdirSync(distDir, { recursive: true })

const clientResult = await Bun.build({
  entrypoints: [resolve(rootDir, 'src/ui/app.ts')],
  minify: true,
  format: 'iife',
  target: 'browser',
  write: false,
} as Bun.BuildConfig & { write?: boolean })

if (!clientResult.success) {
  console.error('Failed to build client UI')
  process.exit(1)
}

const clientOutput = clientResult.outputs[0]
if (!clientOutput) {
  console.error('Missing client UI output')
  process.exit(1)
}

const html = await Bun.file(resolve(rootDir, 'src/ui/index.html')).text()
const css = await Bun.file(resolve(rootDir, 'src/ui/styles.css')).text()
const js = await clientOutput.text()
const manifest = await Bun.file(
  resolve(rootDir, 'src/ui/pwa/manifest.webmanifest'),
).text()
const [icon192, icon512, maskable192, maskable512, appleTouch] = await Promise.all([
  Bun.file(resolve(rootDir, 'src/ui/pwa/icons/icon-192.png')).arrayBuffer(),
  Bun.file(resolve(rootDir, 'src/ui/pwa/icons/icon-512.png')).arrayBuffer(),
  Bun.file(resolve(rootDir, 'src/ui/pwa/icons/maskable-192.png')).arrayBuffer(),
  Bun.file(resolve(rootDir, 'src/ui/pwa/icons/maskable-512.png')).arrayBuffer(),
  Bun.file(resolve(rootDir, 'src/ui/pwa/icons/apple-touch-icon.png')).arrayBuffer(),
])
const icon192B64 = Buffer.from(icon192).toString('base64')
const icon512B64 = Buffer.from(icon512).toString('base64')
const maskable192B64 = Buffer.from(maskable192).toString('base64')
const maskable512B64 = Buffer.from(maskable512).toString('base64')
const appleTouchB64 = Buffer.from(appleTouch).toString('base64')

const serverOutfile = resolve(distDir, 'browsey')
const serverResult = await Bun.build({
  entrypoints: [resolve(rootDir, 'src/bin.ts')],
  outfile: serverOutfile,
  minify: false,
  sourcemap: 'inline',
  target: 'bun',
  format: 'esm',
  write: false,
  define: {
    UI_HTML: JSON.stringify(html),
    UI_CSS: JSON.stringify(css),
    UI_JS: JSON.stringify(js),
    UI_MANIFEST: JSON.stringify(manifest),
    UI_ICON_192_B64: JSON.stringify(icon192B64),
    UI_ICON_512_B64: JSON.stringify(icon512B64),
    UI_MASKABLE_192_B64: JSON.stringify(maskable192B64),
    UI_MASKABLE_512_B64: JSON.stringify(maskable512B64),
    UI_APPLE_TOUCH_ICON_B64: JSON.stringify(appleTouchB64),
  },
} as Bun.BuildConfig & { write?: boolean })

if (!serverResult.success) {
  console.error('Failed to build server bundle')
  process.exit(1)
}

const serverOutput = serverResult.outputs[0]
if (!serverOutput) {
  console.error('Missing server output')
  process.exit(1)
}

const built = await serverOutput.text()
const withShebang = built.startsWith('#!') ? built : `#!/usr/bin/env bun\n${built}`
await Bun.write(serverOutfile, withShebang)
chmodSync(serverOutfile, 0o755)

console.log('Build complete!')
console.log('  dist/browsey')
