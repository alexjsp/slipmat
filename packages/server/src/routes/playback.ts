import {
  groupJoinRequestSchema,
  groupLeaveRequestSchema,
  muteRequestSchema,
  seekRequestSchema,
  volumeRequestSchema,
} from '@slipmat/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { SonosDriver } from '../sonos/driver.js'
import { UnknownZoneError } from '../sonos/errors.js'
import type { SystemStateStore } from '../state/store.js'

export type PlaybackRoutesDeps = {
  driver: SonosDriver
  store: SystemStateStore
}

const zoneParamsSchema = z.object({ id: z.string().min(1) })

const artQuerySchema = z.object({
  zone: z.string().min(1),
  path: z.string().min(1),
})

export async function registerPlaybackRoutes(
  app: FastifyInstance,
  { driver, store }: PlaybackRoutesDeps,
) {
  /**
   * Commands go straight to the driver, then we nudge the store. Sonos will
   * also send an event, but pushing immediately makes the UI feel instant
   * instead of waiting a round-trip for the speaker to notify us.
   */
  const command = <B>(
    path: string,
    bodySchema: z.ZodType<B> | null,
    run: (zoneId: string, body: B) => Promise<void>,
  ) => {
    app.post(path, async (request, reply) => {
      const { id } = zoneParamsSchema.parse(request.params)
      const body = bodySchema ? bodySchema.parse(request.body) : (undefined as B)
      try {
        await run(id, body)
      } catch (err) {
        if (err instanceof UnknownZoneError) {
          return reply.status(404).send({ error: 'not_found', message: err.message })
        }
        request.log.warn({ err, zoneId: id, path }, 'playback command failed')
        return reply.status(502).send({
          error: 'command_failed',
          message: err instanceof Error ? err.message : 'The speaker rejected the command',
        })
      }
      store.refresh()
      return reply.status(204).send()
    })
  }

  command('/api/zones/:id/play', null, (id) => driver.play(id))
  command('/api/zones/:id/pause', null, (id) => driver.pause(id))
  command('/api/zones/:id/next', null, (id) => driver.next(id))
  command('/api/zones/:id/previous', null, (id) => driver.previous(id))
  command('/api/zones/:id/seek', seekRequestSchema, (id, body) =>
    driver.seek(id, body.positionSeconds),
  )
  command('/api/zones/:id/volume', volumeRequestSchema, (id, body) =>
    driver.setVolume(id, body.volume),
  )
  command('/api/zones/:id/mute', muteRequestSchema, (id, body) => driver.setMute(id, body.muted))

  app.post('/api/groups/join', async (request, reply) => {
    const body = groupJoinRequestSchema.parse(request.body)
    try {
      await driver.joinGroup(body.coordinatorZoneId, body.zoneIds)
    } catch (err) {
      if (err instanceof UnknownZoneError) {
        return reply.status(404).send({ error: 'not_found', message: err.message })
      }
      request.log.warn({ err, ...body }, 'join failed')
      return reply.status(502).send({
        error: 'command_failed',
        message: err instanceof Error ? err.message : 'Grouping failed',
      })
    }
    store.refresh()
    return reply.status(204).send()
  })

  app.post('/api/groups/leave', async (request, reply) => {
    const body = groupLeaveRequestSchema.parse(request.body)
    try {
      await driver.leaveGroup(body.zoneIds)
    } catch (err) {
      if (err instanceof UnknownZoneError) {
        return reply.status(404).send({ error: 'not_found', message: err.message })
      }
      request.log.warn({ err, ...body }, 'leave failed')
      return reply.status(502).send({
        error: 'command_failed',
        message: err instanceof Error ? err.message : 'Ungrouping failed',
      })
    }
    store.refresh()
    return reply.status(204).send()
  })

  /**
   * Album art lives on the speaker's own :1400 port. Proxying it keeps artwork
   * working when the UI is reached over Tailscale or behind a reverse proxy,
   * where the browser has no route to the speaker.
   */
  app.get('/api/art', async (request, reply) => {
    const query = artQuerySchema.parse(request.query)
    // Only ever a path on the speaker — never an arbitrary URL, or this
    // endpoint would be an open proxy into the local network.
    if (!query.path.startsWith('/')) {
      return reply.status(400).send({ error: 'bad_request', message: 'path must be absolute' })
    }
    try {
      const art = await driver.fetchArt(query.zone, query.path)
      return reply
        .header('content-type', art.contentType)
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'public, max-age=3600')
        .send(Buffer.from(art.body))
    } catch (err) {
      request.log.debug({ err, ...query }, 'artwork fetch failed')
      return reply.status(404).send({ error: 'not_found', message: 'Artwork unavailable' })
    }
  })
}
