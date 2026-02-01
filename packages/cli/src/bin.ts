import { Command } from 'commander'
import getPort from 'get-port'
import { resolve } from 'path'
import { networkInterfaces } from 'os'
import qrcode from 'qrcode-terminal'
import { startApiServer } from '@vforsh/browsey-api'
import { startAppServer } from '@vforsh/browsey-app'
import { parseIgnorePatterns } from '@vforsh/browsey-shared'
import type { InstanceInfo } from '@vforsh/browsey-shared'
import { listInstances, findAllMatchingInstances, stopInstance, register, deregister } from './registry.js'

export const VERSION = '0.1.0'

const program = new Command()

program
  .name('browsey')
  .description('Mobile-friendly web file browser')
  .version(VERSION)
  .showSuggestionAfterError(true)
  .helpOption('-?, --help', 'Display help for command')

// API command
const apiCommand = new Command('api')
  .alias('service')
  .description('Start the API server')
  .argument('[path]', 'Directory to serve', '.')
  .option('-p, --port <port>', 'Port to listen on', '4200')
  .option('-h, --host <host>', 'Host to bind to', '0.0.0.0')
  .option('-i, --ignore <globs>', 'Ignore patterns (comma-separated)')
  .option('--no-readonly', 'Allow file modifications')
  .option('--hidden', 'Show hidden files')
  .option('--no-qr', 'Do not display QR code')
  .option('--https', 'Enable HTTPS')
  .option('--https-cert <path>', 'Path to TLS certificate (PEM)')
  .option('--https-key <path>', 'Path to TLS private key (PEM)')
  .option('-w, --watch', 'Enable live reload on file changes (dev mode)')
  .option('--cors <origin>', 'CORS allowed origin', '*')
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

    const httpsEnabled = (options.https as boolean) ?? false
    const httpsCert = options.httpsCert ? resolve(options.httpsCert as string) : undefined
    const httpsKey = options.httpsKey ? resolve(options.httpsKey as string) : undefined
    if (httpsEnabled && (!httpsCert || !httpsKey)) {
      console.error('Error: HTTPS requires both --https-cert and --https-key')
      process.exit(1)
    }

    const { shutdown } = await startApiServer(
      {
        root: resolve(pathArg),
        port,
        host,
        readonly: (options.readonly as boolean) ?? true,
        showHidden: (options.hidden as boolean) ?? false,
        showQR: (options.qr as boolean) ?? true,
        ignorePatterns: parseIgnorePatterns(options.ignore as string | undefined),
        version: VERSION,
        https: httpsEnabled,
        httpsCert,
        httpsKey,
        watch: (options.watch as boolean) ?? false,
        corsOrigin: (options.cors as string) ?? '*',
      },
      { register, deregister }
    )

    const onSignal = () => {
      console.log('\n  Shutting down...')
      shutdown()
      process.exit(0)
    }
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)
  })

// App command
const appCommand = new Command('app')
  .alias('ui')
  .description('Start the UI server')
  .option('-p, --port <port>', 'Port to listen on', '4201')
  .option('-h, --host <host>', 'Host to bind to', '0.0.0.0')
  .option('--api <url>', 'API server URL (optional, configure in browser if omitted)')
  .option('--open', 'Open browser automatically')
  .option('--https', 'Enable HTTPS')
  .option('--https-cert <path>', 'Path to TLS certificate (PEM)')
  .option('--https-key <path>', 'Path to TLS private key (PEM)')
  .option('--no-qr', 'Do not display QR code')
  .action(async (options: Record<string, unknown>) => {
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

    const httpsEnabled = (options.https as boolean) ?? false
    const httpsCert = options.httpsCert ? resolve(options.httpsCert as string) : undefined
    const httpsKey = options.httpsKey ? resolve(options.httpsKey as string) : undefined
    if (httpsEnabled && (!httpsCert || !httpsKey)) {
      console.error('Error: HTTPS requires both --https-cert and --https-key')
      process.exit(1)
    }

    const { shutdown } = await startAppServer(
      {
        port,
        host,
        apiUrl: options.api as string | undefined,
        showQR: (options.qr as boolean) ?? true,
        version: VERSION,
        https: httpsEnabled,
        httpsCert,
        httpsKey,
        open: (options.open as boolean) ?? false,
      },
      { register, deregister }
    )

    const onSignal = () => {
      console.log('\n  Shutting down...')
      shutdown()
      process.exit(0)
    }
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)
  })

