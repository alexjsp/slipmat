import type {
  BrowseResponse,
  Preset,
  PresetInput,
  PresetStatus,
  ResolveUrlResponse,
} from '@domovoi/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError } from './api'

async function json<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  })
  if (!res.ok) {
    let message = res.statusText
    try {
      const body = (await res.json()) as { message?: string }
      if (body.message) message = body.message
    } catch {
      // Fall back to the status text.
    }
    throw new ApiError(res.status, message)
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T)
}

type PresetListResponse = { presets: Preset[]; statuses: PresetStatus[] }

export function usePresets() {
  return useQuery({
    queryKey: ['presets'],
    queryFn: () => json<PresetListResponse>('/api/presets'),
  })
}

export function usePresetMutations() {
  const queryClient = useQueryClient()
  // Preset writes change activation state too, so refresh both together.
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['presets'] })
  }

  return {
    create: useMutation({
      mutationFn: (input: PresetInput) =>
        json<{ preset: Preset }>('/api/presets', { method: 'POST', body: JSON.stringify(input) }),
      onSuccess: invalidate,
    }),
    update: useMutation({
      mutationFn: ({ id, input }: { id: string; input: PresetInput }) =>
        json<{ preset: Preset }>(`/api/presets/${id}`, {
          method: 'PATCH',
          body: JSON.stringify(input),
        }),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (id: string) => json<void>(`/api/presets/${id}`, { method: 'DELETE' }),
      onSuccess: invalidate,
    }),
    activate: useMutation({
      mutationFn: (id: string) =>
        json<{ warnings: string[] }>(`/api/presets/${id}/activate`, { method: 'POST' }),
      onSuccess: invalidate,
    }),
    stop: useMutation({
      mutationFn: (id: string) =>
        json<{ stopped: boolean }>(`/api/presets/${id}/stop`, { method: 'POST' }),
      onSuccess: invalidate,
    }),
    restart: useMutation({
      mutationFn: (id: string) =>
        json<{ warnings: string[] }>(`/api/presets/${id}/restart`, { method: 'POST' }),
      onSuccess: invalidate,
    }),
    refreshSources: useMutation({
      mutationFn: (id: string) =>
        json<{ preset: Preset }>(`/api/presets/${id}/refresh-sources`, { method: 'POST' }),
      onSuccess: invalidate,
    }),
    regenerateToken: useMutation({
      mutationFn: (id: string) =>
        json<{ webhookToken: string }>(`/api/presets/${id}/regenerate-token`, { method: 'POST' }),
      onSuccess: invalidate,
    }),
  }
}

export function useBrowse(path: string, enabled: boolean) {
  return useQuery({
    queryKey: ['browse', path],
    queryFn: () => json<BrowseResponse>(`/api/sources/browse?path=${encodeURIComponent(path)}`),
    enabled,
    // Browsing hits real speakers; there's no need to re-fetch a folder often.
    staleTime: 5 * 60 * 1000,
  })
}

export function resolveUrl(url: string) {
  return json<ResolveUrlResponse>('/api/sources/resolve', {
    method: 'POST',
    body: JSON.stringify({ url }),
  })
}

export function webhookUrl(token: string): string {
  return `${window.location.origin}/api/webhooks/${token}`
}
