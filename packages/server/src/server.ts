import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import fastifyStatic from '@fastify/static'
import fastifyWebsocket from '@fastify/websocket'
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify'
import type { Config } from './config.js'
import type { Logger } from './logger.js'
import { registerSystemRoutes } from './routes/system.js'
import { createDriver } from './sonos/create-driver.js'
import type { SonosDriver } from './sonos/driver.js'
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
