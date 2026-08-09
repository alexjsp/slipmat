/**
 * Read-only probe: dump the raw DIDL Sonos stores for a favourite.
 *
 * Sonos rejects an enqueue of a `x-rincon-cpcontainer:` URI unless it is given
 * that container's real metadata (the `r:resMD` block), which carries the
 * service token. This prints it so we can confirm what has to be passed through.
 */
import { SonosManager } from '@svrooij/sonos'
import { loadConfig } from '../src/config.js'

const config = loadConfig()
const favoriteId = process.argv[2] ?? 'FV:2/31'

async function main() {
  const manager = new SonosManager()
  const ok = config.seedIp
    ? await manager.InitializeFromDevice(config.seedIp)
    : await manager.InitializeWithDiscovery(10)
  if (!ok) throw new Error('no devices')

  const device = manager.Devices[0]!
  const response = await device.ContentDirectoryService.Browse({
    ObjectID: 'FV:2',
    BrowseFlag: 'BrowseDirectChildren',
    Filter: '*',
    StartingIndex: 0,
    RequestedCount: 100,
    SortCriteria: '',
  })

  const encoded = typeof response.Result === 'string' ? response.Result : ''
  // Sonos returns the DIDL HTML-entity encoded inside the SOAP body.
  const raw = encoded
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
  console.log(`Raw DIDL length: ${raw.length}`)

  // Items are <item id="FV:2/31" …>…</item>; find the one we asked about.
  const pattern = new RegExp(`<item id="${favoriteId}"[\\s\\S]*?</item>`, 'g')
  const match = pattern.exec(raw)
  if (!match) {
    console.log(`No item ${favoriteId} found. First 600 chars:\n${raw.slice(0, 600)}`)
    process.exit(1)
  }
  console.log(`\n--- ${favoriteId} ---\n${match[0]}`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌', err.message)
    process.exit(1)
  })
