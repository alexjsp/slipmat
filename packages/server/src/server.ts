import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import fastifyStatic from '@fastify/static'
import Fastify from 'fastify'
import type { Config } from './config.js'
import type { Logger } from './logger.js'

export type BuildServerOptions = {
  config: Config
  logger: Logger
}

/**
 * Return type is inferred rather than annotated: passing `loggerInstance`
 * specialises Fastify's logger generic, and a plain `FastifyInstance`
 * annotation would widen it back and fail to typecheck.
 */
export type App = Awaited<ReturnType<typeof buildServer>>

export async function buildServer({ config, logger }: BuildServerOptions) {
  const app = Fastify({ loggerInstance: logger, trustProxy: true })

  app.get('/api/health', async () => ({
    status: 'ok',
    version: process.env.DOMOVOI_VERSION ?? 'dev',
  }))

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

  void config
  return app
}
