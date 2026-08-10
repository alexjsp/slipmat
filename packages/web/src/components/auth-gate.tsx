import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/**
 * Authentication is optional, so this is usually invisible: when no password is
 * configured the server reports `required: false` and children render straight
 * away. It only becomes a login screen when someone has opted in.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const status = useQuery({
    queryKey: ['auth-status'],
    queryFn: async () => {
      const res = await fetch('/api/auth/status')
      return (await res.json()) as { required: boolean }
    },
  })

  const session = useQuery({
    // A 200 here means the cookie is good; 401 means we need the form.
    queryKey: ['auth-session'],
    queryFn: async () => (await fetch('/api/system')).status !== 401,
    enabled: status.data?.required === true,
  })

  if (status.isPending) return null
  if (!status.data?.required || session.data === true) return <>{children}</>
  if (session.isPending) return null

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      if (!res.ok) {
        setError('Incorrect password')
        return
      }
      setPassword('')
      // Everything fetched while logged out needs re-fetching.
      await queryClient.invalidateQueries()
    } catch {
      setError('Could not reach the server')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm gap-4 p-6">
        <h1 className="font-semibold text-xl tracking-tight">Slipmat</h1>
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <div className="flex flex-col gap-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoFocus
            />
          </div>
          {error && <p className="text-destructive text-sm">{error}</p>}
          <Button type="submit" disabled={busy || !password}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </Card>
    </main>
  )
}
