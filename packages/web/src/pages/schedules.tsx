import type { Preset, ScheduleConfig, Trigger, TriggerInput } from '@slipmat/shared'
import { DAY_LABELS } from '@slipmat/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Clock, Moon, Plus, Trash2, Tv } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'wouter'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { getJson } from '@/lib/api'
import { usePresets } from '@/lib/presets'
import { cn } from '@/lib/utils'

type TriggersResponse = { triggers: Trigger[]; timeZone: string }

const WEEKDAYS = [1, 2, 3, 4, 5]
const ORDERED_DAYS = [1, 2, 3, 4, 5, 6, 0]

function describeDays(days: number[]): string {
  if (days.length === 0 || days.length === 7) return 'Every day'
  if (days.length === 5 && WEEKDAYS.every((day) => days.includes(day))) return 'Weekdays'
  if (days.length === 2 && days.includes(0) && days.includes(6)) return 'Weekends'
  return [...days]
    .sort((a, b) => a - b)
    .map((day) => DAY_LABELS[day])
    .join(', ')
}

export function SchedulesPage({ onError }: { onError: (message: string) => void }) {
  const queryClient = useQueryClient()
  const presets = usePresets()
  const [adding, setAdding] = useState<TriggerInput | null>(null)

  const query = useQuery({
    queryKey: ['triggers'],
    queryFn: () => getJson<TriggersResponse>('/api/triggers'),
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['triggers'] })
  }

  const create = useMutation({
    mutationFn: async (input: TriggerInput) => {
      const res = await fetch('/api/triggers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      })
      if (!res.ok) throw new Error((await res.json()).message ?? 'Could not save')
      return res.json()
    },
    onSuccess: () => {
      setAdding(null)
      invalidate()
    },
    onError: (err: Error) => onError(err.message),
  })

  const setEnabled = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      await fetch(`/api/triggers/${id}/enabled`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
    },
    onSuccess: invalidate,
  })

  const remove = useMutation({
    mutationFn: async (id: string) => {
      await fetch(`/api/triggers/${id}`, { method: 'DELETE' })
    },
    onSuccess: invalidate,
  })

  const availablePresets = presets.data?.presets ?? []
  const schedules = query.data?.triggers.filter((t) => t.kind === 'schedule') ?? []
  const sleepTimers = query.data?.triggers.filter((t) => t.kind === 'sleep_timer') ?? []
  const tvTriggers = query.data?.triggers.filter((t) => t.kind === 'tv_pauses_music') ?? []

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold text-lg">Schedules</h2>
          {query.data && (
            <p className="text-muted-foreground text-xs">
              Times are {query.data.timeZone}
              {/* Silent otherwise: a schedule set at 07:30 from a phone in
                  another zone fires at 07:30 on the server, not on the phone. */}
              {query.data.timeZone !== Intl.DateTimeFormat().resolvedOptions().timeZone && (
                <>
                  , not this device's{' '}
                  <Link href="/settings" className="underline">
                    change it
                  </Link>
                </>
              )}
            </p>
          )}
        </div>
      </div>

      {query.isPending ? (
        <p className="text-muted-foreground text-sm">Loading…</p>
      ) : (
        <>
          <Section
            title="Schedules"
            icon={<Clock className="size-4" />}
            onAdd={() =>
              setAdding({
                presetId: availablePresets[0]?.id ?? null,
                kind: 'schedule',
                label: '',
                enabled: true,
                config: {
                  daysOfWeek: [],
                  time: '07:30',
                  action: 'activate',
                  skipIfPlaying: true,
                } satisfies ScheduleConfig,
              })
            }
            empty="Nothing scheduled. Add one to start or stop a preset at a set time."
          >
            {schedules.map((trigger) => {
              const config = trigger.config as ScheduleConfig
              return (
                <Row
                  key={trigger.id}
                  trigger={trigger}
                  title={
                    config.action === 'pause_all'
                      ? 'Pause all music'
                      : `${config.action === 'stop' ? 'Stop' : 'Start'} ${trigger.presetName ?? 'a preset'}`
                  }
                  subtitle={`${describeDays(config.daysOfWeek)} at ${config.time}${
                    config.action === 'activate' && config.skipIfPlaying
                      ? ' · skipped if already playing'
                      : ''
                  }`}
                  onToggle={(enabled) => setEnabled.mutate({ id: trigger.id, enabled })}
                  onDelete={() => remove.mutate(trigger.id)}
                />
              )
            })}
          </Section>

          <Section
            title="Sleep timers"
            icon={<Moon className="size-4" />}
            onAdd={
              availablePresets.length > 0
                ? () =>
                    setAdding({
                      presetId: availablePresets[0]!.id,
                      kind: 'sleep_timer',
                      label: '',
                      enabled: true,
                      config: { minutes: 45 },
                    })
                : undefined
            }
            empty="No sleep timers. Add one to stop a preset a set time after it starts."
          >
            {sleepTimers.map((trigger) => (
              <Row
                key={trigger.id}
                trigger={trigger}
                title={`Stop ${trigger.presetName ?? 'a preset'}`}
                subtitle={`${(trigger.config as { minutes: number }).minutes} minutes after it starts`}
                onToggle={(enabled) => setEnabled.mutate({ id: trigger.id, enabled })}
                onDelete={() => remove.mutate(trigger.id)}
              />
            ))}
          </Section>

          <Section
            title="When the TV turns on"
            icon={<Tv className="size-4" />}
            onAdd={
              tvTriggers.length === 0
                ? () =>
                    setAdding({
                      presetId: null,
                      kind: 'tv_pauses_music',
                      label: '',
                      enabled: true,
                      config: { zoneId: null },
                    })
                : undefined
            }
            empty="Off. Add this to pause music everywhere when TV audio starts."
          >
            {tvTriggers.map((trigger) => (
              <Row
                key={trigger.id}
                trigger={trigger}
                title="Pause all music"
                subtitle="When any speaker switches to TV audio"
                onToggle={(enabled) => setEnabled.mutate({ id: trigger.id, enabled })}
                onDelete={() => remove.mutate(trigger.id)}
              />
            ))}
          </Section>
        </>
      )}

      {adding && (
        <TriggerForm
          draft={adding}
          presets={availablePresets}
          onChange={setAdding}
          onCancel={() => setAdding(null)}
          onSave={() => create.mutate(adding)}
          saving={create.isPending}
        />
      )}
    </div>
  )
}

