/**
 * EntitlementAllocationService — Missão 11 Fase 6.3A economic accounting
 * foundation.
 *
 * Implements the one real, atomic operation this foundation exists for:
 * turning a COLLECTED FeeObligation into a durable, exact, append-only set
 * of recipient entitlements under the currently-live DistributionPolicyVersion
 * (allocate()), and reversing a generation's entitlements when a reorg
 * un-collects the revenue that backed it (reverse()).
 *
 * Deliberately NOT wired into FeeCollectionRecognitionService.recognizeConfirmation()/
 * recordReorgAndRevert() automatically — same precedent as
 * FeeDistributionRepository.addObligationToBatch() (Fase 2.2), which has
 * zero real call sites outside its own tests today: a standalone,
 * explicitly-invokable capability, not auto-wired into the live collection
 * pipeline. Deciding WHEN allocation/reversal actually runs relative to
 * collection recognition is a payout-adjacent orchestration decision,
 * explicitly out of this phase's own "accounting foundation" scope
 * (Missão 11 Fase 6.3A §B's own exclusion list).
 *
 * allocate() runs its reads AND writes inside ONE prisma.$transaction —
 * mirroring FeeDistributionRepository.addObligationToBatch()'s own proven
 * pattern exactly (Fase 2.2): reading the obligation's live collectionStatus
 * and the live PUBLISHED policy INSIDE the same transaction as the write is
 * what closes the TOCTOU race a separate read-then-write sequence would
 * leave open — a concurrent reorg between the read and the write could
 * otherwise allocate against revenue that was reverted a moment earlier.
 */
import { Prisma } from '@prisma/client'
import type { AssetType } from '@prisma/client'
import { prisma } from '../../common/database'
import { EscrowError, NotFoundError } from '../../common/errors'
import { childLogger } from '../../common/logger'


const log = childLogger('entitlement-allocation')
const HUNDRED = new Prisma.Decimal(100)

// Missão 11 Fase 6.3A §A's own precision proof: an entitlement amount
// e_i = C × w_i, where C is always a whole native-unit integer, can never
// need more fractional digits than w_i itself contributes — so converting
// FeeObligation.computedFee (a human-decimal amount, e.g. BTC) to a whole
// native-unit integer (e.g. satoshis) BEFORE multiplying by any weight is
// what makes every downstream entitlement computation exact.
//
// Deliberately NOT reusing wdk-settlement.provider.ts's own toBaseUnits()
// helper, despite it being functionally identical and already exact/
// string-based (no float): that file imports `@tetherto/wdk-wallet-evm`
// (a real, heavy external SDK) at module top level, and importing anything
// from it here would drag that dependency into every test of this
// accounting-only foundation — the exact "unwanted static import
// contamination" class of regression this project's own engineering
// discipline has been burned by before. A ~4-line duplication of pure,
// dependency-free string arithmetic is the correct trade-off here, not a
// shared abstraction.
function toNativeUnits(decimalAmount: string, decimals: number): bigint {
  const [whole, fraction = ''] = decimalAmount.split('.')
  const truncatedFraction = fraction.slice(0, decimals).padEnd(decimals, '0')
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(truncatedFraction || '0')
}

// Native-unit decimal precision per asset — deliberately narrow and
// fail-closed (Phase 6.2.1 §O's own float-finding discipline: never guess).
// Only the asset families real fee collection can produce today (Bitcoin-
// denominated rails, satoshi precision) plus the already-named future USDT
// variants (6-decimal, matching wdk-settlement.provider.ts's own
// USDT_DECIMALS constant) are mapped; anything else throws rather than
// assumes a precision.
export function nativeUnitDecimalsFor(asset: AssetType): number {
  switch (asset) {
    case 'BTC':
    case 'LN_BTC':
    case 'LIQUID_BTC':
    case 'RSK_BTC':
      return 8
    case 'USDT_ERC20':
    case 'USDT_TRC20':
    case 'USDT_LIQUID':
    case 'USDT_LIGHTNING':
      return 6
    default:
      throw new EscrowError(`nativeUnitDecimalsFor: no native-unit decimals mapping defined for asset '${asset}' — refusing to guess.`)
  }
}

