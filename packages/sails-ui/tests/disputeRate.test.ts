import { formatAccountDisputeRate } from '../src/lib/reputation'

describe('account dispute rate display', () => {
  it('never hides disputes behind 0%', () => {
    expect(formatAccountDisputeRate({ totalTrades: 0, disputeCount: 1 })).toBe('1 disputa')
    expect(formatAccountDisputeRate({ totalTrades: 0, disputeCount: 0 })).toBe('0%')
  })
  it('does not show a ratio above 100%', () => {
    expect(formatAccountDisputeRate({ totalTrades: 1, disputeCount: 2 })).toBe('2 disputas')
  })
  it('shows a rounded percentage otherwise', () => {
    expect(formatAccountDisputeRate({ totalTrades: 3, disputeCount: 1 })).toBe('33%')
  })
})
