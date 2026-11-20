import { formatUsdExact } from '../src/lib/format'
import { formatPrice } from '../src/lib/currency'

describe('formatUsdExact (trade USD amounts)', () => {
  it('uses the same en-US style as the Market price', () => {
    expect(formatUsdExact('97450')).toBe('$97,450.00')
    expect(formatUsdExact('97450')).toBe(formatPrice(97450, 'USD'))
    expect(formatUsdExact('487.25')).toBe(formatPrice(487.25, 'USD'))
  })

  it('never rounds away sub-cent digits from the record', () => {
    expect(formatUsdExact('1.002')).toBe('$1.002')
    expect(formatUsdExact('501.000')).toBe('$501.00')
    expect(formatUsdExact('0.1')).toBe('$0.10')
  })

  it('shows an unparseable record as given, still marked as USD', () => {
    expect(formatUsdExact('n/a')).toBe('$n/a')
  })
})
