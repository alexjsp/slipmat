import type { Group, Zone } from '@domovoi/shared'
import { Music, Pause, Play, Radio, SkipBack, SkipForward, Speaker, Tv } from 'lucide-react'
import { useState } from 'react'
import { GroupSheet } from '@/components/group-sheet'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { VolumeSlider } from '@/components/volume-slider'
import { api } from '@/lib/api'
import { useProgress } from '@/lib/use-progress'
import { cn } from '@/lib/utils'

const KIND_LABELS: Record<Group['playbackKind'], string> = {
  queue: 'Queue',
  stream: 'Radio',
  tv: 'TV',
  'line-in': 'Line-in',
  idle: 'Idle',
  unknown: 'Playing',
}

function KindIcon({ kind, className }: { kind: Group['playbackKind']; className?: string }) {
  if (kind === 'tv') return <Tv className={className} />
  if (kind === 'stream') return <Radio className={className} />
  return <Music className={className} />
}

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function GroupCard({
  group,
  zones,
  onError,
}: {
  group: Group
  zones: Zone[]
  onError: (message: string) => void
}) {
  const [sheetOpen, setSheetOpen] = useState(false)

  const members = group.memberZoneIds
    .map((id) => zones.find((zone) => zone.id === id))
    .filter((zone): zone is Zone => !!zone)

  const title = members.map((zone) => zone.name).join(' + ') || 'Unknown'
  const track = group.currentTrack
  const isPlaying = group.transportState === 'PLAYING'
  const duration = track?.durationSeconds ?? null
  // Interpolated locally so the bar creeps forward between server polls.
  const position = useProgress(group.positionSeconds, isPlaying, duration)
  const progress = duration && position !== null ? Math.min(100, (position / duration) * 100) : null

  // TV and line-in aren't ours to drive — Sonos owns their transport.
  const transportDisabled = group.playbackKind === 'tv' || group.playbackKind === 'line-in'
  // Streams are a single non-skippable URI.
  const skipDisabled = transportDisabled || group.playbackKind === 'stream'

  const run = (action: () => Promise<unknown>) => () => {
    action().catch((err: Error) => onError(err.message))
  }

  return (
    <>
      <Card className="gap-0 overflow-hidden p-0">
        <div className="flex gap-4 p-4 pb-3">
          <div className="size-20 shrink-0 overflow-hidden rounded-md bg-muted">
            {track?.artUrl ? (
              <img
                src={track.artUrl}
                alt=""
                className="size-full object-cover"
                // Art comes from the speaker via our proxy and can 404 when the
                // track changes mid-flight; an empty tile beats a broken icon.
                onError={(event) => {
                  event.currentTarget.style.visibility = 'hidden'
                }}
              />
            ) : (
              <div className="flex size-full items-center justify-center text-muted-foreground">
                <KindIcon kind={group.playbackKind} className="size-5" />
              </div>
            )}
          </div>

          <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
            <button
              type="button"
              onClick={() => setSheetOpen(true)}
              className="flex items-center gap-1.5 text-left"
            >
              <h2 className="truncate font-medium text-sm">{title}</h2>
              <Speaker className="size-3.5 shrink-0 text-muted-foreground" />
            </button>

            {track ? (
              <>
                <p className="truncate text-sm">{track.title ?? 'Unknown track'}</p>
                <p className="truncate text-muted-foreground text-xs">
                  {[track.artist, track.album].filter(Boolean).join(' — ') || ' '}
                </p>
              </>
            ) : (
              <p className="text-muted-foreground text-sm">
                {isPlaying ? 'Playing' : 'Nothing playing'}
              </p>
            )}
          </div>

          <Badge variant="secondary" className="h-fit shrink-0 gap-1 text-xs">
            <KindIcon kind={group.playbackKind} className="size-3" />
            {KIND_LABELS[group.playbackKind]}
          </Badge>
        </div>

        {progress !== null && (
          <div className="flex items-center gap-2 px-4 pb-2 text-muted-foreground text-xs tabular-nums">
            <span>{formatTime(position ?? 0)}</span>
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  'h-full rounded-full bg-primary transition-[width] duration-500 ease-linear',
                )}
                style={{ width: `${progress}%` }}
              />
            </div>
            <span>{formatTime(duration ?? 0)}</span>
          </div>
        )}

        <div className="flex items-center gap-3 px-4 pb-4">
          <div className="flex items-center gap-1">
            <Button
              size="icon"
              variant="ghost"
              disabled={skipDisabled}
              aria-label="Previous"
              onClick={run(() => api.previous(group.coordinatorZoneId))}
            >
              <SkipBack className="size-4" />
            </Button>
            <Button
              size="icon"
              variant="secondary"
              disabled={transportDisabled}
              aria-label={isPlaying ? 'Pause' : 'Play'}
              onClick={run(() =>
                isPlaying ? api.pause(group.coordinatorZoneId) : api.play(group.coordinatorZoneId),
              )}
            >
              {isPlaying ? <Pause className="size-4" /> : <Play className="size-4" />}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              disabled={skipDisabled}
              aria-label="Next"
              onClick={run(() => api.next(group.coordinatorZoneId))}
            >
              <SkipForward className="size-4" />
            </Button>
          </div>

          <div className="min-w-0 flex-1">
            {members.length === 1 && members[0] ? (
              <VolumeSlider
                value={members[0].volume}
                muted={members[0].muted}
                disabled={members[0].unreachable}
                onCommit={(volume) => {
                  api.setVolume(members[0]!.id, volume).catch((err: Error) => onError(err.message))
                }}
                onToggleMute={run(() => api.setMute(members[0]!.id, !members[0]!.muted))}
              />
            ) : (
              // Grouped zones each have their own level, so a single slider
              // would be a lie — send people to the per-zone sheet instead.
              <button
                type="button"
                onClick={() => setSheetOpen(true)}
                className="text-muted-foreground text-xs hover:text-foreground"
              >
                {members.length} speakers · adjust volumes
              </button>
            )}
          </div>
        </div>
      </Card>

      <GroupSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        group={group}
        zones={zones}
        onError={onError}
      />
    </>
  )
}
