import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { basename } from 'path'
/**
 * Named import, not the default one. `bonjour-service` ships CJS with a
 * TypeScript-emitted `__importDefault` helper that reads `this`; Bun's bundler
 * rewrites module-scope `this` to `exports`, which makes the helper take its
 * "not an ES module" branch and hand back `{ default: moduleNamespace }`. The
 * default import then resolves to the namespace object, and `new` on it throws
 * "Object is not a constructor" — only in the bundle, never when run from
 * source. The named export sidesteps the helper entirely.
 */
import { Bonjour } from 'bonjour-service'

type BonjourAdvertiseOptions = {
  host: string
  port: number
  rootPath: string
  version: string
  https: boolean
  readonly: boolean
  /**
   * LAN address to advertise from — the same one the banner tells the phone to
   * use. Only the in-process responder needs it: it sends to 224.0.0.251 over
   * whatever the default route happens to be, and a VPN in TUN mode owns that
   * route on a lot of machines, where a point-to-point tunnel cannot carry
   * multicast and every announcement dies with `EHOSTUNREACH`. Null falls back
   * to the default route, which is right when there is no LAN address to prefer.
   */
  interfaceAddress: string | null
}

const BROWSEY_SERVICE_TYPE = 'browsey'

/** Stops the advertisement. Idempotent. */
type StopAdvertisement = () => void

/**
 * Hands the record to the operating system's own responder instead of running a
 * second one in this process. macOS only, and preferred there for a blunt
 * reason: `mDNSResponder` already owns UDP 5353 and the kernel will not deliver
 * multicast to a second socket on that port, so an in-process responder can
 * announce itself but never hear — let alone answer — a query. A phone that was
 * already browsing would catch the announcement; one that opens the app a minute
 * later asks, gets silence, and shows nothing. Registering through `dns-sd` also
 * gets name-conflict probing and goodbye packets for free.
 */
const DNS_SD_BIN = '/usr/bin/dns-sd'

export function startBonjourAdvertisement(options: BonjourAdvertiseOptions): StopAdvertisement {
  if (process.platform === 'darwin' && existsSync(DNS_SD_BIN)) {
    return advertiseViaSystemResponder(options)
  }
  return advertiseInProcess(options)
}

export function getBrowseyServiceType(): string {
  return BROWSEY_SERVICE_TYPE
}

function serviceName(rootPath: string): string {
  return `Browsey (${basename(rootPath) || 'root'})`
}

/** What a discovering client reads to tell instances apart before connecting. */
function serviceTxt(options: BonjourAdvertiseOptions): Record<string, string> {
  return {
    host: options.host,
    path: options.rootPath,
    protocol: options.https ? 'https' : 'http',
    readonly: options.readonly ? '1' : '0',
    version: options.version,
  }
}

function advertiseViaSystemResponder(options: BonjourAdvertiseOptions): StopAdvertisement {
  const txt = Object.entries(serviceTxt(options)).map(([key, value]) => `${key}=${value}`)
  const child = spawn(
    DNS_SD_BIN,
    ['-R', serviceName(options.rootPath), `_${BROWSEY_SERVICE_TYPE}._tcp`, 'local.', String(options.port), ...txt],
    // The registration lives exactly as long as the process holding it, so this
    // child has to outlive the call and is killed by the returned stop.
    { stdio: 'ignore' }
  )

  let stopped = false
  child.on('error', (error) => {
    console.warn(`Warning: Bonjour advertisement failed: ${error.message}`)
  })
  child.on('exit', (code) => {
    // Only worth saying when nobody asked for it: `dns-sd` holds the record for
    // its whole lifetime, so an exit on its own means the service just vanished.
    if (!stopped) console.warn(`Warning: Bonjour advertisement ended unexpectedly (dns-sd exit ${code})`)
  })

  return () => {
    if (stopped) return
    stopped = true
    child.kill()
  }
}

/**
 * The options bag is forwarded verbatim to `multicast-dns`, whose own options —
 * `interface` and `bind` among them — are absent from the published
 * `Partial<ServiceConfig>` signature. Named here so the cast below is one narrow
 * thing instead of an `any` at the call site.
 */
type ResponderOptions = { interface?: string; bind?: string }

function advertiseInProcess(options: BonjourAdvertiseOptions): StopAdvertisement {
  const responder: ResponderOptions = {
    interface: options.interfaceAddress ?? undefined,
    /**
     * Wildcard on purpose. `multicast-dns` reuses `interface` as the bind
     * address, and a socket bound to a single unicast address receives no
     * multicast at all on BSD. Binding wide keeps `interface` doing only what it
     * is passed for: choosing which interface announcements leave from.
     */
    bind: '0.0.0.0',
  }

  /**
   * Announcements are sent from a datagram callback, so a failure there arrives
   * long after this function has returned, where the library's default handler
   * rethrows it — off the stack, which takes the whole server down. Discovery is
   * a convenience the phone can do without, so it is warned about once and then
   * left alone: the failure repeats on every announcement and every query
   * response, and none of the repeats say anything new.
   */
  let warned = false
  const bonjour = new Bonjour(responder as ConstructorParameters<typeof Bonjour>[0], (error: unknown) => {
    if (warned) return
    warned = true
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`Warning: Bonjour advertisement stopped working: ${message}`)
  })

  const service = bonjour.publish({
    name: serviceName(options.rootPath),
    type: BROWSEY_SERVICE_TYPE,
    port: options.port,
    txt: serviceTxt(options),
  })

  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    if (typeof service.stop === 'function') {
      service.stop()
    }
    bonjour.destroy()
  }
}
