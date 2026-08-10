import type { ServerEvent } from '@slipmat/shared'
import type { FastifyInstance } from 'fastify'
import type { SystemStateStore } from '../state/store.js'

export type SystemRoutesDeps = {
  store: SystemStateStore
}

export async function registerSystemRoutes(app: FastifyInstance, { store }: SystemRoutesDeps) {
  app.get('/api/system', async () => store.current)

  app.get('/api/events', { websocket: true }, (socket) => {
    const send = (event: ServerEvent) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event))
    }

    send({ type: 'snapshot', state: store.current })

    const onChange = (state: typeof store.current) => send({ type: 'state', state })
    store.on('change', onChange)

    socket.on('message', (raw: Buffer) => {
      try {
        const parsed = JSON.parse(raw.toString()) as { type?: string }
        // A client that saw a revision gap asks for a fresh snapshot rather
        // than trying to patch around the hole.
        if (parsed.type === 'resync') send({ type: 'snapshot', state: store.current })
      } catch {
        // Ignore malformed frames; the client will resync on its own.
      }
    })

    socket.on('close', () => store.off('change', onChange))
    socket.on('error', () => store.off('change', onChange))
  })
}
