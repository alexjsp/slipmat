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

  /**
   * Setting this turns authentication on. Unset means no login at all, which is
   * the default on purpose: Sonos has no auth of its own, so anything on the
   * LAN can already drive the speakers.
   */
  DOMOVOI_PASSWORD: z.string().optional(),
  DOMOVOI_SESSION_SECRET: z.string().optional(),
  /** Extra Host header values to accept, beyond localhost and private ranges. */
  DOMOVOI_ALLOWED_HOSTS: z.string().optional(),

  /** Seed a known speaker IP when SSDP discovery can't get through. */
  DOMOVOI_SEED_IP: z.string().optional(),
  /** Address the speakers should dial back into for UPnP events. */
  DOMOVOI_CALLBACK_HOST: z.string().optional(),
  /** Run against the in-memory household instead of real speakers. */
  DOMOVOI_FAKE_SONOS: boolish,
  /**
   * Allow scratch-queue expansion of streaming containers. This temporarily
   * replaces an idle speaker's queue (and restores it), so it is opt-in.
   */
  DOMOVOI_ALLOW_QUEUE_EXPANSION: boolish,
  /** Zone to borrow for expansion. Unset picks any idle zone with no queue. */
  DOMOVOI_UTILITY_ZONE: z.string().optional(),

  /**
   * IANA timezone for evaluating time-based preset rules. Explicit, because
   * "after 21:00" silently meaning UTC only surfaces in December.
   */
  DOMOVOI_TZ: z.string().default(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'),

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
  fakeSonos: boolean
  allowQueueExpansion: boolean
  utilityZoneId: string | undefined
  timeZone: string
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
    fakeSonos: parsed.DOMOVOI_FAKE_SONOS,
    allowQueueExpansion: parsed.DOMOVOI_ALLOW_QUEUE_EXPANSION,
    utilityZoneId: parsed.DOMOVOI_UTILITY_ZONE,
    timeZone: parsed.DOMOVOI_TZ,
    homekit: {
      enabled: parsed.DOMOVOI_HOMEKIT,
      pin: parsed.DOMOVOI_HOMEKIT_PIN,
      name: parsed.DOMOVOI_HOMEKIT_NAME,
    },
  }
}