function Section({
  title,
  icon,
  onAdd,
  empty,
  children,
}: {
  title: string
  icon: React.ReactNode
  onAdd?: (() => void) | undefined
  empty: string
  children: React.ReactNode
}) {
  const items = Array.isArray(children) ? children : [children]
  const isEmpty = items.flat().filter(Boolean).length === 0

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 font-medium text-muted-foreground text-xs uppercase tracking-wide">
          {icon}
          {title}
        </h3>
        {onAdd && (
          <Button size="sm" variant="ghost" onClick={onAdd}>
            <Plus className="size-4" />
            Add
          </Button>
        )}
      </div>
      {isEmpty ? <p className="text-muted-foreground text-sm">{empty}</p> : children}
    </section>
  )
}

function Row({
  trigger,
  title,
  subtitle,
  onToggle,
  onDelete,
}: {
  trigger: Trigger
  title: string
  subtitle: string
  onToggle: (enabled: boolean) => void
  onDelete: () => void
}) {
  return (
    <Card className={cn('gap-0 p-3', !trigger.enabled && 'opacity-60')}>
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium text-sm">{title}</span>
          <span className="truncate text-muted-foreground text-xs">{subtitle}</span>
        </div>
        <Switch
          checked={trigger.enabled}
          aria-label={`${title} enabled`}
          onCheckedChange={onToggle}
        />
        <button
          type="button"
          aria-label={`Delete ${title}`}
          className="shrink-0 text-muted-foreground hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="size-4" />
        </button>
      </div>
      {trigger.lastSkippedReason && (
        <p className="mt-2 flex items-start gap-1.5 text-amber-600 text-xs dark:text-amber-400">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          Last run: {trigger.lastSkippedReason}
        </p>
      )}
    </Card>
  )
}

