/**
 * Diagnose why a pasted share URL won't enqueue.
 *
 * Tries several metadata variants against one zone, clearing the queue between
 * each, and reports which Sonos accepts. Mutates the named zone's queue only.
 *
 *   pnpm --filter @slipmat/server exec tsx scripts/probe-enqueue.ts \
 *     --zone "Alex's Office" --url "https://…"
 */
import { MetaDataHelper, SonosManager } from '@svrooij/sonos'
import type { Track as SonosTrack } from '@svrooij/sonos/lib/models/index.js'
import { loadConfig } from '../src/config.js'
import { parseDidl } from '../src/sonos/didl.js'
import { parseServiceUrl } from '../src/sources/service-urls.js'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const config = loadConfig()
const zoneName = arg('zone')
const url = arg('url')
if (!zoneName || !url) throw new Error('--zone and --url are required')

async function main() {
  const manager = new SonosManager()
  const ok = config.seedIp
    ? await manager.InitializeFromDevice(config.seedIp)
    : await manager.InitializeWithDiscovery(10)
  if (!ok) throw new Error('no devices')

  const first = manager.Devices[0]!
  const device = manager.Devices.find((d) => d.Name === zoneName)
  if (!device) {
    throw new Error(`No zone ${zoneName}. Seen: ${manager.Devices.map((d) => d.Name).join(', ')}`)
  }

  const groups = await first.GetZoneGroupState()
  const group = groups.find((g) => g.members.some((m) => m.uuid === device.Uuid))
  const visible = group?.members.filter((m) => !m.Invisible) ?? []
  if (visible.length > 1) throw new Error(`${zoneName} is grouped — refusing to touch it`)

  const originalVolume = (
    await device.RenderingControlService.GetVolume({ InstanceID: 0, Channel: 'Master' })
  ).CurrentVolume
  await device.RenderingControlService.SetVolume({
    InstanceID: 0,
    Channel: 'Master',
    DesiredVolume: 0,
  })

  // Harvest the real service tokens this household uses, rather than guessing.
  const favouritesRaw = await first.ContentDirectoryService.Browse({
    ObjectID: 'FV:2',
    BrowseFlag: 'BrowseDirectChildren',
    Filter: '*',
    StartingIndex: 0,
    RequestedCount: 200,
    SortCriteria: '',
  })
  const favourites = parseDidl(typeof favouritesRaw.Result === 'string' ? favouritesRaw.Result : '')
  const tokens = new Map<string, string>()
  for (const entry of favourites) {
    const match = /<desc id="cdudn"[^>]*>(SA_RINCON(\d+)_[^<]*)<\/desc>/.exec(
      entry.resMD?.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"') ?? '',
    )
    if (match?.[1] && match[2]) tokens.set(match[2], match[1])
  }
  console.log('Household service tokens:')
  for (const [sid, token] of tokens) console.log(`  Svc${sid} -> ${token}`)

  const ref = parseServiceUrl(url)
  const guessed = MetaDataHelper.GuessTrack(ref.uri)
  if (!guessed?.TrackUri) throw new Error('no URI shape')
  console.log(`\nContainer: ${guessed.TrackUri}`)
  console.log(`Guessed CdUdn: ${guessed.CdUdn}`)

  const serviceId = /SA_RINCON(\d+)_/.exec(guessed.CdUdn ?? '')?.[1]
  const realToken = serviceId ? tokens.get(serviceId) : undefined
  console.log(`Household CdUdn for this service: ${realToken ?? '(none found)'}`)

  const withRealToken: SonosTrack = { ...guessed, CdUdn: realToken ?? guessed.CdUdn }

  const variants: { name: string; metadata: SonosTrack | string }[] = [
    {
      name: 'A: metadata as string (TrackToMetaData)',
      metadata: MetaDataHelper.TrackToMetaData(guessed, true, guessed.CdUdn),
    },
    { name: 'B: metadata as Track object (library encodes)', metadata: guessed },
    { name: 'C: Track object with household CdUdn', metadata: withRealToken },
    { name: 'D: empty metadata', metadata: '' },
  ]

  for (const variant of variants) {
    try {
      await device.AVTransportService.RemoveAllTracksFromQueue()
      await device.AVTransportService.AddURIToQueue({
        InstanceID: 0,
        EnqueuedURI: guessed.TrackUri,
        EnqueuedURIMetaData: variant.metadata,
        DesiredFirstTrackNumberEnqueued: 0,
        EnqueueAsNext: false,
      })
      const queue = await device.GetQueue()
      const tracks = typeof queue.Result === 'string' ? [] : queue.Result
      console.log(`\n✅ ${variant.name} → ${tracks.length} tracks`)
      for (const track of tracks.slice(0, 3)) {
        console.log(`     ${track.Title} — ${track.Artist ?? '?'}`)
      }
    } catch (err) {
      console.log(`\n❌ ${variant.name} → ${(err as Error).message}`)
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
