/**
 * EscrowFeeSnapshotService — Missão 11 Fase 2.2 (foundation) / Fase 4.1
 * (pre-funding waiver + fail-closed snapshot).
 *
 * computeSnapshotFields() is a PURE lookup+computation (one read, no
 * writes): given a rail and a trade notional, it decides — BEFORE any
 * funding has happened — whether a PUBLISHED policy exists for that rail
 * and, if so, whether the maximum possible Protocol Fee (Fmax, sized
 * against the full trade notional, the worst-case release basis) is even
 * economically collectible against the CURRENTLY configured collection
 * destination (Fase 4.1 §1). A seller must never be asked to pre-fund a
 * reserve that is already known, at this moment, to be uncollectible —
 * discovering that only at settlement time (Fase 4's own gap, closed
 * here) left a real class of escrows fundable-but-unreleasable.
 *
 * escrow.service.ts's createEscrow() calls this BEFORE creating the
 * escrow row and folds the result straight into that same INSERT — never
 * a separate best-effort update afterward. This is what makes the whole
 * operation fail-closed by construction (Fase 4.1 §4): if a PUBLISHED
 * policy exists for this rail and anything here throws, the escrow is
 * never created at all — there is no persistence step left to fail
 * independently, and therefore no way for a fee-aware escrow to end up
 * silently downgraded to a legacy (feePolicyVersionId=NULL) one because
 * of a DB hiccup. No active/published policy for the rail is the ONLY
 * case that returns null (normal no-fee behavior, unchanged).
 *
 * snapshotEscrowFeePolicy() (update-based) is kept for direct/isolated
 * testing against an ALREADY-existing escrow row (e.g. proving the
 * DB-native immutability trigger) — createEscrow() itself no longer uses
 * this path.
 */
import { prisma } from '../../common/database'
import { AppError } from '../../common/errors'
import { Prisma, FeePayerModel, FeeEconomicBasis } from '@prisma/client'
import { feePolicyService, FeePolicyService, maxProtocolFeeRate } from './fee-policy.service'
import { computeMaxProtocolFee } from './fee-reserve-math'
import { evaluateFeeCollectibility, networkFor } from './multisig.provider'
import { parseBreakEven, reserveRequired, collectionAddressDust } from './fee-break-even'
import { config } from '../../config'
import { FEE_COLLECTION_CAPABLE_RAILS, assertRailCanActivateFeeCollection } from './escrow-providers'

export interface FeeSnapshotFields {
  feePolicyVersionId: string
  snapshotProtocolFeeRate: Prisma.Decimal
  snapshotPayerModel: FeePayerModel
  snapshotEconomicBasis: FeeEconomicBasis
  snapshotFeeCollectionAddress: string | null
  snapshotFeeCollectionWaivedPreFunding: boolean
}

export class EscrowFeeSnapshotService {
  constructor(private readonly policyService: FeePolicyService = feePolicyService) {}

  /**
   * Returns null (no snapshot at all — legacy behavior, unchanged) only
   * when no PUBLISHED policy exists for `railScope`. Once a policy
   * exists, this ALWAYS returns real fields — never null, never a
   * partially-filled result — so the caller can persist them atomically.
   * Never writes to the database itself.
   */
  async computeSnapshotFields(railScope: string, lockedAmount: Prisma.Decimal | string): Promise<FeeSnapshotFields | null> {
    const policy = await this.policyService.findLivePolicyForRail(railScope)
    if (!policy) return null
    return this.fieldsFor(policy, railScope, lockedAmount)
  }

  /**
   * The snapshot of an escrow bound to a COMMITTED pair: the fee policy the two parties signed, read in the caller's
   * transaction (under the pair lock), never the rail's policy of the moment. A party pays the committed fee, none, or
   * the escrow is refused:
   * - the committed policy is this rail's (and not a DRAFT) => it is frozen, even if retired since the commitment;
   * - it is another rail's while this rail has a live policy => refused (409 FEE_POLICY_NOT_COMMITTED);
   * - it is another rail's and this rail has none => no snapshot (legacy, no fee).
   * Without a pair (only a MOCK escrow in a test database; every other type is refused before this) the legacy live lookup applies.
   */
  async computeCommittedSnapshotFields(
    railScope: string,
    lockedAmount: Prisma.Decimal | string,
    committedPolicyId: string | null,
    tx: Prisma.TransactionClient,
  ): Promise<FeeSnapshotFields | null> {
    if (!committedPolicyId) return this.computeSnapshotFields(railScope, lockedAmount)
    const committed = await tx.feePolicyVersion.findUnique({ where: { id: committedPolicyId } })
    if (committed && committed.railScope === railScope && committed.status !== 'DRAFT') return this.fieldsFor(committed, railScope, lockedAmount)
    const live = await tx.feePolicyVersion.findFirst({ where: { railScope, status: 'PUBLISHED' }, select: { id: true } })
    if (live) throw new AppError(`escrow refused: the committed fee policy is not this rail's (${railScope})`, 409, 'FEE_POLICY_NOT_COMMITTED')
    return null
  }

