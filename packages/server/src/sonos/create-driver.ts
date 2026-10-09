import type { Config } from '../config.js'
import type { Logger } from '../logger.js'
import type { SonosDriver } from './driver.js'
import { FakeSonosDriver } from './fake-driver.js'
import { RealSonosDriver } from './real-driver.js'

export function createDriver(config: Config, logger: Logger): SonosDriver {
  if (config.fakeSonos) {
    logger.warn('SLIPMAT_FAKE_SONOS is set — using the in-memory household, no real speakers')
    // Seed a scenario worth looking at: a soundbar on TV audio (which pause-all
    // must skip) and a grouped pair playing from a queue.
    const fake = new FakeSonosDriver({ tvZoneIds: ['RINCON_LIVING01400'] })
    void fake.start().then(async () => {
      await fake.joinGroup('RINCON_KITCHEN01400', ['RINCON_BEDROOM01400'])
      fake.setNowPlaying('RINCON_KITCHEN01400', {
        transportUri: 'x-rincon-queue:RINCON_KITCHEN01400#0',
        track: {
          uri: 'x-sonos-spotify:spotify%3atrack%3ademo',
          title: 'Windowlicker',
          artist: 'Aphex Twin',
          album: 'Windowlicker',
          artUrl: null,
          durationSeconds: 366,
        },
        positionSeconds: 94,
      })
    })
    return fake
  }
  // The library reads its callback address straight from the environment, the
  // first time it subscribes to anything. Without this the setting was parsed
  // and then ignored.
  if (config.callbackHost && !process.env.SONOS_LISTENER_HOST) {
    process.env.SONOS_LISTENER_HOST = config.callbackHost
  }
  return new RealSonosDriver({ logger, seedIp: config.seedIp })
}
