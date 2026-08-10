/**
 * Measure the container-at-a-time approach to filling a queue.
 *
 * Instead of expanding every source into tracks and enqueueing them one by one
 * (~780ms each, so 26 minutes for a 2,000-track playlist), hand Sonos each
 * container and let it do the expansion itself — one SOAP call per source.
 * Then dedupe the resulting queue, and let Sonos' own shuffle mode interleave
 * across the whole thing.
 *
 * Reports the cost of each stage: enqueue per container, reading the queue back,
 * and removing duplicates.
 *
 * Mutates only the named zone's queue, at volume 0. Refuses a grouped zone.
 *
 *   pnpm exec tsx scripts/probe-container-queue.ts --zone "Alex’s Office"
 */
import { SonosManager } from '@svrooij/sonos'
import { loadConfig } from '../src/config.js'
import { parseDidl } from '../src/sonos/didl.js'
import { encodeTrackUri, soapEnvelope } from '../src/sonos/soap.js'
import { trackIdentity } from '../src/sonos/uris.js'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const config = loadConfig()
const zoneName = arg('zone') ?? 'Alex’s Office'
const favouriteIds = (arg('favorites') ?? 'FV:2/8,FV:2/51,FV:2/7,FV:2/92').split(',')

async function soap(host: string, action: string, body: string, timeoutMs: number) {
  const response = await fetch(`http://${host}:1400/MediaRenderer/AVTransport/Control`, {
    method: 'POST',
    headers: {
      SOAPAction: `"urn:schemas-upnp-org:service:AVTransport:1#${action}"`,
      'Content-type': 'text/xml; charset=utf8',
    },
    body: soapEnvelope('AVTransport', action, body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  if (!response.ok) {
    const code = /<errorCode>(\d+)<\/errorCode>/.exec(text)?.[1]
    throw new Error(`${action} failed: UPnP ${code ?? response.status}`)
  }
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

  const favouritesRaw = await first.ContentDirectoryService.Browse({
    ObjectID: 'FV:2',
    BrowseFlag: 'BrowseDirectChildren',
    Filter: '*',
    StartingIndex: 0,
    RequestedCount: 200,
    SortCriteria: '',
  })
  const favourites = parseDidl(typeof favouritesRaw.Result === 'string' ? favouritesRaw.Result : '')
  const sources = favouriteIds.map((id) => {
    const entry = favourites.find((candidate) => candidate.id === id)
    if (!entry?.res) throw new Error(`No favourite ${id}`)
    return entry
  })

  const originalVolume = (
    await device.RenderingControlService.GetVolume({ InstanceID: 0, Channel: 'Master' })
  ).CurrentVolume
  await device.RenderingControlService.SetVolume({
    InstanceID: 0,
    Channel: 'Master',
    DesiredVolume: 0,
  })

  const readQueue = async () => {
    const entries = []
    let start = 0
    for (;;) {
      const page = await device.ContentDirectoryService.Browse({
        ObjectID: 'Q:0',
        BrowseFlag: 'BrowseDirectChildren',
        Filter: '*',
        StartingIndex: start,
        RequestedCount: 1000,
        SortCriteria: '',
      })
      const pageEntries = parseDidl(typeof page.Result === 'string' ? page.Result : '')
      entries.push(...pageEntries)
      start += pageEntries.length
      if (pageEntries.length === 0 || start >= page.TotalMatches) break
    }
    return entries
  }

  try {
    await device.AVTransportService.RemoveAllTracksFromQueue()

    console.log('Enqueueing each container:\n')
    let firstPlayableAt = 0
    const overall = Date.now()
    for (const [index, source] of sources.entries()) {
      const started = Date.now()
      await soap(
        device.Host,
        'AddURIToQueue',
        '<InstanceID>0</InstanceID>' +
          `<EnqueuedURI>${encodeTrackUri(source.res!)}</EnqueuedURI>` +
          `<EnqueuedURIMetaData>${source.resMD ?? ''}</EnqueuedURIMetaData>` +
          '<DesiredFirstTrackNumberEnqueued>0</DesiredFirstTrackNumberEnqueued>' +
          '<EnqueueAsNext>0</EnqueueAsNext>',
        10 * 60 * 1000,
      )
      const elapsed = Date.now() - started
      if (index === 0) firstPlayableAt = Date.now() - overall
      const queue = await device.ContentDirectoryService.Browse({
        ObjectID: 'Q:0',
        BrowseFlag: 'BrowseDirectChildren',
        Filter: '*',
        StartingIndex: 0,
        RequestedCount: 1,
        SortCriteria: '',
      })
      console.log(
        `  ${source.title}: ${(elapsed / 1000).toFixed(1)}s → queue now ${queue.TotalMatches}`,
      )
    }
    const totalEnqueueMs = Date.now() - overall
    console.log(
      `\nAll containers queued in ${(totalEnqueueMs / 1000).toFixed(1)}s; ` +
        `playback could have started after ${(firstPlayableAt / 1000).toFixed(1)}s`,
    )

    const readStarted = Date.now()
    const entries = await readQueue()
    console.log(`\nRead ${entries.length} entries back in ${Date.now() - readStarted}ms`)

    // Find duplicates by item identity, keeping the first of each.
    const seen = new Set<string>()
    const duplicateIndexes: number[] = []
    entries.forEach((entry, index) => {
      const identity = trackIdentity(entry.res)
      if (!identity) return
      if (seen.has(identity)) duplicateIndexes.push(index)
      else seen.add(identity)
    })
    console.log(`Duplicates: ${duplicateIndexes.length}`)

    if (duplicateIndexes.length > 0) {
      // Remove back to front so earlier indexes stay valid.
      const sample = duplicateIndexes.slice(-10).reverse()
      const removeStarted = Date.now()
      for (const index of sample) {
        await soap(
          device.Host,
          'RemoveTrackFromQueue',
          '<InstanceID>0</InstanceID>' +
            `<ObjectID>Q:0/${index + 1}</ObjectID>` +
            '<UpdateID>0</UpdateID>',
          30_000,
        )
      }
      const per = (Date.now() - removeStarted) / sample.length
      console.log(
        `Removed ${sample.length} duplicates at ${per.toFixed(0)}ms each ` +
          `→ all ${duplicateIndexes.length} would take ${((per * duplicateIndexes.length) / 1000).toFixed(1)}s`,
      )
    }

    const shuffleStarted = Date.now()
    await soap(
      device.Host,
      'SetPlayMode',
      '<InstanceID>0</InstanceID><NewPlayMode>SHUFFLE</NewPlayMode>',
      30_000,
    )
    console.log(`\nSetPlayMode(SHUFFLE) took ${Date.now() - shuffleStarted}ms`)

    const final = await readQueue()
    const titled = final.filter((entry) => entry.title).length
    console.log(`Final queue: ${final.length} tracks, ${titled} with titles`)
    console.log(
      `First three: ${final
        .slice(0, 3)
        .map((e) => e.title)
        .join(' | ')}`,
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
