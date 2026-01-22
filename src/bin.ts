import { Command } from 'commander'
import getPort from 'get-port'
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
  .option('--open', 'Open browser automatically')
  .option('--no-readonly', 'Allow file modifications')
  .option('--hidden', 'Show hidden files')
  .option('--no-qr', 'Do not display QR code')
  .option('--no-bonjour', 'Disable Bonjour service advertising')
  .addHelpText(
    'after',
    `
Examples:
  $ browsey
  $ browsey ./my-folder -p 3000
  $ browsey --no-readonly --open
  $ browsey . -h localhost --no-qr
  $ browsey -i "node_modules,*.log,.git"
`
  )
  .action(async (pathArg: string, options: Record<string, unknown>) => {
    const requestedPort = parseInt(options.port as string, 10)
    if (isNaN(requestedPort) || requestedPort < 1 || requestedPort > 65535) {
      console.error('Error: Invalid port number')
      process.exit(1)
    }

    const host = options.host as string
    const port = await getPort({ port: requestedPort, host })
    if (port !== requestedPort) {
      console.log(`Port ${requestedPort} is busy. Using ${port} instead.`)
    }

    await startServer({
      root: resolve(pathArg),
      port,
      host,
      open: (options.open as boolean) ?? false,
      readonly: (options.readonly as boolean) ?? true,
      showHidden: (options.hidden as boolean) ?? false,
      showQR: (options.qr as boolean) ?? true,
      bonjour: (options.bonjour as boolean) ?? true,
      ignorePatterns: parseIgnorePatterns(options.ignore as string | undefined),
    })
  })

program.parseAsync().catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : error}`)
  process.exit(1)
})
