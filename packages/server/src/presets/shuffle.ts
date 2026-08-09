import type { ResolvedTrack } from '../sources/resolver.js'

/**
 * Deterministic PRNG (mulberry32). Shuffles are seeded per activation so a run
 * can be reproduced from its seed when diagnosing "why did it play that?", and
 * so tests aren't flaky. A fresh seed per activation is what makes each
 * activation reshuffle.
 */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Two tracks are "the same" if they point at the same audio. Streaming URIs
 * carry per-request query strings (`?sid=…&flags=…&sn=…`) that differ between
 * sources for identical tracks, so those are stripped before comparing —
 * otherwise dedupe silently does nothing for the case it exists to handle.
 */
export function trackIdentity(track: ResolvedTrack): string {
  const [base] = track.uri.split('?')
  return (base ?? track.uri).toLowerCase()
}

export function dedupeTracks(tracks: ResolvedTrack[]): ResolvedTrack[] {
  const seen = new Set<string>()
  const output: ResolvedTrack[] = []
  for (const track of tracks) {
    const identity = trackIdentity(track)
    if (seen.has(identity)) continue
    seen.add(identity)
    output.push(track)
  }
  return output
}

/** Fisher–Yates. Returns a new array; the input is untouched. */
export function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const output = [...items]
  for (let i = output.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    const a = output[i]!
    const b = output[j]!
    output[i] = b
    output[j] = a
  }
  return output
}

export type BuildQueueOptions = {
  dedupe: boolean
  seed: number
}

/** Pool every source's tracks together, optionally dedupe, then shuffle. */
export function buildQueue(
  sources: ResolvedTrack[][],
  options: BuildQueueOptions,
): ResolvedTrack[] {
  const pooled = sources.flat()
  const deduped = options.dedupe ? dedupeTracks(pooled) : pooled
  return shuffle(deduped, createRandom(options.seed))
}
