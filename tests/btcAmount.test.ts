// tests/btcAmount.test.ts
//
// CSC-E01 / #165 — exact BTC decimal -> satoshi conversion. Pure unit tests:
// no network, no database. The two providers that used to run
// `Math.round(parseFloat(x) * 1e8)` now go through btcDecimalToSats().

import { Prisma } from '@prisma/client'
import { btcDecimalToSats } from '../src/modules/open-settlement/btc-amount'
import { EscrowError } from '../src/common/errors'

describe('btcDecimalToSats — exact, fail-closed (CSC-E01)', () => {
  describe('exact values', () => {
    it.each([
      ['0', 0],
      ['0.00000001', 1],
      ['0.00000041', 41],
      ['0.001', 100_000],
      ['0.1', 10_000_000],
      ['0.29', 29_000_000],
      ['1', 100_000_000],
      ['1.005', 100_500_000],
      ['21000000', 2_100_000_000_000_000],
      ['20999999.99999999', 2_099_999_999_999_999],
      ['10000000.00000001', 1_000_000_000_000_001],
    ])('%s BTC = %d sats', (btc, sats) => {
      expect(btcDecimalToSats(btc)).toBe(sats)
    })

    it('accepts the same amount in other textual forms', () => {
      expect(btcDecimalToSats('0.10000000')).toBe(10_000_000)
      expect(btcDecimalToSats('0.1000000000')).toBe(10_000_000) // trailing zeros past dp 8
      expect(btcDecimalToSats(' 0.5 ')).toBe(50_000_000)
      // Decimal#toString() emits exponent notation for small values.
      expect(new Prisma.Decimal('0.0000001').toString()).toBe('1e-7')
      expect(btcDecimalToSats(new Prisma.Decimal('0.0000001').toString())).toBe(10)
      expect(btcDecimalToSats(new Prisma.Decimal('0.0000001'))).toBe(10)
    })

    it('matches an independent BigInt reference for 20,000 pseudo-random 8-dp amounts up to the 21M BTC cap', () => {
      let seed = 987654321
      const rnd = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648
        return seed / 2147483648
      }
      for (let i = 0; i < 20_000; i++) {
        const whole = Math.floor(rnd() * 21_000_000)
        const frac = Math.floor(rnd() * 1e8)
        const text = `${whole}.${String(frac).padStart(8, '0')}`
        const reference = BigInt(whole) * 100_000_000n + BigInt(frac)
        expect(BigInt(btcDecimalToSats(text))).toBe(reference)
      }
    })
  })

  describe('fails closed — the old float formula did not', () => {
    // Old behavior for context (Math.round(parseFloat(x) * 1e8)):
    //   '-0.001'      ->  -100000   (any UTXO satisfied `value >= expected`)
    //   '0.000000004' ->  0         (a zero-sat requirement is trivially met)
    //   'abc' / ''    ->  NaN       (comparisons silently false)
    //   '1e400'       ->  Infinity
    it.each([
      ['a negative amount', '-0.001'],
      ['a fractional satoshi', '0.000000004'],
      ['a fractional satoshi at large magnitude', '20999999.999999999'],
      ['not a number', 'abc'],
      ['an empty string', ''],
      ['whitespace only', '   '],
      ['NaN', 'NaN'],
      ['Infinity', 'Infinity'],
      ['an astronomically large exponent', '1e400'],
      ['more satoshis than a safe integer holds', '90071993'], // 9.0071993e15 sats > MAX_SAFE_INTEGER
    ])('rejects %s', (_label, input) => {
      expect(() => btcDecimalToSats(input)).toThrow(EscrowError)
    })

    it('refuses a sub-satoshi tail that 20-digit Decimal arithmetic would otherwise swallow', () => {
      // 0.12345678000000000000001 x 1e8 evaluates to the integer 12345678 at
      // Decimal's default 20-significant-digit precision.
      expect(new Prisma.Decimal('0.12345678000000000000001').times(100_000_000).isInteger()).toBe(true)
      expect(() => btcDecimalToSats('0.12345678000000000000001')).toThrow(/fractional satoshi/)
      expect(() => btcDecimalToSats('0.00000000000000000000001')).toThrow(/fractional satoshi/)
      expect(btcDecimalToSats('0.12345678000000000000000')).toBe(12_345_678) // trailing zeros only: same amount
    })

    it('never rounds: 0.000000005 BTC is half a satoshi and is refused, not rounded to 1', () => {
      expect(() => btcDecimalToSats('0.000000005')).toThrow(/fractional satoshi/)
    })

    it('rejects a negative or non-finite Prisma.Decimal as well', () => {
      expect(() => btcDecimalToSats(new Prisma.Decimal(-1))).toThrow(EscrowError)
      expect(() => btcDecimalToSats(new Prisma.Decimal('Infinity'))).toThrow(EscrowError)
      expect(() => btcDecimalToSats(new Prisma.Decimal('0.000000001'))).toThrow(/fractional satoshi/)
    })

    it('the largest accepted value is a safe integer; one satoshi past MAX_SAFE_INTEGER is refused', () => {
      const maxSafeBtc = new Prisma.Decimal(Number.MAX_SAFE_INTEGER).dividedBy(100_000_000)
      expect(btcDecimalToSats(maxSafeBtc)).toBe(Number.MAX_SAFE_INTEGER)
      const justOver = new Prisma.Decimal(Number.MAX_SAFE_INTEGER).plus(1).dividedBy(100_000_000)
      expect(() => btcDecimalToSats(justOver)).toThrow(/safe integer/)
    })
  })

  describe('same helper, Decimal inputs from the fee math (multisig.provider decimalBtcToSats)', () => {
    it('an 8-dp floored fee Decimal converts exactly', () => {
      // 0.40% of 0.12345678 BTC floored to 8 dp = 0.00049382 -> 49382 sats
      expect(btcDecimalToSats(new Prisma.Decimal('0.00049382'))).toBe(49_382)
    })
  })
})
