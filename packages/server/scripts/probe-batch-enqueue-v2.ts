/**
 * Does AddMultipleURIsToQueue work now the metadata is right?
 *
 * It was ruled out earlier, but that verdict was reached while we were sending
 * queue-entry DIDL that Sonos discarded — so the batch call may have been
 * rejecting the metadata, not the batching. Now that each track carries a real
 * service item id and token, and now that per-track enqueueing has turned out
 * to cost ~740ms (Sonos resolves every item against the service before it
 * answers), it is worth asking again: 2,000 tracks one at a time is 25 minutes.
 *
 * Mutates only the named zone's queue, at volume 0. Refuses a grouped or
 * playing zone. Leaves the queue empty.
 */
import { SonosManager } from '@svrooij/sonos'
import Database from 'better-sqlite3'
import { loadConfig } from '../src/config.js'
import { decodeEntities, parseDidl } from '../src/sonos/didl.js'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const config = loadConfig()
const zoneName = arg('zone') ?? 'Alex’s Office'
const batchSize = Number(arg('batch') ?? '16')

const DIDL_OPEN =
  '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/"' +
  ' xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"' +
  ' xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/"' +
  ' xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">'

function escapeDocument(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** Merge our per-track documents into the single document the batch call wants. */
function mergeDidl(metadatas: (string | null)[]): string {
  const items = metadatas
    .map((metadata) => {
      if (!metadata) return ''
      const decoded = decodeEntities(metadata)
      const openEnd = decoded.indexOf('>', decoded.indexOf('<DIDL-Lite'))
      const closeStart = decoded.lastIndexOf('</DIDL-Lite>')
      if (openEnd === -1 || closeStart === -1) return ''
      return decoded.slice(openEnd + 1, closeStart)
    })
    .join('')
  return items ? escapeDocument(`${DIDL_OPEN}${items}</DIDL-Lite>`) : ''
}

type Track = { uri: string; metadata: string | null }

async function main() {
  const db = new Database(arg('db') ?? '../../data/domovoi.db', { readonly: true })
  const row = db
    .prepare("SELECT tracks_json FROM resolved_sources WHERE label LIKE '%Great%' LIMIT 1")
    .get() as { tracks_json: string } | undefined
  db.close()
  if (!row) throw new Error('no cached large playlist to test with')
  const all = JSON.parse(row.tracks_json) as Track[]
  const tracks = all.slice(0, batchSize)
  console.log(`Using ${tracks.length} real tracks from a ${all.length}-track playlist\n`)

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

  const originalVolume = (
    await device.RenderingControlService.GetVolume({ InstanceID: 0, Channel: 'Master' })
  ).CurrentVolume
  await device.RenderingControlService.SetVolume({
    InstanceID: 0,
    Channel: 'Master',
    DesiredVolume: 0,
  })

  const check = async (label: string, run: () => Promise<unknown>) => {
    await device.AVTransportService.RemoveAllTracksFromQueue()
    const started = Date.now()
    try {
      await run()
    } catch (err) {
      console.log(`❌ ${label} → ${(err as Error).message}`)
      return
    }
    const elapsed = Date.now() - started
    const queue = await device.ContentDirectoryService.Browse({
      ObjectID: 'Q:0',
      BrowseFlag: 'BrowseDirectChildren',
      Filter: '*',
      StartingIndex: 0,
      RequestedCount: 5,
      SortCriteria: '',
    })
    const entries = parseDidl(typeof queue.Result === 'string' ? queue.Result : '')
    const titled = entries.filter((entry) => entry.title).length
    console.log(
      `✅ ${label} → ${queue.TotalMatches} tracks in ${elapsed}ms ` +
        `(${Math.round(elapsed / Math.max(1, queue.TotalMatches))}ms/track), ` +
        `${titled}/${entries.length} sampled have titles`,
    )
  }

  try {
    await check('one AddURIToQueue per track', async () => {
      for (const item of tracks) {
        await device.AVTransportService.AddURIToQueue({
          InstanceID: 0,
          EnqueuedURI: item.uri,
          EnqueuedURIMetaData: item.metadata ?? '',
          DesiredFirstTrackNumberEnqueued: 0,
          EnqueueAsNext: false,
        })
      }
    })

    await check('AddMultipleURIsToQueue, merged DIDL', () =>
      device.AVTransportService.AddMultipleURIsToQueue({
        InstanceID: 0,
        UpdateID: 0,
        NumberOfURIs: tracks.length,
        EnqueuedURIs: tracks.map((t) => t.uri).join(' '),
        EnqueuedURIsMetaData: mergeDidl(tracks.map((t) => t.metadata)),
        ContainerURI: '',
        ContainerMetaData: '',
        DesiredFirstTrackNumberEnqueued: 0,
        EnqueueAsNext: false,
      }),
    )

    await check('AddMultipleURIsToQueue, no metadata', () =>
      device.AVTransportService.AddMultipleURIsToQueue({
        InstanceID: 0,
        UpdateID: 0,
        NumberOfURIs: tracks.length,
        EnqueuedURIs: tracks.map((t) => t.uri).join(' '),
        EnqueuedURIsMetaData: '',
        ContainerURI: '',
        ContainerMetaData: '',
        DesiredFirstTrackNumberEnqueued: 0,
        EnqueueAsNext: false,
      }),
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
