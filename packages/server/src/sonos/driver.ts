/**
 * The only interface the rest of Domovoi is allowed to talk to a speaker
 * through. Two implementations exist: `RealSonosDriver` (UPnP, via
 * @svrooij/sonos) and `FakeSonosDriver` (tests).
 *
 * Everything is expressed in terms of *zones* — rooms — not devices. Bonded
 * satellites and subs never appear here.
 */

export type DriverTrack = {
  uri: string
  title: string | null
  artist: string | null
  album: string | null
  /** Absolute URL on the speaker; the API layer rewrites it to the art proxy. */
  artUrl: string | null
  durationSeconds: number | null
}

export type DriverZone = {
  id: string
  name: string
  host: string
  port: number
  volume: number
  muted: boolean
  /** Bonded devices folded into this zone (stereo pair members, subs). */
  bondedDeviceCount: number
  /** No recent successful contact — commands will probably fail. */
  unreachable: boolean
}

export type DriverGroup = {
  coordinatorZoneId: string
  memberZoneIds: string[]
  transportState: 'PLAYING' | 'PAUSED_PLAYBACK' | 'STOPPED' | 'TRANSITIONING'
  /** What the coordinator's AVTransport is pointed at (queue, stream, TV…). */
  transportUri: string | null
  currentTrackUri: string | null
  currentTrack: DriverTrack | null
  positionSeconds: number | null
  volume: number
  muted: boolean
}

export type DriverSnapshot = {
  ready: boolean
  householdId: string | null
  zones: DriverZone[]
  groups: DriverGroup[]
}

export type DriverEvents = {
  /** Any state or topology change. Coalesced by the store before it reaches clients. */
  change: () => void
}

export interface SonosDriver {
  start(): Promise<void>
  stop(): Promise<void>

  /** Current view of the household. Cheap — served from cached event state. */
  snapshot(): DriverSnapshot

  on<E extends keyof DriverEvents>(event: E, listener: DriverEvents[E]): void
  off<E extends keyof DriverEvents>(event: E, listener: DriverEvents[E]): void

  // --- playback -----------------------------------------------------------
  play(zoneId: string): Promise<void>
  pause(zoneId: string): Promise<void>
  next(zoneId: string): Promise<void>
  previous(zoneId: string): Promise<void>
  seek(zoneId: string, positionSeconds: number): Promise<void>

  // --- rendering ----------------------------------------------------------
  setVolume(zoneId: string, volume: number): Promise<void>
  setMute(zoneId: string, muted: boolean): Promise<void>

  // --- grouping -----------------------------------------------------------
  /** Make `zoneIds` follow `coordinatorZoneId`. */
  joinGroup(coordinatorZoneId: string, zoneIds: string[]): Promise<void>
  /** Break `zoneIds` out into standalone groups of their own. */
  leaveGroup(zoneIds: string[]): Promise<void>

  /**
   * Fetch the artwork bytes for a zone. Art lives on the speaker itself, so we
   * proxy it rather than pointing browsers at `:1400` — that breaks the moment
   * the UI is reached over Tailscale or a reverse proxy.
   */
  fetchArt(zoneId: string, path: string): Promise<{ body: ArrayBuffer; contentType: string }>
}
