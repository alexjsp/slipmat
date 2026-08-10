import type { ServerEvent, SystemState } from '@slipmat/shared'
import { useEffect, useRef, useState } from 'react'

export type ConnectionStatus = 'connecting' | 'open' | 'closed'

/**
 * Live household state.
 *
 * The WebSocket is the source of truth once connected — the initial fetch just
 * avoids an empty first paint. On disconnect we reconnect with backoff and ask
 * for a fresh snapshot, because a gap in `revision` means we've missed deltas.
 */
export function useSystemState() {
  const [state, setState] = useState<SystemState | null>(null)
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const socketRef = useRef<WebSocket | null>(null)
  const attemptRef = useRef(0)

  useEffect(() => {
    let disposed = false
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined

    void fetch('/api/system')
      .then((res) => (res.ok ? res.json() : null))
      .then((initial: SystemState | null) => {
        // Don't clobber anything the socket has already delivered.
        if (!disposed && initial) setState((current) => current ?? initial)
      })
      .catch(() => undefined)

    const connect = () => {
      if (disposed) return
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const socket = new WebSocket(`${protocol}//${window.location.host}/api/events`)
      socketRef.current = socket

      socket.onopen = () => {
        attemptRef.current = 0
        setStatus('open')
      }

      socket.onmessage = (event) => {
        const parsed = JSON.parse(event.data as string) as ServerEvent
        if (parsed.type === 'snapshot' || parsed.type === 'state') setState(parsed.state)
      }

      socket.onclose = () => {
        if (disposed) return
        setStatus('closed')
        attemptRef.current += 1
        const delay = Math.min(1000 * 2 ** (attemptRef.current - 1), 15_000)
        reconnectTimer = setTimeout(connect, delay)
      }

      socket.onerror = () => socket.close()
    }

    connect()

    return () => {
      disposed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      socketRef.current?.close()
    }
  }, [])

  return { state, status }
}
