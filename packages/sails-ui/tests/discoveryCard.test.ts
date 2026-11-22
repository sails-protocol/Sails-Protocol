import { DISCOVERY_SNOOZE_DAYS, shouldShowDiscovery } from '../src/lib/discoveryCard'

const NOW = Date.parse('2026-11-21T12:00:00Z')
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString()

describe('markets discovery card', () => {
  it('shows until dismissed', () => {
    expect(shouldShowDiscovery(NOW, null)).toBe(true)
  })
  it('stays hidden during the snooze and returns after it', () => {
    expect(shouldShowDiscovery(NOW, daysAgo(1))).toBe(false)
    expect(shouldShowDiscovery(NOW, daysAgo(DISCOVERY_SNOOZE_DAYS - 1))).toBe(false)
    expect(shouldShowDiscovery(NOW, daysAgo(DISCOVERY_SNOOZE_DAYS))).toBe(true)
  })
  it('an unreadable stored value shows the card instead of hiding it forever', () => {
    expect(shouldShowDiscovery(NOW, 'not a date')).toBe(true)
  })
})
