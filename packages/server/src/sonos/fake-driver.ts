import { EventEmitter } from 'node:events'
import type {
  DriverBrowseItem,
  DriverBrowseResult,
  DriverEvents,
  DriverGroup,
  DriverMusicService,
  DriverPlayMode,
  DriverSnapshot,
  DriverTrack,
  DriverZone,
  SonosDriver,
} from './driver.js'
import { UnknownZoneError } from './errors.js'

/**
 * An in-memory Sonos household.
 *
 * Every automated test runs against this — never a real system. It also backs
 * `SLIPMAT_FAKE_SONOS=1`, so the UI can be developed without hardware.
 *
 * It models the behaviours that actually bite in production: grouping moves
 * members between groups, a coordinator that joins someone else's group stops
 * being a coordinator, and TV/line-in zones report their real playback kind.
 */

type FakeZone = {
  id: string
  name: string
  host: string
  volume: number
  muted: boolean
  bondedDeviceCount: number
  unreachable: boolean
}

type FakeGroup = {
  coordinatorZoneId: string
  memberZoneIds: string[]
  transportState: DriverGroup['transportState']
  transportUri: string | null
  currentTrackUri: string | null
  currentTrack: DriverTrack | null
  positionSeconds: number | null
  queue: DriverBrowseItem[]
}

export type FakeSonosDriverOptions = {
  zones?: { id: string; name: string }[]
  /** Zones that should start out playing TV audio. */
  tvZoneIds?: string[]
  /** Artwork to serve for a path; unset serves an empty image, as tests expect. */
  artwork?: (path: string) => { body: ArrayBuffer; contentType: string } | undefined
}

const DEFAULT_ZONES = [
  { id: 'RINCON_KITCHEN01400', name: 'Kitchen' },
  { id: 'RINCON_LIVING01400', name: 'Living Room' },
  { id: 'RINCON_BEDROOM01400', name: 'Bedroom' },
  { id: 'RINCON_OFFICE01400', name: 'Office' },
]

/**
 * What a real speaker reports as the current track once it starts playing one.
 *
 * The fake used to move `currentTrackUri` and leave `currentTrack` alone, so
 * anything reading the playing track's title or artist saw nothing — which
 * would have hidden the blocklist's skip entirely.
 */
function trackFromQueueItem(item: DriverBrowseItem): DriverTrack {
  return {
    uri: item.uri ?? '',
    title: item.title,
    artist: item.artist ?? item.subtitle ?? null,
    album: item.album,
    artUrl: item.artUrl,
    durationSeconds: null,
  }
}

export class FakeSonosDriver implements SonosDriver {
  private readonly emitter = new EventEmitter()
  private readonly zones = new Map<string, FakeZone>()
  private groups: FakeGroup[] = []
  private started = false

  /** Every command issued, so tests can assert on ordering and volume timing. */
  readonly calls: { method: string; args: unknown[] }[] = []

  /** What each container URI expands into when enqueued. */
  private readonly containers = new Map<string, DriverBrowseItem[]>()
  private readonly browseTree = new Map<string, DriverBrowseItem[]>()
  private readonly playModes = new Map<string, DriverPlayMode>()
  private readonly refuseJoin = new Set<string>()
  private readonly artwork: FakeSonosDriverOptions['artwork']

  constructor(options: FakeSonosDriverOptions = {}) {
    this.artwork = options.artwork
    const zones = options.zones ?? DEFAULT_ZONES
    for (const [index, zone] of zones.entries()) {
      this.zones.set(zone.id, {
        id: zone.id,
        name: zone.name,
        host: `192.168.1.${100 + index}`,
        volume: 25,
        muted: false,
        bondedDeviceCount: 1,
        unreachable: false,
      })
      const isTv = options.tvZoneIds?.includes(zone.id) ?? false
      this.groups.push({
        coordinatorZoneId: zone.id,
        memberZoneIds: [zone.id],
        transportState: isTv ? 'PLAYING' : 'STOPPED',
        transportUri: isTv ? `x-sonos-htastream:${zone.id}:spdif` : null,
        currentTrackUri: isTv ? `x-sonos-htastream:${zone.id}:spdif` : null,
        currentTrack: null,
        positionSeconds: null,
        queue: [],
      })
    }
  }

  async start(): Promise<void> {
    this.started = true
    this.changed()
  }

