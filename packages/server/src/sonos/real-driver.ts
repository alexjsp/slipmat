import { EventEmitter } from 'node:events'
import type { SonosDevice } from '@svrooij/sonos'
import { MetaDataHelper, SonosManager } from '@svrooij/sonos'
import type { Track as SonosTrack } from '@svrooij/sonos/lib/models/index.js'
import { PlayMode } from '@svrooij/sonos/lib/models/playmode.js'
import type { ZoneGroup } from '@svrooij/sonos/lib/models/zone-group.js'
import type { AVTransportServiceEvent } from '@svrooij/sonos/lib/services/index.js'
import type { Logger } from '../logger.js'
import type { DidlEntry } from './didl.js'
import { asMetadataDocument, isContainerClass, parseDidl } from './didl.js'
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
import { encodeTrackUri, encodeXml, soapEnvelope } from './soap.js'
import { formatDuration, parseDuration } from './time.js'

import { classifyPlaybackKind, followUriFor, queueUriFor } from './uris.js'

/** Sonos returns at most this many Browse results regardless of what we ask. */
const QUEUE_PAGE_SIZE = 1000

/**
 * Pause between commands that change the household's topology.
 *
 * Sonos does not cope with being asked to do several of these at once. Three
 * concurrent joins produced two thirty-second HTTP timeouts — not slow replies,
 * no reply at all — and left those speakers out of the group and muted. Issuing
 * them one at a time with a gap is both more reliable and, because a hung call
 * costs thirty seconds, faster in practice.
 */