  private fieldsFor(policy: { id: string; protocolFeeRate: Prisma.Decimal | string; payerModel: FeePayerModel; economicBasis: FeeEconomicBasis; smallTradeRule?: unknown }, railScope: string, lockedAmount: Prisma.Decimal | string): FeeSnapshotFields {
    // The node's ceiling is a safety restriction only: above it the operation is REFUSED; the rate charged is never altered.
    if (new Prisma.Decimal(policy.protocolFeeRate).greaterThan(maxProtocolFeeRate())) {
      throw new AppError(`escrow refused: the committed fee rate is above this node's ceiling`, 409, 'FEE_RATE_ABOVE_CEILING')
    }

    // Missão 11 Fase 5 §10 — defense-in-depth: fee-policy.service.ts's
    // publish() is the real, only application path that can make a policy
    // PUBLISHED, and it already refuses this for a rail with no real
    // fee-aware construction. Reaching a PUBLISHED policy for such a rail
    // HERE would mean that gate was bypassed (e.g. a raw-SQL insert) — a
    // real invariant violation, not a normal runtime condition, so this
    // fails loudly rather than silently snapshotting a phantom obligation
    // (Fase 4.2's own Activation Blocker B).
    assertRailCanActivateFeeCollection(railScope)

    const rate = new Prisma.Decimal(policy.protocolFeeRate)
    let collectionAddress: string | null = null
    let waivedPreFunding = false

    // Missão 11 Fase 4.1 §1/§5 — a genuine zero-rate policy is NOT the
    // pre-funding-waived case (waivedPreFunding stays false; Fmax=0
    // follows from the rate math alone downstream) — the two are recorded
    // separately so accounting can always tell them apart (Fase 4.1 §6),
    // never inferred from Fmax=0 alone.
    if (rate.greaterThan(0) && FEE_COLLECTION_CAPABLE_RAILS.has(railScope)) {
      const fmaxCandidate = computeMaxProtocolFee(lockedAmount, rate)
      const fmaxCandidateSats = Number(fmaxCandidate.times(1e8).toFixed(0))
      const decision = evaluateFeeCollectibility(fmaxCandidateSats)
      // Break-even (CTO 38 §14.1): a reserve only when it covers the payout dust plus the collection output's own cost at
      // the committed cap, and the collection address's dust is within the committed one.
      const breakEven = parseBreakEven(policy.smallTradeRule)
      const breakEvenOk = !breakEven || (reserveRequired(breakEven, fmaxCandidateSats)
        && collectionAddressDust(decision.collectionAddress ?? '', networkFor(config.multisig.network)) <= BigInt(breakEven.collectionDustSats))
      if (decision.collectible && breakEvenOk) {
        collectionAddress = decision.collectionAddress
      } else {
        waivedPreFunding = true
      }
    }

    return {
      feePolicyVersionId: policy.id,
      snapshotProtocolFeeRate: rate,
      snapshotPayerModel: policy.payerModel,
      snapshotEconomicBasis: policy.economicBasis,
      snapshotFeeCollectionAddress: collectionAddress,
      snapshotFeeCollectionWaivedPreFunding: waivedPreFunding,
    }
  }

  /**
   * Update-based variant — writes the computed fields onto an escrow row
   * that already exists. Idempotency note: relies on the migration-level
   * trigger to reject a second write to an already-snapshotted escrow
   * (escrows_fee_snapshot_immutability_guard) — this method does not
   * itself pre-check for an existing snapshot, matching the same
   * "let the database's own constraint be the real guarantee" discipline
   * already used for outpoint double-claim protection (Missão 10).
   */
  async snapshotEscrowFeePolicy(escrowId: string, railScope: string, lockedAmount: Prisma.Decimal | string): Promise<string | null> {
    const fields = await this.computeSnapshotFields(railScope, lockedAmount)
    if (!fields) return null

    await prisma.escrow.update({
      where: { id: escrowId },
      data: fields,
    })

    return fields.feePolicyVersionId
  }
}

export const escrowFeeSnapshotService = new EscrowFeeSnapshotService()
