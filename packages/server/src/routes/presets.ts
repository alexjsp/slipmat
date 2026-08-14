import type { Preset, PresetRule, PresetStatus, RuleCondition, RuleEffect } from '@slipmat/shared'
import {
  presetInputSchema,
  presetRuleInputSchema,
  rulesGuaranteeASource,
  sourcesFromRules,
} from '@slipmat/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ActivationEngine } from '../presets/activate.js'
import type { PresetRepository } from '../presets/repository.js'
import { clockFrom, evaluateRules } from '../presets/rules.js'
import type { SonosDriver } from '../sonos/driver.js'
import type { SourceCache } from '../sources/cache.js'

export type PresetRoutesDeps = {
  /** IANA zone for the "what would this do right now?" preview. */
  timeZone: string
  repo: PresetRepository
  engine: ActivationEngine
  driver: SonosDriver
  cache: SourceCache
  /** Lets the HomeKit bridge add, rename or drop switches as presets change. */
  onPresetsChanged?: () => void
}

const idParamsSchema = z.object({ id: z.string().min(1) })

export async function registerPresetRoutes(
  app: FastifyInstance,
  { repo, engine, driver, cache, onPresetsChanged, timeZone }: PresetRoutesDeps,
) {
  const changed = () => onPresetsChanged?.()
  const zoneNames = () =>
    new Map(driver.snapshot().zones.map((zone) => [zone.id, zone.name] as const))

  /**
   * Attach what the resolver cache already knows, without resolving anything,
   * and what the preset's rules could play — which for a preset with no sources
   * of its own is all of its music.
   */
  const withSourceMeta = (preset: Preset): Preset => ({
    ...preset,
    ruleSources: sourcesFromRules(repo.rulesFor(preset.id)),
    sources: preset.sources.map((source) => {
      const cached = cache.peek({ kind: source.kind, ref: source.ref })
      return {
        ...source,
        resolutionMode: cached?.mode ?? null,
        trackCount: cached ? cached.tracks.length : null,
        resolvedAt: cached?.resolvedAt ?? null,
        resolveError: cached?.warning ?? null,
      }
    }),
  })

  const statusOf = (preset: Preset): PresetStatus => {
    const activation = engine.liveActivation(preset.id)
    const active = engine.isStillPlaying(preset.id)
    const uris = activation ? (JSON.parse(activation.trackUrisJson) as string[]) : []
    return {
      presetId: preset.id,
      active,
      activationId: activation?.id ?? null,
      startedAt: activation?.startedAt ?? null,
      loading: false,
      tracksEnqueued: uris.length,
      tracksTotal: null,
      // Only while it is still going to happen: no wind-down configured, not
      // playing, or already wound down all mean there is nothing to count to.
      windDownAt:
        activation && !activation.shrunkAt && preset.shrink
          ? new Date(
              new Date(activation.startedAt).getTime() + preset.shrink.afterMinutes * 60_000,
            ).toISOString()
          : null,
      warnings: activation ? (JSON.parse(activation.warningsJson) as string[]) : [],
    }
  }

  app.get('/api/presets', async () => ({
    presets: repo.list().map(withSourceMeta),
    statuses: repo.list().map(statusOf),
  }))

  app.get('/api/presets/:id', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params)
    const preset = repo.get(id)
    if (!preset) return reply.status(404).send({ error: 'not_found', message: 'No such preset' })
    return { preset: withSourceMeta(preset), status: statusOf(preset) }
  })

  /**
   * A preset has to have something to play, but it does not have to own it: a
   * rule with no conditions counts, which is what lets a preset be nothing but
   * "rotate through these three playlists".
   */
  const nothingToPlay = (
    sources: unknown[],
    rules: Array<{ enabled: boolean; condition: RuleCondition; effect: RuleEffect }>,
  ) => sources.length === 0 && !rulesGuaranteeASource(rules)

  const silentPresetError = {
    error: 'nothing_to_play',
    message:
      'This preset has no sources of its own, so it needs a rule with no conditions that plays something',
  }

  app.post('/api/presets', async (request, reply) => {
    const input = presetInputSchema.parse(request.body)
    if (nothingToPlay(input.sources, input.rules ?? [])) {
      return reply.status(400).send(silentPresetError)
    }
    const preset = repo.create(input, zoneNames())
    changed()
    // Warm the cache in the background so the first activation is instant.
    void warmSources(cache, preset, repo.rulesFor(preset.id))
    return reply.status(201).send({ preset: withSourceMeta(preset) })
  })

  app.patch('/api/presets/:id', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params)
    const input = presetInputSchema.parse(request.body)
    // Rules left out of the request are the ones already stored, and they are
    // what the preset will still be relying on afterwards.
    if (nothingToPlay(input.sources, input.rules ?? repo.rulesFor(id))) {
      return reply.status(400).send(silentPresetError)
    }
    const preset = repo.update(id, input, zoneNames())
    if (!preset) return reply.status(404).send({ error: 'not_found', message: 'No such preset' })
    changed()
    void warmSources(cache, preset, repo.rulesFor(id))
    return { preset: withSourceMeta(preset) }
  })

  app.delete('/api/presets/:id', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params)
    if (!repo.delete(id)) {
      return reply.status(404).send({ error: 'not_found', message: 'No such preset' })
    }
    changed()
    return reply.status(204).send()
  })

  app.post('/api/presets/:id/activate', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params)
    const preset = repo.get(id)
    if (!preset) return reply.status(404).send({ error: 'not_found', message: 'No such preset' })
    try {
      return await engine.activate(preset, { trigger: 'ui' })
    } catch (err) {
      request.log.warn({ err, presetId: id }, 'activation failed')
      return reply.status(502).send({
        error: 'activation_failed',
        message: err instanceof Error ? err.message : 'Could not start this preset',
      })
    }
  })

  app.post('/api/presets/:id/restart', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params)
    const preset = repo.get(id)
    if (!preset) return reply.status(404).send({ error: 'not_found', message: 'No such preset' })
    return engine.activate(preset, { restart: true, trigger: 'ui' })
  })

  app.post('/api/presets/:id/stop', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params)
    if (!repo.get(id)) {
      return reply.status(404).send({ error: 'not_found', message: 'No such preset' })
    }
    const stopped = await engine.stop(id)
    return { stopped }
  })

  app.post('/api/presets/:id/regenerate-token', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params)
    const token = repo.regenerateWebhookToken(id)
    if (!token) return reply.status(404).send({ error: 'not_found', message: 'No such preset' })
    return { webhookToken: token }
  })

  /** Force a re-resolve, e.g. after adding tracks to a playlist. */
  app.post('/api/presets/:id/refresh-sources', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params)
    const preset = repo.get(id)
    if (!preset) return reply.status(404).send({ error: 'not_found', message: 'No such preset' })
    for (const source of preset.sources) {
      await cache.refresh({ kind: source.kind, ref: source.ref, label: source.label })
    }
    return { preset: withSourceMeta(repo.get(id)!) }
  })

  // --- conditional rules --------------------------------------------------

  app.get('/api/presets/:id/rules', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params)
    const preset = repo.get(id)
    if (!preset) return reply.status(404).send({ error: 'not_found', message: 'No such preset' })
    return {
      rules: repo.rulesFor(id),
      // What this preset would actually do if fired right now — so a rule can
      // be checked without waiting for Thursday.
      preview: evaluateRules(preset, repo.rulesFor(id), clockFrom(new Date(), timeZone)),
    }
  })

  app.put('/api/presets/:id/rules', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params)
    const preset = repo.get(id)
    if (!preset) return reply.status(404).send({ error: 'not_found', message: 'No such preset' })

    const body = z.object({ rules: z.array(presetRuleInputSchema) }).parse(request.body)

    // A preset with no sources of its own leans entirely on its rules. Saving
    // rules that no longer cover every day would leave it silent on the days
    // they miss, and the only way to find that out is to wait for one.
    if (nothingToPlay(preset.sources, body.rules)) {
      return reply.status(400).send(silentPresetError)
    }

    const rules = repo.setRules(id, body.rules)

    // Rules can introduce sources the cache has never seen; warm them now so
    // the first matching activation isn't the one that pays for a cold resolve.
    void warmSources(cache, preset, rules)

    return {
      rules,
      preview: evaluateRules(preset, rules, clockFrom(new Date(), timeZone)),
    }
  })

  app.get('/api/presets/export', async () => ({ presets: repo.list() }))
}

async function warmSources(cache: SourceCache, preset: Preset, rules: PresetRule[] = []) {
  // Rules included: they can introduce sources the preset never mentions, and a
  // preset with no sources of its own has nothing else to warm.
  const sources = [
    ...preset.sources.map((source) => ({
      kind: source.kind,
      ref: source.ref,
      label: source.label,
    })),
    ...rules.flatMap((rule) => [
      ...(rule.effect.addSources ?? []),
      ...(rule.effect.replaceSources ?? []),
      ...(rule.effect.rotateSources?.sources ?? []),
    ]),
  ]

  // One source at a time. Resolving an expensive one borrows a speaker's queue,
  // and several at once means several speakers borrowed simultaneously — on a
  // system that reacts badly to being asked for more than one thing at a time.
  // Nobody is waiting on this; it runs after the save has been answered.
  for (const source of sources) {
    try {
      await cache.get(source)
    } catch {
      // A source that will not resolve is surfaced when the preset is used.
    }
  }
}
