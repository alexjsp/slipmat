import type { ResolutionMode, SourceKind } from '@domovoi/shared'
import { MetaDataHelper } from '@svrooij/sonos'
import type { Logger } from '../logger.js'
import type { DriverBrowseItem, SonosDriver } from '../sonos/driver.js'
import { isRadioStream } from '../sonos/uris.js'
import { parseServiceUrl, ServiceNotConnectedError, serviceDisplayName } from './service-urls.js'

export type ResolvedTrack = {
  uri: string
  metadata: string | null
  title: string | null
  artist: string | null
}

export type ResolvedSource = {
  mode: ResolutionMode
  label: string
  tracks: ResolvedTrack[]
  /**
   * For `container_only` and `stream`: the single URI to hand to
   * SetAVTransportURI, since these can't be expanded into a track pool.
   */
  containerUri: string | null
  containerMetadata: string | null
  /**
   * Structured metadata for pasted service URLs. Kept alongside the string
   * form because Sonos rejects hand-stringified DIDL for these containers.
   */
  containerMetadataObject?: unknown
  /**
   * True when resolving this borrowed a speaker's queue. Cheap sources are a
   * plain ContentDirectory browse and can safely be re-resolved on every
   * activation; expensive ones cannot, so they rely on the cache.
   */
  expensive: boolean
  warning: string | null
}

export type SourceInput = {
  kind: SourceKind
  ref: string
  label?: string
}

export type ResolveOptions = {
  /**
   * Zone to use for scratch-queue expansion, overriding the idle-zone search.
   *
   * During activation this is the preset's own coordinator: its queue is about
   * to be cleared and replaced regardless, so expanding there costs nothing and
   * disturbs nobody. That also makes expansion work in a house with only a
   * couple of speakers, where there may be no idle zone to borrow at all.
   */
  expansionZone?: { zoneId: string; queueIsExpendable: boolean }
}

/** Where the browse tree starts for each kind of saved content. */
export const ROOT_OBJECT_IDS = {
  favorites: 'FV:2',
  playlists: 'SQ:',
  albums: 'A:ALBUM',
  artists: 'A:ARTIST',
  genres: 'A:GENRE',
  tracks: 'A:TRACKS',
} as const

export type SourceResolverOptions = {
  driver: SonosDriver
  logger: Logger
  /**
   * Zone used for scratch-queue expansion. When unset, an idle zone with an
   * empty queue is chosen at resolve time — expansion temporarily replaces a
   * speaker's queue, so we go out of our way to pick one nobody is using.
   */
  utilityZoneId?: string | undefined
  /**
   * Expansion mutates a real speaker's queue. Off by default so that nothing —
   * a test, a dev run, an accidental import — can disturb a household without
   * the operator having deliberately enabled it.
   */
  allowScratchQueueExpansion?: boolean
}

export class SourceResolver {
  private readonly driver: SonosDriver
  private readonly logger: Logger
  private readonly utilityZoneId: string | undefined
  private readonly allowExpansion: boolean

  constructor(options: SourceResolverOptions) {
    this.driver = options.driver
    this.logger = options.logger.child({ component: 'resolver' })
    this.utilityZoneId = options.utilityZoneId
    this.allowExpansion = options.allowScratchQueueExpansion ?? false
  }

  async resolve(source: SourceInput, options: ResolveOptions = {}): Promise<ResolvedSource> {
    switch (source.kind) {
      case 'sonos_playlist':
      case 'library_container':
        return this.resolveContainerObject(source)
      case 'sonos_favorite':
        return this.resolveFavorite(source, options)
      case 'service_url':
        return this.resolveServiceUrl(source, options)
      case 'raw_uri':
        return this.singleUri(source.ref, null, source.label ?? source.ref)
    }
  }

  /**
   * Sonos playlists and the local library are directly browsable, so these
   * resolve exactly and cheaply — no scratch queue involved.
   */
  private async resolveContainerObject(source: SourceInput): Promise<ResolvedSource> {
    const items = await this.browseAll(source.ref)
    const tracks = items.filter((item) => !item.isContainer && item.uri).map(toResolvedTrack)

    if (tracks.length === 0) {
      return {
        mode: 'container_only',
        label: source.label ?? source.ref,
        tracks: [],
        containerUri: null,
        containerMetadata: null,
        expensive: false,
        warning: 'This container has no playable tracks.',
      }
    }

    return {
      mode: 'tracks',
      label: source.label ?? source.ref,
      tracks,
      containerUri: null,
      containerMetadata: null,
      expensive: false,
      warning: null,
    }
  }

