/**
 * Parsing pasted share URLs into a canonical descriptor.
 *
 * This is deliberately separate from turning a descriptor into a Sonos URI:
 * parsing is pure and knowable, whereas the Sonos side needs the household's
 * service id and account serial number and is far more fragile. Keeping them
 * apart means a service we can't yet play still parses cleanly and produces a
 * useful error, rather than failing somewhere unreadable.
 */

export type ServiceKind = 'track' | 'album' | 'playlist' | 'artist'

export type ServiceRef = {
  service: 'spotify' | 'apple'
  kind: ServiceKind
  /** Service-native id, e.g. a Spotify base-62 id or an Apple numeric id. */
  id: string
  /** Apple needs this; catalog ids are only meaningful within a storefront. */
  storefront?: string
  /** Canonical service URI, e.g. `spotify:playlist:37i9…`. */
  uri: string
}

export class UnsupportedServiceUrlError extends Error {
  constructor(url: string) {
    super(
      `Couldn't recognise "${url}". Paste a Spotify or Apple Music link to a playlist, album, artist or track.`,
    )
    this.name = 'UnsupportedServiceUrlError'
  }
}

const SPOTIFY_KINDS: Record<string, ServiceKind> = {
  track: 'track',
  album: 'album',
  playlist: 'playlist',
  artist: 'artist',
}

function parseSpotify(url: URL): ServiceRef | null {
  // open.spotify.com/playlist/<id>, with an optional /intl-xx/ locale segment.
  const segments = url.pathname.split('/').filter(Boolean)
  const start = segments[0]?.startsWith('intl-') ? 1 : 0
  const type = segments[start]
  const id = segments[start + 1]
  if (!type || !id) return null

  const kind = SPOTIFY_KINDS[type]
  if (!kind) return null

  // Ids are base-62; anything else is a URL we've misread.
  const cleanId = id.split('?')[0] ?? id
  if (!/^[A-Za-z0-9]{16,32}$/.test(cleanId)) return null

  return { service: 'spotify', kind, id: cleanId, uri: `spotify:${kind}:${cleanId}` }
}

function parseSpotifyUri(value: string): ServiceRef | null {
  const match = /^spotify:(track|album|playlist|artist):([A-Za-z0-9]{16,32})$/.exec(value)
  if (!match) return null
  const kind = SPOTIFY_KINDS[match[1]!]!
  return { service: 'spotify', kind, id: match[2]!, uri: `spotify:${kind}:${match[2]!}` }
}

function parseApple(url: URL): ServiceRef | null {
  // music.apple.com/<storefront>/<type>/<slug>/<id>[?i=<trackId>]
  const segments = url.pathname.split('/').filter(Boolean)
  const storefront = segments[0]
  const type = segments[1]
  if (!storefront || !type) return null

  // A track shared from an album carries the album URL plus ?i=<trackId>.
  const trackId = url.searchParams.get('i')
  if (trackId && type === 'album') {
    return {
      service: 'apple',
      kind: 'track',
      id: trackId,
      storefront,
      uri: `apple:track:${trackId}`,
    }
  }

  const id = segments[segments.length - 1]
  if (!id || !/^(pl\.)?[A-Za-z0-9.-]+$/.test(id)) return null

  const kind =
    type === 'album'
      ? 'album'
      : type === 'playlist'
        ? 'playlist'
        : type === 'artist'
          ? 'artist'
          : type === 'song'
            ? 'track'
            : null
  if (!kind) return null

  return { service: 'apple', kind, id, storefront, uri: `apple:${kind}:${id}` }
}

/**
 * Accepts a share URL or a native service URI. Throws
 * `UnsupportedServiceUrlError` for anything we don't recognise, so the message
 * reaches the user rather than a generic parse failure.
 */
export function parseServiceUrl(input: string): ServiceRef {
  const trimmed = input.trim()
  if (!trimmed) throw new UnsupportedServiceUrlError(input)

  const asUri = parseSpotifyUri(trimmed)
  if (asUri) return asUri

  let url: URL
  try {
    url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`)
  } catch {
    throw new UnsupportedServiceUrlError(input)
  }

  const host = url.hostname.toLowerCase()
  const parsed =
    host.endsWith('spotify.com') || host === 'spotify.link'
      ? parseSpotify(url)
      : host.endsWith('music.apple.com')
        ? parseApple(url)
        : null

  if (!parsed) throw new UnsupportedServiceUrlError(input)
  return parsed
}

/** A single track can't be shuffled with anything; it's just one URI. */
export function isContainerRef(ref: ServiceRef): boolean {
  return ref.kind !== 'track'
}
