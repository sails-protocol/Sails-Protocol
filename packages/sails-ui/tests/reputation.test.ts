import { formatReputation, trustParts } from '../src/lib/reputation'
import * as reputation from '../src/lib/reputation'
import { countActiveFilters } from '../src/lib/filters'
import { DEFAULT_FILTERS } from '../src/types'

describe('reputation display', () => {
  it('uses the one "Reputação N" format, never "pontos"', () => {
    expect(formatReputation(96)).toBe('Reputação 96')
    expect(formatReputation(-3)).toBe('Reputação -3')
    expect(formatReputation(74.6)).toBe('Reputação 75')
  })

  it('builds the trust line only from fields that exist', () => {
    expect(trustParts({ reputationScore: 10 })).toEqual(['Reputação 10'])
    expect(trustParts({ reputationScore: 10, totalTrades: 1, disputeCount: 0 })).toEqual(['Reputação 10', '1 trade', '0 disputas'])
    expect(trustParts({ reputationScore: 10, totalTrades: 312, disputeCount: 1 })).toEqual(['Reputação 10', '312 trades', '1 disputa'])
  })

  it('no longer exposes UI-invented trust metrics (CTO Despacho 033)', () => {
    expect(Object.keys(reputation)).not.toContain('positiveFeedbackPct')
    expect(Object.keys(reputation)).not.toContain('isPowerTrader')
    expect(Object.keys(reputation)).not.toContain('isPowerTraderFromCanonical')
  })
})

describe('Market filters', () => {
  it('has no fixed-threshold "alta reputação" filter, and a stale saved one is not counted', () => {
    expect(DEFAULT_FILTERS).not.toHaveProperty('highReputationOnly')
    const saved = { ...DEFAULT_FILTERS, highReputationOnly: true } as typeof DEFAULT_FILTERS
    expect(countActiveFilters(saved)).toBe(0)
  })
})
