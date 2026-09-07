import { Command } from 'commander'
import getPort from 'get-port'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { hostname, networkInterfaces } from 'os'
import qrcode from 'qrcode-terminal'
import { startApiServer } from '@vforsh/browsey-api'
import { startAppServer } from '@vforsh/browsey-app'
import { parseIgnorePatterns, describeAccessProtection } from '@vforsh/browsey-shared'
import type { AgentsOptions, InstanceInfo } from '@vforsh/browsey-shared'
import { listInstances, findAllMatchingInstances, stopInstance, register, deregister, parseTarget } from './registry.js'
import { getAgentTokenPath, readAgentToken, readOrCreateAgentToken } from './agent-token.js'
import { getAccessTokenPath, readAccessToken, readAccessTokenFile, readOrCreateAccessToken } from './access-token.js'

export const VERSION = '0.1.0'

/**
 * Agents are on by default; the persisted token is what actually gates the
 * endpoints. `--agents-token` overrides for this run without persisting.
 */
function resolveAgentsOptions(options: Record<string, unknown>): AgentsOptions {
  if (((options.agents as boolean) ?? true) === false) {
    return { enabled: false, token: '' }
  }

  const override = (options.agentsToken as string | undefined)?.trim()
  return { enabled: true, token: override || readOrCreateAgentToken() }
}

/**
 * The server-wide access token, or undefined to leave the API unprotected — the
 * default, so every existing LAN setup and every older client keeps working.
 *
 * Never a raw token in `argv`: a process list is readable by every user on the
 * machine and shell history keeps it forever. Hence a boolean flag, a path, or
 * the environment — the environment first, so a launchd-managed instance can be
 * configured entirely outside the command line.
 *
 * `createDefault` is the difference between starting a server (mint the default
 * file if it is not there yet, exactly as the agent token does) and reporting on
 * one (`browsey pair`, which must never invent a token the server is not using).
 */
type ResolvedAccessToken = {
  token: string
  /** Recorded in the registry so a reload resolves this same secret again. */
  file?: string
  fromEnv?: boolean
}

function resolveAccessToken(
  options: Record<string, unknown>,
  { createDefault }: { createDefault: boolean }
): ResolvedAccessToken | undefined {
  const fromEnv = process.env.BROWSEY_ACCESS_TOKEN?.trim()
  if (fromEnv) return { token: fromEnv, fromEnv: true }

  const file = (options.accessTokenFile as string | undefined)?.trim()
  if (file) {
    const path = resolve(file)
    const token = readAccessTokenFile(path)
    if (!token) {
      console.error(`Error: Could not read an access token from ${path}`)
      process.exit(1)
    }
    return { token, file: path }
  }

  if (((options.accessToken as boolean) ?? false) === false) {
    return undefined
  }

  if (createDefault) {
    return { token: readOrCreateAccessToken(), file: getAccessTokenPath() }
  }

  const token = readAccessToken()
  if (!token) {
    console.error('Error: No access token found.')
    console.error(`Expected at ${getAccessTokenPath()}.`)
    console.error('Start a server with --access-token first, or pass --access-token-file <path>.')
    process.exit(1)
  }
  return { token, file: getAccessTokenPath() }
}

/** Spreads a resolved token into the server options, or nothing at all. */
function accessOptions(
  resolved: ResolvedAccessToken | undefined
): {
  accessToken?: string
  accessTokenFile?: string
  accessTokenFromEnv?: boolean
} {
  if (!resolved) return {}
  return {
    accessToken: resolved.token,
    ...(resolved.file ? { accessTokenFile: resolved.file } : {}),
    ...(resolved.fromEnv ? { accessTokenFromEnv: true } : {}),
  }
}

/**
 * The token a reload must come back up with: the same one, from wherever the
 * running instance got it. Refusing is the safe failure here — a reload that
 * quietly mints a different secret leaves the server protected and every
 * paired phone locked out, which is worse than not reloading.
 */
