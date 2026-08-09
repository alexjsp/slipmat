import { z } from 'zod'
import { presetStatusSchema } from './presets.js'
import { systemStateSchema } from './zones.js'

/**
 * Server -> client over the /api/events WebSocket.
 *
 * `snapshot` is sent on connect and whenever the client's revision is stale;
 * everything else is a delta. Clients that see a revision gap ask for a
 * snapshot rather than trying to patch.
 */
export const serverEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), state: systemStateSchema }),
  z.object({ type: z.literal('state'), state: systemStateSchema }),
  z.object({ type: z.literal('presetStatus'), status: presetStatusSchema }),
  z.object({ type: z.literal('presetsChanged') }),
  z.object({
    type: z.literal('toast'),
    level: z.enum(['info', 'warn', 'error']),
    message: z.string(),
  }),
])
export type ServerEvent = z.infer<typeof serverEventSchema>

export const clientEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping') }),
  z.object({ type: z.literal('resync') }),
])
export type ClientEvent = z.infer<typeof clientEventSchema>
