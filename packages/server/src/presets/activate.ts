import { randomUUID } from 'node:crypto'
import type { ActivationResult, BlockRule, Preset, SourceKind } from '@slipmat/shared'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import { activations } from '../db/schema.js'
import type { Logger } from '../logger.js'
import type { DriverPlayMode, SonosDriver } from '../sonos/driver.js'
import {
  classifyPlaybackKind,
  isOwnQueueUri,
  isProtectedFromPauseAll,
  trackIdentity,
} from '../sonos/uris.js'
import type { SourceCache } from '../sources/cache.js'
import type { ResolvedTrack, ResolveOptions } from '../sources/resolver.js'
import type { SystemStateStore } from '../state/store.js'
import { compileBlocklist, isBlocked } from './blocklist.js'
import { songKey } from './duplicates.js'
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

/**
 * How many blocked tracks in a row to skip before giving up.
 *
 * A queue of nothing but blocked music would otherwise skip forever, hammering
 * the speaker. The prune that follows removes them anyway.
 */
const MAX_BLOCKED_SKIPS = 8

/**
 * How many unrecognised tracks in a row mean the queue is no longer ours.
 *
 * Adding a song from the Sonos app leaves the preset's queue exactly where it
 * was with one extra track in it, and shuffle will land on that track sooner or
 * later. Retiring on the first one we don't recognise is what took the Morning
 * preset's switch off at 6am on a queue that played all day: a single hand-
 * queued track, one reconcile while it played, and the activation was gone for
 * good.
 *
 * Three *distinct* tracks in a row, so a handful of additions is ridiculous
 * odds against, while a queue someone genuinely replaced is retired within a
 * few minutes of music.
 */
const FOREIGN_TRACK_LIMIT = 3

/** One row of the activations table, as read back. */
type ActivationRow = typeof activations.$inferSelect

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
  /** Music never to play. Absent means no blocklist, which is the default. */
  settings?: { blocklist(): BlockRule[] }
  /** How long to let a skip land. Zero in tests; a real speaker needs a moment. */
  skipSettleMs?: number
  /** Gap between background queue commands. Zero in tests; real time in life. */
  queueGapMs?: number
}

