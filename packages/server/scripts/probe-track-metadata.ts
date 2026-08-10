/**
 * Find a metadata shape Sonos will actually *keep* for an enqueued service track.
 *
 * Tracks enqueued from our resolver cache play but show no title anywhere, and
 * the Sonos iOS app reports "No Content" — Sonos accepts the metadata and then
 * discards it. This tries candidate shapes one at a time against a single zone
 * and reads Q:0 back to see which survives.
 *
 * Mutates only the named zone's queue, at volume 0, and refuses a zone that is
 * grouped. It leaves the queue empty when it finishes.
 *
 *   pnpm exec tsx scripts/probe-track-metadata.ts --zone "Alex’s Office"
 */
import { SonosManager } from '@svrooij/sonos'
import { loadConfig } from '../src/config.js'
import { decodeEntities, parseDidl } from '../src/sonos/didl.js'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const config = loadConfig()
const zoneName = arg('zone') ?? 'Alex’s Office'

const DIDL_OPEN =
  '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/"' +
  ' xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"' +
  ' xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/"' +
  ' xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">'

function escapeDocument(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

async function main() {
  const manager = new SonosManager()
  const ok = config.seedIp
    ? await manager.InitializeFromDevice(config.seedIp)
    : await manager.InitializeWithDiscovery(10)
  if (!ok) throw new Error('no devices')

  const first = manager.Devices[0]!
  const device = manager.Devices.find((d) => d.Name === zoneName)
  if (!device) throw new Error(`No zone ${zoneName}`)

  const groups = await first.GetZoneGroupState()
  const group = groups.find((g) => g.members.some((m) => m.uuid === device.Uuid))
  if ((group?.members.filter((m) => !m.Invisible).length ?? 1) > 1) {
    throw new Error(`${zoneName} is grouped — refusing`)
  }

  // The cdudn service token lives on containers, not on expanded queue entries.
  const favouritesRaw = await first.ContentDirectoryService.Browse({
    ObjectID: 'FV:2',
    BrowseFlag: 'BrowseDirectChildren',
    Filter: '*',
    StartingIndex: 0,
    RequestedCount: 200,
    SortCriteria: '',
  })
  const tokens = new Set<string>()
  for (const entry of parseDidl(
    typeof favouritesRaw.Result === 'string' ? favouritesRaw.Result : '',
  )) {
    const resMD = entry.resMD ? decodeEntities(entry.resMD) : ''
    const match = /<desc id="cdudn"[^>]*>([^<]*)<\/desc>/.exec(resMD)
    if (match?.[1]) tokens.add(match[1])
  }
  console.log('cdudn tokens found on favourites:')
  for (const token of tokens) console.log(`  ${token}`)
  const token = [...tokens].find((t) => t.includes('52231')) ?? [...tokens][0]
  if (!token) throw new Error('no cdudn token found on any favourite')
  console.log(`\nUsing: ${token}\n`)

  const uri = 'x-sonos-http:librarytrack%3aa.1440913387.mp4?sid=204&flags=8232&sn=2'
  const itemId = 'librarytrack%3aa.1440913387'
  const title = 'Probe Title'
  const creator = 'Probe Artist'
  const desc = `<desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">${token}</desc>`
  const body =
    `<dc:title>${title}</dc:title>` +
    `<upnp:class>object.item.audioItem.musicTrack</upnp:class>` +
    `<dc:creator>${creator}</dc:creator>`

  const item = (id: string, parentId: string, withDesc: boolean) =>
    escapeDocument(
      `${DIDL_OPEN}<item id="${id}" parentID="${parentId}" restricted="true">${body}${
        withDesc ? desc : ''
      }</item></DIDL-Lite>`,
    )

  const variants: { name: string; metadata: string }[] = [
    { name: 'A queue id, no cdudn (what we ship today)', metadata: item('Q:0/1', 'Q:0', false) },
    { name: 'B queue id + cdudn', metadata: item('Q:0/1', 'Q:0', true) },
    {
      name: 'C 10032020 service id + cdudn',
      metadata: item(`10032020${itemId}`, '10fe2064', true),
    },
    {
      name: 'D 00032020 service id + cdudn',
      metadata: item(`00032020${itemId}`, '00020000', true),
    },
    { name: 'E bare service id + cdudn', metadata: item(itemId, '-1', true) },
  ]

  const originalVolume = (
    await device.RenderingControlService.GetVolume({ InstanceID: 0, Channel: 'Master' })
  ).CurrentVolume
  await device.RenderingControlService.SetVolume({
    InstanceID: 0,
    Channel: 'Master',
    DesiredVolume: 0,
  })

  try {
    for (const variant of variants) {
      await device.AVTransportService.RemoveAllTracksFromQueue()
      try {
        await device.AVTransportService.AddURIToQueue({
          InstanceID: 0,
          EnqueuedURI: uri,
          EnqueuedURIMetaData: variant.metadata,
          DesiredFirstTrackNumberEnqueued: 0,
          EnqueueAsNext: false,
        })
      } catch (err) {
        console.log(`❌ ${variant.name} → ${(err as Error).message}`)
        continue
      }
      const raw = await device.ContentDirectoryService.Browse({
        ObjectID: 'Q:0',
        BrowseFlag: 'BrowseDirectChildren',
        Filter: '*',
        StartingIndex: 0,
        RequestedCount: 1,
        SortCriteria: '',
      })
      const stored = decodeEntities(typeof raw.Result === 'string' ? raw.Result : '')
      const [entry] = parseDidl(stored)
      const keptTitle = entry?.title === title
      const keptToken = stored.includes('cdudn')
      console.log(
        `${keptTitle ? '✅' : '⚠️ '} ${variant.name} → title=${JSON.stringify(
          entry?.title,
        )} creator=${JSON.stringify(entry?.creator)} cdudn=${keptToken}`,
      )
      if (keptTitle) console.log(`     stored: ${stored.replace(/^.*?<item/, '<item')}`)
    }
  } finally {
    await device.AVTransportService.RemoveAllTracksFromQueue().catch(() => undefined)
    await device.RenderingControlService.SetVolume({
      InstanceID: 0,
      Channel: 'Master',
      DesiredVolume: originalVolume,
    })
    console.log(`\nCleaned up; queue emptied, volume restored to ${originalVolume}`)
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌', err.message)
    process.exit(1)
  })
