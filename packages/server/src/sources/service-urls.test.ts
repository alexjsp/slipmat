import { describe, expect, it } from 'vitest'
import { parseServiceUrl, UnsupportedServiceUrlError } from './service-urls.js'

describe('parseServiceUrl — Spotify', () => {
  it('parses a playlist share link', () => {
    expect(parseServiceUrl('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M')).toEqual({
      service: 'spotify',
      kind: 'playlist',
      id: '37i9dQZF1DXcBWIGoYBM5M',
      uri: 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M',
    })
  })

  it('strips the tracking query the share sheet adds', () => {
    const ref = parseServiceUrl(
      'https://open.spotify.com/album/4uLU6hMCjMI75M1A2tKUQC?si=abc123&utm_source=copy-link',
    )
    expect(ref.kind).toBe('album')
    expect(ref.id).toBe('4uLU6hMCjMI75M1A2tKUQC')
  })

  it('handles the intl- locale segment', () => {
    const ref = parseServiceUrl('https://open.spotify.com/intl-de/track/4uLU6hMCjMI75M1A2tKUQC')
    expect(ref.kind).toBe('track')
    expect(ref.id).toBe('4uLU6hMCjMI75M1A2tKUQC')
  })

  it('accepts a native spotify: uri', () => {
    expect(parseServiceUrl('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M').uri).toBe(
      'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M',
    )
  })

  it('accepts a url without a scheme', () => {
    expect(parseServiceUrl('open.spotify.com/artist/4uLU6hMCjMI75M1A2tKUQC').kind).toBe('artist')
  })
})

describe('parseServiceUrl — Apple Music', () => {
  it('parses an album link', () => {
    const ref = parseServiceUrl('https://music.apple.com/gb/album/windowlicker-ep/1440826303')
    expect(ref.service).toBe('apple')
    expect(ref.kind).toBe('album')
    expect(ref.id).toBe('1440826303')
    expect(ref.storefront).toBe('gb')
  })

  it('parses a playlist link', () => {
    const ref = parseServiceUrl('https://music.apple.com/gb/playlist/chill-mix/pl.u-abc123')
    expect(ref.kind).toBe('playlist')
    expect(ref.id).toBe('pl.u-abc123')
  })

  it('treats an album link with ?i= as the individual track it shares', () => {
    const ref = parseServiceUrl(
      'https://music.apple.com/gb/album/windowlicker/1440826303?i=1440826305',
    )
    expect(ref.kind).toBe('track')
    expect(ref.id).toBe('1440826305')
  })
})

describe('parseServiceUrl — rejections', () => {
  it.each([
    '',
    'not a url',
    'https://example.com/playlist/123',
    'https://open.spotify.com/playlist',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://open.spotify.com/episode/512ojhOuo1ktJprKbVcKyQ',
  ])('rejects %j with a message the user can act on', (input) => {
    expect(() => parseServiceUrl(input)).toThrow(UnsupportedServiceUrlError)
  })

  it('explains what it wants', () => {
    expect(() => parseServiceUrl('https://example.com')).toThrow(/Spotify or Apple Music link/)
  })
})
