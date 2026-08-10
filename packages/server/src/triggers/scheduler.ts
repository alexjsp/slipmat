import type { ScheduleConfig, SleepTimerConfig, TvPausesMusicConfig } from '@slipmat/shared'
import type { Logger } from '../logger.js'
import type { ActivationEngine } from '../presets/activate.js'
import { pauseAllMusic } from '../presets/pause-all.js'
import type { PresetRepository } from '../presets/repository.js'
import { clockFrom } from '../presets/rules.js'
import type { SonosDriver } from '../sonos/driver.js'
import type { SystemStateStore } from '../state/store.js'
import { isScheduleDue, sleepTimerExpired } from './matching.js'
import type { TriggerRepository } from './repository.js'

/**
 * Ticks well inside a minute so an occurrence isn't missed, with the
 * once-per-occurrence guarantee coming from the dedupe key rather than from
 * timer precision.
 */
const TICK_MS = 20 * 1000

export type SchedulerDeps = {
  triggers: TriggerRepository
  presets: PresetRepository
  engine: ActivationEngine
  driver: SonosDriver
  store: SystemStateStore
  logger: Logger
  timeZone: string
  now?: () => Date
}

export class Scheduler {
  private readonly logger: Logger
  private timer: NodeJS.Timeout | undefined
  private running = false
  /** Zones seen playing TV on the previous tick, for edge detection. */
  private tvZones: Set<string> | undefined
  private readonly onStoreChange = () => void this.checkTvTriggers()

