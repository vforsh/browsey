import { basename } from 'path'
import Bonjour from 'bonjour-service'

type BonjourAdvertiseOptions = {
  host: string
  port: number
  rootPath: string
  version: string
  https: boolean
  readonly: boolean
}

const BROWSEY_SERVICE_TYPE = 'browsey'

export function startBonjourAdvertisement(options: BonjourAdvertiseOptions): () => void {
  const bonjour = new Bonjour()
  const directoryName = basename(options.rootPath) || 'root'
  const serviceName = `Browsey (${directoryName})`

  const service = bonjour.publish({
    name: serviceName,
    type: BROWSEY_SERVICE_TYPE,
    port: options.port,
    txt: {
      host: options.host,
      path: options.rootPath,
      protocol: options.https ? 'https' : 'http',
      readonly: options.readonly ? '1' : '0',
      version: options.version,
    },
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

export function getBrowseyServiceType(): string {
  return BROWSEY_SERVICE_TYPE
}
