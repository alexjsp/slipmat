import { AlertTriangle } from 'lucide-react'
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'

/**
 * Keeps one broken component from taking the whole page with it.
 *
 * React unmounts the entire tree when a render throws and nothing catches it,
 * so a single bad read — a `.map` on a field that a failed request never
 * returned — showed up as the app vanishing into a blank page, with the reason
 * visible only in the browser console. Losing a panel is bad; losing the
 * transport controls and any hint of what happened is worse.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; label?: string },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Still worth the console: the message on screen is deliberately short.
    console.error('Unhandled error in', this.props.label ?? 'component', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <div className="flex flex-col items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
        <div className="flex items-center gap-2 text-destructive text-sm">
          <AlertTriangle className="size-4 shrink-0" />
          <span className="font-medium">
            {this.props.label ? `${this.props.label} failed to load` : 'Something went wrong'}
          </span>
        </div>
        <p className="text-muted-foreground text-xs">{this.state.error.message}</p>
        <Button size="sm" variant="secondary" onClick={() => this.setState({ error: null })}>
          Try again
        </Button>
      </div>
    )
  }
}
