import { publicationPriceUsd } from '../src/lib/publicationPrice'

describe('publication price boundary (CTO 118)', () => {
  it('never manufactures USD from another currency', () => {
    for (const currency of ['BRL', 'PYG', 'EUR', 'Todas', '', 'usd']) {
      expect(publicationPriceUsd('500.00', currency)).toBe(null)
    }
  })

  it('preserves USD decimal strings without floating-point conversion or rounding', () => {
    for (const price of ['500.00', '0.00000001', '9999999999999999.99999999']) {
      expect(publicationPriceUsd(price, 'USD')).toBe(price)
    }
  })

  it('rejects invalid, non-positive and out-of-scale values rather than rounding them', () => {
    for (const price of ['', '0', '0.00000000', '-1', 'NaN', 'Infinity', '1e3', '1,25', ' 1 ', '1.000000001', '10000000000000000']) {
      expect(publicationPriceUsd(price, 'USD')).toBe(null)
    }
  })
})
