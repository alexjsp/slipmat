/**
 * Make Sonos actually shuffle: does starting the queue at a random track do it?
 *
 * Setting SHUFFLE and pressing play leaves playback strictly sequential, even
 * though the mode reads back as SHUFFLE. The Sonos app's shuffle button does
 * more than set a mode — it starts the queue somewhere random. Try that.
 *
 * Mutates only the named zone: restarts playback on its existing queue, seeks,
 * and lets tracks roll over. Volume forced to 0.
 */
import { SonosManager } from '@svrooij/sonos'
import { loadConfig } from '../src/config.js'
import { parseDuration } from '../src/sonos/time.js'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const config = loadConfig()
const zoneName = arg('zone') ?? 'Alex’s Office'

function hhmmss(seconds: number): string {
  const clamped = Math.max(0, Math.floor(seconds))
  return `${Math.floor(clamped / 3600)}:${String(Math.floor((clamped % 3600) / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`
}

async function main() {
  const manager = new SonosManager()
  const ok = config.seedIp
    ? await manager.InitializeFromDevice(config.seedIp)
    : await manager.InitializeWithDiscovery(10)
  if (!ok) throw new Error('no devices')
  const device = manager.Devices.find((d) => d.Name === zoneName)
  if (!device) throw new Error(`No zone ${zoneName}`)

  const originalVolume = (
    await device.RenderingControlService.GetVolume({ InstanceID: 0, Channel: 'Master' })
  ).CurrentVolume
  await device.RenderingControlService.SetVolume({
    InstanceID: 0,
    Channel: 'Master',
    DesiredVolume: 0,
  })

  try {
    const media = await device.AVTransportService.GetMediaInfo({ InstanceID: 0 })
    const length = media.NrTracks
    console.log(`Queue length: ${length}\n`)

    // Start somewhere random, the way the app's shuffle button does.
    const start = 1 + Math.floor(Math.random() * length)
    await device.AVTransportService.SetPlayMode({ InstanceID: 0, NewPlayMode: 'SHUFFLE' as never })
    await device.AVTransportService.SetAVTransportURI({
      InstanceID: 0,
      CurrentURI: `x-rincon-queue:${device.Uuid}#0`,
      CurrentURIMetaData: '',
    })
    await device.AVTransportService.Seek({
      InstanceID: 0,
      Unit: 'TRACK_NR',
      Target: String(start),
    })
    await device.AVTransportService.Play({ InstanceID: 0, Speed: '1' })
    await new Promise((resolve) => setTimeout(resolve, 1500))

    const landed = await device.AVTransportService.GetPositionInfo({ InstanceID: 0 })
    console.log(`Asked to start at ${start}, landed on ${landed.Track}\n`)

    for (let round = 0; round < 3; round += 1) {
      const before = await device.AVTransportService.GetPositionInfo({ InstanceID: 0 })
      const duration = parseDuration(before.TrackDuration) ?? 0
      if (duration < 5) break
      await device.AVTransportService.Seek({
        InstanceID: 0,
        Unit: 'REL_TIME',
        Target: hhmmss(duration - 3),
      })
      await new Promise((resolve) => setTimeout(resolve, 7000))
      const after = await device.AVTransportService.GetPositionInfo({ InstanceID: 0 })
      console.log(
        `  ${before.Track} → ${after.Track} ${after.Track - before.Track === 1 ? '(sequential)' : '(jumped)'}`,
      )
    }
  } finally {
    await device.RenderingControlService.SetVolume({
      InstanceID: 0,
      Channel: 'Master',
      DesiredVolume: originalVolume,
    })
    console.log(`\nVolume restored to ${originalVolume}`)
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌', err.message)
    process.exit(1)
  })
