import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`

export const presets = sqliteTable('presets', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  icon: text('icon'),
  color: text('color'),
  shuffle: integer('shuffle', { mode: 'boolean' }).notNull().default(true),
  repeatAll: integer('repeat_all', { mode: 'boolean' }).notNull().default(true),
  dedupe: integer('dedupe', { mode: 'boolean' }).notNull().default(true),
  pauseOthers: integer('pause_others', { mode: 'boolean' }).notNull().default(false),
  crossfade: integer('crossfade', { mode: 'boolean' }).notNull().default(false),
  homekitEnabled: integer('homekit_enabled', { mode: 'boolean' }).notNull().default(false),
  /** Secret in the webhook URL; regenerable from the editor. */
  webhookToken: text('webhook_token').notNull(),
  position: integer('position').notNull().default(0),
  createdAt: text('created_at').notNull().default(now),
  updatedAt: text('updated_at').notNull().default(now),
})

export const presetZones = sqliteTable(
  'preset_zones',
  {
    id: text('id').primaryKey(),
    presetId: text('preset_id')
      .notNull()
      .references(() => presets.id, { onDelete: 'cascade' }),
    zoneId: text('zone_id').notNull(),
    /** Captured at save time so a preset still reads sensibly if a zone vanishes. */
    zoneName: text('zone_name').notNull(),
    volume: integer('volume').notNull(),
    isCoordinator: integer('is_coordinator', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => [uniqueIndex('preset_zones_unique').on(table.presetId, table.zoneId)],
)

export const presetSources = sqliteTable(
  'preset_sources',
  {
    id: text('id').primaryKey(),
    presetId: text('preset_id')
      .notNull()
      .references(() => presets.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    kind: text('kind').notNull(),
    ref: text('ref').notNull(),
    label: text('label').notNull(),
  },
  (table) => [index('preset_sources_preset').on(table.presetId, table.position)],
)

/**
 * Resolved track lists, keyed by a hash of (kind, ref). Expansion is slow and
 * sometimes borrows a speaker, so it never happens on the activation path.
 */
export const resolvedSources = sqliteTable('resolved_sources', {
  hash: text('hash').primaryKey(),
  kind: text('kind').notNull(),
  ref: text('ref').notNull(),
  label: text('label').notNull(),
  mode: text('mode').notNull(),
  /** JSON array of { uri, metadata, title, artist }. */
  tracksJson: text('tracks_json').notNull(),
  containerUri: text('container_uri'),
  containerMetadata: text('container_metadata'),
  /** Structured metadata for pasted service URLs; see driver.addUrisToQueue. */
  containerMetadataObjectJson: text('container_metadata_object_json'),
  warning: text('warning'),
  /** Whether resolving borrowed a speaker; see SourceCache. */
  expensive: integer('expensive', { mode: 'boolean' }).notNull().default(false),
  resolvedAt: text('resolved_at').notNull().default(now),
})

/**
 * One row per activation. This is the ground truth for the "loose" active-state
 * check that drives the UI badge and the HomeKit switch.
 */
export const activations = sqliteTable(
  'activations',
  {
    id: text('id').primaryKey(),
    presetId: text('preset_id')
      .notNull()
      .references(() => presets.id, { onDelete: 'cascade' }),
    coordinatorZoneId: text('coordinator_zone_id').notNull(),
    /** JSON array of zone ids. */
    memberZoneIdsJson: text('member_zone_ids_json').notNull(),
    /** JSON array of enqueued track URIs; grows as the tail is appended. */
    trackUrisJson: text('track_uris_json').notNull(),
    /** Set for stream presets, which have no queue to match against. */
    streamUri: text('stream_uri'),
    warningsJson: text('warnings_json').notNull().default('[]'),
    /** Cleared when the activation stops or is superseded. */
    live: integer('live', { mode: 'boolean' }).notNull().default(true),
    startedAt: text('started_at').notNull().default(now),
  },
  (table) => [index('activations_live').on(table.live, table.presetId)],
)

/**
 * Present from day one so cron schedules can be added without a migration.
 * Nothing writes here yet.
 */
export const triggers = sqliteTable('triggers', {
  id: text('id').primaryKey(),
  presetId: text('preset_id')
    .notNull()
    .references(() => presets.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  /** Kind-specific JSON config, e.g. { cron: '30 7 * * 1-5', tz: 'Europe/London' }. */
  configJson: text('config_json').notNull().default('{}'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull().default(now),
})

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})

/**
 * Conditional rules: "add throwbacks on Thursdays", "wind down after 21:00".
 * Additive, so presets created before this existed need no migration.
 */
export const presetRules = sqliteTable(
  'preset_rules',
  {
    id: text('id').primaryKey(),
    presetId: text('preset_id')
      .notNull()
      .references(() => presets.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    label: text('label').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    conditionJson: text('condition_json').notNull().default('{}'),
    effectJson: text('effect_json').notNull().default('{}'),
  },
  (table) => [index('preset_rules_preset').on(table.presetId, table.position)],
)
