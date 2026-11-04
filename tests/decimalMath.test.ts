// tests/decimalMath.test.ts
//
// #165 — exact decimal multiply for persisted money-like values
// (Trade.totalUsd, TradeIntent min/max value, appeal fee). Pure unit tests.

import { Prisma } from '@prisma/client'
import { multiplyDecimals } from '../src/common/decimal-math'

// Independent reference: scaled BigInt arithmetic, round half up to 8 dp.
function referenceMultiply(a: string, b: string): string {
  const [aw, af = ''] = a.split('.')
  const [bw, bf = ''] = b.split('.')
  const aScaled = BigInt(aw + af.padEnd(8, '0'))
  const bScaled = BigInt(bw + bf.padEnd(8, '0'))
  const prod = aScaled * bScaled // 16 decimal places
  const unit = 10n ** 8n
  let q = prod / unit
  if ((prod % unit) * 2n >= unit) q += 1n
  return `${q / unit}.${(q % unit).toString().padStart(8, '0')}`
}

describe('multiplyDecimals (exact, half-up, 8 dp)', () => {
  it.each([
    ['60000', '0.001', '60.00000000'],
    ['0.1', '0.3', '0.03000000'],
    ['1', '1', '1.00000000'],
    ['0', '123.45', '0.00000000'],
    ['0.00000001', '0.5', '0.00000001'], // 5e-9 rounds half UP, not down
    ['0.00000001', '0.4', '0.00000000'],
    ['1.00000001', '1.00000001', '1.00000002'],
  ])('%s x %s = %s', (a, b, expected) => {
    expect(multiplyDecimals(a, b)).toBe(expected)
  })

  it('accepts Prisma.Decimal and number operands (as Offer/Escrow columns and constants)', () => {
    expect(multiplyDecimals(new Prisma.Decimal('0.00123456'), 2)).toBe('0.00246912')
    expect(multiplyDecimals(0, 2)).toBe('0.00000000') // escrow.feeCharged ?? 0
  })

  it('never emits exponent notation and keeps a >20-significant-digit product exact', () => {
    expect(multiplyDecimals('0.00000001', '0.00000001')).toBe('0.00000000')
    expect(multiplyDecimals('99999999999999', '99999999')).toBe('9999999899999900000001.00000000')
  })

  it('a pair where the old float formula is wrong at the 8th decimal', () => {
    const a = '67681.28117907'
    const b = '841.04548895'
    const oldFloat = (Number(a) * Number(b)).toFixed(8)
    expect(multiplyDecimals(a, b)).toBe('56923036.22201336')
    expect(oldFloat).toBe('56923036.22201337') // documents the defect being fixed
    expect(multiplyDecimals(a, b)).not.toBe(oldFloat)
  })

  it('matches the BigInt reference for 20,000 pseudo-random price x amount pairs', () => {
    let seed = 20261026
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    const make = (maxWhole: number) =>
      `${Math.floor(rnd() * maxWhole)}.${String(Math.floor(rnd() * 1e8)).padStart(8, '0')}`
    for (let i = 0; i < 20_000; i++) {
      const a = make(150_000)
      const b = make(1_000)
      expect(multiplyDecimals(a, b)).toBe(referenceMultiply(a, b))
    }
  })
})