  constructor(private readonly deps: SchedulerDeps) {
    this.logger = deps.logger.child({ component: 'scheduler' })
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))()
  }

  start() {
    // Seed from current reality so a TV already on at startup isn't treated as
    // having just turned on.
    this.tvZones = this.currentTvZones()
    this.deps.store.on('change', this.onStoreChange)
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref()
    this.logger.info({ timeZone: this.deps.timeZone }, 'scheduler started')
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.deps.store.off('change', this.onStoreChange)
  }

  /** One pass over schedules and sleep timers. Safe to call directly in tests. */
  async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      await this.runSchedules()
      await this.runSleepTimers()
    } catch (err) {
      this.logger.error({ err }, 'scheduler tick failed')
    } finally {
      this.running = false
    }
  }

  // --- schedules ----------------------------------------------------------

  private async runSchedules() {
    const now = this.now()
    const clock = clockFrom(now, this.deps.timeZone)

    for (const row of this.deps.triggers.rowsFor('schedule')) {
      const config = JSON.parse(row.configJson) as ScheduleConfig
      const due = isScheduleDue(config, clock, row.id, row.lastFiredKey)
      if (!due) continue

      const skipped = await this.runScheduleAction(row.id, row.presetId, config)
      // Recorded either way: a skipped occurrence must not be retried on the
      // next tick within the same minute.
      this.deps.triggers.recordFired(row.id, due.key, skipped)
    }
  }

  private async runScheduleAction(
    triggerId: string,
    presetId: string | null,
    config: ScheduleConfig,
  ): Promise<string | null> {
    if (config.action === 'pause_all') {
      const result = await pauseAllMusic({
        driver: this.deps.driver,
        store: this.deps.store,
        engine: this.deps.engine,
        logger: this.logger,
      })
      this.logger.info({ triggerId, paused: result.pausedGroupIds.length }, 'scheduled pause all')
      return null
    }

    if (!presetId) return 'No preset attached'
    const preset = this.deps.presets.get(presetId)
    if (!preset) return 'Preset no longer exists'

    if (config.action === 'stop') {
      const stopped = await this.deps.engine.stop(preset.id)
      this.logger.info({ triggerId, preset: preset.name, stopped }, 'scheduled stop')
      return stopped ? null : 'Was not playing'
    }

    if (config.skipIfPlaying) {
      const busy = this.zonesBusyElsewhere(
        preset.zones.map((zone) => zone.zoneId),
        preset.id,
      )
      if (busy) {
        this.logger.info(
          { triggerId, preset: preset.name, busy },
          'schedule skipped; already playing',
        )
        return `${busy} was already playing`
      }
    }

    try {
      const result = await this.deps.engine.activate(preset)
      this.logger.info(
        { triggerId, preset: preset.name, noop: result.noop, warnings: result.warnings },
        'scheduled activation',
      )
      return result.warnings.length > 0 ? result.warnings.join('. ') : null
    } catch (err) {
      this.logger.warn({ err, triggerId, preset: preset.name }, 'scheduled activation failed')
      return err instanceof Error ? err.message : 'Activation failed'
    }
  }

  /**
   * Is something *else* already playing in these rooms?
   *
   * The preset's own music doesn't count — a schedule that overlaps a still-running
   * activation of the same preset should be a no-op, not a "skipped" report.
   */
  private zonesBusyElsewhere(zoneIds: string[], presetId: string): string | null {
    if (this.deps.engine.isStillPlaying(presetId)) return null

    const snapshot = this.deps.driver.snapshot()
    const mine = new Set(zoneIds)
    for (const group of snapshot.groups) {
      if (group.transportState !== 'PLAYING') continue
      if (!group.memberZoneIds.some((zoneId) => mine.has(zoneId))) continue
      const zone = snapshot.zones.find((entry) => entry.id === group.coordinatorZoneId)
      return zone?.name ?? group.coordinatorZoneId
    }
    return null
  }

  // --- sleep timers -------------------------------------------------------

  private async runSleepTimers() {
    const now = this.now()

    for (const row of this.deps.triggers.rowsFor('sleep_timer')) {
      if (!row.presetId) continue
      const config = JSON.parse(row.configJson) as SleepTimerConfig

      const activation = this.deps.engine.liveActivation(row.presetId)
      if (!activation) continue
      if (!sleepTimerExpired(activation.startedAt, config.minutes, now)) continue

      await this.deps.engine.stop(row.presetId)
      this.logger.info(
        { triggerId: row.id, presetId: row.presetId, minutes: config.minutes },
        'sleep timer stopped preset',
      )
      this.deps.triggers.recordFired(row.id, `${row.id}:${activation.id}`, null)
    }
  }

  // --- TV event -----------------------------------------------------------

  private currentTvZones(): Set<string> {
    const zones = new Set<string>()
    for (const group of this.deps.store.current.groups) {
      if (group.playbackKind === 'tv' && group.transportState === 'PLAYING') {
        for (const zoneId of group.memberZoneIds) zones.add(zoneId)
      }
    }
    return zones
  }

  /**
   * Fires on the *edge* of a TV starting, not while it stays on — otherwise
   * every state change would re-pause music someone had just started.
   */
  private async checkTvTriggers() {
    const rows = this.deps.triggers.rowsFor('tv_pauses_music')
    const current = this.currentTvZones()
    const previous = this.tvZones ?? current
    this.tvZones = current

    if (rows.length === 0) return

    const started = [...current].filter((zoneId) => !previous.has(zoneId))
    if (started.length === 0) return

    for (const row of rows) {
      const config = JSON.parse(row.configJson) as TvPausesMusicConfig
      const matches = config.zoneId ? started.includes(config.zoneId) : true
      if (!matches) continue

      // pauseAllMusic deliberately skips TV and line-in, so this cannot silence
      // the thing that triggered it, and cannot loop.
      const result = await pauseAllMusic({
        driver: this.deps.driver,
        store: this.deps.store,
        engine: this.deps.engine,
        logger: this.logger,
      })
      this.logger.info(
        { triggerId: row.id, zones: started, paused: result.pausedGroupIds.length },
        'TV turned on; paused music',
      )
      this.deps.triggers.recordFired(row.id, `${row.id}:${Date.now()}`, null)
    }
  }
}