// Start command (both API + App)
const startCommand = new Command('start')
  .alias('serve')
  .description('Start both API and App servers')
  .argument('[path]', 'Directory to serve', '.')
  .option('-p, --port <port>', 'API port to listen on', '4200')
  .option('--app-port <port>', 'App port to listen on', '4201')
  .option('-h, --host <host>', 'Host to bind to', '0.0.0.0')
  .option('-i, --ignore <globs>', 'Ignore patterns (comma-separated)')
  .option('--no-readonly', 'Allow file modifications')
  .option('--hidden', 'Show hidden files')
  .option('--no-qr', 'Do not display QR code')
  .option('--https', 'Enable HTTPS')
  .option('--https-cert <path>', 'Path to TLS certificate (PEM)')
  .option('--https-key <path>', 'Path to TLS private key (PEM)')
  .option('-w, --watch', 'Enable live reload on file changes (dev mode)')
  .option('--cors <origin>', 'CORS allowed origin', '*')
  .option('--open', 'Open browser automatically')
  .action(async (pathArg: string, options: Record<string, unknown>) => {
    // Validate API port
    const requestedApiPort = parseInt(options.port as string, 10)
    if (isNaN(requestedApiPort) || requestedApiPort < 1 || requestedApiPort > 65535) {
      console.error('Error: Invalid API port number')
      process.exit(1)
    }

    // Validate App port
    const requestedAppPort = parseInt(options.appPort as string, 10)
    if (isNaN(requestedAppPort) || requestedAppPort < 1 || requestedAppPort > 65535) {
      console.error('Error: Invalid App port number')
      process.exit(1)
    }

    const host = options.host as string
    const apiPort = await getPort({ port: requestedApiPort, host })
    if (apiPort !== requestedApiPort) {
      console.log(`API port ${requestedApiPort} is busy. Using ${apiPort} instead.`)
    }

    const appPort = await getPort({ port: requestedAppPort, host })
    if (appPort !== requestedAppPort) {
      console.log(`App port ${requestedAppPort} is busy. Using ${appPort} instead.`)
    }

    const httpsEnabled = (options.https as boolean) ?? false
    const httpsCert = options.httpsCert ? resolve(options.httpsCert as string) : undefined
    const httpsKey = options.httpsKey ? resolve(options.httpsKey as string) : undefined
    if (httpsEnabled && (!httpsCert || !httpsKey)) {
      console.error('Error: HTTPS requires both --https-cert and --https-key')
      process.exit(1)
    }

    const protocol = httpsEnabled ? 'https' : 'http'
    const rootPath = resolve(pathArg)

    // Start API server (quiet mode)
    const { shutdown: apiShutdown } = await startApiServer(
      {
        root: rootPath,
        port: apiPort,
        host,
        readonly: (options.readonly as boolean) ?? true,
        showHidden: (options.hidden as boolean) ?? false,
        showQR: false,
        ignorePatterns: parseIgnorePatterns(options.ignore as string | undefined),
        version: VERSION,
        https: httpsEnabled,
        httpsCert,
        httpsKey,
        watch: (options.watch as boolean) ?? false,
        corsOrigin: (options.cors as string) ?? '*',
        quiet: true,
      },
      { register, deregister }
    )

    // Construct API URL for the App server
    const networkIp = getNetworkIp()
    const apiUrl = `${protocol}://${networkIp ?? '127.0.0.1'}:${apiPort}`

    // Start App server (quiet mode)
    const { shutdown: appShutdown } = await startAppServer(
      {
        port: appPort,
        host,
        apiUrl,
        showQR: false,
        version: VERSION,
        https: httpsEnabled,
        httpsCert,
        httpsKey,
        open: (options.open as boolean) ?? false,
        quiet: true,
      },
      { register, deregister }
    )

    // Print unified banner
    const localApiUrl = `${protocol}://127.0.0.1:${apiPort}`
    const localAppUrl = `${protocol}://127.0.0.1:${appPort}`
    const networkAppUrl = networkIp ? `${protocol}://${networkIp}:${appPort}` : null

    console.log()
    console.log('  \x1b[1mBrowsey\x1b[0m is running!')
    console.log()
    console.log(`  \x1b[2mAPI:\x1b[0m     ${localApiUrl}`)
    console.log(`  \x1b[2mApp:\x1b[0m     ${localAppUrl}`)
    if (networkAppUrl) {
      console.log(`  \x1b[2mNetwork:\x1b[0m ${networkAppUrl}`)
    }
    console.log()
    console.log(`  \x1b[2mServing:\x1b[0m ${rootPath}`)
    console.log(`  \x1b[2mMode:\x1b[0m    ${(options.readonly as boolean) ?? true ? 'read-only' : 'read-write'}`)
    console.log()

    const showQR = (options.qr as boolean) ?? true
    if (showQR && networkAppUrl) {
      console.log('  \x1b[2mScan to open:\x1b[0m')
      console.log()
      qrcode.generate(networkAppUrl, { small: true })
      console.log()
    }

    console.log('  \x1b[2mPress Ctrl+C to stop\x1b[0m')
    console.log()

    const onSignal = () => {
      console.log('\n  Shutting down...')
      apiShutdown()
      appShutdown()
      process.exit(0)
    }
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)
  })

program.addCommand(startCommand)
program.addCommand(apiCommand)
program.addCommand(appCommand)

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
    console.log('  \x1b[1mPID     PORT   KIND   DIRECTORY                         MODE\x1b[0m')
    console.log('  ' + '─'.repeat(68))

    for (const instance of instances) {
      const pid = instance.pid.toString().padEnd(7)
      const port = instance.port.toString().padEnd(6)
      const kind = instance.kind.padEnd(6)

      if (instance.kind === 'app') {
        const apiTarget = `→ ${instance.apiUrl || 'unknown'}`
        console.log(`  ${pid} ${port} ${kind} ${apiTarget}`)
      } else {
        const dir = truncatePath(instance.rootPath, 33).padEnd(33)
        const mode = instance.readonly ? 'read-only' : 'read-write'
        console.log(`  ${pid} ${port} ${kind} ${dir} ${mode}`)
      }
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

function getNetworkIp(): string | null {
  const interfaces = networkInterfaces()
  for (const iface of Object.values(interfaces)) {
    for (const config of iface ?? []) {
      if (config.family === 'IPv4' && !config.internal) {
        return config.address
      }
    }
  }
  return null
}

function truncatePath(path: string, maxLen: number): string {
  if (path.length <= maxLen) return path
  return '...' + path.slice(-(maxLen - 3))
}

program.parseAsync().catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : error}`)
  process.exit(1)
})
