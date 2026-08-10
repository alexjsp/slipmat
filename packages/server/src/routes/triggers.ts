import { triggerInputSchema } from '@domovoi/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { TriggerRepository } from '../triggers/repository.js'
import type { Scheduler } from '../triggers/scheduler.js'

export type TriggerRoutesDeps = {
  triggers: TriggerRepository
  scheduler: Scheduler
  timeZone: string
}

const idParamsSchema = z.object({ id: z.string().min(1) })

export async function registerTriggerRoutes(
  app: FastifyInstance,
  { triggers, timeZone }: TriggerRoutesDeps,
) {
  app.get('/api/triggers', async () => ({
    triggers: triggers.list(),
    // The UI shows this so "07:30" is unambiguous when the container's zone
    // isn't what the user assumed.
    timeZone,
  }))

  app.post('/api/triggers', async (request, reply) => {
    const input = triggerInputSchema.parse(request.body)
    return reply.status(201).send({ trigger: triggers.create(input) })
  })

  app.patch('/api/triggers/:id', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params)
    const input = triggerInputSchema.parse(request.body)
    const trigger = triggers.update(id, input)
    if (!trigger) return reply.status(404).send({ error: 'not_found', message: 'No such trigger' })
    return { trigger }
  })

  app.post('/api/triggers/:id/enabled', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params)
    const { enabled } = z.object({ enabled: z.boolean() }).parse(request.body)
    const trigger = triggers.setEnabled(id, enabled)
    if (!trigger) return reply.status(404).send({ error: 'not_found', message: 'No such trigger' })
    return { trigger }
  })

  app.delete('/api/triggers/:id', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params)
    if (!triggers.delete(id)) {
      return reply.status(404).send({ error: 'not_found', message: 'No such trigger' })
    }
    return reply.status(204).send()
  })
}
