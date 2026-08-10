/** Read-only: every Sonos playlist in the household. */
import { SonosManager } from '@svrooij/sonos'
import { loadConfig } from '../src/config.js'
import { parseDidl } from '../src/sonos/didl.js'

const config = loadConfig()
const manager = new SonosManager()
await (config.seedIp
  ? manager.InitializeFromDevice(config.seedIp)
  : manager.InitializeWithDiscovery(10))
const d = manager.Devices[0]!
let start = 0
for (;;) {
  const page = await d.ContentDirectoryService.Browse({
    ObjectID: 'SQ:',
    BrowseFlag: 'BrowseDirectChildren',
    Filter: '*',
    StartingIndex: start,
    RequestedCount: 100,
    SortCriteria: '',
  })
  const entries = parseDidl(typeof page.Result === 'string' ? page.Result : '')
  for (const e of entries) console.log(`${e.id}\t${e.title}`)
  start += entries.length
  if (entries.length === 0 || start >= page.TotalMatches) {
    console.log(`\n${page.TotalMatches} playlists total`)
    break
  }
}
process.exit(0)
