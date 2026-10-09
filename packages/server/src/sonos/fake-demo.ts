import type { DriverBrowseItem, DriverTrack } from './driver.js'
import { FakeSonosDriver } from './fake-driver.js'

/**
 * The household SLIPMAT_FAKE_SONOS boots into: enough to exercise most of the
 * UI, and to take screenshots that look like a house rather than a test.
 *
 * Every name here is invented. Artwork is generated, so nothing is fetched.
 */

const KITCHEN = 'RINCON_KITCHEN01400'
const LIVING = 'RINCON_LIVING01400'
const BEDROOM = 'RINCON_BEDROOM01400'
const OFFICE = 'RINCON_OFFICE01400'

/** Speakers report artwork on themselves; the fake's address stands in. */
const ART_HOST = 'http://192.168.1.100:1400'

type DemoTrack = { title: string; artist: string; album: string }

const PLAYLISTS: { id: string; title: string; tracks: DemoTrack[] }[] = [
  {
    id: 'SQ:1',
    title: 'Sunday Morning',
    tracks: [
      { title: 'Slow Light', artist: 'The Hollow Pines', album: 'Kettle Weather' },
      { title: 'Marmalade Sky', artist: 'June Arbour', album: 'Second Breakfast' },
      { title: 'Open Windows', artist: 'Field Notes', album: 'Open Windows' },
      { title: 'Paper Boats', artist: 'The Hollow Pines', album: 'Kettle Weather' },
      { title: 'Late Riser', artist: 'Mara Quill', album: 'Lie In' },
      { title: 'Crossword', artist: 'June Arbour', album: 'Second Breakfast' },
    ],
  },
  {
    id: 'SQ:2',
    title: 'Chill Out',
    tracks: [
      { title: 'Low Tide', artist: 'Coastal Drift', album: 'Shoreline' },
      { title: 'Neon Rain', artist: 'Velvet Static', album: 'Afterglow' },
      { title: 'Halfway Home', artist: 'Coastal Drift', album: 'Shoreline' },
      { title: 'Soft Focus', artist: 'Lumen', album: 'Soft Focus' },
    ],
  },
  {
    id: 'SQ:3',
    title: 'Dinner Party',
    tracks: [
      { title: 'Candlelight', artist: 'The Supper Club', album: 'Second Helpings' },
      { title: 'Corkscrew', artist: 'Ella Vance Trio', album: 'After Hours' },
      { title: 'Table for Six', artist: 'The Supper Club', album: 'Second Helpings' },
      { title: 'Velvet Hour', artist: 'Ella Vance Trio', album: 'After Hours' },
    ],
  },
  {
    id: 'SQ:4',
    title: 'Throwback Hits',
    tracks: [
      { title: 'Mixtape Summer', artist: 'Cassette Kids', album: 'Side A' },
      { title: 'Rewind', artist: 'Polaroid Hearts', album: 'Instant' },
    ],
  },
  {
    id: 'SQ:5',
    title: 'Christmas Classics',
    tracks: [
      { title: 'Frost on the Glass', artist: 'Holly & The Ivy', album: 'Midwinter' },
      { title: 'Snow Globe', artist: 'Tinsel Town', album: 'Snow Globe' },
    ],
  },
  {
    id: 'SQ:6',
    title: 'Wind Down',
    tracks: [
      { title: 'Lamplight', artist: 'Mara Quill', album: 'Night Owl' },
      { title: 'Quiet Streets', artist: 'Lumen', album: 'Soft Focus' },
    ],
  },
]

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-')
const artFor = (album: string) => `${ART_HOST}/demo-art/${slug(album)}`

function trackItem(playlistId: string, index: number, track: DemoTrack): DriverBrowseItem {
  return {
    id: `${playlistId}/${index}`,
    title: track.title,
    subtitle: track.artist,
    artist: track.artist,
    album: track.album,
    artUrl: artFor(track.album),
    isContainer: false,
    uri: `x-file-cifs://demo/${slug(track.artist)}/${slug(track.title)}.flac`,
    metadata: null,
  }
}

