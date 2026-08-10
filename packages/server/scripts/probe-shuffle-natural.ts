/**
 * Does shuffle show up on a natural track change?
 *
 * `Next` appears to walk the queue by position whatever the play mode, so it
 * cannot tell us whether shuffle is working. Seek to the last couple of seconds
 * of the current track and let it roll over on its own instead.
 *
 * Mutates only the named zone: seeks and lets tracks change, at volume 0.
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
const rounds = Number(arg('rounds') ?? '4')

function hhmmss(seconds: number): string {
  const clamped = Math.max(0, Math.floor(seconds))
  const h = Math.floor(clamped / 3600)
  const m = Math.floor((clamped % 3600) / 60)
  const s = clamped % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
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
    const settings = await device.AVTransportService.GetTransportSettings({ InstanceID: 0 })
    const media = await device.AVTransportService.GetMediaInfo({ InstanceID: 0 })
    console.log(`Play mode: ${settings.PlayMode}, queue length: ${media.NrTracks}\n`)

    await device.AVTransportService.Play({ InstanceID: 0, Speed: '1' }).catch(() => undefined)

    const jumps: string[] = []
    for (let round = 0; round < rounds; round += 1) {
      const before = await device.AVTransportService.GetPositionInfo({ InstanceID: 0 })
      const duration = parseDuration(before.TrackDuration) ?? 0
      if (duration < 5) {
        console.log('  (no duration; skipping round)')
        continue
      }
      await device.AVTransportService.Seek({
        InstanceID: 0,
        Unit: 'REL_TIME',
        Target: hhmmss(duration - 3),
      })
      await new Promise((resolve) => setTimeout(resolve, 7000))
      const after = await device.AVTransportService.GetPositionInfo({ InstanceID: 0 })
      const delta = after.Track - before.Track
      jumps.push(`${before.Track} → ${after.Track}`)
      console.log(
        `  ${before.Track} → ${after.Track} (${delta === 1 ? 'next in queue' : 'jumped'})`,
      )
    }

    const jumped = jumps.filter((jump) => {
      const [from, to] = jump.split(' → ').map(Number)
      return to! - from! !== 1
    }).length
    console.log(
      `\n${jumped}/${jumps.length} transitions jumped → ${
        jumped > 0 ? 'shuffle IS working' : 'shuffle is NOT working'
      }`,
    )
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
