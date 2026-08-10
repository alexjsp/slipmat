import { useQuery } from '@tanstack/react-query'
import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { useHomeKit } from '@/lib/use-homekit'

export function SettingsPage() {
  const homekit = useHomeKit()
  const pauseAll = useQuery({
    queryKey: ['pause-all-token'],
    queryFn: async () => (await fetch('/api/pause-all/token')).json() as Promise<{ token: string }>,
  })

  return (
    <div className="flex flex-col gap-4">
      <h2 className="font-semibold text-lg">Settings</h2>

      <Card className="gap-3 p-4">
        <h3 className="font-medium text-sm">HomeKit</h3>
        {homekit.isPending ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : !homekit.data?.enabled ? (
          <p className="text-muted-foreground text-sm">
            Off. Set <code className="font-mono">DOMOVOI_HOMEKIT=1</code> and restart to expose your
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
              <strong>Domovoi</strong>. Enter this code when asked:
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
