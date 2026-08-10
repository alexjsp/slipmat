import type { PresetInput, ResolveUrlResponse } from '@domovoi/shared'
import { ChevronLeft, Folder, Loader2, Music, Radio } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { resolveUrl, useBrowse } from '@/lib/presets'

type NewSource = PresetInput['sources'][number]

/**
 * Pick a source either by browsing what Sonos already knows about, or by
 * pasting a share link. Pasting resolves before it's accepted so the track
 * count — and any "this can only be played whole" caveat — is visible now
 * rather than the first time the preset runs.
 */
export function SourcePicker({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onPick: (source: NewSource) => void
}) {
  const [path, setPath] = useState('')
  const browse = useBrowse(path, open)

  const [url, setUrl] = useState('')
  const [resolving, setResolving] = useState(false)
  const [resolved, setResolved] = useState<ResolveUrlResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const pick = (source: NewSource) => {
    onPick(source)
    onOpenChange(false)
    setPath('')
    setUrl('')
    setResolved(null)
    setError(null)
  }

  const doResolve = async () => {
    setResolving(true)
    setError(null)
    setResolved(null)
    try {
      setResolved(await resolveUrl(url))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not resolve that link')
    } finally {
      setResolving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid-cols-[minmax(0,1fr)] max-h-[85dvh] gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="min-w-0 p-4 pb-2 text-left">
          <DialogTitle className="pr-6">Add a source</DialogTitle>
          <DialogDescription>
            Sources are shuffled together into one queue when the preset runs.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="browse" className="min-w-0 gap-0">
          <TabsList className="mx-4">
            <TabsTrigger value="browse">Browse</TabsTrigger>
            <TabsTrigger value="link">Paste a link</TabsTrigger>
          </TabsList>

          <TabsContent value="browse" className="min-w-0 max-h-[55dvh] overflow-y-auto p-4">
            {path !== '' && (
              <Button variant="ghost" size="sm" className="mb-2 gap-1" onClick={() => setPath('')}>
                <ChevronLeft className="size-4" />
                Back
              </Button>
            )}

            {browse.isPending ? (
              <p className="text-muted-foreground text-sm">Loading…</p>
            ) : browse.isError ? (
              <p className="text-destructive text-sm">Could not browse that location.</p>
            ) : browse.data.items.length === 0 ? (
              <p className="text-muted-foreground text-sm">Nothing here.</p>
            ) : (
              <ul className="flex flex-col">
                {browse.data.items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm hover:bg-accent"
                      onClick={() => {
                        // A top-level folder is only ever a place to descend into.
                        if (path === '') {
                          setPath(item.id)
                          return
                        }
                        pick({ kind: item.kind, ref: item.id, label: item.title })
                      }}
                    >
                      {item.isContainer && path === '' ? (
                        <Folder className="size-4 shrink-0 text-muted-foreground" />
                      ) : item.isStream ? (
                        <Radio className="size-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <Music className="size-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className="min-w-0 flex-1 truncate">{item.title}</span>
                      {item.isStream && (
                        <span className="shrink-0 text-muted-foreground text-xs">radio</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>

          <TabsContent value="link" className="flex min-w-0 flex-col gap-3 p-4">
            <div className="flex gap-2">
              <Input
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://open.spotify.com/playlist/…"
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && url) void doResolve()
                }}
              />
              <Button onClick={() => void doResolve()} disabled={!url || resolving}>
                {resolving ? <Loader2 className="size-4 animate-spin" /> : 'Check'}
              </Button>
            </div>

            <p className="text-muted-foreground text-xs">
              Spotify or Apple Music links to a playlist, album, artist or track.
            </p>

            {error && <p className="text-destructive text-sm">{error}</p>}

            {resolved && (
              <div className="flex flex-col gap-2 rounded-md border p-3">
                <p className="font-medium text-sm">{resolved.label}</p>
                <p className="text-muted-foreground text-xs">
                  {resolved.resolutionMode === 'tracks'
                    ? `${resolved.trackCount} tracks — can be shuffled with other sources`
                    : resolved.resolutionMode === 'stream'
                      ? 'A radio stream — can only be used on its own'
                      : 'Can only be played whole, not mixed with other sources'}
                </p>
                {resolved.warning && <p className="text-amber-500 text-xs">{resolved.warning}</p>}
                {resolved.sampleTracks.length > 0 && (
                  <ul className="text-muted-foreground text-xs">
                    {resolved.sampleTracks.map((track) => (
                      <li key={track.title} className="truncate">
                        {track.title}
                        {track.artist ? ` — ${track.artist}` : ''}
                      </li>
                    ))}
                  </ul>
                )}
                <Button
                  size="sm"
                  className="mt-1 self-start"
                  onClick={() => pick({ kind: 'service_url', ref: url, label: resolved.label })}
                >
                  Add this source
                </Button>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
