/**
 * The only interface the rest of Slipmat is allowed to talk to a speaker
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

export type DriverBrowseItem = {
  /** ContentDirectory object id (`SQ:3`, `A:ALBUM/…`) or a bare URI. */
  id: string
  title: string
  subtitle: string | null
  album: string | null
  artUrl: string | null
  isContainer: boolean
  /** Playable resource, absent for pure containers. */
  uri: string | null
  /** DIDL-Lite metadata, needed verbatim when enqueueing. */
  metadata: string | null
}

export type DriverBrowseResult = {
  items: DriverBrowseItem[]
  total: number
}

export type DriverMusicService = {
  id: number
  name: string
  /** Account serial number; service URIs are invalid without it. */
  serial: string
}

export type DriverPlayMode = 'NORMAL' | 'REPEAT_ALL' | 'SHUFFLE_NOREPEAT' | 'SHUFFLE'

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
  /**
   * Make `zoneIds` follow `coordinatorZoneId`.
   *
   * `settle: false` issues the joins and returns without waiting for Sonos to
   * report the new topology, which takes a couple of seconds. Pair it with
   * `awaitGrouping` when the caller has something better to do meanwhile.
   */
  joinGroup(
    coordinatorZoneId: string,
    zoneIds: string[],
    options?: { settle?: boolean },
  ): Promise<void>
  /** Wait until Sonos reports `zoneIds` as members of the coordinator's group. */
  awaitGrouping(coordinatorZoneId: string, zoneIds: string[]): Promise<void>
  /** Break `zoneIds` out into standalone groups of their own. */
  leaveGroup(zoneIds: string[], options?: { settle?: boolean }): Promise<void>

  /**
   * Fetch the artwork bytes for a zone. Art lives on the speaker itself, so we
   * proxy it rather than pointing browsers at `:1400` — that breaks the moment
   * the UI is reached over Tailscale or a reverse proxy.
   */
  fetchArt(zoneId: string, path: string): Promise<{ body: ArrayBuffer; contentType: string }>

  // --- content (read-only) ------------------------------------------------

  /** Browse the ContentDirectory: favourites, playlists, music library. */
  browse(
    objectId: string,
    options?: { start?: number; count?: number },
  ): Promise<DriverBrowseResult>

  /** Services the household is signed in to, with the serials their URIs need. */
  listMusicServices(): Promise<DriverMusicService[]>

  // --- queue (mutating) ---------------------------------------------------

  getQueue(zoneId: string): Promise<DriverBrowseItem[]>
  clearQueue(zoneId: string): Promise<void>
  /**
   * Drop one track from the queue by its 1-based position.
   *
   * Positions shift as tracks are removed, so a caller removing several must
   * work from the back forwards.
   */
  removeTrackFromQueue(zoneId: string, position: number): Promise<void>
  /**
   * Jump to a 1-based position in the queue.
   *
   * Under shuffle this indexes the *shuffled* order Sonos is playing, not the
   * order the tracks were added in — which is what makes it usable for picking
   * a random starting point.
   */
  seekToTrack(zoneId: string, position: number): Promise<void>
  /**
   * Enqueue in order. Implementations batch to respect the SOAP payload limit.
   *
   * `metadata` is an already-XML-encoded DIDL string (as taken verbatim from a
   * favourite's `r:resMD`). `metadataObject` is structured metadata the
   * transport encodes itself — required for pasted service URLs, where a
   * hand-stringified value is rejected with UPnP 402.
   */
  addUrisToQueue(
    zoneId: string,
    items: { uri: string; metadata?: string; metadataObject?: unknown }[],
    options?: {
      /**
       * Override the SOAP read timeout. Enqueueing a *container* is not a quick
       * call: Sonos expands it into individual tracks before it answers, which
       * for a few thousand tracks takes well over the library's fixed 30s.
       */
      timeoutMs?: number
    },
  ): Promise<void>
  /** Point the coordinator at its own queue. */
  setTransportToQueue(zoneId: string): Promise<void>
  /** Point the coordinator at a single URI — a radio stream, TV, or line-in. */
  setTransportUri(zoneId: string, uri: string, metadata?: string): Promise<void>
  setPlayMode(zoneId: string, mode: DriverPlayMode): Promise<void>
  setCrossfade(zoneId: string, enabled: boolean): Promise<void>

  // Deliberately no saveQueue/removeSavedQueue. Snapshotting a queue means
  // creating a Sonos playlist in someone's household as a side effect of an
  // internal operation, and leaving it behind if the process dies before the
  // cleanup runs. Nothing here may add playlists to a user's system.
}
