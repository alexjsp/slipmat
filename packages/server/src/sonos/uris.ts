import type { PlaybackKind } from '@domovoi/shared'

/**
 * Sonos encodes what a group is doing in the URI it is playing. These prefixes
 * are the whole basis for two behaviours that matter:
 *
 *  - "Pause All Music" must skip TV and line-in.
 *  - Radio streams are single, non-skippable URIs, so they can only ever be a
 *    solo preset source — they cannot be shuffled into a track pool.
 */
const TV_PREFIX = 'x-sonos-htastream:'
const LINE_IN_PREFIXES = ['x-rincon-stream:', 'x-sonos-vli:']
const QUEUE_PREFIX = 'x-rincon-queue:'
/** This device is following another coordinator; it has no playback of its own. */
const FOLLOWER_PREFIX = 'x-rincon:'

const STREAM_PREFIXES = [
  'x-sonosapi-stream:', // most internet radio
  'x-sonosapi-radio:', // service-provided radio (Spotify/Apple stations)
  'x-sonosapi-hls:', // live HLS
  'x-rincon-mp3radio:',
  'aac:',
  'hls-radio:',
]

// Deliberately not a stream prefix: `x-sonosapi-hls-static:` is a fixed-length
// HLS asset — an ordinary track that happens to be delivered in segments. Apple
// Music serves queue tracks this way once Sonos has resolved them against the
// service, so treating it as radio would classify a perfectly normal preset
// queue as an unseekable stream.

/**
 * Named extensions only. A greedy `\.[a-z0-9]+$` looks equivalent and is not:
 * an Apple Music id ends in digits, so `librarytrack:a.1887686006` loses its
 * identity entirely when the URI happens to carry no extension.
 */
const AUDIO_EXTENSION = /\.(mp3|mp4|m4a|aac|flac|ogg|opus|wav|wma|alac)$/i

export function isTvStream(uri: string | undefined | null): boolean {
  return !!uri && uri.startsWith(TV_PREFIX)
}

export function isLineIn(uri: string | undefined | null): boolean {
  return !!uri && LINE_IN_PREFIXES.some((p) => uri.startsWith(p))
}

export function isFollower(uri: string | undefined | null): boolean {
  return !!uri && uri.startsWith(FOLLOWER_PREFIX) && !uri.startsWith(QUEUE_PREFIX)
}

/**
 * True for anything that plays forever and can't be seeked or shuffled.
 * `MetadataHelper.IsRadioStream` covers most of this upstream, but we need the
 * check on bare URIs from the queue too.
 */
export function isRadioStream(uri: string | undefined | null): boolean {
  return !!uri && STREAM_PREFIXES.some((p) => uri.startsWith(p))
}

/**
 * Classify what a group is doing.
 *
 * `transportUri` is the AVTransport URI (what the group was pointed at) and
 * `trackUri` is the track currently coming out of it. TV and line-in only ever
 * show up in the track URI, so that takes precedence.
 */
export function classifyPlaybackKind(
  transportUri: string | undefined | null,
  trackUri: string | undefined | null,
): PlaybackKind {
  if (isTvStream(trackUri) || isTvStream(transportUri)) return 'tv'
  if (isLineIn(trackUri) || isLineIn(transportUri)) return 'line-in'
  // A group pointed at its own queue is playing a queue, whatever scheme the
  // individual track arrives over. Radio is only ever set as the transport URI.
  if (transportUri?.startsWith(QUEUE_PREFIX)) return 'queue'
  if (isRadioStream(trackUri) || isRadioStream(transportUri)) return 'stream'
  if (!transportUri && !trackUri) return 'idle'
  return 'unknown'
}

/** Groups whose audio we deliberately never touch in "Pause All Music". */
export function isProtectedFromPauseAll(kind: PlaybackKind): boolean {
  return kind === 'tv' || kind === 'line-in'
}

/**
 * The service item a URI refers to, independent of how it is being delivered.
 *
 * Sonos rewrites an enqueued URI once it has resolved the item against the
 * music service: `x-sonos-http:librarytrack%3aa.123.mp4?sid=204…` comes back
 * out of the queue as `x-sonosapi-hls-static:librarytrack:a.123?sid=204…`.
 * Same track, different scheme, different encoding — so "is the group playing
 * something we queued?" cannot be answered by comparing URIs directly.
 */
export function trackIdentity(uri: string | undefined | null): string | null {
  if (!uri) return null
  const withoutScheme = uri.replace(/^[a-z0-9-]+:/i, '')
  const withoutQuery = withoutScheme.split('?')[0] ?? ''
  const withoutExtension = withoutQuery.replace(AUDIO_EXTENSION, '')
  if (!withoutExtension) return null
  try {
    return decodeURIComponent(withoutExtension).toLowerCase()
  } catch {
    // A stray `%` that isn't an escape; the raw form still identifies it.
    return withoutExtension.toLowerCase()
  }
}

/** The URI that points a coordinator at its own queue. */
export function queueUriFor(coordinatorUuid: string): string {
  return `${QUEUE_PREFIX}${coordinatorUuid}#0`
}

/** The URI that makes a device follow another coordinator. */
export function followUriFor(coordinatorUuid: string): string {
  return `${FOLLOWER_PREFIX}${coordinatorUuid}`
}
