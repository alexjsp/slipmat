import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema.js'

export type Db = ReturnType<typeof openDatabase>
/** The handle passed into `db.transaction(...)`; not assignable to `Db`. */
export type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0]

/**
 * DDL is applied directly rather than through generated migration files. The
 * schema is small, single-writer and SQLite-only, and `IF NOT EXISTS` makes
 * startup idempotent — a migration toolchain would be more moving parts than
 * this earns. Any future column change needs a real migration step here.
 */
const DDL = [
  `CREATE TABLE IF NOT EXISTS presets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT,
    color TEXT,
    shuffle INTEGER NOT NULL DEFAULT 1,
    repeat_all INTEGER NOT NULL DEFAULT 1,
    dedupe INTEGER NOT NULL DEFAULT 1,
    pause_others INTEGER NOT NULL DEFAULT 0,
    crossfade INTEGER NOT NULL DEFAULT 0,
    homekit_enabled INTEGER NOT NULL DEFAULT 0,
    webhook_token TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS presets_webhook_token ON presets (webhook_token)`,

  `CREATE TABLE IF NOT EXISTS preset_zones (
    id TEXT PRIMARY KEY,
    preset_id TEXT NOT NULL REFERENCES presets(id) ON DELETE CASCADE,
    zone_id TEXT NOT NULL,
    zone_name TEXT NOT NULL,
    volume INTEGER NOT NULL,
    is_coordinator INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS preset_zones_unique ON preset_zones (preset_id, zone_id)`,

  `CREATE TABLE IF NOT EXISTS preset_sources (
    id TEXT PRIMARY KEY,
    preset_id TEXT NOT NULL REFERENCES presets(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    kind TEXT NOT NULL,
    ref TEXT NOT NULL,
    label TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS preset_sources_preset ON preset_sources (preset_id, position)`,

  `CREATE TABLE IF NOT EXISTS resolved_sources (
    hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    ref TEXT NOT NULL,
    label TEXT NOT NULL,
    mode TEXT NOT NULL,
    tracks_json TEXT NOT NULL,
    container_uri TEXT,
    container_metadata TEXT,
    container_metadata_object_json TEXT,
    warning TEXT,
    expensive INTEGER NOT NULL DEFAULT 0,
    resolved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`,

  // Added after the table shipped; SQLite has no ADD COLUMN IF NOT EXISTS, so
  // the duplicate-column error is expected and ignored on an up-to-date db.
  `ALTER TABLE resolved_sources ADD COLUMN container_metadata_object_json TEXT`,
  `ALTER TABLE resolved_sources ADD COLUMN expensive INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE presets ADD COLUMN shuffle INTEGER NOT NULL DEFAULT 1`,

  `CREATE TABLE IF NOT EXISTS activations (
    id TEXT PRIMARY KEY,
    preset_id TEXT NOT NULL REFERENCES presets(id) ON DELETE CASCADE,
    coordinator_zone_id TEXT NOT NULL,
    member_zone_ids_json TEXT NOT NULL,
    track_uris_json TEXT NOT NULL,
    stream_uri TEXT,
    warnings_json TEXT NOT NULL DEFAULT '[]',
    live INTEGER NOT NULL DEFAULT 1,
    started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`,
  `CREATE INDEX IF NOT EXISTS activations_live ON activations (live, preset_id)`,

  `CREATE TABLE IF NOT EXISTS preset_triggers (
    id TEXT PRIMARY KEY,
    preset_id TEXT REFERENCES presets(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    config_json TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    last_fired_key TEXT,
    last_fired_at TEXT,
    last_skipped_reason TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`,
  `CREATE INDEX IF NOT EXISTS preset_triggers_enabled ON preset_triggers (enabled)`,

  `CREATE TABLE IF NOT EXISTS preset_rules (
    id TEXT PRIMARY KEY,
    preset_id TEXT NOT NULL REFERENCES presets(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    label TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    condition_json TEXT NOT NULL DEFAULT '{}',
    effect_json TEXT NOT NULL DEFAULT '{}'
  )`,
  `CREATE INDEX IF NOT EXISTS preset_rules_preset ON preset_rules (preset_id, position)`,

  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
]

export function openDatabase(options: { dataDir: string } | { inMemory: true }) {
  const file = 'inMemory' in options ? ':memory:' : join(options.dataDir, 'domovoi.db')
  if (!('inMemory' in options)) mkdirSync(dirname(file), { recursive: true })

  const sqlite = new Database(file)
  // WAL survives an unclean container stop far better than the default journal.
  if (!('inMemory' in options)) sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')

  // The original `triggers` table declared preset_id NOT NULL, which a
  // system-wide trigger can't satisfy. Nothing ever wrote to it, so drop it —
  // but only if it really is empty, rather than trusting that.
  try {
    const legacy = sqlite
      .prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name='triggers'")
      .get() as { count: number }
    if (legacy.count > 0) {
      const rows = sqlite.prepare('SELECT count(*) AS count FROM triggers').get() as {
        count: number
      }
      if (rows.count === 0) sqlite.exec('DROP TABLE triggers')
    }
  } catch {
    // Leaving it in place is harmless; nothing reads it.
  }

  for (const statement of DDL) {
    try {
      sqlite.exec(statement)
    } catch (err) {
      // Only "column already exists" from the ALTERs above is survivable.
      if (!(err instanceof Error) || !/duplicate column name/i.test(err.message)) throw err
    }
  }

  return drizzle(sqlite, { schema })
}
