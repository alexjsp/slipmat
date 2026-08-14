import { randomBytes } from 'node:crypto'
import { type Blocklist, blocklistSchema } from '@slipmat/shared'
import { eq } from 'drizzle-orm'
import type { Db } from './db/index.js'
import { settings } from './db/schema.js'

/** Reserved webhook token for the system-wide Pause All Music action. */
const PAUSE_ALL_TOKEN_KEY = 'pause_all_token'
const BLOCKLIST_KEY = 'blocklist'
const TIMEZONE_KEY = 'time_zone'

/** Does the platform recognise this as an IANA zone? */
export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value })
    return true
  } catch {
    return false
  }
}

export class SettingsStore {
  constructor(private readonly db: Db) {}

  get(key: string): string | undefined {
    return this.db.select().from(settings).where(eq(settings.key, key)).get()?.value
  }

  set(key: string, value: string): void {
    this.db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value } })
      .run()
  }

  /**
   * Stable across restarts — a webhook URL saved into Shortcuts or Node-RED has
   * to keep working, so this is generated once and then persisted.
   */
  pauseAllToken(): string {
    const existing = this.get(PAUSE_ALL_TOKEN_KEY)
    if (existing) return existing
    const token = randomBytes(24).toString('base64url')
    this.set(PAUSE_ALL_TOKEN_KEY, token)
    return token
  }

  /**
   * Music never to play, whichever preset asks for it.
   *
   * Parsed defensively: this is the only thing standing between a hand-edited
   * or half-written settings row and every activation throwing.
   */
  blocklist(): Blocklist {
    const raw = this.get(BLOCKLIST_KEY)
    if (!raw) return []
    const parsed = blocklistSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : []
  }

  /**
   * The zone every schedule and time-based rule is read in.
   *
   * Stored rather than taken from the host because the host is a container:
   * left alone it is UTC, which is how "07:30" quietly became 06:30 in summer.
   * Falls back to whatever the environment said, and ignores a stored value the
   * platform no longer recognises rather than throwing on every scheduler tick.
   */
  timeZone(fallback: string): string {
    const stored = this.get(TIMEZONE_KEY)
    return stored && isValidTimeZone(stored) ? stored : fallback
  }

  setTimeZone(value: string): void {
    this.set(TIMEZONE_KEY, value)
  }

  setBlocklist(rules: Blocklist): void {
    this.set(BLOCKLIST_KEY, JSON.stringify(rules))
  }

  regeneratePauseAllToken(): string {
    const token = randomBytes(24).toString('base64url')
    this.set(PAUSE_ALL_TOKEN_KEY, token)
    return token
  }
}
