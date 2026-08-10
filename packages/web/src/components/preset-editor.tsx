import type { Preset, PresetInput, Zone } from '@slipmat/shared'
import { Check, Copy, GripVertical, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  type DraftRule,
  nextRuleKey,
  RuleEditor,
  type RulesResponse,
} from '@/components/rule-editor'
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
import { getJson, saveRules } from '@/lib/api'
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
      shrink: null,
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
    shrink: preset.shrink,
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
  // Rules live here rather than inside RuleEditor so they are saved by the one
  // Save button, and so a preset can carry rules before it exists.
  const [rules, setRules] = useState<DraftRule[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mutations = usePresetMutations()
  const homekit = useHomeKit()

  // Re-seed whenever a different preset is opened.
  useEffect(() => {
    if (!open) return
    setDraft(draftFrom(preset))
    setError(null)
    if (!preset) {
      setRules([])
      return
    }
    let cancelled = false
    getJson<RulesResponse>(`/api/presets/${preset.id}/rules`)
      .then((data) => {
        if (cancelled) return
        setRules(
          data.rules.map((rule) => ({
            key: nextRuleKey(),
            label: rule.label,
            enabled: rule.enabled,
            condition: rule.condition,
            effect: rule.effect,
          })),
        )
      })
      .catch(() => {
        // The preset is still editable without its rules; saving would wipe
        // them, so say so rather than quietly presenting an empty list.
        if (!cancelled) setError('Existing rules could not be loaded — saving would remove them.')
      })
    return () => {
      cancelled = true
    }
  }, [open, preset])

  const patch = (changes: Partial<Draft>) => setDraft((current) => ({ ...current, ...changes }))

  // Keep the wind-down list honest as speakers are ticked and unticked. The
  // coordinator moves when you untick the first speaker, and a keep list that
  // has lost its coordinator — or names a speaker no longer in the preset — is
  // rejected on save, which is a poor way to find out.
  useEffect(() => {
    const shrink = draft.shrink
    if (!shrink) return
    const zoneIds = new Set(draft.zones.map((zone) => zone.zoneId))
    const coordinator = draft.zones.find((zone) => zone.isCoordinator)?.zoneId
    const kept = shrink.keepZoneIds.filter((zoneId) => zoneIds.has(zoneId))
    const next = coordinator && !kept.includes(coordinator) ? [coordinator, ...kept] : kept
    const unchanged =
      next.length === shrink.keepZoneIds.length &&
      next.every((zoneId, index) => zoneId === shrink.keepZoneIds[index])
    if (unchanged) return
    setDraft((current) =>
      current.shrink ? { ...current, shrink: { ...current.shrink, keepZoneIds: next } } : current,
    )
  }, [draft.zones, draft.shrink])

  const toggleZone = (zoneId: string, selected: boolean) => {
    setDraft((current) => {
      const zones = selected
        ? [...current.zones, { zoneId, volume: DEFAULT_VOLUME, isCoordinator: false }]
        : current.zones.filter((zone) => zone.zoneId !== zoneId)

      // The queue lives on the coordinator, so one must always exist. Zones are
      // held in the order they were ticked, so this makes the first speaker you
      // pick the coordinator — and promotes the next one along if you untick it.
      const withCoordinator = zones.some((zone) => zone.isCoordinator)
        ? zones
        : zones.map((zone, index) => ({ ...zone, isCoordinator: index === 0 }))

      return { ...current, zones: withCoordinator }
    })
  }

  const coordinatorZoneId = draft.zones.find((zone) => zone.isCoordinator)?.zoneId
  const allZonesKept =
    draft.shrink !== null && draft.shrink.keepZoneIds.length >= draft.zones.length

  const canSave =
    draft.name.trim() !== '' &&
    draft.zones.length > 0 &&
    draft.sources.length > 0 &&
    // The server rejects these too; blocking Save says so before a round trip.
    !allZonesKept

  const save = async () => {
    setError(null)
    try {
      // Rules are saved after the preset, because a new one has no id to hang
      // them off until it exists.
      const saved = preset
        ? await mutations.update.mutateAsync({ id: preset.id, input: draft })
        : await mutations.create.mutateAsync(draft)
      const id = preset?.id ?? saved?.preset.id
      if (id)
        await saveRules(
          id,
          rules.map(({ key, ...rule }) => rule),
        )
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
        <SheetContent
          side="bottom"
          // A half-built preset is real work — several speakers, their volumes,
          // a source list, maybe a rule or two — and none of it is saved until
          // Save. A stray tap on the overlay is far too cheap a way to lose it,
          // and on a phone the overlay is most of the screen. Cancel and Save
          // are both right there; closing is left to them and to Escape.
          onInteractOutside={(event) => event.preventDefault()}
          // Don't land on the Name field. Radix focuses the first focusable
          // thing on open, which on iOS raises the keyboard over most of the
          // sheet before anyone has said they want to type — and the name is
          // usually the one field already filled in when editing.
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            // Focus still has to enter the dialog, or a keyboard user is left
            // behind on the trigger. Radix gives the content tabIndex -1 for it.
            if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus()
          }}
          className="max-h-[92dvh] overflow-y-auto overflow-x-hidden sm:mx-auto sm:max-w-2xl sm:rounded-t-xl sm:border-x"
        >
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
              <h3 className="font-medium text-sm">Speakers</h3>

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
                      {/* A real label, so the whole row toggles the checkbox —
                          including the empty space after a short name. */}
                      <label
                        htmlFor={`zone-${zone.id}`}
                        className={cn(
                          'flex-1 cursor-pointer py-1 text-sm',
                          selected?.isCoordinator && draft.zones.length > 1 && 'font-medium',
                        )}
                      >
                        {zone.name}
                        {selected?.isCoordinator && draft.zones.length > 1 && (
                          <span className="ml-2 text-muted-foreground text-xs">coordinator</span>
                        )}
                      </label>
                      {selected && (
                        <span className="w-8 shrink-0 text-right text-muted-foreground text-xs tabular-nums">
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

            <section className="flex flex-col gap-3 border-t pt-6">
              <ToggleRow
                id="shrink"
                label="Wind down to fewer speakers"
                description="Start everywhere, then keep playing in just some rooms."
                checked={draft.shrink !== null}
                onChange={(value) =>
                  patch({
                    // Defaults to the speaker holding the queue, which is the
                    // only one that can carry on alone.
                    shrink: value
                      ? {
                          afterMinutes: 30,
                          keepZoneIds: coordinatorZoneId ? [coordinatorZoneId] : [],
                        }
                      : null,
                  })
                }
              />

              {draft.shrink && (
                <div className="flex flex-col gap-3 pl-1">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="shrink-minutes" className="shrink-0">
                      After
                    </Label>
                    <Input
                      id="shrink-minutes"
                      type="number"
                      min={1}
                      max={1440}
                      className="w-20"
                      value={draft.shrink.afterMinutes}
                      onChange={(event) =>
                        patch({
                          shrink: draft.shrink
                            ? {
                                ...draft.shrink,
                                afterMinutes: Number(event.target.value) || 1,
                              }
                            : null,
                        })
                      }
                    />
                    <span className="text-muted-foreground text-sm">minutes, keep playing in</span>
                  </div>

                  {draft.zones.length === 0 ? (
                    <p className="text-muted-foreground text-xs">Pick some speakers first.</p>
                  ) : (
                    draft.zones.map((entry) => {
                      const zone = zones.find((z) => z.id === entry.zoneId)
                      const kept = draft.shrink?.keepZoneIds.includes(entry.zoneId) ?? false
                      // The coordinator holds the queue: drop it and the rooms
                      // you kept fall silent, so it is not up for debate.
                      const locked = entry.isCoordinator
                      return (
                        <div key={entry.zoneId} className="flex items-center gap-3">
                          <Checkbox
                            id={`keep-${entry.zoneId}`}
                            checked={kept || locked}
                            disabled={locked}
                            onCheckedChange={(checked) => {
                              const current = draft.shrink
                              if (!current) return
                              const next =
                                checked === true
                                  ? [...current.keepZoneIds, entry.zoneId]
                                  : current.keepZoneIds.filter((id) => id !== entry.zoneId)
                              patch({ shrink: { ...current, keepZoneIds: next } })
                            }}
                          />
                          <label htmlFor={`keep-${entry.zoneId}`} className="flex-1 text-sm">
                            {zone?.name ?? entry.zoneId}
                            {locked && (
                              <span className="ml-2 text-muted-foreground text-xs">
                                holds the queue — always kept
                              </span>
                            )}
                          </label>
                        </div>
                      )
                    })
                  )}
                  {allZonesKept && (
                    <p className="text-muted-foreground text-xs">
                      Keeping every speaker leaves nothing to drop.
                    </p>
                  )}
                </div>
              )}
            </section>

            <div className="border-t pt-6">
              <RuleEditor rules={rules} onChange={setRules} presetId={preset?.id} />
            </div>

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
