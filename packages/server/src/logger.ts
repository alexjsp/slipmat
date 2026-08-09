import { pino } from 'pino'
import type { Config } from './config.js'

export function createLogger(config: Pick<Config, 'logLevel'>) {
  const pretty = process.env.NODE_ENV !== 'production'
  return pino({
    level: config.logLevel,
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
          },
        }
      : {}),
  })
}

export type Logger = ReturnType<typeof createLogger>
