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
    album: null,
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
    shuffle: true,
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
  let db: ReturnType<typeof openDatabase>
  let store: SystemStateStore
  let cache: SourceCache

  beforeEach(async () => {
    driver = new FakeSonosDriver({ tvZoneIds: [LIVING] })
    await driver.start()

    driver.setBrowseResult('SQ:1', [track('jazz-1'), track('jazz-2'), track('jazz-3')])
    driver.setBrowseResult('SQ:2', [track('rock-1'), track('rock-2'), track('rock-3')])

    db = openDatabase({ inMemory: true })
    store = new SystemStateStore(driver)
    const resolver = new SourceResolver({ driver, logger, allowScratchQueueExpansion: true })
    cache = new SourceCache(db, resolver, logger)

    repo = new PresetRepository(db)
    engine = new ActivationEngine({
      db,
      driver,
      store,
      cache,
      logger,
      repo,
      timeZone: 'UTC',
    })
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
    // Fixed seed: a correct shuffle can legitimately produce the concatenated
    // order by chance (1 in 20 for 3+3 tracks), so asserting against it with a
    // random seed is a flaky test, not a stronger one.
    await engine.activate(preset, { seed: 12345 })

    const queue = driver.queueOf(KITCHEN)
    expect(queue).toHaveLength(6)
    const prefixes = queue.map((uri) => uri.split('-')[0])
    expect(new Set(prefixes)).toEqual(new Set(['jazz', 'rock']))
    expect([...queue].sort()).toEqual(['jazz-1', 'jazz-2', 'jazz-3', 'rock-1', 'rock-2', 'rock-3'])
    expect(prefixes).not.toEqual(['jazz', 'jazz', 'jazz', 'rock', 'rock', 'rock'])
  })

  it('plays sources in order when shuffle is off', async () => {
    const preset = create({
      shuffle: false,
      sources: [
        { kind: 'sonos_playlist', ref: 'SQ:1', label: 'Jazz' },
        { kind: 'sonos_playlist', ref: 'SQ:2', label: 'Rock' },
      ],
    })
    await engine.activate(preset)

    expect(driver.queueOf(KITCHEN)).toEqual([
      'jazz-1',
      'jazz-2',
      'jazz-3',
      'rock-1',
      'rock-2',
      'rock-3',
    ])
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
        album: null,
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

  describe('streaming sources in a small house', () => {
    // A two-speaker household with both speakers busy: there is nothing idle to
    // borrow, which used to degrade the preset to "container only".
    const buildTwoSpeakerHouse = async () => {
      const smallDriver = new FakeSonosDriver({
        zones: [
          { id: 'RINCON_A01400', name: 'Kitchen' },
          { id: 'RINCON_B01400', name: 'Living Room' },
        ],
      })
      await smallDriver.start()
      smallDriver.setPlaying('RINCON_A01400', 'x-rincon-queue:a#0', 'busy-a')
      smallDriver.setPlaying('RINCON_B01400', 'x-rincon-queue:b#0', 'busy-b')

      const containerUri =
        'x-rincon-cpcontainer:1006206cspotify%3aplaylist%3a37i9dQZF1DXcBWIGoYBM5M?sid=9&flags=8300&sn=7'
      smallDriver.setContainerContents(containerUri, [
        track('stream-1'),
        track('stream-2'),
        track('stream-3'),
      ])

      const db2 = openDatabase({ inMemory: true })
      const store2 = new SystemStateStore(smallDriver)
      const cache2 = new SourceCache(
        db2,
        new SourceResolver({ driver: smallDriver, logger, allowScratchQueueExpansion: true }),
        logger,
      )
      const repo2 = new PresetRepository(db2)
      const engine2 = new ActivationEngine({
        db: db2,
        driver: smallDriver,
        store: store2,
        cache: cache2,
        logger,
        repo: repo2,
        timeZone: 'UTC',
      })
      return { driver: smallDriver, repo: repo2, engine: engine2 }
    }

    it('expands on the preset coordinator when no speaker is free to borrow', async () => {
      const house = await buildTwoSpeakerHouse()
      const preset = house.repo.create(
        {
          ...presetInput(),
          zones: [{ zoneId: 'RINCON_A01400', volume: 20, isCoordinator: true }],
          sources: [
            {
              kind: 'service_url',
              ref: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
              label: 'Streaming',
            },
          ],
        },
        new Map([
          ['RINCON_A01400', 'Kitchen'],
          ['RINCON_B01400', 'Living Room'],
        ]),
      )

      const result = await house.engine.activate(preset)

      // Previously this degraded to container-only with a warning.
      expect(result.warnings).toEqual([])
      // Sorted: the queue is shuffled, so only its contents are meaningful.
      expect([...house.driver.queueOf('RINCON_A01400')].sort()).toEqual([
        'stream-1',
        'stream-2',
        'stream-3',
      ])
    })

    it('never touches the other speaker to do it', async () => {
      const house = await buildTwoSpeakerHouse()
      const preset = house.repo.create(
        {
          ...presetInput(),
          zones: [{ zoneId: 'RINCON_A01400', volume: 20, isCoordinator: true }],
          sources: [
            {
              kind: 'service_url',
              ref: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
              label: 'Streaming',
            },
          ],
        },
        new Map([['RINCON_A01400', 'Kitchen']]),
      )

      await house.engine.activate(preset)

      const touchedOther = house.driver.calls.some(
        (call) => call.method === 'clearQueue' && call.args[0] === 'RINCON_B01400',
      )
      expect(touchedOther).toBe(false)
    })
  })

  describe('conditional rules', () => {
    const buildEngineAt = (now: Date) => {
      const db2 = openDatabase({ inMemory: true })
      const store2 = new SystemStateStore(driver)
      const cache2 = new SourceCache(
        db2,
        new SourceResolver({ driver, logger, allowScratchQueueExpansion: true }),
        logger,
      )
      const repo2 = new PresetRepository(db2)
      const engine2 = new ActivationEngine({
        db: db2,
        driver,
        store: store2,
        cache: cache2,
        logger,
        repo: repo2,
        timeZone: 'UTC',
        now: () => now,
      })
      return { repo: repo2, engine: engine2 }
    }

    it('adds a source on the day the rule names', async () => {
      // 2026-06-18 is a Thursday.
      const { repo: r, engine: e } = buildEngineAt(new Date('2026-06-18T10:00:00Z'))
      const preset = r.create(presetInput(), zoneNames)
      r.setRules(preset.id, [
        {
          label: 'Throwback Thursday',
          enabled: true,
          condition: { daysOfWeek: [4] },
          effect: { addSources: [{ kind: 'sonos_playlist', ref: 'SQ:2', label: 'Rock' }] },
        },
      ])

      await e.activate(preset)
      const queue = driver.queueOf(KITCHEN)
      expect(queue.some((uri) => uri.startsWith('rock'))).toBe(true)
      expect(queue.some((uri) => uri.startsWith('jazz'))).toBe(true)
    })

    it('leaves the preset alone on a day the rule does not name', async () => {
      // 2026-06-19 is a Friday.
      const { repo: r, engine: e } = buildEngineAt(new Date('2026-06-19T10:00:00Z'))
      const preset = r.create(presetInput(), zoneNames)
      r.setRules(preset.id, [
        {
          label: 'Throwback Thursday',
          enabled: true,
          condition: { daysOfWeek: [4] },
          effect: { addSources: [{ kind: 'sonos_playlist', ref: 'SQ:2', label: 'Rock' }] },
        },
      ])

      await e.activate(preset)
      expect(driver.queueOf(KITCHEN).every((uri) => uri.startsWith('jazz'))).toBe(true)
    })

    it('replaces sources and lowers volumes for a late-evening wind-down', async () => {
      const { repo: r, engine: e } = buildEngineAt(new Date('2026-06-18T22:30:00Z'))
      const preset = r.create(presetInput(), zoneNames)
      r.setRules(preset.id, [
        {
          label: 'Wind down',
          enabled: true,
          condition: { timeOfDay: { from: '21:00', to: '05:00' } },
          effect: {
            replaceSources: [{ kind: 'sonos_playlist', ref: 'SQ:2', label: 'Wind Down' }],
            volumeDelta: -20,
          },
        },
      ])

      await e.activate(preset)

      expect(driver.queueOf(KITCHEN).every((uri) => uri.startsWith('rock'))).toBe(true)
      const zones = driver.snapshot().zones
      // 30 -> 10 and 15 -> 0 (clamped).
      expect(zones.find((z) => z.id === KITCHEN)?.volume).toBe(10)
      expect(zones.find((z) => z.id === BEDROOM)?.volume).toBe(0)
    })
  })

  describe('active-state detection', () => {
    it('reports active while our queue is playing on the right speakers', async () => {
      const preset = create()
      await engine.activate(preset)
      expect(engine.isStillPlaying(preset.id)).toBe(true)
    })

    it('does not retire an activation the speaker has not caught up with yet', async () => {
      // Reconcile runs on every state change, and activation itself causes
      // several — grouping, volumes, crossfade — before Play is even called.
      // Answering "is it playing?" during that window killed every activation
      // milliseconds after it was created, and nothing revives one.
      const preset = create()
      await engine.activate(preset)
      await driver.pause(KITCHEN)

      engine.reconcile()

      expect(engine.liveActivation(preset.id)).toBeDefined()
    })

    it('retires it once the grace period has passed and it is still not playing', async () => {
      const preset = create()
      await engine.activate(preset)
      await driver.pause(KITCHEN)

      // Same engine, an unhurried clock.
      const later = new ActivationEngine({
        db,
        driver,
        store,
        cache,
        logger,
        repo,
        timeZone: 'UTC',
        now: () => new Date(Date.now() + 60_000),
      })
      later.reconcile()

      expect(later.liveActivation(preset.id)).toBeUndefined()
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
