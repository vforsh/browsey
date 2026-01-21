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
