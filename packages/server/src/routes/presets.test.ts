import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { createLogger } from '../logger.js'
import { buildServer } from '../server.js'
import { FakeSonosDriver } from '../sonos/fake-driver.js'

const KITCHEN = 'RINCON_KITCHEN01400'
const BEDROOM = 'RINCON_BEDROOM01400'
const OFFICE = 'RINCON_OFFICE01400'
const LIVING = 'RINCON_LIVING01400'

const validPreset = {
  name: 'Morning',
  zones: [
    { zoneId: KITCHEN, volume: 30, isCoordinator: true },
    { zoneId: BEDROOM, volume: 12 },
  ],
  sources: [{ kind: 'raw_uri', ref: 'x-sonos-http:song:1.mp4', label: 'A track' }],
}

// Driver is injected and the database is in-memory, so nothing here reaches a
// real household or leaves state behind.
describe('preset and webhook routes', () => {
  let driver: FakeSonosDriver
  let app: Awaited<ReturnType<typeof buildServer>>

  beforeEach(async () => {
    driver = new FakeSonosDriver({ tvZoneIds: [LIVING] })
    app = await buildServer({
      config: loadConfig({
        SLIPMAT_LOG_LEVEL: 'error',
        SLIPMAT_FAKE_SONOS: '1',
        SLIPMAT_DATA_DIR: ':memory:',
      }),
      logger: createLogger({ logLevel: 'error' }),
      driver,
    })
  })

  afterEach(async () => {
    await app.close()
  })

  const create = async (overrides: Record<string, unknown> = {}) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/presets',
      payload: { ...validPreset, ...overrides },
    })
    expect(res.statusCode).toBe(201)
    return res.json().preset
  }

  it('creates a preset with a coordinator and a webhook token', async () => {
    const preset = await create()
    expect(preset.zones.find((z: { zoneId: string }) => z.zoneId === KITCHEN).isCoordinator).toBe(
      true,
    )
    expect(preset.webhookToken).toMatch(/^[A-Za-z0-9_-]{20,}$/)
    // Names are captured at save time so a preset still reads sensibly later.
    expect(preset.zones.map((z: { zoneName: string }) => z.zoneName).sort()).toEqual([
      'Bedroom',
      'Kitchen',
    ])
  })

  it('rejects a preset with no zones', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/presets',
      payload: { ...validPreset, zones: [] },
    })
    expect(res.statusCode).toBe(400)
  })

  describe('a preset whose music comes from its rules', () => {
    const rotation = {
      label: 'Rotate',
      enabled: true,
      condition: {},
      effect: {
        rotateSources: {
          period: 'day',
          sources: [
            { kind: 'raw_uri', ref: 'x-sonos-http:song:a.mp4', label: 'A' },
            { kind: 'raw_uri', ref: 'x-sonos-http:song:b.mp4', label: 'B' },
          ],
        },
      },
    }

    const conditional = { ...rotation, condition: { months: [12] } }

    const putRules = (id: string, rules: unknown[]) =>
      app.inject({ method: 'PUT', url: `/api/presets/${id}/rules`, payload: { rules } })

    it('lists what its rules can play, so the card is not blank', async () => {
      await create({ sources: [], rules: [rotation] })
      const listed = (await app.inject({ method: 'GET', url: '/api/presets' })).json().presets[0]
      expect(listed.sources).toEqual([])
      expect(listed.ruleSources.map((source: { label: string }) => source.label)).toEqual([
        'A',
        'B',
      ])
    })

    it('is created in one request, rules and all', async () => {
      const preset = await create({ sources: [], rules: [rotation] })
      const res = await app.inject({ method: 'GET', url: `/api/presets/${preset.id}/rules` })
      expect(res.json().rules).toHaveLength(1)
      // Whichever arm today lands on, there is something to play.
      expect(res.json().preview.sources).toHaveLength(1)
    })

    it('cannot be created without the rule it depends on', async () => {
      for (const payload of [
        { ...validPreset, sources: [] },
        { ...validPreset, sources: [], rules: [conditional] },
      ]) {
        const res = await app.inject({ method: 'POST', url: '/api/presets', payload })
        expect(res.statusCode).toBe(400)
        expect(res.json().error).toBe('nothing_to_play')
      }
      expect((await app.inject({ method: 'GET', url: '/api/presets' })).json().presets).toEqual([])
    })

    it('cannot have its last source and its rules removed at once', async () => {
      const preset = await create({ sources: [], rules: [rotation] })
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/presets/${preset.id}`,
        payload: { ...validPreset, sources: [], rules: [] },
      })
      expect(res.statusCode).toBe(400)
      // Still intact, rules and all.
      const after = await app.inject({ method: 'GET', url: `/api/presets/${preset.id}/rules` })
      expect(after.json().rules).toHaveLength(1)
    })

    it('keeps its stored rules when a save leaves them out', async () => {
      const preset = await create({ sources: [], rules: [rotation] })
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/presets/${preset.id}`,
        payload: { ...validPreset, sources: [], name: 'Renamed' },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().preset.name).toBe('Renamed')
      const after = await app.inject({ method: 'GET', url: `/api/presets/${preset.id}/rules` })
      expect(after.json().rules).toHaveLength(1)
    })

    it('will not accept rules that leave it silent on some days', async () => {
      const preset = await create({ sources: [], rules: [rotation] })
      const res = await putRules(preset.id, [conditional])
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toBe('nothing_to_play')
      // The rejected rules were not written.
      const after = await app.inject({ method: 'GET', url: `/api/presets/${preset.id}/rules` })
      expect(after.json().rules[0].label).toBe('Rotate')
    })

    it('still allows a conditional rule when the preset has its own sources', async () => {
      const preset = await create()
      expect((await putRules(preset.id, [conditional])).statusCode).toBe(200)
    })
  })

  it('updates and deletes', async () => {
    const preset = await create()

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/presets/${preset.id}`,
      payload: { ...validPreset, name: 'Renamed' },
    })
    expect(updated.json().preset.name).toBe('Renamed')

    expect(
      (await app.inject({ method: 'DELETE', url: `/api/presets/${preset.id}` })).statusCode,
    ).toBe(204)
    expect((await app.inject({ method: 'GET', url: `/api/presets/${preset.id}` })).statusCode).toBe(
      404,
    )
  })

  it('activates, reports active, and stops', async () => {
    const preset = await create()

    const activated = await app.inject({
      method: 'POST',
      url: `/api/presets/${preset.id}/activate`,
    })
    expect(activated.json().noop).toBe(false)

    const status = await app.inject({ method: 'GET', url: `/api/presets/${preset.id}` })
    expect(status.json().status.active).toBe(true)

    await app.inject({ method: 'POST', url: `/api/presets/${preset.id}/stop` })
    const after = await app.inject({ method: 'GET', url: `/api/presets/${preset.id}` })
    expect(after.json().status.active).toBe(false)
  })

  it('regenerating a token invalidates the old webhook URL', async () => {
    const preset = await create()
    const old = preset.webhookToken

    const res = await app.inject({
      method: 'POST',
      url: `/api/presets/${preset.id}/regenerate-token`,
    })
    const fresh = res.json().webhookToken
    expect(fresh).not.toBe(old)

    expect((await app.inject({ method: 'GET', url: `/api/webhooks/${old}` })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: `/api/webhooks/${fresh}` })).statusCode).toBe(
      200,
    )
  })

  describe('webhooks', () => {
    it('starts a preset over GET, so dumb clients can fire it', async () => {
      const preset = await create()
      const res = await app.inject({ method: 'GET', url: `/api/webhooks/${preset.webhookToken}` })
      expect(res.statusCode).toBe(200)
      expect(res.json().noop).toBe(false)
    })

    it('is idempotent when a client retries', async () => {
      const preset = await create()
      await app.inject({ method: 'POST', url: `/api/webhooks/${preset.webhookToken}` })
      const retry = await app.inject({
        method: 'POST',
        url: `/api/webhooks/${preset.webhookToken}`,
      })
      expect(retry.json().noop).toBe(true)
    })

    it('supports stop and toggle actions', async () => {
      const preset = await create()
      const url = `/api/webhooks/${preset.webhookToken}`

      await app.inject({ method: 'GET', url })
      expect((await app.inject({ method: 'GET', url: `${url}?action=stop` })).json().stopped).toBe(
        true,
      )

      // Toggle turns it back on, then off again.
      expect((await app.inject({ method: 'GET', url: `${url}?action=toggle` })).json().noop).toBe(
        false,
      )
      expect(
        (await app.inject({ method: 'GET', url: `${url}?action=toggle` })).json().stopped,
      ).toBe(true)
    })

    it('404s an unknown token without revealing anything', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/webhooks/definitely-not-a-token' })
      expect(res.statusCode).toBe(404)
      expect(res.json().message).toBe('Unknown webhook')
    })
  })

  describe('pause all music', () => {
    it('pauses music everywhere but leaves the TV playing', async () => {
      driver.setPlaying(OFFICE, 'x-rincon-queue:o#0', 'some-track')

      const res = await app.inject({ method: 'POST', url: '/api/pause-all' })
      expect(res.json().pausedGroupIds).toContain(OFFICE)
      expect(res.json().skippedGroupIds).toContain(LIVING)

      const state = await app.inject({ method: 'GET', url: '/api/system' })
      const groups = state.json().groups
      expect(groups.find((g: { id: string }) => g.id === OFFICE).transportState).toBe(
        'PAUSED_PLAYBACK',
      )
      expect(groups.find((g: { id: string }) => g.id === LIVING).transportState).toBe('PLAYING')
    })

    it('turns off any preset it silenced', async () => {
      const preset = await create()
      await app.inject({ method: 'POST', url: `/api/presets/${preset.id}/activate` })

      await app.inject({ method: 'POST', url: '/api/pause-all' })

      const status = await app.inject({ method: 'GET', url: `/api/presets/${preset.id}` })
      expect(status.json().status.active).toBe(false)
    })

    it('is reachable by its own stable webhook token', async () => {
      const token = (await app.inject({ method: 'GET', url: '/api/pause-all/token' })).json().token
      expect(token).toMatch(/^[A-Za-z0-9_-]{20,}$/)

      driver.setPlaying(OFFICE, 'x-rincon-queue:o#0', 'some-track')
      const res = await app.inject({ method: 'GET', url: `/api/webhooks/${token}` })
      expect(res.json().pausedGroupIds).toContain(OFFICE)
    })

    it('keeps the same token across restarts', async () => {
      const first = (await app.inject({ method: 'GET', url: '/api/pause-all/token' })).json().token
      const second = (await app.inject({ method: 'GET', url: '/api/pause-all/token' })).json().token
      expect(second).toBe(first)
    })
  })
})
