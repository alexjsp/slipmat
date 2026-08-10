import { randomBytes, randomUUID } from 'node:crypto'
import type {
  Preset,
  PresetInput,
  PresetRule,
  PresetRuleInput,
  PresetSource,
  PresetZone,
} from '@domovoi/shared'
import { asc, eq } from 'drizzle-orm'
import type { Db, DbTx } from '../db/index.js'
import { presetRules, presetSources, presets, presetZones } from '../db/schema.js'

export type ResolvedSourceMeta = {
  mode: string
  trackCount: number | null
  resolvedAt: string | null
  warning: string | null
}

export class PresetRepository {
  constructor(private readonly db: Db) {}

  list(): Preset[] {
    const rows = this.db
      .select()
      .from(presets)
      .orderBy(asc(presets.position), asc(presets.name))
      .all()
    return rows.map((row) => this.hydrate(row))
  }

  get(id: string): Preset | undefined {
    const row = this.db.select().from(presets).where(eq(presets.id, id)).get()
    return row ? this.hydrate(row) : undefined
  }

  findByWebhookToken(token: string): Preset | undefined {
    const row = this.db.select().from(presets).where(eq(presets.webhookToken, token)).get()
    return row ? this.hydrate(row) : undefined
  }

  create(input: PresetInput, zoneNames: Map<string, string>): Preset {
    const id = randomUUID()
    const maxPosition = this.db.select().from(presets).all().length

    this.db.transaction((tx) => {
      tx.insert(presets)
        .values({
          id,
          name: input.name,
          icon: input.icon,
          color: input.color,
          shuffle: input.shuffle,
          repeatAll: input.repeatAll,
          dedupe: input.dedupe,
          pauseOthers: input.pauseOthers,
          crossfade: input.crossfade,
          homekitEnabled: input.homekitEnabled,
          webhookToken: newWebhookToken(),
          position: maxPosition,
        })
        .run()
      this.writeChildren(tx, id, input, zoneNames)
    })

    return this.get(id)!
  }

