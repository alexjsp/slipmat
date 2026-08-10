/**
 * Does re-asserting SHUFFLE re-randomise across a queue that grew underneath it?
 *
 * Activation sets shuffle over the opening source (~25 tracks), starts
 * playback, then fills the rest of the queue behind it and sets shuffle again.
 * If Sonos treats the second call as a no-op, the shuffle order could stay
 * scoped to those first 25 tracks — and a 2,000-track playlist would never be
 * reached at all.
 *
 * Skips through the queue and reports which positions Sonos picks. Positions
 * spread across the whole queue mean the re-assert worked; positions clustered
 * in the low twenties mean it did not.
 *
 * Mutates only the named zone: it skips tracks. Volume is forced to 0.
 */
import { SonosManager } from '@svrooij/sonos'
import { loadConfig } from '../src/config.js'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const config = loadConfig()
const zoneName = arg('zone') ?? 'Alex’s Office'
const skips = Number(arg('skips') ?? '12')

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
    console.log(`Queue length: ${media.NrTracks}`)
    const mode = await device.AVTransportService.GetTransportSettings({ InstanceID: 0 })
    console.log(`Play mode: ${mode.PlayMode}\n`)

    const positions: number[] = []
    for (let index = 0; index < skips; index += 1) {
      const info = await device.AVTransportService.GetPositionInfo({ InstanceID: 0 })
      positions.push(info.Track)
      await device.AVTransportService.Next({ InstanceID: 0 })
      await new Promise((resolve) => setTimeout(resolve, 900))
    }

    console.log(`Queue positions visited: ${positions.join(', ')}`)
    const max = Math.max(...positions)
    const beyondHead = positions.filter((position) => position > 25).length
    console.log(`\nHighest position reached: ${max} of ${media.NrTracks}`)
    console.log(`Positions beyond the opening 25: ${beyondHead}/${positions.length}`)
    console.log(
      beyondHead > 0
        ? '→ shuffle spans the whole queue'
        : '→ shuffle looks confined to the opening source',
    )
  } finally {
    await device.RenderingControlService.SetVolume({
      InstanceID: 0,
      Channel: 'Master',
      DesiredVolume: originalVolume,
    })
    console.log(`\nVolume restored to ${originalVolume}; queue left as it was`)
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌', err.message)
    process.exit(1)
  })
