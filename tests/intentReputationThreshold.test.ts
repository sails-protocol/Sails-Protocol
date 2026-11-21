/**
 * UX-048 (CTO): the reputation threshold of a TradeIntent is compared with the canonical OpenReputation score
 * (users.reputationScore: cumulative, no ceiling, can be negative). minReputationScore is the field;
 * minReputationRating stays as a deprecated alias with its old 0-5 validation and the same number (never rescaled).
 */
import { OpenP2PTradeIntentHandler } from '../src/modules/open-p2p/intent-handler'
import type { TradeIntentPayload } from '../src/common/types/intent'

const base: TradeIntentPayload = { asset: 'BTC', side: 'BUY' } as TradeIntentPayload
const check = (extra: Record<string, unknown>) => OpenP2PTradeIntentHandler.validate({ ...base, ...extra } as TradeIntentPayload)

describe('TradeIntent reputation threshold (UX-048)', () => {
  it.each([-5, 0, 3.5, 40, 1e9, -1e9])('accepts minReputationScore %p (finite, negative allowed, no 0-5 ceiling)', (v) => {
    expect(check({ minReputationScore: v })).toEqual({ valid: true })
  })

  it.each([NaN, Infinity, -Infinity, 1e12, -1e12, 1e9 + 1])('refuses minReputationScore %p (not finite or outside the sanity range)', (v) => {
    expect(check({ minReputationScore: v }).valid).toBe(false)
  })

  it.each(['5', true, null, {}])('refuses a non-number minReputationScore %p', (v) => {
    expect(check({ minReputationScore: v }).valid).toBe(false)
  })

  it('keeps the deprecated alias exactly as before: 0-5 accepted, outside refused', () => {
    expect(check({ minReputationRating: 0 })).toEqual({ valid: true })
    expect(check({ minReputationRating: 5 })).toEqual({ valid: true })
    expect(check({ minReputationRating: 6 }).valid).toBe(false)
    expect(check({ minReputationRating: -1 }).valid).toBe(false)
  })

  it('accepts both fields when equal, refuses them when they differ', () => {
    expect(check({ minReputationScore: 3, minReputationRating: 3 })).toEqual({ valid: true })
    const r = check({ minReputationScore: -5, minReputationRating: 0 })
    expect(r.valid).toBe(false)
    expect(r.errors?.join(' ')).toMatch(/must be equal/)
  })

  it('no threshold at all is valid (unchanged)', () => {
    expect(check({})).toEqual({ valid: true })
  })
})
