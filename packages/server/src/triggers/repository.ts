import { randomUUID } from 'node:crypto'
import type { Trigger, TriggerInput, TriggerKind } from '@domovoi/shared'
import { asc, eq } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import { presets, triggers } from '../db/schema.js'

export class TriggerRepository {
  constructor(private readonly db: Db) {}

  list(): Trigger[] {
    // Left join so a system-wide trigger (no preset) still comes back.
    const rows = this.db
      .select({ trigger: triggers, presetName: presets.name })
      .from(triggers)
      .leftJoin(presets, eq(triggers.presetId, presets.id))
      .orderBy(asc(triggers.createdAt))
      .all()

    return rows.map((row) => this.hydrate(row.trigger, row.presetName))
  }

  get(id: string): Trigger | undefined {
    const row = this.db
      .select({ trigger: triggers, presetName: presets.name })
      .from(triggers)
      .leftJoin(presets, eq(triggers.presetId, presets.id))
      .where(eq(triggers.id, id))
      .get()
    return row ? this.hydrate(row.trigger, row.presetName) : undefined
  }

  /** Raw rows for the scheduler, which needs `lastFiredKey`. */
  enabledRows() {
    return this.db.select().from(triggers).where(eq(triggers.enabled, true)).all()
  }

  rowsFor(kind: TriggerKind) {
    return this.enabledRows().filter((row) => row.kind === kind)
  }

  create(input: TriggerInput): Trigger {
    const id = randomUUID()
    this.db
      .insert(triggers)
      .values({
        id,
        presetId: input.presetId,
        kind: input.kind,
        label: input.label,
        enabled: input.enabled,
        configJson: JSON.stringify(input.config),
      })
      .run()
    return this.get(id)!
  }

  update(id: string, input: TriggerInput): Trigger | undefined {
    const result = this.db
      .update(triggers)
      .set({
        presetId: input.presetId,
        kind: input.kind,
        label: input.label,
        enabled: input.enabled,
        configJson: JSON.stringify(input.config),
        // Editing a schedule clears the dedupe key, so a corrected time can
        // fire today rather than waiting until tomorrow.
        lastFiredKey: null,
      })
      .where(eq(triggers.id, id))
      .run()
    return result.changes > 0 ? this.get(id) : undefined
  }

  setEnabled(id: string, enabled: boolean): Trigger | undefined {
    const result = this.db.update(triggers).set({ enabled }).where(eq(triggers.id, id)).run()
    return result.changes > 0 ? this.get(id) : undefined
  }

  delete(id: string): boolean {
    return this.db.delete(triggers).where(eq(triggers.id, id)).run().changes > 0
  }

  recordFired(id: string, key: string, skippedReason: string | null): void {
    this.db
      .update(triggers)
      .set({
        lastFiredKey: key,
        lastFiredAt: new Date().toISOString(),
        lastSkippedReason: skippedReason,
      })
      .where(eq(triggers.id, id))
      .run()
  }

  private hydrate(row: typeof triggers.$inferSelect, presetName: string | null): Trigger {
    return {
      id: row.id,
      presetId: row.presetId,
      presetName,
      kind: row.kind as TriggerKind,
      label: row.label,
      enabled: row.enabled,
      config: JSON.parse(row.configJson),
      lastFiredAt: row.lastFiredAt,
      lastSkippedReason: row.lastSkippedReason,
      createdAt: row.createdAt,
    }
  }
}
