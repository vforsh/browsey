import { Bonjour, type Service } from 'bonjour-service'
import { hostname, networkInterfaces } from 'os'

let bonjourInstance: Bonjour | null = null
let publishedService: Service | null = null

/**
 * Get the primary network interface IP address.
 * On macOS, prefers en0 (Wi-Fi/Ethernet). Falls back to first non-internal IPv4.
 */
function getPrimaryInterface(): string | undefined {
  const nets = networkInterfaces()

  // On macOS, en0 is typically the primary interface (Wi-Fi or built-in Ethernet)
  const en0 = nets['en0']
  if (en0) {
    const ipv4 = en0.find(n => n.family === 'IPv4' && !n.internal)
    if (ipv4) return ipv4.address
  }

  // Fallback: find any non-internal IPv4 address
  for (const name of Object.keys(nets)) {
    const net = nets[name]
    if (!net) continue
    const ipv4 = net.find(n => n.family === 'IPv4' && !n.internal)
    if (ipv4) return ipv4.address
  }

  return undefined
}

export function advertiseService(port: number, rootPath: string): () => void {
  const iface = getPrimaryInterface()

  // Specify interface to avoid multicast on all interfaces (which can break networking)
  // Also provide error callback to prevent unhandled errors from crashing
  bonjourInstance = new Bonjour(
    iface ? { interface: iface } : {},
    (err) => {
      // Log but don't crash - Bonjour is optional functionality
      console.warn('[bonjour] mDNS error:', err.message)
    }
  )

  // Add port to make service name unique per instance
  const serviceName = `Browsey on ${hostname()} (${port})`

  publishedService = bonjourInstance.publish({
    name: serviceName,
    type: 'browsey',
    port: port,
    txt: {
      version: '1.0',
      path: rootPath,
    },
    probe: false, // Skip probing to avoid conflicts with stale entries
  })

  return () => {
    if (publishedService) {
      publishedService.stop?.()
      publishedService = null
    }
    if (bonjourInstance) {
      bonjourInstance.destroy()
      bonjourInstance = null
    }
  }
}
