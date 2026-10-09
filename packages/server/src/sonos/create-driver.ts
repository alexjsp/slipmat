import type { Config } from '../config.js'
import type { Logger } from '../logger.js'
import type { SonosDriver } from './driver.js'
import { createDemoHousehold } from './fake-demo.js'
import { RealSonosDriver } from './real-driver.js'

export function createDriver(config: Config, logger: Logger): SonosDriver {
  if (config.fakeSonos) {
    logger.warn('SLIPMAT_FAKE_SONOS is set — using the in-memory household, no real speakers')
    // A soundbar on TV audio (which pause-all must skip), a grouped pair
    // playing from a queue, a radio stream, and some playlists to build from.
    return createDemoHousehold()
  }
  // The library reads its callback address straight from the environment, the
  // first time it subscribes to anything. Without this the setting was parsed
  // and then ignored.
  if (config.callbackHost && !process.env.SONOS_LISTENER_HOST) {
    process.env.SONOS_LISTENER_HOST = config.callbackHost
  }
  return new RealSonosDriver({ logger, seedIp: config.seedIp })
}
