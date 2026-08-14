import { sourcesFromRules } from '@slipmat/shared'
import type { Logger } from '../logger.js'
import type { PresetRepository } from '../presets/repository.js'
import type { SourceCache } from './cache.js'
import type { SourceInput } from './resolver.js'

/** How often to re-expand streaming containers used by presets. */
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000
/** Give discovery and the first event burst time to settle before borrowing anything. */
const STARTUP_DELAY_MS = 60 * 1000

export type SourceRefresherDeps = {
  repo: PresetRepository
  cache: SourceCache
  logger: Logger
  intervalMs?: number
}

/**
 * Keeps expensive sources current in the background.
 *
 * Cheap sources are re-resolved inline on every activation, so this only exists
 * for streaming containers: expanding one borrows an idle speaker's queue,
 * which is fine to do quietly on a timer but not while someone is waiting for
 * a preset button to make sound. Without it, a weekly-updating playlist would
 * serve its previous contents until something happened to refresh it.
 */
export class SourceRefresher {
  private timer: NodeJS.Timeout | undefined
  private startupTimer: NodeJS.Timeout | undefined
  private readonly logger: Logger
  private running = false

  constructor(private readonly deps: SourceRefresherDeps) {
    this.logger = deps.logger.child({ component: 'refresher' })
  }

  start() {
    const interval = this.deps.intervalMs ?? DEFAULT_INTERVAL_MS
    this.startupTimer = setTimeout(() => {
      void this.runOnce()
      this.timer = setInterval(() => void this.runOnce(), interval)
      this.timer.unref()
    }, STARTUP_DELAY_MS)
    this.startupTimer.unref()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    if (this.startupTimer) clearTimeout(this.startupTimer)
  }

  /** Re-resolve every expensive source referenced by a preset or one of its rules. */
  async runOnce(): Promise<number> {
    if (this.running) return 0
    this.running = true
    let refreshed = 0

    try {
      for (const source of this.collectSources()) {
        const cached = this.deps.cache.peek(source)
        // Unknown sources get resolved on first use; cheap ones inline. Neither
        // needs the timer.
        if (!cached?.expensive) continue
        try {
          await this.deps.cache.refresh(source)
          refreshed += 1
        } catch (err) {
          this.logger.warn({ err, ref: source.ref }, 'scheduled refresh failed')
        }
      }
      if (refreshed > 0) this.logger.info({ refreshed }, 'refreshed streaming sources')
    } finally {
      this.running = false
    }

    return refreshed
  }

  private collectSources(): SourceInput[] {
    const seen = new Set<string>()
    const sources: SourceInput[] = []

    const add = (source: SourceInput) => {
      const key = `${source.kind}:${source.ref}`
      if (seen.has(key)) return
      seen.add(key)
      sources.push(source)
    }

    for (const preset of this.deps.repo.list()) {
      for (const source of preset.sources) {
        add({ kind: source.kind, ref: source.ref, label: source.label })
      }
      // Rules can introduce sources the base preset never mentions — a
      // Christmas playlist has to be current in December too, and every arm of
      // a rotation, not just today's, since tomorrow's is hours away.
      for (const source of sourcesFromRules(this.deps.repo.rulesFor(preset.id))) {
        add(source)
      }
    }

    return sources
  }
}
