import { randomUUID } from 'node:crypto'
import type { ActivationResult, Preset } from '@domovoi/shared'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import { activations } from '../db/schema.js'
import type { Logger } from '../logger.js'
import type { SonosDriver } from '../sonos/driver.js'
import { classifyPlaybackKind, isProtectedFromPauseAll } from '../sonos/uris.js'
import type { SourceCache } from '../sources/cache.js'
import type { ResolvedTrack } from '../sources/resolver.js'
import type { SystemStateStore } from '../state/store.js'
import { pickCoordinator } from './repository.js'
import { buildQueue } from './shuffle.js'

/**
 * Tracks enqueued before playback starts. The rest is appended in the
 * background: a full pool is dozens of sequential SOAP calls, which would mean
 * several seconds of silence after a button press and a HomeKit timeout.
 */
const FAST_START_TRACKS = 20

export type ActivationDeps = {
  db: Db
  driver: SonosDriver
  store: SystemStateStore
  cache: SourceCache
  logger: Logger
}

export class ActivationEngine {
  private readonly logger: Logger

  constructor(private readonly deps: ActivationDeps) {
    this.logger = deps.logger.child({ component: 'activation' })
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

    const resolved = await this.resolveSources(preset, warnings)
    const streamSource = resolved.find((source) => source.mode === 'stream')
    const containerOnly = resolved.filter((source) => source.mode === 'container_only')

    // Supersede anything already running that overlaps these speakers.
    this.invalidateOverlapping(
      members.map((zone) => zone.zoneId),
      preset.id,
    )

    if (preset.pauseOthers) {
      await this.pauseOtherGroups(members.map((zone) => zone.zoneId))
    }

    await this.applyGrouping(
      coordinator.zoneId,
      members.map((zone) => zone.zoneId),
      warnings,
    )
    await this.applyVolumes(members, warnings)
    await this.deps.driver.setCrossfade(coordinator.zoneId, preset.crossfade).catch(() => {
      warnings.push('Crossfade could not be set')
    })

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

    const pool = buildQueue(
      resolved.filter((source) => source.mode === 'tracks').map((source) => source.tracks),
      { dedupe: preset.dedupe, seed: options.seed ?? seedFor(activationId) },
    )

    if (pool.length === 0) {
      // Nothing expandable — fall back to playing a container whole under
      // Sonos' own shuffle, which is better than silence.
      const fallback = containerOnly[0]
      if (!fallback?.containerUri) {
        throw new Error(`${preset.name} has no playable tracks`)
      }
      warnings.push(`Playing "${fallback.label}" whole — its tracks could not be listed`)
      await this.deps.driver.clearQueue(coordinator.zoneId)
      await this.deps.driver.addUrisToQueue(coordinator.zoneId, [
        { uri: fallback.containerUri, metadata: fallback.containerMetadata ?? undefined },
      ])
      await this.deps.driver.setPlayMode(coordinator.zoneId, 'SHUFFLE')
      await this.deps.driver.setTransportToQueue(coordinator.zoneId)
      await this.deps.driver.play(coordinator.zoneId)

      const queue = await this.deps.driver.getQueue(coordinator.zoneId)
      this.recordActivation({
        activationId,
        preset,
        coordinatorZoneId: coordinator.zoneId,
        memberZoneIds: members.map((zone) => zone.zoneId),
        trackUris: queue.map((item) => item.uri).filter((uri): uri is string => !!uri),
        streamUri: null,
        warnings,
      })
      this.deps.store.refresh()
      return { activationId, noop: false, warnings }
    }

    for (const source of containerOnly) {
      warnings.push(`"${source.label}" could not be mixed in and was skipped`)
    }

    await this.startQueue(coordinator.zoneId, preset, pool)

    this.recordActivation({
      activationId,
      preset,
      coordinatorZoneId: coordinator.zoneId,
      memberZoneIds: members.map((zone) => zone.zoneId),
      trackUris: pool.slice(0, FAST_START_TRACKS).map((track) => track.uri),
      streamUri: null,
      warnings,
    })

    // Append the tail behind playback, widening the activation's URI set as it
    // goes so active-state detection keeps matching.
    void this.appendRemainder(activationId, coordinator.zoneId, pool).catch((err) =>
      this.logger.warn({ err, presetId: preset.id }, 'failed to append queue tail'),
    )

    this.deps.store.refresh()
    return { activationId, noop: false, warnings }
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
   * The "loose" active-state test: right speakers, still playing, still playing
   * something we queued. Survives skips and an extra speaker joining; goes false
   * on pause, stop, or the queue being replaced.
   */
  isStillPlaying(presetId: string): boolean {
    const activation = this.liveActivation(presetId)
    if (!activation) return false

    const snapshot = this.deps.driver.snapshot()
    const group = snapshot.groups.find(
      (candidate) => candidate.coordinatorZoneId === activation.coordinatorZoneId,
    )
    if (group?.transportState !== 'PLAYING') return false

    const members = new Set(group.memberZoneIds)
    const expected = JSON.parse(activation.memberZoneIdsJson) as string[]
    if (!expected.every((zoneId) => members.has(zoneId))) return false

    if (activation.streamUri) return group.transportUri === activation.streamUri

    const uris = new Set(JSON.parse(activation.trackUrisJson) as string[])
    return !!group.currentTrackUri && uris.has(group.currentTrackUri)
  }

  /** Drop activations whose reality no longer matches, so switches go off. */
  reconcile(): void {
    for (const activation of this.liveActivations()) {
      if (!this.isStillPlaying(activation.presetId)) this.markStopped(activation.id)
    }
  }

  // --- steps --------------------------------------------------------------

  private async resolveSources(preset: Preset, warnings: string[]) {
    const resolved = []
    for (const source of preset.sources) {
      try {
        resolved.push(
          await this.deps.cache.get({ kind: source.kind, ref: source.ref, label: source.label }),
        )
      } catch (err) {
        this.logger.warn({ err, ref: source.ref }, 'source failed to resolve')
        warnings.push(`"${source.label}" could not be loaded`)
      }
    }
    return resolved
  }

  private async applyGrouping(coordinatorZoneId: string, zoneIds: string[], warnings: string[]) {
    const others = zoneIds.filter((zoneId) => zoneId !== coordinatorZoneId)
    try {
      if (others.length > 0) {
        await this.deps.driver.joinGroup(coordinatorZoneId, others)
      } else {
        await this.deps.driver.leaveGroup([coordinatorZoneId])
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

  private async startQueue(coordinatorZoneId: string, preset: Preset, pool: ResolvedTrack[]) {
    await this.deps.driver.clearQueue(coordinatorZoneId)
    await this.deps.driver.addUrisToQueue(
      coordinatorZoneId,
      pool.slice(0, FAST_START_TRACKS).map((track) => ({
        uri: track.uri,
        metadata: track.metadata ?? undefined,
      })),
    )
    // Already shuffled, so NORMAL — letting Sonos shuffle too would undo the
    // careful cross-source interleave.
    await this.deps.driver.setPlayMode(
      coordinatorZoneId,
      preset.repeatAll ? 'REPEAT_ALL' : 'NORMAL',
    )
    await this.deps.driver.setTransportToQueue(coordinatorZoneId)
    await this.deps.driver.play(coordinatorZoneId)
  }

  private async appendRemainder(
    activationId: string,
    coordinatorZoneId: string,
    pool: ResolvedTrack[],
  ) {
    const remainder = pool.slice(FAST_START_TRACKS)
    if (remainder.length === 0) return

    await this.deps.driver.addUrisToQueue(
      coordinatorZoneId,
      remainder.map((track) => ({ uri: track.uri, metadata: track.metadata ?? undefined })),
    )

    // Only widen a still-live activation; a stop mid-append must not resurrect it.
    const row = this.deps.db
      .select()
      .from(activations)
      .where(eq(activations.id, activationId))
      .get()
    if (!row?.live) return

    this.deps.db
      .update(activations)
      .set({ trackUrisJson: JSON.stringify(pool.map((track) => track.uri)) })
      .where(eq(activations.id, activationId))
      .run()
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