  async stop(): Promise<void> {
    this.started = false
    this.emitter.removeAllListeners()
  }

  on<E extends keyof DriverEvents>(event: E, listener: DriverEvents[E]): void {
    this.emitter.on(event, listener)
  }

  off<E extends keyof DriverEvents>(event: E, listener: DriverEvents[E]): void {
    this.emitter.off(event, listener)
  }

  private changed() {
    this.emitter.emit('change')
  }

  private record(method: string, ...args: unknown[]) {
    this.calls.push({ method, args })
  }

  private requireZone(zoneId: string): FakeZone {
    const zone = this.zones.get(zoneId)
    if (!zone) throw new UnknownZoneError(zoneId)
    if (zone.unreachable) throw new Error(`Zone ${zone.name} is unreachable`)
    return zone
  }

  private groupFor(zoneId: string): FakeGroup {
    const group = this.groups.find((g) => g.memberZoneIds.includes(zoneId))
    if (!group) throw new UnknownZoneError(zoneId)
    return group
  }

  snapshot(): DriverSnapshot {
    const zones: DriverZone[] = [...this.zones.values()].map((zone) => ({
      id: zone.id,
      name: zone.name,
      host: zone.host,
      port: 1400,
      volume: zone.volume,
      muted: zone.muted,
      bondedDeviceCount: zone.bondedDeviceCount,
      unreachable: zone.unreachable,
    }))

    const groups: DriverGroup[] = this.groups.map((group) => {
      const members = group.memberZoneIds.map((id) => this.zones.get(id)!).filter(Boolean)
      const volume = members.length
        ? Math.round(members.reduce((sum, z) => sum + z.volume, 0) / members.length)
        : 0
      return {
        coordinatorZoneId: group.coordinatorZoneId,
        memberZoneIds: [...group.memberZoneIds],
        transportState: group.transportState,
        transportUri: group.transportUri,
        currentTrackUri: group.currentTrackUri,
        currentTrack: group.currentTrack,
        positionSeconds: group.positionSeconds,
        volume,
        muted: members.every((z) => z.muted),
      }
    })

    return { ready: this.started, householdId: 'Fake_Household', zones, groups }
  }

  // --- playback -----------------------------------------------------------

  async play(zoneId: string): Promise<void> {
    this.record('play', zoneId)
    this.requireZone(zoneId)
    const group = this.groupFor(zoneId)
    group.transportState = 'PLAYING'
    if (group.positionSeconds === null) group.positionSeconds = 0
    this.changed()
  }

  async pause(zoneId: string): Promise<void> {
    this.record('pause', zoneId)
    this.requireZone(zoneId)
    this.groupFor(zoneId).transportState = 'PAUSED_PLAYBACK'
    this.changed()
  }

  async next(zoneId: string): Promise<void> {
    this.record('next', zoneId)
    const group = this.groupFor(zoneId)
    const index = group.queue.findIndex((item) => item.uri === group.currentTrackUri)
    const nextItem = group.queue[index + 1]
    if (nextItem?.uri) {
      group.currentTrackUri = nextItem.uri
      group.currentTrack = trackFromQueueItem(nextItem)
      group.positionSeconds = 0
    }
    this.changed()
  }

  async previous(zoneId: string): Promise<void> {
    this.record('previous', zoneId)
    const group = this.groupFor(zoneId)
    const index = group.queue.findIndex((item) => item.uri === group.currentTrackUri)
    const prevItem = index > 0 ? group.queue[index - 1] : undefined
    if (prevItem?.uri) {
      group.currentTrackUri = prevItem.uri
      group.positionSeconds = 0
    }
    this.changed()
  }

  async seek(zoneId: string, positionSeconds: number): Promise<void> {
    this.record('seek', zoneId, positionSeconds)
    this.groupFor(zoneId).positionSeconds = positionSeconds
    this.changed()
  }

  // --- rendering ----------------------------------------------------------

  async setVolume(zoneId: string, volume: number): Promise<void> {
    this.record('setVolume', zoneId, volume)
    this.requireZone(zoneId).volume = volume
    this.changed()
  }

  async setMute(zoneId: string, muted: boolean): Promise<void> {
    this.record('setMute', zoneId, muted)
    this.requireZone(zoneId).muted = muted
    this.changed()
  }

  // --- grouping -----------------------------------------------------------

