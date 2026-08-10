import { useQuery } from '@tanstack/react-query'
import { getJson } from '@/lib/api'

export type HomeKitInfo = {
  enabled: boolean
  running: boolean
  pincode: string | null
  setupUri: string | null
}

/**
 * HomeKit is opt-in, so anything that only makes sense with the bridge running
 * — the per-preset "Show in HomeKit" toggle, the pairing code — should not be
 * offered when it's switched off.
 */
export function useHomeKit() {
  return useQuery({
    queryKey: ['homekit'],
    queryFn: () => getJson<HomeKitInfo>('/api/homekit'),
    // Only changes when the server restarts with different settings.
    staleTime: Number.POSITIVE_INFINITY,
  })
}
