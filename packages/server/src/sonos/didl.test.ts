import { describe, expect, it } from 'vitest'
import { isContainerClass, parseDidl } from './didl.js'

/**
 * These fixtures are trimmed from real responses off a live household. Each
 * assertion here corresponds to something that actually broke against real
 * hardware, so they're worth keeping exact.
 */
const FAVORITES_DIDL = `&lt;DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/"&gt;&lt;item id="FV:2/31" parentID="FV:2" restricted="false"&gt;&lt;dc:title&gt;Sunday&amp;apos;s Chill Mix&lt;/dc:title&gt;&lt;upnp:class&gt;object.itemobject.item.sonos-favorite&lt;/upnp:class&gt;&lt;res protocolInfo="x-rincon-cpcontainer:*:*:*"&gt;x-rincon-cpcontainer:1006206clibraryplaylist%3ap.ODDB4sx0v5W&lt;/res&gt;&lt;upnp:albumArtURI&gt;http://is1.mzstatic.com/image/thumb/400x400cc.jpeg&lt;/upnp:albumArtURI&gt;&lt;r:resMD&gt;&amp;lt;DIDL-Lite&amp;gt;&amp;lt;item id=&amp;quot;1006206clibraryplaylist%3ap.ODDB4sx0v5W&amp;quot;&amp;gt;&amp;lt;desc id=&amp;quot;cdudn&amp;quot;&amp;gt;SA_RINCON52231_X_#Svc52231-0a1b2c3-Token&amp;lt;/desc&amp;gt;&amp;lt;/item&amp;gt;&amp;lt;/DIDL-Lite&amp;gt;&lt;/r:resMD&gt;&lt;/item&gt;&lt;item id="FV:2/27" parentID="FV:2" restricted="false"&gt;&lt;dc:title&gt;BBC Radio 2&lt;/dc:title&gt;&lt;res protocolInfo="x-sonosapi-stream:*:*:*"&gt;x-sonosapi-stream:s24940?sid=333&amp;amp;flags=8224&amp;amp;sn=19&lt;/res&gt;&lt;/item&gt;&lt;/DIDL-Lite&gt;`

describe('parseDidl', () => {
  const entries = parseDidl(FAVORITES_DIDL)

  it('reads every item', () => {
    expect(entries).toHaveLength(2)
    expect(entries.map((e) => e.id)).toEqual(['FV:2/31', 'FV:2/27'])
  })

  it('decodes titles', () => {
    expect(entries[0]?.title).toBe("Sunday's Chill Mix")
  })

  it('keeps percent-encoding in res, which Sonos treats as significant', () => {
    // Decoding %3a here is what produced UPnP 402 against real hardware.
    expect(entries[0]?.res).toBe('x-rincon-cpcontainer:1006206clibraryplaylist%3ap.ODDB4sx0v5W')
    expect(entries[0]?.res).toContain('%3a')
  })

  it('resolves XML entities in res so query strings are usable', () => {
    expect(entries[1]?.res).toBe('x-sonosapi-stream:s24940?sid=333&flags=8224&sn=19')
  })

  it('leaves resMD XML-encoded, ready to hand straight back to Sonos', () => {
    // The SOAP layer inserts string metadata verbatim, so decoding it here
    // yields UPnP 402. It must still look like markup-in-a-string.
    const resMd = entries[0]?.resMD
    expect(resMd).toContain('&lt;DIDL-Lite&gt;')
    expect(resMd).not.toContain('<DIDL-Lite>')
  })

  it('carries the service token, without which enqueueing returns UPnP 800', () => {
    expect(entries[0]?.resMD).toContain('SA_RINCON52231_X_#Svc52231-0a1b2c3-Token')
  })

  it('reports items with no res at all', () => {
    const [entry] = parseDidl(
      '<DIDL-Lite><container id="SQ:3"><dc:title>Chill Out</dc:title></container></DIDL-Lite>',
    )
    expect(entry?.res).toBeNull()
    expect(entry?.id).toBe('SQ:3')
  })
})

describe('isContainerClass', () => {
  it('distinguishes containers from items', () => {
    expect(isContainerClass('object.container.playlistContainer')).toBe(true)
    expect(isContainerClass('object.item.audioItem.musicTrack')).toBe(false)
    // A favourite is an item that points at a container.
    expect(isContainerClass('object.itemobject.item.sonos-favorite')).toBe(false)
    expect(isContainerClass(null)).toBe(false)
  })
})
