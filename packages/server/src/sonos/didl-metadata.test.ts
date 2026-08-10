import { describe, expect, it } from 'vitest'
import { asMetadataDocument, parseDidl } from './didl.js'

/**
 * Fixture trimmed from a real Q:0 response. Queue entries differ from
 * favourites in a way that matters: they carry no `r:resMD`, because the entry
 * itself is the metadata.
 */
const QUEUE_DIDL = `&lt;DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/"&gt;&lt;item id="Q:0/1" parentID="Q:0" restricted="true"&gt;&lt;res protocolInfo="sonos.com-http:*:audio/mp4:*" duration="0:03:21"&gt;x-sonos-http:librarytrack%3aa.1440913387.mp4?sid=204&amp;amp;flags=8232&amp;amp;sn=2&lt;/res&gt;&lt;dc:title&gt;A Comet Appears&lt;/dc:title&gt;&lt;dc:creator&gt;The Shins&lt;/dc:creator&gt;&lt;upnp:album&gt;Wincing the Night Away&lt;/upnp:album&gt;&lt;desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/"&gt;SA_RINCON52231_X_#Svc52231-decc08f-Token&lt;/desc&gt;&lt;/item&gt;&lt;/DIDL-Lite&gt;`

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

  it('keeps its own element so it can be handed back as metadata', () => {
    expect(entry?.raw).toContain('<dc:title>A Comet Appears</dc:title>')
    expect(entry?.raw).toContain('cdudn')
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

  it('carries the service token through', () => {
    expect(metadata).toContain('SA_RINCON52231_X_#Svc52231-decc08f-Token')
  })

  it('wraps exactly one document', () => {
    expect(metadata.match(/&lt;DIDL-Lite/g)).toHaveLength(1)
  })
})
