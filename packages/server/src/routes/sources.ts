import type { BrowseItem, BrowseResponse, ResolveUrlResponse, SourceKind } from '@slipmat/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { SonosDriver } from '../sonos/driver.js'
import { isRadioStream } from '../sonos/uris.js'
import { ROOT_OBJECT_IDS, type SourceResolver } from '../sources/resolver.js'
import { ServiceNotConnectedError, UnsupportedServiceUrlError } from '../sources/service-urls.js'

export type SourceRoutesDeps = {
  driver: SonosDriver
  resolver: SourceResolver
}

const browseQuerySchema = z.object({
  path: z.string().default(''),
  start: z.coerce.number().int().min(0).default(0),
  count: z.coerce.number().int().min(1).max(500).default(200),
})

const resolveBodySchema = z.object({ url: z.string().min(1) })

/** The top level is ours, not Sonos' — Sonos has no single browsable root. */
const ROOTS: { id: string; title: string; kind: SourceKind }[] = [
  { id: ROOT_OBJECT_IDS.favorites, title: 'Favourites', kind: 'sonos_favorite' },
  { id: ROOT_OBJECT_IDS.playlists, title: 'Sonos Playlists', kind: 'sonos_playlist' },
  { id: ROOT_OBJECT_IDS.albums, title: 'Albums', kind: 'library_container' },
  { id: ROOT_OBJECT_IDS.artists, title: 'Artists', kind: 'library_container' },
  { id: ROOT_OBJECT_IDS.genres, title: 'Genres', kind: 'library_container' },
]

function kindForPath(path: string): SourceKind {
  if (path.startsWith('FV:')) return 'sonos_favorite'
  if (path.startsWith('SQ:')) return 'sonos_playlist'
  if (path.startsWith('A:')) return 'library_container'
  return 'raw_uri'
}

export async function registerSourceRoutes(
  app: FastifyInstance,
  { driver, resolver }: SourceRoutesDeps,
) {
  app.get('/api/sources/browse', async (request, reply) => {
    const query = browseQuerySchema.parse(request.query)

    if (query.path === '') {
      const response: BrowseResponse = {
        path: '',
        breadcrumbs: [],
        items: ROOTS.map((root) => ({
          id: root.id,
          title: root.title,
          subtitle: null,
          artUrl: null,
          isContainer: true,
          kind: root.kind,
          isStream: false,
        })),
        total: ROOTS.length,
      }
      return response
    }

    try {
      const page = await driver.browse(query.path, { start: query.start, count: query.count })
      const kind = kindForPath(query.path)
      const items: BrowseItem[] = page.items.map((item) => ({
        id: item.id,
        title: item.title,
        subtitle: item.subtitle,
        artUrl: null,
        isContainer: item.isContainer,
        kind,
        // Radio can only ever be a solo preset source; the editor enforces that.
        isStream: isRadioStream(item.uri),
      }))

      const root = ROOTS.find((entry) => query.path.startsWith(entry.id))
      const response: BrowseResponse = {
        path: query.path,
        breadcrumbs: root ? [{ id: root.id, title: root.title }] : [],
        items,
        total: page.total,
      }
      return response
    } catch (err) {
      request.log.warn({ err, path: query.path }, 'browse failed')
      return reply
        .status(502)
        .send({ error: 'browse_failed', message: 'Sonos could not browse that location' })
    }
  })

  /**
   * Preview a pasted URL before it's saved to a preset, so the user sees the
   * track count — and any "this can only be played whole" caveat — up front
   * rather than discovering it when the preset first runs.
   */
  app.post('/api/sources/resolve', async (request, reply) => {
    const body = resolveBodySchema.parse(request.body)
    try {
      const resolved = await resolver.resolve({ kind: 'service_url', ref: body.url })
      const response: ResolveUrlResponse = {
        kind: 'service_url',
        ref: body.url,
        label: resolved.label,
        resolutionMode: resolved.mode,
        trackCount: resolved.mode === 'tracks' ? resolved.tracks.length : null,
        sampleTracks: resolved.tracks
          .slice(0, 5)
          .map((track) => ({ title: track.title ?? track.uri, artist: track.artist })),
        warning: resolved.warning,
      }
      return response
    } catch (err) {
      if (err instanceof UnsupportedServiceUrlError) {
        return reply.status(400).send({ error: 'unsupported_url', message: err.message })
      }
      if (err instanceof ServiceNotConnectedError) {
        return reply.status(400).send({ error: 'service_not_connected', message: err.message })
      }
      request.log.warn({ err, url: body.url }, 'resolve failed')
      return reply.status(502).send({
        error: 'resolve_failed',
        message: err instanceof Error ? err.message : 'Could not resolve that link',
      })
    }
  })
}
