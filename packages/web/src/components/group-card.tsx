import type { Group, Zone } from '@domovoi/shared'
import { Music, Radio, Tv, Volume2, VolumeX } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'

const KIND_LABELS: Record<Group['playbackKind'], string> = {
  queue: 'Queue',
  stream: 'Radio',
  tv: 'TV',
  'line-in': 'Line-in',
  idle: 'Idle',
  unknown: 'Playing',
}

function KindIcon({ kind }: { kind: Group['playbackKind'] }) {
  if (kind === 'tv') return <Tv className="size-4" />
  if (kind === 'stream') return <Radio className="size-4" />
  return <Music className="size-4" />
}

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function GroupCard({ group, zones }: { group: Group; zones: Zone[] }) {
  const members = group.memberZoneIds
    .map((id) => zones.find((zone) => zone.id === id))
    .filter((zone): zone is Zone => !!zone)

  const title = members.map((zone) => zone.name).join(' + ') || 'Unknown'
  const track = group.currentTrack
  const isPlaying = group.transportState === 'PLAYING'
  const duration = track?.durationSeconds ?? null
  const progress =
    duration && group.positionSeconds !== null
      ? Math.min(100, (group.positionSeconds / duration) * 100)
      : null

  return (
    <Card className="gap-0 overflow-hidden p-0">
      <div className="flex gap-4 p-4">
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
              <KindIcon kind={group.playbackKind} />
            </div>
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate font-medium text-sm">{title}</h2>
            <Badge variant="secondary" className="shrink-0 gap-1 text-xs">
              <KindIcon kind={group.playbackKind} />
              {KIND_LABELS[group.playbackKind]}
            </Badge>
          </div>

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

        <div className="flex shrink-0 flex-col items-end justify-center gap-1 text-muted-foreground">
          {group.muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
          <span className="tabular-nums text-xs">{group.volume}</span>
        </div>
      </div>

      {progress !== null && (
        <div className="flex items-center gap-2 px-4 pb-3 text-muted-foreground text-xs tabular-nums">
          <span>{formatTime(group.positionSeconds ?? 0)}</span>
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className={cn('h-full rounded-full bg-primary transition-[width] duration-1000')}
              style={{ width: `${progress}%` }}
            />
          </div>
          <span>{formatTime(duration ?? 0)}</span>
        </div>
      )}
    </Card>
  )
}
