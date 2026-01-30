import { Bonjour, type Service, type ServiceConfig } from 'bonjour-service'
import { hostname, networkInterfaces } from 'os'

let bonjourInstance: Bonjour | null = null
let publishedService: Service | null = null

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

  bonjourInstance = new Bonjour(
    iface ? { interface: iface } as unknown as Partial<ServiceConfig> : undefined,
    (err: Error) => {
      console.warn('[bonjour] mDNS error:', err.message)
    }
  )

  const serviceName = `Browsey on ${hostname()} (${port})`

  publishedService = bonjourInstance.publish({
    name: serviceName,
    type: 'browsey',
    port: port,
    txt: {
      version: '1.0',
      path: rootPath,
    },
    probe: false,
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
