import { randomBytes } from 'node:crypto'
import { type Blocklist, blocklistSchema } from '@slipmat/shared'
import { eq } from 'drizzle-orm'
import type { Db } from './db/index.js'
import { settings } from './db/schema.js'

/** Reserved webhook token for the system-wide Pause All Music action. */
const PAUSE_ALL_TOKEN_KEY = 'pause_all_token'
const BLOCKLIST_KEY = 'blocklist'

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

  setBlocklist(rules: Blocklist): void {
    this.set(BLOCKLIST_KEY, JSON.stringify(rules))
  }

  regeneratePauseAllToken(): string {
    const token = randomBytes(24).toString('base64url')
    this.set(PAUSE_ALL_TOKEN_KEY, token)
    return token
  }
}