export interface AllocatedEntry {
  id: string
  recipientId: string
  amount: string
}

export class EntitlementAllocationService {
  /**
   * Missão 11 Fase 6.3A §G — atomic allocation of a COLLECTED FeeObligation.
   *
   * G11: fails closed unless collectionStatus === 'COLLECTED' (read inside
   *      the transaction, not cached from an earlier call).
   * G12: fails closed unless a real frozen DistributionPolicyVersion
   *      exists for this generation — no implicit Treasury fallback
   *      (Phase 6.2 §D6/D7/D8).
   * G13: the confirmationEvidenceId used is the most recent CONFIRMED
   *      FeeCollectionEvidence row for this obligation — the DB trigger
   *      (entitlement_ledger_entries_confirmed_evidence_guard) independently
   *      re-verifies this is genuinely CONFIRMED before the insert commits.
   * G1-G4: exact Decimal arithmetic throughout; e_i = C × w_i/100; zero
   *      float; zero native-unit rounding; Σe_i = C exactly (proven by
   *      construction — see this method's own final assertion).
   * G5-G7: all entries for one generation are created in this one
   *      transaction; the policy reference and the evidence reference are
   *      both fixed to what this transaction itself resolved, never a
   *      value read outside it.
   * G9/G10: the @@unique([confirmationEvidenceId, recipientId, kind])
   *      constraint on entitlement_ledger_entries makes a retried or
   *      concurrent second attempt for the SAME generation fail at the
   *      database (P2002) — this method surfaces that as a clear,
   *      idempotent-safe EscrowError, never a silent double-write.
   *
   * Missão 11 Fase 7.2 (CTO-frozen decision) — this method NEVER chooses a
   * DistributionPolicyVersion from live PUBLISHED state (no findLivePolicy(),
   * no orderBy publishedAt, no take:1, no latest-wins). Distribution-policy
   * SELECTION belongs exclusively to recognition/COLLECTED time
   * (fee-collection-recognition.service.ts's recognizeConfirmation(),
   * which already froze it onto the CONFIRMED FeeCollectionEvidence row
   * this method reads). allocate() only MATERIALIZES the already-decided
   * economic ownership — reading the frozen reference is the entire
   * "selection" this method performs. Generation identity: the existing
   * "most recent CONFIRMED row for this obligation" query below already
   * disambiguates G1 vs. G2 correctly after a reorg/reconfirmation — a
   * fresh CONFIRMED row IS a new generation with its own independently
   * frozen policy reference, so no separate CollectionGeneration concept
   * is needed (Fase 7.2 §G).
   */
  async allocate(feeObligationId: string): Promise<AllocatedEntry[]> {
    return prisma.$transaction(async (tx) => {
      // Hold the obligation row so no collection-status change (reorg revert, reconfirmation) commits between the
      // checks below and the inserts. NO KEY UPDATE is the lock the status UPDATE takes; FK inserts are not blocked.
      await tx.$queryRaw`SELECT 1 FROM "fee_obligations" WHERE "id" = ${feeObligationId} FOR NO KEY UPDATE`
      const obligation = await tx.feeObligation.findUnique({ where: { id: feeObligationId } })
      if (!obligation) {
        throw new NotFoundError('FeeObligation', feeObligationId)
      }
      if (obligation.collectionStatus !== 'COLLECTED') {
        throw new EscrowError(
          `allocate: FeeObligation ${feeObligationId} is not COLLECTED (currently ${obligation.collectionStatus}) — no allocation without collected revenue (E1).`
        )
      }
      if (obligation.computedFee === null || obligation.asset === null) {
        throw new EscrowError(`allocate: FeeObligation ${feeObligationId} has no computedFee/asset recorded — nothing to allocate.`)
      }

      const policyVersion = await tx.feePolicyVersion.findUnique({ where: { id: obligation.feePolicyVersionId }, select: { railScope: true } })
      if (!policyVersion) {
        throw new EscrowError(`allocate: FeeObligation ${feeObligationId} references a nonexistent FeePolicyVersion ${obligation.feePolicyVersionId} — structurally impossible per the real FK constraint.`)
      }
      const rail = policyVersion.railScope

      const evidenceRows = await tx.feeCollectionEvidence.findMany({
        where: { feeObligationId, kind: 'CONFIRMED' },
        orderBy: { recordedAt: 'desc' },
        take: 1,
      })
      const confirmation = evidenceRows[0]
      if (!confirmation) {
        throw new EscrowError(
          `allocate: FeeObligation ${feeObligationId} is COLLECTED but has no CONFIRMED FeeCollectionEvidence row — structurally impossible per Fase 5's own invariant (COLLECTED only ever results from recognizeConfirmation() recording one); refusing to guess (G13/G14).`
        )
      }

      // One revenue, one live allocation: G9/G10 is per generation, so an earlier generation still allocated
      // (reorg recorded, reverseGeneration() not yet run) must block a new one, or C is entitled twice.
      const earlier = await tx.entitlementLedgerEntry.findFirst({
        where: { feeObligationId, kind: 'ALLOCATION', confirmationEvidenceId: { not: confirmation.id }, reversedBy: { none: {} } },
        select: { confirmationEvidenceId: true },
      })
      if (earlier) {
        throw new EscrowError(
          `allocate: FeeObligation ${feeObligationId}'s earlier generation (confirmationEvidenceId=${earlier.confirmationEvidenceId}) is still allocated — reverse it (reverseGeneration) before allocating generation ${confirmation.id}; refusing to entitle the same revenue twice.`
        )
      }

      // Missão 11 Fase 7.2 §C — a null frozen reference is a real,
      // permanent outcome (zero DistributionPolicyVersion was PUBLISHED
      // at COLLECTED time, today's actual state) — never adopted from
      // whatever happens to be live now. A policy published after
      // confirmation can never retroactively claim this generation's
      // revenue.
      if (confirmation.distributionPolicyVersionId === null) {
        throw new EscrowError(
          `allocate: confirmed generation ${confirmation.id} has no frozen distribution policy (no DistributionPolicyVersion was PUBLISHED at COLLECTED time) — refusing to allocate under a policy chosen after the fact. A policy published later can never retroactively claim this generation's revenue (Fase 7.2 §C).`
        )
      }
      const distributionPolicy = await tx.distributionPolicyVersion.findUnique({
        where: { id: confirmation.distributionPolicyVersionId },
        include: { recipients: true },
      })
      if (!distributionPolicy) {
        throw new EscrowError(
          `allocate: confirmation ${confirmation.id} references a nonexistent DistributionPolicyVersion ${confirmation.distributionPolicyVersionId} — structurally impossible per the real FK constraint.`
        )
      }
      if (distributionPolicy.recipients.length === 0) {
        throw new EscrowError(`allocate: frozen DistributionPolicyVersion ${distributionPolicy.id} has no recipients — structurally impossible if publish() validation ran correctly, refusing to guess.`)
      }

      const decimals = nativeUnitDecimalsFor(obligation.asset)
      const cNative = toNativeUnits(new Prisma.Decimal(obligation.computedFee).toFixed(decimals), decimals)
      const C = new Prisma.Decimal(cNative.toString())

      let weightTotal = new Prisma.Decimal(0)
      const computed: Array<{ recipientId: string; amount: Prisma.Decimal }> = []
      for (const recipientRow of distributionPolicy.recipients) {
        const weight = new Prisma.Decimal(recipientRow.weightPct)
        weightTotal = weightTotal.plus(weight)
        const e = C.times(weight).dividedBy(HUNDRED)
        computed.push({ recipientId: recipientRow.recipientId, amount: e })
      }
      if (!weightTotal.equals(HUNDRED)) {
        // Defense-in-depth: publish() already enforced this; a PUBLISHED
        // policy failing this check here would mean the immutability
        // trigger itself was bypassed, which should be structurally
        // impossible — surfaced loudly rather than silently allocating
        // an inexact split (E4/G4).
        throw new EscrowError(
          `allocate: PUBLISHED DistributionPolicyVersion ${distributionPolicy.id} has weights summing to ${weightTotal.toString()}, not exactly 100 — refusing to allocate an inexact split. This should be structurally impossible; treat as a reconciliation-worthy anomaly.`
        )
      }

      const sumCheck = computed.reduce((acc, entry) => acc.plus(entry.amount), new Prisma.Decimal(0))
      if (!sumCheck.equals(C)) {
        throw new EscrowError(
          `allocate: computed entitlements sum to ${sumCheck.toString()}, not exactly the collected amount ${C.toString()} — refusing to allocate (E4 violated). This should be mathematically impossible given exact Decimal weights summing to exactly 100; treat as a reconciliation-worthy anomaly.`
        )
      }

      const created: AllocatedEntry[] = []
      for (const entry of computed) {
        try {
          const row = await tx.entitlementLedgerEntry.create({
            data: {
              feeObligationId,
              confirmationEvidenceId: confirmation.id,
              distributionPolicyVersionId: distributionPolicy.id,
              recipientId: entry.recipientId,
              asset: obligation.asset,
              rail,
              kind: 'ALLOCATION',
              amount: entry.amount,
            },
          })
          created.push({ id: row.id, recipientId: row.recipientId, amount: row.amount.toString() })
        } catch (err: any) {
          if (err?.code === 'P2002') {
            throw new EscrowError(
              `allocate: FeeObligation ${feeObligationId}'s current collection generation (confirmationEvidenceId=${confirmation.id}) has already been allocated for recipient ${entry.recipientId} — refusing to allocate twice (G9/G10, idempotent retry protection).`
            )
          }
          throw err
        }
      }

      return created
    })
  }

