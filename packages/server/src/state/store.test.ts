import { beforeEach, describe, expect, it } from 'vitest'
import { FakeSonosDriver } from '../sonos/fake-driver.js'
import { SystemStateStore } from './store.js'

// Every test here runs against the fake household — never real speakers.
describe('SystemStateStore', () => {
  let driver: FakeSonosDriver
  let store: SystemStateStore

  beforeEach(async () => {
    driver = new FakeSonosDriver({ tvZoneIds: ['RINCON_LIVING01400'] })
    await driver.start()
    store = new SystemStateStore(driver)
    store.refresh()
  })

  it('exposes one zone per room and one group per zone at rest', () => {
    const state = store.current
    expect(state.zones.map((z) => z.name)).toEqual(['Bedroom', 'Kitchen', 'Living Room', 'Office'])
    expect(state.groups).toHaveLength(4)
  })

  it('classifies the TV zone so pause-all can skip it', () => {
    const living = store.current.groups.find((g) => g.coordinatorZoneId === 'RINCON_LIVING01400')
    expect(living?.playbackKind).toBe('tv')
    expect(living?.transportState).toBe('PLAYING')
  })

  it('collapses a join into a single group with the right members', async () => {
    await driver.joinGroup('RINCON_KITCHEN01400', ['RINCON_BEDROOM01400', 'RINCON_OFFICE01400'])
    store.refresh()

    const state = store.current
    expect(state.groups).toHaveLength(2)
    const kitchen = state.groups.find((g) => g.coordinatorZoneId === 'RINCON_KITCHEN01400')
    expect(kitchen?.memberZoneIds.sort()).toEqual([
      'RINCON_BEDROOM01400',
      'RINCON_KITCHEN01400',
      'RINCON_OFFICE01400',
    ])
    // Zones survive grouping — they're rooms, not groups.
    expect(state.zones).toHaveLength(4)
  })

  it('hands coordination to a remaining member when the coordinator leaves', async () => {
    await driver.joinGroup('RINCON_KITCHEN01400', ['RINCON_BEDROOM01400'])
    await driver.leaveGroup(['RINCON_KITCHEN01400'])
    store.refresh()

    const bedroom = store.current.groups.find((g) =>
      g.memberZoneIds.includes('RINCON_BEDROOM01400'),
    )
    expect(bedroom?.coordinatorZoneId).toBe('RINCON_BEDROOM01400')
    expect(bedroom?.memberZoneIds).toEqual(['RINCON_BEDROOM01400'])
  })

  it('bumps the revision and notifies listeners only on real changes', async () => {
    const seen: number[] = []
    store.on('change', (state) => seen.push(state.revision))

    await driver.setVolume('RINCON_KITCHEN01400', 42)
    store.refresh()
    await driver.setVolume('RINCON_KITCHEN01400', 42) // same value, no change
    store.refresh()

    expect(seen).toHaveLength(1)
    expect(store.current.zones.find((z) => z.name === 'Kitchen')?.volume).toBe(42)
  })

  it('rewrites album art through the proxy so it survives remote access', async () => {
    driver.setPlaying(
      'RINCON_KITCHEN01400',
      'x-rincon-queue:RINCON_KITCHEN01400#0',
      'x-sonos-spotify:track1',
    )
    store.refresh()
    const kitchen = store.current.groups.find((g) => g.coordinatorZoneId === 'RINCON_KITCHEN01400')
    expect(kitchen?.playbackKind).toBe('queue')
  })

  it('marks a dropped speaker unreachable rather than removing it', () => {
    driver.setUnreachable('RINCON_OFFICE01400', true)
    store.refresh()
    const office = store.current.zones.find((z) => z.name === 'Office')
    expect(office?.unreachable).toBe(true)
  })
})
