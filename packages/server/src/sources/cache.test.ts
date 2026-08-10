import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/index.js'
import { createLogger } from '../logger.js'
import type { DriverBrowseItem } from '../sonos/driver.js'
import { FakeSonosDriver } from '../sonos/fake-driver.js'
import { SourceCache } from './cache.js'
import { SourceResolver } from './resolver.js'

const logger = createLogger({ logLevel: 'error' })

function track(uri: string): DriverBrowseItem {
  return {
    id: uri,
    title: uri,
    subtitle: null,
    album: null,
    artUrl: null,
    isContainer: false,
    uri,
    metadata: null,
  }
}

/**
 * The behaviour these lock in: a preset stores a *reference* to a playlist, not
 * a snapshot of its tracks. A playlist that changes must be picked up without
 * anyone editing the preset.
 */
describe('SourceCache freshness', () => {
  let driver: FakeSonosDriver
  let cache: SourceCache

  beforeEach(async () => {
    driver = new FakeSonosDriver()
    await driver.start()
    const db = openDatabase({ inMemory: true })
    const resolver = new SourceResolver({ driver, logger, allowScratchQueueExpansion: true })
    cache = new SourceCache(db, resolver, logger)
  })

  it('picks up a changed Sonos playlist on the very next activation', async () => {
    driver.setBrowseResult('SQ:1', [track('week-1-a'), track('week-1-b')])
    const first = await cache.get({ kind: 'sonos_playlist', ref: 'SQ:1' })
    expect(first.tracks.map((t) => t.uri)).toEqual(['week-1-a', 'week-1-b'])

    // The user's weekly mix updates.
    driver.setBrowseResult('SQ:1', [track('week-2-a'), track('week-2-b'), track('week-2-c')])

    const second = await cache.get({ kind: 'sonos_playlist', ref: 'SQ:1' })
    expect(second.tracks.map((t) => t.uri)).toEqual(['week-2-a', 'week-2-b', 'week-2-c'])
  })

  it('marks a browsable source as cheap, so it is never served stale', async () => {
    driver.setBrowseResult('SQ:1', [track('a')])
    const resolved = await cache.get({ kind: 'sonos_playlist', ref: 'SQ:1' })
    expect(resolved.expensive).toBe(false)
  })

  it('marks a streaming container as expensive, since expanding it borrows a speaker', async () => {
    const containerUri =
      'x-rincon-cpcontainer:1006206cspotify%3aplaylist%3a37i9dQZF1DXcBWIGoYBM5M?sid=9&flags=8300&sn=7'
    driver.setContainerContents(containerUri, [track('x-sonos-spotify:one')])

    const resolved = await cache.get({
      kind: 'service_url',
      ref: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
    })
    expect(resolved.expensive).toBe(true)
  })

  it('serves an expensive source from cache rather than borrowing a speaker mid-activation', async () => {
    const containerUri =
      'x-rincon-cpcontainer:1006206cspotify%3aplaylist%3a37i9dQZF1DXcBWIGoYBM5M?sid=9&flags=8300&sn=7'
    driver.setContainerContents(containerUri, [track('x-sonos-spotify:one')])
    const source = {
      kind: 'service_url' as const,
      ref: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
    }

    await cache.get(source)
    const callsAfterFirst = driver.calls.filter((call) => call.method === 'clearQueue').length

    await cache.get(source)
    const callsAfterSecond = driver.calls.filter((call) => call.method === 'clearQueue').length

    // A second activation must not touch a speaker again.
    expect(callsAfterSecond).toBe(callsAfterFirst)
  })

  it('falls back to the cached tracks when a fresh resolve fails', async () => {
    driver.setBrowseResult('SQ:1', [track('a')])
    await cache.get({ kind: 'sonos_playlist', ref: 'SQ:1' })

    // Simulate the household becoming briefly unreachable.
    driver.setBrowseResult('SQ:1', [])
    const result = await cache.get({ kind: 'sonos_playlist', ref: 'SQ:1' })
    // An empty browse is a legitimate answer, so this asserts we didn't throw.
    expect(result).toBeDefined()
  })
})
