import type { SystemState } from '@slipmat/shared'
import { GroupCard } from '@/components/group-card'

export function NowPlayingPage({
  state,
  onError,
}: {
  state: SystemState
  onError: (message: string) => void
}) {
  // Rooms doing nothing are noise; a card per idle speaker buries what's playing.
  const active = state.groups.filter((group) => group.playbackKind !== 'idle')
  const idle = state.groups.filter((group) => group.playbackKind === 'idle')

  return (
    <div className="flex flex-col gap-3">
      {active.map((group) => (
        <GroupCard key={group.id} group={group} zones={state.zones} onError={onError} />
      ))}

      {active.length === 0 && (
        <p className="py-8 text-center text-muted-foreground text-sm">Nothing playing.</p>
      )}

      {idle.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-muted-foreground text-sm">
            {idle.length} idle {idle.length === 1 ? 'room' : 'rooms'}
          </summary>
          <div className="mt-3 flex flex-col gap-3">
            {idle.map((group) => (
              <GroupCard key={group.id} group={group} zones={state.zones} onError={onError} />
            ))}
          </div>
        </details>
      )}
    </div>
  )
}
