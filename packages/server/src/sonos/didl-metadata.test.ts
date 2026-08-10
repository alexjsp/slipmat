import { describe, expect, it } from 'vitest'
import {
  asMetadataDocument,
  buildTrackMetadata,
  decodeEntities,
  extractCdudn,
  parseDidl,
  serviceItemId,
} from './didl.js'

/**
 * Fixture trimmed from a real Q:0 response, after Sonos expanded an Apple Music
 * container onto a scratch zone. Two absences matter, and neither is obvious:
 *
 *  - no `r:resMD`, because a queue entry points at nothing but itself;
 *  - no `<desc id="cdudn">`, because Sonos strips the service token from the
 *    entries it expands. The token has to be carried over from the container.
 */
const QUEUE_DIDL = `&lt;DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/"&gt;&lt;item id="Q:0/1" parentID="Q:0" restricted="true"&gt;&lt;res protocolInfo="sonos.com-http:*:audio/mp4:*" duration="0:03:21"&gt;x-sonos-http:librarytrack%3aa.1440913387.mp4?sid=204&amp;amp;flags=8232&amp;amp;sn=2&lt;/res&gt;&lt;dc:title&gt;A Comet Appears&lt;/dc:title&gt;&lt;dc:creator&gt;The Shins&lt;/dc:creator&gt;&lt;upnp:album&gt;Wincing the Night Away&lt;/upnp:album&gt;&lt;/item&gt;&lt;/DIDL-Lite&gt;`

describe('queue entries', () => {
  const [entry] = parseDidl(QUEUE_DIDL)

  it('keeps the percent-encoded colon Sonos requires', () => {
    // Decoding this is what produced UPnP 402 when re-enqueueing.
    expect(entry?.res).toContain('librarytrack%3aa.1440913387')
    expect(entry?.res).not.toContain('librarytrack:a.1440913387')
  })

  it('resolves the ampersands in the query string', () => {
    expect(entry?.res).toBe('x-sonos-http:librarytrack%3aa.1440913387.mp4?sid=204&flags=8232&sn=2')
  })

  it('has no resMD, unlike a favourite', () => {
    expect(entry?.resMD).toBeNull()
  })

  it('keeps its own element, which is where the descriptive fields come from', () => {
    expect(entry?.raw).toContain('<dc:title>A Comet Appears</dc:title>')
  })

  it('identifies itself by queue position, so it cannot be reused as metadata', () => {
    // Handing this back as EnqueuedURIMetaData is silently ignored by Sonos.
    expect(entry?.id).toBe('Q:0/1')
  })
})

describe('asMetadataDocument', () => {
  const [entry] = parseDidl(QUEUE_DIDL)
  const metadata = asMetadataDocument(entry!.raw)

  it('escapes the document, since the transport inserts it verbatim', () => {
    // Unescaped markup here is rejected as UPnP 402.
    expect(metadata).toContain('&lt;DIDL-Lite')
    expect(metadata).not.toContain('<DIDL-Lite')
  })

  it('carries the title through, so the track does not play as blank', () => {
    expect(metadata).toContain('A Comet Appears')
  })

  it('wraps exactly one document', () => {
    expect(metadata.match(/&lt;DIDL-Lite/g)).toHaveLength(1)
  })
})

const TRACK_URI = 'x-sonos-http:librarytrack%3aa.1440913387.mp4?sid=204&flags=8232&sn=2'
const TOKEN = 'SA_RINCON52231_X_#Svc52231-decc08f-Token'

describe('serviceItemId', () => {
  it('derives the object id from the stream URI', () => {
    expect(serviceItemId(TRACK_URI)).toBe('10032020librarytrack%3aa.1440913387')
  })

  it('keeps %3a encoded, since it is part of the identifier', () => {
    expect(serviceItemId(TRACK_URI)).not.toContain('librarytrack:a.')
  })

  it('declines anything that is not a service stream', () => {
    // A local library track already has usable metadata of its own.
    expect(serviceItemId('x-file-cifs://nas/music/track.flac')).toBeNull()
  })
})

describe('extractCdudn', () => {
  it('reads the token out of an escaped container resMD', () => {
    const resMD = `&lt;desc id="cdudn" nameSpace="urn:x"&gt;${TOKEN}&lt;/desc&gt;`
    expect(extractCdudn(resMD)).toBe(TOKEN)
  })

  it('returns null for a queue entry, which never carries one', () => {
    expect(extractCdudn(parseDidl(QUEUE_DIDL)[0]?.raw)).toBeNull()
  })
})

describe('buildTrackMetadata', () => {
  const metadata = buildTrackMetadata({
    uri: TRACK_URI,
    title: 'Don’t Go Breaking My Heart',
    creator: 'Elton John & Kiki Dee',
    album: 'Rock of the Westies',
    token: TOKEN,
  })!
  // What Sonos sees after the SOAP layer decodes the value once.
  const asSonosSeesIt = decodeEntities(metadata)

  it('identifies the track by service id, not by queue position', () => {
    // A `Q:0/n` id is why Sonos discarded our metadata and showed "No Content".
    expect(asSonosSeesIt).toContain('id="10032020librarytrack%3aa.1440913387"')
    expect(asSonosSeesIt).not.toContain('Q:0')
  })

  it('carries the service token, so the app can resolve the track', () => {
    expect(asSonosSeesIt).toContain(`<desc id="cdudn"`)
    expect(asSonosSeesIt).toContain(TOKEN)
  })

  it('declares itself a music track rather than a bare item', () => {
    expect(asSonosSeesIt).toContain('<upnp:class>object.item.audioItem.musicTrack</upnp:class>')
  })

  it('escapes an ampersand in an artist name exactly once', () => {
    // Doubly escaped on the wire, singly escaped once Sonos decodes the body,
    // literal by the time the DIDL itself is parsed.
    expect(metadata).toContain('Elton John &amp;amp; Kiki Dee')
    expect(parseDidl(asSonosSeesIt)[0]?.creator).toBe('Elton John &amp; Kiki Dee')
  })

  it('omits fields it does not have rather than emitting empty ones', () => {
    const sparse = decodeEntities(buildTrackMetadata({ uri: TRACK_URI })!)
    expect(sparse).not.toContain('<dc:title>')
    expect(sparse).not.toContain('cdudn')
  })

  it('gives up on a URI it cannot derive an id from', () => {
    expect(buildTrackMetadata({ uri: 'x-file-cifs://nas/track.flac', title: 'Local' })).toBeNull()
  })
})

describe('serviceItemId extension handling', () => {
  it('keeps a numeric id when the URI carries no extension', () => {
    // `\.[a-z0-9]+$` would truncate this to `…librarytrack%3aa`.
    expect(serviceItemId('x-sonos-http:librarytrack%3aa.1887686006?sid=204')).toBe(
      '10032020librarytrack%3aa.1887686006',
    )
  })
})
