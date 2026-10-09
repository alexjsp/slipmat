import { describe, expect, it } from 'vitest'
import { LoginThrottle } from './login-throttle.js'

describe('login throttle', () => {
  const clock = () => {
    let now = 1_000_000
    return { now: () => now, advance: (ms: number) => (now += ms) }
  }

  it('lets a few mistakes through, then makes one address wait', () => {
    const time = clock()
    const throttle = new LoginThrottle(time.now)
    for (let i = 0; i < 10; i++) {
      expect(throttle.retryAfterMs('10.0.0.5')).toBe(0)
      throttle.recordFailure('10.0.0.5')
    }
    expect(throttle.retryAfterMs('10.0.0.5')).toBeGreaterThan(0)
    // Somebody else in the house is unaffected.
    expect(throttle.retryAfterMs('10.0.0.6')).toBe(0)

    time.advance(15 * 60 * 1000 + 1)
    expect(throttle.retryAfterMs('10.0.0.5')).toBe(0)
  })

  it('caps guessing spread across many addresses', () => {
    const throttle = new LoginThrottle(clock().now)
    for (let i = 0; i < 100; i++) throttle.recordFailure(`198.51.100.${i}`)
    expect(throttle.retryAfterMs('203.0.113.1')).toBeGreaterThan(0)
  })

  it('forgets an address once it gets the password right', () => {
    const throttle = new LoginThrottle(clock().now)
    for (let i = 0; i < 10; i++) throttle.recordFailure('10.0.0.5')
    throttle.recordSuccess('10.0.0.5')
    expect(throttle.retryAfterMs('10.0.0.5')).toBe(0)
  })
})
