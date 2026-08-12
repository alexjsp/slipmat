import { blocklistSchema } from '@slipmat/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ActivationEngine } from '../presets/activate.js'
import { pauseAllMusic } from '../presets/pause-all.js'
import type { PresetRepository } from '../presets/repository.js'
import type { SettingsStore } from '../settings.js'
import type { SonosDriver } from '../sonos/driver.js'
import type { SystemStateStore } from '../state/store.js'

export type WebhookRoutesDeps = {
  repo: PresetRepository
  engine: ActivationEngine
  driver: SonosDriver
  store: SystemStateStore
  settings: SettingsStore
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

  app.get('/api/blocklist', async () => ({ rules: deps.settings.blocklist() }))

  app.put('/api/blocklist', async (request) => {
    const body = z.object({ rules: blocklistSchema }).parse(request.body)
    deps.settings.setBlocklist(body.rules)
    return { rules: deps.settings.blocklist() }
  })
}