  async awaitGrouping(): Promise<void> {
    // The fake applies grouping synchronously; there is nothing to settle.
  }

  async joinGroup(
    coordinatorZoneId: string,
    zoneIds: string[],
    options: { makeStandalone?: boolean } = {},
  ): Promise<void> {
    this.record('joinGroup', coordinatorZoneId, zoneIds)
    this.requireZone(coordinatorZoneId)
    if (options.makeStandalone !== false) await this.leaveGroup([coordinatorZoneId])

    const target = this.groups.find((g) => g.coordinatorZoneId === coordinatorZoneId)
    if (!target) throw new Error(`Zone ${coordinatorZoneId} did not become a coordinator`)

    for (const zoneId of zoneIds) {
      if (zoneId === coordinatorZoneId) continue
      // A refused join is silent, as it is on real hardware: the other members
      // arrive and this one simply is not there.
      if (this.refuseJoin.has(zoneId)) continue
      this.requireZone(zoneId)
      this.detach(zoneId)
      target.memberZoneIds.push(zoneId)
    }
    this.changed()
  }

  async leaveGroup(zoneIds: string[]): Promise<void> {
    this.record('leaveGroup', zoneIds)
    for (const zoneId of zoneIds) {
      const group = this.groupFor(zoneId)
      if (group.coordinatorZoneId === zoneId && group.memberZoneIds.length === 1) continue
      this.detach(zoneId)
      this.groups.push({
        coordinatorZoneId: zoneId,
        memberZoneIds: [zoneId],
        transportState: 'STOPPED',
        transportUri: null,
        currentTrackUri: null,
        currentTrack: null,
        positionSeconds: null,
        queue: [],
      })
    }
    this.changed()
  }

  /**
   * Remove a zone from whatever group it's in. If it was the coordinator, the
   * group either dissolves or hands off to the next remaining member — the same
   * thing a real household does.
   */
  private detach(zoneId: string) {
    const group = this.groups.find((g) => g.memberZoneIds.includes(zoneId))
    if (!group) return
    group.memberZoneIds = group.memberZoneIds.filter((id) => id !== zoneId)
    if (group.memberZoneIds.length === 0) {
      this.groups = this.groups.filter((g) => g !== group)
    } else if (group.coordinatorZoneId === zoneId) {
      group.coordinatorZoneId = group.memberZoneIds[0]!
    }
  }

  async fetchArt(
    _zoneId: string,
    path: string,
  ): Promise<{ body: ArrayBuffer; contentType: string }> {
    return this.artwork?.(path) ?? { body: new ArrayBuffer(0), contentType: 'image/jpeg' }
  }

  // --- content ------------------------------------------------------------

  async browse(
    objectId: string,
    options: { start?: number; count?: number } = {},
  ): Promise<DriverBrowseResult> {
    const all = this.browseTree.get(objectId) ?? []
    const start = options.start ?? 0
    const count = options.count ?? 200
    return { items: all.slice(start, start + count), total: all.length }
  }

  async listMusicServices(): Promise<DriverMusicService[]> {
    return [{ id: 9, name: 'Spotify', serial: '7' }]
  }

  // --- queue --------------------------------------------------------------

  async getQueue(zoneId: string): Promise<DriverBrowseItem[]> {
    return [...this.groupFor(zoneId).queue]
  }

  async clearQueue(zoneId: string): Promise<void> {
    this.record('clearQueue', zoneId)
    this.groupFor(zoneId).queue = []
    this.changed()
  }

  async seekToTrack(zoneId: string, position: number): Promise<void> {
    this.record('seekToTrack', zoneId, position)
    const group = this.groupFor(zoneId)
    const item = group.queue[position - 1]
    if (item?.uri) {
      group.currentTrackUri = item.uri
      group.currentTrack = trackFromQueueItem(item)
      group.positionSeconds = 0
    }
    this.changed()
  }

  async removeTrackFromQueue(zoneId: string, position: number): Promise<void> {
    this.record('removeTrackFromQueue', zoneId, position)
    this.groupFor(zoneId).queue.splice(position - 1, 1)
    this.changed()
  }

