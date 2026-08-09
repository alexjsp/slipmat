/**
 * Minimal DIDL-Lite reader for browse results.
 *
 * We parse the raw DIDL rather than using the library's parsed `Track[]`
 * because two details matter and are lost in translation:
 *
 *  - `<res>` is percent-encoded (`…libraryplaylist%3ap.ODDB4sx0v5W`). The
 *    library helpfully decodes it, and Sonos then rejects the decoded form.
 *  - `<r:resMD>` carries the container's own metadata, including the
 *    `<desc id="cdudn">SA_RINCON…-Token</desc>` service token. Enqueue a
 *    `x-rincon-cpcontainer:` URI without it and Sonos answers UPnP 800.
 */

export type DidlEntry = {
  id: string
  parentId: string | null
  title: string
  /** XML-entity decoded but never percent-decoded — `%3a` is significant. */
  res: string | null
  protocolInfo: string | null
  upnpClass: string | null
  albumArtUri: string | null
  creator: string | null
  album: string | null
  /**
   * The `r:resMD` block, left XML-entity encoded. The SOAP layer inserts a
   * string `…MetaData` value verbatim, so it has to arrive already encoded —
   * decoding it here produces a UPnP 402.
   */
  resMD: string | null
}

/** Sonos wraps the DIDL in the SOAP body HTML-entity encoded, sometimes twice. */
export function decodeEntities(input: string): string {
  return input
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
}

function tagContent(source: string, tag: string): string | null {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(source)
  return match?.[1] ?? null
}

function attribute(source: string, name: string): string | null {
  const match = new RegExp(`${name}="([^"]*)"`).exec(source)
  return match?.[1] ?? null
}

export function parseDidl(encoded: string): DidlEntry[] {
  const xml = encoded.includes('&lt;') ? decodeEntities(encoded) : encoded
  const entries: DidlEntry[] = []

  // Containers and items are structurally the same for our purposes.
  const pattern = /<(item|container)\s([^>]*)>([\s\S]*?)<\/\1>/g
  let match = pattern.exec(xml)
  while (match) {
    const attrs = match[2] ?? ''
    const body = match[3] ?? ''
    const resBlock = /<res[^>]*>([\s\S]*?)<\/res>/.exec(body)
    const rawResMD = tagContent(body, 'r:resMD')

    entries.push({
      id: attribute(attrs, 'id') ?? '',
      parentId: attribute(attrs, 'parentID'),
      title: decodeEntities(tagContent(body, 'dc:title') ?? ''),
      // XML-entity decoded (so `&amp;` becomes `&`), but never percent-decoded:
      // `%3a` inside a cpcontainer id is part of the identifier, not an escape.
      res: resBlock?.[1] ? decodeEntities(resBlock[1]) : null,
      protocolInfo: resBlock ? attribute(resBlock[0], 'protocolInfo') : null,
      upnpClass: tagContent(body, 'upnp:class'),
      albumArtUri: tagContent(body, 'upnp:albumArtURI'),
      creator: tagContent(body, 'dc:creator'),
      album: tagContent(body, 'upnp:album'),
      resMD: rawResMD,
    })
    match = pattern.exec(xml)
  }

  return entries
}

export function isContainerClass(upnpClass: string | null): boolean {
  if (!upnpClass) return false
  return upnpClass.startsWith('object.container')
}
