import type { ScheduleConfig } from '@slipmat/shared'
import { type Clock, clockFrom } from '../presets/rules.js'

/**
 * Deciding whether a schedule is due, as a pure function.
 *
 * Two rules drive the design:
 *
 * - **A missed schedule stays missed.** If Slipmat was down at 07:30 and starts
 *   at 07:45, nothing fires. So "due" means the current local minute *is* the
 *   scheduled minute — not "is at or past it".
 * - **Exactly once per occurrence.** The scheduler ticks more often than once a
 *   minute, so each occurrence gets a stable key and a trigger records the last
 *   key it fired. That also survives a restart inside the same minute.
 */

export type Occurrence = {
  /** Stable per (trigger, local date, time) — the dedupe key. */
  key: string
  clock: Clock
}

export function occurrenceKey(triggerId: string, clock: Clock, time: string): string {
  // Local date, so a schedule fires once per local day regardless of UTC offset.
  const date = `${clock.month.toString().padStart(2, '0')}-${clock.day.toString().padStart(2, '0')}`
  return `${triggerId}:${date}:${time}`
}

function parseTime(value: string): { hours: number; minutes: number } {
  const [hours, minutes] = value.split(':')
  return { hours: Number(hours), minutes: Number(minutes) }
}

/**
 * Is this schedule due right now?
 *
 * `lastFiredKey` is whatever the trigger last fired, so a tick that lands twice
 * in the same minute only acts once.
 */
export function isScheduleDue(
  schedule: ScheduleConfig,
  clock: Clock,
  triggerId: string,
  lastFiredKey: string | null,
): Occurrence | null {
  if (schedule.daysOfWeek.length > 0 && !schedule.daysOfWeek.includes(clock.dayOfWeek)) return null

  const { hours, minutes } = parseTime(schedule.time)
  if (clock.minutes !== hours * 60 + minutes) return null

  const key = occurrenceKey(triggerId, clock, schedule.time)
  if (key === lastFiredKey) return null

  return { key, clock }
}

/** Convenience for callers holding a Date rather than a Clock. */
export function scheduleDueAt(
  schedule: ScheduleConfig,
  now: Date,
  timeZone: string,
  triggerId: string,
  lastFiredKey: string | null,
): Occurrence | null {
  return isScheduleDue(schedule, clockFrom(now, timeZone), triggerId, lastFiredKey)
}

/**
 * Has a running preset outlived its sleep timer?
 *
 * Derived from the activation's start time rather than an in-memory timer, so a
 * restart mid-doze still stops the music at the right moment instead of leaving
 * it playing all night.
 */
export function sleepTimerExpired(startedAt: string, minutes: number, now: Date): boolean {
  const elapsedMs = now.getTime() - new Date(startedAt).getTime()
  return elapsedMs >= minutes * 60 * 1000
}

/** Minutes remaining, for the UI. Negative means overdue. */
export function sleepTimerRemaining(startedAt: string, minutes: number, now: Date): number {
  const elapsedMs = now.getTime() - new Date(startedAt).getTime()
  return Math.ceil(minutes - elapsedMs / 60000)
}

/**
 * Next occurrence of a schedule, as a human string for the UI.
 *
 * Deliberately approximate — it walks forward day by day rather than doing
 * timezone arithmetic, because being an hour out across a DST boundary in a
 * hint line is not worth the complexity of getting it exactly right.
 */
export function describeSchedule(schedule: ScheduleConfig, dayLabels: readonly string[]): string {
  const days =
    schedule.daysOfWeek.length === 0
      ? 'Every day'
      : schedule.daysOfWeek.length === 7
        ? 'Every day'
        : isWeekdays(schedule.daysOfWeek)
          ? 'Weekdays'
          : isWeekend(schedule.daysOfWeek)
            ? 'Weekends'
            : [...schedule.daysOfWeek]
                .sort((a, b) => a - b)
                .map((day) => dayLabels[day])
                .join(', ')
  return `${days} at ${schedule.time}`
}

function isWeekdays(days: number[]): boolean {
  const set = new Set(days)
  return set.size === 5 && [1, 2, 3, 4, 5].every((day) => set.has(day))
}

function isWeekend(days: number[]): boolean {
  const set = new Set(days)
  return set.size === 2 && set.has(0) && set.has(6)
}
