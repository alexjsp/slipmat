import { z } from 'zod'

export const seekRequestSchema = z.object({ positionSeconds: z.number().min(0) })
export const volumeRequestSchema = z.object({ volume: z.number().int().min(0).max(100) })
export const muteRequestSchema = z.object({ muted: z.boolean() })

export const groupJoinRequestSchema = z.object({
  /** Zones to pull into `coordinatorZoneId`'s group. */
  zoneIds: z.array(z.string()).min(1),
  coordinatorZoneId: z.string(),
})
export const groupLeaveRequestSchema = z.object({
  zoneIds: z.array(z.string()).min(1),
})

export const pauseAllResponseSchema = z.object({
  pausedGroupIds: z.array(z.string()),
  /** Groups deliberately left alone: TV and line-in. */
  skippedGroupIds: z.array(z.string()),
})
export type PauseAllResponse = z.infer<typeof pauseAllResponseSchema>

export const loginRequestSchema = z.object({ password: z.string().min(1) })

export const apiErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
})
export type ApiError = z.infer<typeof apiErrorSchema>
