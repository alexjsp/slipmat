import { z } from 'zod'
import { presetSourceSchema } from './sources.js'

export const presetZoneSchema = z.object({
  zoneId: z.string(),
  /** Display name captured at save time, so a preset still reads sensibly if a zone vanishes. */
  zoneName: z.string(),
  volume: z.number().int().min(0).max(100),
  isCoordinator: z.boolean(),
})
export type PresetZone = z.infer<typeof presetZoneSchema>

export const presetSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(60),
  icon: z.string().nullable(),
  color: z.string().nullable(),
  zones: z.array(presetZoneSchema).min(1),
  sources: z.array(presetSourceSchema).min(1),
  repeatAll: z.boolean(),
  dedupe: z.boolean(),
  /** Pause every other group in the house before starting. */
  pauseOthers: z.boolean(),
  crossfade: z.boolean(),
  homekitEnabled: z.boolean(),
  webhookToken: z.string(),
  position: z.number().int().min(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})
export type Preset = z.infer<typeof presetSchema>

/** What the UI sends when creating or editing. Server owns ids, tokens, timestamps. */
export const presetInputSchema = z.object({
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
  sources: z
    .array(
      z.object({
        kind: presetSourceSchema.shape.kind,
        ref: z.string().min(1),
        label: z.string().min(1),
      }),
    )
    .min(1),
  repeatAll: z.boolean().default(true),
  dedupe: z.boolean().default(true),
  pauseOthers: z.boolean().default(false),
  crossfade: z.boolean().default(false),
  homekitEnabled: z.boolean().default(false),
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
