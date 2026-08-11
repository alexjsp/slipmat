import { useEffect, useState } from 'react'

/**
 * Whole seconds until a moment, or null once there is nothing to wait for.
 *
 * A countdown sitting at zero is worse than no countdown, because the thing it
 * was counting to has already happened — so a moment in the past reads as null.
 */
function secondsUntil(target: string | null): number | null {
  if (!target) return null
  const seconds = Math.round((new Date(target).getTime() - Date.now()) / 1000)
  return seconds > 0 ? seconds : null
}

/**
 * Seconds remaining until a moment, ticking locally.
 *
 * The server sends the moment itself rather than a number of seconds, so this
 * counts down smoothly instead of lurching whenever a fresh figure arrives —
 * the same reason the seek bar interpolates between position polls.
 */
export function useCountdown(target: string | null): number | null {
  const [seconds, setSeconds] = useState(() => secondsUntil(target))

  useEffect(() => {
    setSeconds(secondsUntil(target))
    if (!target) return
    const timer = setInterval(() => setSeconds(secondsUntil(target)), 1000)
    return () => clearInterval(timer)
  }, [target])

  return seconds
}

/** `18:41`, or `1:18:41` once there is more than an hour to go. */
export function formatCountdown(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60
  const mm = String(minutes).padStart(2, '0')
  const ss = String(secs).padStart(2, '0')
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`
}
