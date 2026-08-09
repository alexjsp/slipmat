import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import fastifyStatic from '@fastify/static'
import fastifyWebsocket from '@fastify/websocket'
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import type { Config } from './config.js'
import { openDatabase } from './db/index.js'
import type { Logger } from './logger.js'
import { ActivationEngine } from './presets/activate.js'
import { PresetRepository } from './presets/repository.js'
import { registerPlaybackRoutes } from './routes/playback.js'
import { registerPresetRoutes } from './routes/presets.js'
import { registerSourceRoutes } from './routes/sources.js'
import { registerSystemRoutes } from './routes/system.js'
import { createDriver } from './sonos/create-driver.js'
import type { SonosDriver } from './sonos/driver.js'
import { SourceCache } from './sources/cache.js'
import { SourceResolver } from './sources/resolver.js'
import { SystemStateStore } from './state/store.js'

export type BuildServerOptions = {
  config: Config
  logger: Logger
  /** Injected by tests so nothing ever reaches a real household. */
  driver?: SonosDriver
}

export type App = FastifyInstance

export async function buildServer({
  config,
  logger,
  driver: injected,
}: BuildServerOptions): Promise<App> {
  // Widened to FastifyBaseLogger deliberately: passing pino's concrete Logger
  // specialises Fastify's logger generic, which then makes every route module
  // typed against a plain FastifyInstance incompatible.
  const app = Fastify({ loggerInstance: logger as FastifyBaseLogger, trustProxy: true })

  const driver = injected ?? createDriver(config, logger)
  await driver.start()

  const store = new SystemStateStore(driver)

  app.addHook('onClose', async () => {
    store.close()
    await driver.stop()
  })

  await app.register(fastifyWebsocket)

  app.get('/api/health', async () => ({
    status: 'ok',
    version: process.env.DOMOVOI_VERSION ?? 'dev',
    sonosReady: store.current.ready,
  }))

  await registerSystemRoutes(app, { store })
  await registerPlaybackRoutes(app, { driver, store })

  const resolver = new SourceResolver({
    driver,
    logger,
    utilityZoneId: config.utilityZoneId,
    allowScratchQueueExpansion: config.allowQueueExpansion,
  })
  await registerSourceRoutes(app, { driver, resolver })

  const db = openDatabase({ dataDir: config.dataDir })
  const cache = new SourceCache(db, resolver, logger)
  const repo = new PresetRepository(db)
  const engine = new ActivationEngine({ db, driver, store, cache, logger })

  // Reality can drift while we're not looking (someone pauses in the Sonos app,
  // a speaker reboots), so re-derive active state whenever anything changes.
  store.on('change', () => engine.reconcile())

  await registerPresetRoutes(app, { repo, engine, driver, cache })

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply
        .status(400)
        .send({ error: 'bad_request', message: 'Invalid request', details: error.issues })
    }
    request.log.error({ err: error }, 'unhandled error')
    return reply.status(500).send({ error: 'internal_error', message: 'Something went wrong' })
  })

  // The built SPA is copied next to the server bundle in the Docker image. In
  // dev it doesn't exist and Vite serves the UI on its own port instead.
  const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../public')
  if (existsSync(join(webRoot, 'index.html'))) {
    await app.register(fastifyStatic, { root: webRoot })
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.status(404).send({ error: 'not_found', message: 'No such endpoint' })
      }
      return reply.sendFile('index.html')
    })
  } else {
    logger.warn({ webRoot }, 'no built UI found; serving API only')
  }

  return app
}
