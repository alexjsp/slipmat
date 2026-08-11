import { randomUUID } from 'node:crypto'
import type { ActivationResult, Preset, SourceKind } from '@slipmat/shared'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import { activations } from '../db/schema.js'
import type { Logger } from '../logger.js'
import type { DriverPlayMode, SonosDriver } from '../sonos/driver.js'
import { classifyPlaybackKind, isProtectedFromPauseAll, trackIdentity } from '../sonos/uris.js'
import type { SourceCache } from '../sources/cache.js'
import type { ResolvedTrack, ResolveOptions } from '../sources/resolver.js'
import type { SystemStateStore } from '../state/store.js'
import type { PresetRepository } from './repository.js'
import { pickCoordinator } from './repository.js'
import { clockFrom, evaluateRules } from './rules.js'

/**
 * How long an activation is left alone before reconciliation may retire it.
 *
 * Sonos reaches PLAYING with a current track a beat after `Play` returns, so
 * anything shorter than this races the speaker it is asking about.
 */
const SETTLE_GRACE_MS = 10_000

/**
 * How long to let Sonos chew on a container enqueue.
 *
 * It expands the whole thing before answering: 44s for a 2,000-track Apple
 * Music playlist, comfortably past the library's fixed 30s.
 */
const CONTAINER_ENQUEUE_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Largest source playback is willing to wait on.
 *
 * Sonos expands a container before acknowledging the enqueue, at roughly a
 * second per twenty-five tracks, so a hundred tracks is about four seconds —
 * the outer edge of what a button press can absorb. Anything at or under this
 * is a candidate to open with; the rest fill in behind.
 */
const FAST_START_MAX_TRACKS = 100

/**
 * Breathing room between queue commands.
 *
 * Each of these makes Sonos expand a container, which is real work for the
 * household. Running them back to back, on top of grouping, is what turned a
 * four-second activation into a thirty-four-second one with speakers dropping
 * out.
 *
 * Five seconds because that is what worked in the shell script this replaces —
 * a number with a household behind it, rather than the half-second I had
 * guessed at. Nobody is waiting on it: the music is already playing, and this
 * only paces the sources queued behind the first one.
 */
const QUEUE_COMMAND_GAP_MS = 5000

export type ActivationDeps = {
  db: Db
  driver: SonosDriver
  store: SystemStateStore
  cache: SourceCache
  logger: Logger
  repo: PresetRepository
  /** IANA zone for evaluating time-based rules. */
  timeZone: string
  /** Injectable so rule behaviour can be tested without waiting for Thursday. */
  now?: () => Date
  /** Injectable so the random choice of opening source can be pinned in tests. */
  random?: () => number
  /** Gap between background queue commands. Zero in tests; real time in life. */
  queueGapMs?: number
}

