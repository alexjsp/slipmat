/**
 * Sonos reports durations and positions as `H:MM:SS`, and uses `NOT_IMPLEMENTED`
 * or `0:00:00` for streams that have no meaningful length.
 */
export function parseDuration(value: string | undefined | null): number | null {
  if (!value) return null
  const parts = value.split(':')
  if (parts.length !== 3) return null
  const [h, m, s] = parts
  const hours = Number(h)
  const minutes = Number(m)
  const seconds = Number(s)
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) return null
  const total = hours * 3600 + minutes * 60 + seconds
  return total > 0 ? total : null
}

export function formatDuration(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  const seconds = safe % 60
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${hours}:${pad(minutes)}:${pad(seconds)}`
}
