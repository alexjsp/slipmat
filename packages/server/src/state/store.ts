import { EventEmitter } from 'node:events'
import type { Group, SystemState, Track, Zone } from '@domovoi/shared'
import type { DriverTrack, SonosDriver } from '../sonos/driver.js'
import { classifyPlaybackKind } from '../sonos/uris.js'

/**
 * Holds the current view of the household and hands it to the API and the
 * WebSocket. Driver events are coalesced here so a burst of UPnP notifications
 * becomes one client update rather than a dozen.
 */

const COALESCE_MS = 100

export type SystemStateEvents = {
  change: (state: SystemState) => void
}

export class SystemStateStore {
  private readonly emitter = new EventEmitter()
  private readonly driver: SonosDriver
  private state: SystemState
  private revision = 0
  private flushTimer: NodeJS.Timeout | undefined
  private readonly onDriverChange = () => this.scheduleFlush()

  constructor(driver: SonosDriver) {
    this.driver = driver
    this.state = this.build()
    driver.on('change', this.onDriverChange)
  }

  close() {
    this.driver.off('change', this.onDriverChange)
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.emitter.removeAllListeners()
  }

  get current(): SystemState {
    return this.state
  }

  on(event: 'change', listener: SystemStateEvents['change']): void {
    this.emitter.on(event, listener)
  }

  off(event: 'change', listener: SystemStateEvents['change']): void {
    this.emitter.off(event, listener)
  }

  /** Force a rebuild now, e.g. after a command we know changed something. */
  refresh() {
    this.flush()
  }

  private scheduleFlush() {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      this.flush()
    }, COALESCE_MS)
    this.flushTimer.unref()
  }

  private flush() {
    const next = this.build()
    // `revision` always differs, so compare everything else.
    const changed =
      JSON.stringify({ ...next, revision: 0 }) !== JSON.stringify({ ...this.state, revision: 0 })
    if (!changed) return
    this.revision += 1
    this.state = { ...next, revision: this.revision }
    this.emitter.emit('change', this.state)
  }

  private build(): SystemState {
    const snapshot = this.driver.snapshot()

    const zones: Zone[] = snapshot.zones.map((zone) => ({
      id: zone.id,
      name: zone.name,
      volume: zone.volume,
      muted: zone.muted,
      unreachable: zone.unreachable,
      bondedDeviceCount: zone.bondedDeviceCount,
    }))

    const groups: Group[] = snapshot.groups.map((group) => ({
      id: group.coordinatorZoneId,
      coordinatorZoneId: group.coordinatorZoneId,
      memberZoneIds: group.memberZoneIds,
      transportState: group.transportState,
      playbackKind: classifyPlaybackKind(group.transportUri, group.currentTrackUri),
      currentTrack: toApiTrack(group.coordinatorZoneId, group.currentTrack),
      positionSeconds: group.positionSeconds === null ? null : Math.round(group.positionSeconds),
      volume: group.volume,
      muted: group.muted,
      // Filled in by the preset engine once it exists (M6).
      activePresetId: null,
    }))

    // Stable ordering keeps the UI from reshuffling cards on every update.
    zones.sort((a, b) => a.name.localeCompare(b.name))
    groups.sort((a, b) => {
      const nameA = zones.find((z) => z.id === a.coordinatorZoneId)?.name ?? ''
      const nameB = zones.find((z) => z.id === b.coordinatorZoneId)?.name ?? ''
      return nameA.localeCompare(nameB)
    })

    return {
      ready: snapshot.ready,
      householdId: snapshot.householdId,
      zones,
      groups,
      revision: this.revision,
    }
  }
}

/**
 * Artwork lives on the speaker itself. Pointing a browser straight at
 * `http://192.168.x.x:1400/getaa` breaks as soon as the UI is reached over
 * Tailscale or a reverse proxy, so rewrite it to our own proxy endpoint.
 */
function toApiTrack(zoneId: string, track: DriverTrack | null): Track | null {
  if (!track) return null
  let artUrl: string | null = null
  if (track.artUrl) {
    try {
      const parsed = new URL(track.artUrl)
      const path = `${parsed.pathname}${parsed.search}`
      artUrl = `/api/art?zone=${encodeURIComponent(zoneId)}&path=${encodeURIComponent(path)}`
    } catch {
      artUrl = null
    }
  }
  return {
    uri: track.uri,
    title: track.title,
    artist: track.artist,
    album: track.album,
    artUrl,
    durationSeconds: track.durationSeconds,
  }
}
