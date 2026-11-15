/**
 * DistributionReconciliation — Missão 11 Fase 6.3A §M.
 *
 * Detect-don't-fix, mirroring fee-obligation-reconciliation.ts's own
 * established discipline exactly (Fase 3 §5): every function below only
 * ever reads and reports an economically-impossible-or-suspicious state —
 * none of them writes, corrects, or "heals" anything. A real anomaly here
 * is a signal for manual, CTO-level review, never an input to an automatic
 * repair path (Fase 5 §8's own "detect and surface as an exceptional
 * condition, never improvise financial reversal" principle, applied to the
 * distribution layer).
 */
import { prisma } from '../../common/database'
import { Prisma } from '@prisma/client'

export interface CollectedNotAllocatedRow {
  feeObligationId: string
  confirmationEvidenceId: string
}

/** (1) A COLLECTED obligation with a real CONFIRMED evidence row and a real
 *  PUBLISHED distribution policy, but no ALLOCATION entries at all yet —
 *  not itself an error (allocation is a separate, explicitly-invoked step,
 *  §B's own deliberate decoupling), but a real operational backlog signal
 *  worth surfacing. */
export async function findCollectedNotYetAllocated(): Promise<CollectedNotAllocatedRow[]> {
  const anyPublishedPolicy = await prisma.distributionPolicyVersion.findFirst({ where: { status: 'PUBLISHED' } })
  if (!anyPublishedPolicy) return []

  const collected = await prisma.feeObligation.findMany({
    where: { collectionStatus: 'COLLECTED' },
    select: { id: true },
  })
  const rows: CollectedNotAllocatedRow[] = []
  for (const obligation of collected) {
    const confirmed = await prisma.feeCollectionEvidence.findFirst({
      where: { feeObligationId: obligation.id, kind: 'CONFIRMED' },
      orderBy: [{ recordedAt: 'desc' }, { seq: 'desc' }],
    })
    if (!confirmed) continue
    const hasAllocation = await prisma.entitlementLedgerEntry.findFirst({
      where: { confirmationEvidenceId: confirmed.id, kind: 'ALLOCATION' },
    })
    if (!hasAllocation) rows.push({ feeObligationId: obligation.id, confirmationEvidenceId: confirmed.id })
  }
  return rows
}

export interface AllocationForNonCollectedRow {
  feeObligationId: string
  currentCollectionStatus: string | null
  entryId: string
}

/** (2) An ALLOCATION entry exists for an obligation that is NOT currently
 *  COLLECTED. Legitimate immediately after a reorg (the obligation moved to
 *  IN_PROGRESS but the entry hasn't been reversed yet) — flagged here so
 *  that window is visible/auditable, not itself proof of a bug; a
 *  persistent, never-reversed instance IS a real anomaly. */
export async function findAllocationsForNonCollectedObligation(): Promise<AllocationForNonCollectedRow[]> {
  const entries = await prisma.entitlementLedgerEntry.findMany({
    where: { kind: 'ALLOCATION' },
    select: { id: true, feeObligationId: true, confirmationEvidenceId: true },
  })
  const rows: AllocationForNonCollectedRow[] = []
  for (const entry of entries) {
    const obligation = await prisma.feeObligation.findUnique({ where: { id: entry.feeObligationId }, select: { collectionStatus: true } })
    if (!obligation || obligation.collectionStatus === 'COLLECTED' || obligation.collectionStatus === 'DISTRIBUTED') continue
    // A reversed generation is expected/healthy — only flag if this
    // specific generation has NOT been reversed at all.
    const anyReversalForGeneration = await prisma.entitlementLedgerEntry.findFirst({
      where: { confirmationEvidenceId: entry.confirmationEvidenceId, kind: 'REVERSAL' },
    })
    if (!anyReversalForGeneration) {
      rows.push({ feeObligationId: entry.feeObligationId, currentCollectionStatus: obligation.collectionStatus, entryId: entry.id })
    }
  }
  return rows
}

export interface GenerationSumMismatchRow {
  confirmationEvidenceId: string
  feeObligationId: string
  netAllocated: string
  collectedAmountNative: string
}

/** (3) For each allocation generation, the NET (allocation - its own
 *  reversal, if any) sum across recipients must equal EXACTLY the
 *  collected amount for that obligation, in native units — or exactly
 *  zero if the generation has been fully reversed. Any other value is a
 *  genuine conservation violation (E4). */
