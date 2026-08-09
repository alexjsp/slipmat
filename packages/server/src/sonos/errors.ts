/**
 * Distinguishes "you asked for a zone that doesn't exist" (a client mistake,
 * 404) from "the speaker refused or was unreachable" (an upstream failure,
 * 502). Both used to surface as 502, which made a typo look like a broken
 * speaker.
 */
export class UnknownZoneError extends Error {
  readonly zoneId: string

  constructor(zoneId: string) {
    super(`Unknown zone ${zoneId}`)
    this.name = 'UnknownZoneError'
    this.zoneId = zoneId
  }
}
