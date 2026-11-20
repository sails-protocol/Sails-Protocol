import { acceptsAnyMethod, splitOverflow } from '../src/lib/paymentMethods'

describe('PaymentMethods overflow', () => {
  it('shows up to max and counts the rest', () => {
    expect(splitOverflow(['PIX'], 2)).toEqual({ shown: ['PIX'], more: 0 })
    expect(splitOverflow(['PIX', 'TED'], 2)).toEqual({ shown: ['PIX', 'TED'], more: 0 })
    expect(splitOverflow(['PIX', 'TED', 'Dinheiro', 'Wise'], 2)).toEqual({ shown: ['PIX', 'TED'], more: 2 })
    expect(splitOverflow(['PIX', 'TED', 'Dinheiro'], 1)).toEqual({ shown: ['PIX'], more: 2 })
  })
  it('handles empty lists and odd limits', () => {
    expect(splitOverflow([], 2)).toEqual({ shown: [], more: 0 })
    expect(splitOverflow(['PIX', 'TED'], 0)).toEqual({ shown: [], more: 2 })
    expect(splitOverflow(['PIX', 'TED'], -1)).toEqual({ shown: [], more: 2 })
    expect(splitOverflow(['PIX', 'TED', 'Wise'], 1.7)).toEqual({ shown: ['PIX'], more: 2 })
  })
})

describe('payment filter (any of)', () => {
  it('matches when the offer accepts at least one selected method', () => {
    expect(acceptsAnyMethod(['PIX'], [])).toBe(true)
    expect(acceptsAnyMethod(['PIX'], ['PIX', 'TED'])).toBe(true)
    expect(acceptsAnyMethod(['CASH', 'TED'], ['TED'])).toBe(true)
    expect(acceptsAnyMethod(['PIX'], ['TED'])).toBe(false)
    expect(acceptsAnyMethod([], ['TED'])).toBe(false)
  })
})