function TriggerForm({
  draft,
  presets,
  onChange,
  onCancel,
  onSave,
  saving,
}: {
  draft: TriggerInput
  presets: Preset[]
  onChange: (draft: TriggerInput) => void
  onCancel: () => void
  onSave: () => void
  saving: boolean
}) {
  const config = draft.config as Record<string, unknown>
  const patchConfig = (changes: Record<string, unknown>) =>
    onChange({ ...draft, config: { ...config, ...changes } })

  const action = (config.action as ScheduleConfig['action']) ?? 'activate'
  const days = (config.daysOfWeek as number[]) ?? []

  return (
    <Card className="flex flex-col gap-4 p-4">
      <h3 className="font-medium text-sm">
        {draft.kind === 'schedule'
          ? 'New schedule'
          : draft.kind === 'sleep_timer'
            ? 'New sleep timer'
            : 'Pause music when the TV turns on'}
      </h3>

      {draft.kind === 'schedule' && (
        <>
          <div className="flex flex-col gap-2">
            <Label className="text-xs">Do this</Label>
            <div className="flex flex-wrap gap-1">
              {(['activate', 'stop', 'pause_all'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() =>
                    onChange({
                      ...draft,
                      // Pause all is system-wide, so it must not carry a preset.
                      presetId:
                        value === 'pause_all' ? null : (draft.presetId ?? presets[0]?.id ?? null),
                      config: { ...config, action: value },
                    })
                  }
                  className={cn(
                    'rounded px-2 py-1 text-xs',
                    action === value ? 'bg-primary text-primary-foreground' : 'bg-secondary',
                  )}
                >
                  {value === 'activate'
                    ? 'Start a preset'
                    : value === 'stop'
                      ? 'Stop a preset'
                      : 'Pause all music'}
                </button>
              ))}
            </div>
          </div>

          {action !== 'pause_all' && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="trigger-preset" className="text-xs">
                Preset
              </Label>
              <select
                id="trigger-preset"
                value={draft.presetId ?? ''}
                onChange={(event) => onChange({ ...draft, presetId: event.target.value })}
                className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
              >
                {presets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <Label className="text-xs">On these days</Label>
            <div className="flex flex-wrap gap-1">
              {ORDERED_DAYS.map((day) => {
                const selected = days.includes(day)
                return (
                  <button
                    key={day}
                    type="button"
                    onClick={() =>
                      patchConfig({
                        daysOfWeek: selected ? days.filter((d) => d !== day) : [...days, day],
                      })
                    }
                    className={cn(
                      'rounded px-2 py-1 text-xs',
                      selected ? 'bg-primary text-primary-foreground' : 'bg-secondary',
                    )}
                  >
                    {DAY_LABELS[day]}
                  </button>
                )
              })}
            </div>
            <p className="text-muted-foreground text-xs">None selected means every day.</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor="trigger-time" className="text-xs">
              At
            </Label>
            <Input
              id="trigger-time"
              type="time"
              value={(config.time as string) ?? '07:30'}
              onChange={(event) => patchConfig({ time: event.target.value })}
              className="h-8 w-28 shrink-0"
            />
          </div>

          {action === 'activate' && (
            <div className="flex items-start justify-between gap-4">
              <div className="flex flex-col gap-0.5">
                <Label htmlFor="skip-if-playing">Skip if already playing</Label>
                <p className="text-muted-foreground text-xs">
                  Leave whatever is on rather than taking the speakers over.
                </p>
              </div>
              <Switch
                id="skip-if-playing"
                checked={(config.skipIfPlaying as boolean) ?? true}
                onCheckedChange={(value) => patchConfig({ skipIfPlaying: value })}
              />
            </div>
          )}
        </>
      )}

      {draft.kind === 'sleep_timer' && (
        <>
          <div className="flex flex-col gap-2">
            <Label htmlFor="sleep-preset" className="text-xs">
              Preset
            </Label>
            <select
              id="sleep-preset"
              value={draft.presetId ?? ''}
              onChange={(event) => onChange({ ...draft, presetId: event.target.value })}
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
            >
              {presets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor="sleep-minutes" className="text-xs">
              Stop after
            </Label>
            <Input
              id="sleep-minutes"
              type="number"
              min={1}
              max={1440}
              value={(config.minutes as number) ?? 45}
              onChange={(event) => patchConfig({ minutes: Number(event.target.value) })}
              className="h-8 w-24 shrink-0"
            />
            <span className="text-muted-foreground text-xs">minutes</span>
          </div>
        </>
      )}

      {draft.kind === 'tv_pauses_music' && (
        <p className="text-muted-foreground text-sm">
          When any speaker switches to TV audio, music everywhere else is paused. TV and line-in are
          never touched.
        </p>
      )}

      <div className="flex gap-2">
        <Button size="sm" onClick={onSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  )
}
