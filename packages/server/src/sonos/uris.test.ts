import { describe, expect, it } from 'vitest'
import { formatDuration, parseDuration } from './time.js'
import {
  classifyPlaybackKind,
  isProtectedFromPauseAll,
  isRadioStream,
  queueUriFor,
} from './uris.js'

describe('classifyPlaybackKind', () => {
  it('detects TV audio from the track uri', () => {
    expect(classifyPlaybackKind(null, 'x-sonos-htastream:RINCON_ABC01400:spdif')).toBe('tv')
  })

  it('detects TV audio even when the transport uri is the queue', () => {
    // A soundbar switched to TV can still report a stale queue transport uri.
    expect(
      classifyPlaybackKind(
        'x-rincon-queue:RINCON_ABC01400#0',
        'x-sonos-htastream:RINCON_ABC:spdif',
      ),
    ).toBe('tv')
  })

  it('detects line-in', () => {
    expect(classifyPlaybackKind(null, 'x-rincon-stream:RINCON_ABC01400')).toBe('line-in')
    expect(classifyPlaybackKind(null, 'x-sonos-vli:RINCON_ABC01400:2')).toBe('line-in')
  })

  it('detects radio streams', () => {
    expect(classifyPlaybackKind('x-sonosapi-stream:s12345?sid=254', null)).toBe('stream')
    expect(classifyPlaybackKind(null, 'x-rincon-mp3radio://stream.example/live')).toBe('stream')
  })

  it('detects the queue', () => {
    expect(
      classifyPlaybackKind(
        'x-rincon-queue:RINCON_ABC01400#0',
        'x-sonos-spotify:spotify%3atrack%3a1',
      ),
    ).toBe('queue')
  })

  it('reports idle when nothing is loaded', () => {
    expect(classifyPlaybackKind(null, null)).toBe('idle')
    expect(classifyPlaybackKind(undefined, undefined)).toBe('idle')
  })
})

describe('isProtectedFromPauseAll', () => {
  it('protects TV and line-in only', () => {
    expect(isProtectedFromPauseAll('tv')).toBe(true)
    expect(isProtectedFromPauseAll('line-in')).toBe(true)
    expect(isProtectedFromPauseAll('queue')).toBe(false)
    expect(isProtectedFromPauseAll('stream')).toBe(false)
  })
})

describe('isRadioStream', () => {
  it('does not treat queue tracks as streams', () => {
    expect(isRadioStream('x-sonos-spotify:spotify%3atrack%3a4uLU6hMCjMI75M1A2tKUQC')).toBe(false)
    expect(isRadioStream('x-file-cifs://nas/music/track.flac')).toBe(false)
  })
})

describe('queueUriFor', () => {
  it('builds the coordinator queue uri', () => {
    expect(queueUriFor('RINCON_ABC01400')).toBe('x-rincon-queue:RINCON_ABC01400#0')
  })
})

describe('duration parsing', () => {
  it('round-trips', () => {
    expect(parseDuration('0:03:21')).toBe(201)
    expect(formatDuration(201)).toBe('0:03:21')
  })

  it('treats unknown and zero durations as null', () => {
    expect(parseDuration('NOT_IMPLEMENTED')).toBeNull()
    expect(parseDuration('0:00:00')).toBeNull()
    expect(parseDuration(undefined)).toBeNull()
  })
})
