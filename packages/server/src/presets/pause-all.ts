import type { PauseAllResponse } from '@domovoi/shared'
import type { SonosDriver } from '../sonos/driver.js'
import { classifyPlaybackKind, isProtectedFromPauseAll } from '../sonos/uris.js'
import type { SystemStateStore } from '../state/store.js'
import type { ActivationEngine } from './activate.js'

/**
 * Structural, so this works with both the app logger and Fastify's per-request
 * child logger — the latter is what gives a webhook's log lines their request id.
 */
type MinimalLogger = {
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
}

export type PauseAllDeps = {
  driver: SonosDriver
  store: SystemStateStore
  engine: ActivationEngine
  logger: MinimalLogger
}

/**
 * Silence the house without touching the TV.
 *
 * "Everything" deliberately means everything playing *music*: a soundbar on TV
 * audio or a turntable on line-in keeps going, because cutting those off is
 * never what someone means when they ask for the music to stop.
 */
export async function pauseAllMusic(deps: PauseAllDeps): Promise<PauseAllResponse> {
  const paused: string[] = []
  const skipped: string[] = []

  for (const group of deps.driver.snapshot().groups) {
    if (group.transportState !== 'PLAYING') continue

    const kind = classifyPlaybackKind(group.transportUri, group.currentTrackUri)
    if (isProtectedFromPauseAll(kind)) {
      skipped.push(group.coordinatorZoneId)
      continue
    }

    try {
      await deps.driver.pause(group.coordinatorZoneId)
      paused.push(group.coordinatorZoneId)
    } catch (err) {
      deps.logger.warn({ err, zoneId: group.coordinatorZoneId }, 'pause-all: group would not pause')
    }
  }

  // Anything we just silenced is no longer a live preset, so its UI badge and
  // HomeKit switch need to go off with it.
  deps.store.refresh()
  deps.engine.reconcile()

  deps.logger.info({ paused: paused.length, skipped: skipped.length }, 'paused all music')
  return { pausedGroupIds: paused, skippedGroupIds: skipped }
}
