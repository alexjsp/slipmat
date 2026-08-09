import { loadConfig } from './config.js'
import { createLogger } from './logger.js'
import { buildServer } from './server.js'

const config = loadConfig()
const logger = createLogger(config)

async function main() {
  const app = await buildServer({ config, logger })

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down')
    try {
      await app.close()
      process.exit(0)
    } catch (err) {
      logger.error({ err }, 'error during shutdown')
      process.exit(1)
    }
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  await app.listen({ host: config.host, port: config.port })
  logger.info({ host: config.host, port: config.port }, 'domovoi listening')
}

main().catch((err) => {
  logger.error({ err }, 'failed to start')
  process.exit(1)
})
