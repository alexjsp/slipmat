import type { BlockRule } from '@slipmat/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { getJson, saveBlocklist } from '@/lib/api'

const FIELD_LABELS: Record<BlockRule['field'], string> = {
  any: 'Anywhere',
  title: 'Title',
  artist: 'Artist',
  album: 'Album',
}

const MATCH_LABELS: Record<BlockRule['match'], string> = {
  is: 'is',
  begins: 'begins with',
  ends: 'ends with',
  contains: 'contains',
  matches: 'matches',
}

/**
 * Rules are deletable, so an index key would hand one row's React state to its
 * neighbour on removal — the cursor jumping mid-edit. Each carries its own.
 */
type DraftRule = BlockRule & { key: string }

let keyCounter = 0
const nextKey = () => `block-${keyCounter++}`

/**
 * Music never to play, whichever preset asks for it.
 *
 * Applied when the queue is pruned, in the same pass that removes duplicates —
 * so a blocked track can be heard briefly if it happens to be the one playback
 * starts on, and is gone from everything that follows.
 */
export function BlocklistEditor() {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ['blocklist'],
    queryFn: () => getJson<{ rules: BlockRule[] }>('/api/blocklist'),
  })
  const [draft, setDraft] = useState<DraftRule[] | null>(null)

  useEffect(() => {
    if (query.data && draft === null) {
      setDraft(query.data.rules.map((rule) => ({ ...rule, key: nextKey() })))
    }
  }, [query.data, draft])

  const save = useMutation({
    mutationFn: (rules: DraftRule[]) => saveBlocklist(rules.map(({ key, ...rule }) => rule)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['blocklist'] }),
  })

  if (!draft) return <p className="text-muted-foreground text-sm">Loading…</p>

  const patch = (index: number, changes: Partial<DraftRule>) =>
    setDraft(draft.map((rule, i) => (i === index ? { ...rule, ...changes } : rule)))

  return (
    <Card className="gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-medium text-sm">Blocked music</h3>
          <p className="text-muted-foreground text-xs">
            Anything matching is taken out of the queue, whichever preset queued it.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            setDraft([
              ...draft,
              { key: nextKey(), field: 'any', match: 'contains', pattern: '', enabled: true },
            ])
          }
        >
          <Plus className="size-4" />
          Add
        </Button>
      </div>

      {draft.length === 0 ? (
        <p className="text-muted-foreground text-xs">Nothing blocked.</p>
      ) : (
        draft.map((rule, index) => (
          <div key={rule.key} className="flex flex-wrap items-center gap-2 border-t pt-3">
            <select
              aria-label="Field"
              className="h-9 rounded-md border bg-transparent px-2 text-sm"
              value={rule.field}
              onChange={(event) =>
                patch(index, { field: event.target.value as BlockRule['field'] })
              }
            >
              {Object.entries(FIELD_LABELS).map(([field, label]) => (
                <option key={field} value={field}>
                  {label}
                </option>
              ))}
            </select>
            <select
              aria-label="Match"
              className="h-9 rounded-md border bg-transparent px-2 text-sm"
              value={rule.match}
              onChange={(event) =>
                patch(index, { match: event.target.value as BlockRule['match'] })
              }
            >
              {Object.entries(MATCH_LABELS).map(([match, label]) => (
                <option key={match} value={match}>
                  {label}
                </option>
              ))}
            </select>
            <Input
              className="min-w-40 flex-1"
              placeholder={rule.match === 'matches' ? '^last christmas' : 'Wham!'}
              value={rule.pattern}
              onChange={(event) => patch(index, { pattern: event.target.value })}
            />
            <label
              htmlFor={`block-enabled-${index}`}
              className="flex items-center gap-1.5 text-muted-foreground text-xs"
            >
              <Switch
                id={`block-enabled-${index}`}
                checked={rule.enabled}
                onCheckedChange={(value) => patch(index, { enabled: value })}
              />
              On
            </label>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Remove"
              onClick={() => setDraft(draft.filter((_, i) => i !== index))}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))
      )}

      <Button
        size="sm"
        className="self-start"
        disabled={save.isPending || draft.some((rule) => rule.pattern.trim() === '')}
        onClick={() => save.mutate(draft)}
      >
        {save.isPending ? 'Saving…' : 'Save blocked music'}
      </Button>
    </Card>
  )
}
