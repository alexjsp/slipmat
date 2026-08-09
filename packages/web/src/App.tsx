import { GroupCard } from '@/components/group-card'
import { useSystemState } from '@/lib/system-state'
import { cn } from '@/lib/utils'

export function App() {
  const { state, status } = useSystemState()

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-4 p-4 pb-16">
      <header className="flex items-baseline justify-between gap-4">
        <h1 className="font-semibold text-xl tracking-tight">Domovoi</h1>
        <span
          className={cn(
            'text-xs',
            status === 'open' ? 'text-muted-foreground' : 'text-destructive',
          )}
        >
          {status === 'open' ? 'live' : status === 'connecting' ? 'connecting…' : 'reconnecting…'}
        </span>
      </header>

      {!state ? (
        <p className="text-muted-foreground text-sm">Loading…</p>
      ) : !state.ready ? (
        <p className="text-muted-foreground text-sm">
          No Sonos devices found yet. Check host networking, or set <code>DOMOVOI_SEED_IP</code>.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {state.groups.map((group) => (
            <GroupCard key={group.id} group={group} zones={state.zones} />
          ))}
        </div>
      )}
    </main>
  )
}