  /**
   * A favourite is a pointer. It can be a radio stream (a solo source), a
   * container (expandable), or a single track.
   */
  private async resolveFavorite(
    source: SourceInput,
    options: ResolveOptions = {},
  ): Promise<ResolvedSource> {
    const favorites = await this.browseAll(ROOT_OBJECT_IDS.favorites)
    const favorite = favorites.find((item) => item.id === source.ref)
    if (!favorite) throw new Error(`Favourite ${source.ref} no longer exists`)

    const label = source.label ?? favorite.title
    const uri = favorite.uri

    if (!uri) {
      return this.resolveContainerObject({ ...source, ref: favorite.id, label })
    }

    if (isRadioStream(uri)) {
      return {
        mode: 'stream',
        label,
        tracks: [],
        containerUri: uri,
        containerMetadata: favorite.metadata,
        expensive: false,
        warning: null,
      }
    }

    if (uri.startsWith('x-rincon-cpcontainer:') || favorite.isContainer) {
      return this.expandContainer(uri, favorite.metadata, label, undefined, undefined, options)
    }

    return this.singleUri(uri, favorite.metadata, label)
  }

  /**
   * A pasted share URL. `MetaDataHelper` already knows the container URI shapes
   * Sonos expects per service, so we lean on that rather than reinventing them.
   */
  private async resolveServiceUrl(
    source: SourceInput,
    options: ResolveOptions = {},
  ): Promise<ResolvedSource> {
    const ref = parseServiceUrl(source.ref)
    const guessed = MetaDataHelper.GuessTrack(ref.uri)

    if (!guessed?.TrackUri) {
      throw new Error(
        `Sonos has no URI format for ${ref.service} ${ref.kind}. Try adding it as a Sonos favourite instead, then pick it from Favourites.`,
      )
    }

    const label = source.label ?? `${ref.service} ${ref.kind}`
    const metadata = MetaDataHelper.TrackToMetaData(guessed, true, guessed.CdUdn)

    if (ref.kind === 'track') {
      return this.singleUri(guessed.TrackUri, metadata, label)
    }

    return this.expandContainer(
      guessed.TrackUri,
      metadata,
      label,
      guessed,
      serviceDisplayName(ref.service),
      options,
    )
  }

  private singleUri(uri: string, metadata: string | null, label: string): ResolvedSource {
    return {
      mode: isRadioStream(uri) ? 'stream' : 'tracks',
      label,
      tracks: isRadioStream(uri) ? [] : [{ uri, metadata, title: null, artist: null }],
      containerUri: isRadioStream(uri) ? uri : null,
      containerMetadata: isRadioStream(uri) ? metadata : null,
      expensive: false,
      warning: null,
    }
  }

