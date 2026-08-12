import { describe, expect, it } from 'vitest'
import { songKey } from './duplicates.js'

describe('songKey', () => {
  it('matches the same song reached through different playlists', () => {
    // The real case: identical track, two Apple Music library ids, so the URIs
    // could never match. All six repeats in the queue looked like this.
    expect(songKey({ title: 'Eclipse', artist: 'Delta Goodrem' })).toBe(
      songKey({ title: 'Eclipse', artist: 'Delta Goodrem' }),
    )
  })

  it('keeps different songs that share a title apart', () => {
    // Both were in the same household: title alone would have merged them.
    expect(songKey({ title: 'Poison', artist: 'Alice Cooper' })).not.toBe(
      songKey({ title: 'Poison', artist: 'Rita Ora' }),
    )
    expect(songKey({ title: 'Take On Me', artist: 'a-ha' })).not.toBe(
      songKey({ title: 'Take On Me', artist: 'Weezer' }),
    )
  })

  it('ignores case and stray whitespace', () => {
    expect(songKey({ title: '  Brontosaurus ', artist: 'They Might Be Giants' })).toBe(
      songKey({ title: 'BRONTOSAURUS', artist: 'they might be giants' }),
    )
  })

  it('reads an escaped ampersand as an ampersand', () => {
    // Artists arrive still carrying one level of encoding in places, and
    // "&" and "&amp;" have to be the same artist or the duplicate is missed.
    expect(songKey({ title: 'Home', artist: 'Nathan Evans &amp; SAINT PHNX' })).toBe(
      songKey({ title: 'Home', artist: 'Nathan Evans & SAINT PHNX' }),
    )
  })

  it('gives up when either half is missing', () => {
    // Two tracks Sonos has told us nothing about are not the same track.
    expect(songKey({ title: 'Untitled', artist: null })).toBeNull()
    expect(songKey({ title: null, artist: 'Someone' })).toBeNull()
    expect(songKey({ title: '  ', artist: 'Someone' })).toBeNull()
  })
})
