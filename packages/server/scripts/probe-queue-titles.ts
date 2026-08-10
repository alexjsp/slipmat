/** Read-only: do the tracks we enqueued carry titles in the device queue? */
import { SonosManager } from '@svrooij/sonos'
import { loadConfig } from '../src/config.js'
import { parseDidl } from '../src/sonos/didl.js'

const config = loadConfig()
const zoneName = process.argv[2] ?? 'Alex’s Office'

async function main() {
  const manager = new SonosManager()
  const ok = config.seedIp
    ? await manager.InitializeFromDevice(config.seedIp)
    : await manager.InitializeWithDiscovery(10)
  if (!ok) throw new Error('no devices')
  const device = manager.Devices.find((d) => d.Name === zoneName)!

  const raw = await device.ContentDirectoryService.Browse({
    ObjectID: 'Q:0',
    BrowseFlag: 'BrowseDirectChildren',
    Filter: '*',
    StartingIndex: 0,
    RequestedCount: 5,
    SortCriteria: '',
  })
  const entries = parseDidl(typeof raw.Result === 'string' ? raw.Result : '')
  console.log(`queue length: ${raw.TotalMatches}`)
  for (const e of entries) {
    console.log(`  title=${JSON.stringify(e.title)} creator=${JSON.stringify(e.creator)}`)
  }
}
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
