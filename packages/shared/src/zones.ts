import { z } from 'zod'

/**
 * How a group is getting its audio. Anything other than `queue` or `stream` is
 * non-shufflable, and `tv` / `line-in` are deliberately left alone by pause-all.
 */
export const playbackKindSchema = z.enum([
  'queue', // the Sonos queue (what presets build)
  'stream', // radio / non-skippable stream
  'tv', // home theatre: x-sonos-htastream:
  'line-in', // x-rincon-stream:
  'idle',
  'unknown',
])
export type PlaybackKind = z.infer<typeof playbackKindSchema>

export const transportStateSchema = z.enum([
  'PLAYING',
  'PAUSED_PLAYBACK',
  'STOPPED',
  'TRANSITIONING',
])
export type TransportState = z.infer<typeof transportStateSchema>

/**
 * A zone is a room, not a device. Bonded satellites and subs are folded into
 * their coordinator and never surface here; a stereo pair is one zone.
 */
export const zoneSchema = z.object({
  id: z.string(), // the coordinating device's UUID (RINCON_...)
  name: z.string(),
  volume: z.number().int().min(0).max(100),
  muted: z.boolean(),
  /** Zone can't be controlled right now (offline, or subscription lost). */
  unreachable: z.boolean().default(false),
  /** Bonded members folded into this zone, for display only. */
  bondedDeviceCount: z.number().int().min(1).default(1),
})
export type Zone = z.infer<typeof zoneSchema>

export const trackSchema = z.object({
  uri: z.string(),
  title: z.string().nullable(),
  artist: z.string().nullable(),
  album: z.string().nullable(),
  /** Already rewritten to point at our own /api/art proxy. */
  artUrl: z.string().nullable(),
  durationSeconds: z.number().nullable(),
})
export type Track = z.infer<typeof trackSchema>

export const groupSchema = z.object({
  id: z.string(), // coordinator zone id
  coordinatorZoneId: z.string(),
  memberZoneIds: z.array(z.string()),
  transportState: transportStateSchema,
  playbackKind: playbackKindSchema,
  currentTrack: trackSchema.nullable(),
  positionSeconds: z.number().nullable(),
  /** Group-level volume, the average Sonos itself reports. */
  volume: z.number().int().min(0).max(100),
  muted: z.boolean(),
  /** Populated when this group was started by a preset and still matches it. */
  activePresetId: z.string().nullable(),
})
export type Group = z.infer<typeof groupSchema>

export const systemStateSchema = z.object({
  /** False until discovery has found at least one device. */
  ready: z.boolean(),
  householdId: z.string().nullable(),
  zones: z.array(zoneSchema),
  groups: z.array(groupSchema),
  /** Bumped on every change so clients can detect dropped WebSocket frames. */
  revision: z.number().int(),
})
export type SystemState = z.infer<typeof systemStateSchema>
