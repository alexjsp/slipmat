import { z } from 'zod'

/** Which part of a track a rule looks at. */
export const blockFieldSchema = z.enum(['any', 'title', 'artist', 'album'])
export type BlockField = z.infer<typeof blockFieldSchema>

/**
 * How the pattern is compared.
 *
 * `is` and `contains` are plain text, which is what almost every rule wants —
 * naming an artist, or catching a word. `matches` is a regular expression, for
 * the times nothing simpler will do.
 */
export const blockMatchSchema = z.enum(['is', 'contains', 'matches'])
export type BlockMatch = z.infer<typeof blockMatchSchema>

export const blockRuleSchema = z.object({
  field: blockFieldSchema.default('any'),
  match: blockMatchSchema.default('contains'),
  pattern: z.string().min(1).max(200),
  /** Off keeps a rule around without applying it, which beats deleting to test. */
  enabled: z.boolean().default(true),
})
export type BlockRule = z.infer<typeof blockRuleSchema>

export const blocklistSchema = z.array(blockRuleSchema).max(200)
export type Blocklist = z.infer<typeof blocklistSchema>
