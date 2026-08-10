import { beforeEach, describe, expect, it } from 'vitest'
import { createLogger } from '../logger.js'
import { decodeEntities } from '../sonos/didl.js'
import type { DriverBrowseItem } from '../sonos/driver.js'
import { FakeSonosDriver } from '../sonos/fake-driver.js'
import { SourceResolver } from './resolver.js'

const logger = createLogger({ logLevel: 'error' })

function track(uri: string, title: string): DriverBrowseItem {
  return {
    id: uri,
    title,
    subtitle: 'Some Artist',
    album: null,
    artUrl: null,
    isContainer: false,
    uri,
    metadata: `<DIDL>${title}</DIDL>`,
  }
}

// Everything here runs against the fake household.
describe('SourceResolver', () => {
  let driver: FakeSonosDriver

  beforeEach(async () => {
    driver = new FakeSonosDriver()
    await driver.start()
  })

  const resolver = (allowExpansion: boolean) =>
    new SourceResolver({ driver, logger, allowScratchQueueExpansion: allowExpansion })

  it('resolves a Sonos playlist by browsing it directly', async () => {
    driver.setBrowseResult('SQ:3', [
      track('x-file-cifs://a.flac', 'A'),
      track('x-file-cifs://b.flac', 'B'),
    ])

    const result = await resolver(false).resolve({ kind: 'sonos_playlist', ref: 'SQ:3' })
    expect(result.mode).toBe('tracks')
    expect(result.tracks.map((t) => t.uri)).toEqual([
      'x-file-cifs://a.flac',
      'x-file-cifs://b.flac',
    ])
  })

  it('ignores nested containers when collecting tracks', async () => {
    driver.setBrowseResult('A:ALBUM/Foo', [
      { ...track('x-file-cifs://a.flac', 'A'), isContainer: false },
      { ...track('ignored', 'Sub-container'), isContainer: true },
    ])

    const result = await resolver(false).resolve({ kind: 'library_container', ref: 'A:ALBUM/Foo' })
    expect(result.tracks).toHaveLength(1)
  })

  it('treats a radio favourite as a solo stream, not a track pool', async () => {
    driver.setBrowseResult('FV:2', [
      {
        id: 'FV:2/12',
        title: 'BBC 6 Music',
        subtitle: null,
        album: null,
        artUrl: null,
        isContainer: false,
        uri: 'x-sonosapi-stream:bbc_6music?sid=254',
        metadata: '<DIDL>radio</DIDL>',
      },
    ])

    const result = await resolver(false).resolve({ kind: 'sonos_favorite', ref: 'FV:2/12' })
    expect(result.mode).toBe('stream')
    expect(result.tracks).toEqual([])
    expect(result.containerUri).toBe('x-sonosapi-stream:bbc_6music?sid=254')
  })

  it('carries the container service token onto every expanded track', async () => {
    // Sonos strips the token from the queue entries it expands a container
    // into. Without carrying it across, the tracks play but the Sonos app can
    // only describe them as "No Content".
    const token = 'SA_RINCON52231_X_#Svc52231-decc08f-Token'
    const containerUri = 'x-rincon-cpcontainer:1006206clibraryplaylist%3ap.abc?sid=204&flags=8300'
    driver.setBrowseResult('FV:2', [
      {
        id: 'FV:2/8',
        title: 'Well Rated Music',
        subtitle: null,
        album: null,
        artUrl: null,
        isContainer: false,
        uri: containerUri,
        metadata:
          `&lt;DIDL-Lite&gt;&lt;item&gt;&lt;desc id="cdudn" ` +
          `nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/"&gt;${token}` +
          `&lt;/desc&gt;&lt;/item&gt;&lt;/DIDL-Lite&gt;`,
      },
    ])
    driver.setContainerContents(containerUri, [
      {
        ...track('x-sonos-http:librarytrack%3aa.1440913387.mp4?sid=204&sn=2', 'A Comet Appears'),
        // As Sonos hands it back: queue position for an id, no token.
        id: 'Q:0/1',
      },
    ])

    const result = await resolver(true).resolve({ kind: 'sonos_favorite', ref: 'FV:2/8' })

    expect(result.mode).toBe('tracks')
    const metadata = decodeEntities(result.tracks[0]!.metadata!)
    expect(metadata).toContain(token)
    expect(metadata).toContain('id="10032020librarytrack%3aa.1440913387"')
    expect(metadata).not.toContain('Q:0')
    expect(metadata).toContain('<dc:title>A Comet Appears</dc:title>')
  })

  it('gives Sonos longer than the default to expand a container', async () => {
    // Sonos expands the whole container before it answers, so this call scales
    // with the playlist: a 2,008-track one measured at 44s against real
    // hardware, and the library's fixed 30s turned that into a network timeout
    // reported as "could not be mixed in".
    const containerUri =
      'x-rincon-cpcontainer:1006206cspotify%3aplaylist%3a37i9dQZF1DXcBWIGoYBM5M?sid=9&flags=8300&sn=7'
    driver.setContainerContents(containerUri, [track('x-sonos-spotify:one', 'One')])

    await resolver(true).resolve({
      kind: 'service_url',
      ref: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
    })

    const enqueue = driver.calls.find((call) => call.method === 'addUrisToQueue')
    expect(enqueue?.args[2]).toBeGreaterThan(60_000)
  })

  it('expands a pasted Spotify playlist via the scratch queue', async () => {
    // Exactly what MetaDataHelper builds, query string and all.
    const containerUri =
      'x-rincon-cpcontainer:1006206cspotify%3aplaylist%3a37i9dQZF1DXcBWIGoYBM5M?sid=9&flags=8300&sn=7'
    driver.setContainerContents(containerUri, [
      track('x-sonos-spotify:one', 'One'),
      track('x-sonos-spotify:two', 'Two'),
      track('x-sonos-spotify:three', 'Three'),
    ])

    const result = await resolver(true).resolve({
      kind: 'service_url',
      ref: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
    })

    expect(result.mode).toBe('tracks')
    expect(result.tracks.map((t) => t.uri)).toEqual([
      'x-sonos-spotify:one',
      'x-sonos-spotify:two',
      'x-sonos-spotify:three',
    ])
  })

  it('leaves the borrowed speaker exactly as it found it', async () => {
    // Exactly what MetaDataHelper builds, query string and all.
    const containerUri =
      'x-rincon-cpcontainer:1006206cspotify%3aplaylist%3a37i9dQZF1DXcBWIGoYBM5M?sid=9&flags=8300&sn=7'
    driver.setContainerContents(containerUri, [track('x-sonos-spotify:one', 'One')])

    await resolver(true).resolve({
      kind: 'service_url',
      ref: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
    })

    // Every zone was idle with an empty queue, and must still be.
    for (const zone of driver.snapshot().zones) {
      expect(driver.queueOf(zone.id)).toEqual([])
    }
  })

  it('falls back to container-only when expansion is disabled', async () => {
    const result = await resolver(false).resolve({
      kind: 'service_url',
      ref: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
    })

    expect(result.mode).toBe('container_only')
    expect(result.containerUri).toContain('x-rincon-cpcontainer:')
    expect(result.warning).toMatch(/cannot be mixed/)
  })

  it('never borrows the configured utility zone while it is playing', async () => {
    // This actually happened: a background refresh wiped the queue of the
    // speaker that was mid-song, because a configured zone skipped the check.
    const containerUri =
      'x-rincon-cpcontainer:1006206cspotify%3aplaylist%3a37i9dQZF1DXcBWIGoYBM5M?sid=9&flags=8300&sn=7'
    driver.setContainerContents(containerUri, [track('x-sonos-spotify:one', 'One')])
    driver.setPlaying('RINCON_KITCHEN01400', 'x-rincon-queue:k#0', 'someones-music')

    const pinned = new SourceResolver({
      driver,
      logger,
      allowScratchQueueExpansion: true,
      utilityZoneId: 'RINCON_KITCHEN01400',
    })
    await pinned.resolve({
      kind: 'service_url',
      ref: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
    })

    const clearedKitchen = driver.calls.some(
      (call) => call.method === 'clearQueue' && call.args[0] === 'RINCON_KITCHEN01400',
    )
    expect(clearedKitchen).toBe(false)
  })

  it('never borrows a speaker that is playing', async () => {
    // Occupy every zone, so no utility zone is available.
    for (const zone of driver.snapshot().zones) {
      driver.setPlaying(zone.id, 'x-rincon-queue:x#0', 'x-sonos-spotify:busy')
    }

    const result = await resolver(true).resolve({
      kind: 'service_url',
      ref: 'https://open.spotify.com/album/4uLU6hMCjMI75M1A2tKUQC',
    })

    expect(result.mode).toBe('container_only')
    expect(result.warning).toMatch(/No idle speaker/)
    expect(driver.calls.some((call) => call.method === 'clearQueue')).toBe(false)
  })

  it('resolves a single pasted track without touching any speaker', async () => {
    const result = await resolver(true).resolve({
      kind: 'service_url',
      ref: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC',
    })

    expect(result.mode).toBe('tracks')
    expect(result.tracks).toHaveLength(1)
    expect(driver.calls.some((call) => call.method === 'clearQueue')).toBe(false)
  })

  it('surfaces an actionable error for an unparseable url', async () => {
    await expect(
      resolver(true).resolve({ kind: 'service_url', ref: 'https://example.com/nope' }),
    ).rejects.toThrow(/Spotify or Apple Music/)
  })
})
