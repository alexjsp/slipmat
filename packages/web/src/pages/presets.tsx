import type { Preset, PresetStatus, Zone } from '@domovoi/shared'
import { AlertTriangle, Loader2, Pencil, Play, Plus, RotateCcw, Square } from 'lucide-react'
import { useState } from 'react'
import { PresetEditor } from '@/components/preset-editor'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { usePresetMutations, usePresets } from '@/lib/presets'
import { cn } from '@/lib/utils'

export function PresetsPage({ zones, onError }: { zones: Zone[]; onError: (m: string) => void }) {
  const { data, isPending, isError } = usePresets()
  const [editing, setEditing] = useState<Preset | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)

  const openNew = () => {
    setEditing(null)
    setEditorOpen(true)
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-lg">Presets</h2>
        <Button size="sm" onClick={openNew}>
          <Plus className="size-4" />
          New
        </Button>
      </div>

      {isPending ? (
        <p className="text-muted-foreground text-sm">Loading…</p>
      ) : isError ? (
        <p className="text-destructive text-sm">Could not load presets.</p>
      ) : data.presets.length === 0 ? (
        <Card className="p-6 text-center">
          <p className="text-muted-foreground text-sm">
            No presets yet. Create one to group speakers and shuffle playlists together.
          </p>
          <Button className="mt-3 self-center" onClick={openNew}>
            <Plus className="size-4" />
            New preset
          </Button>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {data.presets.map((preset) => (
            <PresetTile
              key={preset.id}
              preset={preset}
              status={data.statuses.find((entry) => entry.presetId === preset.id)}
              onEdit={() => {
                setEditing(preset)
                setEditorOpen(true)
              }}
              onError={onError}
            />
          ))}
        </div>
      )}

      <PresetEditor open={editorOpen} onOpenChange={setEditorOpen} preset={editing} zones={zones} />
    </div>
  )
}

function PresetTile({
  preset,
  status,
  onEdit,
  onError,
}: {
  preset: Preset
  status: PresetStatus | undefined
  onEdit: () => void
  onError: (message: string) => void
}) {
  const mutations = usePresetMutations()
  const active = status?.active ?? false
  const busy =
    mutations.activate.isPending || mutations.stop.isPending || mutations.restart.isPending

  const run = (action: Promise<unknown>) => {
    action.catch((err: Error) => onError(err.message))
  }

  return (
    <Card
      className={cn(
        'gap-0 overflow-hidden p-0 transition-colors',
        active && 'border-primary/60 bg-primary/5',
      )}
    >
      <div className="flex items-start gap-3 p-4">
        <button
          type="button"
          aria-label={active ? `Stop ${preset.name}` : `Start ${preset.name}`}
          disabled={busy}
          onClick={() =>
            run(
              active
                ? mutations.stop.mutateAsync(preset.id)
                : mutations.activate.mutateAsync(preset.id).then((result) => {
                    // Warnings mean it started, but not exactly as configured.
                    if (result.warnings.length > 0) onError(result.warnings.join('. '))
                    return result
                  }),
            )
          }
          className={cn(
            'flex size-12 shrink-0 items-center justify-center rounded-full transition-colors',
            active
              ? 'bg-primary text-primary-foreground'
              : 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
            busy && 'opacity-60',
          )}
        >
          {busy ? (
            <Loader2 className="size-5 animate-spin" />
          ) : active ? (
            <Square className="size-4 fill-current" />
          ) : (
            <Play className="size-5 fill-current" />
          )}
        </button>

        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h3 className="truncate font-medium">{preset.name}</h3>
          <p className="truncate text-muted-foreground text-xs">
            {preset.zones.map((zone) => zone.zoneName).join(' + ')}
          </p>
          <p className="truncate text-muted-foreground text-xs">
            {preset.sources.map((source) => source.label).join(', ')}
          </p>
        </div>

        <div className="flex shrink-0 flex-col gap-1">
          <Button variant="ghost" size="icon" aria-label="Edit preset" onClick={onEdit}>
            <Pencil className="size-4" />
          </Button>
          {active && (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Reshuffle"
              disabled={busy}
              onClick={() => run(mutations.restart.mutateAsync(preset.id))}
            >
              <RotateCcw className="size-4" />
            </Button>
          )}
        </div>
      </div>

      {status && status.warnings.length > 0 && (
        <div className="flex items-start gap-2 border-t bg-amber-500/10 px-4 py-2 text-amber-600 text-xs dark:text-amber-400">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{status.warnings.join('. ')}</span>
        </div>
      )}
    </Card>
  )
}
