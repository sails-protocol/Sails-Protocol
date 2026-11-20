import { acceptsAnyMethod, LIST_METHODS_MAX, LIST_METHODS_MAX_NARROW, MAX_PAYMENT_METHODS, offerPaymentMethods, splitOverflow } from '../src/lib/paymentMethods'

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

describe('payment method rules', () => {
  it('caps an offer at 5 methods (product rule, issue #735)', () => {
    expect(MAX_PAYMENT_METHODS).toBe(5)
  })
  it('list rows show 3 then +N, 2 below sm', () => {
    expect(LIST_METHODS_MAX).toBe(3)
    expect(LIST_METHODS_MAX_NARROW).toBe(2)
    const five = ['PIX', 'TED', 'Dinheiro', 'Wise', 'Outro']
    expect(splitOverflow(five, LIST_METHODS_MAX)).toEqual({ shown: ['PIX', 'TED', 'Dinheiro'], more: 2 })
    expect(splitOverflow(five, LIST_METHODS_MAX_NARROW)).toEqual({ shown: ['PIX', 'TED'], more: 3 })
    expect(splitOverflow(['PIX', 'TED', 'Dinheiro'], LIST_METHODS_MAX)).toEqual({ shown: ['PIX', 'TED', 'Dinheiro'], more: 0 })
  })
})

describe('offerPaymentMethods (single adapter)', () => {
  it('real data yields the one real method', () => {
    expect(offerPaymentMethods({ paymentMethod: 'PIX' })).toEqual(['PIX'])
    expect(offerPaymentMethods({ paymentMethod: 'TED', demoPaymentMethods: [] })).toEqual(['TED'])
  })
  it('demo data yields its list, never more than 5', () => {
    expect(offerPaymentMethods({ paymentMethod: 'PIX', demoPaymentMethods: ['PIX', 'TED', 'CASH'] })).toEqual(['PIX', 'TED', 'CASH'])
    expect(offerPaymentMethods({ paymentMethod: 'PIX', demoPaymentMethods: ['PIX', 'TED', 'CASH', 'OTHER', 'BANK_TRANSFER', 'CRYPTO_DIRECT'] })).toHaveLength(5)
  })
  it('the any-of filter sees every demo method', () => {
    expect(acceptsAnyMethod(offerPaymentMethods({ paymentMethod: 'BANK_TRANSFER', demoPaymentMethods: ['BANK_TRANSFER', 'PIX', 'TED'] }), ['TED'])).toBe(true)
    expect(acceptsAnyMethod(offerPaymentMethods({ paymentMethod: 'BANK_TRANSFER' }), ['TED'])).toBe(false)
  })
})
