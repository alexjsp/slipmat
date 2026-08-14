import { z } from 'zod'
import { presetRuleInputSchema, ruleSourceSchema } from './rules.js'
import { presetSourceSchema } from './sources.js'

export const presetZoneSchema = z.object({
  zoneId: z.string(),
  /** Display name captured at save time, so a preset still reads sensibly if a zone vanishes. */
  zoneName: z.string(),
  volume: z.number().int().min(0).max(100),
  isCoordinator: z.boolean(),
})
export type PresetZone = z.infer<typeof presetZoneSchema>

/**
 * Shrink the group partway through, leaving the music in fewer rooms.
 *
 * The case this exists for is bedtime: start the same music everywhere while
 * the house winds down, then keep it going in the bedroom alone. Expressed as a
 * property of the preset rather than a separate trigger, because it is part of
 * what the scene *is*.
 *
 * `keepZoneIds` must include the coordinator. Sonos keeps the queue on the
 * coordinator and a zone that leaves a group gets its own empty one, so
 * "keeping" a follower would hand you silence in the one room you cared about.
 */
export const presetShrinkSchema = z.object({
  afterMinutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60),
  keepZoneIds: z.array(z.string()).min(1),
})
export type PresetShrink = z.infer<typeof presetShrinkSchema>

export const presetSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(60),
  icon: z.string().nullable(),
  color: z.string().nullable(),
  zones: z.array(presetZoneSchema).min(1),
  /**
   * May be empty when the preset's rules supply the music instead — a preset
   * that only rotates through three playlists has no base of its own.
   */
  sources: z.array(presetSourceSchema),
  /**
   * Everything the preset's rules could contribute, deduplicated.
   *
   * Derived rather than stored, and filled in by the API alongside the resolver
   * metadata on `sources`. A preset that owns nothing and rotates through three
   * playlists would otherwise show an empty line where its music should be.
   */
  ruleSources: z.array(ruleSourceSchema).default([]),
  /** Off plays every source end to end, in the order they were added. */
  shuffle: z.boolean(),
  repeatAll: z.boolean(),
  dedupe: z.boolean(),
  /** Pause every other group in the house before starting. */
  pauseOthers: z.boolean(),
  crossfade: z.boolean(),
  /** Drop back to fewer rooms after a while. Null leaves the group alone. */
  shrink: presetShrinkSchema.nullable(),
  homekitEnabled: z.boolean(),
  webhookToken: z.string(),
  position: z.number().int().min(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})
export type Preset = z.infer<typeof presetSchema>

/** What the UI sends when creating or editing. Server owns ids, tokens, timestamps. */
export const presetInputSchema = z
  .object({
    name: z.string().min(1).max(60),
    icon: z.string().nullable().default(null),
    color: z.string().nullable().default(null),
    zones: z
      .array(
        z.object({
          zoneId: z.string(),
          volume: z.number().int().min(0).max(100),
          isCoordinator: z.boolean().default(false),
        }),
      )
      .min(1),
    /**
     * May be empty when `rules` supplies the music instead. The two are
     * validated together, so neither can be saved leaving nothing to play.
     */
    sources: z.array(
      z.object({
        kind: presetSourceSchema.shape.kind,
        ref: z.string().min(1),
        label: z.string().min(1),
      }),
    ),
    /**
     * Sent with the preset so a rotation and the preset it belongs to land in
     * one transaction. Absent — as opposed to empty — leaves existing rules
     * alone, which is what an editor that could not load them should do.
     */
    rules: z.array(presetRuleInputSchema).optional(),
    shuffle: z.boolean().default(true),
    repeatAll: z.boolean().default(true),
    dedupe: z.boolean().default(true),
    pauseOthers: z.boolean().default(false),
    crossfade: z.boolean().default(false),
    shrink: presetShrinkSchema.nullable().default(null),
    homekitEnabled: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if (!value.shrink) return
    const zoneIds = new Set(value.zones.map((zone) => zone.zoneId))
    const unknown = value.shrink.keepZoneIds.filter((zoneId) => !zoneIds.has(zoneId))
    if (unknown.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'Keep only speakers this preset uses',
        path: ['shrink', 'keepZoneIds'],
      })
      return
    }
    // Without the coordinator there is nothing left holding the queue, so the
    // rooms you kept would go quiet — the exact opposite of the point.
    const coordinator = value.zones.find((zone) => zone.isCoordinator) ?? value.zones[0]
    if (coordinator && !value.shrink.keepZoneIds.includes(coordinator.zoneId)) {
      ctx.addIssue({
        code: 'custom',
        message: 'The speaker holding the queue has to be one of the ones you keep',
        path: ['shrink', 'keepZoneIds'],
      })
    }
    if (value.shrink.keepZoneIds.length >= value.zones.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'Keep fewer speakers than the preset starts with, or there is nothing to drop',
        path: ['shrink', 'keepZoneIds'],
      })
    }
  })
export type PresetInput = z.infer<typeof presetInputSchema>

export const presetStatusSchema = z.object({
  presetId: z.string(),
  /** The "loose" active-state answer that drives the UI badge and HomeKit. */
  active: z.boolean(),
  activationId: z.string().nullable(),
  startedAt: z.string().datetime().nullable(),
  /** Still enqueueing the tail of the pool in the background. */
  loading: z.boolean(),
  tracksEnqueued: z.number().int().min(0),
  tracksTotal: z.number().int().min(0).nullable(),
  /**
   * When this preset will drop back to fewer rooms, as an absolute time.
   *
   * A timestamp rather than a number of seconds so the UI can count down
   * smoothly between polls instead of jumping whenever a fresh figure lands.
   * Null when the preset has no wind-down, is not playing, or has already
   * wound down.
   */
  windDownAt: z.string().datetime().nullable(),
  warnings: z.array(z.string()),
})
export type PresetStatus = z.infer<typeof presetStatusSchema>

export const activationResultSchema = z.object({
  activationId: z.string(),
  /** True when the preset was already active and we deliberately did nothing. */
  noop: z.boolean(),
  warnings: z.array(z.string()),
})
export type ActivationResult = z.infer<typeof activationResultSchema>
