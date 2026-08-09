import { useQuery } from '@tanstack/react-query'

export function App() {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: async () => {
      const res = await fetch('/api/health')
      if (!res.ok) throw new Error('health check failed')
      return (await res.json()) as { status: string; version: string }
    },
  })

  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-6 p-6">
      <header className="flex items-baseline justify-between">
        <h1 className="font-semibold text-2xl tracking-tight">Domovoi</h1>
        <span className="text-muted-foreground text-sm">
          {health.isPending
            ? 'connecting…'
            : health.isError
              ? 'server unreachable'
              : `api ${health.data.version}`}
        </span>
      </header>
      <p className="text-muted-foreground text-sm">
        Scaffolding in place. Zones and presets land in the next milestones.
      </p>
    </main>
  )
}
