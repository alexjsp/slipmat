import { z } from 'zod'

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM, 24-hour')

/**
 * What a schedule does when it fires. `pause_all` is the system-wide action and
 * is the one kind that isn't attached to a preset.
 */
export const scheduleActionSchema = z.enum(['activate', 'stop', 'pause_all'])
export type ScheduleAction = z.infer<typeof scheduleActionSchema>

export const triggerKindSchema = z.enum(['schedule', 'sleep_timer', 'tv_pauses_music'])
export type TriggerKind = z.infer<typeof triggerKindSchema>

export const scheduleConfigSchema = z.object({
  /** 0 = Sunday … 6 = Saturday. Empty means every day. */
  daysOfWeek: z.array(z.number().int().min(0).max(6)).default([]),
  time: timeSchema,
  action: scheduleActionSchema,
  /**
   * Skip rather than take over when the preset's speakers are already playing
   * something. Defaults on: a schedule fires unattended, and stomping on
   * whatever someone deliberately put on is worse than not running.
   */
  skipIfPlaying: z.boolean().default(true),
})
export type ScheduleConfig = z.infer<typeof scheduleConfigSchema>

export const sleepTimerConfigSchema = z.object({
  /** Minutes after the preset starts, at which point it is stopped. */
  minutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60),
})
export type SleepTimerConfig = z.infer<typeof sleepTimerConfigSchema>

export const tvPausesMusicConfigSchema = z.object({
  /** Watch one zone, or every zone when null. */
  zoneId: z.string().nullable().default(null),
})
export type TvPausesMusicConfig = z.infer<typeof tvPausesMusicConfigSchema>

export const triggerSchema = z.object({
  id: z.string(),
  /** Null for system-wide triggers: scheduled Pause All, and the TV rule. */
  presetId: z.string().nullable(),
  presetName: z.string().nullable(),
  kind: triggerKindSchema,
  label: z.string(),
  enabled: z.boolean(),
  config: z.union([scheduleConfigSchema, sleepTimerConfigSchema, tvPausesMusicConfigSchema]),
  lastFiredAt: z.string().datetime().nullable(),
  /** Why the last run did nothing, when it did nothing. */
  lastSkippedReason: z.string().nullable(),
  createdAt: z.string().datetime(),
})
export type Trigger = z.infer<typeof triggerSchema>

export const triggerInputSchema = z
  .object({
    presetId: z.string().nullable().default(null),
    kind: triggerKindSchema,
    label: z.string().max(60).default(''),
    enabled: z.boolean().default(true),
    config: z.unknown(),
  })
  .superRefine((value, ctx) => {
    // The config shape depends on the kind, and the pairing of kind to
    // preset/no-preset is a correctness rule rather than a formality: a
    // schedule that stops "nothing" would silently never do anything.
    if (value.kind === 'schedule') {
      const parsed = scheduleConfigSchema.safeParse(value.config)
      if (!parsed.success) {
        ctx.addIssue({ code: 'custom', message: 'Invalid schedule', path: ['config'] })
        return
      }
      if (parsed.data.action === 'pause_all' && value.presetId) {
        ctx.addIssue({
          code: 'custom',
          message: 'Pause all is not tied to a preset',
          path: ['presetId'],
        })
      }
      if (parsed.data.action !== 'pause_all' && !value.presetId) {
        ctx.addIssue({ code: 'custom', message: 'Choose a preset', path: ['presetId'] })
      }
    }
    if (value.kind === 'sleep_timer') {
      if (!sleepTimerConfigSchema.safeParse(value.config).success) {
        ctx.addIssue({ code: 'custom', message: 'Invalid sleep timer', path: ['config'] })
      }
      if (!value.presetId) {
        ctx.addIssue({ code: 'custom', message: 'Choose a preset', path: ['presetId'] })
      }
    }
    if (value.kind === 'tv_pauses_music') {
      if (!tvPausesMusicConfigSchema.safeParse(value.config).success) {
        ctx.addIssue({ code: 'custom', message: 'Invalid TV trigger', path: ['config'] })
      }
    }
  })
export type TriggerInput = z.infer<typeof triggerInputSchema>

export const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
