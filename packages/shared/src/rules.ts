import { z } from 'zod'

/** `HH:MM`, 24-hour. */
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM, 24-hour')
/** `MM-DD` — no year, so a range recurs every year. */
const monthDaySchema = z.string().regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'Use MM-DD')

export const ruleConditionSchema = z.object({
  /** 0 = Sunday … 6 = Saturday. Empty or absent means any day. */
  daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
  /** 1 = January … 12 = December. */
  months: z.array(z.number().int().min(1).max(12)).optional(),
  /** Recurring yearly window; `from` after `to` wraps the new year. */
  dateRange: z.object({ from: monthDaySchema, to: monthDaySchema }).optional(),
  /** `from` after `to` wraps midnight, e.g. 21:00–05:00. */
  timeOfDay: z.object({ from: timeSchema, to: timeSchema }).optional(),
})
export type RuleCondition = z.infer<typeof ruleConditionSchema>

export const ruleSourceSchema = z.object({
  kind: z.enum(['sonos_playlist', 'sonos_favorite', 'library_container', 'service_url', 'raw_uri']),
  ref: z.string().min(1),
  label: z.string().min(1),
})
export type RuleSource = z.infer<typeof ruleSourceSchema>

/**
 * Take a different one of these each day (or week), in order, forever.
 *
 * The pick is a function of the date alone, so it is the same however many
 * times the preset is fired today, and the editor's preview can be trusted.
 */
export const rotationSchema = z.object({
  sources: z.array(ruleSourceSchema).min(1),
  period: z.enum(['day', 'week']).default('day'),
})
export type Rotation = z.infer<typeof rotationSchema>

export const ruleEffectSchema = z.object({
  /** Appended to whatever the preset has accumulated so far. */
  addSources: z.array(ruleSourceSchema).optional(),
  /** Discards everything accumulated so far. The deliberate override. */
  replaceSources: z.array(ruleSourceSchema).optional(),
  /** Appends exactly one of its sources, chosen by today's date. */
  rotateSources: rotationSchema.optional(),
  /** Applied to every zone in the preset, clamped to 0–100. */
  volumeDelta: z.number().int().min(-100).max(100).optional(),
  /** Wins over `volumeDelta` when both are set. */
  volumeAbsolute: z.number().int().min(0).max(100).optional(),
  shuffle: z.boolean().optional(),
  repeatAll: z.boolean().optional(),
  crossfade: z.boolean().optional(),
  pauseOthers: z.boolean().optional(),
})
export type RuleEffect = z.infer<typeof ruleEffectSchema>

export const presetRuleSchema = z.object({
  id: z.string(),
  presetId: z.string(),
  position: z.number().int().min(0),
  /** Shown in the editor, e.g. "Thursdays" or "Wind down". */
  label: z.string(),
  enabled: z.boolean(),
  condition: ruleConditionSchema,
  effect: ruleEffectSchema,
})
export type PresetRule = z.infer<typeof presetRuleSchema>

export const presetRuleInputSchema = z.object({
  label: z.string().min(1).max(60),
  enabled: z.boolean().default(true),
  condition: ruleConditionSchema,
  effect: ruleEffectSchema,
})
export type PresetRuleInput = z.infer<typeof presetRuleInputSchema>

/**
 * Every source these rules could ever contribute, in order, without repeats.
 *
 * One list for the three jobs that need it: warming the cache, keeping resolved
 * sources fresh, and showing what a preset plays when the rules are all it has.
 */
export function sourcesFromRules(rules: Array<{ effect: RuleEffect }>): RuleSource[] {
  const seen = new Set<string>()
  const sources: RuleSource[] = []
  for (const { effect } of rules) {
    for (const source of [
      ...(effect.addSources ?? []),
      ...(effect.replaceSources ?? []),
      ...(effect.rotateSources?.sources ?? []),
    ]) {
      const key = `${source.kind}:${source.ref}`
      if (seen.has(key)) continue
      seen.add(key)
      sources.push({ kind: source.kind, ref: source.ref, label: source.label })
    }
  }
  return sources
}

/** No clause to fail, so this rule applies whatever the date. */
export function isUnconditional(condition: RuleCondition): boolean {
  // Empty arrays mean "any", the same as absent — that is how the matcher
  // reads them, and disagreeing here would promise music that never arrives.
  return (
    !condition.daysOfWeek?.length &&
    !condition.months?.length &&
    !condition.dateRange &&
    !condition.timeOfDay
  )
}

/**
 * Will these rules put something in the queue on every day of the year?
 *
 * What lets a preset have no sources of its own: "rotate through these three
 * playlists" is a complete instruction, and demanding a base source as well
 * meant one of the three had to play every day.
 */
export function rulesGuaranteeASource(
  rules: Array<{ enabled: boolean; condition: RuleCondition; effect: RuleEffect }>,
): boolean {
  // An empty replace is "play nothing", and it can appear behind any condition,
  // so nothing downstream of it is guaranteed.
  if (rules.some((rule) => rule.enabled && rule.effect.replaceSources?.length === 0)) return false

  return rules.some((rule) => {
    if (!rule.enabled || !isUnconditional(rule.condition)) return false
    const { addSources, replaceSources, rotateSources } = rule.effect
    return !!(addSources?.length || replaceSources?.length || rotateSources?.sources.length)
  })
}

/** What a preset would actually do, once rules have been applied. */
export const effectivePresetSchema = z.object({
  sources: z.array(ruleSourceSchema),
  zoneVolumes: z.array(z.object({ zoneId: z.string(), zoneName: z.string(), volume: z.number() })),
  shuffle: z.boolean(),
  repeatAll: z.boolean(),
  crossfade: z.boolean(),
  pauseOthers: z.boolean(),
  /** Labels of the rules that matched, so the UI can explain the outcome. */
  appliedRuleLabels: z.array(z.string()),
})
export type EffectivePreset = z.infer<typeof effectivePresetSchema>
