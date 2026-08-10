import type { PresetInput } from '@domovoi/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/index.js'
import { createLogger } from '../logger.js'
import { ActivationEngine } from '../presets/activate.js'
import { PresetRepository } from '../presets/repository.js'
import type { DriverBrowseItem } from '../sonos/driver.js'
import { FakeSonosDriver } from '../sonos/fake-driver.js'
import { SourceCache } from '../sources/cache.js'
import { SourceResolver } from '../sources/resolver.js'
import { SystemStateStore } from '../state/store.js'
import { TriggerRepository } from './repository.js'
import { Scheduler } from './scheduler.js'

const logger = createLogger({ logLevel: 'error' })

const KITCHEN = 'RINCON_KITCHEN01400'
const BEDROOM = 'RINCON_BEDROOM01400'
const OFFICE = 'RINCON_OFFICE01400'
const LIVING = 'RINCON_LIVING01400'

function track(uri: string): DriverBrowseItem {
  return {
    id: uri,
    title: uri,
    subtitle: null,
    album: null,
    artUrl: null,
    isContainer: false,
    uri,
    metadata: null,
  }
}

// 2026-06-15 07:30 UTC is a Monday.
const MONDAY_0730 = new Date('2026-06-15T07:30:00Z')

describe('Scheduler', () => {
  let driver: FakeSonosDriver
  let presets: PresetRepository
  let triggers: TriggerRepository
  let engine: ActivationEngine
  let store: SystemStateStore
  let now: Date

  const presetInput = (overrides: Partial<PresetInput> = {}): PresetInput => ({
    name: 'Morning',
    icon: null,
    color: null,
    zones: [
      { zoneId: KITCHEN, volume: 25, isCoordinator: true },
      { zoneId: BEDROOM, volume: 15, isCoordinator: false },
    ],
    sources: [{ kind: 'sonos_playlist', ref: 'SQ:1', label: 'Jazz' }],
    shuffle: true,
    repeatAll: true,
    dedupe: true,
    pauseOthers: false,
    crossfade: false,
    homekitEnabled: false,
    ...overrides,
  })

  const makeScheduler = () =>
    new Scheduler({
      triggers,
      presets,
      engine,
      driver,
      store,
      logger,
      timeZone: 'UTC',
      now: () => now,
    })

  beforeEach(async () => {
    now = MONDAY_0730
    driver = new FakeSonosDriver({ tvZoneIds: [] })
    await driver.start()
    driver.setBrowseResult('SQ:1', [track('jazz-1'), track('jazz-2')])

    const db = openDatabase({ inMemory: true })
    store = new SystemStateStore(driver)
    const cache = new SourceCache(
      db,
      new SourceResolver({ driver, logger, allowScratchQueueExpansion: true }),
      logger,
    )
    presets = new PresetRepository(db)
    triggers = new TriggerRepository(db)
    engine = new ActivationEngine({
      db,
      driver,
      store,
      cache,
      logger,
      repo: presets,
      timeZone: 'UTC',
      now: () => now,
    })
  })

  const zoneNames = () =>
    new Map([
      [KITCHEN, 'Kitchen'],
      [BEDROOM, 'Bedroom'],
      [OFFICE, 'Office'],
      [LIVING, 'Living Room'],
    ])

  const schedule = (presetId: string | null, config: Record<string, unknown>) =>
    triggers.create({
      presetId,
      kind: 'schedule',
      label: 'Test',
      enabled: true,
      config: { daysOfWeek: [], time: '07:30', action: 'activate', skipIfPlaying: true, ...config },
    })

  it('activates a preset at its scheduled time', async () => {
    const preset = presets.create(presetInput(), zoneNames())
    schedule(preset.id, {})

    await makeScheduler().tick()

    expect(engine.isStillPlaying(preset.id)).toBe(true)
  })

  it('does nothing a minute before', async () => {
    const preset = presets.create(presetInput(), zoneNames())
    schedule(preset.id, {})
    now = new Date('2026-06-15T07:29:00Z')

    await makeScheduler().tick()

    expect(engine.isStillPlaying(preset.id)).toBe(false)
  })

  it('never fires late after a restart', async () => {
    const preset = presets.create(presetInput(), zoneNames())
    schedule(preset.id, {})
    // Domovoi comes up at 07:45, having been down at 07:30.
    now = new Date('2026-06-15T07:45:00Z')

    await makeScheduler().tick()

    expect(engine.isStillPlaying(preset.id)).toBe(false)
  })

  it('fires once even when ticked repeatedly within the minute', async () => {
    const preset = presets.create(presetInput(), zoneNames())
    schedule(preset.id, {})
    const scheduler = makeScheduler()

    await scheduler.tick()
    await engine.stop(preset.id)
    await scheduler.tick()

    // The second tick must not restart it.
    expect(engine.isStillPlaying(preset.id)).toBe(false)
  })

  it('respects the day of the week', async () => {
    const preset = presets.create(presetInput(), zoneNames())
    schedule(preset.id, { daysOfWeek: [0, 6] }) // weekends only

    await makeScheduler().tick() // Monday

    expect(engine.isStillPlaying(preset.id)).toBe(false)
  })

  describe('skipIfPlaying', () => {
    it('skips when something else is already playing in those rooms', async () => {
      const preset = presets.create(presetInput(), zoneNames())
      schedule(preset.id, { skipIfPlaying: true })
      driver.setPlaying(KITCHEN, 'x-rincon-queue:k#0', 'someone-elses-choice')

      await makeScheduler().tick()

      expect(engine.isStillPlaying(preset.id)).toBe(false)
      expect(triggers.list()[0]?.lastSkippedReason).toMatch(/already playing/)
    })

    it('takes over when the toggle is off', async () => {
      const preset = presets.create(presetInput(), zoneNames())
      schedule(preset.id, { skipIfPlaying: false })
      driver.setPlaying(KITCHEN, 'x-rincon-queue:k#0', 'someone-elses-choice')

      await makeScheduler().tick()

      expect(engine.isStillPlaying(preset.id)).toBe(true)
    })

    it('is not fooled by the preset already playing its own music', async () => {
      const preset = presets.create(presetInput(), zoneNames())
      await engine.activate(preset)
      schedule(preset.id, { skipIfPlaying: true })

      await makeScheduler().tick()

      // Already-active is a no-op, not a "skipped because busy" report.
      expect(triggers.list()[0]?.lastSkippedReason).toBeNull()
      expect(engine.isStillPlaying(preset.id)).toBe(true)
    })
  })

  it('stops a preset on a scheduled stop', async () => {
    const preset = presets.create(presetInput(), zoneNames())
    await engine.activate(preset)
    schedule(preset.id, { action: 'stop' })

    await makeScheduler().tick()

    expect(engine.isStillPlaying(preset.id)).toBe(false)
  })

  it('pauses all music on a scheduled pause-all, leaving the TV alone', async () => {
    driver = new FakeSonosDriver({ tvZoneIds: [LIVING] })
    await driver.start()
    store = new SystemStateStore(driver)
    const db = openDatabase({ inMemory: true })
    const cache = new SourceCache(db, new SourceResolver({ driver, logger }), logger)
    presets = new PresetRepository(db)
    triggers = new TriggerRepository(db)
    engine = new ActivationEngine({
      db,
      driver,
      store,
      cache,
      logger,
      repo: presets,
      timeZone: 'UTC',
      now: () => now,
    })

    driver.setPlaying(OFFICE, 'x-rincon-queue:o#0', 'music')
    schedule(null, { action: 'pause_all' })

    await makeScheduler().tick()

    const groups = driver.snapshot().groups
    expect(groups.find((g) => g.coordinatorZoneId === OFFICE)?.transportState).toBe(
      'PAUSED_PLAYBACK',
    )
    expect(groups.find((g) => g.coordinatorZoneId === LIVING)?.transportState).toBe('PLAYING')
  })

  describe('sleep timers', () => {
    it('stops the preset once the timer elapses', async () => {
      const preset = presets.create(presetInput(), zoneNames())
      triggers.create({
        presetId: preset.id,
        kind: 'sleep_timer',
        label: 'Sleep',
        enabled: true,
        config: { minutes: 45 },
      })
      await engine.activate(preset)
      expect(engine.isStillPlaying(preset.id)).toBe(true)

      now = new Date(MONDAY_0730.getTime() + 46 * 60 * 1000)
      await makeScheduler().tick()

      expect(engine.isStillPlaying(preset.id)).toBe(false)
    })

    it('leaves it playing before the timer elapses', async () => {
      const preset = presets.create(presetInput(), zoneNames())
      triggers.create({
        presetId: preset.id,
        kind: 'sleep_timer',
        label: 'Sleep',
        enabled: true,
        config: { minutes: 45 },
      })
      await engine.activate(preset)

      now = new Date(MONDAY_0730.getTime() + 10 * 60 * 1000)
      await makeScheduler().tick()

      expect(engine.isStillPlaying(preset.id)).toBe(true)
    })

    it('still stops it when the elapsed time is only noticed after a restart', async () => {
      const preset = presets.create(presetInput(), zoneNames())
      triggers.create({
        presetId: preset.id,
        kind: 'sleep_timer',
        label: 'Sleep',
        enabled: true,
        config: { minutes: 45 },
      })
      await engine.activate(preset)

      // Hours later — derived from the activation row, not an in-memory timer.
      now = new Date(MONDAY_0730.getTime() + 6 * 60 * 60 * 1000)
      await makeScheduler().tick()

      expect(engine.isStillPlaying(preset.id)).toBe(false)
    })
  })

  it('ignores disabled triggers', async () => {
    const preset = presets.create(presetInput(), zoneNames())
    const trigger = schedule(preset.id, {})
    triggers.setEnabled(trigger.id, false)

    await makeScheduler().tick()

    expect(engine.isStillPlaying(preset.id)).toBe(false)
  })

  it('reports a schedule whose preset was deleted rather than throwing', async () => {
    const preset = presets.create(presetInput(), zoneNames())
    schedule(preset.id, {})
    presets.delete(preset.id)

    // Cascade removes the trigger with the preset, so there is simply nothing
    // left to run — and certainly no crash.
    await expect(makeScheduler().tick()).resolves.toBeUndefined()
    expect(triggers.list()).toHaveLength(0)
  })
})
