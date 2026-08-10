import { useEffect, useRef, useState } from 'react'

/**
 * Smoothly advancing playback position.
 *
 * Sonos never pushes position, so the server polls it every few seconds. Using
 * that value directly makes the progress bar lurch forward in visible jumps.
 * This ticks locally between updates and re-syncs whenever a fresh value
 * arrives, so the bar moves continuously without polling any harder.
 */
const TICK_MS = 500

export function useProgress(
  positionSeconds: number | null,
  isPlaying: boolean,
  durationSeconds: number | null,
): number | null {
  const [displayed, setDisplayed] = useState(positionSeconds)
  // When the server last told us something, in local time.
  const anchor = useRef({ at: Date.now(), position: positionSeconds })

  // Re-anchor on every server value, including one that repeats: a paused
  // track reporting the same second twice still means "this is the truth now".
  useEffect(() => {
    anchor.current = { at: Date.now(), position: positionSeconds }
    setDisplayed(positionSeconds)
  }, [positionSeconds])

  useEffect(() => {
    if (!isPlaying || anchor.current.position === null) return

    const timer = setInterval(() => {
      const base = anchor.current.position
      if (base === null) return
      const elapsed = (Date.now() - anchor.current.at) / 1000
      const next = base + elapsed
      // Don't run past the end while waiting for the next track to be reported.
      setDisplayed(durationSeconds === null ? next : Math.min(next, durationSeconds))
    }, TICK_MS)

    return () => clearInterval(timer)
  }, [isPlaying, durationSeconds])

  return displayed
}
