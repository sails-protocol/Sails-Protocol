/**
 * FeeObligationReconciliation — Missão 11 Fase 3 §5.
 *
 * The terminal-escrow invariant: for any Escrow with a non-null
 * feePolicyVersionId that has reached a terminal settlement status
 * (COMPLETED/REFUNDED/SPLIT), a FeeObligation row must exist — its absence
 * is provably an integrity error, never an ambiguous case (Fase 2.1 §3).
 *
 * findTerminalPolicyAwareEscrowsMissingObligation() DETECTS this gap only —
 * it never creates a missing FeeObligation itself. A silent auto-fix here
 * would be exactly the kind of undisclosed backfill this whole mission has
 * repeatedly ruled out for historical/legacy data, and would also hide a
 * real bug (a settlement path that bypassed
 * recordObligationForEscrowSettlement()) behind a self-healing side effect
 * instead of surfacing it.
 *
 * Legacy escrows (feePolicyVersionId IS NULL) are correctly excluded by the
 * WHERE clause itself — their absence of a FeeObligation is the expected,
 * permanent, correct state (Fase 3 §8), never flagged here.
 */
import { prisma } from '../../common/database'
import { Prisma } from '@prisma/client'
import * as bitcoin from 'bitcoinjs-lib'
import { computeRequiredFundingAmount } from './fee-reserve-math'
import { networkFor } from './multisig.provider'
import { config } from '../../config'

export interface MissingObligationRow {
  escrowId: string
  status: string
  feePolicyVersionId: string
}

export async function findTerminalPolicyAwareEscrowsMissingObligation(): Promise<MissingObligationRow[]> {
  const rows = await prisma.escrow.findMany({
    where: {
      feePolicyVersionId: { not: null },
      status: { in: ['COMPLETED', 'REFUNDED', 'SPLIT'] },
      feeObligation: { is: null },
    },
    select: { id: true, status: true, feePolicyVersionId: true },
  })

  return rows.map((r) => ({
    escrowId: r.id,
    status: r.status,
    feePolicyVersionId: r.feePolicyVersionId!,
  }))
}

export interface FundedAmountMismatchRow {
  escrowId: string
  fundedAmount: string
  requiredFundingAmount: string
}

// Missão 11 Fase 4 §K — DB-only (no live chain lookup): compares the
// purely observational Escrow.fundedAmount (Fase 4 §C, recorded once at
// lockFunds() success time) against the requiredFundingAmount computed
// fresh from lockedAmount + the escrow's own immutable rate snapshot.
// Under exact-funding enforcement (multisig.provider.ts) these should
// always agree in the success case — this exists to DETECT a regression
// (e.g. a future bug loosening the exact-match check) without needing to
// re-query the explorer for every escrow on every reconciliation pass.
export async function findFundedAmountMismatches(): Promise<FundedAmountMismatchRow[]> {
  const rows = await prisma.escrow.findMany({
    where: {
      feePolicyVersionId: { not: null },
      fundedAmount: { not: null },
      snapshotProtocolFeeRate: { not: null },
    },
    select: { id: true, lockedAmount: true, fundedAmount: true, snapshotProtocolFeeRate: true },
  })

  const mismatches: FundedAmountMismatchRow[] = []
  for (const row of rows) {
    const required = computeRequiredFundingAmount(row.lockedAmount, row.snapshotProtocolFeeRate!)
    if (!new Prisma.Decimal(row.fundedAmount!).equals(required)) {
      mismatches.push({
        escrowId: row.id,
        fundedAmount: row.fundedAmount!.toString(),
        requiredFundingAmount: required.toString(),
      })
    }
  }
  return mismatches
}

export interface CollectionEvidenceMismatchRow {
  feeObligationId: string
  escrowId: string
  computedFee: string
  confirmedEvidenceAmount: string | null
}

// Missão 11 Fase 4 §K — DB-only. For any obligation already marked
// COLLECTED, its most recent CONFIRMED FeeCollectionEvidence (if any)
// should record the same amount as computedFee. Flags both an outright
// missing confirmation and an amount disagreement — never auto-corrects
// either (Fase 2.1's own "detect, don't silently fix" principle, applied
// here too). No collection-tracking mechanism writes FeeCollectionEvidence
// yet in this phase (Fase 4's own scope boundary — see this mission's own
// report) — this query is forward-ready for when one does, not exercised
// by any real data today.
export async function findCollectionEvidenceMismatches(): Promise<CollectionEvidenceMismatchRow[]> {
  const obligations = await prisma.feeObligation.findMany({
    where: { collectionStatus: 'COLLECTED' },
    include: { evidence: { where: { kind: 'CONFIRMED' }, orderBy: { seq: 'desc' }, take: 1 } },
  })

  const mismatches: CollectionEvidenceMismatchRow[] = []
  for (const obligation of obligations) {
    const latestConfirmed = obligation.evidence[0]
    const computedFee = obligation.computedFee?.toString() ?? null
    const confirmedAmount = latestConfirmed?.amount?.toString() ?? null
    if (confirmedAmount === null || confirmedAmount !== computedFee) {
      mismatches.push({
        feeObligationId: obligation.id,
        escrowId: obligation.escrowId,
        computedFee: computedFee ?? '(null)',
        confirmedEvidenceAmount: confirmedAmount,
      })
    }
  }
  return mismatches
}