function reloadAccessToken(source: {
  accessTokenFile?: string
  accessTokenFromEnv?: boolean
}): ResolvedAccessToken {
  if (source.accessTokenFromEnv) {
    const fromEnv = process.env.BROWSEY_ACCESS_TOKEN?.trim()
    if (fromEnv) return { token: fromEnv, fromEnv: true }
    console.error('Error: This instance took its access token from BROWSEY_ACCESS_TOKEN,')
    console.error('which is not set in this shell. Set it and reload again, or stop the')
    console.error('instance and start a new one.')
    process.exit(1)
  }
  const path = source.accessTokenFile ?? getAccessTokenPath()
  const token = readAccessTokenFile(path)
  if (!token) {
    console.error(`Error: This instance took its access token from ${path},`)
    console.error('which can no longer be read. Restore it and reload again.')
    process.exit(1)
  }
  return { token, file: path }
}

/** Cloudflare Access service token: the pair that gets a request past the edge. */
type CloudflareServiceToken = {
  id: string
  secret: string
}

/**
 * Same rule as the access token — secrets arrive through the environment or a
 * file, never as flag values. A half pair is an error rather than a payload the
 * client would have to reject.
 */
function resolveCloudflareCredentials(
  options: Record<string, unknown>
): CloudflareServiceToken | undefined {
  const envId = process.env.CF_ACCESS_CLIENT_ID?.trim()
  const envSecret = process.env.CF_ACCESS_CLIENT_SECRET?.trim()
  if (envId || envSecret) {
    if (!envId || !envSecret) {
      console.error('Error: CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET must both be set.')
      process.exit(1)
    }
    return { id: envId, secret: envSecret }
  }

  const file = (options.cfCredentialsFile as string | undefined)?.trim()
  if (!file) return undefined

  const path = resolve(file)
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (error) {
    console.error(`Error: Could not read Cloudflare credentials from ${path}`)
    console.error(`  ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }

  const record = parsed as { id?: unknown; secret?: unknown } | null
  const id = typeof record?.id === 'string' ? record.id.trim() : ''
  const secret = typeof record?.secret === 'string' ? record.secret.trim() : ''
  if (!id || !secret) {
    console.error(`Error: ${path} must be a JSON object with non-empty "id" and "secret".`)
    process.exit(1)
  }

  return { id, secret }
}

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
  .option('--no-bonjour', 'Disable Bonjour/mDNS service advertisement')
  .option('-w, --watch', 'Enable live reload on file changes (dev mode)')
  .option('--cors <origin>', 'CORS allowed origin', '*')
  .option('--no-agents', 'Disable the agent thread launch endpoints')
  .option('--agents-token <token>', 'Use this agent token instead of the persisted one')
  .option('--access-token', `Require X-Browsey-Access-Token, read from ${getAccessTokenPath()}`)
  .option('--access-token-file <path>', 'Require X-Browsey-Access-Token, read from this file')
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
        bonjour: (options.bonjour as boolean) ?? true,
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
        agents: resolveAgentsOptions(options),
        ...accessOptions(resolveAccessToken(options, { createDefault: true })),
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

// API reload subcommand
apiCommand
  .command('reload')
  .alias('restart')
  .description('Restart an API server instance (picks up code changes)')
  .argument('<target>', 'Port (e.g., :4200 or 4200) or PID of the API instance')
  .action(async (target: string) => {
    // Normalize target: allow both "4200" and ":4200"
    const portTarget = target.startsWith(':') ? target : `:${target}`
    const instances = listInstances()
    const instance = instances.find((i) => {
      if (i.kind !== 'api') return false
      const parsed = parseTarget(portTarget)
      if (parsed.type === 'port') return i.port === parsed.value
      if (parsed.type === 'pid') return i.pid === parsed.value
      return false
    })

    if (!instance) {
      console.error(`Error: No API instance found matching "${target}"`)
      console.error('Run "browsey list" to see running instances.')
      process.exit(1)
    }

    console.log(`Restarting API server on port ${instance.port}...`)

    // Save instance config before stopping
    const {
      port,
      host,
      bonjour,
      rootPath,
      readonly,
      https,
      httpsCert,
      httpsKey,
      showQR,
      showHidden,
      ignorePatterns,
      watch,
      corsOrigin,
      agents,
      accessToken,
      accessTokenFile,
      accessTokenFromEnv,
    } = instance

    // Stop the instance
    stopInstance(instance.pid, false)

    // Wait a moment for port to be released
    await new Promise((r) => setTimeout(r, 500))

    // Start new instance with same config
    const { shutdown } = await startApiServer(
      {
        root: rootPath,
        port,
        host,
        bonjour: bonjour ?? true,
        readonly,
        showHidden: showHidden ?? false,
        showQR: showQR ?? true,
        ignorePatterns: ignorePatterns ?? [],
        version: VERSION,
        https: https ?? false,
        httpsCert,
        httpsKey,
        watch: watch ?? false,
        corsOrigin: corsOrigin ?? '*',
        agents: resolveAgentsOptions({ agents: agents ?? true }),
        // The registry records only that protection was on and where the value
        // came from, never the value. A reload must neither drop the origin's
        // defences nor mint a *different* secret — the second would lock out
        // every phone already paired with this server.
        ...accessOptions(
          accessToken
            ? reloadAccessToken({ accessTokenFile, accessTokenFromEnv })
            : undefined
        ),
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
  .option('--open', 'Open browser automatically')
  .option('--https', 'Enable HTTPS')
  .option('--https-cert <path>', 'Path to TLS certificate (PEM)')
  .option('--https-key <path>', 'Path to TLS private key (PEM)')
  .option('--no-qr', 'Do not display QR code')
  .option('-w, --watch', 'Watch UI files and live reload on changes (dev mode)')
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
        showQR: (options.qr as boolean) ?? true,
        version: VERSION,
        https: httpsEnabled,
        httpsCert,
        httpsKey,
        open: (options.open as boolean) ?? false,
        watch: (options.watch as boolean) ?? false,
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

// App reload subcommand
appCommand
  .command('reload')
  .alias('restart')
  .description('Restart an app server instance (picks up code changes)')
  .argument('<target>', 'Port (e.g., :4211 or 4211) or PID of the app instance')
  .action(async (target: string) => {
    // Normalize target: allow both "4211" and ":4211"
    const portTarget = target.startsWith(':') ? target : `:${target}`
    const instances = listInstances()
    const instance = instances.find((i) => {
      if (i.kind !== 'app') return false
      const parsed = parseTarget(portTarget)
      if (parsed.type === 'port') return i.port === parsed.value
      if (parsed.type === 'pid') return i.pid === parsed.value
      return false
    })

    if (!instance) {
      console.error(`Error: No app instance found matching "${target}"`)
      console.error('Run "browsey list" to see running instances.')
      process.exit(1)
    }

    console.log(`Restarting app server on port ${instance.port}...`)

    // Save instance config before stopping
    const { port, host, https, httpsCert, httpsKey, showQR } = instance

    // Stop the instance
    stopInstance(instance.pid, false)

    // Wait a moment for port to be released
    await new Promise((r) => setTimeout(r, 500))

    // Start new instance with same config
    const { shutdown } = await startAppServer(
      {
        port,
        host,
        showQR: showQR ?? true,
        version: VERSION,
        https: https ?? false,
        httpsCert,
        httpsKey,
        open: false,
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
  .option('--no-bonjour', 'Disable Bonjour/mDNS service advertisement')
  .option('-w, --watch', 'Enable live reload on file changes (dev mode)')
  .option('--cors <origin>', 'CORS allowed origin', '*')
  .option('--no-agents', 'Disable the agent thread launch endpoints')
  .option('--agents-token <token>', 'Use this agent token instead of the persisted one')
  .option('--access-token', `Require X-Browsey-Access-Token, read from ${getAccessTokenPath()}`)
  .option('--access-token-file <path>', 'Require X-Browsey-Access-Token, read from this file')
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
    const agentsOptions = resolveAgentsOptions(options)
    const access = resolveAccessToken(options, { createDefault: true })

    // Start API server (quiet mode)
    const { shutdown: apiShutdown } = await startApiServer(
      {
        root: rootPath,
        port: apiPort,
        host,
        bonjour: (options.bonjour as boolean) ?? true,
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
        agents: agentsOptions,
        ...accessOptions(access),
        quiet: true,
      },
      { register, deregister }
    )

    // Construct URLs for QR code and --open
    const networkIp = getNetworkIp()
    const networkApiUrl = `${protocol}://${networkIp ?? '127.0.0.1'}:${apiPort}`
    const networkAppUrl = networkIp ? `${protocol}://${networkIp}:${appPort}` : null
    const appUrlWithApi = networkAppUrl
      ? `${networkAppUrl}?api=${encodeURIComponent(networkApiUrl)}`
      : `${protocol}://127.0.0.1:${appPort}?api=${encodeURIComponent(`${protocol}://127.0.0.1:${apiPort}`)}`

    // Start App server (quiet mode)
    const { shutdown: appShutdown } = await startAppServer(
      {
        port: appPort,
        host,
        showQR: false,
        version: VERSION,
        https: httpsEnabled,
        httpsCert,
        httpsKey,
        open: (options.open as boolean) ?? false,
        openUrl: appUrlWithApi,
        quiet: true,
      },
      { register, deregister }
    )

    // Print unified banner
    const localApiUrl = `${protocol}://127.0.0.1:${apiPort}`
    const localAppUrl = `${protocol}://127.0.0.1:${appPort}`

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
    console.log(`  \x1b[2mAccess:\x1b[0m  ${describeAccessProtection(access?.token)}`)
    console.log(
      `  \x1b[2mAgents:\x1b[0m  ${
        agentsOptions.enabled
          ? "enabled — run 'browsey pair' to pair the mobile app"
          : 'disabled'
      }`
    )
    console.log()

    const showQR = (options.qr as boolean) ?? true
    if (showQR && networkAppUrl) {
      console.log('  \x1b[2mScan to open:\x1b[0m')
      console.log()
      qrcode.generate(appUrlWithApi, { small: true })
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

// Pair command
program
  .command('pair')
  .description('Show the agent token and a pairing QR code for the mobile app')
  .argument('[target]', 'PID, :port, or path substring of the API instance to pair with')
  .option('--url <url>', 'Override the URL advertised in the QR payload (e.g. the tunnel hostname)')
  .option('--name <name>', 'Override the machine name shown in the app')
  .option('--access-token', `Include the access token from ${getAccessTokenPath()}`)
  .option('--access-token-file <path>', 'Include the access token read from this file')
  .option(
    '--cf-credentials-file <path>',
    'Include a Cloudflare Access service token from this JSON file: {"id": "...", "secret": "..."}'
  )
  .action((target: string | undefined, options: Record<string, unknown>) => {
    const urlOverride = (options.url as string | undefined)?.trim()
    // A target the user typed is still resolved strictly even alongside --url,
    // so a typo is an error rather than a silently unprotected payload.
    const instance = resolvePairInstance(target, Boolean(target) || !urlOverride)

    const url = urlOverride ?? (instance ? instancePairUrl(instance) : null)
    if (!url) {
      console.error('Error: Could not determine the API URL.')
      console.error('Start an API instance, or pass --url https://<host>')
      process.exit(1)
    }

    let parsedUrl: URL
    try {
      parsedUrl = new URL(url)
    } catch {
      console.error(`Error: Invalid URL: ${url}`)
      process.exit(1)
    }

    // Asked for explicitly, or inferred from the instance the phone will talk to
    // — a protected server that paired without its token is a phone that 401s on
    // its very first request.
    const accessRequested =
      Boolean(options.accessToken) ||
      Boolean(options.accessTokenFile) ||
      Boolean(process.env.BROWSEY_ACCESS_TOKEN?.trim()) ||
      instance?.accessToken === true
    const access = accessRequested
      ? resolveAccessToken({ ...options, accessToken: true }, { createDefault: false })
      : undefined
    const cf = resolveCloudflareCredentials(options)

    // The phone checks the origin token on every request; the Cloudflare pair
    // only gets it past an edge. A payload with the second and not the first
    // describes a server it can reach but not talk to, and the client refuses
    // to store it — so refuse to print it.
    if (cf && !access) {
      console.error('Error: Cloudflare credentials need an access token alongside them.')
      console.error('The origin checks X-Browsey-Access-Token on every request; Cloudflare')
      console.error('only gets the request that far. Pass --access-token as well.')
      process.exit(1)
    }

    if ((access || cf) && parsedUrl.protocol !== 'https:') {
      console.error(`Error: Refusing to put remote credentials in a payload for ${url}`)
      console.error('Access tokens and Cloudflare credentials require an https: URL.')
      console.error('Pass --url https://<your tunnel hostname>, or serve the LAN over TLS')
      console.error('with --https --https-cert <pem> --https-key <pem>.')
      process.exit(1)
    }

    const token = readAgentToken()
    if (!token && !access && !cf) {
      console.error('Error: No agent token found.')
      console.error(`Expected at ${getAgentTokenPath()}.`)
      console.error('Start a server with agents enabled first (they are on by default).')
      process.exit(1)
    }

    const name = (options.name as string | undefined) ?? hostname()
    // JSON, not a URL: a stray scan by a stock camera app must not turn these
    // secrets into an HTTP GET or a browser history entry. v1 stays on the wire
    // whenever there is nothing remote to carry, so older clients keep pairing.
    const payload = JSON.stringify({
      v: access || cf ? 2 : 1,
      kind: 'browsey-pair',
      url,
      name,
      ...(token ? { token } : {}),
      ...(access ? { access } : {}),
      ...(cf ? { cf } : {}),
    })

    console.log()
    console.log('  \x1b[1mBrowsey pairing\x1b[0m')
    console.log()
    console.log(`  \x1b[2mServer:\x1b[0m ${url}`)
    console.log(`  \x1b[2mName:\x1b[0m   ${name}`)
    if (token) {
      console.log(`  \x1b[2mToken:\x1b[0m  ${token}`)
    }
    if (access) {
      console.log('  \x1b[2mAccess:\x1b[0m in the QR payload')
    }
    if (cf) {
      console.log(`  \x1b[2mCF:\x1b[0m     ${cf.id} (secret in the QR payload)`)
    }
    console.log()
    console.log('  \x1b[2mScan in Browsey (Connect → Scan QR):\x1b[0m')
    console.log()
    qrcode.generate(payload, { small: true })
    console.log()
    if (token) {
      console.log('  \x1b[2mAnyone with this token can run agents on this machine.\x1b[0m')
      console.log()
    }
  })

/** The API instance to pair with, preferring an explicit target. */
function resolvePairInstance(target: string | undefined, strict: boolean): InstanceInfo | null {
  const apiInstances = listInstances().filter((instance) => instance.kind === 'api')
  if (apiInstances.length === 0) return null

  const matching = target
    ? findAllMatchingInstances(target).filter((instance) => instance.kind === 'api')
    : apiInstances

  if (matching.length === 0) {
    if (!strict) return null
    console.error(`Error: No API instance found matching "${target}"`)
    process.exit(1)
  }
  if (matching.length > 1) {
    if (!strict) return null
    console.error(`Found ${matching.length} API instances:`)
    for (const instance of matching) {
      console.error(`  PID ${instance.pid}: ${instance.rootPath} (port ${instance.port})`)
    }
    console.error('\nPlease specify one (PID, :port, or path substring).')
    process.exit(1)
  }

  return matching[0]!
}

/** Network URL an instance is reachable at from the LAN. */
function instancePairUrl(instance: InstanceInfo): string {
  const protocol = instance.https ? 'https' : 'http'
  const isWildcard = instance.host === '0.0.0.0' || instance.host === '::'
  const host = isWildcard ? getNetworkIp() ?? '127.0.0.1' : instance.host
  return `${protocol}://${host}:${instance.port}`
}

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
        console.log(`  ${pid} ${port} ${kind} (browser-configured)`)
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
