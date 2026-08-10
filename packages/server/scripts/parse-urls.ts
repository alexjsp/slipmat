/**
 * Read-only: show how pasted share URLs map onto Sonos URIs.
 *
 * Touches no speakers — purely parsing plus MetaDataHelper's URI construction.
 * Useful for triaging "why won't this link work?" before involving hardware.
 *
 *   pnpm --filter @domovoi/server exec tsx scripts/parse-urls.ts <url> [url…]
 */
import { MetaDataHelper } from '@svrooij/sonos'
import { parseServiceUrl } from '../src/sources/service-urls.js'

const urls = process.argv.slice(2)
if (urls.length === 0) {
  console.error('Pass one or more share URLs.')
  process.exit(1)
}

for (const url of urls) {
  console.log(`\n${url}`)
  try {
    const ref = parseServiceUrl(url)
    const guessed = MetaDataHelper.GuessTrack(ref.uri)
    console.log(`  parsed:    ${ref.service} ${ref.kind} (${ref.id})`)
    console.log(`  canonical: ${ref.uri}`)
    console.log(`  sonos uri: ${guessed?.TrackUri ?? '❌ no URI shape for this service/kind'}`)
  } catch (err) {
    console.log(`  ❌ ${(err as Error).message}`)
  }
}
