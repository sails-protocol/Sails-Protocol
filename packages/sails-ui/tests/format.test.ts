import { formatAmount, formatDateTime, formatUsdExact } from '../src/lib/format'
import { formatPrice } from '../src/lib/currency'

// Intl puts a no-break space between the symbol and the number.
const nb = (s: string) => s.replace(/ /g, ' ')

describe('formatUsdExact (trade USD amounts)', () => {
  it('uses the same pt-BR style as the Market price', () => {
    expect(formatUsdExact('97450')).toBe(nb('US$ 97.450,00'))
    expect(formatUsdExact('97450')).toBe(formatPrice(97450, 'USD'))
    expect(formatUsdExact('487.25')).toBe(formatPrice(487.25, 'USD'))
  })

  it('never rounds away sub-cent digits from the record', () => {
    expect(formatUsdExact('1.002')).toBe(nb('US$ 1,002'))
    expect(formatUsdExact('501.000')).toBe(nb('US$ 501,00'))
    expect(formatUsdExact('0.1')).toBe(nb('US$ 0,10'))
  })

  it('shows an unparseable record as given, still marked as USD', () => {
    expect(formatUsdExact('n/a')).toBe('US$ n/a')
  })
})

describe('one pt-BR number and date policy', () => {
  it('crypto amounts use the decimal comma and trim trailing zeros', () => {
    expect(formatAmount(0.0015)).toBe('0,0015')
    expect(formatAmount(5000)).toBe('5.000')
    expect(formatAmount(0.123456789)).toBe('0,12345679')
  })

  it('dates show the year only when it is not the current year', () => {
    const now = new Date(2026, 10, 20, 12, 0)
    expect(formatDateTime(new Date(2026, 10, 20, 14, 32).toISOString(), now)).toBe('20/11, 14:32')
    expect(formatDateTime(new Date(2025, 8, 3, 9, 5).toISOString(), now)).toBe('03/09/2025, 09:05')
  })
})