export async function findGenerationSumMismatches(): Promise<GenerationSumMismatchRow[]> {
  const generations = await prisma.entitlementLedgerEntry.groupBy({
    by: ['confirmationEvidenceId', 'feeObligationId'],
    where: { kind: 'ALLOCATION' },
  })
  const rows: GenerationSumMismatchRow[] = []
  for (const gen of generations) {
    const entries = await prisma.entitlementLedgerEntry.findMany({
      where: { confirmationEvidenceId: gen.confirmationEvidenceId },
    })
    const net = entries.reduce((acc, e) => acc.plus(e.amount), new Prisma.Decimal(0))

    const obligation = await prisma.feeObligation.findUnique({ where: { id: gen.feeObligationId } })
    if (!obligation || obligation.computedFee === null || obligation.asset === null) continue

    const fullyReversed = entries.filter((e) => e.kind === 'ALLOCATION').every((alloc) =>
      entries.some((rev) => rev.kind === 'REVERSAL' && rev.reversalOfId === alloc.id)
    )
    if (fullyReversed) {
      if (!net.isZero()) {
        rows.push({ confirmationEvidenceId: gen.confirmationEvidenceId, feeObligationId: gen.feeObligationId, netAllocated: net.toString(), collectedAmountNative: 'N/A (fully reversed, expected 0)' })
      }
      continue
    }

    // Not (yet) fully reversed — net should equal the full collected
    // amount converted to native units. Re-derive the same conversion
    // allocate() itself uses, purely for comparison (never re-decided).
    const decimalsMap: Record<string, number> = { BTC: 8, LN_BTC: 8, LIQUID_BTC: 8, RSK_BTC: 8, USDT_ERC20: 6, USDT_TRC20: 6, USDT_LIQUID: 6, USDT_LIGHTNING: 6 }
    const decimals = decimalsMap[obligation.asset]
    if (decimals === undefined) continue
    const fixed = new Prisma.Decimal(obligation.computedFee).toFixed(decimals)
    const [whole, fraction = ''] = fixed.split('.')
    const nativeStr = (whole === '0' ? '' : whole) + fraction.padEnd(decimals, '0')
    const expected = new Prisma.Decimal(nativeStr === '' ? '0' : nativeStr)

    if (!net.equals(expected)) {
      rows.push({ confirmationEvidenceId: gen.confirmationEvidenceId, feeObligationId: gen.feeObligationId, netAllocated: net.toString(), collectedAmountNative: expected.toString() })
    }
  }
  return rows
}

export interface WrongEvidencePairingRow {
  entryId: string
  confirmationEvidenceId: string
  reason: string
}

/** (5) An entry whose confirmationEvidenceId does not belong to the same
 *  feeObligationId the entry itself claims — should be structurally
 *  impossible (the service always derives both from the SAME read), but
 *  detected independently rather than assumed. */
export async function findWrongEvidencePairing(): Promise<WrongEvidencePairingRow[]> {
  const entries = await prisma.entitlementLedgerEntry.findMany({ select: { id: true, feeObligationId: true, confirmationEvidenceId: true } })
  const rows: WrongEvidencePairingRow[] = []
  for (const entry of entries) {
    const evidence = await prisma.feeCollectionEvidence.findUnique({ where: { id: entry.confirmationEvidenceId } })
    if (!evidence) {
      rows.push({ entryId: entry.id, confirmationEvidenceId: entry.confirmationEvidenceId, reason: 'evidence row does not exist' })
    } else if (evidence.feeObligationId !== entry.feeObligationId) {
      rows.push({ entryId: entry.id, confirmationEvidenceId: entry.confirmationEvidenceId, reason: `evidence belongs to feeObligationId=${evidence.feeObligationId}, entry claims ${entry.feeObligationId}` })
    } else if (evidence.kind !== 'CONFIRMED') {
      rows.push({ entryId: entry.id, confirmationEvidenceId: entry.confirmationEvidenceId, reason: `evidence kind is ${evidence.kind}, not CONFIRMED` })
    }
  }
  return rows
}

export interface ReorgedGenerationNotReversedRow {
  confirmationEvidenceId: string
  feeObligationId: string
  txid: string | null
}

