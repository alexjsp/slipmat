import { EventEmitter } from 'node:events'
import type { SonosDevice } from '@svrooij/sonos'
import { SonosManager } from '@svrooij/sonos'
import type { Track as SonosTrack } from '@svrooij/sonos/lib/models/index.js'
import type { ZoneGroup } from '@svrooij/sonos/lib/models/zone-group.js'
import type { AVTransportServiceEvent } from '@svrooij/sonos/lib/services/index.js'
import type { Logger } from '../logger.js'
import type {
  DriverEvents,
  DriverGroup,
  DriverSnapshot,
  DriverTrack,
  DriverZone,
  SonosDriver,
} from './driver.js'
import { UnknownZoneError } from './errors.js'
import { formatDuration, parseDuration } from './time.js'
import { classifyPlaybackKind, followUriFor } from './uris.js'

/** UPnP subscriptions last ~10 minutes; renew comfortably inside that. */
const SUBSCRIPTION_CHECK_MS = 4 * 60 * 1000
/** Topology is event-driven, but a slow backstop catches missed notifications. */
const TOPOLOGY_REFRESH_MS = 60 * 1000
/** Position isn't evented, so it has to be polled. The UI interpolates between. */
const POSITION_POLL_MS = 5 * 1000
/** Grouping is eventually consistent — how long we wait for topology to settle. */
const TOPOLOGY_SETTLE_TIMEOUT_MS = 5000

type DeviceState = {
  volume: number
  muted: boolean
  transportState: DriverGroup['transportState']
  transportUri: string | null
  currentTrackUri: string | null
  currentTrack: DriverTrack | null
  positionSeconds: number | null
  positionUpdatedAt: number | null
  unreachable: boolean
}

function emptyDeviceState(): DeviceState {
  return {
    volume: 0,
    muted: false,
    transportState: 'STOPPED',
    transportUri: null,
    currentTrackUri: null,
    currentTrack: null,
    positionSeconds: null,
    positionUpdatedAt: null,
    unreachable: false,
  }
}

export type RealSonosDriverOptions = {
  logger: Logger
  /** Known speaker IP, used when SSDP discovery can't get through. */
  seedIp?: string | undefined
  discoveryTimeoutSeconds?: number
}

export class RealSonosDriver implements SonosDriver {
  private readonly emitter = new EventEmitter()
  private readonly logger: Logger
  private readonly options: RealSonosDriverOptions

  private manager: SonosManager | undefined
  private zoneGroups: ZoneGroup[] = []
  private readonly deviceState = new Map<string, DeviceState>()
  private readonly subscribed = new Set<string>()

  private timers: NodeJS.Timeout[] = []
  private topologyRefreshQueued = false
  private stopped = false

  constructor(options: RealSonosDriverOptions) {
    this.options = options
    this.logger = options.logger.child({ component: 'sonos' })
  }

