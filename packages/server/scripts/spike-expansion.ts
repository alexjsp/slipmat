/**
 * M3 validation: does scratch-queue expansion actually work on a real system?
 *
 * ⚠️ This is the one script in the repo that touches real speakers. It requires
 * an explicit --zone, defaults to read-only recon, and only mutates when
 * --expand is passed with a container URL.
 *
 *   pnpm --filter @domovoi/server exec tsx scripts/spike-expansion.ts --recon
 *   pnpm --filter @domovoi/server exec tsx scripts/spike-expansion.ts \
 *     --zone "Alex's Office" --expand "https://open.spotify.com/playlist/…" --silent
 *
 * --silent sets the zone's volume to 0 for the duration and restores it after,
 * so nothing is audible in the room.
 */

import { MetaDataHelper } from '@svrooij/sonos'
import { loadConfig } from '../src/config.js'
import { createLogger } from '../src/logger.js'
import { RealSonosDriver } from '../src/sonos/real-driver.js'
import { parseServiceUrl } from '../src/sources/service-urls.js'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

const config = loadConfig()
const logger = createLogger({ logLevel: 'warn' })

async function main() {
  const driver = new RealSonosDriver({ logger, seedIp: config.seedIp })
  console.log('Discovering…')
  await driver.start()

  const snapshot = driver.snapshot()
  console.log(`\nZones (${snapshot.zones.length}):`)
  for (const zone of snapshot.zones) {
    const group = snapshot.groups.find((g) => g.memberZoneIds.includes(zone.id))
    console.log(
      `  ${zone.name.padEnd(22)} vol=${String(zone.volume).padStart(3)} ` +
        `${group?.transportState ?? '?'} ${group?.coordinatorZoneId === zone.id ? '(coordinator)' : ''}`,
    )
  }

  const services = await driver.listMusicServices()
  console.log(`\nMusic services: ${services.map((s) => `${s.name}(${s.id})`).join(', ') || 'none'}`)

  for (const [label, objectId] of [
    ['Favourites', 'FV:2'],
    ['Sonos playlists', 'SQ:'],
    ['Albums', 'A:ALBUM'],
  ] as const) {
    try {
      const page = await driver.browse(objectId, { count: 10 })
      console.log(`\n${label} (${page.total} total, first ${page.items.length}):`)
      for (const item of page.items) {
        console.log(`  ${item.id.padEnd(10)} ${item.title}`)
        if (objectId === 'FV:2') console.log(`             -> ${item.uri ?? '(no uri)'}`)
      }
    } catch (err) {
      console.log(`\n${label}: browse failed — ${(err as Error).message}`)
    }
  }

  const browsePath = arg('browse')
  if (browsePath) {
    const page = await driver.browse(browsePath, { count: 15 })
    console.log(`\nBrowse ${browsePath} (${page.total} total):`)
    for (const item of page.items) {
      console.log(`  ${item.title}${item.isContainer ? ' [container]' : ''}`)
      console.log(`    uri: ${item.uri ?? '(none)'}`)
    }
  }

  const favoriteId = arg('favorite')
  const expandUrl = arg('expand') ?? favoriteId
  if (!expandUrl) {
    console.log('\nRecon only — no --expand given, nothing was modified.')
    await driver.stop()
    return
  }

  const zoneName = arg('zone')
  if (!zoneName) throw new Error('--expand requires --zone "Room Name"')
  const zone = snapshot.zones.find((z) => z.name === zoneName)
  if (!zone)
    throw new Error(
      `No zone named ${zoneName}. Seen: ${snapshot.zones.map((z) => z.name).join(', ')}`,
    )

  const group = snapshot.groups.find((g) => g.memberZoneIds.includes(zone.id))
  if (group && group.transportState === 'PLAYING') {
    throw new Error(`${zoneName} is playing right now — refusing to touch it.`)
  }
  // Permission for this zone is conditional on it being on its own: borrowing a
  // grouped speaker would disturb whatever the rest of the group is doing.
  if (group && group.memberZoneIds.length > 1) {
    const others = group.memberZoneIds
      .filter((id) => id !== zone.id)
      .map((id) => snapshot.zones.find((z) => z.id === id)?.name ?? id)
    throw new Error(
      `${zoneName} is grouped with ${others.join(', ')} — refusing to touch a grouped speaker.`,
    )
  }

  // A favourite carries the exact res + resMD Sonos needs; prefer those.
  let favoriteRes: string | null = null
  let favoriteResMd: string | null = null
  if (favoriteId) {
    const favorites = await driver.browse('FV:2', { count: 200 })
    const favorite = favorites.items.find((item) => item.id === favoriteId)
    if (!favorite) throw new Error(`No favourite ${favoriteId}`)
    favoriteRes = favorite.uri
    favoriteResMd = favorite.metadata
    console.log(`\nFavourite: ${favorite.title}`)
  }

  // Either a pasted share URL, or a raw container URI taken from a favourite.
  const isRawUri = !!favoriteId || (expandUrl.includes(':') && !expandUrl.startsWith('http'))
  const containerUri = favoriteRes
    ? favoriteRes
    : isRawUri
      ? expandUrl
      : (() => {
          const ref = parseServiceUrl(expandUrl)
          const guessed = MetaDataHelper.GuessTrack(ref.uri)
          if (!guessed?.TrackUri)
            throw new Error(`No Sonos URI shape for ${ref.service} ${ref.kind}`)
          return guessed.TrackUri
        })()
  const containerMetadata = favoriteResMd
    ? favoriteResMd
    : isRawUri
      ? ''
      : MetaDataHelper.TrackToMetaData(
          MetaDataHelper.GuessTrack(parseServiceUrl(expandUrl).uri),
          true,
        )

  console.log(`\nExpanding on "${zoneName}" (${zone.id})`)
  console.log(`  container: ${containerUri}`)

  const originalVolume = zone.volume
  const silent = flag('silent')

  try {
    if (silent) {
      console.log(`  muting (volume ${originalVolume} -> 0)`)
      await driver.setVolume(zone.id, 0)
    }

    const before = await driver.getQueue(zone.id)
    console.log(`  queue before: ${before.length} tracks`)

    await driver.clearQueue(zone.id)
    await driver.addUrisToQueue(zone.id, [{ uri: containerUri, metadata: containerMetadata }])

    const expanded = await driver.getQueue(zone.id)
    console.log(`\n  ✅ expanded into ${expanded.length} tracks:`)
    for (const item of expanded.slice(0, 8)) {
      console.log(`     ${item.title} — ${item.subtitle ?? '?'}`)
      console.log(`       ${item.uri}`)
    }
    if (expanded.length > 8) console.log(`     … and ${expanded.length - 8} more`)
  } finally {
    console.log('\n  cleaning up…')
    await driver.clearQueue(zone.id).catch((err) => console.log(`  clear failed: ${err.message}`))
    if (silent) {
      await driver
        .setVolume(zone.id, originalVolume)
        .catch((err) => console.log(`  volume restore failed: ${err.message}`))
      console.log(`  volume restored to ${originalVolume}`)
    }
    await driver.stop()
  }
}

// UPnP subscriptions keep the event loop alive even after stop(), so exit hard.
main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n❌', err.message)
    process.exit(1)
  })
