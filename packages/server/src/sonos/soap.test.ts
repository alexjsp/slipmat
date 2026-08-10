import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { encodeTrackUri, encodeXml } from './soap.js'

/**
 * The library's own helper, loaded the awkward way.
 *
 * It is a default export of an internal CJS module and is not re-exported from
 * the package root, so it cannot be imported normally — but it can be reached
 * here, which is the whole point: our reimplementation is only correct insofar
 * as it agrees with the one the rest of the calls go through.
 */
const require = createRequire(import.meta.url)
const XmlHelper = require('@svrooij/sonos/lib/helpers/xml-helper.js').default as {
  EncodeXml(value: unknown): string
  EncodeTrackUri(uri: string): string
}

const URIS = [
  // The case that actually matters: a large Apple Music container.
  'x-rincon-cpcontainer:1006206clibraryplaylist%3Ap.VMMqkhzQ5Jk?sid=204&flags=8300&sn=2',
  'x-sonos-http:librarytrack%3aa.1440913387.mp4?sid=204&flags=8232&sn=2',
  'x-rincon-cpcontainer:1006206cspotify%3aplaylist%3a37i9dQZF1DXcBWIGoYBM5M?sid=9&flags=8300&sn=7',
  'x-sonosapi-stream:bbc_6music?sid=254&flags=8224',
  'x-file-cifs://nas/music/A Band/An Album/01 A Track.flac',
  'x-rincon-playlist:RINCON_ABC01400#A:ALBUM/Some Album',
  'http://10.10.10.1:1400/some/path?a=b&c=d',
  'x-sonos-htastream:RINCON_ABC01400:spdif',
  'x-rincon-mp3radio://stream.example.com/live',
]

describe('encodeTrackUri', () => {
  for (const uri of URIS) {
    it(`matches the library for ${uri.split(':')[0]}`, () => {
      expect(encodeTrackUri(uri)).toBe(XmlHelper.EncodeTrackUri(uri))
    })
  }

  it('percent-encodes colons after the scheme but not the scheme itself', () => {
    expect(encodeTrackUri('x-sonos-http:librarytrack:a.123')).toBe(
      'x-sonos-http:librarytrack%3aa.123',
    )
  })
})

describe('encodeXml', () => {
  for (const value of ['a & b', '<tag>', 'quote "x"', "apostrophe 'x'", 'plain', '']) {
    it(`matches the library for ${JSON.stringify(value)}`, () => {
      expect(encodeXml(value)).toBe(XmlHelper.EncodeXml(value))
    })
  }
})
