import type { EffectivePreset, PresetRule, PresetRuleInput } from '@slipmat/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { SourcePicker } from '@/components/source-picker'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { getJson } from '@/lib/api'
import { cn } from '@/lib/utils'

const DAYS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
]

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export type RulesResponse = { rules: PresetRule[]; preview: EffectivePreset }

export type DraftRule = PresetRuleInput & { key: string }

let keyCounter = 0
export const nextRuleKey = () => `rule-${keyCounter++}`
const nextKey = nextRuleKey

/**
 * Rules make one preset behave differently depending on when it's fired.
 *
 * The preview line is the important part of this screen: rules are otherwise
 * only observable by waiting for the right day, which is a miserable way to
 * find out you got a condition backwards.
 */
export function RuleEditor({
  rules: draft,
  onChange: setDraft,
  presetId,
}: {
  rules: DraftRule[]
  onChange: (rules: DraftRule[]) => void
  /** Absent while the preset is still being created; enables the preview. */
  presetId?: string | undefined
}) {
  const [pickerFor, setPickerFor] = useState<{
    index: number
    mode: 'add' | 'replace' | 'rotate'
  } | null>(null)

  // Only the preview is fetched here. The rules themselves belong to the form
  // above, so they are saved with everything else rather than on their own.
  const query = useQuery({
    queryKey: ['rules', presetId],
    queryFn: async () => getJson<RulesResponse>(`/api/presets/${presetId}/rules`),
    enabled: presetId !== undefined,
  })

  const patch = (index: number, changes: Partial<DraftRule>) =>
    setDraft(draft.map((rule, i) => (i === index ? { ...rule, ...changes } : rule)))

  const addRule = () =>
    setDraft([
      ...draft,
      { key: nextKey(), label: 'New rule', enabled: true, condition: {}, effect: {} },
    ])

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-medium text-sm">Rules</h3>
          <p className="text-muted-foreground text-xs">
            Change what this preset plays depending on the day or time.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={addRule}>
          <Plus className="size-4" />
          Add rule
        </Button>
      </div>

      {query.data && (
        <div className="rounded-md border bg-muted/40 p-3 text-xs">
          <p className="font-medium">Right now this would play</p>
          <p className="text-muted-foreground">
            {query.data.preview.sources.map((source) => source.label).join(', ') || 'nothing'}
            {' · '}
            {query.data.preview.zoneVolumes
              .map((zone) => `${zone.zoneName} at ${zone.volume}`)
              .join(', ')}
          </p>
          {query.data.preview.appliedRuleLabels.length > 0 && (
            <p className="mt-1 text-muted-foreground">
              Applying: {query.data.preview.appliedRuleLabels.join(', ')}
            </p>
          )}
        </div>
      )}

      {draft.map((rule, index) => (
        <div key={rule.key} className="flex flex-col gap-3 rounded-md border p-3">
          <div className="flex items-center gap-2">
            <Input
              value={rule.label}
              onChange={(event) => patch(index, { label: event.target.value })}
              className="h-8 min-w-0"
            />
            <Switch
              checked={rule.enabled}
              aria-label="Rule enabled"
              onCheckedChange={(enabled) => patch(index, { enabled })}
            />
            <button
              type="button"
              aria-label="Delete rule"
              className="text-muted-foreground hover:text-destructive"
              onClick={() => setDraft(draft.filter((_, i) => i !== index))}
            >
              <Trash2 className="size-4" />
            </button>
          </div>

          <div className="flex flex-col gap-2">
            <Label className="text-xs">On these days</Label>
            <div className="flex flex-wrap gap-1">
              {DAYS.map((day) => {
                const selected = rule.condition.daysOfWeek?.includes(day.value) ?? false
                return (
                  <button
                    key={day.value}
                    type="button"
                    onClick={() => {
                      const current = rule.condition.daysOfWeek ?? []
                      patch(index, {
                        condition: {
                          ...rule.condition,
                          daysOfWeek: selected
                            ? current.filter((value) => value !== day.value)
                            : [...current, day.value],
                        },
                      })
                    }}
                    className={cn(
                      'rounded px-2 py-1 text-xs',
                      selected ? 'bg-primary text-primary-foreground' : 'bg-secondary',
                    )}
                  >
                    {day.label}
                  </button>
                )
              })}
            </div>
            <p className="text-muted-foreground text-xs">None selected means any day.</p>
          </div>

          <div className="flex flex-col gap-2">
            <Label className="text-xs">In these months</Label>
            <div className="flex flex-wrap gap-1">
              {MONTHS.map((month, monthIndex) => {
                const value = monthIndex + 1
                const selected = rule.condition.months?.includes(value) ?? false
                return (
                  <button
                    key={month}
                    type="button"
                    onClick={() => {
                      const current = rule.condition.months ?? []
                      patch(index, {
                        condition: {
                          ...rule.condition,
                          months: selected
                            ? current.filter((entry) => entry !== value)
                            : [...current, value],
                        },
                      })
                    }}
                    className={cn(
                      'rounded px-2 py-1 text-xs',
                      selected ? 'bg-primary text-primary-foreground' : 'bg-secondary',
                    )}
                  >
                    {month}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Checkbox
              id={`time-${index}`}
              checked={!!rule.condition.timeOfDay}
              onCheckedChange={(checked) =>
                patch(index, {
                  condition: {
                    ...rule.condition,
                    timeOfDay: checked === true ? { from: '21:00', to: '05:00' } : undefined,
                  },
                })
              }
            />
            <Label htmlFor={`time-${index}`} className="text-xs">
              Between
            </Label>
            <Input
              type="time"
              disabled={!rule.condition.timeOfDay}
              value={rule.condition.timeOfDay?.from ?? '21:00'}
              className="h-8 w-28 shrink-0"
              onChange={(event) =>
                patch(index, {
                  condition: {
                    ...rule.condition,
                    timeOfDay: {
                      from: event.target.value,
                      to: rule.condition.timeOfDay?.to ?? '05:00',
                    },
                  },
                })
              }
            />
            <span className="text-muted-foreground text-xs">and</span>
            <Input
              type="time"
              disabled={!rule.condition.timeOfDay}
              value={rule.condition.timeOfDay?.to ?? '05:00'}
              className="h-8 w-28 shrink-0"
              onChange={(event) =>
                patch(index, {
                  condition: {
                    ...rule.condition,
                    timeOfDay: {
                      from: rule.condition.timeOfDay?.from ?? '21:00',
                      to: event.target.value,
                    },
                  },
                })
              }
            />
          </div>

          <div className="flex flex-col gap-2 border-t pt-3">
            <Label className="text-xs">Then</Label>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setPickerFor({ index, mode: 'add' })}
              >
                Also play…
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setPickerFor({ index, mode: 'replace' })}
              >
                Play only…
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setPickerFor({ index, mode: 'rotate' })}
              >
                Rotate through…
              </Button>
            </div>

            {(['addSources', 'replaceSources'] as const).map((key) =>
              (rule.effect[key] ?? []).map((source, sourceIndex) => (
                <p
                  key={`${key}-${source.ref}`}
                  className="flex items-center gap-2 text-muted-foreground text-xs"
                >
                  {key === 'addSources' ? '+' : 'only'} {source.label}
                  <button
                    type="button"
                    aria-label={`Remove ${source.label}`}
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => {
                      const remaining = (rule.effect[key] ?? []).filter((_, i) => i !== sourceIndex)
                      patch(index, {
                        effect: {
                          ...rule.effect,
                          // Empty means "no clause", not "play nothing": an
                          // empty replaceSources would silently wipe the
                          // preset's own sources.
                          [key]: remaining.length ? remaining : undefined,
                        },
                      })
                    }}
                  >
                    <X className="size-3" />
                  </button>
                </p>
              )),
            )}

            {rule.effect.rotateSources && (
              <div className="flex flex-col gap-2">
                {rule.effect.rotateSources.sources.map((source, sourceIndex) => (
                  <p
                    key={source.ref}
                    className="flex items-center gap-2 text-muted-foreground text-xs"
                  >
                    <span className="tabular-nums">{sourceIndex + 1}.</span>
                    {source.label}
                    <button
                      type="button"
                      aria-label={`Remove ${source.label} from the rotation`}
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => {
                        const rotation = rule.effect.rotateSources
                        if (!rotation) return
                        const sources = rotation.sources.filter((_, i) => i !== sourceIndex)
                        patch(index, {
                          effect: {
                            ...rule.effect,
                            // An empty rotation is not a rotation; drop it
                            // rather than saving something that does nothing.
                            rotateSources: sources.length ? { ...rotation, sources } : undefined,
                          },
                        })
                      }}
                    >
                      <X className="size-3" />
                    </button>
                  </p>
                ))}
                <div className="flex items-center gap-1">
                  <span className="text-muted-foreground text-xs">rotating, one per</span>
                  {(['day', 'week'] as const).map((period) => (
                    <button
                      key={period}
                      type="button"
                      onClick={() => {
                        const rotation = rule.effect.rotateSources
                        if (!rotation) return
                        patch(index, {
                          effect: { ...rule.effect, rotateSources: { ...rotation, period } },
                        })
                      }}
                      className={cn(
                        'rounded px-2 py-1 text-xs',
                        rule.effect.rotateSources?.period === period
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-secondary',
                      )}
                    >
                      {period}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Label htmlFor={`vol-${index}`} className="text-xs">
                Volume change
              </Label>
              <Input
                id={`vol-${index}`}
                type="number"
                min={-100}
                max={100}
                className="h-8 w-24"
                value={rule.effect.volumeDelta ?? 0}
                onChange={(event) =>
                  patch(index, {
                    effect: {
                      ...rule.effect,
                      volumeDelta: Number(event.target.value) || undefined,
                    },
                  })
                }
              />
              <span className="text-muted-foreground text-xs">e.g. -15 to wind down</span>
            </div>
          </div>
        </div>
      ))}

      <SourcePicker
        open={pickerFor !== null}
        onOpenChange={(open) => !open && setPickerFor(null)}
        onPick={(source) => {
          if (!pickerFor) return
          const rule = draft[pickerFor.index]
          if (!rule) return
          if (pickerFor.mode === 'rotate') {
            const rotation = rule.effect.rotateSources ?? { sources: [], period: 'day' as const }
            patch(pickerFor.index, {
              effect: {
                ...rule.effect,
                rotateSources: { ...rotation, sources: [...rotation.sources, source] },
              },
            })
            setPickerFor(null)
            return
          }
          const key = pickerFor.mode === 'add' ? 'addSources' : 'replaceSources'
          patch(pickerFor.index, {
            effect: { ...rule.effect, [key]: [...(rule.effect[key] ?? []), source] },
          })
          setPickerFor(null)
        }}
      />
    </section>
  )
}