export class ActivationEngine {
  private readonly logger: Logger
  constructor(private readonly deps: ActivationDeps) {
    this.logger = deps.logger.child({ component: 'activation' })
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))()
  }

  private random(): number {
    return (this.deps.random ?? Math.random)()
  }

  /** The live activation for a preset, if any. */
  liveActivation(presetId: string) {
    return this.deps.db
      .select()
      .from(activations)
      .where(and(eq(activations.presetId, presetId), eq(activations.live, true)))
      .get()
  }

  liveActivations() {
    return this.deps.db.select().from(activations).where(eq(activations.live, true)).all()
  }

  /**
   * Start a preset.
   *
   * Idempotent by design: a webhook that retries, or Siri sending "on" twice,
   * must not restart the music. `restart` forces a fresh shuffle.
   */
  async activate(
    preset: Preset,
    options: { restart?: boolean; seed?: number } = {},
  ): Promise<ActivationResult> {
    const existing = this.liveActivation(preset.id)
    if (existing && !options.restart) {
      const stillPlaying = this.isStillPlaying(preset.id)
      if (stillPlaying) {
        this.logger.info({ presetId: preset.id }, 'already active; no-op')
        return { activationId: existing.id, noop: true, warnings: [] }
      }
    }

    const warnings: string[] = []
    // Phase timings, because "tap to first note" is the number that matters and
    // it is made of a dozen sequential SOAP calls that are easy to misattribute.
    const phases: Record<string, number> = {}
    let mark = Date.now()
    const took = (phase: string) => {
      phases[phase] = Date.now() - mark
      mark = Date.now()
    }

    const snapshot = this.deps.driver.snapshot()
    const reachable = new Set(
      snapshot.zones.filter((zone) => !zone.unreachable).map((zone) => zone.id),
    )

    // Play on whatever answered rather than failing the whole preset for one
    // flaky speaker — but say so.
    const missing = preset.zones.filter((zone) => !reachable.has(zone.zoneId))
    for (const zone of missing) warnings.push(`${zone.zoneName} is unavailable and was skipped`)

    const coordinator = pickCoordinator(preset, reachable)
    if (!coordinator) {
      throw new Error(`None of ${preset.name}'s speakers are available`)
    }
    const members = preset.zones.filter((zone) => reachable.has(zone.zoneId))

    // Rules are evaluated once, here — a preset started at 20:59 does not
    // mutate into the wind-down version at 21:00 while someone is listening.
    const rules = this.deps.repo.rulesFor(preset.id)
    const clock = clockFrom(this.now(), this.deps.timeZone)
    const effective = evaluateRules(preset, rules, clock)
    if (effective.appliedRuleLabels.length > 0) {
      this.logger.info(
        { presetId: preset.id, rules: effective.appliedRuleLabels },
        'applied conditional rules',
      )
    }

    // Volumes and flags come from the rule-adjusted view from here on.
    const volumeByZone = new Map(effective.zoneVolumes.map((zone) => [zone.zoneId, zone.volume]))
    const flags = {
      shuffle: effective.shuffle,
      repeatAll: effective.repeatAll,
      crossfade: effective.crossfade,
      pauseOthers: effective.pauseOthers,
    }

    // Only far enough to hand each source to Sonos — no expansion, so nothing
    // borrows a speaker and a huge playlist costs nothing to prepare.
    const resolved = await this.resolveSources(effective.sources, warnings)
    took('resolve')
    const streamSource = resolved.find((source) => source.mode === 'stream')
    const containerOnly = resolved.filter((source) => source.mode === 'container_only')

    // Supersede anything already running that overlaps these speakers.
    this.invalidateOverlapping(
      members.map((zone) => zone.zoneId),
      preset.id,
    )

    if (flags.pauseOthers) {
      await this.pauseOtherGroups(members.map((zone) => zone.zoneId))
      took('pauseOthers')
    }

    // Group first, one command at a time, skipping anything already true. This
    // is the order `node-sonos-http-api` uses, and the reason for following it
    // is that concurrency here made the household unreliable: three joins at
    // once produced two thirty-second HTTP timeouts and left those rooms out of
    // the group entirely.
    const memberZoneIds = members.map((zone) => zone.zoneId)
    await this.applyGrouping(coordinator.zoneId, memberZoneIds, warnings)
    took('group')

    await this.deps.driver.setCrossfade(coordinator.zoneId, flags.crossfade).catch(() => {
      warnings.push('Crossfade could not be set')
    })
    took('crossfade')

    const activationId = randomUUID()

    if (streamSource?.containerUri) {
      // A radio stream is a single non-skippable URI; there is no queue.
      await this.deps.driver.setTransportUri(
        coordinator.zoneId,
        streamSource.containerUri,
        streamSource.containerMetadata ?? undefined,
      )
      await this.deps.driver.play(coordinator.zoneId)
      this.recordActivation({
        activationId,
        preset,
        coordinatorZoneId: coordinator.zoneId,
        memberZoneIds: members.map((zone) => zone.zoneId),
        trackUris: [],
        streamUri: streamSource.containerUri,
        warnings,
      })
      this.deps.store.refresh()
      return { activationId, noop: false, warnings }
    }

    // Queue each source as a whole container and let Sonos expand it.
    //
    // The alternative — expand every source into tracks and enqueue them one at
    // a time — is what this used to do, and it does not scale: Sonos resolves
    // each track against the music service before acknowledging the enqueue, so
    // a 2,000-track playlist took 26 minutes to load. Handing over the container
    // instead is a single call that Sonos answers in 44s for the same playlist,
    // and the first source is usually far smaller than that, so playback starts
    // in about a second.
    //
    // Interleaving then falls to Sonos' own shuffle mode rather than an
    // in-memory Fisher-Yates: the queue holds the sources back to back, and
    // shuffle picks across the whole of it, which is the same thing a listener
    // hears. Deduplication moves onto the queue afterwards, where a removal
    // costs about 4ms.
    const playable = resolved.filter(
      (source) => source.mode === 'tracks' || source.mode === 'container_only',
    )
    if (playable.length === 0) {
      throw new Error(`${preset.name} has no playable sources`)
    }

    await this.deps.driver.clearQueue(coordinator.zoneId)
    took('clearQueue')
    // Sonos answers a container enqueue only once it has expanded the whole
    // thing — 1s for a 25-track mix, 44s for a 2,000-track playlist — so which
    // source goes first decides how long the room stays silent. Under shuffle
    // queue order has no effect on what gets played, so one of the small
    // sources is moved to the front. With shuffle off the preset's order *is*
    // the playback order and must be left alone.
    const ordered = flags.shuffle ? this.orderForFastStart(playable) : playable
    const [head, ...tail] = ordered
    await this.enqueueSource(coordinator.zoneId, head!)
    took('enqueueHead')

    await this.deps.driver.setPlayMode(coordinator.zoneId, playModeFor(flags))
    await this.deps.driver.setTransportToQueue(coordinator.zoneId)
    // Otherwise every activation opens on the same song: Sonos always begins at
    // shuffled position 1 and keeps the same track there.
    //
    // Only when the queue loops, though. Starting two thirds of the way into a
    // queue that stops at the end means the first two thirds never play at all
    // — a worse trade than a predictable opening track.
    // Volumes last, and only then Play. Joining resets a member's volume, so
    // this has to follow the grouping; putting Play after it means nothing is
    // ever audible at the wrong volume, which is what the muting and unmuting
    // this replaces was trying and failing to achieve.
    await this.applyVolumes(
      members.map((zone) => ({ ...zone, volume: volumeByZone.get(zone.zoneId) ?? zone.volume })),
      warnings,
    )
    took('volumes')

    if (flags.shuffle && flags.repeatAll) await this.startSomewhereRandom(coordinator.zoneId)
    took('startPoint')
    await this.deps.driver.play(coordinator.zoneId)
    took('play')
    this.logger.info(
      {
        presetId: preset.id,
        phases,
        toFirstNoteMs: Object.values(phases).reduce((a, b) => a + b, 0),
      },
      'activation timings',
    )

    const head_queue = await this.deps.driver.getQueue(coordinator.zoneId)
    this.recordActivation({
      activationId,
      preset,
      coordinatorZoneId: coordinator.zoneId,
      memberZoneIds: members.map((zone) => zone.zoneId),
      trackUris: head_queue.map((item) => item.uri).filter((uri): uri is string => !!uri),
      streamUri: null,
      warnings,
    })

    // The rest fills in behind playback.
    void this.fillQueue(activationId, coordinator.zoneId, tail, {
      dedupe: preset.dedupe,
      shuffle: flags.shuffle,
      repeatAll: flags.repeatAll,
    }).catch((err) => this.logger.warn({ err, presetId: preset.id }, 'failed to fill queue'))

    this.deps.store.refresh()
    return { activationId, noop: false, warnings }
  }

  /**
   * Drop the preset back to the rooms it is meant to end in.
   *
   * Only the zones this activation actually grouped are ungrouped, so a room
   * someone joined by hand is left where they put it. The coordinator is never
   * dropped — the queue lives on it, and ungrouping it would stop the music
   * everywhere rather than narrow it.
   *
   * Returns what it did, so the caller can record it and not do it twice.
   */
  async shrink(
    presetId: string,
    keepZoneIds: string[],
  ): Promise<{ shrunk: true; dropped: string[] } | { shrunk: false; reason: string }> {
    const activation = this.liveActivation(presetId)
    if (!activation) return { shrunk: false, reason: 'no longer playing' }

    const keep = new Set(keepZoneIds)
    if (!keep.has(activation.coordinatorZoneId)) {
      // Can happen without the preset being wrong: if the intended coordinator
      // was unreachable at activation, another zone took the role.
      return {
        shrunk: false,
        reason: `the queue is on a speaker that is not in the keep list (${activation.coordinatorZoneId})`,
      }
    }

    const mine = JSON.parse(activation.memberZoneIdsJson) as string[]
    const dropped = mine.filter((zoneId) => !keep.has(zoneId))
    if (dropped.length === 0) return { shrunk: false, reason: 'nothing left to drop' }

    await this.deps.driver.leaveGroup(dropped)
    this.deps.db
      .update(activations)
      .set({ memberZoneIdsJson: JSON.stringify(mine.filter((zoneId) => keep.has(zoneId))) })
      .where(eq(activations.id, activation.id))
      .run()
    this.deps.store.refresh()
    this.logger.info({ presetId, dropped }, 'shrank preset to its keep list')
    return { shrunk: true, dropped }
  }

  /** Record that the shrink has been dealt with, so a tick loop won't retry it. */
  markShrunk(activationId: string) {
    this.deps.db
      .update(activations)
      .set({ shrunkAt: new Date().toISOString() })
      .where(eq(activations.id, activationId))
      .run()
  }

  async stop(presetId: string): Promise<boolean> {
    const activation = this.liveActivation(presetId)
    if (!activation) return false
    // Pause only: the group, volumes and queue stay as they are, so playback
    // can be resumed from the Sonos app.
    await this.deps.driver.pause(activation.coordinatorZoneId).catch(() => undefined)
    this.markStopped(activation.id)
    this.deps.store.refresh()
    return true
  }

  /**
   * The "loose" active-state test: the coordinator is still playing something
   * we queued. Survives skips, a speaker joining or leaving, and a wind-down to
   * fewer rooms; goes false on pause, stop, or the queue being replaced.
   */
  isStillPlaying(presetId: string): boolean {
    const activation = this.liveActivation(presetId)
    if (!activation) return false

    const snapshot = this.deps.driver.snapshot()
    const group = snapshot.groups.find(
      (candidate) => candidate.coordinatorZoneId === activation.coordinatorZoneId,
    )
    // TRANSITIONING counts as playing. Sonos passes through it between every
    // pair of tracks, and for minutes on end while a large preset's tail is
    // still being appended — treating it as stopped makes a preset flicker off
    // at every track change and stay off through the whole append.
    if (group?.transportState !== 'PLAYING' && group?.transportState !== 'TRANSITIONING') {
      return false
    }

    // Deliberately no check that every zone the preset asked for is still in
    // the group. The music lives on the coordinator, and whether some other
    // room is currently along for the ride says nothing about whether this
    // preset is playing. Requiring all of them was silently fatal: one speaker
    // that failed to join made this false forever, so reconciliation retired an
    // activation whose music was playing all night — taking the wind-down, the
    // sleep timer and the HomeKit switch with it.

    if (activation.streamUri) return group.transportUri === activation.streamUri

    // Compared by item identity, not by URI: Sonos swaps the scheme once it has
    // resolved a track against its service, so what comes back out of the queue
    // is never the string we put in.
    const queued = new Set(
      (JSON.parse(activation.trackUrisJson) as string[])
        .map(trackIdentity)
        .filter((identity): identity is string => identity !== null),
    )
    const playing = trackIdentity(group.currentTrackUri)
    return !!playing && queued.has(playing)
  }

  /** Drop activations whose reality no longer matches, so switches go off. */
  reconcile(): void {
    const now = this.now().getTime()
    for (const activation of this.liveActivations()) {
      // A just-started activation has not had time to become true yet. Grouping
      // and volume changes each emit an event, and reconcile runs on every one
      // of them — all while the coordinator is still TRANSITIONING with no
      // current track. Without this the activation is marked dead within
      // milliseconds of being created, and no later event ever revives it.
      const age = now - new Date(activation.startedAt).getTime()
      if (age < SETTLE_GRACE_MS) continue
      if (!this.isStillPlaying(activation.presetId)) this.markStopped(activation.id)
    }
  }

  // --- steps --------------------------------------------------------------

  private async resolveSources(
    sources: { kind: SourceKind; ref: string; label: string }[],
    warnings: string[],
  ) {
    const resolved = []
    for (const source of sources) {
      try {
        resolved.push(
          await this.deps.cache.forPlayback({
            kind: source.kind,
            ref: source.ref,
            label: source.label,
          }),
        )
      } catch (err) {
        this.logger.warn({ err, ref: source.ref }, 'source failed to resolve')
        warnings.push(`"${source.label}" could not be loaded`)
      }
    }
    return resolved
  }

  /**
   * This warning is for the *commands* failing, not for being unable to confirm
   * they worked. Waiting for topology to settle is best-effort inside the
   * driver, deliberately: a snapshot that cannot be read says nothing about
   * whether the speakers grouped, and reporting a failure on that basis told
   * people their preset was broken when it was playing correctly.
   */
  /**
   * Bring the other rooms in behind the music.
   *
   * A follower is only unmuted once Sonos confirms it is actually in the group.
   * Unmuting unconditionally is a bug I shipped: when a join failed, the mute
   * was lifted on a speaker that had never joined, so it went back to being
   * audible playing whatever it had been playing before the preset started.
   * A room the preset claimed and failed to get is better left silent.
   */
  private async joinFollowers(
    activationId: string,
    coordinatorZoneId: string,
    followers: { zoneId: string; zoneName: string; volume: number }[],
  ) {
    if (followers.length === 0) return
    const zoneIds = followers.map((zone) => zone.zoneId)

    // Parallel, and measured: one join takes ~2.6s because Sonos does not answer
    // until the speaker has torn down what it was doing. Sequentially that is
    // eight seconds for a four-room preset.
    // The coordinator is already standalone and already playing; making it
    // standalone again here stops it. That is what left activations sitting at
    // STOPPED with a track loaded, roughly half the time.
    await this.deps.driver
      .joinGroup(coordinatorZoneId, zoneIds, { makeStandalone: false })
      .catch((err) => {
        this.logger.warn({ err, coordinatorZoneId }, 'joining followers failed')
      })

    // Four joins landing at once can outrun the topology settle, and a speaker
    // that is merely late must not be written off as absent — being written off
    // means staying muted all evening. So ask again, and ask it to join again,
    // before concluding anything.
    let missing = this.notInGroup(coordinatorZoneId, followers)
    if (missing.length > 0) {
      await this.deps.driver
        .joinGroup(
          coordinatorZoneId,
          missing.map((zone) => zone.zoneId),
          { makeStandalone: false },
        )
        .catch((err) => this.logger.warn({ err, coordinatorZoneId }, 'retrying joins failed'))
      missing = this.notInGroup(coordinatorZoneId, followers)
    }

    const late = new Set(missing.map((zone) => zone.zoneId))
    const stranded: string[] = []
    for (const zone of followers) {
      if (late.has(zone.zoneId)) {
        stranded.push(zone.zoneName)
        continue
      }
      // Volume after the join, never before: joining resets it.
      await this.deps.driver.setVolume(zone.zoneId, zone.volume).catch((err) => {
        this.logger.warn({ err, zoneId: zone.zoneId }, 'volume failed')
      })
      await this.deps.driver.setMute(zone.zoneId, false).catch(() => undefined)
    }

    if (stranded.length > 0) {
      this.logger.warn({ coordinatorZoneId, stranded }, 'speakers never joined; left muted')
      this.addWarnings(activationId, [
        `${stranded.join(', ')} did not join and ${stranded.length === 1 ? 'is' : 'are'} left silent`,
      ])
    }
  }

  private notInGroup<T extends { zoneId: string }>(coordinatorZoneId: string, zones: T[]): T[] {
    const group = this.deps.driver
      .snapshot()
      .groups.find((candidate) => candidate.coordinatorZoneId === coordinatorZoneId)
    const joined = new Set(group?.memberZoneIds ?? [])
    return zones.filter((zone) => !joined.has(zone.zoneId))
  }

  /** Append to an activation's warnings after the fact, for anything late. */
  private addWarnings(activationId: string, extra: string[]) {
    const row = this.deps.db
      .select()
      .from(activations)
      .where(eq(activations.id, activationId))
      .get()
    if (!row) return
    const existing = JSON.parse(row.warningsJson) as string[]
    this.deps.db
      .update(activations)
      .set({ warningsJson: JSON.stringify([...existing, ...extra]) })
      .where(eq(activations.id, activationId))
      .run()
    this.deps.store.refresh()
  }

  /**
   * Put exactly the preset's speakers in one group, doing as little as possible.
   *
   * Modelled on `node-sonos-http-api`'s `applyPreset`, which has been reliable
   * for years where this had become flaky. The lessons taken from it:
   *
   * - one command at a time, never several at once;
   * - never redo work that is already done — a speaker already following this
   *   coordinator is left alone, which makes re-running a preset nearly free;
   * - only break the coordinator out when it is somebody's follower. If it is
   *   already coordinating, remove the rooms that should not be there instead
   *   of tearing the group down and rebuilding it.
   */
  private async applyGrouping(coordinatorZoneId: string, zoneIds: string[], warnings: string[]) {
    const wanted = new Set(zoneIds)
    try {
      const group = this.deps.driver
        .snapshot()
        .groups.find((candidate) => candidate.coordinatorZoneId === coordinatorZoneId)

      // No group of its own means it is following someone else, and has to be
      // broken out before anyone can follow it.
      if (!group) {
        await this.deps.driver.leaveGroup([coordinatorZoneId])
      }

      const present = new Set(group?.memberZoneIds ?? [coordinatorZoneId])
      const missing = zoneIds.filter(
        (zoneId) => zoneId !== coordinatorZoneId && !present.has(zoneId),
      )
      if (missing.length > 0) {
        await this.deps.driver.joinGroup(coordinatorZoneId, missing, { makeStandalone: false })
      }

      const superfluous = [...present].filter(
        (zoneId) => zoneId !== coordinatorZoneId && !wanted.has(zoneId),
      )
      if (superfluous.length > 0) {
        await this.deps.driver.leaveGroup(superfluous)
      }
    } catch (err) {
      this.logger.warn({ err, coordinatorZoneId }, 'grouping failed')
      warnings.push('Speakers could not be grouped as configured')
    }
  }

  private async applyVolumes(
    zones: { zoneId: string; zoneName: string; volume: number }[],
    warnings: string[],
  ) {
    // Deliberately after grouping settles — a join resets member volumes.
    for (const zone of zones) {
      try {
        await this.deps.driver.setVolume(zone.zoneId, zone.volume)
        await this.deps.driver.setMute(zone.zoneId, false)
      } catch (err) {
        this.logger.warn({ err, zoneId: zone.zoneId }, 'volume failed')
        warnings.push(`${zone.zoneName}'s volume could not be set`)
      }
    }
  }

  private async pauseOtherGroups(memberZoneIds: string[]) {
    const mine = new Set(memberZoneIds)
    for (const group of this.deps.driver.snapshot().groups) {
      if (group.memberZoneIds.some((zoneId) => mine.has(zoneId))) continue
      if (group.transportState !== 'PLAYING') continue
      // Same rule as Pause All Music: `pauseOthers` means other *music*, so a
      // preset must never cut the TV off mid-programme.
      const kind = classifyPlaybackKind(group.transportUri, group.currentTrackUri)
      if (isProtectedFromPauseAll(kind)) continue
      await this.deps.driver.pause(group.coordinatorZoneId).catch(() => undefined)
    }
  }

  /**
   * Choose which source playback waits on, and put it first.
   *
   * Any source small enough to enqueue quickly will do, so the choice is
   * random among them rather than simply the smallest. Always picking the
   * smallest is predictable in a way that shows: a preset holding one album and
   * three medium playlists would open on that same album every single day, even
   * though the point of shuffle is that it shouldn't.
   *
   * If nothing is small enough — every source is huge, or none has a known
   * count — fall back to the smallest known, since waiting on a 200-track
   * playlist still beats waiting on a 2,000-track one.
   */
  private orderForFastStart(sources: EnqueueableSource[]): EnqueueableSource[] {
    if (sources.length < 2) return sources

    const quick = sources.filter(
      (source) => source.tracks.length > 0 && source.tracks.length <= FAST_START_MAX_TRACKS,
    )
    const head = quick.length
      ? quick[Math.floor(this.random() * quick.length)]
      : [...sources].sort(bySmallestKnownFirst)[0]
    if (!head) return sources

    return [head, ...sources.filter((source) => source !== head)]
  }

  /**
   * Put one source into the queue.
   *
   * A container goes in whole and Sonos expands it — one call, and the tracks
   * arrive with full metadata because Sonos resolved them itself. Sources with
   * no container URI (Sonos playlists and the local library, which are browsed
   * rather than pointed at) fall back to their individual tracks.
   */
  private async enqueueSource(zoneId: string, source: EnqueueableSource): Promise<void> {
    const started = Date.now()
    if (source.containerUri) {
      await this.deps.driver.addUrisToQueue(
        zoneId,
        [
          {
            uri: source.containerUri,
            metadata: source.containerMetadata ?? undefined,
            metadataObject: source.containerMetadataObject,
          },
        ],
        // Sonos expands the container before answering, which for a few
        // thousand tracks is well past the default timeout.
        { timeoutMs: CONTAINER_ENQUEUE_TIMEOUT_MS },
      )
    } else {
      await this.deps.driver.addUrisToQueue(
        zoneId,
        source.tracks.map((track) => ({ uri: track.uri, metadata: track.metadata ?? undefined })),
      )
    }
    this.logger.debug(
      {
        label: source.label,
        viaContainer: !!source.containerUri,
        elapsedMs: Date.now() - started,
      },
      'queued source',
    )
  }

  /**
   * Add the remaining sources behind playback, then dedupe and re-shuffle.
   *
   * Liveness is checked between sources: stopping the preset, or starting
   * another on the same speakers, must not leave this still stuffing tracks in
   * behind the new music.
   */
  private async fillQueue(
    activationId: string,
    zoneId: string,
    sources: EnqueueableSource[],
    options: { dedupe: boolean; shuffle: boolean; repeatAll: boolean },
  ): Promise<void> {
    // Let the grouping finish before adding anything else. The remaining
    // sources are large container enqueues, and stacking them on top of a
    // household still moving speakers between groups is what made this
    // unreliable in the first place.
    await this.deps.driver.awaitGrouping(zoneId, []).catch(() => undefined)

    for (const source of sources) {
      if (!this.isLive(activationId)) {
        this.logger.info({ activationId }, 'queue fill abandoned; activation is no longer live')
        return
      }
      await this.enqueueSource(zoneId, source)
      // Between commands, not after the last one — at five seconds a trailing
      // pause is five seconds of holding up the dedupe and the shuffle.
      const gap = this.deps.queueGapMs ?? QUEUE_COMMAND_GAP_MS
      const isLast = source === sources[sources.length - 1]
      if (gap > 0 && !isLast) await new Promise((resolve) => setTimeout(resolve, gap))
    }
    if (!this.isLive(activationId)) return

    if (options.dedupe) await this.dedupeQueue(zoneId)
    if (!this.isLive(activationId)) return

    // Re-asserted now the queue is complete, so the shuffled order spans all of
    // it rather than the opening source it was generated over.
    await this.deps.driver.setPlayMode(zoneId, playModeFor(options))

    const queue = await this.deps.driver.getQueue(zoneId)
    if (!this.isLive(activationId)) return
    this.deps.db
      .update(activations)
      .set({
        trackUrisJson: JSON.stringify(
          queue.map((item) => item.uri).filter((uri): uri is string => !!uri),
        ),
      })
      .where(eq(activations.id, activationId))
      .run()
  }

  /**
   * Start the queue somewhere random.
   *
   * Sonos' shuffle is real — `Browse Q:0` returns a shuffled order once the
   * mode is set, re-randomised each time it is set — but pressing play always
   * begins at shuffled position 1, and Sonos pins the same track there. Five
   * consecutive starts on a 2,082-track queue opened on the same song every
   * time. Seeking to a random position indexes the shuffled order, so this is
   * the missing half of what the app's shuffle button does.
   *
   * Only sound when the queue repeats: everything before the starting point is
   * reached by looping round, and without repeat it is simply never played.
   */
  private async startSomewhereRandom(zoneId: string): Promise<void> {
    const queue = await this.deps.driver.getQueue(zoneId)
    if (queue.length < 2) return
    const position = 1 + Math.floor(this.random() * queue.length)
    await this.deps.driver.seekToTrack(zoneId, position).catch((err) => {
      this.logger.debug({ err, position }, 'could not pick a random starting track')
    })
  }

  /**
   * Drop tracks the queue already contains.
   *
   * Sources overlap — a favourites mix and a "great music" playlist share
   * plenty — and enqueuing containers wholesale means those duplicates land in
   * the queue. Removals go back to front because each one shifts the positions
   * after it.
   */
  private async dedupeQueue(zoneId: string): Promise<void> {
    const queue = await this.deps.driver.getQueue(zoneId)
    const group = this.deps.driver
      .snapshot()
      .groups.find((candidate) => candidate.coordinatorZoneId === zoneId)
    // Whatever is playing right now stays, even if it is the duplicate: pulling
    // it out from under the transport skips the track someone is listening to.
    const playing = trackIdentity(group?.currentTrackUri)

    const seen = new Set<string>()
    const duplicates: number[] = []
    queue.forEach((item, index) => {
      const identity = trackIdentity(item.uri)
      if (!identity) return
      if (!seen.has(identity)) {
        seen.add(identity)
        return
      }
      if (identity === playing) return
      duplicates.push(index + 1)
    })
    if (duplicates.length === 0) return

    const started = Date.now()
    for (const position of duplicates.reverse()) {
      await this.deps.driver.removeTrackFromQueue(zoneId, position).catch((err) => {
        this.logger.debug({ err, position }, 'failed to remove duplicate')
      })
    }
    this.logger.info(
      { removed: duplicates.length, of: queue.length, elapsedMs: Date.now() - started },
      'deduped queue',
    )
  }

  private isLive(activationId: string): boolean {
    return !!this.deps.db.select().from(activations).where(eq(activations.id, activationId)).get()
      ?.live
  }

  // --- bookkeeping --------------------------------------------------------

  private recordActivation(input: {
    activationId: string
    preset: Preset
    coordinatorZoneId: string
    memberZoneIds: string[]
    trackUris: string[]
    streamUri: string | null
    warnings: string[]
  }) {
    this.deps.db
      .insert(activations)
      .values({
        id: input.activationId,
        presetId: input.preset.id,
        coordinatorZoneId: input.coordinatorZoneId,
        memberZoneIdsJson: JSON.stringify(input.memberZoneIds),
        trackUrisJson: JSON.stringify(input.trackUris),
        streamUri: input.streamUri,
        warningsJson: JSON.stringify(input.warnings),
        live: true,
        // Stamped from the engine's clock rather than the database's, so
        // everything that reasons about elapsed time — sleep timers especially —
        // agrees on what "now" means.
        startedAt: this.now().toISOString(),
      })
      .run()
  }

  private markStopped(activationId: string) {
    this.deps.db
      .update(activations)
      .set({ live: false })
      .where(eq(activations.id, activationId))
      .run()
  }

  private invalidateOverlapping(zoneIds: string[], exceptPresetId: string) {
    const mine = new Set(zoneIds)
    for (const activation of this.liveActivations()) {
      if (activation.presetId === exceptPresetId) {
        this.markStopped(activation.id)
        continue
      }
      const members = JSON.parse(activation.memberZoneIdsJson) as string[]
      if (members.some((zoneId) => mine.has(zoneId))) this.markStopped(activation.id)
    }
  }
}

