/**
 * Fee break-even (CTO 38, §14). Parameters live in the committed policy's `smallTradeRule.breakEven`, already inside
 * the FeePolicyV1 digest and frozen by trigger, so they are signed with the pair and never read from the live policy.
 *
 * - Creation: the reserve is required only if Fmax >= dMaxSats + vBytes * fMaxSatPerVb; otherwise the fee is waived
 *   before funding.
 * - Construction: the whole transaction is built at f_eff = min(market, fMaxSatPerVb). The collection output pays its
 *   own marginal vbytes out of the fee (collected = F - cost), so the buyer receives exactly what the same spend without
 *   a fee output would give. Collected only if F - cost >= collectionDustSats; otherwise the reserve returns to the
 *   seller's existing output.
 * A policy without `breakEven` keeps the earlier behavior (there, the fee output's vbytes still come out of the buyer).
 */
import * as bitcoin from 'bitcoinjs-lib'
import { ValidationError, AppError } from '../../common/errors'
import { classifyOutputScript, dustThresholdSats, type OutputScriptKind } from './bitcoin-dust-policy'
import { estimatedVBytesForOutputCount } from './execution-cost-policy'

export const PAYOUT_TYPES = { P2WPKH: { dust: 294, vBytes: 31 }, P2WSH: { dust: 330, vBytes: 43 }, P2TR: { dust: 330, vBytes: 43 } } as const
export type PayoutType = keyof typeof PAYOUT_TYPES

export interface BreakEven {
  fMaxSatPerVb: number
  vBytes: number
  dMaxSats: number
  collectionDustSats: number
  allowedPayoutTypes: PayoutType[]
}

const KEYS = ['fMaxSatPerVb', 'vBytes', 'dMaxSats', 'collectionDustSats', 'allowedPayoutTypes']

function refuse(reason: string): never {
  throw new ValidationError(`smallTradeRule.breakEven: ${reason}`)
}

/** null when the rule has no `breakEven`; otherwise the strictly validated parameters (throws ValidationError). */
export function parseBreakEven(smallTradeRule: unknown): BreakEven | null {
  if (!smallTradeRule || typeof smallTradeRule !== 'object' || !('breakEven' in smallTradeRule)) return null
  const be = (smallTradeRule as Record<string, unknown>).breakEven
  if (!be || typeof be !== 'object' || Array.isArray(be)) refuse('must be an object')
  const o = be as Record<string, unknown>
  const unknownKeys = Object.keys(o).filter((k) => !KEYS.includes(k))
  if (unknownKeys.length) refuse(`unknown keys ${unknownKeys.join(', ')}`)
  for (const k of KEYS.slice(0, 4)) {
    if (!Number.isSafeInteger(o[k]) || (o[k] as number) <= 0) refuse(`${k} must be a positive integer`)
  }
  const types = o.allowedPayoutTypes
  if (!Array.isArray(types) || types.length === 0 || new Set(types).size !== types.length || !types.every((t) => t in PAYOUT_TYPES)) {
    refuse(`allowedPayoutTypes must be a non-empty, duplicate-free subset of ${Object.keys(PAYOUT_TYPES).join(', ')}`)
  }
  const allowed = types as PayoutType[]
  const parsed = { fMaxSatPerVb: o.fMaxSatPerVb, vBytes: o.vBytes, dMaxSats: o.dMaxSats, collectionDustSats: o.collectionDustSats, allowedPayoutTypes: allowed } as BreakEven
  if (parsed.dMaxSats < Math.max(...allowed.map((t) => PAYOUT_TYPES[t].dust))) refuse('dMaxSats is below the dust of an allowed payout type')
  // The construction charges each output at the estimator's own per-output weight, so V must cover it too.
  const perOutput = estimatedVBytesForOutputCount(2) - estimatedVBytesForOutputCount(1)
  if (parsed.vBytes < Math.max(perOutput, ...allowed.map((t) => PAYOUT_TYPES[t].vBytes))) refuse('vBytes is below the size of an output')
  // A plain release collects Fmax - cost >= Fmax - vBytes*fMax >= dMaxSats, so a collection dust above dMaxSats would make
  // the creation rule insufficient for it.
  if (parsed.collectionDustSats > parsed.dMaxSats) refuse('collectionDustSats must not exceed dMaxSats')
  return parsed
}

/** The collection destination's own dust must not exceed the committed collectionDustSats. */
export function assertCollectionDustCovered(be: BreakEven, collectionDustSats: bigint): void {
  if (collectionDustSats > BigInt(be.collectionDustSats)) refuse(`collectionDustSats ${be.collectionDustSats} is below the collection address's dust ${collectionDustSats}`)
}

/** The dust of a collection address; an invalid address counts as uncollectible. */
export function collectionAddressDust(address: string, network: bitcoin.Network): bigint {
  try {
    return dustThresholdSats(Buffer.from(bitcoin.address.toOutputScript(address, network)))
  } catch {
    return BigInt(Number.MAX_SAFE_INTEGER)
  }
}

/** Creation rule (§14.1). */
export function reserveRequired(be: BreakEven, fmaxSats: number): boolean {
  return fmaxSats >= be.dMaxSats + be.vBytes * be.fMaxSatPerVb
}

/** Construction-time fee rate: never above the committed cap. */
export function effectiveFeeRate(be: BreakEven | null | undefined, marketSatPerVb: number): number {
  return be ? Math.min(marketSatPerVb, be.fMaxSatPerVb) : marketSatPerVb
}

/** Escrow creation: a registered payout address of a type outside the committed allowed types is refused. */
export function assertPayoutTypeAllowed(be: BreakEven, address: string, network: bitcoin.Network): void {
  let kind: OutputScriptKind
  try {
    kind = classifyOutputScript(Buffer.from(bitcoin.address.toOutputScript(address, network)))
  } catch {
    kind = 'OTHER'
  }
  if (!(be.allowedPayoutTypes as string[]).includes(kind)) {
    throw new AppError(`escrow refused: a registered payout address is of type ${kind}, outside the committed fee policy's allowed types (${be.allowedPayoutTypes.join(', ')})`, 409, 'PAYOUT_TYPE_NOT_ALLOWED')
  }
}

/** The break-even of the escrow's own fee policy, the committed one (an immutable row); never the rail's live policy. */
export async function committedBreakEven(
  db: { feePolicyVersion: { findUnique(args: { where: { id: string }; select: { smallTradeRule: true } }): PromiseLike<{ smallTradeRule: unknown } | null> } },
  feePolicyVersionId: string | null | undefined,
): Promise<BreakEven | null> {
  if (!feePolicyVersionId) return null
  return parseBreakEven((await db.feePolicyVersion.findUnique({ where: { id: feePolicyVersionId }, select: { smallTradeRule: true } }))?.smallTradeRule)
}
