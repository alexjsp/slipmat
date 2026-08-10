/**
 * How long does Sonos need to expand a very large playlist, and how much of it
 * comes back?
 *
 * The library hard-codes a 30s SOAP timeout, which a playlist of a few thousand
 * tracks blows straight through — the enqueue is reported as a network timeout
 * and the source is written off as unexpandable. This issues the same call with
 * no such limit and times it, then pages the whole queue back.
 *
 * Mutates only the named zone's queue, at volume 0, and refuses a zone that is
 * grouped or playing. Leaves the queue empty.
 *
 *   pnpm exec tsx scripts/probe-big-playlist.ts --zone "Alex’s Office" --favorite "Alex’s Great Music"
 */
import { SonosManager } from '@svrooij/sonos'
import { loadConfig } from '../src/config.js'
import { decodeEntities, parseDidl } from '../src/sonos/didl.js'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const config = loadConfig()
const zoneName = arg('zone') ?? 'Alex’s Office'
const favouriteTitle = arg('favorite') ?? 'Alex’s Great Music'

function envelope(action: string, body: string): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>` +
    `<u:${action} xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">${body}</u:${action}>` +
    `</s:Body></s:Envelope>`
  )
}

/** The same SOAP call the library makes, without its 30s ceiling. */
async function addUriToQueue(host: string, uri: string, metadata: string, timeoutMs: number) {
  const body =
    `<InstanceID>0</InstanceID>` +
    `<EnqueuedURI>${uri.replaceAll('&', '&amp;')}</EnqueuedURI>` +
    `<EnqueuedURIMetaData>${metadata}</EnqueuedURIMetaData>` +
    `<DesiredFirstTrackNumberEnqueued>0</DesiredFirstTrackNumberEnqueued>` +
    `<EnqueueAsNext>0</EnqueueAsNext>`
  const response = await fetch(`http://${host}:1400/MediaRenderer/AVTransport/Control`, {
    method: 'POST',
    headers: {
      SOAPAction: '"urn:schemas-upnp-org:service:AVTransport:1#AddURIToQueue"',
      'Content-type': 'text/xml; charset=utf8',
    },
    body: envelope('AddURIToQueue', body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 400)}`)
  return text
}

async function main() {
  const manager = new SonosManager()
  const ok = config.seedIp
    ? await manager.InitializeFromDevice(config.seedIp)
    : await manager.InitializeWithDiscovery(10)
  if (!ok) throw new Error('no devices')

  const first = manager.Devices[0]!
  const device = manager.Devices.find((d) => d.Name === zoneName)
  if (!device) throw new Error(`No zone ${zoneName}`)

  const groups = await first.GetZoneGroupState()
  const group = groups.find((g) => g.members.some((m) => m.uuid === device.Uuid))
  if ((group?.members.filter((m) => !m.Invisible).length ?? 1) > 1) {
    throw new Error(`${zoneName} is grouped — refusing`)
  }
  const transport = await device.AVTransportService.GetTransportInfo({ InstanceID: 0 })
  if (transport.CurrentTransportState === 'PLAYING') {
    throw new Error(`${zoneName} is playing — refusing`)
  }

  const favouritesRaw = await first.ContentDirectoryService.Browse({
    ObjectID: 'FV:2',
    BrowseFlag: 'BrowseDirectChildren',
    Filter: '*',
    StartingIndex: 0,
    RequestedCount: 200,
    SortCriteria: '',
  })
  const favourite = parseDidl(
    typeof favouritesRaw.Result === 'string' ? favouritesRaw.Result : '',
  ).find((entry) => entry.title === favouriteTitle)
  if (!favourite?.res) throw new Error(`No favourite titled "${favouriteTitle}"`)
  console.log(`Container: ${favourite.res}\n`)

  const originalVolume = (
    await device.RenderingControlService.GetVolume({ InstanceID: 0, Channel: 'Master' })
  ).CurrentVolume
  await device.RenderingControlService.SetVolume({
    InstanceID: 0,
    Channel: 'Master',
    DesiredVolume: 0,
  })

  try {
    await device.AVTransportService.RemoveAllTracksFromQueue()

    const started = Date.now()
    await addUriToQueue(device.Host, favourite.res, favourite.resMD ?? '', 10 * 60 * 1000)
    const enqueueMs = Date.now() - started
    console.log(`AddURIToQueue took ${(enqueueMs / 1000).toFixed(1)}s (library gives up at 30s)\n`)

    // Page the whole thing: one Browse never returns thousands of entries.
    let start = 0
    let total = 0
    let fetched = 0
    const pageStarted = Date.now()
    for (;;) {
      const page = await device.ContentDirectoryService.Browse({
        ObjectID: 'Q:0',
        BrowseFlag: 'BrowseDirectChildren',
        Filter: '*',
        StartingIndex: start,
        RequestedCount: 1000,
        SortCriteria: '',
      })
      total = page.TotalMatches
      const entries = parseDidl(typeof page.Result === 'string' ? page.Result : '')
      fetched += entries.length
      console.log(`  page at ${start}: ${entries.length} entries (total reported ${total})`)
      if (entries.length === 0) break
      start += entries.length
      if (start >= total) break
    }
    console.log(
      `\nPaged ${fetched} of ${total} tracks in ${((Date.now() - pageStarted) / 1000).toFixed(1)}s`,
    )

    const sample = await device.ContentDirectoryService.Browse({
      ObjectID: 'Q:0',
      BrowseFlag: 'BrowseDirectChildren',
      Filter: '*',
      StartingIndex: 0,
      RequestedCount: 1,
      SortCriteria: '',
    })
    const [entry] = parseDidl(
      decodeEntities(typeof sample.Result === 'string' ? sample.Result : ''),
    )
    console.log(
      `\nFirst entry: ${JSON.stringify(entry?.title)} — ${JSON.stringify(entry?.creator)}`,
    )
  } finally {
    await device.AVTransportService.RemoveAllTracksFromQueue().catch(() => undefined)
    await device.RenderingControlService.SetVolume({
      InstanceID: 0,
      Channel: 'Master',
      DesiredVolume: originalVolume,
    })
    console.log(`\nCleaned up; queue emptied, volume restored to ${originalVolume}`)
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌', err.message)
    process.exit(1)
  })
