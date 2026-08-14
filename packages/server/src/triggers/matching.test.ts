import type { ScheduleConfig } from '@slipmat/shared'
import { describe, expect, it } from 'vitest'
import {
  describeSchedule,
  isScheduleDue,
  occurrenceKey,
  scheduleDueAt,
  sleepTimerExpired,
  sleepTimerRemaining,
} from './matching.js'

const clock = (
  overrides: Partial<{
    dayOfWeek: number
    month: number
    day: number
    minutes: number
    epochDay: number
  }> = {},
) => ({
  dayOfWeek: 1,
  month: 6,
  day: 15,
  minutes: 7 * 60 + 30,
  epochDay: 20_619,
  ...overrides,
})

const schedule = (overrides: Partial<ScheduleConfig> = {}): ScheduleConfig => ({
  daysOfWeek: [],
  time: '07:30',
  action: 'activate',
  skipIfPlaying: true,
  ...overrides,
})

describe('isScheduleDue', () => {
  it('fires on the scheduled minute', () => {
    expect(isScheduleDue(schedule(), clock(), 't1', null)).not.toBeNull()
  })

  it('does not fire a minute early or late', () => {
    expect(isScheduleDue(schedule(), clock({ minutes: 7 * 60 + 29 }), 't1', null)).toBeNull()
    expect(isScheduleDue(schedule(), clock({ minutes: 7 * 60 + 31 }), 't1', null)).toBeNull()
  })

  it('never fires late, however long the gap', () => {
    // The whole point: a restart at 07:45 must not start the morning playlist.
    expect(isScheduleDue(schedule(), clock({ minutes: 7 * 60 + 45 }), 't1', null)).toBeNull()
    expect(isScheduleDue(schedule(), clock({ minutes: 18 * 60 }), 't1', null)).toBeNull()
  })

  it('respects days of the week', () => {
    const weekdays = schedule({ daysOfWeek: [1, 2, 3, 4, 5] })
    expect(isScheduleDue(weekdays, clock({ dayOfWeek: 3 }), 't1', null)).not.toBeNull()
    expect(isScheduleDue(weekdays, clock({ dayOfWeek: 6 }), 't1', null)).toBeNull()
  })

  it('treats an empty day list as every day', () => {
    for (let day = 0; day < 7; day++) {
      expect(
        isScheduleDue(schedule({ daysOfWeek: [] }), clock({ dayOfWeek: day }), 't1', null),
      ).not.toBeNull()
    }
  })

  it('fires only once per occurrence, however often it is polled', () => {
    const first = isScheduleDue(schedule(), clock(), 't1', null)
    expect(first).not.toBeNull()
    // Same minute, now with the key recorded.
    expect(isScheduleDue(schedule(), clock(), 't1', first!.key)).toBeNull()
  })

  it('fires again the next day', () => {
    const today = isScheduleDue(schedule(), clock({ day: 15 }), 't1', null)!
    expect(isScheduleDue(schedule(), clock({ day: 16 }), 't1', today.key)).not.toBeNull()
  })

  it('keys separate triggers apart, so one firing does not suppress another', () => {
    const a = occurrenceKey('t1', clock(), '07:30')
    const b = occurrenceKey('t2', clock(), '07:30')
    expect(a).not.toBe(b)
  })

  it('handles midnight', () => {
    expect(
      isScheduleDue(schedule({ time: '00:00' }), clock({ minutes: 0 }), 't1', null),
    ).not.toBeNull()
  })
})

describe('scheduleDueAt', () => {
  it('uses the configured timezone, not the host one', () => {
    // 06:30 UTC on 2026-06-15 is 07:30 in London (BST).
    const instant = new Date('2026-06-15T06:30:00Z')
    expect(scheduleDueAt(schedule(), instant, 'Europe/London', 't1', null)).not.toBeNull()
    expect(scheduleDueAt(schedule(), instant, 'UTC', 't1', null)).toBeNull()
  })

  it('still fires at the wall-clock time across a DST change', () => {
    // 2026-10-25 is when the UK falls back; 07:30 local is 07:30 GMT.
    const afterFallback = new Date('2026-10-25T07:30:00Z')
    expect(scheduleDueAt(schedule(), afterFallback, 'Europe/London', 't1', null)).not.toBeNull()
  })
})

describe('sleep timers', () => {
  const started = '2026-06-15T21:00:00.000Z'

  it('has not expired before its time', () => {
    expect(sleepTimerExpired(started, 45, new Date('2026-06-15T21:44:00Z'))).toBe(false)
  })

  it('expires exactly on time', () => {
    expect(sleepTimerExpired(started, 45, new Date('2026-06-15T21:45:00Z'))).toBe(true)
  })

  it('expires when the gap is discovered late, e.g. after a restart', () => {
    // Derived from the activation row, so a restart mid-doze still stops it
    // rather than leaving music on all night.
    expect(sleepTimerExpired(started, 45, new Date('2026-06-16T03:00:00Z'))).toBe(true)
  })

  it('reports minutes remaining', () => {
    expect(sleepTimerRemaining(started, 45, new Date('2026-06-15T21:15:00Z'))).toBe(30)
  })
})

describe('describeSchedule', () => {
  const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

  it('summarises common patterns rather than listing days', () => {
    expect(describeSchedule(schedule({ daysOfWeek: [] }), labels)).toBe('Every day at 07:30')
    expect(describeSchedule(schedule({ daysOfWeek: [1, 2, 3, 4, 5] }), labels)).toBe(
      'Weekdays at 07:30',
    )
    expect(describeSchedule(schedule({ daysOfWeek: [0, 6] }), labels)).toBe('Weekends at 07:30')
    expect(describeSchedule(schedule({ daysOfWeek: [2, 4] }), labels)).toBe('Tue, Thu at 07:30')
  })
})
