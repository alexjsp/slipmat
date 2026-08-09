import { EventEmitter } from 'node:events'
import type {
  DriverEvents,
  DriverGroup,
  DriverSnapshot,
  DriverTrack,
  DriverZone,
  SonosDriver,
} from './driver.js'

/**
 * An in-memory Sonos household.
 *
 * Every automated test runs against this — never a real system. It also backs
 * `DOMOVOI_FAKE_SONOS=1`, so the UI can be developed without hardware.
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
  queue: string[]
}

export type FakeSonosDriverOptions = {
  zones?: { id: string; name: string }[]
  /** Zones that should start out playing TV audio. */
  tvZoneIds?: string[]
}

const DEFAULT_ZONES = [
  { id: 'RINCON_KITCHEN01400', name: 'Kitchen' },
  { id: 'RINCON_LIVING01400', name: 'Living Room' },
  { id: 'RINCON_BEDROOM01400', name: 'Bedroom' },
  { id: 'RINCON_OFFICE01400', name: 'Office' },
]

export class FakeSonosDriver implements SonosDriver {
  private readonly emitter = new EventEmitter()
  private readonly zones = new Map<string, FakeZone>()
  private groups: FakeGroup[] = []
  private started = false

  /** Every command issued, so tests can assert on ordering and volume timing. */
  readonly calls: { method: string; args: unknown[] }[] = []

  constructor(options: FakeSonosDriverOptions = {}) {
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
    if (!zone) throw new Error(`Unknown zone ${zoneId}`)
    if (zone.unreachable) throw new Error(`Zone ${zone.name} is unreachable`)
    return zone
  }

  private groupFor(zoneId: string): FakeGroup {
    const group = this.groups.find((g) => g.memberZoneIds.includes(zoneId))
    if (!group) throw new Error(`Zone ${zoneId} is not in any group`)
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
    const index = group.queue.indexOf(group.currentTrackUri ?? '')
    const nextUri = group.queue[index + 1]
    if (nextUri) {
      group.currentTrackUri = nextUri
      group.positionSeconds = 0
    }
    this.changed()
  }

  async previous(zoneId: string): Promise<void> {
    this.record('previous', zoneId)
    const group = this.groupFor(zoneId)
    const index = group.queue.indexOf(group.currentTrackUri ?? '')
    const prevUri = index > 0 ? group.queue[index - 1] : undefined
    if (prevUri) {
      group.currentTrackUri = prevUri
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

  async joinGroup(coordinatorZoneId: string, zoneIds: string[]): Promise<void> {
    this.record('joinGroup', coordinatorZoneId, zoneIds)
    this.requireZone(coordinatorZoneId)
    await this.leaveGroup([coordinatorZoneId])

    const target = this.groups.find((g) => g.coordinatorZoneId === coordinatorZoneId)
    if (!target) throw new Error(`Zone ${coordinatorZoneId} did not become a coordinator`)

    for (const zoneId of zoneIds) {
      if (zoneId === coordinatorZoneId) continue
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

  async fetchArt(): Promise<{ body: ArrayBuffer; contentType: string }> {
    return { body: new ArrayBuffer(0), contentType: 'image/jpeg' }
  }

  // --- test helpers -------------------------------------------------------

  /** Simulate a speaker dropping off the network. */
  setUnreachable(zoneId: string, unreachable: boolean) {
    const zone = this.zones.get(zoneId)
    if (zone) zone.unreachable = unreachable
    this.changed()
  }

  /** Simulate someone starting music outside Domovoi. */
  setPlaying(zoneId: string, transportUri: string, trackUri: string) {
    const group = this.groupFor(zoneId)
    group.transportUri = transportUri
    group.currentTrackUri = trackUri
    group.transportState = 'PLAYING'
    this.changed()
  }

  getQueue(zoneId: string): string[] {
    return [...this.groupFor(zoneId).queue]
  }

  setQueue(zoneId: string, uris: string[]) {
    const group = this.groupFor(zoneId)
    group.queue = [...uris]
    this.changed()
  }
}
