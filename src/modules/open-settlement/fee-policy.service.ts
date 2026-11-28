/**
 * FeePolicyService — Missão 11 Fase 2.2 economic accounting foundation.
 *
 * STRUCTURAL FOUNDATION ONLY. This service does not choose, and must never
 * be read as recommending, any real economic parameter — every rate,
 * ceiling, and bucket split passed to createDraft()/publish() in this
 * codebase's own tests is an explicitly-labeled fixture. It does not wire
 * into any real settlement flow and does not activate fee collection.
 * RFC-021 Phase 0's chargeProtocolFee()/PROTOCOL_FEE_RATE mechanism was
 * retired in Missão 11 Fase 6.5.2 — this policy's own downstream
 * (FeeObligation -> a frozen DistributionPolicyVersion ->
 * EntitlementLedgerEntry) is now the sole future economic authority,
 * still not activated by this file either.
 *
 * Validation split (Fase 2.1 §4 / Fase 2.2 §4), enforced here:
 *   STRUCTURAL (this file):    rate >= 0; a FeeObligation may only ever
 *                              snapshot a PUBLISHED policy, never a DRAFT
 *                              one.
 *   GOVERNANCE (NOT this file, NOT this phase): the actual rate value, any
 *                              commercial rate ceiling, small-trade
 *                              threshold numbers, confirmation-depth N.
 *                              None of these are chosen or bounded here —
 *                              a caller may pass any structurally-valid
 *                              value.
 *
 * Missão 11 Fase 7.2 (CTO decision, §I) — the four legacy bucket-percentage
 * columns (nodeOperatorPct/treasuryPct/walletRebatePct/arbitratorReservePct)
 * are remnants of the retired Mechanism 2 distribution architecture (Fase
 * 6.5.2) and are no longer normative inputs for fee-policy publication —
 * publish() no longer validates them at all. DistributionPolicyVersion
 * alone determines revenue allocation now (FeePolicyVersion = charging
 * economics; DistributionPolicyVersion = allocation economics). Historical
 * rows retain their original values, unchanged and fully readable.
 *
 * publish() is the ONLY place that performs structural validation — a
 * DRAFT's economic fields can be anything (including nonsensical values)
 * right up until the moment publish() is called, at which point it becomes
 * permanently locked in via the repository's narrow surface + the
 * database's own BEFORE UPDATE trigger (see fee-policy-repository.ts's own
 * header and the migration file).
 */
import { Prisma } from '@prisma/client'
import { ValidationError, EconomicAuthorityAmbiguityError } from '../../common/errors'
import {
  feePolicyVersionRepository,
  type FeePolicyVersionRepository,
  type CreateDraftFeePolicyVersionData,
} from './fee-policy-repository'
import { assertRailCanActivateFeeCollection } from './escrow-providers'
import { networkFor } from './multisig.provider'
import { config } from '../../config'
import { parseBreakEven, assertCollectionDustCovered, collectionAddressDust } from './fee-break-even'

// The protocol fee ceiling (CTO 38, D-E6). PROPOSED value, pending governance: 0.50%, 1.25x the 0.40% reference, until
// the signed global policy carries it. A node's SAILS_MAX_PROTOCOL_FEE_RATE can only TIGHTEN it, never widen it, so local
// configuration never allows more than the protocol does. A rate above the effective ceiling is never accepted.
export const PROTOCOL_MAX_FEE_RATE = '0.005'
export function maxProtocolFeeRate(): string {
  const local = config.settlement?.maxProtocolFeeRate
  return local && new Prisma.Decimal(local).lessThan(PROTOCOL_MAX_FEE_RATE) ? local : PROTOCOL_MAX_FEE_RATE
}

// CTO 413 (P1) — structural checks plus the ceiling above. DECIMAL(24,8) would store NaN
// (and order it above every number) and round a 9th decimal place silently, so both are refused, never coerced.
function assertValidProtocolFeeRate(value: Prisma.Decimal | string): void {
  let rate: Prisma.Decimal
  try {
    rate = new Prisma.Decimal(value)
  } catch {
    throw new ValidationError('protocolFeeRate is not a decimal number', { protocolFeeRate: String(value) })
  }
  if (!rate.isFinite()) {
    throw new ValidationError('protocolFeeRate must be finite (NaN and Infinity are refused)', { protocolFeeRate: rate.toString() })
  }
  if (rate.isNegative()) {
    throw new ValidationError('protocolFeeRate must be >= 0', { protocolFeeRate: rate.toString() })
  }
  const ceiling = maxProtocolFeeRate()
  if (rate.greaterThan(ceiling)) {
    throw new ValidationError(`protocolFeeRate must be <= ${ceiling}`, { protocolFeeRate: rate.toString() })
  }
  if (rate.decimalPlaces() > 8) {
    throw new ValidationError('protocolFeeRate must have at most 8 decimal places (it is never rounded)', { protocolFeeRate: rate.toString() })
  }
}