/** (7) A generation's CONFIRMED evidence has a corresponding REORGED_OUT
 *  evidence row (same feeObligationId, same txid) recorded AFTER it, but
 *  the generation's ALLOCATION entries have not been reversed — a real,
 *  actionable gap (the reorg was detected at the collection layer but
 *  reverseGeneration() was never called for it). */
export async function findReorgedGenerationsNotReversed(): Promise<ReorgedGenerationNotReversedRow[]> {
  const confirmedRows = await prisma.feeCollectionEvidence.findMany({ where: { kind: 'CONFIRMED' } })
  const rows: ReorgedGenerationNotReversedRow[] = []
  for (const confirmed of confirmedRows) {
    const reorgedOut = await prisma.feeCollectionEvidence.findFirst({
      where: { feeObligationId: confirmed.feeObligationId, kind: 'REORGED_OUT', txid: confirmed.txid,
        OR: [{ recordedAt: { gt: confirmed.recordedAt } }, { recordedAt: confirmed.recordedAt, seq: { gt: confirmed.seq } }] },
    })
    if (!reorgedOut) continue
    const allocations = await prisma.entitlementLedgerEntry.findMany({ where: { confirmationEvidenceId: confirmed.id, kind: 'ALLOCATION' } })
    if (allocations.length === 0) continue
    const anyUnreversed = await Promise.all(
      allocations.map(async (alloc) => {
        const reversal = await prisma.entitlementLedgerEntry.findFirst({ where: { reversalOfId: alloc.id } })
        return !reversal
      })
    )
    if (anyUnreversed.some(Boolean)) {
      rows.push({ confirmationEvidenceId: confirmed.id, feeObligationId: confirmed.feeObligationId, txid: confirmed.txid })
    }
  }
  return rows
}

export interface OverReversalRow {
  reversalEntryId: string
  originalEntryId: string
  reason: string
}

/** (8) A REVERSAL entry whose magnitude does not exactly equal its
 *  original ALLOCATION entry's magnitude — should be structurally
 *  impossible (reverseEntry() always negates the exact original amount),
 *  detected independently. */
export async function findOverReversals(): Promise<OverReversalRow[]> {
  const reversals = await prisma.entitlementLedgerEntry.findMany({ where: { kind: 'REVERSAL' } })
  const rows: OverReversalRow[] = []
  for (const reversal of reversals) {
    if (!reversal.reversalOfId) {
      rows.push({ reversalEntryId: reversal.id, originalEntryId: 'none', reason: 'REVERSAL entry has no reversalOfId' })
      continue
    }
    const original = await prisma.entitlementLedgerEntry.findUnique({ where: { id: reversal.reversalOfId } })
    if (!original) {
      rows.push({ reversalEntryId: reversal.id, originalEntryId: reversal.reversalOfId, reason: 'referenced original entry does not exist' })
      continue
    }
    if (original.kind !== 'ALLOCATION') {
      rows.push({ reversalEntryId: reversal.id, originalEntryId: original.id, reason: `referenced entry is not an ALLOCATION (kind=${original.kind})` })
      continue
    }
    const expectedMagnitude = new Prisma.Decimal(original.amount).negated()
    if (!new Prisma.Decimal(reversal.amount).equals(expectedMagnitude)) {
      rows.push({ reversalEntryId: reversal.id, originalEntryId: original.id, reason: `reversal amount ${reversal.amount.toString()} does not exactly negate original amount ${original.amount.toString()}` })
    }
    if (
      reversal.feeObligationId !== original.feeObligationId ||
      reversal.asset !== original.asset ||
      reversal.rail !== original.rail ||
      reversal.recipientId !== original.recipientId
    ) {
      rows.push({ reversalEntryId: reversal.id, originalEntryId: original.id, reason: 'reversal does not match original obligation/asset/rail/recipient (cross-contamination)' })
    }
  }
  return rows
}

export interface PolicyWeightSumMismatchRow {
  policyVersionId: string
  status: string
  totalWeightPct: string
}

/** (11) A PUBLISHED (or RETIRED — retirement never un-freezes economics)
 *  policy whose recipient weights do not sum to exactly 100 — should be
 *  structurally impossible given publish()'s own validation plus the
 *  immutability trigger, detected independently as defense-in-depth. */
