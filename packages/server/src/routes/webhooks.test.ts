import { Writable } from 'node:stream'
import { pino } from 'pino'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import type { Logger } from '../logger.js'
import { buildServer } from '../server.js'
import { FakeSonosDriver } from '../sonos/fake-driver.js'

describe('webhook logging', () => {
  const servers: Awaited<ReturnType<typeof buildServer>>[] = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((app) => app.close()))
  })

  it('never writes the token into the request log', async () => {
    const lines: string[] = []
    const sink = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk))
        done()
      },
    })
    const app = await buildServer({
      config: loadConfig({ SLIPMAT_FAKE_SONOS: '1', SLIPMAT_DATA_DIR: ':memory:' }),
      logger: pino({ level: 'info' }, sink) as unknown as Logger,
      driver: new FakeSonosDriver(),
    })
    servers.push(app)

    const { token } = (await app.inject({ method: 'GET', url: '/api/pause-all/token' })).json()
    await app.inject({ method: 'POST', url: `/api/webhooks/${token}` })
    await app.inject({ method: 'GET', url: '/api/webhooks/guessed-token?action=stop' })

    const log = lines.join('')
    expect(log).toContain('/api/webhooks/[redacted]')
    expect(log).not.toContain(token)
    expect(log).not.toContain('guessed-token')
  })
})
