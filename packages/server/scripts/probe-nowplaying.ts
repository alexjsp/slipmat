/** Read-only: what does the speaker itself say about mute and the current track? */
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

  const mute = await device.RenderingControlService.GetMute({ InstanceID: 0, Channel: 'Master' })
  const vol = await device.RenderingControlService.GetVolume({ InstanceID: 0, Channel: 'Master' })
  console.log('speaker says: muted =', mute.CurrentMute, ' volume =', vol.CurrentVolume)

  const pos = await device.AVTransportService.GetPositionInfo({ InstanceID: 0 })
  console.log('TrackURI:', pos.TrackURI)
  console.log('TrackMetaData type:', typeof pos.TrackMetaData)
  console.log('TrackMetaData:', JSON.stringify(pos.TrackMetaData).slice(0, 300))

  const raw = await device.ContentDirectoryService.Browse({
    ObjectID: 'Q:0',
    BrowseFlag: 'BrowseDirectChildren',
    Filter: '*',
    StartingIndex: 0,
    RequestedCount: 1,
    SortCriteria: '',
  })
  const entries = parseDidl(typeof raw.Result === 'string' ? raw.Result : '')
  console.log('\nQueue item 1 title from raw DIDL:', JSON.stringify(entries[0]?.title))
  console.log('Queue item 1 resMD present?', !!entries[0]?.resMD)
}
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