  async addUrisToQueue(
    zoneId: string,
    items: { uri: string; metadata?: string; metadataObject?: unknown }[],
    options: { timeoutMs?: number } = {},
  ): Promise<void> {
    this.record('addUrisToQueue', zoneId, items.length, options.timeoutMs)
    const group = this.groupFor(zoneId)
    for (const item of items) {
      // A real speaker expands a container URI into its individual tracks.
      // That expansion is exactly what the resolver leans on, so model it.
      const expansion = this.containers.get(item.uri)
      if (expansion) {
        group.queue.push(...expansion)
        continue
      }
      // A real queue read comes back with the track's title, artist and album,
      // whether the track arrived via a container or one at a time. Synthesising
      // a bare row here would have quietly hidden anything that matches on
      // metadata — the blocklist, for one.
      const known = [...this.browseTree.values()]
        .flat()
        .find((candidate) => candidate.uri === item.uri)
      group.queue.push(
        known ?? {
          id: item.uri,
          title: item.uri,
          subtitle: null,
          album: null,
          artUrl: null,
          isContainer: false,
          uri: item.uri,
          metadata: item.metadata ?? null,
        },
      )
    }
    this.changed()
  }

  async setTransportToQueue(zoneId: string): Promise<void> {
    this.record('setTransportToQueue', zoneId)
    const group = this.groupFor(zoneId)
    group.transportUri = `x-rincon-queue:${group.coordinatorZoneId}#0`
    group.currentTrackUri = group.queue[0]?.uri ?? null
    group.currentTrack = null
    group.positionSeconds = 0
    this.changed()
  }

  async setTransportUri(zoneId: string, uri: string): Promise<void> {
    this.record('setTransportUri', zoneId, uri)
    const group = this.groupFor(zoneId)
    group.transportUri = uri
    group.currentTrackUri = uri
    group.positionSeconds = null
    this.changed()
  }

  async setPlayMode(zoneId: string, mode: DriverPlayMode): Promise<void> {
    this.record('setPlayMode', zoneId, mode)
    this.playModes.set(zoneId, mode)
  }

  async setCrossfade(zoneId: string, enabled: boolean): Promise<void> {
    this.record('setCrossfade', zoneId, enabled)
  }

  playModeOf(zoneId: string): DriverPlayMode | undefined {
    return this.playModes.get(zoneId)
  }

  // --- test helpers -------------------------------------------------------

  /** Simulate a speaker dropping off the network. */
  setUnreachable(zoneId: string, unreachable: boolean) {
    const zone = this.zones.get(zoneId)
    if (zone) zone.unreachable = unreachable
    this.changed()
  }

  /**
   * Make one zone refuse to join a group.
   *
   * Models the real failure that matters: Sonos accepts the command for the
   * other members and this one simply never arrives, so anything that assumed
   * the whole group formed is wrong about it.
   */
  failJoinFor(zoneId: string) {
    this.refuseJoin.add(zoneId)
  }

  /** Drive the transport state directly — TRANSITIONING has no other route. */
  setTransportState(zoneId: string, state: DriverGroup['transportState']) {
    this.groupFor(zoneId).transportState = state
    this.changed()
  }

  /** Simulate someone starting music outside Slipmat. */
  setPlaying(zoneId: string, transportUri: string, trackUri: string) {
    const group = this.groupFor(zoneId)
    group.transportUri = transportUri
    group.currentTrackUri = trackUri
    group.transportState = 'PLAYING'
    this.changed()
  }

  /** As above, but with full track metadata — used to seed the dev household. */
  setNowPlaying(
    zoneId: string,
    options: { transportUri: string; track: DriverTrack; positionSeconds?: number },
  ) {
    const group = this.groupFor(zoneId)
    group.transportUri = options.transportUri
    group.currentTrackUri = options.track.uri
    group.currentTrack = options.track
    group.positionSeconds = options.positionSeconds ?? 0
    group.transportState = 'PLAYING'
    this.changed()
  }

  /** Inspect a queue synchronously — convenience for assertions. */
  queueOf(zoneId: string): string[] {
    return this.groupFor(zoneId)
      .queue.map((item) => item.uri)
      .filter((uri): uri is string => uri !== null)
  }

  /** Register what a container expands into, so resolution can be tested. */
  setContainerContents(containerUri: string, items: DriverBrowseItem[]) {
    this.containers.set(containerUri, items)
  }

  setBrowseResult(objectId: string, items: DriverBrowseItem[]) {
    this.browseTree.set(objectId, items)
  }
}
