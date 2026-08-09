import type { EffectivePreset, Preset, PresetRule, RuleCondition } from '@domovoi/shared'

/**
 * Rule evaluation is a pure function of (preset, rules, now).
 *
 * Kept free of I/O and of `new Date()` so it can be tested exhaustively and so
 * the editor can answer "what would this do right now?" without touching a
 * speaker. Rules are evaluated once, at activation — a preset started at 20:59
 * does not mutate into the wind-down version at 21:00.
 */

/** Local wall-clock fields, in the configured timezone rather than the host's. */
export type Clock = {
  /** 0 = Sunday … 6 = Saturday. */
  dayOfWeek: number
  /** 1–12. */
  month: number
  /** 1–31. */
  day: number
  /** Minutes since local midnight. */
  minutes: number
}

export function clockFrom(now: Date, timeZone: string): Clock {
  // `en-GB` + explicit parts avoids depending on the host locale for ordering.
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now)

  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  const weekdays: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  }

  // 24-hour formatting yields "24" for midnight in some ICU versions.
  const hour = Number(get('hour')) % 24

  return {
    dayOfWeek: weekdays[get('weekday')] ?? 0,
    month: Number(get('month')),
    day: Number(get('day')),
    minutes: hour * 60 + Number(get('minute')),
  }
}

function parseTime(value: string): number {
  const [hours, minutes] = value.split(':')
  return Number(hours) * 60 + Number(minutes)
}

function parseMonthDay(value: string): number {
  const [month, day] = value.split('-')
  // Ordinal within a year: comparable without needing a real date.
  return Number(month) * 100 + Number(day)
}

/**
 * Inclusive window that wraps when `from > to`.
 *
 * Wrapping is the normal case here, not an edge case: "21:00–05:00" and
 * "12-20 to 01-05" both have to mean the obvious thing.
 */
function inWrappingRange(value: number, from: number, to: number): boolean {
  return from <= to ? value >= from && value <= to : value >= from || value <= to
}

export function conditionMatches(condition: RuleCondition, clock: Clock): boolean {
  if (condition.daysOfWeek?.length && !condition.daysOfWeek.includes(clock.dayOfWeek)) return false
  if (condition.months?.length && !condition.months.includes(clock.month)) return false

  if (condition.dateRange) {
    const today = clock.month * 100 + clock.day
    const from = parseMonthDay(condition.dateRange.from)
    const to = parseMonthDay(condition.dateRange.to)
    if (!inWrappingRange(today, from, to)) return false
  }

  if (condition.timeOfDay) {
    const from = parseTime(condition.timeOfDay.from)
    const to = parseTime(condition.timeOfDay.to)
    if (!inWrappingRange(clock.minutes, from, to)) return false
  }

  return true
}

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)))

/**
 * Apply every matching rule, in order, to a working copy of the preset.
 *
 * All matches apply rather than first-match-wins, so "December" and "Thursday"
 * compose naturally; `replaceSources` exists for when override semantics are
 * actually wanted.
 */
export function evaluateRules(preset: Preset, rules: PresetRule[], clock: Clock): EffectivePreset {
  const effective: EffectivePreset = {
    sources: preset.sources.map((source) => ({
      kind: source.kind,
      ref: source.ref,
      label: source.label,
    })),
    zoneVolumes: preset.zones.map((zone) => ({
      zoneId: zone.zoneId,
      zoneName: zone.zoneName,
      volume: zone.volume,
    })),
    repeatAll: preset.repeatAll,
    crossfade: preset.crossfade,
    pauseOthers: preset.pauseOthers,
    appliedRuleLabels: [],
  }

  const ordered = [...rules].sort((a, b) => a.position - b.position)

  for (const rule of ordered) {
    if (!rule.enabled) continue
    if (!conditionMatches(rule.condition, clock)) continue

    const { effect } = rule

    if (effect.replaceSources) {
      effective.sources = [...effect.replaceSources]
    }
    if (effect.addSources) {
      effective.sources = [...effective.sources, ...effect.addSources]
    }
    if (effect.volumeAbsolute !== undefined) {
      const absolute = effect.volumeAbsolute
      effective.zoneVolumes = effective.zoneVolumes.map((zone) => ({
        ...zone,
        volume: clamp(absolute),
      }))
    } else if (effect.volumeDelta !== undefined) {
      const delta = effect.volumeDelta
      effective.zoneVolumes = effective.zoneVolumes.map((zone) => ({
        ...zone,
        volume: clamp(zone.volume + delta),
      }))
    }
    if (effect.repeatAll !== undefined) effective.repeatAll = effect.repeatAll
    if (effect.crossfade !== undefined) effective.crossfade = effect.crossfade
    if (effect.pauseOthers !== undefined) effective.pauseOthers = effect.pauseOthers

    effective.appliedRuleLabels.push(rule.label)
  }

  // Two rules can legitimately contribute the same playlist; queueing it twice
  // would skew the shuffle towards it.
  const seen = new Set<string>()
  effective.sources = effective.sources.filter((source) => {
    const key = `${source.kind}:${source.ref}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  return effective
}
