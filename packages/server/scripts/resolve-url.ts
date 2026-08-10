/**
 * End-to-end check of the real SourceResolver against a live household.
 *
 * Unlike probe-enqueue.ts (which pokes the UPnP layer directly), this exercises
 * the code path an actual preset uses. Borrows the named zone's queue for the
 * expansion and restores it.
 *
 *   pnpm --filter @slipmat/server exec tsx scripts/resolve-url.ts \
 *     --zone "Alex's Office" --url "https://…"
 */
import { loadConfig } from '../src/config.js'
import { createLogger } from '../src/logger.js'
import { RealSonosDriver } from '../src/sonos/real-driver.js'
import { SourceResolver } from '../src/sources/resolver.js'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const config = loadConfig()
const logger = createLogger({ logLevel: 'warn' })
const zoneName = arg('zone')
const urls = process.argv.filter((value) => value.startsWith('http'))
if (!zoneName || urls.length === 0) throw new Error('--zone and at least one URL are required')

async function main() {
  const driver = new RealSonosDriver({ logger, seedIp: config.seedIp })
  await driver.start()

  const snapshot = driver.snapshot()
  const zone = snapshot.zones.find((z) => z.name === zoneName)
  if (!zone)
    throw new Error(`No zone ${zoneName}. Seen: ${snapshot.zones.map((z) => z.name).join(', ')}`)

  const group = snapshot.groups.find((g) => g.memberZoneIds.includes(zone.id))
  if (group && group.memberZoneIds.length > 1) throw new Error(`${zoneName} is grouped — refusing`)
  if (group?.transportState === 'PLAYING') throw new Error(`${zoneName} is playing — refusing`)

  const originalVolume = zone.volume
  await driver.setVolume(zone.id, 0)

  const resolver = new SourceResolver({
    driver,
    logger,
    utilityZoneId: zone.id,
    allowScratchQueueExpansion: true,
  })

  try {
    for (const url of urls) {
      console.log(`\n${url}`)
      try {
        const result = await resolver.resolve({ kind: 'service_url', ref: url })
        const icon = result.mode === 'tracks' ? '✅' : '⚠️ '
        console.log(`  ${icon} ${result.mode} — ${result.tracks.length} tracks — "${result.label}"`)
        if (result.warning) console.log(`     ${result.warning}`)
        for (const track of result.tracks.slice(0, 3)) {
          console.log(`     ${track.title ?? track.uri}${track.artist ? ` — ${track.artist}` : ''}`)
        }
      } catch (err) {
        console.log(`  ❌ ${(err as Error).message}`)
      }
    }
  } finally {
    await driver.clearQueue(zone.id).catch(() => undefined)
    await driver.setVolume(zone.id, originalVolume).catch(() => undefined)
    console.log(`\nCleaned up; ${zoneName} volume restored to ${originalVolume}`)
    await driver.stop()
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌', err.message)
    process.exit(1)
  })
