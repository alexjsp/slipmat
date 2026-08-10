import { describe, expect, it } from 'vitest'
import type { ResolvedTrack } from '../sources/resolver.js'
import { buildQueue, createRandom, dedupeTracks, shuffle } from './shuffle.js'

const track = (uri: string): ResolvedTrack => ({ uri, metadata: null, title: uri, artist: null })

describe('shuffle', () => {
  it('is a permutation, losing and inventing nothing', () => {
    const items = Array.from({ length: 200 }, (_, i) => i)
    const result = shuffle(items, createRandom(42))
    expect(result).toHaveLength(items.length)
    expect([...result].sort((a, b) => a - b)).toEqual(items)
  })

  it('does not mutate its input', () => {
    const items = [1, 2, 3, 4, 5]
    shuffle(items, createRandom(1))
    expect(items).toEqual([1, 2, 3, 4, 5])
  })

  it('is deterministic for a given seed, and differs between seeds', () => {
    const items = Array.from({ length: 50 }, (_, i) => i)
    expect(shuffle(items, createRandom(7))).toEqual(shuffle(items, createRandom(7)))
    expect(shuffle(items, createRandom(7))).not.toEqual(shuffle(items, createRandom(8)))
  })

  it('actually reorders', () => {
    const items = Array.from({ length: 100 }, (_, i) => i)
    expect(shuffle(items, createRandom(3))).not.toEqual(items)
  })
})

describe('dedupeTracks', () => {
  it('ignores the per-request query string streaming URIs carry', () => {
    // The same Apple Music track reached via two different sources.
    const tracks = [
      track('x-sonos-http:librarytrack:a.669287844.mp4?sid=204&flags=8232&sn=2'),
      track('x-sonos-http:librarytrack:a.669287844.mp4?sid=204&flags=32&sn=7'),
      track('x-sonos-http:librarytrack:a.111111111.mp4?sid=204&flags=8232&sn=2'),
    ]
    expect(dedupeTracks(tracks)).toHaveLength(2)
  })

  it('keeps the first occurrence', () => {
    const first = track('x-sonos-http:song:1.mp4?sn=2')
    const result = dedupeTracks([first, track('x-sonos-http:song:1.mp4?sn=9')])
    expect(result[0]).toBe(first)
  })

  it('treats genuinely different tracks as different', () => {
    expect(dedupeTracks([track('a'), track('b'), track('c')])).toHaveLength(3)
  })
})

describe('buildQueue', () => {
  const jazz = [track('j1'), track('j2'), track('j3')]
  const rock = [track('r1'), track('r2'), track('r3')]

  it('interleaves sources rather than concatenating them', () => {
    const result = buildQueue([jazz, rock], { dedupe: true, shuffle: true, seed: 5 })
    expect(result).toHaveLength(6)

    // The whole point of the feature: the second half must not be all one source.
    const secondHalf = result.slice(3).map((t) => t.uri[0])
    expect(new Set(secondHalf).size).toBeGreaterThan(1)
  })

  it('honours dedupe across sources', () => {
    const overlapping = [track('shared?sn=1'), track('x1')]
    const other = [track('shared?sn=2'), track('x2')]
    expect(buildQueue([overlapping, other], { dedupe: true, shuffle: true, seed: 1 })).toHaveLength(
      3,
    )
    expect(
      buildQueue([overlapping, other], { dedupe: false, shuffle: true, seed: 1 }),
    ).toHaveLength(4)
  })

  it('plays sources end to end, in preset order, when shuffle is off', () => {
    const result = buildQueue([jazz, rock], { dedupe: true, shuffle: false, seed: 5 })
    expect(result.map((t) => t.uri)).toEqual(['j1', 'j2', 'j3', 'r1', 'r2', 'r3'])
  })

  it('still dedupes with shuffle off, without disturbing the order', () => {
    const a = [track('x'), track('y')]
    const b = [track('y'), track('z')]
    expect(buildQueue([a, b], { dedupe: true, shuffle: false, seed: 1 }).map((t) => t.uri)).toEqual(
      ['x', 'y', 'z'],
    )
  })

  it('ignores the seed entirely when shuffle is off', () => {
    const first = buildQueue([jazz, rock], { dedupe: true, shuffle: false, seed: 1 })
    const second = buildQueue([jazz, rock], { dedupe: true, shuffle: false, seed: 999 })
    expect(first.map((t) => t.uri)).toEqual(second.map((t) => t.uri))
  })

  it('handles an empty source without dropping the others', () => {
    expect(buildQueue([jazz, [], rock], { dedupe: true, shuffle: true, seed: 2 })).toHaveLength(6)
  })
})