/** A deterministic abstract cover: two-tone gradient and a couple of shapes. */
function cover(path: string): { body: ArrayBuffer; contentType: string } | undefined {
  const name = path.match(/^\/demo-art\/([a-z0-9-]+)$/)?.[1]
  if (!name) return undefined
  // FNV-1a, so similar names still land on well-separated colours.
  let hash = 0x811c9dc5
  for (const char of name) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0
  const hue = hash % 360
  const second = (hue + 40 + (hash % 80)) % 360
  const cx = 150 + (hash % 300)
  const cy = 150 + ((hash >> 8) % 300)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="hsl(${hue} 70% 55%)"/><stop offset="1" stop-color="hsl(${second} 65% 30%)"/>
</linearGradient></defs>
<rect width="600" height="600" fill="url(#g)"/>
<circle cx="${cx}" cy="${cy}" r="${120 + (hash % 90)}" fill="hsl(${second} 80% 75%)" opacity="0.35"/>
<circle cx="${600 - cx}" cy="${600 - cy}" r="${60 + (hash % 50)}" fill="hsl(${hue} 90% 85%)" opacity="0.25"/>
</svg>`
  const bytes = new TextEncoder().encode(svg)
  return { body: bytes.buffer as ArrayBuffer, contentType: 'image/svg+xml' }
}

export function createDemoHousehold(): FakeSonosDriver {
  const fake = new FakeSonosDriver({
    zones: [
      { id: KITCHEN, name: 'Kitchen' },
      { id: LIVING, name: 'Living Room' },
      { id: BEDROOM, name: 'Bedroom' },
      { id: OFFICE, name: 'Office' },
      // Left idle, so the UI's idle-rooms section has something in it.
      { id: 'RINCON_GARDEN01400', name: 'Garden' },
    ],
    tvZoneIds: [LIVING],
    artwork: cover,
  })

  fake.setBrowseResult(
    'SQ:',
    PLAYLISTS.map((playlist) => ({
      id: playlist.id,
      title: playlist.title,
      subtitle: `${playlist.tracks.length} tracks`,
      album: null,
      artUrl: artFor(playlist.tracks[0]!.album),
      isContainer: true,
      uri: null,
      metadata: null,
    })),
  )
  for (const playlist of PLAYLISTS) {
    fake.setBrowseResult(
      playlist.id,
      playlist.tracks.map((track, index) => trackItem(playlist.id, index, track)),
    )
  }
  fake.setBrowseResult('FV:2', [
    {
      id: 'FV:2/1',
      title: 'Riverside Radio',
      subtitle: 'Internet radio',
      album: null,
      artUrl: artFor('riverside-radio'),
      isContainer: false,
      uri: 'x-sonosapi-stream:s1000?sid=254&flags=8224&sn=0',
      metadata: null,
    },
  ])

  void fake.start().then(async () => {
    await fake.joinGroup(KITCHEN, [BEDROOM])
    const [first] = PLAYLISTS
    const track = first!.tracks[1]!
    const nowPlaying: DriverTrack = {
      uri: trackItem(first!.id, 1, track).uri ?? '',
      title: track.title,
      artist: track.artist,
      album: track.album,
      artUrl: artFor(track.album),
      durationSeconds: 244,
    }
    fake.setNowPlaying(KITCHEN, {
      transportUri: `x-rincon-queue:${KITCHEN}#0`,
      track: nowPlaying,
      positionSeconds: 94,
    })
    fake.setNowPlaying(OFFICE, {
      transportUri: 'x-sonosapi-stream:s1000?sid=254&flags=8224&sn=0',
      track: {
        uri: 'x-sonosapi-stream:s1000?sid=254&flags=8224&sn=0',
        title: 'Riverside Radio',
        artist: 'The Afternoon Show',
        album: null,
        artUrl: artFor('riverside-radio'),
        durationSeconds: null,
      },
    })
  })
  return fake
}
