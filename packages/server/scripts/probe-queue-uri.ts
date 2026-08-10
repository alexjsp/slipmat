/**
 * Compare the URI Sonos actually stores in a queue with the one we send back.
 *
 * Expands a favourite onto one zone (volume 0), reads the raw Q:0 DIDL, and
 * prints the exact <res> value alongside what our pipeline produced.
 */
import { SonosManager } from '@svrooij/sonos'
import Database from 'better-sqlite3'
import { loadConfig } from '../src/config.js'
import { parseDidl } from '../src/sonos/didl.js'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const config = loadConfig()
const zoneName = arg('zone')
const favouriteId = arg('favorite') ?? 'FV:2/8'
if (!zoneName) throw new Error('--zone is required')

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

  const originalVolume = (
    await device.RenderingControlService.GetVolume({ InstanceID: 0, Channel: 'Master' })
  ).CurrentVolume
  await device.RenderingControlService.SetVolume({
    InstanceID: 0,
    Channel: 'Master',
    DesiredVolume: 0,
  })

  try {
    // Put real service tracks in the queue via the path that works.
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
    ).find((entry) => entry.id === favouriteId)
    if (!favourite?.res) throw new Error(`No favourite ${favouriteId}`)

    await device.AVTransportService.RemoveAllTracksFromQueue()
    await device.AVTransportService.AddURIToQueue({
      InstanceID: 0,
      EnqueuedURI: favourite.res,
      EnqueuedURIMetaData: favourite.resMD ?? '',
      DesiredFirstTrackNumberEnqueued: 0,
      EnqueueAsNext: false,
    })

    // Raw, unparsed — the library's parser decodes res, which is the suspicion.
    const raw = await device.ContentDirectoryService.Browse({
      ObjectID: 'Q:0',
      BrowseFlag: 'BrowseDirectChildren',
      Filter: '*',
      StartingIndex: 0,
      RequestedCount: 2,
      SortCriteria: '',
    })
    const entries = parseDidl(typeof raw.Result === 'string' ? raw.Result : '')
    console.log(`Queue has ${raw.TotalMatches} tracks.\n`)
    console.log('What Sonos stores (raw <res>):')
    console.log(`  ${entries[0]?.res}`)

    // What the library's parsed path gives us, which is what we cached.
    const parsed = await device.GetQueue()
    const parsedTracks = typeof parsed.Result === 'string' ? [] : parsed.Result
    console.log('\nWhat the library hands us (parsed TrackUri):')
    console.log(`  ${parsedTracks[0]?.TrackUri}`)

    const db = new Database(arg('db') ?? '../../data/slipmat.db', { readonly: true })
    const row = db.prepare('SELECT tracks_json FROM resolved_sources LIMIT 1').get() as
      | { tracks_json: string }
      | undefined
    db.close()
    if (row) {
      const cached = JSON.parse(row.tracks_json) as { uri: string }[]
      console.log('\nWhat we cached and send back:')
      console.log(`  ${cached[0]?.uri}`)
    }

    console.log('\nIdentical?', entries[0]?.res === parsedTracks[0]?.TrackUri)
  } finally {
    await device.AVTransportService.RemoveAllTracksFromQueue().catch(() => undefined)
    await device.RenderingControlService.SetVolume({
      InstanceID: 0,
      Channel: 'Master',
      DesiredVolume: originalVolume,
    })
    console.log(`\nCleaned up; volume restored to ${originalVolume}`)
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌', err.message)
    process.exit(1)
  })
