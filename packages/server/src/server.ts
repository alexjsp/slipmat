import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import fastifyStatic from '@fastify/static'
import fastifyWebsocket from '@fastify/websocket'
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { registerAuth } from './auth.js'
import type { Config } from './config.js'
import { openDatabase } from './db/index.js'
import type { HomeKitBridge } from './homekit/bridge.js'
import type { Logger } from './logger.js'
import { ActivationEngine } from './presets/activate.js'
import { PresetRepository } from './presets/repository.js'
import { registerPlaybackRoutes } from './routes/playback.js'
import { registerPresetRoutes } from './routes/presets.js'
import { registerSourceRoutes } from './routes/sources.js'
import { registerSystemRoutes } from './routes/system.js'
import { registerTriggerRoutes } from './routes/triggers.js'
import { registerWebhookRoutes } from './routes/webhooks.js'
import { SettingsStore } from './settings.js'
import { createDriver } from './sonos/create-driver.js'
import type { SonosDriver } from './sonos/driver.js'
import { SourceCache } from './sources/cache.js'
import { SourceRefresher } from './sources/refresher.js'
import { SourceResolver } from './sources/resolver.js'
import { SystemStateStore } from './state/store.js'
import { TriggerRepository } from './triggers/repository.js'
import { Scheduler } from './triggers/scheduler.js'

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

  const db =
    config.fakeSonos && config.dataDir === ':memory:'
      ? openDatabase({ inMemory: true })
      : openDatabase({ dataDir: config.dataDir })
  const settings = new SettingsStore(db)

  // Registered before any route so the Host check and session guard see
  // everything, including the WebSocket upgrade.
  await registerAuth(app, { config, logger, settings })

  app.get('/api/health', async () => ({
    status: 'ok',
    version: process.env.SLIPMAT_VERSION ?? 'dev',
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

  const cache = new SourceCache(db, resolver, logger)
  const repo = new PresetRepository(db)
  // A function, not a value: the zone is a stored setting, and a scheduler that
  // captured it at boot would keep firing on the old one until a restart.
  const timeZone = () => settings.timeZone(config.timeZone)
  const engine = new ActivationEngine({
    db,
    driver,
    store,
    cache,
    logger,
    repo,
    timeZone,
    settings,
  })

  // Reality can drift while we're not looking (someone pauses in the Sonos app,
  // a speaker reboots), so re-derive active state whenever anything changes.
  store.on('change', () => engine.reconcile())

  // Streaming playlists change under us — a weekly mix would otherwise keep
  // serving last week's tracks until something happened to refresh it.
  const refresher = new SourceRefresher({ repo, cache, logger })
  refresher.start()
  app.addHook('onClose', async () => refresher.stop())

  // Off unless SLIPMAT_HOMEKIT=1, and the HAP library is only imported when it
  // is — so with the feature off nothing is advertised over mDNS at all.
  let homekit: HomeKitBridge | undefined
  if (config.homekit.enabled) {
    try {
      const { startHomeKitBridge } = await import('./homekit/bridge.js')
      homekit = await startHomeKitBridge({
        config,
        logger,
        repo,
        engine,
        driver,
        store,
        pincode: config.homekit.pin ?? settings.homekitPin(),
      })
      app.addHook('onClose', async () => homekit?.stop())
    } catch (err) {
      // A HomeKit failure must not take the whole app down with it.
      logger.error({ err }, 'HomeKit bridge failed to start; continuing without it')
    }
  }

  await registerPresetRoutes(app, {
    repo,
    engine,
    driver,
    cache,
    onPresetsChanged: () => homekit?.sync(),
    timeZone,
  })
  await registerWebhookRoutes(app, { repo, engine, driver, store, settings, timeZone })

  const triggers = new TriggerRepository(db)
  const scheduler = new Scheduler({
    triggers,
    presets: repo,
    engine,
    driver,
    store,
    logger,
    timeZone,
  })
  scheduler.start()
  app.addHook('onClose', async () => scheduler.stop())

  await registerTriggerRoutes(app, { triggers, scheduler, timeZone })

  app.get('/api/homekit', async () => ({
    enabled: config.homekit.enabled,
    running: !!homekit,
    pincode: homekit?.pincode ?? null,
    setupUri: homekit?.setupUri() ?? null,
  }))

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
