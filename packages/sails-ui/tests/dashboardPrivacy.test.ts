import { aggregatesHidden, MIN_AGGREGATE_COUNT, periodFigures } from '../src/lib/tradeStats'
import { demoMarketDashboard, DEMO_DASHBOARD_MARKET_ID } from '../src/demo/dashboards'
import { DEMO_MEMBER_KEYS } from '../src/demo/nodesMarkets'

describe('space dashboard small-numbers privacy (CTO 29 Portable Analytics)', () => {
  it('hides with fewer than MIN_AGGREGATE_COUNT concluded trades or members, or members unknown', () => {
    expect(MIN_AGGREGATE_COUNT).toBe(5)
    expect(aggregatesHidden({ completed: 4, members: 12 })).toBe(true)
    expect(aggregatesHidden({ completed: 5, members: 4 })).toBe(true)
    expect(aggregatesHidden({ completed: 5, members: undefined })).toBe(true)
    expect(aggregatesHidden({ completed: 5, members: null })).toBe(true)
    expect(aggregatesHidden({ completed: 5, members: 5 })).toBe(false)
  })

  const now = new Date(2026, 10, 23, 12)
  const data = demoMarketDashboard(DEMO_DASHBOARD_MARKET_ID, 6, DEMO_MEMBER_KEYS.length, now)!
  const day = (n: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - n)
  it('demo: the market has enough members, and 30 days show the breakdown', () => {
    expect(DEMO_MEMBER_KEYS.length).toBeGreaterThanOrEqual(MIN_AGGREGATE_COUNT)
    const fig = periodFigures(data.trades, { from: day(29), to: day(0) })
    expect(aggregatesHidden({ completed: fig.completed, members: DEMO_MEMBER_KEYS.length })).toBe(false)
  })
  it('demo: a short custom range with few trades shows the privacy message', () => {
    const fig = periodFigures(data.trades, { from: day(2), to: day(0) })
    expect(fig.completed).toBeLessThan(MIN_AGGREGATE_COUNT)
    expect(aggregatesHidden({ completed: fig.completed, members: DEMO_MEMBER_KEYS.length })).toBe(true)
  })
})
