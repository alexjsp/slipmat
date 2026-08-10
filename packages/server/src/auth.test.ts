import { afterEach, describe, expect, it } from 'vitest'
import { __testing } from './auth.js'
import { loadConfig } from './config.js'
import { createLogger } from './logger.js'
import { buildServer } from './server.js'
import { FakeSonosDriver } from './sonos/fake-driver.js'

const { isAllowedHost, isPublicPath } = __testing

describe('host allowlist', () => {
  it('accepts the ways someone actually reaches a LAN service', () => {
    for (const host of ['localhost:5544', 'slipmat.local', '192.168.1.50:5544', 'unraid.ts.net']) {
      expect(isAllowedHost(host, [])).toBe(true)
    }
  })

  it('rejects an attacker-controlled hostname pointed at us', () => {
    // The DNS-rebinding case: evil.com resolving to our private IP.
    expect(isAllowedHost('evil.example.com', [])).toBe(false)
    expect(isAllowedHost(undefined, [])).toBe(false)
  })

  it('accepts a hostname the operator has allowlisted', () => {
    expect(isAllowedHost('slipmat.jsp.scot', ['slipmat.jsp.scot'])).toBe(true)
  })
})

describe('public paths', () => {
  it('leaves webhooks reachable without a session', () => {
    // These are used by Shortcuts and Node-RED, which cannot log in.
    expect(isPublicPath('/api/webhooks/abc')).toBe(true)
    expect(isPublicPath('/api/health')).toBe(true)
    expect(isPublicPath('/presets')).toBe(true)
  })

  it('guards everything else under /api', () => {
    expect(isPublicPath('/api/presets')).toBe(false)
    expect(isPublicPath('/api/system')).toBe(false)
  })
})

describe('authentication', () => {
  const servers: Awaited<ReturnType<typeof buildServer>>[] = []

  const build = async (env: Record<string, string> = {}) => {
    const app = await buildServer({
      config: loadConfig({
        SLIPMAT_LOG_LEVEL: 'error',
        SLIPMAT_FAKE_SONOS: '1',
        SLIPMAT_DATA_DIR: ':memory:',
        ...env,
      }),
      logger: createLogger({ logLevel: 'error' }),
      driver: new FakeSonosDriver(),
    })
    servers.push(app)
    return app
  }

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((app) => app.close()))
  })

  it('is off by default, so the API works with no credentials', async () => {
    const app = await build()
    expect((await app.inject({ method: 'GET', url: '/api/system' })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/api/auth/status' })).json().required).toBe(
      false,
    )
  })

  it('guards the API once a password is set', async () => {
    const app = await build({ SLIPMAT_PASSWORD: 'hunter2', SLIPMAT_SESSION_SECRET: 'x'.repeat(32) })
    expect((await app.inject({ method: 'GET', url: '/api/system' })).statusCode).toBe(401)
  })

  it('lets a correct password through and keeps the session', async () => {
    const app = await build({ SLIPMAT_PASSWORD: 'hunter2', SLIPMAT_SESSION_SECRET: 'x'.repeat(32) })

    const bad = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'wrong' },
    })
    expect(bad.statusCode).toBe(401)

    const good = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'hunter2' },
    })
    expect(good.statusCode).toBe(200)

    const cookie = good.cookies[0]
    expect(cookie?.httpOnly).toBe(true)

    const authed = await app.inject({
      method: 'GET',
      url: '/api/system',
      cookies: { [cookie!.name]: cookie!.value },
    })
    expect(authed.statusCode).toBe(200)
  })

  it('still lets webhooks fire when auth is on', async () => {
    const app = await build({ SLIPMAT_PASSWORD: 'hunter2', SLIPMAT_SESSION_SECRET: 'x'.repeat(32) })
    const token = (await app.inject({ method: 'GET', url: '/api/pause-all/token' })).json()
    // The token endpoint itself is guarded, so this proves the guard is on…
    expect(token.error).toBe('unauthorized')

    // …while an actual webhook path stays open by design.
    const hook = await app.inject({ method: 'GET', url: '/api/webhooks/whatever' })
    expect(hook.statusCode).toBe(404)
  })

  it('rejects a rebinding Host even when auth is off', async () => {
    const app = await build()
    const res = await app.inject({
      method: 'GET',
      url: '/api/system',
      headers: { host: 'evil.example.com' },
    })
    expect(res.statusCode).toBe(421)
  })
})
