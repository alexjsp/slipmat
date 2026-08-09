import type { Group, Zone } from '@domovoi/shared'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { VolumeSlider } from '@/components/volume-slider'
import { api } from '@/lib/api'

/**
 * Per-zone volumes and grouping for one group.
 *
 * Grouping is expressed as "which zones are in this group" rather than
 * join/leave verbs, which matches how people think about it — tick the Bedroom
 * to add it, untick to send it back to being its own room.
 */
export function GroupSheet({
  open,
  onOpenChange,
  group,
  zones,
  onError,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  group: Group
  zones: Zone[]
  onError: (message: string) => void
}) {
  const memberIds = new Set(group.memberZoneIds)

  const toggle = (zone: Zone, checked: boolean) => {
    const action = checked
      ? api.joinGroup(group.coordinatorZoneId, [zone.id])
      : api.leaveGroup([zone.id])
    action.catch((err: Error) => onError(err.message))
  }

  const members = zones.filter((zone) => memberIds.has(zone.id))
  const others = zones.filter((zone) => !memberIds.has(zone.id))

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{members.map((zone) => zone.name).join(' + ')}</SheetTitle>
          <SheetDescription>Set each speaker's volume, or add and remove rooms.</SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-5 px-4 pb-8">
          {members.map((zone) => (
            <div key={zone.id} className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-sm">
                  {zone.name}
                  {zone.id === group.coordinatorZoneId && members.length > 1 && (
                    <span className="ml-2 text-muted-foreground text-xs">coordinator</span>
                  )}
                </span>
                {members.length > 1 && (
                  <Checkbox
                    checked
                    aria-label={`Remove ${zone.name} from the group`}
                    // Removing the coordinator hands the group to another member
                    // rather than dissolving it, which is what Sonos does too.
                    onCheckedChange={() => toggle(zone, false)}
                  />
                )}
              </div>
              <VolumeSlider
                value={zone.volume}
                muted={zone.muted}
                disabled={zone.unreachable}
                onCommit={(volume) => {
                  api.setVolume(zone.id, volume).catch((err: Error) => onError(err.message))
                }}
                onToggleMute={() => {
                  api.setMute(zone.id, !zone.muted).catch((err: Error) => onError(err.message))
                }}
              />
            </div>
          ))}

          {others.length > 0 && (
            <div className="flex flex-col gap-3 border-t pt-4">
              <p className="text-muted-foreground text-xs uppercase tracking-wide">Add a room</p>
              {others.map((zone) => (
                <div key={zone.id} className="flex items-center gap-3 text-sm">
                  <Checkbox
                    id={`add-${zone.id}`}
                    checked={false}
                    disabled={zone.unreachable}
                    onCheckedChange={() => toggle(zone, true)}
                  />
                  <label
                    htmlFor={`add-${zone.id}`}
                    className={zone.unreachable ? 'text-muted-foreground' : undefined}
                  >
                    {zone.name}
                    {zone.unreachable && ' (offline)'}
                  </label>
                </div>
              ))}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