  async start(): Promise<void> {
    const manager = new SonosManager()
    this.manager = manager

    let found = false
    if (this.options.seedIp) {
      this.logger.info({ seedIp: this.options.seedIp }, 'initialising from seed device')
      found = await manager.InitializeFromDevice(this.options.seedIp)
    } else {
      this.logger.info('initialising via SSDP discovery')
      found = await manager.InitializeWithDiscovery(this.options.discoveryTimeoutSeconds ?? 10)
    }

    if (!found) {
      throw new Error(
        'No Sonos devices found. Check that the container is on host networking, or set DOMOVOI_SEED_IP to a speaker address.',
      )
    }

    for (const device of manager.Devices) this.attach(device)
    manager.OnNewDevice((device) => {
      this.logger.info({ zone: device.Name, uuid: device.Uuid }, 'new device appeared')
      this.attach(device)
      this.queueTopologyRefresh()
    })

    await this.refreshTopology()
    this.startTimers()

    this.logger.info({ zones: this.zoneGroups.length }, 'sonos ready')
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const timer of this.timers) clearInterval(timer)
    this.timers = []
    for (const device of this.manager?.Devices ?? []) {
      try {
        device.CancelEvents()
      } catch (err) {
        this.logger.debug({ err, zone: device.Name }, 'failed to cancel events')
      }
    }
    this.manager?.CancelSubscription()
    this.manager = undefined
    this.emitter.removeAllListeners()
  }

  on<E extends keyof DriverEvents>(event: E, listener: DriverEvents[E]): void {
    this.emitter.on(event, listener)
  }

  off<E extends keyof DriverEvents>(event: E, listener: DriverEvents[E]): void {
    this.emitter.off(event, listener)
  }

  private changed() {
    if (!this.stopped) this.emitter.emit('change')
  }

  // --- wiring -------------------------------------------------------------

  private attach(device: SonosDevice) {
    const uuid = device.Uuid
    if (this.subscribed.has(uuid)) return
    this.subscribed.add(uuid)
    if (!this.deviceState.has(uuid)) this.deviceState.set(uuid, emptyDeviceState())

    // Touching `.Events` is what subscribes to UPnP notifications.
    const events = device.Events

    events.on('volume', (volume) => {
      this.patch(uuid, { volume, unreachable: false })
    })
    events.on('muted', (muted) => {
      this.patch(uuid, { muted, unreachable: false })
    })
    events.on('avtransport', (data: AVTransportServiceEvent) => {
      this.applyAvTransport(uuid, data)
    })
    events.on('transportState', (state) => {
      // Group states (GROUP_PLAYING) only reach followers; the coordinator is
      // the one that owns real transport state, so ignore them here.
      if (state === 'PLAYING' || state === 'PAUSED_PLAYBACK' || state === 'STOPPED') {
        this.patch(uuid, { transportState: state, unreachable: false })
      }
    })
    events.on('coordinator', () => this.queueTopologyRefresh())
    events.on('groupname', () => this.queueTopologyRefresh())
    events.on('subscriptionError', (err) => {
      this.logger.warn({ err, zone: device.Name }, 'event subscription error')
      this.patch(uuid, { unreachable: true })
    })
  }

  private applyAvTransport(uuid: string, data: AVTransportServiceEvent) {
    const patch: Partial<DeviceState> = { unreachable: false }

    if (data.AVTransportURI !== undefined) patch.transportUri = data.AVTransportURI || null
    if (data.CurrentTrackURI !== undefined) patch.currentTrackUri = data.CurrentTrackURI || null
    if (data.TransportState !== undefined) {
      const state = data.TransportState
      if (state === 'PLAYING' || state === 'PAUSED_PLAYBACK' || state === 'STOPPED') {
        patch.transportState = state
      } else if (state === 'TRANSITIONING') {
        patch.transportState = 'TRANSITIONING'
      }
    }
    if (data.CurrentTrackMetaData !== undefined) {
      patch.currentTrack = this.toDriverTrack(uuid, data.CurrentTrackMetaData, data.CurrentTrackURI)
      // A new track resets position; the next poll refines it.
      patch.positionSeconds = 0
      patch.positionUpdatedAt = Date.now()
    }

    this.patch(uuid, patch)
  }

  private patch(uuid: string, patch: Partial<DeviceState>) {
    const current = this.deviceState.get(uuid) ?? emptyDeviceState()
    const next = { ...current, ...patch }
    // Avoid waking every WebSocket client for a no-op notification.
    let dirty = false
    for (const key of Object.keys(patch) as (keyof DeviceState)[]) {
      if (current[key] !== next[key]) dirty = true
    }
    this.deviceState.set(uuid, next)
    if (dirty) this.changed()
  }

  private toDriverTrack(
    uuid: string,
    metadata: SonosTrack | string | undefined,
    fallbackUri: string | undefined,
  ): DriverTrack | null {
    if (!metadata || typeof metadata === 'string') {
      return fallbackUri
        ? {
            uri: fallbackUri,
            title: null,
            artist: null,
            album: null,
            artUrl: null,
            durationSeconds: null,
          }
        : null
    }
    const host = this.hostFor(uuid)
    const art = metadata.AlbumArtUri
    return {
      uri: metadata.TrackUri ?? fallbackUri ?? '',
      title: metadata.Title ?? null,
      artist: metadata.Artist ?? null,
      album: metadata.Album ?? null,
      artUrl: art && host ? new URL(art, `http://${host}:1400`).toString() : null,
      durationSeconds: parseDuration(metadata.Duration),
    }
  }

  // --- topology -----------------------------------------------------------

  private queueTopologyRefresh() {
    if (this.topologyRefreshQueued || this.stopped) return
    this.topologyRefreshQueued = true
    // Grouping changes arrive as a burst of events; refresh once after they settle.
    setTimeout(() => {
      this.topologyRefreshQueued = false
      void this.refreshTopology().catch((err) =>
        this.logger.warn({ err }, 'topology refresh failed'),
      )
    }, 250).unref()
  }

  private async refreshTopology(): Promise<void> {
    const device = this.manager?.Devices[0]
    if (!device) return
    const groups = await device.GetZoneGroupState()
    this.zoneGroups = groups
    // A speaker that rebooted comes back with no subscription of its own.
    for (const d of this.manager?.Devices ?? []) this.attach(d)
    this.changed()
  }

  private startTimers() {
    const every = (ms: number, fn: () => void) => {
      const timer = setInterval(fn, ms)
      timer.unref()
      this.timers.push(timer)
    }

    every(SUBSCRIPTION_CHECK_MS, () => {
      this.manager
        ?.CheckAllEventSubscriptions()
        .catch((err) => this.logger.warn({ err }, 'subscription renewal failed'))
    })
    every(TOPOLOGY_REFRESH_MS, () => {
      void this.refreshTopology().catch((err) =>
        this.logger.debug({ err }, 'periodic topology refresh failed'),
      )
    })
    every(POSITION_POLL_MS, () => {
      void this.pollPositions()
    })
  }

  /** Position is the one thing Sonos never pushes, so it has to be polled. */
  private async pollPositions() {
    for (const group of this.zoneGroups) {
      const uuid = group.coordinator.uuid
      const state = this.deviceState.get(uuid)
      if (state?.transportState !== 'PLAYING') continue
      const kind = classifyPlaybackKind(state.transportUri, state.currentTrackUri)
      if (kind !== 'queue') continue

      const device = this.deviceByUuid(uuid)
      if (!device) continue
      try {
        const info = await device.AVTransportService.GetPositionInfo()
        this.patch(uuid, {
          positionSeconds: parseDuration(info.RelTime) ?? 0,
          positionUpdatedAt: Date.now(),
          unreachable: false,
        })
      } catch (err) {
        this.logger.debug({ err, uuid }, 'position poll failed')
      }
    }
  }

  // --- lookups ------------------------------------------------------------

  private deviceByUuid(uuid: string): SonosDevice | undefined {
    return this.manager?.Devices.find((d) => d.Uuid === uuid)
  }

  private hostFor(uuid: string): string | undefined {
    return this.deviceByUuid(uuid)?.Host
  }

  private requireDevice(zoneId: string): SonosDevice {
    const device = this.deviceByUuid(zoneId)
    if (!device) throw new UnknownZoneError(zoneId)
    return device
  }

  /** The coordinator that actually owns playback for this zone's group. */
  private coordinatorFor(zoneId: string): SonosDevice {
    const group = this.zoneGroups.find(
      (g) => g.coordinator.uuid === zoneId || g.members.some((m) => m.uuid === zoneId),
    )
    const coordinatorUuid = group?.coordinator.uuid ?? zoneId
    return this.requireDevice(coordinatorUuid)
  }

  // --- snapshot -----------------------------------------------------------

  snapshot(): DriverSnapshot {
    const zones: DriverZone[] = []
    const groups: DriverGroup[] = []

    for (const group of this.zoneGroups) {
      // Invisible members are bonded satellites and subs — part of a zone, never
      // a zone of their own.
      const visible = group.members.filter((m) => !m.Invisible)
      const bondedByZone = new Map<string, number>()
      for (const member of group.members) {
        if (member.Invisible) continue
        const bonded = group.members.filter(
          (m) => m.Invisible && m.ChannelMapSet && m.uuid.startsWith(member.uuid.slice(0, 8)),
        ).length
        bondedByZone.set(member.uuid, bonded + 1)
      }

      for (const member of visible) {
        const state = this.deviceState.get(member.uuid) ?? emptyDeviceState()
        zones.push({
          id: member.uuid,
          name: member.name,
          host: member.host,
          port: member.port,
          volume: state.volume,
          muted: state.muted,
          bondedDeviceCount: bondedByZone.get(member.uuid) ?? 1,
          unreachable: state.unreachable,
        })
      }

      const coordinatorState = this.deviceState.get(group.coordinator.uuid) ?? emptyDeviceState()
      // Interpolate between polls so the UI progress bar doesn't stutter.
      const elapsed = coordinatorState.positionUpdatedAt
        ? (Date.now() - coordinatorState.positionUpdatedAt) / 1000
        : 0
      const position =
        coordinatorState.positionSeconds === null
          ? null
          : coordinatorState.transportState === 'PLAYING'
            ? coordinatorState.positionSeconds + elapsed
            : coordinatorState.positionSeconds

      groups.push({
        coordinatorZoneId: group.coordinator.uuid,
        memberZoneIds: visible.map((m) => m.uuid),
        transportState: coordinatorState.transportState,
        transportUri: coordinatorState.transportUri,
        currentTrackUri: coordinatorState.currentTrackUri,
        currentTrack: coordinatorState.currentTrack,
        positionSeconds: position,
        volume: coordinatorState.volume,
        muted: coordinatorState.muted,
      })
    }

    return {
      ready: this.zoneGroups.length > 0,
      householdId: null,
      zones,
      groups,
    }
  }

  // --- commands -----------------------------------------------------------

  async play(zoneId: string): Promise<void> {
    await this.coordinatorFor(zoneId).Play()
  }

  async pause(zoneId: string): Promise<void> {
    await this.coordinatorFor(zoneId).Pause()
  }

  async next(zoneId: string): Promise<void> {
    await this.coordinatorFor(zoneId).Next()
  }

  async previous(zoneId: string): Promise<void> {
    await this.coordinatorFor(zoneId).Previous()
  }

  async seek(zoneId: string, positionSeconds: number): Promise<void> {
    await this.coordinatorFor(zoneId).SeekPosition(formatDuration(positionSeconds))
  }

  async setVolume(zoneId: string, volume: number): Promise<void> {
    await this.requireDevice(zoneId).RenderingControlService.SetVolume({
      InstanceID: 0,
      Channel: 'Master',
      DesiredVolume: volume,
    })
    this.patch(zoneId, { volume })
  }

  async setMute(zoneId: string, muted: boolean): Promise<void> {
    await this.requireDevice(zoneId).RenderingControlService.SetMute({
      InstanceID: 0,
      Channel: 'Master',
      DesiredMute: muted,
    })
    this.patch(zoneId, { muted })
  }

  async joinGroup(coordinatorZoneId: string, zoneIds: string[]): Promise<void> {
    // The coordinator must own its own group before anyone can follow it.
    await this.leaveGroup([coordinatorZoneId])
    for (const zoneId of zoneIds) {
      if (zoneId === coordinatorZoneId) continue
      await this.requireDevice(zoneId).AVTransportService.SetAVTransportURI({
        InstanceID: 0,
        CurrentURI: followUriFor(coordinatorZoneId),
        CurrentURIMetaData: '',
      })
    }
    await this.waitForTopology(
      () => {
        const group = this.zoneGroups.find((g) => g.coordinator.uuid === coordinatorZoneId)
        if (!group) return false
        const present = new Set(group.members.map((m) => m.uuid))
        return zoneIds.every((id) => present.has(id))
      },
      { coordinatorZoneId, zoneIds },
    )
  }

  async leaveGroup(zoneIds: string[]): Promise<void> {
    for (const zoneId of zoneIds) {
      const device = this.deviceByUuid(zoneId)
      if (!device) continue
      const group = this.zoneGroups.find((g) => g.coordinator.uuid === zoneId)
      // Already standalone: nothing to break out of.
      if (group && group.members.filter((m) => !m.Invisible).length === 1) continue
      await device.AVTransportService.BecomeCoordinatorOfStandaloneGroup()
    }
    await this.waitForTopology(
      () =>
        zoneIds.every((id) => {
          const group = this.zoneGroups.find((g) => g.coordinator.uuid === id)
          return !!group
        }),
      { zoneIds },
    )
  }

  /**
   * Sonos applies grouping asynchronously. Setting volumes before topology has
   * settled gets them clobbered by the join, so callers wait here first.
   */
  private async waitForTopology(
    predicate: () => boolean,
    context: Record<string, unknown>,
  ): Promise<void> {
    const deadline = Date.now() + TOPOLOGY_SETTLE_TIMEOUT_MS
    while (Date.now() < deadline) {
      await this.refreshTopology()
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    this.logger.warn(context, 'topology did not settle within timeout; continuing anyway')
  }

  async fetchArt(
    zoneId: string,
    path: string,
  ): Promise<{ body: ArrayBuffer; contentType: string }> {
    const device = this.requireDevice(zoneId)
    const url = new URL(path, `http://${device.Host}:${device.Port}`)
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Artwork fetch failed with ${response.status}`)
    return {
      body: await response.arrayBuffer(),
      contentType: response.headers.get('content-type') ?? 'image/jpeg',
    }
  }
}
