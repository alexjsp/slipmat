import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'

describe('loadConfig', () => {
  it('treats an empty value as unset, so the default applies', () => {
    // Docker Compose interpolates `${SLIPMAT_TZ:-}` to an empty string, and a
    // Zod default only fires on an absent key — so this used to yield a
    // timezone of '', which threw `Invalid time zone specified:` out of
    // Intl.DateTimeFormat on every scheduler tick and every rules request.
    const config = loadConfig({ SLIPMAT_TZ: '' })
    expect(config.timeZone).not.toBe('')
    expect(() => new Intl.DateTimeFormat('en-GB', { timeZone: config.timeZone })).not.toThrow()
  })

  it('still honours a real value', () => {
    expect(loadConfig({ SLIPMAT_TZ: 'Europe/London' }).timeZone).toBe('Europe/London')
  })

  it('leaves optional settings undefined rather than empty', () => {
    // `if (config.seedIp)` reads the same either way, but '' is not a seed IP
    // and should not survive as far as anything that might log or use it.
    const config = loadConfig({ SLIPMAT_SEED_IP: '', SLIPMAT_UTILITY_ZONE: '' })
    expect(config.seedIp).toBeUndefined()
    expect(config.utilityZoneId).toBeUndefined()
  })

  it('reads an empty allowlist as no extra hosts', () => {
    expect(loadConfig({ SLIPMAT_ALLOWED_HOSTS: '' }).allowedHosts).toEqual([])
  })

  it('splits and trims a real allowlist', () => {
    expect(loadConfig({ SLIPMAT_ALLOWED_HOSTS: 'a.example, b.example ' }).allowedHosts).toEqual([
      'a.example',
      'b.example',
    ])
  })

  it('defaults the port when the variable is blank', () => {
    // Blank would otherwise coerce to 0, which is a valid number and an invalid
    // port, and z.coerce would have accepted it before the min check.
    expect(loadConfig({ SLIPMAT_PORT: '' }).port).toBe(5544)
  })
})