  update(id: string, input: PresetInput, zoneNames: Map<string, string>): Preset | undefined {
    if (!this.get(id)) return undefined

    this.db.transaction((tx) => {
      tx.update(presets)
        .set({
          name: input.name,
          icon: input.icon,
          color: input.color,
          shuffle: input.shuffle,
          repeatAll: input.repeatAll,
          dedupe: input.dedupe,
          pauseOthers: input.pauseOthers,
          crossfade: input.crossfade,
          homekitEnabled: input.homekitEnabled,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(presets.id, id))
        .run()

      // Zones and sources are small and order-sensitive; replacing them wholesale
      // avoids diffing headaches and keeps `position` contiguous.
      tx.delete(presetZones).where(eq(presetZones.presetId, id)).run()
      tx.delete(presetSources).where(eq(presetSources.presetId, id)).run()
      this.writeChildren(tx, id, input, zoneNames)
    })

    return this.get(id)
  }

  delete(id: string): boolean {
    const result = this.db.delete(presets).where(eq(presets.id, id)).run()
    return result.changes > 0
  }

  regenerateWebhookToken(id: string): string | undefined {
    const token = newWebhookToken()
    const result = this.db
      .update(presets)
      .set({ webhookToken: token, updatedAt: new Date().toISOString() })
      .where(eq(presets.id, id))
      .run()
    return result.changes > 0 ? token : undefined
  }

  reorder(orderedIds: string[]): void {
    this.db.transaction((tx) => {
      for (const [index, id] of orderedIds.entries()) {
        tx.update(presets).set({ position: index }).where(eq(presets.id, id)).run()
      }
    })
  }

  private writeChildren(
    tx: DbTx,
    presetId: string,
    input: PresetInput,
    zoneNames: Map<string, string>,
  ) {
    // Exactly one coordinator: the queue lives on it, so an ambiguous or absent
    // choice would make activation non-deterministic.
    const explicit = input.zones.find((zone) => zone.isCoordinator)
    const coordinatorZoneId = explicit?.zoneId ?? input.zones[0]?.zoneId

    for (const zone of input.zones) {
      tx.insert(presetZones)
        .values({
          id: randomUUID(),
          presetId,
          zoneId: zone.zoneId,
          zoneName: zoneNames.get(zone.zoneId) ?? zone.zoneId,
          volume: zone.volume,
          isCoordinator: zone.zoneId === coordinatorZoneId,
        })
        .run()
    }

    for (const [position, source] of input.sources.entries()) {
      tx.insert(presetSources)
        .values({
          id: randomUUID(),
          presetId,
          position,
          kind: source.kind,
          ref: source.ref,
          label: source.label,
        })
        .run()
    }
  }

  /** Rules for a preset, in the order they should be applied. */
  rulesFor(presetId: string): PresetRule[] {
    return this.db
      .select()
      .from(presetRules)
      .where(eq(presetRules.presetId, presetId))
      .orderBy(asc(presetRules.position))
      .all()
      .map((row) => ({
        id: row.id,
        presetId: row.presetId,
        position: row.position,
        label: row.label,
        enabled: row.enabled,
        condition: JSON.parse(row.conditionJson),
        effect: JSON.parse(row.effectJson),
      }))
  }

  /** Replaced wholesale — rules are few, ordered, and edited as a list. */
  setRules(presetId: string, rules: PresetRuleInput[]): PresetRule[] {
    this.db.transaction((tx) => {
      tx.delete(presetRules).where(eq(presetRules.presetId, presetId)).run()
      for (const [position, rule] of rules.entries()) {
        tx.insert(presetRules)
          .values({
            id: randomUUID(),
            presetId,
            position,
            label: rule.label,
            enabled: rule.enabled,
            conditionJson: JSON.stringify(rule.condition),
            effectJson: JSON.stringify(rule.effect),
          })
          .run()
      }
    })
    return this.rulesFor(presetId)
  }

  private hydrate(row: typeof presets.$inferSelect): Preset {
    const zones = this.db
      .select()
      .from(presetZones)
      .where(eq(presetZones.presetId, row.id))
      .all()
      .map(
        (zone): PresetZone => ({
          zoneId: zone.zoneId,
          zoneName: zone.zoneName,
          volume: zone.volume,
          isCoordinator: zone.isCoordinator,
        }),
      )

    const sources = this.db
      .select()
      .from(presetSources)
      .where(eq(presetSources.presetId, row.id))
      .orderBy(asc(presetSources.position))
      .all()
      .map(
        (source): PresetSource => ({
          id: source.id,
          kind: source.kind as PresetSource['kind'],
          ref: source.ref,
          label: source.label,
          position: source.position,
          // Filled in by the caller from the resolver cache when needed.
          resolutionMode: null,
          trackCount: null,
          resolvedAt: null,
          resolveError: null,
        }),
      )

    return {
      id: row.id,
      name: row.name,
      icon: row.icon,
      color: row.color,
      zones,
      sources,
      shuffle: row.shuffle,
      repeatAll: row.repeatAll,
      dedupe: row.dedupe,
      pauseOthers: row.pauseOthers,
      crossfade: row.crossfade,
      homekitEnabled: row.homekitEnabled,
      webhookToken: row.webhookToken,
      position: row.position,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }
}

/** URL-safe and long enough that guessing it isn't worth anyone's time. */
export function newWebhookToken(): string {
  return randomBytes(24).toString('base64url')
}

export function coordinatorOf(preset: Preset): PresetZone | undefined {
  return preset.zones.find((zone) => zone.isCoordinator) ?? preset.zones[0]
}

/** Find the zone that should coordinate, given who is actually reachable. */
export function pickCoordinator(
  preset: Preset,
  availableZoneIds: Set<string>,
): PresetZone | undefined {
  const preferred = coordinatorOf(preset)
  if (preferred && availableZoneIds.has(preferred.zoneId)) return preferred
  // The chosen coordinator is offline — promote any surviving member rather
  // than failing the whole preset.
  return preset.zones.find((zone) => availableZoneIds.has(zone.zoneId))
}
