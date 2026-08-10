/**
 * Find a working shape for AddMultipleURIsToQueue.
 *
 * Tries variants against one named zone, clearing the queue between each, and
 * reports which Sonos accepts. Mutates only that zone's queue, at volume 0.
 *
 *   pnpm --filter @domovoi/server exec tsx scripts/probe-enqueue-batch.ts --zone "Alex's Office"
 */
import { SonosManager } from '@svrooij/sonos'
import Database from 'better-sqlite3'
import { loadConfig } from '../src/config.js'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const config = loadConfig()
const zoneName = arg('zone')
if (!zoneName) throw new Error('--zone is required')

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

const DIDL_OPEN =
  '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/"' +
  ' xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"' +
  ' xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/"' +
  ' xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">'

function mergeDidl(metadatas: (string | null | undefined)[]): string {
  const items = metadatas
    .map((metadata) => {
      if (!metadata) return ''
      const openEnd = metadata.indexOf('>', metadata.indexOf('<DIDL-Lite'))
      const closeStart = metadata.lastIndexOf('</DIDL-Lite>')
      if (openEnd === -1 || closeStart === -1) return ''
      return metadata.slice(openEnd + 1, closeStart)
    })
    .join('')
  return items ? `${DIDL_OPEN}${items}</DIDL-Lite>` : ''
}

type Track = { uri: string; metadata: string | null }

async function main() {
  // Real tracks straight from the resolver cache.
  const dbPath = arg('db') ?? '../../data/domovoi.db'
  const db = new Database(dbPath, { readonly: true })
  const row = db.prepare('SELECT tracks_json FROM resolved_sources LIMIT 1').get() as {
    tracks_json: string
  }
  const tracks = (JSON.parse(row.tracks_json) as Track[]).slice(0, 3)
  db.close()
  console.log(`Using ${tracks.length} real tracks; first URI:\n  ${tracks[0]?.uri}\n`)

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

  const variants: { name: string; run: () => Promise<unknown> }[] = [
    {
      name: 'A: escaped URIs + merged DIDL',
      run: () =>
        device.AVTransportService.AddMultipleURIsToQueue({
          InstanceID: 0,
          UpdateID: 0,
          NumberOfURIs: tracks.length,
          EnqueuedURIs: xmlEscape(tracks.map((t) => t.uri).join(' ')),
          EnqueuedURIsMetaData: xmlEscape(mergeDidl(tracks.map((t) => t.metadata))),
          ContainerURI: '',
          ContainerMetaData: '',
          DesiredFirstTrackNumberEnqueued: 0,
          EnqueueAsNext: false,
        }),
    },
    {
      name: 'B: escaped URIs + empty metadata',
      run: () =>
        device.AVTransportService.AddMultipleURIsToQueue({
          InstanceID: 0,
          UpdateID: 0,
          NumberOfURIs: tracks.length,
          EnqueuedURIs: xmlEscape(tracks.map((t) => t.uri).join(' ')),
          EnqueuedURIsMetaData: '',
          ContainerURI: '',
          ContainerMetaData: '',
          DesiredFirstTrackNumberEnqueued: 0,
          EnqueueAsNext: false,
        }),
    },
    {
      name: 'C: unescaped URIs + empty metadata',
      run: () =>
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
    },
    {
      name: 'D: DesiredFirstTrackNumberEnqueued = 1',
      run: () =>
        device.AVTransportService.AddMultipleURIsToQueue({
          InstanceID: 0,
          UpdateID: 0,
          NumberOfURIs: tracks.length,
          EnqueuedURIs: xmlEscape(tracks.map((t) => t.uri).join(' ')),
          EnqueuedURIsMetaData: xmlEscape(mergeDidl(tracks.map((t) => t.metadata))),
          ContainerURI: '',
          ContainerMetaData: '',
          DesiredFirstTrackNumberEnqueued: 1,
          EnqueueAsNext: false,
        }),
    },
    {
      name: 'E: one AddURIToQueue per track (known-good shape)',
      run: async () => {
        for (const track of tracks) {
          await device.AVTransportService.AddURIToQueue({
            InstanceID: 0,
            EnqueuedURI: track.uri,
            EnqueuedURIMetaData: track.metadata ?? '',
            DesiredFirstTrackNumberEnqueued: 0,
            EnqueueAsNext: false,
          })
        }
      },
    },
  ]

  for (const variant of variants) {
    try {
      await device.AVTransportService.RemoveAllTracksFromQueue()
      const started = Date.now()
      await variant.run()
      const elapsed = Date.now() - started
      const queue = await device.GetQueue()
      const count = typeof queue.Result === 'string' ? 0 : queue.Result.length
      console.log(`✅ ${variant.name} → ${count} tracks in ${elapsed}ms`)
    } catch (err) {
      console.log(`❌ ${variant.name} → ${(err as Error).message}`)
    }
  }

  await device.AVTransportService.RemoveAllTracksFromQueue().catch(() => undefined)
  await device.RenderingControlService.SetVolume({
    InstanceID: 0,
    Channel: 'Master',
    DesiredVolume: originalVolume,
  })
  console.log(`\nCleaned up; volume restored to ${originalVolume}`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌', err.message)
    process.exit(1)
  })
