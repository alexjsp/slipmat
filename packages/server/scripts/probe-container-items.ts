/**
 * Read-only: how does Sonos itself identify service tracks inside a container?
 *
 * Queue entries are renamed to `Q:0/n` and stripped of their service token, so
 * they are no use as a template for re-enqueueing. A Sonos playlist (`SQ:`) or
 * an imported-library container keeps the canonical form.
 */
import { SonosManager } from '@svrooij/sonos'
import { loadConfig } from '../src/config.js'
import { decodeEntities } from '../src/sonos/didl.js'

const config = loadConfig()

async function browse(device: { ContentDirectoryService: any }, objectId: string, count = 3) {
  const raw = await device.ContentDirectoryService.Browse({
    ObjectID: objectId,
    BrowseFlag: 'BrowseDirectChildren',
    Filter: '*',
    StartingIndex: 0,
    RequestedCount: count,
    SortCriteria: '',
  })
  return {
    total: raw.TotalMatches,
    xml: decodeEntities(typeof raw.Result === 'string' ? raw.Result : ''),
  }
}

async function main() {
  const manager = new SonosManager()
  const ok = config.seedIp
    ? await manager.InitializeFromDevice(config.seedIp)
    : await manager.InitializeWithDiscovery(10)
  if (!ok) throw new Error('no devices')
  const device = manager.Devices[0]!

  const playlists = await browse(device, 'SQ:', 20)
  console.log('=== SQ: (Sonos playlists) ===')
  console.log(playlists.xml.slice(0, 2000))

  const ids = [...playlists.xml.matchAll(/<container id="(SQ:\d+)"/g)].map((m) => m[1]!)
  for (const id of ids.slice(0, 3)) {
    const items = await browse(device, id, 2)
    console.log(`\n=== ${id} children (${items.total}) ===`)
    console.log(items.xml.slice(0, 2500))
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
