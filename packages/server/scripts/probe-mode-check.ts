import { SonosManager } from '@svrooij/sonos'
import { loadConfig } from '../src/config.js'

const config = loadConfig()
const manager = new SonosManager()
await (config.seedIp
  ? manager.InitializeFromDevice(config.seedIp)
  : manager.InitializeWithDiscovery(10))
const d = manager.Devices.find((x) => x.Name === 'Alex’s Office')!
const groups = await manager.Devices[0]!.GetZoneGroupState()
const g = groups.find((gr) => gr.members.some((m) => m.uuid === d.Uuid))
console.log(
  'coordinator:',
  g?.coordinator?.uuid,
  'this device:',
  d.Uuid,
  'members:',
  g?.members.length,
)
for (const mode of ['NORMAL', 'SHUFFLE_NOREPEAT', 'SHUFFLE', 'REPEAT_ALL']) {
  await d.AVTransportService.SetPlayMode({ InstanceID: 0, NewPlayMode: mode as never })
  const s = await d.AVTransportService.GetTransportSettings({ InstanceID: 0 })
  console.log(`set ${mode} -> reads back ${s.PlayMode}`)
}
const media = await d.AVTransportService.GetMediaInfo({ InstanceID: 0 })
console.log('transport uri:', media.CurrentURI, 'tracks:', media.NrTracks)
process.exit(0)
