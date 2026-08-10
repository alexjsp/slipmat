/**
 * Is `Track` from GetPositionInfo the queue index, or a playback counter?
 *
 * It decides how to read the shuffle-scope probe: sequential Track numbers mean
 * playback is sequential only if Track really is the queue index. Compare the
 * URI Sonos says it is playing against the queue entry at that index.
 *
 * Read-only apart from skipping tracks on the named zone, at volume 0.
 */
import { SonosManager } from '@svrooij/sonos'
import { loadConfig } from '../src/config.js'
import { parseDidl } from '../src/sonos/didl.js'
import { trackIdentity } from '../src/sonos/uris.js'

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

  const entryAt = async (position: number) => {
    const page = await device.ContentDirectoryService.Browse({
      ObjectID: 'Q:0',
      BrowseFlag: 'BrowseDirectChildren',
      Filter: '*',
      StartingIndex: position - 1,
      RequestedCount: 1,
      SortCriteria: '',
    })
    return parseDidl(typeof page.Result === 'string' ? page.Result : '')[0]
  }

  try {
    for (let step = 0; step < 6; step += 1) {
      const info = await device.AVTransportService.GetPositionInfo({ InstanceID: 0 })
      const playingUri =
        typeof info.TrackMetaData === 'object' && info.TrackMetaData
          ? (info.TrackMetaData as { TrackUri?: string }).TrackUri
          : undefined
      const entry = await entryAt(info.Track)
      const same = trackIdentity(playingUri) === trackIdentity(entry?.res)
      console.log(
        `Track ${info.Track}: playing ${JSON.stringify(
          (info.TrackMetaData as { Title?: string })?.Title,
        )}, queue[${info.Track}] is ${JSON.stringify(entry?.title)} → ${
          same ? 'SAME (Track is the queue index)' : 'DIFFERENT (Track is a playback counter)'
        }`,
      )
      await device.AVTransportService.Next({ InstanceID: 0 })
      await new Promise((resolve) => setTimeout(resolve, 1200))
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