export class FeePolicyService {
  constructor(private readonly repo: FeePolicyVersionRepository = feePolicyVersionRepository) {}

  async createDraft(input: CreateDraftFeePolicyVersionData) {
    assertValidProtocolFeeRate(input.protocolFeeRate)
    const breakEven = parseBreakEven(input.smallTradeRule)
    const collection = config.settlement?.protocolFeeCollectionAddress
    if (breakEven && collection) assertCollectionDustCovered(breakEven, collectionAddressDust(collection, networkFor(config.multisig.network)))
    return this.repo.create(input)
  }

  /**
   * Structural validation only (see this file's own header for the exact
   * boundary). Throws ValidationError, never silently clamps or rounds a
   * caller-supplied value — a policy that fails validation must be
   * corrected and re-submitted as a new/edited DRAFT, never "fixed up" on
   * publish.
   */
  async publish(id: string) {
    const policy = await this.repo.findById(id)
    if (!policy) {
      throw new ValidationError(`FeePolicyVersion not found: ${id}`)
    }
    if (policy.status !== 'DRAFT') {
      throw new ValidationError(
        `FeePolicyVersion ${id} cannot be published from status ${policy.status} — only a DRAFT policy may be published.`
      )
    }

    assertValidProtocolFeeRate(policy.protocolFeeRate)

    // Missão 11 Fase 5 §3 — structural validation only, same discipline as
    // the percentage-sum check above: a real confirmation depth is never
    // chosen here, but publish() refuses to activate a policy with no
    // depth (or a non-positive one) set at all. Fixture values (1, 2) are
    // exactly what this codebase's own tests use — this only rejects the
    // absence of a real decision, never picks one.
    if (policy.requiredConfirmations === null || policy.requiredConfirmations === undefined || policy.requiredConfirmations <= 0) {
      throw new ValidationError(
        'requiredConfirmations must be a positive integer before a policy can be published — the collection-recognition job has no confirmation-depth rule to apply otherwise',
        { requiredConfirmations: String(policy.requiredConfirmations) }
      )
    }

    // Missão 11 Fase 5 §10 — the real activation gate (Fase 4.2 Activation
    // Blocker B): a rail with no real, atomic fee-aware construction must
    // never have a policy go live, regardless of how structurally valid
    // its rate/bucket-split/confirmation-depth fields are.
    assertRailCanActivateFeeCollection(policy.railScope)

    return this.repo.publish(id)
  }

  async retire(id: string) {
    const policy = await this.repo.findById(id)
    if (!policy) {
      throw new ValidationError(`FeePolicyVersion not found: ${id}`)
    }
    if (policy.status !== 'PUBLISHED') {
      throw new ValidationError(
        `FeePolicyVersion ${id} cannot be retired from status ${policy.status} — only a PUBLISHED policy may be retired.`
      )
    }
    return this.repo.retire(id)
  }

  /** The one currently-live policy for a rail, or null if none is
   *  published — callers must treat null exactly like "no policy exists"
   *  (Fase 2.2 §5: no hidden default policy, ever).
   *
   *  Missão 11 Fase 7.1A/7.2 (CTO Decision B) — "order by publishedAt desc
   *  and silently take the first row" is not acceptable: policy ambiguity
   *  must fail closed, never resolve itself by picking a winner. This
   *  should be structurally impossible post-exclusivity-migration
   *  (fee_policy_versions_single_published_per_rail_key) — the >1 branch
   *  here is defense-in-depth for a legacy/corrupt/raw-SQL-bypass state,
   *  not an expected runtime path. */
  async findLivePolicyForRail(railScope: string) {
    const published = await this.repo.findPublishedForRail(railScope)
    if (published.length === 0) return null
    if (published.length === 1) return published[0]
    throw new EconomicAuthorityAmbiguityError(
      `${published.length} FeePolicyVersion rows are simultaneously PUBLISHED for railScope '${railScope}' — refusing to silently pick one. This should be structurally impossible under the DB-native exclusivity guard; treat as a reconciliation-worthy anomaly.`,
      { railScope, publishedIds: published.map((p) => p.id) }
    )
  }

  /** Structural guard used by escrow-fee-snapshot.service.ts (Fase 2.2 §4's
   *  "a FeeObligation/snapshot may only reference a PUBLISHED policy, never
   *  a DRAFT one" rule) — throws rather than silently refusing, since a
   *  caller reaching this with a non-PUBLISHED id is a programming error,
   *  not a normal/expected runtime condition (unlike findLivePolicyForRail's
   *  null-is-expected contract above). */
  async assertPublished(id: string) {
    const policy = await this.repo.findById(id)
    if (!policy || policy.status !== 'PUBLISHED') {
      throw new ValidationError(`FeePolicyVersion ${id} is not PUBLISHED — cannot be snapshotted.`)
    }
    return policy
  }
}

export const feePolicyService = new FeePolicyService()
