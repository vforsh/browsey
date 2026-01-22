import Bonjour, { type Service } from 'bonjour-service'
import { hostname } from 'os'

let bonjourInstance: Bonjour | null = null
let publishedService: Service | null = null

export function advertiseService(port: number, rootPath: string): () => void {
  bonjourInstance = new Bonjour()

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
