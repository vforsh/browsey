import { Command } from 'commander'
import { resolve } from 'path'
import { startServer } from './server.js'
import { parseIgnorePatterns } from './ignore.js'

const VERSION = '0.1.0'

const program = new Command()

program
  .name('browsey')
  .description('Mobile-friendly web file browser')
  .version(VERSION)
  .showSuggestionAfterError(true)
  .helpOption('-?, --help', 'Display help for command')
  .argument('[path]', 'Directory to serve', '.')
  .option('-p, --port <port>', 'Port to listen on', '8080')
  .option('-h, --host <host>', 'Host to bind to', '0.0.0.0')
  .option('-i, --ignore <globs>', 'Ignore patterns (comma-separated)')
  .option('--no-open', 'Do not open browser automatically')
  .option('--readonly', 'Disable file modifications (download only)')
  .option('--hidden', 'Show hidden files')
  .option('--qr', 'Display QR code for mobile access')
  .addHelpText(
    'after',
    `
Examples:
  $ browsey
  $ browsey ./my-folder -p 3000
  $ browsey --readonly --qr
  $ browsey . -h localhost --no-open
  $ browsey -i "node_modules,*.log,.git"
`
  )
  .action(async (pathArg: string, options: Record<string, unknown>) => {
    const port = parseInt(options.port as string, 10)
    if (isNaN(port) || port < 1 || port > 65535) {
      console.error('Error: Invalid port number')
      process.exit(1)
    }

    await startServer({
      root: resolve(pathArg),
      port,
      host: options.host as string,
      open: options.open as boolean,
      readonly: (options.readonly as boolean) ?? false,
      showHidden: (options.hidden as boolean) ?? false,
      showQR: (options.qr as boolean) ?? false,
      ignorePatterns: parseIgnorePatterns(options.ignore as string | undefined),
    })
  })

program.parseAsync().catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : error}`)
  process.exit(1)
})
