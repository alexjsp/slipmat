import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import { BlocklistEditor } from '@/components/blocklist-editor'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { getJson, putJson } from '@/lib/api'
import { useHomeKit } from '@/lib/use-homekit'

export function SettingsPage() {
  const homekit = useHomeKit()
  const pauseAll = useQuery({
    queryKey: ['pause-all-token'],
    queryFn: () => getJson<{ token: string }>('/api/pause-all/token'),
  })

  return (
    <div className="flex flex-col gap-4">
      <h2 className="font-semibold text-lg">Settings</h2>

      <TimeZoneCard />

      <BlocklistEditor />

      <Card className="gap-3 p-4">
        <h3 className="font-medium text-sm">HomeKit</h3>
        {homekit.isPending ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : !homekit.data?.enabled ? (
          <p className="text-muted-foreground text-sm">
            Off. Set <code className="font-mono">SLIPMAT_HOMEKIT=1</code> and restart to expose your
            presets as HomeKit switches, plus a Pause All Music switch.
          </p>
        ) : !homekit.data.running ? (
          <p className="text-destructive text-sm">
            Enabled, but the bridge failed to start — check the logs. HomeKit needs host networking
            for mDNS.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-muted-foreground text-sm">
              In the Home app choose “Add Accessory”, then “More options…”, and pick{' '}
              <strong>Slipmat</strong>. Enter this code when asked:
            </p>
            <p className="font-mono text-2xl tracking-wider">{homekit.data.pincode}</p>
            <p className="text-muted-foreground text-xs">
              Only presets with “Show in HomeKit” turned on appear as switches.
            </p>
          </div>
        )}
      </Card>

      <Card className="gap-3 p-4">
        <h3 className="font-medium text-sm">Pause All Music webhook</h3>
        <p className="text-muted-foreground text-sm">
          Pauses every group playing music and leaves TV and line-in alone. GET or POST works.
        </p>
        {pauseAll.data && (
          <CopyableUrl value={`${window.location.origin}/api/webhooks/${pauseAll.data.token}`} />
        )}
      </Card>
    </div>
  )
}

/**
 * The one zone the whole household runs on.
 *
 * It has to be the server's, because that is where a 07:30 schedule fires long
 * after every browser is closed — but the server is a container, and left to
 * itself it thinks it is in UTC. So this offers the zone of the device you are
 * reading it on, which is as close to "your time" as a shared server can get.
 */
function TimeZoneCard() {
  const client = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const query = useQuery({
    queryKey: ['timezone'],
    queryFn: () => getJson<{ timeZone: string }>('/api/timezone'),
  })

  const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const serverZone = query.data?.timeZone

  const save = async (timeZone: string) => {
    setError(null)
    try {
      await putJson('/api/timezone', { timeZone })
      // Schedules, rule previews and the "times are…" line all read this.
      await client.invalidateQueries()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the time zone')
    }
  }

  return (
    <Card className="gap-3 p-4">
      <h3 className="font-medium text-sm">Time zone</h3>
      {serverZone && (
        <p className="text-muted-foreground text-sm">
          Schedules and time-based rules are read in <strong>{serverZone}</strong>. It is{' '}
          {new Date().toLocaleTimeString('en-GB', {
            timeZone: serverZone,
            hour: '2-digit',
            minute: '2-digit',
          })}{' '}
          there now.
        </p>
      )}
      {serverZone && serverZone !== deviceZone && (
        <Button variant="outline" size="sm" className="self-start" onClick={() => save(deviceZone)}>
          Use this device's ({deviceZone})
        </Button>
      )}
      {error && <p className="text-destructive text-sm">{error}</p>}
    </Card>
  )
}

function CopyableUrl({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex gap-2">
      <Input readOnly value={value} className="font-mono text-xs" />
      <Button
        variant="outline"
        size="icon"
        aria-label="Copy URL"
        onClick={() => {
          void navigator.clipboard.writeText(value)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </Button>
    </div>
  )
}
