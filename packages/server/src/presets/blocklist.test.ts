import type { BlockRule } from '@slipmat/shared'
import { describe, expect, it } from 'vitest'
import { createLogger } from '../logger.js'
import { compileBlocklist, isBlocked } from './blocklist.js'

const logger = createLogger({ logLevel: 'error' })

const rule = (overrides: Partial<BlockRule>): BlockRule => ({
  field: 'any',
  match: 'contains',
  pattern: 'x',
  enabled: true,
  ...overrides,
})

const track = { title: 'Last Christmas', artist: 'Wham!', album: 'Music from the Edge of Heaven' }

const blocks = (rules: BlockRule[], candidate = track) =>
  isBlocked(candidate, compileBlocklist(rules, logger))

describe('blocklist', () => {
  it('matches plain text anywhere, ignoring case', () => {
    expect(blocks([rule({ pattern: 'christmas' })])).toBe(true)
    expect(blocks([rule({ pattern: 'WHAM' })])).toBe(true)
    expect(blocks([rule({ pattern: 'edge of heaven' })])).toBe(true)
  })

  it('leaves everything else alone', () => {
    expect(blocks([rule({ pattern: 'jazz' })])).toBe(false)
  })

  it('confines a rule to the field it names', () => {
    expect(blocks([rule({ field: 'artist', pattern: 'christmas' })])).toBe(false)
    expect(blocks([rule({ field: 'title', pattern: 'christmas' })])).toBe(true)
  })

  it('matches a whole field for "is", not a fragment of it', () => {
    expect(blocks([rule({ field: 'artist', match: 'is', pattern: 'Wham!' })])).toBe(true)
    expect(blocks([rule({ field: 'artist', match: 'is', pattern: 'wham!' })])).toBe(true)
    // "contains" would catch this; "is" is the whole name or nothing.
    expect(blocks([rule({ field: 'artist', match: 'is', pattern: 'Wham' })])).toBe(false)
    expect(blocks([rule({ field: 'title', match: 'is', pattern: 'Christmas' })])).toBe(false)
  })

  it('treats "matches" as a regular expression', () => {
    expect(blocks([rule({ match: 'matches', pattern: '^last\\b' })])).toBe(true)
    expect(blocks([rule({ match: 'matches', pattern: 'christmas$' })])).toBe(true)
    expect(blocks([rule({ match: 'matches', pattern: '^christmas' })])).toBe(false)
  })

  it('ignores a rule that is switched off', () => {
    expect(blocks([rule({ pattern: 'christmas', enabled: false })])).toBe(false)
  })

  it('drops a regular expression that will not compile, and keeps the rest', () => {
    // Silently applying nothing would look identical to a rule that matches
    // nothing, so the broken one is discarded and the good one still runs.
    const rules = [rule({ match: 'matches', pattern: '([unclosed' }), rule({ pattern: 'wham' })]
    expect(blocks(rules)).toBe(true)
    expect(blocks([rule({ match: 'matches', pattern: '([unclosed' })])).toBe(false)
  })

  it('never matches a field the track does not have', () => {
    // A rule against an unknown artist must not take the whole queue with it.
    const unknown = { title: 'Untitled', artist: null, album: null }
    expect(blocks([rule({ field: 'artist', pattern: 'a' })], unknown)).toBe(false)
    expect(blocks([rule({ field: 'album', pattern: '' })], unknown)).toBe(false)
  })

  it('does nothing at all with no rules', () => {
    expect(isBlocked(track, compileBlocklist([], logger))).toBe(false)
    expect(blocks([rule({ pattern: 'christmas', enabled: false })])).toBe(false)
  })
})
