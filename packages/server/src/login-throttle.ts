/** How far back failed logins count. */
const WINDOW_MS = 15 * 60 * 1000
/** Failures one address may make inside the window before it is made to wait. */
const PER_ADDRESS_LIMIT = 10
/**
 * Failures from everyone together. The per-address limit alone is beaten by
 * anyone who can vary their address — a LAN client can claim any
 * X-Forwarded-For it likes — so a household-wide ceiling sits behind it.
 */
const TOTAL_LIMIT = 100

/**
 * Slows password guessing to a crawl without a dependency or a database.
 *
 * In memory on purpose: a restart forgetting the counts costs an attacker a
 * restart, which they cannot cause, and there is one process.
 */
export class LoginThrottle {
  private readonly byAddress = new Map<string, number[]>()
  private all: number[] = []

  constructor(private readonly now: () => number = Date.now) {}

  /** Milliseconds until this address may try again; 0 when it may try now. */
  retryAfterMs(address: string): number {
    const cutoff = this.now() - WINDOW_MS
    this.all = this.all.filter((t) => t > cutoff)
    const mine = (this.byAddress.get(address) ?? []).filter((t) => t > cutoff)
    if (mine.length === 0) this.byAddress.delete(address)
    else this.byAddress.set(address, mine)

    const waits: number[] = []
    if (mine.length >= PER_ADDRESS_LIMIT) waits.push(mine[0]! - cutoff)
    if (this.all.length >= TOTAL_LIMIT) waits.push(this.all[0]! - cutoff)
    return waits.length ? Math.max(...waits) : 0
  }

  recordFailure(address: string): void {
    const at = this.now()
    this.all.push(at)
    this.byAddress.set(address, [...(this.byAddress.get(address) ?? []), at])
  }

  /** A correct password clears that address's record, not everyone's. */
  recordSuccess(address: string): void {
    this.byAddress.delete(address)
  }
}
