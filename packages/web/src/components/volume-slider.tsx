import { Volume1, VolumeX } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Slider } from '@/components/ui/slider'
import { cn } from '@/lib/utils'

/**
 * Volume is a tug-of-war: the user is dragging while the speaker is pushing its
 * own state back over the WebSocket. So while dragging we hold a local value and
 * ignore incoming updates, and after committing we keep holding it briefly —
 * otherwise the slider snaps back to the old value for the round-trip it takes
 * Sonos to acknowledge the change.
 */
const SETTLE_MS = 800

export function VolumeSlider({
  value,
  muted,
  disabled,
  onCommit,
  onToggleMute,
}: {
  value: number
  muted: boolean
  disabled?: boolean
  onCommit: (volume: number) => void
  onToggleMute: () => void
}) {
  const [local, setLocal] = useState<number | null>(null)
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(settleTimer.current), [])

  const displayed = local ?? value

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onToggleMute}
        disabled={disabled}
        aria-label={muted ? 'Unmute' : 'Mute'}
        className={cn(
          'text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40',
          muted && 'text-destructive',
        )}
      >
        {muted ? <VolumeX className="size-4" /> : <Volume1 className="size-4" />}
      </button>

      <Slider
        value={[displayed]}
        min={0}
        max={100}
        step={1}
        disabled={disabled}
        aria-label="Volume"
        onValueChange={([next]) => {
          clearTimeout(settleTimer.current)
          setLocal(next ?? 0)
        }}
        onValueCommit={([next]) => {
          onCommit(next ?? 0)
          settleTimer.current = setTimeout(() => setLocal(null), SETTLE_MS)
        }}
        className="flex-1"
      />

      <span className="w-7 shrink-0 text-right text-muted-foreground text-xs tabular-nums">
        {displayed}
      </span>
    </div>
  )
}