/** Derive a stable numeric seed from the activation id. */
function seedFor(activationId: string): number {
  let hash = 0
  for (let index = 0; index < activationId.length; index++) {
    hash = (Math.imul(31, hash) + activationId.charCodeAt(index)) | 0
  }
  return hash >>> 0
}

/**
 * A resolved source in the form the queue builder needs: either something Sonos
 * can expand itself, or a list of tracks to add individually.
 */
type EnqueueableSource = {
  label: string
  containerUri: string | null
  containerMetadata: string | null
  containerMetadataObject?: unknown
  tracks: ResolvedTrack[]
}

/**
 * Sonos does the interleaving, so shuffle is a play mode rather than something
 * baked into queue order. `SHUFFLE` means shuffle *and* repeat-all, which is
 * why the no-repeat variant is a separate mode rather than a second flag.
 */
function playModeFor(flags: { shuffle: boolean; repeatAll: boolean }): DriverPlayMode {
  if (flags.shuffle) return flags.repeatAll ? 'SHUFFLE' : 'SHUFFLE_NOREPEAT'
  return flags.repeatAll ? 'REPEAT_ALL' : 'NORMAL'
}

/**
 * Smallest known track count first, unknown counts last.
 *
 * The fallback for when no source is small enough to be a good opener. A source
 * with no cached count could be either, so it does not get to hold up the start.
 */
function bySmallestKnownFirst(a: EnqueueableSource, b: EnqueueableSource): number {
  const sizeOf = (source: EnqueueableSource) =>
    source.tracks.length > 0 ? source.tracks.length : Number.MAX_SAFE_INTEGER
  return sizeOf(a) - sizeOf(b)
}
