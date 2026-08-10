/**
 * The bits of SOAP encoding we have to do ourselves.
 *
 * Almost every call goes through `@svrooij/sonos`, which handles this. One does
 * not: enqueueing a large container needs a longer timeout than the library's
 * fixed 30s, so that request is built by hand. These reproduce the library's
 * encoding exactly, so the two paths put identical bytes on the wire — the
 * library's own helper is not importable (`XmlHelper` is a default export of an
 * internal CJS module, and is not re-exported from the package root).
 */

/** XML entity encoding, matching `html-entities` at level `xml`. */
export function encodeXml(value: string): string {
  if (!value) return ''
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/**
 * Encode a URI for a `…URI` SOAP argument.
 *
 * The colon rewriting is the part that matters and the part that looks wrong:
 * everything after the scheme has its colons percent-encoded, because a service
 * identifier like `librarytrack:a.123` is a single opaque token to Sonos and a
 * bare colon there is read as structure.
 */
export function encodeTrackUri(uri: string): string {
  if (uri.startsWith('http')) return encodeURI(uri)
  // Home-theatre and mp3 radio URIs are passed through untouched by the
  // library, and Sonos rejects them if they are encoded.
  if (uri.startsWith('x-sonos-hta') || uri.startsWith('x-rincon-mp3radio')) return uri

  if (uri.startsWith('x-rincon-playlist:')) {
    const slash = uri.indexOf('/')
    return (
      uri.slice(0, slash) +
      encodeXml(uri.slice(slash)).replaceAll(':', '%3a').replaceAll(' ', '%20')
    )
  }

  const afterScheme = uri.indexOf(':') + 1
  return uri.slice(0, afterScheme) + encodeXml(uri.slice(afterScheme)).replaceAll(':', '%3a')
}

/** Wrap an action body in the SOAP envelope Sonos expects. */
export function soapEnvelope(service: string, action: string, body: string): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"' +
    ' s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>' +
    `<u:${action} xmlns:u="urn:schemas-upnp-org:service:${service}:1">${body}</u:${action}>` +
    `</s:Body></s:Envelope>`
  )
}
