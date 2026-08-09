import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { Db } from './db/index.js'
import { settings } from './db/schema.js'

/** Reserved webhook token for the system-wide Pause All Music action. */
const PAUSE_ALL_TOKEN_KEY = 'pause_all_token'

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

  regeneratePauseAllToken(): string {
    const token = randomBytes(24).toString('base64url')
    this.set(PAUSE_ALL_TOKEN_KEY, token)
    return token
  }
}