// ─── Missão 11 Fase 5 §9 — collection-recognition reconciliation ──────────
// All DETECT-only, same discipline as every function above: never creates,
// updates, or deletes anything. "Legacy escrow with collection evidence"
// and "obligation exists, no FeeObligation for evidence to attach to" are
// deliberately NOT implemented as functions here — both are already
// structurally impossible (FeeCollectionEvidence.feeObligationId is a
// required FK to FeeObligation, which itself is only ever created for a
// policy-aware escrow — recordObligationForEscrowSettlement()'s own first
// line makes this the one case that can never even be queried for).

export interface WaivedWithEvidenceRow {
  feeObligationId: string
  escrowId: string
  collectionStatus: string
  evidenceCount: number
}

// A WAIVED or UNCOLLECTIBLE_BYPASSED obligation should never have ANY
// collection evidence at all — no fee output was ever built for either
// outcome, so there is nothing real to have evidence of.
export async function findWaivedOrBypassedWithEvidence(): Promise<WaivedWithEvidenceRow[]> {
  const obligations = await prisma.feeObligation.findMany({
    where: { collectionStatus: { in: ['WAIVED', 'UNCOLLECTIBLE_BYPASSED'] } },
    include: { evidence: true },
  })
  return obligations
    .filter((o) => o.evidence.length > 0)
    .map((o) => ({ feeObligationId: o.id, escrowId: o.escrowId, collectionStatus: o.collectionStatus!, evidenceCount: o.evidence.length }))
}

export interface SettlementTxidMismatchRow {
  feeObligationId: string
  escrowId: string
  escrowTxReleaseId: string | null
  evidenceTxid: string | null
}

// The escrow's own recorded txReleaseId (written by
// escrow-pending-tx.ts's updateSignatureCollectionResult(), independently
// of the fee-evidence write) must always match what collection evidence
// says was broadcast for the SAME settlement — the two are written from
// the same real broadcast, moments apart, and should never disagree.
export async function findSettlementTxidMismatches(): Promise<SettlementTxidMismatchRow[]> {
  const obligations = await prisma.feeObligation.findMany({
    where: { collectionStatus: { in: ['IN_PROGRESS', 'COLLECTED', 'DISTRIBUTED'] } },
    include: { escrow: true, evidence: { where: { kind: 'BROADCAST' }, orderBy: { seq: 'desc' }, take: 1 } },
  })
  const mismatches: SettlementTxidMismatchRow[] = []
  for (const obligation of obligations) {
    const evidenceTxid = obligation.evidence[0]?.txid ?? null
    if (obligation.escrow.txReleaseId !== evidenceTxid) {
      mismatches.push({
        feeObligationId: obligation.id,
        escrowId: obligation.escrowId,
        escrowTxReleaseId: obligation.escrow.txReleaseId,
        evidenceTxid,
      })
    }
  }
  return mismatches
}

export interface DuplicateBroadcastEvidenceRow {
  feeObligationId: string
  escrowId: string
  txid: string
  count: number
}

// More than one BROADCAST evidence row for the IDENTICAL txid on the same
// obligation is a real duplicate (a genuine RBF replacement produces a
// BROADCAST row for a DIFFERENT txid, recorded alongside a REPLACED row
// for the old one — never two BROADCAST rows sharing one txid).
export async function findDuplicateBroadcastEvidence(): Promise<DuplicateBroadcastEvidenceRow[]> {
  const evidenceRows = await prisma.feeCollectionEvidence.findMany({
    where: { kind: 'BROADCAST', txid: { not: null } },
  })
  const counts = new Map<string, { feeObligationId: string; txid: string; count: number }>()
  for (const row of evidenceRows) {
    const key = `${row.feeObligationId}:${row.txid}`
    const existing = counts.get(key)
    counts.set(key, { feeObligationId: row.feeObligationId, txid: row.txid!, count: (existing?.count ?? 0) + 1 })
  }
  const duplicates = [...counts.values()].filter((c) => c.count > 1)
  if (duplicates.length === 0) return []

  const obligations = await prisma.feeObligation.findMany({
    where: { id: { in: duplicates.map((d) => d.feeObligationId) } },
    select: { id: true, escrowId: true },
  })
  const escrowIdByObligation = new Map(obligations.map((o) => [o.id, o.escrowId]))
  return duplicates.map((d) => ({ feeObligationId: d.feeObligationId, escrowId: escrowIdByObligation.get(d.feeObligationId) ?? '(unknown)', txid: d.txid, count: d.count }))
}

