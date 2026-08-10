import type { Preset, PresetInput, Zone } from '@domovoi/shared'
import { Check, Copy, GripVertical, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { RuleEditor } from '@/components/rule-editor'
import { SourcePicker } from '@/components/source-picker'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { usePresetMutations, webhookUrl } from '@/lib/presets'
import { useHomeKit } from '@/lib/use-homekit'
import { cn } from '@/lib/utils'

type Draft = PresetInput

const DEFAULT_VOLUME = 20

function draftFrom(preset: Preset | null): Draft {
  if (!preset) {
    return {
      name: '',
      icon: null,
      color: null,
      zones: [],
      sources: [],
      shuffle: true,
      repeatAll: true,
      dedupe: true,
      pauseOthers: false,
      crossfade: false,
      homekitEnabled: false,
    }
  }
  return {
    name: preset.name,
    icon: preset.icon,
    color: preset.color,
    zones: preset.zones.map((zone) => ({
      zoneId: zone.zoneId,
      volume: zone.volume,
      isCoordinator: zone.isCoordinator,
    })),
    sources: preset.sources.map((source) => ({
      kind: source.kind,
      ref: source.ref,
      label: source.label,
    })),
    shuffle: preset.shuffle,
    repeatAll: preset.repeatAll,
    dedupe: preset.dedupe,
    pauseOthers: preset.pauseOthers,
    crossfade: preset.crossfade,
    homekitEnabled: preset.homekitEnabled,
  }
}

export function PresetEditor({
  open,
  onOpenChange,
  preset,
  zones,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  preset: Preset | null
  zones: Zone[]
}) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(preset))
  const [pickerOpen, setPickerOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mutations = usePresetMutations()
  const homekit = useHomeKit()

  // Re-seed whenever a different preset is opened.
  useEffect(() => {
    if (open) {
      setDraft(draftFrom(preset))
      setError(null)
    }
  }, [open, preset])

  const patch = (changes: Partial<Draft>) => setDraft((current) => ({ ...current, ...changes }))

  const toggleZone = (zoneId: string, selected: boolean) => {
    setDraft((current) => {
      const zones = selected
        ? [...current.zones, { zoneId, volume: DEFAULT_VOLUME, isCoordinator: false }]
        : current.zones.filter((zone) => zone.zoneId !== zoneId)
      // The queue lives on the coordinator, so one must always exist.
      if (!zones.some((zone) => zone.isCoordinator) && zones[0]) zones[0].isCoordinator = true
      return { ...current, zones }
    })
  }

  const canSave = draft.name.trim() !== '' && draft.zones.length > 0 && draft.sources.length > 0

  const save = async () => {
    setError(null)
    try {
      if (preset) {
        await mutations.update.mutateAsync({ id: preset.id, input: draft })
      } else {
        await mutations.create.mutateAsync(draft)
      }
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save this preset')
    }
  }

  const remove = async () => {
    if (!preset) return
    await mutations.remove.mutateAsync(preset.id)
    onOpenChange(false)
  }

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="bottom" className="max-h-[92dvh] overflow-y-auto overflow-x-hidden">
          <SheetHeader>
            <SheetTitle>{preset ? 'Edit preset' : 'New preset'}</SheetTitle>
            <SheetDescription>
              Group speakers, set their volumes, and shuffle several sources together.
            </SheetDescription>
          </SheetHeader>

          <div className="flex flex-col gap-6 px-4 pb-10">
            <div className="flex flex-col gap-2">
              <Label htmlFor="preset-name">Name</Label>
              <Input
                id="preset-name"
                value={draft.name}
                placeholder="Morning Kitchen"
                onChange={(event) => patch({ name: event.target.value })}
              />
            </div>

            <section className="flex flex-col gap-3">
              <div className="flex items-baseline justify-between">
                <h3 className="font-medium text-sm">Speakers</h3>
                {draft.zones.length > 1 && (
                  <span className="text-muted-foreground text-xs">
                    Tap a name to make it the coordinator
                  </span>
                )}
              </div>

              {zones.map((zone) => {
                const selected = draft.zones.find((entry) => entry.zoneId === zone.id)
                return (
                  <div key={zone.id} className="flex flex-col gap-2">
                    <div className="flex items-center gap-3">
                      <Checkbox
                        id={`zone-${zone.id}`}
                        checked={!!selected}
                        onCheckedChange={(checked) => toggleZone(zone.id, checked === true)}
                      />
                      <button
                        type="button"
                        disabled={!selected}
                        onClick={() =>
                          patch({
                            zones: draft.zones.map((entry) => ({
                              ...entry,
                              isCoordinator: entry.zoneId === zone.id,
                            })),
                          })
                        }
                        className={cn(
                          'flex-1 text-left text-sm disabled:cursor-default',
                          selected?.isCoordinator && 'font-medium',
                        )}
                      >
                        {zone.name}
                        {selected?.isCoordinator && draft.zones.length > 1 && (
                          <span className="ml-2 text-muted-foreground text-xs">coordinator</span>
                        )}
                      </button>
                      {selected && (
                        <span className="w-8 text-right text-muted-foreground text-xs tabular-nums">
                          {selected.volume}
                        </span>
                      )}
                    </div>
                    {selected && (
                      // Indent with padding on a wrapper, not a margin on the
                      // slider: the slider is w-full, so a margin makes it wider
                      // than its parent and the whole sheet scrolls sideways.
                      <div className="pl-7">
                        <Slider
                          value={[selected.volume]}
                          min={0}
                          max={100}
                          step={1}
                          aria-label={`${zone.name} volume`}
                          onValueChange={([value]) =>
                            patch({
                              zones: draft.zones.map((entry) =>
                                entry.zoneId === zone.id
                                  ? { ...entry, volume: value ?? entry.volume }
                                  : entry,
                              ),
                            })
                          }
                        />
                      </div>
                    )}
                  </div>
                )
              })}
            </section>

            <section className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <h3 className="font-medium text-sm">Sources</h3>
                <Button size="sm" variant="outline" onClick={() => setPickerOpen(true)}>
                  <Plus className="size-4" />
                  Add
                </Button>
              </div>

              {draft.sources.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No sources yet. Add a playlist, favourite, or paste a link.
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {draft.sources.map((source, index) => (
                    <li
                      key={`${source.kind}:${source.ref}`}
                      className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
                    >
                      <GripVertical className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{source.label}</span>
                      <button
                        type="button"
                        aria-label={`Remove ${source.label}`}
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() =>
                          patch({ sources: draft.sources.filter((_, i) => i !== index) })
                        }
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="flex flex-col gap-4">
              <h3 className="font-medium text-sm">Behaviour</h3>
              <ToggleRow
                id="shuffle"
                label="Shuffle queue"
                description="Off plays each source right through, in the order you added them."
                checked={draft.shuffle}
                onChange={(value) => patch({ shuffle: value })}
              />
              <ToggleRow
                id="repeat-all"
                label="Repeat when the queue ends"
                description="Loop the shuffled pool rather than falling silent."
                checked={draft.repeatAll}
                onChange={(value) => patch({ repeatAll: value })}
              />
              <ToggleRow
                id="dedupe"
                label="Remove duplicates"
                description="A track in two sources is only queued once."
                checked={draft.dedupe}
                onChange={(value) => patch({ dedupe: value })}
              />
              <ToggleRow
                id="pause-others"
                label="Pause the rest of the house"
                description="Stops other music when this starts. Never touches the TV."
                checked={draft.pauseOthers}
                onChange={(value) => patch({ pauseOthers: value })}
              />
              <ToggleRow
                id="crossfade"
                label="Crossfade"
                description="Enables Sonos' crossfade on the queue, blending each track into the next."
                checked={draft.crossfade}
                onChange={(value) => patch({ crossfade: value })}
              />
              {/* Offering this with the bridge switched off would promise a
                  switch that never appears. */}
              {homekit.data?.enabled && (
                <ToggleRow
                  id="homekit"
                  label="Show in HomeKit"
                  description="Adds a switch to the Home app for this preset."
                  checked={draft.homekitEnabled}
                  onChange={(value) => patch({ homekitEnabled: value })}
                />
              )}
            </section>

            {preset && (
              <div className="border-t pt-6">
                <RuleEditor presetId={preset.id} />
              </div>
            )}

            {preset && (
              <section className="flex flex-col gap-2">
                <h3 className="font-medium text-sm">Webhook</h3>
                <div className="flex gap-2">
                  <Input
                    readOnly
                    value={webhookUrl(preset.webhookToken)}
                    className="font-mono text-xs"
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="Copy webhook URL"
                    onClick={() => {
                      void navigator.clipboard.writeText(webhookUrl(preset.webhookToken))
                      setCopied(true)
                      setTimeout(() => setCopied(false), 1500)
                    }}
                  >
                    {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                  </Button>
                </div>
                <p className="text-muted-foreground text-xs">
                  GET or POST this URL to start the preset. It carries its own secret, so it works
                  without signing in.
                </p>
              </section>
            )}

            {error && <p className="text-destructive text-sm">{error}</p>}

            <div className="flex gap-2">
              <Button onClick={() => void save()} disabled={!canSave}>
                {preset ? 'Save changes' : 'Create preset'}
              </Button>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              {preset && (
                <Button
                  variant="ghost"
                  className="ml-auto text-destructive"
                  onClick={() => void remove()}
                >
                  Delete
                </Button>
              )}
            </div>
          </div>
        </SheetContent>
      </Sheet>

      <SourcePicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onPick={(source) => patch({ sources: [...draft.sources, source] })}
      />
    </>
  )
}

function ToggleRow({
  id,
  label,
  description,
  checked,
  onChange,
}: {
  id: string
  label: string
  description?: string
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex flex-col gap-0.5">
        <Label htmlFor={id}>{label}</Label>
        {description && <p className="text-muted-foreground text-xs">{description}</p>}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  )
}
