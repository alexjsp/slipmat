import type { Preset, PresetRule } from '@slipmat/shared'
import { describe, expect, it } from 'vitest'
import { type Clock, clockFrom, conditionMatches, evaluateRules } from './rules.js'

const clock = (overrides: Partial<Clock> = {}): Clock => ({
  dayOfWeek: 1,
  month: 6,
  day: 15,
  minutes: 12 * 60,
  ...overrides,
})

const basePreset = {
  id: 'p1',
  name: 'Morning',
  icon: null,
  color: null,
  zones: [
    { zoneId: 'kitchen', zoneName: 'Kitchen', volume: 30, isCoordinator: true },
    { zoneId: 'bedroom', zoneName: 'Bedroom', volume: 20, isCoordinator: false },
  ],
  sources: [
    {
      id: 's1',
      kind: 'sonos_playlist',
      ref: 'SQ:1',
      label: 'Sunday Morning',
      position: 0,
      resolutionMode: null,
      trackCount: null,
      resolvedAt: null,
      resolveError: null,
    },
  ],
  shuffle: true,
  repeatAll: true,
  dedupe: true,
  pauseOthers: false,
  crossfade: false,
  homekitEnabled: false,
  webhookToken: 't',
  position: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as Preset

const rule = (overrides: Partial<PresetRule>): PresetRule => ({
  id: 'r1',
  presetId: 'p1',
  position: 0,
  label: 'Rule',
  enabled: true,
  condition: {},
  effect: {},
  ...overrides,
})

describe('conditionMatches', () => {
  it('matches everything when no clauses are set', () => {
    expect(conditionMatches({}, clock())).toBe(true)
  })

  it('matches a day of the week', () => {
    expect(conditionMatches({ daysOfWeek: [4] }, clock({ dayOfWeek: 4 }))).toBe(true)
    expect(conditionMatches({ daysOfWeek: [4] }, clock({ dayOfWeek: 5 }))).toBe(false)
  })

  it('matches a month', () => {
    expect(conditionMatches({ months: [12] }, clock({ month: 12 }))).toBe(true)
    expect(conditionMatches({ months: [12] }, clock({ month: 11 }))).toBe(false)
  })

  it('requires every clause it specifies', () => {
    const condition = { months: [12], daysOfWeek: [4] }
    expect(conditionMatches(condition, clock({ month: 12, dayOfWeek: 4 }))).toBe(true)
    expect(conditionMatches(condition, clock({ month: 12, dayOfWeek: 3 }))).toBe(false)
  })

  describe('time windows', () => {
    it('handles an ordinary daytime window', () => {
      const condition = { timeOfDay: { from: '09:00', to: '17:00' } }
      expect(conditionMatches(condition, clock({ minutes: 10 * 60 }))).toBe(true)
      expect(conditionMatches(condition, clock({ minutes: 8 * 60 }))).toBe(false)
      expect(conditionMatches(condition, clock({ minutes: 18 * 60 }))).toBe(false)
    })

    it('wraps midnight, which is the whole point of a wind-down window', () => {
      const condition = { timeOfDay: { from: '21:00', to: '05:00' } }
      expect(conditionMatches(condition, clock({ minutes: 22 * 60 }))).toBe(true)
      expect(conditionMatches(condition, clock({ minutes: 2 * 60 }))).toBe(true)
      expect(conditionMatches(condition, clock({ minutes: 0 }))).toBe(true)
      expect(conditionMatches(condition, clock({ minutes: 12 * 60 }))).toBe(false)
      expect(conditionMatches(condition, clock({ minutes: 20 * 60 + 59 }))).toBe(false)
    })

    it('includes both ends of the window', () => {
      const condition = { timeOfDay: { from: '09:00', to: '17:00' } }
      expect(conditionMatches(condition, clock({ minutes: 9 * 60 }))).toBe(true)
      expect(conditionMatches(condition, clock({ minutes: 17 * 60 }))).toBe(true)
    })
  })

  describe('date ranges', () => {
    it('matches a range within one year', () => {
      const condition = { dateRange: { from: '12-20', to: '12-26' } }
      expect(conditionMatches(condition, clock({ month: 12, day: 25 }))).toBe(true)
      expect(conditionMatches(condition, clock({ month: 12, day: 27 }))).toBe(false)
    })

    it('wraps the new year', () => {
      const condition = { dateRange: { from: '12-20', to: '01-05' } }
      expect(conditionMatches(condition, clock({ month: 12, day: 31 }))).toBe(true)
      expect(conditionMatches(condition, clock({ month: 1, day: 2 }))).toBe(true)
      expect(conditionMatches(condition, clock({ month: 6, day: 15 }))).toBe(false)
    })
  })
})

describe('evaluateRules', () => {
  it('returns the preset unchanged when nothing matches', () => {
    const result = evaluateRules(basePreset, [], clock())
    expect(result.sources.map((s) => s.ref)).toEqual(['SQ:1'])
    expect(result.appliedRuleLabels).toEqual([])
  })

  it('adds a source on Thursdays', () => {
    const rules = [
      rule({
        label: 'Throwback Thursday',
        condition: { daysOfWeek: [4] },
        effect: { addSources: [{ kind: 'sonos_playlist', ref: 'SQ:9', label: 'Throwbacks' }] },
      }),
    ]

    const thursday = evaluateRules(basePreset, rules, clock({ dayOfWeek: 4 }))
    expect(thursday.sources.map((s) => s.ref)).toEqual(['SQ:1', 'SQ:9'])
    expect(thursday.appliedRuleLabels).toEqual(['Throwback Thursday'])

    const friday = evaluateRules(basePreset, rules, clock({ dayOfWeek: 5 }))
    expect(friday.sources.map((s) => s.ref)).toEqual(['SQ:1'])
  })

  it('replaces everything and drops the volume for a late wind-down', () => {
    const rules = [
      rule({
        label: 'Wind down',
        condition: { timeOfDay: { from: '21:00', to: '05:00' } },
        effect: {
          replaceSources: [{ kind: 'sonos_playlist', ref: 'SQ:5', label: 'Wind Down' }],
          volumeDelta: -12,
        },
      }),
    ]

    const late = evaluateRules(basePreset, rules, clock({ minutes: 22 * 60 }))
    expect(late.sources.map((s) => s.ref)).toEqual(['SQ:5'])
    expect(late.zoneVolumes.map((z) => z.volume)).toEqual([18, 8])
  })

  it('composes December with Thursday rather than picking one', () => {
    const rules = [
      rule({
        id: 'r1',
        position: 0,
        label: 'Christmas',
        condition: { months: [12] },
        effect: { addSources: [{ kind: 'sonos_playlist', ref: 'SQ:X', label: 'Christmas' }] },
      }),
      rule({
        id: 'r2',
        position: 1,
        label: 'Throwbacks',
        condition: { daysOfWeek: [4] },
        effect: { addSources: [{ kind: 'sonos_playlist', ref: 'SQ:T', label: 'Throwbacks' }] },
      }),
    ]

    const result = evaluateRules(basePreset, rules, clock({ month: 12, dayOfWeek: 4 }))
    expect(result.sources.map((s) => s.ref)).toEqual(['SQ:1', 'SQ:X', 'SQ:T'])
    expect(result.appliedRuleLabels).toEqual(['Christmas', 'Throwbacks'])
  })

  it('applies rules in position order, so a later replace wins', () => {
    const rules = [
      rule({
        id: 'r1',
        position: 1,
        label: 'Replace',
        effect: { replaceSources: [{ kind: 'raw_uri', ref: 'final', label: 'Final' }] },
      }),
      rule({
        id: 'r2',
        position: 0,
        label: 'Add',
        effect: { addSources: [{ kind: 'raw_uri', ref: 'early', label: 'Early' }] },
      }),
    ]

    const result = evaluateRules(basePreset, rules, clock())
    expect(result.sources.map((s) => s.ref)).toEqual(['final'])
    expect(result.appliedRuleLabels).toEqual(['Add', 'Replace'])
  })

  it('skips disabled rules', () => {
    const rules = [
      rule({
        enabled: false,
        label: 'Off',
        effect: { addSources: [{ kind: 'raw_uri', ref: 'nope', label: 'Nope' }] },
      }),
    ]
    expect(evaluateRules(basePreset, rules, clock()).sources).toHaveLength(1)
  })

  it('clamps volume rather than going out of range', () => {
    const down = evaluateRules(basePreset, [rule({ effect: { volumeDelta: -80 } })], clock())
    expect(down.zoneVolumes.map((z) => z.volume)).toEqual([0, 0])

    const up = evaluateRules(basePreset, [rule({ effect: { volumeDelta: 90 } })], clock())
    expect(up.zoneVolumes.map((z) => z.volume)).toEqual([100, 100])
  })

  it('prefers an absolute volume over a delta', () => {
    const result = evaluateRules(
      basePreset,
      [rule({ effect: { volumeDelta: -10, volumeAbsolute: 5 } })],
      clock(),
    )
    expect(result.zoneVolumes.map((z) => z.volume)).toEqual([5, 5])
  })

  it('does not queue the same source twice when two rules contribute it', () => {
    const rules = [
      rule({
        id: 'r1',
        position: 0,
        label: 'A',
        effect: { addSources: [{ kind: 'sonos_playlist', ref: 'SQ:9', label: 'Shared' }] },
      }),
      rule({
        id: 'r2',
        position: 1,
        label: 'B',
        effect: { addSources: [{ kind: 'sonos_playlist', ref: 'SQ:9', label: 'Shared' }] },
      }),
    ]
    // Duplicating it would skew the shuffle towards that playlist.
    expect(evaluateRules(basePreset, rules, clock()).sources.map((s) => s.ref)).toEqual([
      'SQ:1',
      'SQ:9',
    ])
  })

  it('overrides flags, including shuffle', () => {
    const result = evaluateRules(
      basePreset,
      [rule({ effect: { repeatAll: false, pauseOthers: true, shuffle: false } })],
      clock(),
    )
    expect(result.repeatAll).toBe(false)
    expect(result.pauseOthers).toBe(true)
    // e.g. "in December, play the Christmas album straight through".
    expect(result.shuffle).toBe(false)
  })
})

describe('clockFrom', () => {
  it('reads wall-clock fields in the configured timezone, not the host one', () => {
    // 23:30 UTC on a Thursday is 00:30 Friday in Europe/London (BST).
    const instant = new Date('2026-06-18T23:30:00Z')

    const london = clockFrom(instant, 'Europe/London')
    expect(london.dayOfWeek).toBe(5)
    expect(london.minutes).toBe(30)

    const utc = clockFrom(instant, 'UTC')
    expect(utc.dayOfWeek).toBe(4)
    expect(utc.minutes).toBe(23 * 60 + 30)
  })

  it('reports midnight as 0 minutes, not 1440', () => {
    expect(clockFrom(new Date('2026-06-18T00:00:00Z'), 'UTC').minutes).toBe(0)
  })
})
