import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from '../config.js'
import type { Logger } from '../logger.js'
import type { ActivationEngine } from '../presets/activate.js'
import { pauseAllMusic } from '../presets/pause-all.js'
import type { PresetRepository } from '../presets/repository.js'
import type { SonosDriver } from '../sonos/driver.js'
import type { SystemStateStore } from '../state/store.js'

export type HomeKitDeps = {
  config: Config
  logger: Logger
  repo: PresetRepository
  engine: ActivationEngine
  driver: SonosDriver
  store: SystemStateStore
}

export type HomeKitBridge = {
  /** Re-sync accessories after presets are created, renamed or deleted. */
  sync(): void
  setupUri(): string | undefined
  pincode: string
  stop(): Promise<void>
}

/** How long the momentary Pause All switch shows as on before resetting. */
const MOMENTARY_RESET_MS = 1000

/**
 * HAP ships these as ambient const enums, which `verbatimModuleSyntax` can't
 * read at runtime, so the documented values are inlined.
 */
const CATEGORY_BRIDGE = 2
const HAP_SERVICE_COMMUNICATION_FAILURE = -70402

/**
 * Embedded HAP bridge — no Homebridge required.
 *
 * Imported dynamically and only when `DOMOVOI_HOMEKIT=1`, so with the feature
 * off the HAP library is never loaded and nothing is advertised over mDNS.
 */
export async function startHomeKitBridge(deps: HomeKitDeps): Promise<HomeKitBridge> {
  const logger = deps.logger.child({ component: 'homekit' })

  const hap = await import('@homebridge/hap-nodejs')
  const { Accessory, Bridge, Characteristic, Service, uuid } = hap

  const storagePath = join(deps.config.dataDir, 'hap')
  mkdirSync(storagePath, { recursive: true })
  hap.HAPStorage.setCustomStoragePath(storagePath)

  const bridgeName = deps.config.homekit.name
  const bridge = new Bridge(bridgeName, uuid.generate(`domovoi:bridge:${bridgeName}`))

  /** Accessories currently published, keyed by the preset they represent. */
  const presetAccessories = new Map<string, InstanceType<typeof Accessory>>()

  const buildPresetAccessory = (presetId: string, name: string) => {
    const accessory = new Accessory(name, uuid.generate(`domovoi:preset:${presetId}`))
    const service = accessory.addService(Service.Switch, name)

    service
      .getCharacteristic(Characteristic.On)
      // Read straight from the same computation the UI uses, so the switch can
      // never disagree with the app about whether a preset is playing.
      .onGet(() => deps.engine.isStillPlaying(presetId))
      .onSet(async (value) => {
        const preset = deps.repo.get(presetId)
        if (!preset) return
        try {
          if (value) {
            await deps.engine.activate(preset)
          } else {
            await deps.engine.stop(presetId)
          }
        } catch (err) {
          logger.warn({ err, presetId, value }, 'homekit switch failed')
          // Surfaces in the Home app as "No Response" rather than silently lying.
          throw new hap.HapStatusError(HAP_SERVICE_COMMUNICATION_FAILURE)
        }
      })

    return accessory
  }

  const pauseAllAccessory = new Accessory('Pause All Music', uuid.generate('domovoi:pause-all'))
  const pauseAllService = pauseAllAccessory.addService(Service.Switch, 'Pause All Music')
  pauseAllService
    .getCharacteristic(Characteristic.On)
    // Momentary: "is all music paused" isn't a meaningful persistent state, so
    // it always reads off and springs back after being switched on.
    .onGet(() => false)
    .onSet(async (value) => {
      if (!value) return
      await pauseAllMusic({
        driver: deps.driver,
        store: deps.store,
        engine: deps.engine,
        logger,
      })
      setTimeout(() => {
        pauseAllService.updateCharacteristic(Characteristic.On, false)
      }, MOMENTARY_RESET_MS).unref()
    })
  bridge.addBridgedAccessory(pauseAllAccessory)

  const sync = () => {
    const wanted = deps.repo.list().filter((preset) => preset.homekitEnabled)
    const wantedIds = new Set(wanted.map((preset) => preset.id))

    for (const [presetId, accessory] of presetAccessories) {
      if (wantedIds.has(presetId)) continue
      bridge.removeBridgedAccessory(accessory, false)
      presetAccessories.delete(presetId)
    }

    for (const preset of wanted) {
      const existing = presetAccessories.get(preset.id)
      if (existing) {
        // A rename should follow through to the Home app.
        existing.getService(Service.Switch)?.updateCharacteristic(Characteristic.Name, preset.name)
        continue
      }
      const accessory = buildPresetAccessory(preset.id, preset.name)
      presetAccessories.set(preset.id, accessory)
      bridge.addBridgedAccessory(accessory)
    }

    logger.info({ switches: presetAccessories.size }, 'homekit accessories synced')
  }

  sync()

  bridge.publish({
    username: deriveUsername(bridgeName),
    pincode: deps.config.homekit.pin,
    port: 0,
    category: CATEGORY_BRIDGE,
    addIdentifyingMaterial: true,
  })

  // Push state changes so the Home app updates without being opened and polled.
  deps.store.on('change', () => {
    for (const [presetId, accessory] of presetAccessories) {
      accessory
        .getService(Service.Switch)
        ?.updateCharacteristic(Characteristic.On, deps.engine.isStillPlaying(presetId))
    }
  })

  logger.info({ pin: deps.config.homekit.pin }, 'homekit bridge published')

  return {
    sync,
    setupUri: () => bridge.setupURI(),
    pincode: deps.config.homekit.pin,
    stop: async () => {
      bridge.unpublish()
    },
  }
}

/**
 * HAP identifies a bridge by a MAC-shaped username. It must be stable across
 * restarts — a new one looks like a different bridge and forces re-pairing —
 * so it's derived from the bridge name rather than generated.
 */
function deriveUsername(seed: string): string {
  let hash = 0
  for (let index = 0; index < seed.length; index++) {
    hash = (Math.imul(31, hash) + seed.charCodeAt(index)) | 0
  }
  const bytes = [0x0e, 0x00, 0x00, 0x00, 0x00, 0x00]
  for (let index = 1; index < 6; index++) {
    bytes[index] = (hash >>> ((index - 1) * 6)) & 0xff
  }
  return bytes.map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(':')
}
