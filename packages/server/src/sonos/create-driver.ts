import type { Config } from '../config.js'
import type { Logger } from '../logger.js'
import type { SonosDriver } from './driver.js'
import { FakeSonosDriver } from './fake-driver.js'
import { RealSonosDriver } from './real-driver.js'

export function createDriver(config: Config, logger: Logger): SonosDriver {
  if (config.fakeSonos) {
    logger.warn('DOMOVOI_FAKE_SONOS is set — using the in-memory household, no real speakers')
    return new FakeSonosDriver()
  }
  return new RealSonosDriver({ logger, seedIp: config.seedIp })
}