const TOPOLOGY_COMMAND_GAP_MS = 250

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** UPnP subscriptions last ~10 minutes; renew comfortably inside that. */
const SUBSCRIPTION_CHECK_MS = 4 * 60 * 1000
/** Topology is event-driven, but a slow backstop catches missed notifications. */
const TOPOLOGY_REFRESH_MS = 60 * 1000
/** Position isn't evented, so it has to be polled. The UI interpolates between. */
const POSITION_POLL_MS = 5 * 1000
/** Grouping is eventually consistent — how long we wait for topology to settle. */
const TOPOLOGY_SETTLE_TIMEOUT_MS = 5000
const PLAY_MODES: Record<DriverPlayMode, PlayMode> = {
  NORMAL: PlayMode.Normal,
  REPEAT_ALL: PlayMode.RepeatAll,
  SHUFFLE: PlayMode.Shuffle,
  SHUFFLE_NOREPEAT: PlayMode.ShuffleNoRepeat,
}

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
        'No Sonos devices found. Check that the container is on host networking, or set SLIPMAT_SEED_IP to a speaker address.',
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

    // `groups`, not `zones` — this counts zone *groups*, and calling it zones
    // reads as a discovery failure whenever anything is grouped.
    this.logger.info(
      { groups: this.zoneGroups.length, devices: this.manager?.Devices.length ?? 0 },
      'sonos ready',
    )
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

    void this.prime(device)
  }

  /**
   * Read a device's current state once at attach time.
   *
   * Without this everything reads as volume 0 / STOPPED until the speaker
   * happens to send its first event, which can be minutes — long enough for the
   * UI to show a wrong picture and for a preset to make decisions on it.
   * All of these calls are read-only.
   */
  private async prime(device: SonosDevice) {
    const uuid = device.Uuid
    try {
      // Sequential, and not because it is faster — it is not. Every device in
      // the household primes at once, so four concurrent reads each becomes
      // dozens of simultaneous requests at startup, and this system does not
      // reward asking it several things at the same time. Nothing is waiting on
      // this, so it can afford to be polite.
      const volume = await device.RenderingControlService.GetVolume({
        InstanceID: 0,
        Channel: 'Master',
      })
      const mute = await device.RenderingControlService.GetMute({
        InstanceID: 0,
        Channel: 'Master',
      })
      const transport = await device.AVTransportService.GetTransportInfo({ InstanceID: 0 })
      const media = await device.AVTransportService.GetMediaInfo({ InstanceID: 0 })

      const state = transport.CurrentTransportState
      this.patch(uuid, {
        volume: volume.CurrentVolume,
        muted: mute.CurrentMute,
        transportState:
          state === 'PLAYING' || state === 'PAUSED_PLAYBACK' || state === 'TRANSITIONING'
            ? state
            : 'STOPPED',
        transportUri: media.CurrentURI || null,
        unreachable: false,
      })

      // Position and track only make sense while something is loaded.
      if (media.CurrentURI) {
        const position = await device.AVTransportService.GetPositionInfo({ InstanceID: 0 })
        this.patch(uuid, {
          currentTrackUri: position.TrackURI || null,
          currentTrack: this.toDriverTrack(uuid, position.TrackMetaData, position.TrackURI),
          positionSeconds: parseDuration(position.RelTime) ?? 0,
          positionUpdatedAt: Date.now(),
        })
      }
    } catch (err) {
      this.logger.debug({ err, zone: device.Name }, 'failed to prime device state')
      this.patch(uuid, { unreachable: true })
    }
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

      // Only a *different* track resets the position. Sonos re-sends the
      // current track's metadata on any transport change, pausing included, so
      // resetting whenever metadata arrives sent the seek bar back to 0:00
      // every time playback was paused — and polling stops while paused, so
      // nothing corrected it.
      const previousUri = this.deviceState.get(uuid)?.currentTrackUri ?? null
      const nextUri =
        data.CurrentTrackURI !== undefined ? data.CurrentTrackURI || null : previousUri
      if (nextUri !== previousUri) {
        patch.positionSeconds = 0
        patch.positionUpdatedAt = Date.now()
      }
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

  async joinGroup(
    coordinatorZoneId: string,
    zoneIds: string[],
    options: { settle?: boolean; makeStandalone?: boolean } = {},
  ): Promise<void> {
    // The coordinator must own its own group before anyone can follow it — but
    // not if it is already playing, because becoming a standalone coordinator
    // stops playback. Callers that started the music first pass false.
    if (options.makeStandalone !== false) await this.leaveGroup([coordinatorZoneId], options)

    // One at a time, with a gap. Doing these concurrently looks obviously
    // better — each takes ~2.6s because Sonos does not answer until the speaker
    // has actually joined — and it is how this got into trouble: three at once
    // and two speakers stopped responding entirely until the HTTP client gave
    // up thirty seconds later.
    const followers = zoneIds.filter((zoneId) => zoneId !== coordinatorZoneId)
    const joins = (async () => {
      for (const zoneId of followers) {
        try {
          await this.requireDevice(zoneId).AVTransportService.SetAVTransportURI({
            InstanceID: 0,
            CurrentURI: followUriFor(coordinatorZoneId),
            CurrentURIMetaData: '',
          })
        } catch (err) {
          this.logger.warn({ err, zoneId }, 'speaker failed to join the group')
        }
        await pause(TOPOLOGY_COMMAND_GAP_MS)
      }
    })()

    // Left in flight deliberately: the caller starts the music and uses
    // `awaitGrouping` as the synchronisation point once it has.
    if (options.settle === false) return

    await joins
    await this.awaitGrouping(coordinatorZoneId, zoneIds)
  }

  async awaitGrouping(coordinatorZoneId: string, zoneIds: string[]): Promise<void> {
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

  async leaveGroup(zoneIds: string[], options: { settle?: boolean } = {}): Promise<void> {
    for (const zoneId of zoneIds) {
      const device = this.deviceByUuid(zoneId)
      if (!device) continue
      const group = this.zoneGroups.find((g) => g.coordinator.uuid === zoneId)
      // Already standalone: nothing to break out of.
      if (group && group.members.filter((m) => !m.Invisible).length === 1) continue
      await device.AVTransportService.BecomeCoordinatorOfStandaloneGroup()
    }
    if (options.settle === false) return
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
      try {
        await this.refreshTopology()
      } catch (err) {
        // A failed read means "not settled yet", never "the grouping failed".
        //
        // Mid-regroup, Sonos briefly reports a group whose coordinator has
        // already left it, and the library rejects the entire snapshot for that
        // one group — `Error parsing ZoneGroup`, thrown from inside a `.map`.
        // The moment we are polling through is exactly when that happens, so
        // letting it escape turned a join that had worked perfectly well into
        // "Speakers could not be grouped as configured".
        this.logger.debug({ err, ...context }, 'topology unreadable while settling')
      }
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    this.logger.warn(context, 'topology did not settle within timeout; continuing anyway')
  }

  // --- content (read-only) ------------------------------------------------

  async browse(
    objectId: string,
    options: { start?: number; count?: number } = {},
  ): Promise<DriverBrowseResult> {
    const device = this.manager?.Devices[0]
    if (!device) throw new Error('No Sonos devices available')

    // Raw Browse, then our own DIDL reader — see didl.ts for why the library's
    // parsed form can't be used here (it decodes res and drops r:resMD).
    const response = await device.ContentDirectoryService.Browse({
      ObjectID: objectId,
      BrowseFlag: 'BrowseDirectChildren',
      Filter: '*',
      StartingIndex: options.start ?? 0,
      RequestedCount: options.count ?? 200,
      SortCriteria: '',
    })

    const encoded = typeof response.Result === 'string' ? response.Result : ''
    const entries = parseDidl(encoded)

    return {
      items: entries.map((entry) => ({
        id: entry.id,
        title: entry.title || 'Unknown',
        subtitle: entry.creator ?? entry.album ?? null,
        album: entry.album,
        artUrl: entry.albumArtUri
          ? new URL(entry.albumArtUri, `http://${device.Host}:1400`).toString()
          : null,
        isContainer: isContainerClass(entry.upnpClass),
        uri: entry.res,
        // A favourite's resMD is the container's own metadata, which Sonos
        // requires when the container is enqueued.
        metadata: entry.resMD,
      })),
      total: response.TotalMatches ?? entries.length,
    }
  }

  async listMusicServices(): Promise<DriverMusicService[]> {
    const device = this.manager?.Devices[0]
    if (!device) return []
    const services = await device.MusicServicesSubscribed()
    return (services ?? []).map((service) => ({
      id: Number(service.Id),
      name: service.Name ?? String(service.Id),
      serial: String(service.Id),
    }))
  }

  // --- queue (mutating) ---------------------------------------------------

  async getQueue(zoneId: string): Promise<DriverBrowseItem[]> {
    const device = this.coordinatorFor(zoneId)

    // Raw DIDL, for the same reason as browse(): the library's parser
    // percent-decodes <res>, turning `librarytrack%3aa.123` into
    // `librarytrack:a.123`. Sonos then rejects that URI when it is handed back,
    // so a queue read through the parsed path yields tracks that cannot be
    // re-enqueued.
    // Paged, because Sonos returns at most a thousand entries per Browse and
    // says nothing about the ones it left out. A two-thousand-track playlist
    // read in one call comes back looking exactly like a complete queue.
    const entries: DidlEntry[] = []
    let start = 0
    for (;;) {
      const page = await device.ContentDirectoryService.Browse({
        ObjectID: 'Q:0',
        BrowseFlag: 'BrowseDirectChildren',
        Filter: '*',
        StartingIndex: start,
        RequestedCount: QUEUE_PAGE_SIZE,
        SortCriteria: '',
      })
      const pageEntries = parseDidl(typeof page.Result === 'string' ? page.Result : '')
      entries.push(...pageEntries)
      start += pageEntries.length
      if (pageEntries.length === 0 || start >= page.TotalMatches) break
    }

    return entries.map((entry) => ({
      id: entry.id,
      title: entry.title || 'Unknown',
      subtitle: entry.creator ?? entry.album ?? null,
      album: entry.album,
      artUrl: entry.albumArtUri
        ? new URL(entry.albumArtUri, `http://${device.Host}:1400`).toString()
        : null,
      isContainer: isContainerClass(entry.upnpClass),
      uri: entry.res,
      // A queue entry has no resMD; its own element is the metadata, and
      // without it a re-enqueued track plays with no title or artist.
      metadata: entry.resMD ?? asMetadataDocument(entry.raw),
    }))
  }

  async clearQueue(zoneId: string): Promise<void> {
    await this.coordinatorFor(zoneId).AVTransportService.RemoveAllTracksFromQueue()
  }

  async seekToTrack(zoneId: string, position: number): Promise<void> {
    await this.coordinatorFor(zoneId).AVTransportService.Seek({
      InstanceID: 0,
      Unit: 'TRACK_NR',
      Target: String(position),
    })
  }

  async removeTrackFromQueue(zoneId: string, position: number): Promise<void> {
    await this.coordinatorFor(zoneId).AVTransportService.RemoveTrackFromQueue({
      InstanceID: 0,
      ObjectID: `Q:0/${position}`,
      UpdateID: 0,
    })
  }

  async addUrisToQueue(
    zoneId: string,
    items: { uri: string; metadata?: string; metadataObject?: unknown }[],
    options: { timeoutMs?: number } = {},
  ): Promise<void> {
    const device = this.coordinatorFor(zoneId)

    // The library fixes its SOAP timeout at 30s, which is fine for a track and
    // not for a container: Sonos expands the whole thing before it answers, and
    // a two-thousand-track playlist measured at 44s on real hardware. The
    // request is reissued here by hand purely to lift that ceiling — same
    // action, same encoding, so it stays interchangeable with the call below.
    if (options.timeoutMs !== undefined) {
      for (const item of items) {
        await this.addUriToQueueSlowly(device, item, options.timeoutMs)
      }
      return
    }

    // One call per item rather than AddMultipleURIsToQueue.
    //
    // The batch call rejects streaming-service track URIs with UPnP 402 in
    // every form tried against a real household — escaped and unescaped URIs,
    // merged DIDL and empty metadata alike — while the single-item call accepts
    // them happily. It is also fast enough not to need batching: measured at
    // roughly 10ms per track, so the twenty-track head of a preset costs about
    // 200ms, well inside the fast-start budget.
    for (const item of items) {
      await device.AVTransportService.AddURIToQueue({
        InstanceID: 0,
        EnqueuedURI: item.uri,
        // An object is serialised and XML-encoded by the transport; a string is
        // inserted verbatim and must already be encoded. Favourites give us the
        // latter, pasted links the former.
        EnqueuedURIMetaData: (item.metadataObject as SonosTrack) ?? item.metadata ?? '',
        DesiredFirstTrackNumberEnqueued: 0,
        EnqueueAsNext: false,
      })
    }
  }

  /**
   * `AddURIToQueue` without the library's 30s ceiling.
   *
   * Encoding follows the library exactly — `XmlHelper.EncodeTrackUri` for the
   * URI, a structured metadata object serialised the same way, a string one
   * inserted verbatim — so the only difference on the wire is how long we are
   * prepared to wait for the answer.
   */
  private async addUriToQueueSlowly(
    device: SonosDevice,
    item: { uri: string; metadata?: string; metadataObject?: unknown },
    timeoutMs: number,
  ): Promise<void> {
    const metadata = item.metadataObject
      ? encodeXml(MetaDataHelper.TrackToMetaData(item.metadataObject as SonosTrack))
      : (item.metadata ?? '')
    const body =
      '<InstanceID>0</InstanceID>' +
      `<EnqueuedURI>${encodeTrackUri(item.uri)}</EnqueuedURI>` +
      `<EnqueuedURIMetaData>${metadata}</EnqueuedURIMetaData>` +
      '<DesiredFirstTrackNumberEnqueued>0</DesiredFirstTrackNumberEnqueued>' +
      '<EnqueueAsNext>0</EnqueueAsNext>'
    const envelope = soapEnvelope('AVTransport', 'AddURIToQueue', body)

    const response = await fetch(`http://${device.Host}:1400/MediaRenderer/AVTransport/Control`, {
      method: 'POST',
      headers: {
        SOAPAction: '"urn:schemas-upnp-org:service:AVTransport:1#AddURIToQueue"',
        'Content-type': 'text/xml; charset=utf8',
      },
      body: envelope,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await response.text()
    if (!response.ok) {
      const code = /<errorCode>(\d+)<\/errorCode>/.exec(text)?.[1]
      throw new Error(
        code
          ? `Sonos error on AddURIToQueue UPnPError ${code}`
          : `Sonos error on AddURIToQueue HTTP ${response.status}`,
      )
    }
  }

  async setTransportToQueue(zoneId: string): Promise<void> {
    const device = this.coordinatorFor(zoneId)
    await device.AVTransportService.SetAVTransportURI({
      InstanceID: 0,
      CurrentURI: queueUriFor(device.Uuid),
      CurrentURIMetaData: '',
    })
  }

  async setTransportUri(zoneId: string, uri: string, metadata = ''): Promise<void> {
    await this.coordinatorFor(zoneId).AVTransportService.SetAVTransportURI({
      InstanceID: 0,
      CurrentURI: uri,
      CurrentURIMetaData: metadata,
    })
  }

  async setPlayMode(zoneId: string, mode: DriverPlayMode): Promise<void> {
    await this.coordinatorFor(zoneId).AVTransportService.SetPlayMode({
      InstanceID: 0,
      NewPlayMode: PLAY_MODES[mode],
    })
  }

  async setCrossfade(zoneId: string, enabled: boolean): Promise<void> {
    await this.coordinatorFor(zoneId).AVTransportService.SetCrossfadeMode({
      InstanceID: 0,
      CrossfadeMode: enabled,
    })
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
