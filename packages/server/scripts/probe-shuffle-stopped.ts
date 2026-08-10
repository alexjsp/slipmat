/** Does SHUFFLE take effect when playback starts from a full stop? */
import { SonosManager } from '@svrooij/sonos'
import { loadConfig } from '../src/config.js'
import { parseDuration } from '../src/sonos/time.js'

const config = loadConfig()
const manager = new SonosManager()
await (config.seedIp
  ? manager.InitializeFromDevice(config.seedIp)
  : manager.InitializeWithDiscovery(10))
const d = manager.Devices.find((x) => x.Name === 'Alex’s Office')!
await d.RenderingControlService.SetVolume({ InstanceID: 0, Channel: 'Master', DesiredVolume: 0 })

const starts: number[] = []
for (let attempt = 0; attempt < 3; attempt += 1) {
  await d.AVTransportService.Stop({ InstanceID: 0 }).catch(() => undefined)
  await d.AVTransportService.SetPlayMode({ InstanceID: 0, NewPlayMode: 'SHUFFLE' as never })
  await d.AVTransportService.SetAVTransportURI({
    InstanceID: 0,
    CurrentURI: `x-rincon-queue:${d.Uuid}#0`,
    CurrentURIMetaData: '',
  })
  await d.AVTransportService.Play({ InstanceID: 0, Speed: '1' })
  await new Promise((r) => setTimeout(r, 2000))
  const info = await d.AVTransportService.GetPositionInfo({ InstanceID: 0 })
  starts.push(info.Track)
  console.log(`start ${attempt + 1}: track ${info.Track}`)
}
console.log(
  starts.every((s) => s === 1)
    ? '-> always track 1: shuffle does not pick a start'
    : '-> start varies: shuffle is choosing',
)

const before = await d.AVTransportService.GetPositionInfo({ InstanceID: 0 })
const dur = parseDuration(before.TrackDuration) ?? 0
if (dur > 5) {
  const t = Math.floor(dur - 3)
  await d.AVTransportService.Seek({
    InstanceID: 0,
    Unit: 'REL_TIME',
    Target: `0:${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`,
  })
  await new Promise((r) => setTimeout(r, 7000))
  const after = await d.AVTransportService.GetPositionInfo({ InstanceID: 0 })
  console.log(`natural transition: ${before.Track} -> ${after.Track}`)
}
process.exit(0)
