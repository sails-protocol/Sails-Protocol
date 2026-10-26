/**
 * Exact decimal arithmetic for persisted money-like values (#165 follow-up
 * to CSC-E01).
 *
 * `trade.service.ts`, `liquidity.service.ts` and `dispute.service.ts` used to
 * compute stored amounts with JS numbers: `(Number(a) * Number(b)).toFixed(8)`.
 * Two 8-decimal operands multiply to 16 decimals; a double only carries ~15-17
 * significant digits, so once the product is large the last stored digit is
 * wrong (about 1 in 5 random full-precision price x amount pairs differed from
 * the exact result at the 8th decimal). These helpers use `Prisma.Decimal`
 * (arbitrary precision, the type the schema columns already use) and round
 * explicitly, half up.
 */
import { Prisma } from '@prisma/client'

type DecimalInput = string | number | Prisma.Decimal

const DEFAULT_DP = 8

// `Prisma.Decimal` is decimal.js with its default precision of 20 significant
// digits: two 8-decimal operands such as 67681.28117907 x 841.04548895 have a
// 24-digit exact product, so the default would round once at the 20th digit
// and again at `dp` (a double rounding). A private clone with a large
// precision keeps the product exact before the single, explicit rounding.
const ExactDecimal = Prisma.Decimal.clone({ precision: 100 })

/** a x b, rounded half-up to `dp` decimal places, as a plain (non-exponent) decimal string. */
export function multiplyDecimals(a: DecimalInput, b: DecimalInput, dp: number = DEFAULT_DP): string {
  return new ExactDecimal(a.toString()).times(new ExactDecimal(b.toString())).toFixed(dp, Prisma.Decimal.ROUND_HALF_UP)
}
