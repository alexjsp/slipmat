/**
 * Which ordering of SetPlayMode / SetAVTransportURI / Play actually shuffles?
 *
 * Activation sets the play mode, points the transport at the queue, then plays
 * — and playback comes out strictly sequential even though the mode reads
 * SHUFFLE. Try the orderings and see which one Sonos honours.
 *
 * Mutates only the named zone: restarts playback on its existing queue, at
 * volume 0.
 */
import { SonosManager } from '@svrooij/sonos'
import { loadConfig } from '../src/config.js'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const config = loadConfig()
const zoneName = arg('zone') ?? 'Alex’s Office'

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

  const queueUri = `x-rincon-queue:${device.Uuid}#0`
  const setMode = (mode: string) =>
    device.AVTransportService.SetPlayMode({ InstanceID: 0, NewPlayMode: mode as never })
  const pointAtQueue = () =>
    device.AVTransportService.SetAVTransportURI({
      InstanceID: 0,
      CurrentURI: queueUri,
      CurrentURIMetaData: '',
    })

  const observe = async (label: string) => {
    const positions: number[] = []
    for (let step = 0; step < 5; step += 1) {
      const info = await device.AVTransportService.GetPositionInfo({ InstanceID: 0 })
      positions.push(info.Track)
      await device.AVTransportService.Next({ InstanceID: 0 })
      await new Promise((resolve) => setTimeout(resolve, 900))
    }
    const sequential = positions.every(
      (position, index) => index === 0 || position === positions[index - 1]! + 1,
    )
    const settings = await device.AVTransportService.GetTransportSettings({ InstanceID: 0 })
    console.log(
      `${sequential ? '❌' : '✅'} ${label}: mode=${settings.PlayMode} positions=${positions.join(', ')}`,
    )
  }

  try {
    const media = await device.AVTransportService.GetMediaInfo({ InstanceID: 0 })
    console.log(`Queue length: ${media.NrTracks}\n`)

    await setMode('NORMAL')
    await setMode('SHUFFLE')
    await pointAtQueue()
    await device.AVTransportService.Play({ InstanceID: 0, Speed: '1' })
    await observe('A  mode → transport → play  (what we ship)')

    await setMode('NORMAL')
    await pointAtQueue()
    await setMode('SHUFFLE')
    await device.AVTransportService.Play({ InstanceID: 0, Speed: '1' })
    await observe('B  transport → mode → play')

    await setMode('NORMAL')
    await pointAtQueue()
    await device.AVTransportService.Play({ InstanceID: 0, Speed: '1' })
    await setMode('SHUFFLE')
    await observe('C  transport → play → mode')
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
