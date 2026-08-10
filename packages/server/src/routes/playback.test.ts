import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { createLogger } from '../logger.js'
import { buildServer } from '../server.js'
import { FakeSonosDriver } from '../sonos/fake-driver.js'

// Driver is injected, so these never reach a real household.
describe('playback routes', () => {
  let driver: FakeSonosDriver
  let app: Awaited<ReturnType<typeof buildServer>>

  const KITCHEN = 'RINCON_KITCHEN01400'
  const BEDROOM = 'RINCON_BEDROOM01400'

  beforeEach(async () => {
    driver = new FakeSonosDriver()
    app = await buildServer({
      config: loadConfig({ SLIPMAT_LOG_LEVEL: 'error' }),
      logger: createLogger({ logLevel: 'error' }),
      driver,
    })
  })

  afterEach(async () => {
    await app.close()
  })

  it('plays and pauses a zone', async () => {
    const play = await app.inject({ method: 'POST', url: `/api/zones/${KITCHEN}/play` })
    expect(play.statusCode).toBe(204)

    const state = await app.inject({ method: 'GET', url: '/api/system' })
    const group = state.json().groups.find((g: { id: string }) => g.id === KITCHEN)
    expect(group.transportState).toBe('PLAYING')

    await app.inject({ method: 'POST', url: `/api/zones/${KITCHEN}/pause` })
    const after = await app.inject({ method: 'GET', url: '/api/system' })
    expect(after.json().groups.find((g: { id: string }) => g.id === KITCHEN).transportState).toBe(
      'PAUSED_PLAYBACK',
    )
  })

  it('sets volume and rejects out-of-range values', async () => {
    const ok = await app.inject({
      method: 'POST',
      url: `/api/zones/${KITCHEN}/volume`,
      payload: { volume: 40 },
    })
    expect(ok.statusCode).toBe(204)

    const state = await app.inject({ method: 'GET', url: '/api/system' })
    expect(state.json().zones.find((z: { id: string }) => z.id === KITCHEN).volume).toBe(40)

    const bad = await app.inject({
      method: 'POST',
      url: `/api/zones/${KITCHEN}/volume`,
      payload: { volume: 140 },
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error).toBe('bad_request')
  })

  it('joins and leaves groups', async () => {
    const join = await app.inject({
      method: 'POST',
      url: '/api/groups/join',
      payload: { coordinatorZoneId: KITCHEN, zoneIds: [BEDROOM] },
    })
    expect(join.statusCode).toBe(204)

    let state = await app.inject({ method: 'GET', url: '/api/system' })
    expect(state.json().groups).toHaveLength(3)

    const leave = await app.inject({
      method: 'POST',
      url: '/api/groups/leave',
      payload: { zoneIds: [BEDROOM] },
    })
    expect(leave.statusCode).toBe(204)

    state = await app.inject({ method: 'GET', url: '/api/system' })
    expect(state.json().groups).toHaveLength(4)
  })

  it('reports a speaker that rejects a command as a gateway failure', async () => {
    driver.setUnreachable(KITCHEN, true)
    const res = await app.inject({ method: 'POST', url: `/api/zones/${KITCHEN}/play` })
    expect(res.statusCode).toBe(502)
    expect(res.json().error).toBe('command_failed')
  })

  it('distinguishes an unknown zone (404) from an unreachable one (502)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/zones/RINCON_NOPE/play' })
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe('not_found')
  })

  it('refuses to proxy artwork from an arbitrary url', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/art?zone=${KITCHEN}&path=${encodeURIComponent('http://evil.example/secret')}`,
    })
    expect(res.statusCode).toBe(400)
  })
})
