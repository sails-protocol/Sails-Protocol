/**
 * Exact BTC decimal -> satoshi conversion (CSC-E01, #165).
 *
 * `multisig.provider.ts` and `lightning-hodl.provider.ts` used to convert a
 * stored `lockedAmount` with `Math.round(parseFloat(x) * 1e8)`. That is a
 * binary-float multiplication: it is only right while the product stays
 * inside the 53-bit mantissa's exact range, and it silently rounds a
 * sub-satoshi remainder instead of refusing it. The funding check and the
 * required-funding (T + Fmax) arithmetic compare these values against
 * on-chain UTXO sats, so they must be exact integers.
 *
 * This module does the conversion with arbitrary-precision decimal
 * arithmetic (the same `Prisma.Decimal` the fee math in `fee-reserve-math.ts`
 * already uses) and fails closed:
 *  - not a finite, non-negative decimal      -> throws
 *  - a fractional satoshi (more than 8 dp)   -> throws, never rounds
 *  - more sats than a JS safe integer holds  -> throws
 * Trailing zeros beyond the 8th decimal place ("0.1000000000") and
 * exponent notation ("1e-7", which `Decimal#toString()` emits for small
 * values) are the same amounts and are accepted.
 *
 * The return type stays `number` on purpose: every caller compares against
 * UTXO `value` fields, which are numbers, and the 21M BTC supply cap
 * (2.1e15 sats) is far below `Number.MAX_SAFE_INTEGER` (9.007e15).
 */
import { Prisma } from '@prisma/client'
import { EscrowError } from '../../common/errors'

const SATS_PER_BTC = new Prisma.Decimal(100_000_000)
const MAX_SAFE_SATS = new Prisma.Decimal(Number.MAX_SAFE_INTEGER)

export function btcDecimalToSats(amount: string | Prisma.Decimal): number {
  let decimal: Prisma.Decimal
  try {
    decimal = typeof amount === 'string' ? new Prisma.Decimal(amount.trim()) : amount
  } catch {
    throw new EscrowError(`Invalid BTC amount ${JSON.stringify(String(amount))}: not a decimal number`)
  }
  if (!decimal.isFinite() || decimal.isNegative()) {
    throw new EscrowError(`Invalid BTC amount ${decimal.toString()}: must be a finite, non-negative decimal`)
  }
  const sats = decimal.times(SATS_PER_BTC)
  if (!sats.isInteger()) {
    throw new EscrowError(`Invalid BTC amount ${decimal.toString()}: has a fractional satoshi (more than 8 decimal places)`)
  }
  if (sats.greaterThan(MAX_SAFE_SATS)) {
    throw new EscrowError(`Invalid BTC amount ${decimal.toString()}: exceeds the safe integer range in satoshis`)
  }
  return sats.toNumber()
}
