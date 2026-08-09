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
  'x-sonosapi-hls:',
  'x-sonosapi-hls-static:',
  'x-rincon-mp3radio:',
  'aac:',
  'hls-radio:',
]

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
  if (isRadioStream(trackUri) || isRadioStream(transportUri)) return 'stream'
  if (transportUri?.startsWith(QUEUE_PREFIX)) return 'queue'
  if (!transportUri && !trackUri) return 'idle'
  return 'unknown'
}

/** Groups whose audio we deliberately never touch in "Pause All Music". */
export function isProtectedFromPauseAll(kind: PlaybackKind): boolean {
  return kind === 'tv' || kind === 'line-in'
}

/** The URI that points a coordinator at its own queue. */
export function queueUriFor(coordinatorUuid: string): string {
  return `${QUEUE_PREFIX}${coordinatorUuid}#0`
}

/** The URI that makes a device follow another coordinator. */
export function followUriFor(coordinatorUuid: string): string {
  return `${FOLLOWER_PREFIX}${coordinatorUuid}`
}
