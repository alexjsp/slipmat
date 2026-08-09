import type { PresetInput } from '@domovoi/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/index.js'
import { createLogger } from '../logger.js'
import type { DriverBrowseItem } from '../sonos/driver.js'
import { FakeSonosDriver } from '../sonos/fake-driver.js'
import { SourceCache } from '../sources/cache.js'
import { SourceResolver } from '../sources/resolver.js'
import { SystemStateStore } from '../state/store.js'
import { ActivationEngine } from './activate.js'
import { PresetRepository } from './repository.js'

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
    artUrl: null,
    isContainer: false,
    uri,
    metadata: null,
  }
}

function presetInput(overrides: Partial<PresetInput> = {}): PresetInput {
  return {
    name: 'Morning',
    icon: null,
    color: null,
    zones: [
      { zoneId: KITCHEN, volume: 30, isCoordinator: true },
      { zoneId: BEDROOM, volume: 15, isCoordinator: false },
    ],
    sources: [{ kind: 'sonos_playlist', ref: 'SQ:1', label: 'Jazz' }],
    repeatAll: true,
    dedupe: true,
    pauseOthers: false,
    crossfade: false,
    homekitEnabled: false,
    ...overrides,
  }
}

// Everything here runs against the fake household and an in-memory database.
describe('ActivationEngine', () => {
  let driver: FakeSonosDriver
  let engine: ActivationEngine
  let repo: PresetRepository
  let zoneNames: Map<string, string>

  beforeEach(async () => {
    driver = new FakeSonosDriver({ tvZoneIds: [LIVING] })
    await driver.start()

    driver.setBrowseResult('SQ:1', [track('jazz-1'), track('jazz-2'), track('jazz-3')])
    driver.setBrowseResult('SQ:2', [track('rock-1'), track('rock-2'), track('rock-3')])

    const db = openDatabase({ inMemory: true })
    const store = new SystemStateStore(driver)
    const resolver = new SourceResolver({ driver, logger, allowScratchQueueExpansion: true })
    const cache = new SourceCache(db, resolver, logger)

    repo = new PresetRepository(db)
    engine = new ActivationEngine({ db, driver, store, cache, logger })
    zoneNames = new Map(driver.snapshot().zones.map((zone) => [zone.id, zone.name]))
  })

  const create = (overrides: Partial<PresetInput> = {}) =>
    repo.create(presetInput(overrides), zoneNames)

  it('groups the named zones under the coordinator and starts playing', async () => {
    const preset = create()
    const result = await engine.activate(preset)

    expect(result.noop).toBe(false)
    const group = driver.snapshot().groups.find((g) => g.coordinatorZoneId === KITCHEN)
    expect(group?.memberZoneIds.sort()).toEqual([BEDROOM, KITCHEN])
    expect(group?.transportState).toBe('PLAYING')
  })

  it('sets per-zone volumes after grouping, not before', async () => {
    const preset = create()
    await engine.activate(preset)

    const zones = driver.snapshot().zones
    expect(zones.find((z) => z.id === KITCHEN)?.volume).toBe(30)
    expect(zones.find((z) => z.id === BEDROOM)?.volume).toBe(15)

    // Ordering matters: a join resets member volumes, so any setVolume issued
    // before the join would be silently undone.
    const joinIndex = driver.calls.findIndex((call) => call.method === 'joinGroup')
    const firstVolumeIndex = driver.calls.findIndex((call) => call.method === 'setVolume')
    expect(joinIndex).toBeGreaterThanOrEqual(0)
    expect(firstVolumeIndex).toBeGreaterThan(joinIndex)
  })

  it('interleaves tracks from several sources rather than concatenating', async () => {
    const preset = create({
      sources: [
        { kind: 'sonos_playlist', ref: 'SQ:1', label: 'Jazz' },
        { kind: 'sonos_playlist', ref: 'SQ:2', label: 'Rock' },
      ],
    })
    await engine.activate(preset)

    const queue = driver.queueOf(KITCHEN)
    expect(queue).toHaveLength(6)
    const prefixes = queue.map((uri) => uri.split('-')[0])
    expect(new Set(prefixes)).toEqual(new Set(['jazz', 'rock']))
    // Concatenation would give jazz,jazz,jazz,rock,rock,rock.
    expect(prefixes).not.toEqual(['jazz', 'jazz', 'jazz', 'rock', 'rock', 'rock'])
  })

  it('is idempotent — firing twice does not restart playback', async () => {
    const preset = create()
    const first = await engine.activate(preset)
    const queueAfterFirst = driver.queueOf(KITCHEN)

    const second = await engine.activate(preset)
    expect(second.noop).toBe(true)
    expect(second.activationId).toBe(first.activationId)
    expect(driver.queueOf(KITCHEN)).toEqual(queueAfterFirst)
  })

  it('reshuffles on an explicit restart', async () => {
    const preset = create({
      sources: [
        { kind: 'sonos_playlist', ref: 'SQ:1', label: 'Jazz' },
        { kind: 'sonos_playlist', ref: 'SQ:2', label: 'Rock' },
      ],
    })
    await engine.activate(preset)
    const first = driver.queueOf(KITCHEN)

    const restarted = await engine.activate(preset, { restart: true })
    expect(restarted.noop).toBe(false)
    expect(driver.queueOf(KITCHEN)).toHaveLength(first.length)
  })

  it('plays on the speakers that answered and warns about the rest', async () => {
    driver.setUnreachable(BEDROOM, true)
    const preset = create()
    const result = await engine.activate(preset)

    expect(result.noop).toBe(false)
    expect(result.warnings.join(' ')).toMatch(/Bedroom/)
    const group = driver.snapshot().groups.find((g) => g.coordinatorZoneId === KITCHEN)
    expect(group?.memberZoneIds).toEqual([KITCHEN])
    expect(group?.transportState).toBe('PLAYING')
  })

  it('promotes another member when the coordinator itself is offline', async () => {
    driver.setUnreachable(KITCHEN, true)
    const preset = create()
    await engine.activate(preset)

    const group = driver.snapshot().groups.find((g) => g.coordinatorZoneId === BEDROOM)
    expect(group?.transportState).toBe('PLAYING')
  })

  it('leaves other groups alone by default', async () => {
    driver.setPlaying(OFFICE, 'x-rincon-queue:o#0', 'other-track')
    await engine.activate(create())

    const office = driver.snapshot().groups.find((g) => g.coordinatorZoneId === OFFICE)
    expect(office?.transportState).toBe('PLAYING')
  })

  it('pauses other groups when pauseOthers is set, but never the TV', async () => {
    driver.setPlaying(OFFICE, 'x-rincon-queue:o#0', 'other-track')
    await engine.activate(create({ pauseOthers: true }))

    const groups = driver.snapshot().groups
    expect(groups.find((g) => g.coordinatorZoneId === OFFICE)?.transportState).toBe(
      'PAUSED_PLAYBACK',
    )
    // The soundbar is on TV audio and must keep playing.
    expect(groups.find((g) => g.coordinatorZoneId === LIVING)?.transportState).toBe('PLAYING')
  })

  it('plays a radio favourite as a single stream with no queue', async () => {
    driver.setBrowseResult('FV:2', [
      {
        id: 'FV:2/9',
        title: 'BBC 6 Music',
        subtitle: null,
        artUrl: null,
        isContainer: false,
        uri: 'x-sonosapi-stream:bbc6?sid=254',
        metadata: '<DIDL/>',
      },
    ])
    const preset = create({
      sources: [{ kind: 'sonos_favorite', ref: 'FV:2/9', label: 'BBC 6' }],
    })
    await engine.activate(preset)

    expect(driver.queueOf(KITCHEN)).toEqual([])
    const group = driver.snapshot().groups.find((g) => g.coordinatorZoneId === KITCHEN)
    expect(group?.transportUri).toBe('x-sonosapi-stream:bbc6?sid=254')
    expect(group?.transportState).toBe('PLAYING')
  })

  it('sets repeat-all when asked, and plain NORMAL otherwise', async () => {
    await engine.activate(create())
    expect(driver.playModeOf(KITCHEN)).toBe('REPEAT_ALL')

    const other = create({
      name: 'No repeat',
      repeatAll: false,
      zones: [{ zoneId: OFFICE, volume: 20, isCoordinator: true }],
    })
    await engine.activate(other)
    expect(driver.playModeOf(OFFICE)).toBe('NORMAL')
  })

  it('stops by pausing, leaving the group and queue intact to resume', async () => {
    const preset = create()
    await engine.activate(preset)
    const queue = driver.queueOf(KITCHEN)

    expect(await engine.stop(preset.id)).toBe(true)

    const group = driver.snapshot().groups.find((g) => g.coordinatorZoneId === KITCHEN)
    expect(group?.transportState).toBe('PAUSED_PLAYBACK')
    expect(group?.memberZoneIds.sort()).toEqual([BEDROOM, KITCHEN])
    expect(driver.queueOf(KITCHEN)).toEqual(queue)
  })

  describe('active-state detection', () => {
    it('reports active while our queue is playing on the right speakers', async () => {
      const preset = create()
      await engine.activate(preset)
      expect(engine.isStillPlaying(preset.id)).toBe(true)
    })

    it('survives a skip to another track we queued', async () => {
      const preset = create()
      await engine.activate(preset)
      await driver.next(KITCHEN)
      expect(engine.isStillPlaying(preset.id)).toBe(true)
    })

    it('goes inactive when paused', async () => {
      const preset = create()
      await engine.activate(preset)
      await driver.pause(KITCHEN)
      expect(engine.isStillPlaying(preset.id)).toBe(false)
    })

    it('goes inactive when someone replaces the queue', async () => {
      const preset = create()
      await engine.activate(preset)
      driver.setPlaying(KITCHEN, 'x-rincon-queue:k#0', 'something-else-entirely')
      expect(engine.isStillPlaying(preset.id)).toBe(false)
    })

    it('goes inactive when a preset speaker is taken away', async () => {
      const preset = create()
      await engine.activate(preset)
      await driver.leaveGroup([BEDROOM])
      expect(engine.isStillPlaying(preset.id)).toBe(false)
    })

    it('supersedes an overlapping preset so both switches cannot read on', async () => {
      const first = create()
      await engine.activate(first)

      const second = repo.create(
        presetInput({
          name: 'Evening',
          zones: [{ zoneId: BEDROOM, volume: 10, isCoordinator: true }],
        }),
        zoneNames,
      )
      await engine.activate(second)

      expect(engine.isStillPlaying(first.id)).toBe(false)
      expect(engine.isStillPlaying(second.id)).toBe(true)
    })
  })
})
