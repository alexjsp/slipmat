import { blocklistSchema } from '@slipmat/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { ActivationEngine } from '../presets/activate.js'
import { pauseAllMusic } from '../presets/pause-all.js'
import type { PresetRepository } from '../presets/repository.js'
import { isValidTimeZone, type SettingsStore } from '../settings.js'
import type { SonosDriver } from '../sonos/driver.js'
import type { SystemStateStore } from '../state/store.js'

export type WebhookRoutesDeps = {
  repo: PresetRepository
  engine: ActivationEngine
  driver: SonosDriver
  store: SystemStateStore
  settings: SettingsStore
  /** Effective zone: the stored setting, or the environment's if unset. */
  timeZone: () => string
}

const tokenParamsSchema = z.object({ token: z.string().min(1) })
const actionQuerySchema = z.object({
  action: z.enum(['activate', 'stop', 'toggle', 'restart']).default('activate'),
})

/**
 * Webhooks carry a per-preset secret in the URL rather than relying on a
 * session, so they work from Shortcuts, Stream Deck and Node-RED regardless of
 * whether the UI has authentication turned on.
 *
 * GET is supported alongside POST because plenty of the things people wire
 * these into can only issue a GET.
 */
export async function registerWebhookRoutes(app: FastifyInstance, deps: WebhookRoutesDeps) {
  const handle = async (token: string, action: string, log: FastifyInstance['log']) => {
    if (token === deps.settings.pauseAllToken()) {
      return pauseAllMusic({
        driver: deps.driver,
        store: deps.store,
        engine: deps.engine,
        logger: log,
      })
    }

    const preset = deps.repo.findByWebhookToken(token)
    if (!preset) return null

    switch (action) {
      case 'stop':
        return { stopped: await deps.engine.stop(preset.id) }
      case 'restart':
        return deps.engine.activate(preset, { restart: true, trigger: 'webhook' })
      case 'toggle':
        return deps.engine.isStillPlaying(preset.id)
          ? { stopped: await deps.engine.stop(preset.id) }
          : deps.engine.activate(preset, { trigger: 'webhook' })
      default:
        return deps.engine.activate(preset, { trigger: 'webhook' })
    }
  }

  for (const method of ['GET', 'POST'] as const) {
    app.route({
      method,
      url: '/api/webhooks/:token',
      // The token is the webhook's only secret, and the default request log
      // line would otherwise write it out on every call. Fastify honours
      // route-level serializers but only types them on `register`, hence the
      // spread.
      ...({ logSerializers: { req: serializeRedactedRequest } } as object),
      handler: async (request, reply) => {
        const { token } = tokenParamsSchema.parse(request.params)
        const { action } = actionQuerySchema.parse(request.query)
        try {
          const result = await handle(token, action, request.log)
          if (result === null) {
            // Deliberately indistinguishable from a valid-but-deleted preset,
            // so this can't be used to probe for live tokens.
            return reply.status(404).send({ error: 'not_found', message: 'Unknown webhook' })
          }
          return result
        } catch (err) {
          request.log.warn({ err, action }, 'webhook failed')
          return reply.status(502).send({
            error: 'webhook_failed',
            message: err instanceof Error ? err.message : 'Could not run this webhook',
          })
        }
      },
    })
  }

  app.post('/api/pause-all', async (request) =>
    pauseAllMusic({
      driver: deps.driver,
      store: deps.store,
      engine: deps.engine,
      logger: request.log,
    }),
  )

  /** The UI needs the pause-all webhook URL to show and copy. */
  app.get('/api/pause-all/token', async () => ({ token: deps.settings.pauseAllToken() }))

  app.post('/api/pause-all/regenerate-token', async () => ({
    token: deps.settings.regeneratePauseAllToken(),
  }))

  /**
   * The zone schedules and time-based rules are read in.
   *
   * One zone for the whole household, not one per browser: the scheduler fires
   * on the server, hours after the last tab was closed.
   */
  app.get('/api/timezone', async () => ({ timeZone: deps.timeZone() }))

  app.put('/api/timezone', async (request, reply) => {
    const body = z.object({ timeZone: z.string().min(1) }).parse(request.body)
    if (!isValidTimeZone(body.timeZone)) {
      return reply
        .status(400)
        .send({ error: 'invalid_timezone', message: `${body.timeZone} is not a known time zone` })
    }
    deps.settings.setTimeZone(body.timeZone)
    return { timeZone: deps.timeZone() }
  })

  app.get('/api/blocklist', async () => ({ rules: deps.settings.blocklist() }))

  app.put('/api/blocklist', async (request) => {
    const body = z.object({ rules: blocklistSchema }).parse(request.body)
    deps.settings.setBlocklist(body.rules)
    return { rules: deps.settings.blocklist() }
  })
}

/** Fastify's default request serializer, minus the token in the path. */
function serializeRedactedRequest(request: FastifyRequest) {
  return {
    method: request.method,
    url: request.url.replace(/^\/api\/webhooks\/[^/?#]+/, '/api/webhooks/[redacted]'),
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  }
}
