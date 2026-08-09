import { ListMusic, Settings, Speaker } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link, Route, Switch, useLocation } from 'wouter'
import { PauseAllButton } from '@/components/pause-all-button'
import { useSystemState } from '@/lib/system-state'
import { cn } from '@/lib/utils'
import { NowPlayingPage } from '@/pages/now-playing'
import { PresetsPage } from '@/pages/presets'
import { SettingsPage } from '@/pages/settings'

export function App() {
  const { state, status } = useSystemState()
  const [error, setError] = useState<string | null>(null)
  const [location] = useLocation()

  const onError = useCallback((message: string) => setError(message), [])

  // Nothing to pause means the button is decoration; disable rather than hide,
  // so it doesn't shift the header around as music starts and stops.
  const anythingPlaying =
    state?.groups.some(
      (group) =>
        group.transportState === 'PLAYING' &&
        group.playbackKind !== 'tv' &&
        group.playbackKind !== 'line-in',
    ) ?? false

  useEffect(() => {
    if (!error) return
    const timer = setTimeout(() => setError(null), 6000)
    return () => clearTimeout(timer)
  }, [error])

  return (
    <div className="mx-auto flex min-h-dvh max-w-2xl flex-col">
      <header className="flex items-center justify-between gap-4 px-4 pt-4">
        <h1 className="font-semibold text-xl tracking-tight">Domovoi</h1>
        <div className="flex items-center gap-3">
          <span
            className={cn(
              'text-xs',
              status === 'open' ? 'text-muted-foreground' : 'text-destructive',
            )}
          >
            {status === 'open' ? 'live' : status === 'connecting' ? 'connecting…' : 'reconnecting…'}
          </span>
          <PauseAllButton
            disabled={!anythingPlaying}
            onDone={(skipped) =>
              // Say so, rather than letting it look like the button half-worked.
              skipped > 0 && setError(`Music paused. Left ${skipped} TV or line-in source playing.`)
            }
            onError={onError}
          />
        </div>
      </header>

      <nav className="flex gap-1 px-4 pt-3">
        <NavLink href="/" current={location} icon={<Speaker className="size-4" />}>
          Now Playing
        </NavLink>
        <NavLink href="/presets" current={location} icon={<ListMusic className="size-4" />}>
          Presets
        </NavLink>
        <NavLink href="/settings" current={location} icon={<Settings className="size-4" />}>
          Settings
        </NavLink>
      </nav>

      {error && (
        <output className="mx-4 mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive text-sm">
          {error}
        </output>
      )}

      <main className="flex-1 p-4 pb-16">
        {!state ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : !state.ready ? (
          <p className="text-muted-foreground text-sm">
            No Sonos devices found yet. Check host networking, or set <code>DOMOVOI_SEED_IP</code>.
          </p>
        ) : (
          <Switch>
            <Route path="/presets">
              <PresetsPage zones={state.zones} onError={onError} />
            </Route>
            <Route path="/settings">
              <SettingsPage />
            </Route>
            <Route>
              <NowPlayingPage state={state} onError={onError} />
            </Route>
          </Switch>
        )}
      </main>
    </div>
  )
}

function NavLink({
  href,
  current,
  icon,
  children,
}: {
  href: string
  current: string
  icon: React.ReactNode
  children: React.ReactNode
}) {
  const active = href === '/' ? current === '/' : current.startsWith(href)
  return (
    <Link
      href={href}
      className={cn(
        'flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium text-sm transition-colors',
        active
          ? 'bg-secondary text-secondary-foreground'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {icon}
      {children}
    </Link>
  )
}
