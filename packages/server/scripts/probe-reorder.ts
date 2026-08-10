/** How expensive is ReorderTracksInQueue? It decides whether we can shuffle a queue ourselves. */
import { SonosManager } from '@svrooij/sonos'
import { loadConfig } from '../src/config.js'

const config = loadConfig()
const manager = new SonosManager()
await (config.seedIp
  ? manager.InitializeFromDevice(config.seedIp)
  : manager.InitializeWithDiscovery(10))
const d = manager.Devices.find((x) => x.Name === 'Alex’s Office')!
await d.RenderingControlService.SetVolume({ InstanceID: 0, Channel: 'Master', DesiredVolume: 0 })

const media = await d.AVTransportService.GetMediaInfo({ InstanceID: 0 })
const n = media.NrTracks
console.log(`Queue length: ${n}`)

const sizes = [1, 25, 100]
for (const size of sizes) {
  const rounds = 10
  const started = Date.now()
  for (let i = 0; i < rounds; i += 1) {
    const from = 1 + Math.floor(Math.random() * (n - size))
    const to = 1 + Math.floor(Math.random() * (n - size))
    await d.AVTransportService.ReorderTracksInQueue({
      InstanceID: 0,
      StartingIndex: from,
      NumberOfTracks: size,
      InsertBefore: to,
      UpdateID: 0,
    })
  }
  const per = (Date.now() - started) / rounds
  console.log(`  moving blocks of ${size}: ${per.toFixed(0)}ms per call`)
}
const after = await d.AVTransportService.GetMediaInfo({ InstanceID: 0 })
console.log(`Queue length after: ${after.NrTracks}`)
process.exit(0)
