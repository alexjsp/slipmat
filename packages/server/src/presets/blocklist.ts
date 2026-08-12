import type { BlockRule } from '@slipmat/shared'
import type { Logger } from '../logger.js'

export type BlockableTrack = {
  title?: string | null
  artist?: string | null
  album?: string | null
}

/**
 * A rule compiled once, ready to run against a whole queue.
 *
 * Compiled up front rather than per track: a two-thousand-track queue against a
 * handful of rules is a lot of matching, and an invalid regular expression
 * should be reported once when it is used rather than once per track.
 */
type CompiledRule = { field: BlockRule['field']; test: (value: string) => boolean }

export function compileBlocklist(rules: BlockRule[], logger?: Logger): CompiledRule[] {
  const compiled: CompiledRule[] = []
  for (const rule of rules) {
    if (!rule.enabled) continue

    if (rule.match === 'is') {
      // Whole field, so "artist is Wham!" does not also catch a compilation
      // that happens to mention them.
      const needle = rule.pattern.trim().toLowerCase()
      compiled.push({ field: rule.field, test: (value) => value.trim().toLowerCase() === needle })
      continue
    }

    if (rule.match === 'contains') {
      const needle = rule.pattern.toLowerCase()
      compiled.push({ field: rule.field, test: (value) => value.toLowerCase().includes(needle) })
      continue
    }

    try {
      const expression = new RegExp(rule.pattern, 'i')
      compiled.push({ field: rule.field, test: (value) => expression.test(value) })
    } catch (err) {
      // A pattern that will not compile is the author's mistake, and silently
      // applying nothing would look exactly like a rule that matches nothing.
      logger?.warn({ err, pattern: rule.pattern }, 'ignoring an invalid blocklist expression')
    }
  }
  return compiled
}

/** True when any rule matches, i.e. this track should not play. */
export function isBlocked(track: BlockableTrack, rules: CompiledRule[]): boolean {
  if (rules.length === 0) return false
  const fields = {
    title: track.title ?? '',
    artist: track.artist ?? '',
    album: track.album ?? '',
  }
  return rules.some((rule) => {
    if (rule.field === 'any') {
      return rule.test(fields.title) || rule.test(fields.artist) || rule.test(fields.album)
    }
    const value = fields[rule.field]
    // An empty field cannot match: a rule looking for "" in an unknown artist
    // would block the entire queue.
    return value !== '' && rule.test(value)
  })
}
