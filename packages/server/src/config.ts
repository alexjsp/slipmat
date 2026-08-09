import { z } from 'zod'

const boolish = z
  .string()
  .optional()
  .transform((v) => v === '1' || v?.toLowerCase() === 'true')

const envSchema = z.object({
  DOMOVOI_HOST: z.string().default('0.0.0.0'),
  DOMOVOI_PORT: z.coerce.number().int().min(1).max(65535).default(5544),
  DOMOVOI_DATA_DIR: z.string().default('./data'),
  DOMOVOI_LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),

  /** Shared password for the UI. Unset disables auth entirely (dev only). */
  DOMOVOI_PASSWORD: z.string().optional(),
  DOMOVOI_SESSION_SECRET: z.string().optional(),
  /** Extra Host header values to accept, beyond localhost and private ranges. */
  DOMOVOI_ALLOWED_HOSTS: z.string().optional(),

  /** Seed a known speaker IP when SSDP discovery can't get through. */
  DOMOVOI_SEED_IP: z.string().optional(),
  /** Address the speakers should dial back into for UPnP events. */
  DOMOVOI_CALLBACK_HOST: z.string().optional(),

  DOMOVOI_HOMEKIT: boolish,
  DOMOVOI_HOMEKIT_PIN: z.string().default('031-45-154'),
  DOMOVOI_HOMEKIT_NAME: z.string().default('Domovoi'),
})

export type Config = {
  host: string
  port: number
  dataDir: string
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error'
  password: string | undefined
  sessionSecret: string | undefined
  allowedHosts: string[]
  seedIp: string | undefined
  callbackHost: string | undefined
  homekit: { enabled: boolean; pin: string; name: string }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.parse(env)
  return {
    host: parsed.DOMOVOI_HOST,
    port: parsed.DOMOVOI_PORT,
    dataDir: parsed.DOMOVOI_DATA_DIR,
    logLevel: parsed.DOMOVOI_LOG_LEVEL,
    password: parsed.DOMOVOI_PASSWORD,
    sessionSecret: parsed.DOMOVOI_SESSION_SECRET,
    allowedHosts:
      parsed.DOMOVOI_ALLOWED_HOSTS?.split(',')
        .map((h) => h.trim())
        .filter(Boolean) ?? [],
    seedIp: parsed.DOMOVOI_SEED_IP,
    callbackHost: parsed.DOMOVOI_CALLBACK_HOST,
    homekit: {
      enabled: parsed.DOMOVOI_HOMEKIT,
      pin: parsed.DOMOVOI_HOMEKIT_PIN,
      name: parsed.DOMOVOI_HOMEKIT_NAME,
    },
  }
}
