import { Loader2, PauseOctagon } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'

/**
 * Silences the house without touching TV audio. Deliberately not a confirm
 * dialog: it's trivially reversible (press play again) and the whole point is
 * that it's one tap when you walk in the door.
 */
export function PauseAllButton({
  disabled,
  onDone,
  onError,
}: {
  disabled?: boolean
  onDone: (skippedCount: number) => void
  onError: (message: string) => void
}) {
  const [busy, setBusy] = useState(false)

  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={disabled || busy}
      aria-label="Pause all music"
      title="Pause all music (leaves TV audio alone)"
      onClick={() => {
        setBusy(true)
        api
          .pauseAll()
          .then((result) => onDone(result.skippedGroupIds.length))
          .catch((err: Error) => onError(err.message))
          .finally(() => setBusy(false))
      }}
    >
      {busy ? <Loader2 className="size-4 animate-spin" /> : <PauseOctagon className="size-4" />}
      Pause all
    </Button>
  )
}