  /**
   * Expand a container Sonos can't browse directly (a streaming service
   * playlist or album) by making a speaker do it for us: enqueue the container
   * on a scratch zone, read back the tracks Sonos expanded it into, then put
   * that zone's queue back exactly as it was.
   *
   * This is the only path in Domovoi that mutates a speaker as a side effect of
   * a read, which is why it is opt-in and restores what it touched.
   */
  private async expandContainer(
    containerUri: string,
    containerMetadata: string | null,
    label: string,
    containerMetadataObject?: unknown,
    serviceName?: string,
    options: ResolveOptions = {},
  ): Promise<ResolvedSource> {
    const containerOnly = (warning: string): ResolvedSource => ({
      mode: 'container_only',
      label,
      tracks: [],
      containerUri,
      containerMetadata,
      containerMetadataObject,
      expensive: true,
      warning,
    })

    if (!this.allowExpansion) {
      return containerOnly(
        'Track-by-track expansion is disabled, so this source can only be played whole under Sonos shuffle — it cannot be mixed with others.',
      )
    }

    const override = options.expansionZone
    const zoneId = override?.zoneId ?? (await this.pickUtilityZone())
    if (!zoneId) {
      return containerOnly(
        'No idle speaker was free to expand this source, so it can only be played whole.',
      )
    }

    let savedQueueId: string | undefined
    try {
      // When the caller says the queue is expendable — activation, where this
      // zone is about to be cleared and refilled anyway — skip the snapshot
      // entirely. Saving and restoring a queue we're about to destroy is pure
      // latency in front of a button press.
      if (!override?.queueIsExpendable) {
        const existing = await this.driver.getQueue(zoneId)
        if (existing.length > 0) {
          savedQueueId = await this.driver.saveQueue(zoneId, `Domovoi restore ${Date.now()}`)
        }
      }

      await this.driver.clearQueue(zoneId)
      await this.driver.addUrisToQueue(zoneId, [
        {
          uri: containerUri,
          metadata: containerMetadata ?? undefined,
          metadataObject: containerMetadataObject,
        },
      ])
      const expanded = await this.driver.getQueue(zoneId)
      const tracks = expanded.filter((item) => item.uri).map(toResolvedTrack)

      if (tracks.length === 0) {
        return containerOnly('Sonos returned no tracks for this source.')
      }

      this.logger.info({ containerUri, count: tracks.length, zoneId }, 'expanded container')
      return {
        mode: 'tracks',
        // "apple playlist" is a placeholder; once Sonos has told us what the
        // tracks are, the album name is a far better default preset label.
        label: albumLabel(expanded) ?? label,
        tracks,
        containerUri,
        containerMetadata,
        containerMetadataObject,
        expensive: true,
        warning: null,
      }
    } catch (err) {
      // UPnP 800 on a service container means Sonos has no account for that
      // service — playing it whole would fail too, so don't pretend otherwise.
      if (serviceName && isServiceUnavailable(err)) {
        throw new ServiceNotConnectedError(serviceName)
      }
      this.logger.warn({ err, containerUri, zoneId }, 'scratch-queue expansion failed')
      return containerOnly(
        'Sonos would not expand this source into tracks, so it can only be played whole.',
      )
    } finally {
      // Always put a borrowed speaker back, even if expansion threw. An
      // expendable queue is the caller's to deal with.
      if (!override?.queueIsExpendable) await this.restoreQueue(zoneId, savedQueueId)
    }
  }

  private async restoreQueue(zoneId: string, savedQueueId: string | undefined) {
    try {
      await this.driver.clearQueue(zoneId)
      if (savedQueueId) {
        await this.driver.addUrisToQueue(zoneId, [{ uri: savedQueueId }])
        await this.driver.removeSavedQueue(savedQueueId)
      }
    } catch (err) {
      this.logger.error({ err, zoneId, savedQueueId }, 'failed to restore borrowed queue')
    }
  }

  /** Prefer a configured utility zone, else any stopped zone with no queue. */
  private async pickUtilityZone(): Promise<string | undefined> {
    const snapshot = this.driver.snapshot()
    if (this.utilityZoneId) return this.utilityZoneId

    for (const group of snapshot.groups) {
      if (group.transportState === 'PLAYING' || group.transportState === 'TRANSITIONING') continue
      const zone = snapshot.zones.find((z) => z.id === group.coordinatorZoneId)
      if (!zone || zone.unreachable) continue
      const queue = await this.driver.getQueue(zone.id)
      if (queue.length === 0) return zone.id
    }
    return undefined
  }

  /** Browse every page — Sonos caps a single Browse at a few hundred items. */
  private async browseAll(objectId: string): Promise<DriverBrowseItem[]> {
    const items: DriverBrowseItem[] = []
    const pageSize = 200
    let start = 0
    for (;;) {
      const page = await this.driver.browse(objectId, { start, count: pageSize })
      items.push(...page.items)
      start += page.items.length
      if (page.items.length === 0 || start >= page.total) break
    }
    return items
  }
}

function toResolvedTrack(item: DriverBrowseItem): ResolvedTrack {
  return {
    uri: item.uri!,
    metadata: item.metadata,
    title: item.title,
    artist: item.subtitle,
  }
}

/** Sonos answers 800 for "no account for this service", among other things. */
function isServiceUnavailable(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'UpnpErrorCode' in err &&
    (err as { UpnpErrorCode: unknown }).UpnpErrorCode === 800
  )
}

/**
 * When every expanded track shares an album, that album name is a better label
 * than the generic "<service> <kind>" placeholder we started with.
 */
function albumLabel(items: DriverBrowseItem[]): string | null {
  const albums = new Set(items.map((item) => item.album).filter(Boolean))
  const [only] = [...albums]
  return albums.size === 1 && only ? only : null
}