  /**
   * Missão 11 Fase 6.3A §H — compensating reversal of one previously-created
   * ALLOCATION entry. Every field except the (fixed) negated amount and the
   * reversalOfId reference is DERIVED directly from the original entry —
   * structurally eliminating a wrong-obligation/wrong-asset/wrong-rail
   * reversal by construction (H4/H5/H6), never merely checked after the
   * fact.
   */
  async reverseEntry(originalEntryId: string): Promise<AllocatedEntry> {
    return prisma.$transaction(async (tx) => {
      const original = await tx.entitlementLedgerEntry.findUnique({ where: { id: originalEntryId } })
      if (!original) {
        throw new NotFoundError('EntitlementLedgerEntry', originalEntryId)
      }
      if (original.kind !== 'ALLOCATION') {
        throw new EscrowError(`reverseEntry: entry ${originalEntryId} is not an ALLOCATION (kind=${original.kind}) — only an ALLOCATION may be reversed.`)
      }

      try {
        const row = await tx.entitlementLedgerEntry.create({
          data: {
            feeObligationId: original.feeObligationId,
            confirmationEvidenceId: original.confirmationEvidenceId,
            distributionPolicyVersionId: original.distributionPolicyVersionId,
            recipientId: original.recipientId,
            asset: original.asset,
            rail: original.rail,
            kind: 'REVERSAL',
            amount: new Prisma.Decimal(original.amount).negated(),
            reversalOfId: original.id,
          },
        })
        return { id: row.id, recipientId: row.recipientId, amount: row.amount.toString() }
      } catch (err: any) {
        if (err?.code === 'P2002') {
          throw new EscrowError(
            `reverseEntry: entry ${originalEntryId} has already been reversed — refusing to reverse it twice (H7/H8, idempotent retry protection).`
          )
        }
        throw err
      }
    })
  }

  /** Reverses every currently-net-positive ALLOCATION entry for one
   *  collection generation (confirmationEvidenceId) — the real operation a
   *  caller invokes when a reorg un-collects the revenue that generation
   *  represented. Each reversal is independently idempotent (reverseEntry()'s
   *  own P2002 guard). Only entries not yet reversed are attempted, so a
   *  retry after a crash part-way through finishes the remaining entries, and
   *  a fully reversed generation is a no-op (returns []). allocate() refuses
   *  the next generation until every entry here is reversed. */
  async reverseGeneration(confirmationEvidenceId: string): Promise<AllocatedEntry[]> {
    const entries = await prisma.entitlementLedgerEntry.findMany({
      where: { confirmationEvidenceId, kind: 'ALLOCATION', reversedBy: { none: {} } },
    })
    const reversed: AllocatedEntry[] = []
    for (const entry of entries) {
      reversed.push(await this.reverseEntry(entry.id))
    }
    return reversed
  }
}

export const entitlementAllocationService = new EntitlementAllocationService()
