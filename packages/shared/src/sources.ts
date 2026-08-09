import { z } from 'zod'

export const sourceKindSchema = z.enum([
  'sonos_playlist', // SQ:n
  'sonos_favorite', // FV:2/...
  'library_container', // A:ALBUM/..., A:ARTIST/..., A:GENRE/...
  'service_url', // pasted Spotify / Apple Music share URL
  'raw_uri', // escape hatch
])
export type SourceKind = z.infer<typeof sourceKindSchema>

/**
 * How well we can turn a source into individual tracks.
 * `container_only` sources can still be played whole under Sonos' own shuffle,
 * but cannot be cross-shuffled with other sources.
 */
export const resolutionModeSchema = z.enum(['tracks', 'container_only', 'stream'])
export type ResolutionMode = z.infer<typeof resolutionModeSchema>

export const presetSourceSchema = z.object({
  id: z.string(),
  kind: sourceKindSchema,
  /** Object id, service URI, or pasted URL — interpreted per `kind`. */
  ref: z.string(),
  label: z.string(),
  position: z.number().int().min(0),
  resolutionMode: resolutionModeSchema.nullable(),
  trackCount: z.number().int().min(0).nullable(),
  resolvedAt: z.string().datetime().nullable(),
  resolveError: z.string().nullable(),
})
export type PresetSource = z.infer<typeof presetSourceSchema>

/** A node in the browse tree (favourites / playlists / music library). */
export const browseItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
  artUrl: z.string().nullable(),
  /** Containers can be descended into; items cannot. */
  isContainer: z.boolean(),
  kind: sourceKindSchema,
  /** True for radio streams — usable only as a solo preset source. */
  isStream: z.boolean(),
})
export type BrowseItem = z.infer<typeof browseItemSchema>

export const browseResponseSchema = z.object({
  path: z.string(),
  breadcrumbs: z.array(z.object({ id: z.string(), title: z.string() })),
  items: z.array(browseItemSchema),
  total: z.number().int(),
})
export type BrowseResponse = z.infer<typeof browseResponseSchema>

export const resolveUrlRequestSchema = z.object({
  url: z.string().min(1),
})
export type ResolveUrlRequest = z.infer<typeof resolveUrlRequestSchema>

export const resolveUrlResponseSchema = z.object({
  kind: sourceKindSchema,
  ref: z.string(),
  label: z.string(),
  resolutionMode: resolutionModeSchema,
  trackCount: z.number().int().min(0).nullable(),
  /** A short preview so the user can sanity-check before saving. */
  sampleTracks: z.array(z.object({ title: z.string(), artist: z.string().nullable() })),
  warning: z.string().nullable(),
})
export type ResolveUrlResponse = z.infer<typeof resolveUrlResponseSchema>
