/** Read-only: dump the raw DIDL Sonos stored for the first queue entries. */
import { SonosManager } from '@svrooij/sonos'
import { loadConfig } from '../src/config.js'
import { decodeEntities } from '../src/sonos/didl.js'

const config = loadConfig()
const zoneName = process.argv[2] ?? 'Alex’s Office'

async function main() {
  const manager = new SonosManager()
  const ok = config.seedIp
    ? await manager.InitializeFromDevice(config.seedIp)
    : await manager.InitializeWithDiscovery(10)
  if (!ok) throw new Error('no devices')
  const device = manager.Devices.find((d) => d.Name === zoneName)
  if (!device) throw new Error(`no zone ${zoneName}: ${manager.Devices.map((d) => d.Name)}`)

  const raw = await device.ContentDirectoryService.Browse({
    ObjectID: 'Q:0',
    BrowseFlag: 'BrowseDirectChildren',
    Filter: '*',
    StartingIndex: 0,
    RequestedCount: 3,
    SortCriteria: '',
  })
  const result = typeof raw.Result === 'string' ? raw.Result : ''
  console.log(`queue length: ${raw.TotalMatches}\n`)
  console.log(decodeEntities(result))

  const position = await device.AVTransportService.GetPositionInfo({ InstanceID: 0 })
  console.log('\n--- GetPositionInfo TrackMetaData ---')
  console.log(
    typeof position.TrackMetaData === 'string'
      ? decodeEntities(position.TrackMetaData)
      : JSON.stringify(position.TrackMetaData),
  )
  console.log('\nTrackURI:', position.TrackURI)
}
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