export async function findPolicyWeightSumMismatches(): Promise<PolicyWeightSumMismatchRow[]> {
  const policies = await prisma.distributionPolicyVersion.findMany({
    where: { status: { in: ['PUBLISHED', 'RETIRED'] } },
    include: { recipients: true },
  })
  const rows: PolicyWeightSumMismatchRow[] = []
  for (const policy of policies) {
    const total = policy.recipients.reduce((acc, r) => acc.plus(r.weightPct), new Prisma.Decimal(0))
    if (!total.equals(new Prisma.Decimal(100))) {
      rows.push({ policyVersionId: policy.id, status: policy.status, totalWeightPct: total.toString() })
    }
  }
  return rows
}

export interface AssetRailMismatchRow {
  entryId: string
  reason: string
}

/** (10) An entry's own asset/rail does not match its FeeObligation's asset
 *  or its FeePolicyVersion's railScope — should be structurally impossible
 *  (allocate() always derives both from the obligation/policy it just
 *  read, never from independent caller input; reverseEntry() always
 *  copies both from the original entry it reverses), detected
 *  independently as defense-in-depth against a direct, out-of-application
 *  write. */
export async function findAssetRailMismatches(): Promise<AssetRailMismatchRow[]> {
  const entries = await prisma.entitlementLedgerEntry.findMany()
  const rows: AssetRailMismatchRow[] = []
  for (const entry of entries) {
    const obligation = await prisma.feeObligation.findUnique({ where: { id: entry.feeObligationId } })
    if (!obligation) continue
    if (obligation.asset !== null && obligation.asset !== entry.asset) {
      rows.push({ entryId: entry.id, reason: `entry.asset=${entry.asset} does not match its own FeeObligation.asset=${obligation.asset}` })
    }
    const policyVersion = await prisma.feePolicyVersion.findUnique({ where: { id: obligation.feePolicyVersionId } })
    if (policyVersion && policyVersion.railScope !== entry.rail) {
      rows.push({ entryId: entry.id, reason: `entry.rail=${entry.rail} does not match its own FeePolicyVersion.railScope=${policyVersion.railScope}` })
    }
    if (entry.kind === 'REVERSAL' && entry.reversalOfId) {
      const original = await prisma.entitlementLedgerEntry.findUnique({ where: { id: entry.reversalOfId } })
      if (original && (original.asset !== entry.asset || original.rail !== entry.rail)) {
        rows.push({ entryId: entry.id, reason: `reversal asset/rail (${entry.asset}/${entry.rail}) does not match the original entry it reverses (${original.asset}/${original.rail})` })
      }
    }
  }
  return rows
}

export interface NegativeRecipientBalanceRow {
  recipientId: string
  asset: string
  rail: string
  balance: string
}

/** (13) A recipient's net balance for any (asset, rail) is negative —
 *  should be structurally impossible (a REVERSAL can never exceed its own
 *  ALLOCATION's magnitude, per findOverReversals() above, and no other
 *  write path can subtract from a balance in this foundation — no payout
 *  exists yet). Detected independently as the final, cheapest defense-in-
 *  depth check. */
export async function findNegativeRecipientBalances(): Promise<NegativeRecipientBalanceRow[]> {
  const grouped = await prisma.entitlementLedgerEntry.groupBy({
    by: ['recipientId', 'asset', 'rail'],
    _sum: { amount: true },
  })
  return grouped
    .filter((g) => (g._sum.amount ?? new Prisma.Decimal(0)).isNegative())
    .map((g) => ({ recipientId: g.recipientId, asset: g.asset, rail: g.rail, balance: (g._sum.amount ?? new Prisma.Decimal(0)).toString() }))
}

// (14) reorg-after-payout — NOT representable with the current schema:
// no payout concept exists yet in this foundation (Missão 11 Fase 6.3A §B's
// own explicit exclusion). Documented here, per the mandate's own
// instruction, as a future reconciliation requirement: once a payout
// record exists, a reconciliation query must detect "a REORGED_OUT
// evidence row recorded for a generation that already has an associated
// payout record" and surface it as an exceptional, manually-reviewed
// condition — mirroring recordReorgAndRevert()'s own existing refusal to
// auto-revert an already-DISTRIBUTED FeeObligation.