export class ActivationEngine {
  private readonly logger: Logger
  /**
   * Activations under way, by preset.
   *
   * The idempotence check below reads the activation *record*, which is only
   * written once the music is playing — so two taps a fraction apart both saw
   * nothing running and both went ahead. Bedtime did exactly that: two
   * activations 85ms apart, fighting over the grouping, the first ending up
   * with a single room in it.
   */
  private readonly inFlight = new Map<string, Promise<ActivationResult>>()
  /**
   * Tracks we did not queue, seen playing out of an activation's queue, by
   * activation. In memory rather than in the database: a restart's worth of
   * doubt is not worth persisting, and reconcile rebuilds it within a track.
   */
  private readonly unrecognised = new Map<string, Set<string>>()
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
    options: {
      restart?: boolean
      seed?: number
      /**
       * What asked for this — `homekit`, `webhook`, `schedule`, `ui`.
       *
       * Recorded because the log could not previously tell them apart: a
       * HomeKit tap makes no HTTP request, so an activation that failed before
       * it reached the timings line was indistinguishable from one that never
       * happened.
       */
      trigger?: string
    } = {},
  ): Promise<ActivationResult> {
    const running = this.inFlight.get(preset.id)
    if (running) {
      // Joined rather than refused: a second tap wants the preset playing, and
      // it is about to be. Refusing would report a failure for something that
      // is working.
      this.logger.info(
        { presetId: preset.id, trigger: options.trigger ?? 'unknown' },
        'activation already under way; joining it rather than starting a second',
      )
      return running
    }

    const run = this.runActivation(preset, options).finally(() => {
      this.inFlight.delete(preset.id)
    })
    this.inFlight.set(preset.id, run)
    return run
  }

  private async runActivation(
    preset: Preset,
    options: { restart?: boolean; seed?: number; trigger?: string },
  ): Promise<ActivationResult> {
    const trigger = options.trigger ?? 'unknown'
    this.logger.info(
      { presetId: preset.id, preset: preset.name, trigger, restart: options.restart ?? false },
      'activating preset',
    )
    const existing = this.liveActivation(preset.id)
    if (existing && !options.restart) {
      const stillPlaying = this.isStillPlaying(preset.id)
      if (stillPlaying) {
        this.logger.info({ presetId: preset.id, trigger }, 'already active; no-op')
        return { activationId: existing.id, noop: true, warnings: [] }
      }
    }

    const warnings: string[] = []
    // Phase timings, because "tap to first note" is the number that matters and
    // it is made of a dozen sequential SOAP calls that are easy to misattribute.
    const phases: Record<string, number> = {}
    let mark = Date.now()
    let lastPhase = 'start'
    const took = (phase: string) => {
      phases[phase] = Date.now() - mark
      lastPhase = phase
      mark = Date.now()
    }
    /**
     * Everything from the first speaker command to Play, so a failure in the
     * middle is not silent. It used to be: `activation timings` is only written
     * once Play returns, and nothing in between was wrapped, so an activation
     * that regrouped the house and then threw left no trace at all — no error,
     * no timings, not even an activation row.
     */
    const speakerWork = async <T>(run: () => Promise<T>): Promise<T> => {
      try {
        return await run()
      } catch (err) {
        this.logger.error(
          {
            err,
            presetId: preset.id,
            preset: preset.name,
            trigger,
            phases,
            failedAfter: lastPhase,
          },
          'activation failed partway; speakers may be left regrouped and silent',
        )
        throw err
      }
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

    // Nothing playable means stop here, before a single speaker is touched.
    // This check used to sit after the grouping, so a preset whose sources had
    // all failed would rearrange the whole house and then abort — leaving every
    // room ungrouped and silent, which is exactly how it looks from the sofa.
    // Playable means there is actually something to hand Sonos: a container it
    // can expand, or tracks to enqueue. A source can resolve "successfully" to
    // neither — an empty playlist comes back as container-only with no
    // container URI — and counting that as playable is how an activation gets
    // far enough to rearrange the house before discovering it has no music.
    const playableSources = resolved.filter(
      (source) =>
        (source.mode === 'tracks' || source.mode === 'container_only') &&
        (source.containerUri !== null || source.tracks.length > 0),
    )
    if (!resolved.some((source) => source.mode === 'stream') && playableSources.length === 0) {
      throw new Error(
        `${preset.name} has nothing playable: ${warnings.join('; ') || 'no sources resolved'}`,
      )
    }

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
    const playable = playableSources

    await speakerWork(() => this.deps.driver.clearQueue(coordinator.zoneId))
    took('clearQueue')
    // Sonos answers a container enqueue only once it has expanded the whole
    // thing — 1s for a 25-track mix, 44s for a 2,000-track playlist — so which
    // source goes first decides how long the room stays silent. Under shuffle
    // queue order has no effect on what gets played, so one of the small
    // sources is moved to the front. With shuffle off the preset's order *is*
    // the playback order and must be left alone.
    const ordered = flags.shuffle ? this.orderForFastStart(playable) : playable
    const [head, ...tail] = ordered
    await speakerWork(() => this.enqueueSource(coordinator.zoneId, head!))
    took('enqueueHead')

    await speakerWork(async () => {
      await this.deps.driver.setPlayMode(coordinator.zoneId, playModeFor(flags))
      await this.deps.driver.setTransportToQueue(coordinator.zoneId)
    })
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
    await speakerWork(() => this.deps.driver.play(coordinator.zoneId))
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
    this.markStopped(activation, 'stopped by request')
    this.deps.store.refresh()
    return true
  }

  /**
   * The "loose" active-state test: the coordinator is still playing our queue.
   * Survives skips, tracks someone queued by hand, a speaker joining or
   * leaving, and a wind-down to fewer rooms; goes false on pause, stop, or the
   * queue being handed to something else.
   */
  isStillPlaying(presetId: string): boolean {
    const activation = this.liveActivation(presetId)
    if (!activation) return false
    return this.liveness(activation).state !== 'gone'
  }

  /**
   * What the speakers say about one activation, in the terms reconcile needs.
   *
   * `unrecognised` is the interesting one: the group is still playing the queue
   * we built, but on a track that was not in it. One of those is somebody
   * adding a song from the Sonos app and means nothing; a run of them means the
   * queue is no longer the preset's.
   */
  private liveness(
    activation: ActivationRow,
  ):
    | { state: 'playing' }
    | { state: 'unrecognised'; identity: string }
    | { state: 'gone'; reason: string } {
    const snapshot = this.deps.driver.snapshot()
    const group = snapshot.groups.find(
      (candidate) => candidate.coordinatorZoneId === activation.coordinatorZoneId,
    )
    if (!group) return { state: 'gone', reason: 'the coordinator no longer leads a group' }

    // TRANSITIONING counts as playing. Sonos passes through it between every
    // pair of tracks, and for minutes on end while a large preset's tail is
    // still being appended — treating it as stopped makes a preset flicker off
    // at every track change and stay off through the whole append.
    if (group.transportState !== 'PLAYING' && group.transportState !== 'TRANSITIONING') {
      return { state: 'gone', reason: `the coordinator is ${group.transportState}` }
    }

    // Deliberately no check that every zone the preset asked for is still in
    // the group. The music lives on the coordinator, and whether some other
    // room is currently along for the ride says nothing about whether this
    // preset is playing. Requiring all of them was silently fatal: one speaker
    // that failed to join made this false forever, so reconciliation retired an
    // activation whose music was playing all night — taking the wind-down, the
    // sleep timer and the HomeKit switch with it.

    if (activation.streamUri) {
      return group.transportUri === activation.streamUri
        ? { state: 'playing' }
        : { state: 'gone', reason: 'the group is playing something other than our stream' }
    }

    // The queue itself is what identifies the activation now, not whichever
    // track happens to be playing out of it. A group pointed at its own queue
    // is playing the queue we filled — Sonos has no way to swap the contents
    // wholesale without going through us or through a transport change.
    if (!isOwnQueueUri(group.transportUri, activation.coordinatorZoneId)) {
      return { state: 'gone', reason: 'the group is no longer playing its own queue' }
    }

    // Compared by item identity, not by URI: Sonos swaps the scheme once it has
    // resolved a track against its service, so what comes back out of the queue
    // is never the string we put in.
    const queued = new Set(
      (JSON.parse(activation.trackUrisJson) as string[])
        .map(trackIdentity)
        .filter((identity): identity is string => identity !== null),
    )
    const playing = trackIdentity(group.currentTrackUri)
    // No readable track is not evidence of anything: events arrive with the URI
    // missing while a track is being loaded, and the queue is still ours.
    if (!playing) return { state: 'playing' }
    return queued.has(playing) ? { state: 'playing' } : { state: 'unrecognised', identity: playing }
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

      const verdict = this.liveness(activation)
      if (verdict.state === 'gone') {
        this.markStopped(activation, verdict.reason)
        continue
      }
      if (verdict.state === 'playing') {
        // One of ours again: whatever was playing before was a guest, not a
        // sign that the queue had moved on.
        this.unrecognised.delete(activation.id)
        continue
      }

      // Counted by identity rather than by sighting, because reconcile runs on
      // every state change — volume, grouping, position — and a single track
      // would otherwise reach any limit within seconds of starting.
      const seen = this.unrecognised.get(activation.id) ?? new Set<string>()
      seen.add(verdict.identity)
      this.unrecognised.set(activation.id, seen)
      if (seen.size >= FOREIGN_TRACK_LIMIT) {
        this.markStopped(activation, `${seen.size} tracks in a row that this preset did not queue`)
      }
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

    const gap = this.deps.queueGapMs ?? QUEUE_COMMAND_GAP_MS
    const breathe = () =>
      gap > 0 ? new Promise((resolve) => setTimeout(resolve, gap)) : Promise.resolve()

    // The caller has just enqueued the first source, and that counts. A preset
    // with a single source — which most are — would otherwise go straight from
    // that container expansion into removing duplicates and setting the play
    // mode, with no pause anywhere, because the loop below has nothing to do.
    await breathe()

    for (const source of sources) {
      if (!this.isLive(activationId)) {
        this.logger.info({ activationId }, 'queue fill abandoned; activation is no longer live')
        return
      }
      await this.enqueueSource(zoneId, source)
      // After every one of them, the last included. Skipping the final pause
      // looked like a free five seconds and is the opposite: enqueueing a
      // container is the command that leaves a speaker labouring, and what
      // comes next — removing duplicates, re-asserting the play mode — lands
      // straight on it.
      await breathe()
    }
    if (!this.isLive(activationId)) return

    // Always run: the blocklist has to be applied even when deduplication is
    // off, and it is the same pass over the same queue.
    await this.dedupeQueue(zoneId, { dedupe: options.dedupe })
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
   * Skip forward until what is playing is something you want to hear.
   *
   * Bounded, because the alternative is a queue of nothing but blocked music
   * skipping forever, hammering the speaker. If the limit is reached the prune
   * still runs, which clears the queue of them so the next track is clean.
   */
  private async skipPastBlocked(
    zoneId: string,
    blocked: ReturnType<typeof compileBlocklist>,
  ): Promise<void> {
    for (let skips = 0; skips < MAX_BLOCKED_SKIPS; skips += 1) {
      const group = this.deps.driver
        .snapshot()
        .groups.find((candidate) => candidate.coordinatorZoneId === zoneId)
      const playing = group?.currentTrack
      if (!playing || !isBlocked(playing, blocked)) return

      this.logger.info(
        { zoneId, title: playing.title, artist: playing.artist },
        'skipping blocked track',
      )
      await this.deps.driver.next(zoneId).catch((err) => {
        this.logger.warn({ err, zoneId }, 'could not skip a blocked track')
      })
      // The speaker reports the new track over an event, which takes a moment.
      await new Promise((resolve) => setTimeout(resolve, this.deps.skipSettleMs ?? 700))
    }
    this.logger.warn({ zoneId }, 'gave up skipping blocked tracks; the prune will clear them')
  }

  /**
   * Drop tracks the queue already contains.
   *
   * Sources overlap — a favourites mix and a "great music" playlist share
   * plenty — and enqueuing containers wholesale means those duplicates land in
   * the queue. Removals go back to front because each one shifts the positions
   * after it.
   */
  private async dedupeQueue(zoneId: string, options: { dedupe: boolean }): Promise<void> {
    const blocked = compileBlocklist(this.deps.settings?.blocklist() ?? [], this.logger)
    if (!options.dedupe && blocked.length === 0) return

    // Move off a blocked track before pruning. The prune runs a few seconds
    // after playback starts, so the track it opened on — picked at random from
    // the queue — may well be one you never want to hear. Removing it from the
    // queue is not enough; it is already playing.
    if (blocked.length > 0) await this.skipPastBlocked(zoneId, blocked)

    const queue = await this.deps.driver.getQueue(zoneId)
    const group = this.deps.driver
      .snapshot()
      .groups.find((candidate) => candidate.coordinatorZoneId === zoneId)
    // Whatever is playing right now stays, even if it is the duplicate: pulling
    // it out from under the transport skips the track someone is listening to.
    const playing = trackIdentity(group?.currentTrackUri)

    const playingSong = songKey(group?.currentTrack ?? {})
    // Two ways of being the same track, and either is enough. The URI identity
    // catches the literal same item; the song key catches the same recording
    // reached through a different playlist, which Apple Music hands back under
    // a different library id and which the URI can therefore never match.
    const seenUris = new Set<string>()
    const seenSongs = new Set<string>()
    const remove: number[] = []
    let blockedCount = 0
    queue.forEach((item, index) => {
      // Blocked first: a track you never want to hear should go whether or not
      // it is also a duplicate.
      if (isBlocked({ title: item.title, artist: item.artist, album: item.album }, blocked)) {
        blockedCount += 1
        remove.push(index + 1)
        return
      }
      const identity = trackIdentity(item.uri)
      const song = songKey(item)
      const duplicate =
        (identity !== null && seenUris.has(identity)) || (song !== null && seenSongs.has(song))
      if (!duplicate) {
        if (identity) seenUris.add(identity)
        if (song) seenSongs.add(song)
        return
      }
      if (!options.dedupe) return
      // Never the one currently playing, by either measure.
      if (identity !== null && identity === playing) return
      if (song !== null && song === playingSong) return
      remove.push(index + 1)
    })
    if (remove.length === 0) return

    const started = Date.now()
    for (const position of remove.reverse()) {
      await this.deps.driver.removeTrackFromQueue(zoneId, position).catch((err) => {
        this.logger.debug({ err, position }, 'failed to remove track')
      })
    }
    this.logger.info(
      {
        removed: remove.length,
        blocked: blockedCount,
        of: queue.length,
        elapsedMs: Date.now() - started,
      },
      'pruned queue',
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

  /**
   * Retire an activation, and say why.
   *
   * The reason is logged and the moment stamped because this used to happen in
   * silence: an activation that went inactive left no row change you could date
   * and no line in the log, so "the preset says off and the music is playing"
   * was a question the server held all the evidence for and none of the answer.
   */
  private markStopped(activation: { id: string; presetId: string }, reason: string) {
    this.deps.db
      .update(activations)
      .set({ live: false, stoppedAt: this.now().toISOString() })
      .where(eq(activations.id, activation.id))
      .run()
    this.unrecognised.delete(activation.id)
    this.logger.info(
      { activationId: activation.id, presetId: activation.presetId, reason },
      'retired activation',
    )
  }

  private invalidateOverlapping(zoneIds: string[], exceptPresetId: string) {
    const mine = new Set(zoneIds)
    for (const activation of this.liveActivations()) {
      if (activation.presetId === exceptPresetId) {
        this.markStopped(activation, 'superseded by a new activation of the same preset')
        continue
      }
      const members = JSON.parse(activation.memberZoneIdsJson) as string[]
      if (members.some((zoneId) => mine.has(zoneId))) {
        this.markStopped(activation, 'its rooms were taken by another preset')
      }
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
