export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  if (!res.ok) {
    let message = res.statusText
    try {
      const parsed = (await res.json()) as { message?: string }
      if (parsed.message) message = parsed.message
    } catch {
      // Non-JSON error body; the status text will have to do.
    }
    throw new ApiError(res.status, message)
  }

  if (res.status === 204) return undefined
  return res.json()
}

/**
 * A GET that fails loudly.
 *
 * Worth using in every `queryFn` rather than `fetch(...).json()`: an error
 * response is still valid JSON, so parsing it blindly hands the component an
 * object with none of the fields it expects. That is how a 500 on the rules
 * endpoint became `Cannot read properties of undefined (reading 'map')` and
 * unmounted the whole app.
 */
export function getJson<T>(path: string): Promise<T> {
  return request('GET', path) as Promise<T>
}

export const api = {
  play: (zoneId: string) => request('POST', `/api/zones/${zoneId}/play`),
  pause: (zoneId: string) => request('POST', `/api/zones/${zoneId}/pause`),
  next: (zoneId: string) => request('POST', `/api/zones/${zoneId}/next`),
  previous: (zoneId: string) => request('POST', `/api/zones/${zoneId}/previous`),
  seek: (zoneId: string, positionSeconds: number) =>
    request('POST', `/api/zones/${zoneId}/seek`, { positionSeconds }),
  setVolume: (zoneId: string, volume: number) =>
    request('POST', `/api/zones/${zoneId}/volume`, { volume }),
  setMute: (zoneId: string, muted: boolean) =>
    request('POST', `/api/zones/${zoneId}/mute`, { muted }),
  joinGroup: (coordinatorZoneId: string, zoneIds: string[]) =>
    request('POST', '/api/groups/join', { coordinatorZoneId, zoneIds }),
  leaveGroup: (zoneIds: string[]) => request('POST', '/api/groups/leave', { zoneIds }),
  pauseAll: () =>
    request('POST', '/api/pause-all') as Promise<{
      pausedGroupIds: string[]
      skippedGroupIds: string[]
    }>,
}
