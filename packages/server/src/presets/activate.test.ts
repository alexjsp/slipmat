import type { PresetInput } from '@slipmat/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/index.js'
import { activations } from '../db/schema.js'
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

/**
 * Let the fire-and-forget queue fill finish.
 *
 * Activation queues the first source, starts playback and returns; the rest go
 * in behind it. Anything asserting on the *whole* queue has to wait for that.
 */
const settle = async () => {
  // `setTimeout`, not `setImmediate`. The background work waits on timers — the
  // gap between queue commands, the pause after a skip — and a tight
  // `setImmediate` loop runs in an earlier phase of the event loop, starving
  // them. That looked exactly like a broken feature: the work stopped partway
  // and the assertions ran against a half-finished queue.
  // Forty is comfortably more than the longest chain any test sets up — eight
  // skips past blocked tracks is the worst of them — without making every call
  // wait a tenth of a second for nothing.
  for (let index = 0; index < 40; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
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
      // Real life spaces these out; the tests would only be waiting.
      queueGapMs: 0,
      skipSettleMs: 0,
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

  it('sets every volume after grouping and before playing', async () => {
    const preset = create()
    await engine.activate(preset)
    await settle()

    const zones = driver.snapshot().zones
    expect(zones.find((z) => z.id === KITCHEN)?.volume).toBe(30)
    expect(zones.find((z) => z.id === BEDROOM)?.volume).toBe(15)

    // Joining resets a member's volume, so volumes have to follow the grouping.
    // Play following the volumes is what keeps anything from being briefly
    // audible at the wrong one — the job the mute dance used to attempt.
    const methods = driver.calls.map((call) => call.method)
    const lastJoin = methods.lastIndexOf('joinGroup')
    const firstVolume = methods.indexOf('setVolume')
    const play = methods.indexOf('play')
    expect(lastJoin).toBeGreaterThanOrEqual(0)
    expect(firstVolume).toBeGreaterThan(lastJoin)
    expect(play).toBeGreaterThan(firstVolume)
  })

  it('does not tear down a group that is already the one it wants', async () => {
    // Re-running a preset is the common case, and rebuilding an identical group
    // was 3.2s of dead time before a note played.
    const preset = create()
    await engine.activate(preset)
    await settle()
    driver.calls.length = 0

    await engine.activate(preset, { restart: true })
    await settle()

    expect(driver.calls.some((call) => call.method === 'leaveGroup')).toBe(false)
    const group = driver.snapshot().groups.find((g) => g.coordinatorZoneId === KITCHEN)
    expect(group?.memberZoneIds.sort()).toEqual([BEDROOM, KITCHEN])
    expect(group?.transportState).toBe('PLAYING')
  })

  it('does tear down a group holding a room the preset does not want', async () => {
    const preset = create()
    await engine.activate(preset)
    await settle()
    await driver.joinGroup(KITCHEN, [OFFICE])
    driver.calls.length = 0

    await engine.activate(preset, { restart: true })
    await settle()

    // The stray room has to go, and only a teardown removes it.
    expect(driver.calls.some((call) => call.method === 'leaveGroup')).toBe(true)
    const group = driver.snapshot().groups.find((g) => g.coordinatorZoneId === KITCHEN)
    expect(group?.memberZoneIds.sort()).toEqual([BEDROOM, KITCHEN])
  })

  it('refuses before touching a speaker when nothing will play', async () => {
    // This is how a morning went wrong: the check for anything playable sat
    // after the grouping, so a preset whose sources had all failed rearranged
    // the house and then aborted — every room ungrouped, nothing playing.
    driver.setBrowseResult('SQ:1', [])
    const preset = create()

    await expect(engine.activate(preset)).rejects.toThrow(/nothing playable/)

    expect(driver.calls.some((call) => call.method === 'leaveGroup')).toBe(false)
    expect(driver.calls.some((call) => call.method === 'joinGroup')).toBe(false)
    expect(driver.calls.some((call) => call.method === 'clearQueue')).toBe(false)
  })

  it('never mutes a speaker, so none can be left silent by a failed join', async () => {
    // There is no muting to undo any more. Play comes after the volumes, so a
    // speaker that never joins simply is not in the group and never makes a
    // sound — replacing a mute-then-unmute dance that stranded rooms muted for
    // the evening whenever the unmute did not happen.
    driver.setBrowseResult('SQ:1', [track('jazz-1')])
    const preset = create()
    driver.failJoinFor(BEDROOM)

    await engine.activate(preset)
    await settle()

    expect(driver.calls.some((call) => call.method === 'setMute' && call.args[1] === true)).toBe(
      false,
    )
    expect(driver.snapshot().zones.find((z) => z.id === BEDROOM)?.muted).toBe(false)
    expect(engine.liveActivation(preset.id)).toBeDefined()
  })

  it('queues every source and leaves the interleaving to Sonos shuffle', async () => {
    const preset = create({
      sources: [
        { kind: 'sonos_playlist', ref: 'SQ:1', label: 'Jazz' },
        { kind: 'sonos_playlist', ref: 'SQ:2', label: 'Rock' },
      ],
    })
    await engine.activate(preset)
    await settle()

    // The queue holds the sources back to back; shuffle mode is what mixes
    // them at playback time. Interleaving them in the queue instead would mean
    // enqueueing track by track, which costs ~780ms each against real hardware.
    const queue = driver.queueOf(KITCHEN)
    expect([...queue].sort()).toEqual(['jazz-1', 'jazz-2', 'jazz-3', 'rock-1', 'rock-2', 'rock-3'])
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
    await settle()

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

  it('removes the same song reached through a different playlist', async () => {
    // Apple Music gives the same recording a different library id per playlist,
    // so the URIs differ and deduplication by URI alone saw nothing — a queue of
    // 125 tracks had six repeated titles and removed none of them.
    driver.setBrowseResult('SQ:1', [
      { ...track('lib-a'), title: 'Eclipse', artist: 'Delta Goodrem' },
      { ...track('lib-b'), title: 'Eclipse', artist: 'Delta Goodrem' },
      { ...track('lib-c'), title: 'Poison', artist: 'Alice Cooper' },
      { ...track('lib-d'), title: 'Poison', artist: 'Rita Ora' },
    ])

    await engine.activate(create())
    await settle()

    const queue = driver.queueOf(KITCHEN)
    // One Eclipse, and both Poisons: same title, different artists, different songs.
    expect(queue).toHaveLength(3)
    expect(queue.filter((uri) => uri.startsWith('lib-a') || uri.startsWith('lib-b'))).toHaveLength(
      1,
    )
    expect(queue).toContain('lib-c')
    expect(queue).toContain('lib-d')
  })

  it('removes blocked music from the queue', async () => {
    driver.setBrowseResult('SQ:1', [
      { ...track('a'), title: 'Last Christmas', artist: 'Wham!' },
      { ...track('b'), title: 'Wichita Lineman', artist: 'Glen Campbell' },
      { ...track('c'), title: 'Fairytale of New York', artist: 'The Pogues' },
    ])
    const blocked = new ActivationEngine({
      db,
      driver,
      store,
      cache,
      logger,
      repo,
      timeZone: 'UTC',
      queueGapMs: 0,
      skipSettleMs: 0,
      settings: {
        blocklist: () => [
          { field: 'any', match: 'contains', pattern: 'christmas', enabled: true },
          { field: 'title', match: 'contains', pattern: 'fairytale', enabled: true },
        ],
      },
    })

    await blocked.activate(create())
    await settle()

    expect(driver.queueOf(KITCHEN)).toEqual(['b'])
  })

  it('skips off a blocked track that is already playing', async () => {
    // The prune runs a few seconds after playback starts, and the track it
    // opened on is picked at random — so it may well be one you never want to
    // hear. Taking it out of the queue is no help; it is already playing.
    driver.setBrowseResult('SQ:1', [
      { ...track('a'), title: 'Last Christmas', artist: 'Wham!' },
      { ...track('b'), title: 'Wichita Lineman', artist: 'Glen Campbell' },
    ])
    const blocked = new ActivationEngine({
      db,
      driver,
      store,
      cache,
      logger,
      repo,
      timeZone: 'UTC',
      queueGapMs: 0,
      skipSettleMs: 0,
      // Always start on the first track, which is the blocked one.
      random: () => 0,
      settings: {
        blocklist: () => [{ field: 'any', match: 'contains', pattern: 'christmas', enabled: true }],
      },
    })

    await blocked.activate(create())
    await settle()

    expect(driver.calls.some((call) => call.method === 'next')).toBe(true)
    const group = driver.snapshot().groups.find((g) => g.coordinatorZoneId === KITCHEN)
    expect(group?.currentTrack?.title).toBe('Wichita Lineman')
    expect(driver.queueOf(KITCHEN)).toEqual(['b'])
  })

  it('gives up skipping rather than hammering a queue of nothing but blocked music', async () => {
    driver.setBrowseResult(
      'SQ:1',
      Array.from({ length: 30 }, (_, index) => ({
        ...track(`x-${index}`),
        title: `Last Christmas ${index}`,
        artist: 'Wham!',
      })),
    )
    const blocked = new ActivationEngine({
      db,
      driver,
      store,
      cache,
      logger,
      repo,
      timeZone: 'UTC',
      queueGapMs: 0,
      skipSettleMs: 0,
      random: () => 0,
      settings: {
        blocklist: () => [{ field: 'any', match: 'contains', pattern: 'christmas', enabled: true }],
      },
    })

    await blocked.activate(create())
    await settle()

    // Bounded, and the prune clears the queue regardless.
    expect(driver.calls.filter((call) => call.method === 'next').length).toBeLessThanOrEqual(8)
    expect(driver.queueOf(KITCHEN)).toEqual([])
  })

  it('applies the blocklist even when deduplication is off', async () => {
    driver.setBrowseResult('SQ:1', [
      { ...track('a'), title: 'Last Christmas', artist: 'Wham!' },
      { ...track('b'), title: 'Wichita Lineman', artist: 'Glen Campbell' },
    ])
    const blocked = new ActivationEngine({
      db,
      driver,
      store,
      cache,
      logger,
      repo,
      timeZone: 'UTC',
      queueGapMs: 0,
      skipSettleMs: 0,
      settings: {
        blocklist: () => [{ field: 'any', match: 'contains', pattern: 'christmas', enabled: true }],
      },
    })

    await blocked.activate(create({ dedupe: false }))
    await settle()

    expect(driver.queueOf(KITCHEN)).toEqual(['b'])
  })

  it('joins an activation already under way instead of starting a second', async () => {
    // Bedtime did this for real: two taps 85ms apart, two activations, both
    // rearranging the same speakers. The idempotence check could not see the
    // first because the record it reads is only written once the music starts.
    const preset = create()

    const [first, second] = await Promise.all([
      engine.activate(preset, { trigger: 'homekit' }),
      engine.activate(preset, { trigger: 'homekit' }),
    ])
    await settle()

    expect(second.activationId).toBe(first.activationId)
    expect(driver.calls.filter((call) => call.method === 'clearQueue')).toHaveLength(1)
    expect(
      db
        .select()
        .from(activations)
        .all()
        .filter((row) => row.presetId === preset.id),
    ).toHaveLength(1)
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

  it('maps the shuffle and repeat flags onto a Sonos play mode', async () => {
    await engine.activate(create({ shuffle: true, repeatAll: true }))
    expect(driver.playModeOf(KITCHEN)).toBe('SHUFFLE')

    await engine.activate(create({ shuffle: true, repeatAll: false }), { restart: true })
    expect(driver.playModeOf(KITCHEN)).toBe('SHUFFLE_NOREPEAT')

    await engine.activate(create({ shuffle: false, repeatAll: true }), { restart: true })
    expect(driver.playModeOf(KITCHEN)).toBe('REPEAT_ALL')

    const other = create({
      name: 'Neither',
      shuffle: false,
      repeatAll: false,
      zones: [{ zoneId: OFFICE, volume: 20, isCoordinator: true }],
    })
    await engine.activate(other)
    expect(driver.playModeOf(OFFICE)).toBe('NORMAL')
  })

  it('stops by pausing, leaving the group and queue intact to resume', async () => {
    const preset = create()
    await engine.activate(preset)
    // Wait for the background fill and shuffle, so this compares against the
    // settled queue rather than racing it.
    await settle()
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
        queueGapMs: 0,
        skipSettleMs: 0,
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
      await settle()
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
      await settle()

      expect(driver.queueOf(KITCHEN).every((uri) => uri.startsWith('rock'))).toBe(true)
      const zones = driver.snapshot().zones
      // 30 -> 10 and 15 -> 0 (clamped).
      expect(zones.find((z) => z.id === KITCHEN)?.volume).toBe(10)
      expect(zones.find((z) => z.id === BEDROOM)?.volume).toBe(0)
    })
  })

  describe('very large pools', () => {
    it('queues every track of a very large pool, uncapped', async () => {
      driver.setBrowseResult(
        'SQ:1',
        Array.from({ length: 1000 }, (_, index) => track(`jazz-${index}`)),
      )
      driver.setBrowseResult(
        'SQ:2',
        Array.from({ length: 1000 }, (_, index) => track(`rock-${index}`)),
      )
      const preset = create({
        sources: [
          { kind: 'sonos_playlist', ref: 'SQ:1', label: 'Jazz' },
          { kind: 'sonos_playlist', ref: 'SQ:2', label: 'Rock' },
        ],
      })

      await engine.activate(preset)
      await settle()

      expect(driver.queueOf(KITCHEN)).toHaveLength(2000)
    })

    it('opens on a small source rather than the one that takes 40s to expand', async () => {
      // Sonos answers a container enqueue only after expanding it, so listing a
      // huge playlist first would mean 40-odd seconds of silence.
      driver.setBrowseResult(
        'SQ:1',
        Array.from({ length: 800 }, (_, index) => track(`jazz-${index}`)),
      )
      driver.setBrowseResult('SQ:2', [track('rock-1'), track('rock-2')])
      const preset = create({
        sources: [
          { kind: 'sonos_playlist', ref: 'SQ:1', label: 'Huge' },
          { kind: 'sonos_playlist', ref: 'SQ:2', label: 'Small' },
        ],
      })

      await engine.activate(preset)
      await settle()

      // The first enqueue — the one playback waits on — carried two tracks.
      const enqueues = driver.calls.filter((call) => call.method === 'addUrisToQueue')
      expect(enqueues[0]?.args[1]).toBe(2)
      expect(driver.queueOf(KITCHEN)).toHaveLength(802)
    })

    it('varies which small source opens, rather than always the smallest', async () => {
      // Always choosing the smallest is predictable in a way that shows: an
      // album among medium playlists would open every single day.
      driver.setBrowseResult('SQ:1', [track('album-1'), track('album-2')])
      driver.setBrowseResult(
        'SQ:2',
        Array.from({ length: 40 }, (_, index) => track(`mix-${index}`)),
      )
      const sources = [
        { kind: 'sonos_playlist' as const, ref: 'SQ:1', label: 'Album' },
        { kind: 'sonos_playlist' as const, ref: 'SQ:2', label: 'Mix' },
      ]
      const engineWith = (random: () => number) =>
        new ActivationEngine({
          db,
          driver,
          store,
          cache,
          logger,
          repo,
          timeZone: 'UTC',
          random,
          queueGapMs: 0,
          skipSettleMs: 0,
        })

      // Both are small, so both are candidates and the choice is the random one.
      await engineWith(() => 0).activate(create({ name: 'First', sources }))
      const firstOpener = driver.calls.filter((c) => c.method === 'addUrisToQueue')[0]?.args[1]

      driver.calls.length = 0
      await engineWith(() => 0.99).activate(create({ name: 'Second', sources }))
      const secondOpener = driver.calls.filter((c) => c.method === 'addUrisToQueue')[0]?.args[1]

      expect(firstOpener).toBe(2)
      expect(secondOpener).toBe(40)
    })

    it('starts somewhere random, since Sonos always opens at shuffled position 1', async () => {
      // Verified on the household: five consecutive starts on a 2,082-track
      // shuffled queue all opened on the same song. Sonos shuffles the order
      // but pins what sits at the front, so the starting point is ours to pick.
      driver.setBrowseResult(
        'SQ:1',
        Array.from({ length: 30 }, (_, index) => track(`jazz-${index}`)),
      )
      const sources = [{ kind: 'sonos_playlist' as const, ref: 'SQ:1', label: 'Jazz' }]
      const engineWith = (random: () => number) =>
        new ActivationEngine({ db, driver, store, cache, logger, repo, timeZone: 'UTC', random })

      await engineWith(() => 0).activate(create({ name: 'Low', repeatAll: true, sources }))
      const low = driver.calls.filter((call) => call.method === 'seekToTrack').at(-1)?.args[1]

      await engineWith(() => 0.9).activate(create({ name: 'High', repeatAll: true, sources }))
      const high = driver.calls.filter((call) => call.method === 'seekToTrack').at(-1)?.args[1]

      expect(low).toBe(1)
      expect(high).toBe(28)
    })

    it('does not pick a starting track when shuffle is off', async () => {
      // The preset's order is the playback order; jumping into the middle of it
      // would be the opposite of what was asked for.
      driver.setBrowseResult('SQ:1', [track('a'), track('b'), track('c')])
      await engine.activate(
        create({ shuffle: false, sources: [{ kind: 'sonos_playlist', ref: 'SQ:1', label: 'A' }] }),
      )
      await settle()

      expect(driver.calls.some((call) => call.method === 'seekToTrack')).toBe(false)
    })

    it('does not pick a starting track when the queue will not loop', async () => {
      // Starting in the middle of a queue that stops at the end means the
      // beginning never plays. A predictable first track is the lesser evil.
      driver.setBrowseResult(
        'SQ:1',
        Array.from({ length: 30 }, (_, index) => track(`jazz-${index}`)),
      )
      await engine.activate(
        create({
          shuffle: true,
          repeatAll: false,
          sources: [{ kind: 'sonos_playlist', ref: 'SQ:1', label: 'Jazz' }],
        }),
      )
      await settle()

      expect(driver.calls.some((call) => call.method === 'seekToTrack')).toBe(false)
    })

    it('re-asserts shuffle once the whole queue is in', async () => {
      // The order Sonos generated covered only the opening source.
      driver.setBrowseResult('SQ:1', [track('jazz-1')])
      driver.setBrowseResult('SQ:2', [track('rock-1'), track('rock-2')])
      await engine.activate(
        create({
          sources: [
            { kind: 'sonos_playlist', ref: 'SQ:1', label: 'Jazz' },
            { kind: 'sonos_playlist', ref: 'SQ:2', label: 'Rock' },
          ],
        }),
      )
      await settle()

      const modeCalls = driver.calls.filter((call) => call.method === 'setPlayMode')
      expect(modeCalls.length).toBeGreaterThan(1)
      expect(modeCalls.at(-1)?.args[1]).toBe('SHUFFLE')
    })

    it('leaves the playing track alone when deduping', async () => {
      // Pulling it out from under the transport would skip the song someone is
      // listening to, so a duplicate of the current track is left in place.
      driver.setBrowseResult('SQ:1', [track('a'), track('b')])
      driver.setBrowseResult('SQ:2', [track('a'), track('b')])
      const preset = create({
        dedupe: true,
        sources: [
          { kind: 'sonos_playlist', ref: 'SQ:1', label: 'One' },
          { kind: 'sonos_playlist', ref: 'SQ:2', label: 'Two' },
        ],
      })

      await engine.activate(preset)
      driver.setPlaying(KITCHEN, 'x-rincon-queue:k#0', 'a')
      await settle()

      const queue = driver.queueOf(KITCHEN)
      expect(queue.filter((uri) => uri === 'a')).toHaveLength(2)
      expect(queue.filter((uri) => uri === 'b')).toHaveLength(1)
    })

    it('abandons the append when the activation is superseded mid-flight', async () => {
      driver.setBrowseResult(
        'SQ:1',
        Array.from({ length: 200 }, (_, index) => track(`jazz-${index}`)),
      )
      const preset = create()
      await engine.activate(preset)

      // Stopping it must not leave a background fill still adding sources.
      const stopped = await engine.stop(preset.id)
      expect(stopped).toBe(true)
      expect(engine.liveActivation(preset.id)).toBeUndefined()
    })
  })

  describe('shrinking to fewer rooms', () => {
    const shrinkPreset = (keepZoneIds: string[]) =>
      create({
        name: `Bedtime ${keepZoneIds.join('-')}`,
        zones: [
          { zoneId: KITCHEN, volume: 20, isCoordinator: true },
          { zoneId: BEDROOM, volume: 10, isCoordinator: false },
        ],
        shrink: { afterMinutes: 30, keepZoneIds },
      })

    it('ungroups the rooms it is not keeping, and leaves the music playing', async () => {
      const preset = shrinkPreset([KITCHEN])
      await engine.activate(preset)
      await settle()

      const result = await engine.shrink(preset.id, [KITCHEN])

      expect(result).toEqual({ shrunk: true, dropped: [BEDROOM] })
      const group = driver.snapshot().groups.find((g) => g.coordinatorZoneId === KITCHEN)
      expect(group?.memberZoneIds).toEqual([KITCHEN])
      expect(group?.transportState).toBe('PLAYING')
      // Still the same activation: narrowing a preset is not stopping it.
      expect(engine.liveActivation(preset.id)).toBeDefined()
    })

    it('narrows the activation, so active-state follows the smaller group', async () => {
      const preset = shrinkPreset([KITCHEN])
      await engine.activate(preset)
      await settle()
      await engine.shrink(preset.id, [KITCHEN])

      // Was expecting both rooms; expecting Bedroom still would read as stopped.
      expect(engine.isStillPlaying(preset.id)).toBe(true)
    })

    it('refuses to drop the speaker holding the queue', async () => {
      // Keeping only a follower would ungroup the coordinator and leave the one
      // room you asked for playing nothing at all.
      const preset = shrinkPreset([BEDROOM])
      await engine.activate(preset)
      await settle()

      const result = await engine.shrink(preset.id, [BEDROOM])

      expect(result.shrunk).toBe(false)
      const group = driver.snapshot().groups.find((g) => g.coordinatorZoneId === KITCHEN)
      expect(group?.memberZoneIds.sort()).toEqual([BEDROOM, KITCHEN])
    })

    it('leaves a room someone joined by hand where they put it', async () => {
      const preset = shrinkPreset([KITCHEN])
      await engine.activate(preset)
      await settle()
      // Someone wanders in and adds the office to the group themselves.
      await driver.joinGroup(KITCHEN, [OFFICE])

      await engine.shrink(preset.id, [KITCHEN])

      const group = driver.snapshot().groups.find((g) => g.coordinatorZoneId === KITCHEN)
      expect(group?.memberZoneIds.sort()).toEqual([KITCHEN, OFFICE])
    })

    it('does nothing once the preset has been stopped', async () => {
      const preset = shrinkPreset([KITCHEN])
      await engine.activate(preset)
      await settle()
      await engine.stop(preset.id)

      const result = await engine.shrink(preset.id, [KITCHEN])
      expect(result).toEqual({ shrunk: false, reason: 'no longer playing' })
    })
  })

  describe('active-state detection', () => {
    it('reports active while our queue is playing on the right speakers', async () => {
      const preset = create()
      await engine.activate(preset)
      expect(engine.isStillPlaying(preset.id)).toBe(true)
    })

    it('stays active while the coordinator is between tracks', async () => {
      const preset = create()
      await engine.activate(preset)
      driver.setTransportState(KITCHEN, 'TRANSITIONING')

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

    it('stays active when a speaker leaves, because the music has not stopped', async () => {
      // Requiring every speaker was silently fatal: one that failed to join
      // made this false forever, so reconciliation retired an activation whose
      // music played all night — and with it the wind-down and sleep timer.
      const preset = create()
      await engine.activate(preset)
      await settle()
      await driver.leaveGroup([BEDROOM])

      expect(engine.isStillPlaying(preset.id)).toBe(true)
    })

    it('still goes inactive when the coordinator itself stops', async () => {
      const preset = create()
      await engine.activate(preset)
      await settle()
      await driver.pause(KITCHEN)

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
