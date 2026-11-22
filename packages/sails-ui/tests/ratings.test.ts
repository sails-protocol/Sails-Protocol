import { offerRatings, ratingCompactItem, ratingFullText, ratingSrText, ratingSummaryOf, sellerMemberSince, sellerRatings } from '../src/lib/ratings'
import { RATINGS_DEMO_EXPLANATION, REPUTATION_EXPLANATION } from '../src/lib/reputation'

describe('rating summary reader (demo-only until LOOSE_WIRES.readRatings)', () => {
  it('real data (no demo field) is always null', () => {
    expect(offerRatings({})).toBeNull()
    expect(sellerRatings({})).toBeNull()
    expect(sellerMemberSince({})).toBeNull()
  })
  it('accepts only a 1-5 average over at least one rating', () => {
    expect(ratingSummaryOf({ average: 4.8, count: 126 })).toEqual({ average: 4.8, count: 126 })
    for (const bad of [null, undefined, {}, { average: 0, count: 3 }, { average: 5.1, count: 3 }, { average: 4, count: 0 }, { average: 4, count: 2.5 }, { average: Number.NaN, count: 3 }, { average: '4.8', count: 3 }])
      expect(ratingSummaryOf(bad)).toBeNull()
  })
  it('compact list form: star item "4,8 (126)", never "/5", with the full accessible name', () => {
    const item = ratingCompactItem({ average: 4.8, count: 126 })
    expect(item).toEqual({ kind: 'rating', text: '4,8 (126)', srText: 'Avaliação média 4,8 de 5, 126 avaliações' })
    expect(item.text).not.toMatch(/\/\s*5/)
    expect(ratingCompactItem({ average: 5, count: 1 }).text).toBe('5,0 (1)')
  })
  it('full form and singular count', () => {
    expect(ratingFullText({ average: 4.7, count: 233 })).toBe('4,7 · 233 avaliações')
    expect(ratingFullText({ average: 4.66, count: 1 })).toBe('4,7 · 1 avaliação')
    expect(ratingSrText({ average: 4.6, count: 12 })).toBe('Avaliação média 4,6 de 5, 12 avaliações')
  })
  it('member since is month and year, nothing for a bad date', () => {
    expect(sellerMemberSince({ demoMemberSince: '2025-01-15T12:00:00Z' })).toBe('jan. de 2025')
    expect(sellerMemberSince({ demoMemberSince: 'x' })).toBeNull()
  })
})

describe('ratings stay separate from the reputation', () => {
  it('the reputation explanation says stars are informational and never change it', () => {
    expect(REPUTATION_EXPLANATION.footer).toContain('As estrelas são avaliações')
    expect(REPUTATION_EXPLANATION.footer).toContain('nunca mudam a reputação')
  })
  it('the on-screen ratings explanation says the numbers are demo-only', () => {
    expect(RATINGS_DEMO_EXPLANATION.lines.join(' ')).toContain('fictícios do modo demonstração')
  })
})
