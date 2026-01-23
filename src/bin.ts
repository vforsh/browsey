import { Command } from 'commander'
import getPort from 'get-port'
import { resolve } from 'path'
import { startServer } from './server.js'
import { parseIgnorePatterns } from './ignore.js'
import { listInstances, findInstance, findAllMatchingInstances, stopInstance } from './registry.js'
import type { InstanceInfo } from './types.js'

export const VERSION = '0.1.0'

const program = new Command()

program
  .name('browsey')
  .description('Mobile-friendly web file browser')
  .version(VERSION)
  .showSuggestionAfterError(true)
  .helpOption('-?, --help', 'Display help for command')

// Default serve command (backwards compatible)
const serveCommand = new Command('serve')
  .description('Start the file browser server')
  .argument('[path]', 'Directory to serve', '.')
  .option('-p, --port <port>', 'Port to listen on', '4200')
  .option('-h, --host <host>', 'Host to bind to', '0.0.0.0')
  .option('-i, --ignore <globs>', 'Ignore patterns (comma-separated)')
  .option('--open', 'Open browser automatically')
  .option('--no-readonly', 'Allow file modifications')
  .option('--hidden', 'Show hidden files')
  .option('--no-qr', 'Do not display QR code')
  .option('--no-bonjour', 'Disable Bonjour service advertising')
  .option('--no-https', 'Disable HTTPS')
  .option('--https-cert <path>', 'Path to TLS certificate (PEM)', './certs/browsey.pem')
  .option('--https-key <path>', 'Path to TLS private key (PEM)', './certs/browsey-key.pem')
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

    const httpsEnabled = (options.https as boolean) ?? true
    const httpsCert = options.httpsCert ? resolve(options.httpsCert as string) : undefined
    const httpsKey = options.httpsKey ? resolve(options.httpsKey as string) : undefined
    if (httpsEnabled && (!httpsCert || !httpsKey)) {
      console.error('Error: HTTPS requires both --https-cert and --https-key')
      process.exit(1)
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
      version: VERSION,
      https: httpsEnabled,
      httpsCert,
      httpsKey,
    })
  })

program.addCommand(serveCommand, { isDefault: true })

// List command
program
  .command('list')
  .alias('ls')
  .description('List running browsey instances')
  .option('--json', 'Output as JSON')
  .action((options: { json?: boolean }) => {
    const instances = listInstances()

    if (options.json) {
      console.log(JSON.stringify(instances, null, 2))
      return
    }

    if (instances.length === 0) {
      console.log('No running browsey instances found.')
      return
    }

    // Table header
    console.log()
    console.log('  \x1b[1mPID     PORT   DIRECTORY                         MODE\x1b[0m')
    console.log('  ' + '─'.repeat(60))

    for (const instance of instances) {
      const pid = instance.pid.toString().padEnd(7)
      const port = instance.port.toString().padEnd(6)
      const dir = truncatePath(instance.rootPath, 33).padEnd(33)
      const mode = instance.readonly ? 'read-only' : 'read-write'
      console.log(`  ${pid} ${port} ${dir} ${mode}`)
    }
    console.log()
  })

// Stop command
program
  .command('stop')
  .alias('kill')
  .description('Stop running browsey instances')
  .argument('[target]', 'PID, :port, or path substring to match')
  .option('--all', 'Stop all instances')
  .option('--force', 'Use SIGKILL instead of SIGTERM')
  .action((target: string | undefined, options: { all?: boolean; force?: boolean }) => {
    const instances = listInstances()

    if (instances.length === 0) {
      console.log('No running browsey instances found.')
      return
    }

    if (options.all) {
      stopAllInstances(instances, options.force ?? false)
      return
    }

    if (!target) {
      console.error('Error: Please specify a target (PID, :port, or path) or use --all')
      process.exit(1)
    }

    const matching = findAllMatchingInstances(target)

    if (matching.length === 0) {
      console.error(`Error: No instance found matching "${target}"`)
      process.exit(1)
    }

    if (matching.length > 1) {
      console.log(`Found ${matching.length} matching instances:`)
      for (const inst of matching) {
        console.log(`  PID ${inst.pid}: ${inst.rootPath} (port ${inst.port})`)
      }
      console.log('\nPlease be more specific or use --all to stop all instances.')
      process.exit(1)
    }

    const instance = matching[0]!
    stopSingleInstance(instance, options.force ?? false)
  })

function stopAllInstances(instances: InstanceInfo[], force: boolean): void {
  console.log(`Stopping ${instances.length} instance(s)...`)
  let stopped = 0
  for (const instance of instances) {
    const success = stopInstance(instance.pid, force)
    if (success) {
      console.log(`  Stopped PID ${instance.pid} (${instance.rootPath})`)
      stopped++
    } else {
      console.log(`  PID ${instance.pid} was already stopped`)
    }
  }
  console.log(`Done. ${stopped} instance(s) stopped.`)
}

function stopSingleInstance(instance: InstanceInfo, force: boolean): void {
  const success = stopInstance(instance.pid, force)
  if (success) {
    console.log(`Stopped browsey instance (PID ${instance.pid}) serving ${instance.rootPath}`)
  } else {
    console.log(`Instance (PID ${instance.pid}) was already stopped`)
  }
}

function truncatePath(path: string, maxLen: number): string {
  if (path.length <= maxLen) return path
  return '...' + path.slice(-(maxLen - 3))
}

program.parseAsync().catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : error}`)
  process.exit(1)
})