export interface WrongCollectionDestinationRow {
  feeObligationId: string
  escrowId: string
  expectedScriptPubKey: string
  actualScriptPubKey: string | null
}

// Every recorded BROADCAST/CONFIRMED evidence's scriptPubKey must match
// the escrow's own FROZEN snapshotFeeCollectionAddress — compared as raw
// script bytes (pure, local bitcoinjs-lib decode of an address string
// already in the database; no live chain call, consistent with this
// module's own "DB-only" scope). A mismatch here would mean a real fee
// output was built against a destination different from what the escrow
// was actually snapshotted with — the exact class of bug Fase 4.1's
// destination-freeze exists to make structurally impossible; this is the
// detection backstop in case that guarantee is ever violated some other
// way (e.g. a future code change bypassing multisig.provider.ts entirely).
export async function findWrongCollectionDestinationEvidence(): Promise<WrongCollectionDestinationRow[]> {
  const obligations = await prisma.feeObligation.findMany({
    where: { collectionStatus: { in: ['IN_PROGRESS', 'COLLECTED', 'DISTRIBUTED'] } },
    include: { escrow: true, evidence: { where: { kind: { in: ['BROADCAST', 'CONFIRMED'] } }, orderBy: { seq: 'desc' }, take: 1 } },
  })
  const mismatches: WrongCollectionDestinationRow[] = []
  const network = networkFor(config.multisig.network)
  for (const obligation of obligations) {
    if (!obligation.escrow.snapshotFeeCollectionAddress) continue // nothing frozen to compare against — a different anomaly class, not this one
    let expectedScriptHex: string
    try {
      expectedScriptHex = Buffer.from(bitcoin.address.toOutputScript(obligation.escrow.snapshotFeeCollectionAddress, network)).toString('hex')
    } catch {
      continue // malformed frozen address is its own, separately-surfaced problem — not a destination MISMATCH per se
    }
    const actualScriptHex = obligation.evidence[0]?.scriptPubKey ?? null
    if (actualScriptHex !== expectedScriptHex) {
      mismatches.push({ feeObligationId: obligation.id, escrowId: obligation.escrowId, expectedScriptPubKey: expectedScriptHex, actualScriptPubKey: actualScriptHex })
    }
  }
  return mismatches
}

export interface UnresolvedChainEventRow {
  feeObligationId: string
  escrowId: string
  collectionStatus: string
  lastEvidenceKind: string
}

// An IN_PROGRESS obligation whose most recent evidence is DROPPED, or a
// COLLECTED obligation whose most recent evidence is REORGED_OUT (the
// "already DISTRIBUTED, could not auto-revert" exceptional case
// fee-collection-recognition.service.ts's own recordReorgAndRevert()
// explicitly refuses to improvise past) — both are real chain events that
// were correctly recorded but left the obligation in a state that needs a
// human decision, never an automatic one.
export async function findUnresolvedChainEvents(): Promise<UnresolvedChainEventRow[]> {
  const obligations = await prisma.feeObligation.findMany({
    where: { collectionStatus: { in: ['IN_PROGRESS', 'COLLECTED', 'DISTRIBUTED'] } },
    include: { evidence: { orderBy: { seq: 'desc' }, take: 1 } },
  })
  const flagged: UnresolvedChainEventRow[] = []
  for (const obligation of obligations) {
    const lastKind = obligation.evidence[0]?.kind
    if (!lastKind) continue
    const isUnresolved =
      (obligation.collectionStatus === 'IN_PROGRESS' && lastKind === 'DROPPED') ||
      ((obligation.collectionStatus === 'COLLECTED' || obligation.collectionStatus === 'DISTRIBUTED') && lastKind === 'REORGED_OUT')
    if (isUnresolved) {
      flagged.push({ feeObligationId: obligation.id, escrowId: obligation.escrowId, collectionStatus: obligation.collectionStatus!, lastEvidenceKind: lastKind })
    }
  }
  return flagged
}
