/**
 * FeeCollectionRecognitionService — Missão 11 Fase 5.
 *
 * Closes the gap between "the settlement transaction contains a real
 * Sails Protocol Fee output" and "the Sails accounting system has
 * recognized that fee as actually collected" (Fase 4.2's own Activation
 * Blocker A). Rail-agnostic by design — it only ever writes
 * FeeCollectionEvidence rows and drives FeeObligation.collectionStatus
 * through the existing Fase 2.1 transition graph
 * (PENDING_COLLECTION -> IN_PROGRESS -> COLLECTED, with COLLECTED ->
 * IN_PROGRESS as the one automatic backward edge, for a pre-distribution
 * reorg). Every rail-specific concern — deciding WHICH output is the fee,
 * querying a chain explorer for confirmation depth — lives in the calling
 * rail's own provider (multisig.provider.ts's identifyFeeOutput()/
 * fetchTransactionConfirmationStatus() for MULTISIG) and is never
 * duplicated here.
 *
 * The core invariant this service exists to enforce structurally:
 * NO ON-CHAIN COLLECTION EVIDENCE -> NO COLLECTED REVENUE. Every method
 * below either records real evidence tied to a real txid/output, or
 * refuses.
 */
import { Prisma } from '@prisma/client'
import { prisma } from '../../common/database'
import { EscrowError } from '../../common/errors'
import { childLogger } from '../../common/logger'
import { feeObligationRepository, type FeeObligationRepository } from './fee-obligation-repository'
import { feeCollectionEvidenceRepository, type FeeCollectionEvidenceRepository } from './fee-collection-evidence-repository'
import { feeObligationService, FeeObligationService } from './fee-obligation.service'
import { distributionPolicyService as defaultDistributionPolicyService, DistributionPolicyService } from './distribution-policy.service'

const log = childLogger('fee-collection-recognition')

export interface BroadcastEvidenceInput {
  txid: string
  vout: number
  scriptPubKey: string
  amountSats: number
}

// Missão 11 Fase 7.2.1 — injectable, same reason every repository/service
// dependency on this class already is: recognizeConfirmation() needs its
// two writes to commit atomically (see that method's own header comment
// for the adversarial proof of why), but this class's own established
// contract is unit-testable via fake repositories with NO real database
// (this file's own test suite's header comment). Hardcoding a call to the
// real `prisma.$transaction` would silently force every test through this
// method to open a genuine Postgres transaction — reproduced directly
// while building this fix (the existing fake-repo unit tests hung
// waiting on a real DB round trip). A single injectable function,
// defaulting to the real `prisma.$transaction`, keeps production
// behavior exactly atomic while letting a unit test supply a trivial
// synchronous-passthrough fake (`(fn) => fn(undefined)`) — the fake
// repositories underneath already ignore the `tx` argument entirely, so
// this changes nothing about what those tests actually verify.
export type TransactionRunner = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>
const defaultTransactionRunner: TransactionRunner = (fn) => prisma.$transaction(fn)

export class FeeCollectionRecognitionService {
  constructor(
    private readonly obligationRepo: FeeObligationRepository = feeObligationRepository,
    private readonly evidenceRepo: FeeCollectionEvidenceRepository = feeCollectionEvidenceRepository,
    private readonly obligationService: FeeObligationService = feeObligationService,
    private readonly distributionPolicyService: DistributionPolicyService = defaultDistributionPolicyService,
    private readonly runInTransaction: TransactionRunner = defaultTransactionRunner
  ) {}

  /**
   * §6 — a fee-bearing settlement transaction was successfully broadcast.
   * Records append-only BROADCAST evidence tied to the real txid/output
   * the caller already deterministically identified (never re-derived
   * here), then transitions PENDING_COLLECTION -> IN_PROGRESS.
   *
   * Broadcast success != confirmed revenue — this method NEVER, under any
   * circumstance, transitions an obligation to COLLECTED. Callers must
   * never invoke this for a waived, refund, or legacy outcome (there is
   * no fee output to have evidence for in any of those cases) — the one
   * real call site (escrow-pending-tx.ts) only reaches this method when a
   * real, non-waived Sails output was actually constructed.
   */
  async recordBroadcastAndAdvance(feeObligationId: string, evidence: BroadcastEvidenceInput): Promise<void> {
    // Day-0 #245 — BROADCAST evidence and the lifecycle claim are one
    // crash-consistent fact. If the CAS loses a concurrent race, throwing
    // rolls this transaction's evidence insert back as well; no orphaned
    // BROADCAST row can survive while the obligation is still PENDING.
    await this.runInTransaction(async (tx) => {
      await this.evidenceRepo.record({
        feeObligationId,
        kind: 'BROADCAST',
        txid: evidence.txid,
        vout: evidence.vout,
        scriptPubKey: evidence.scriptPubKey,
        amount: new Prisma.Decimal(evidence.amountSats).dividedBy(1e8),
      }, tx)
      await this.obligationService.transitionCollectionStatus(feeObligationId, 'PENDING_COLLECTION', 'IN_PROGRESS', tx)
    })
  }

  /**
   * §7 — the confirmation-depth rule (FeePolicyVersion.requiredConfirmations)
   * has been satisfied for this obligation's broadcast transaction.
   * Re-verifies before recognizing anything: the obligation must actually
   * be IN_PROGRESS (never recognizes a confirmation for one that isn't
   * awaiting one), and `txid` must match this obligation's own most
   * recent BROADCAST evidence exactly — never trusts a caller-supplied
   * txid on faith, even from a trusted internal caller. Only after both
   * checks pass does this record CONFIRMED evidence and transition
   * IN_PROGRESS -> COLLECTED. This is the ONLY place in the codebase that
   * may ever make that transition — the fee becomes Protocol Revenue
   * here, nowhere else.
   *
   * Missão 11 Fase 7.2 (CTO-frozen decision) — this is also the ONLY
   * place a DistributionPolicyVersion is ever selected to govern a
   * collection generation's future allocation. Resolved once, right here.
   *
   * Missão 11 Fase 7.2.1 — the CONFIRMED-evidence insert (carrying the
   * resolved policy) and the IN_PROGRESS -> COLLECTED transition commit
   * inside ONE prisma.$transaction — the same pattern entitlement-
   * allocation.service.ts's own allocate() already established for this
   * identical class of problem ("reading/writing economically
   * authoritative state must not leave a crash-recoverable window where
   * one half committed and the other didn't"). Proven necessary by direct
   * adversarial reproduction against real Postgres: the previous shape
   * (two separate top-level writes) let a crash between them, followed by
   * the real periodic sweep job's automatic retry
   * (multisig-fee-confirmation-job.ts re-selects any still-IN_PROGRESS
   * obligation every tick — this is not a hypothetical race, it is that
   * job's normal, expected recovery behavior), produce TWO CONFIRMED rows
   * for the SAME on-chain confirmation event, independently frozen to
   * DIFFERENT DistributionPolicyVersions if a policy rotation happened in
   * that window. Wrapping both writes atomically closes this
   * structurally: either both commit (one fully-formed COLLECTED
   * generation with its one frozen policy) or neither does — a retry
   * starts genuinely fresh, with zero orphaned evidence row ever
   * persisted. The same atomic claim also closes the concurrent-caller
   * case (two simultaneous recognizeConfirmation() calls): the SECOND to
   * reach the transition claim inside its own transaction sees 0 rows
   * affected (the row's collectionStatus is no longer 'IN_PROGRESS' once
   * the first transaction commits) and throws, rolling back that
   * transaction's own CONFIRMED insert too — never leaving a second,
   * competing CONFIRMED row behind. Operational latency (a worker running
   * allocate() seconds, minutes, or a process-restart later) still can
   * never affect which policy this generation is bound to. A `null`
   * result (zero DistributionPolicyVersion PUBLISHED right now) is a
   * real, permanent outcome, not a placeholder — no backfill, no later
   * adoption of whatever becomes live afterward (Fase 7.2 §C).
   */
  async recognizeConfirmation(feeObligationId: string, txid: string, confirmedAtHeight: number): Promise<void> {
    const obligation = await this.obligationRepo.findById(feeObligationId)
    if (!obligation) {
      throw new EscrowError(`recognizeConfirmation: FeeObligation ${feeObligationId} not found`)
    }
    if (obligation.collectionStatus !== 'IN_PROGRESS') {
      throw new EscrowError(
        `recognizeConfirmation: FeeObligation ${feeObligationId} is not IN_PROGRESS (currently ${obligation.collectionStatus}) — refusing to recognize a confirmation for an obligation that isn't awaiting one`
      )
    }
    const evidence = await this.evidenceRepo.listForObligation(feeObligationId)
    const lastBroadcast = [...evidence].reverse().find((e) => e.kind === 'BROADCAST')
    if (!lastBroadcast || lastBroadcast.txid !== txid) {
      throw new EscrowError(
        `recognizeConfirmation: txid '${txid}' does not match this obligation's own recorded BROADCAST evidence (${lastBroadcast?.txid ?? 'none recorded'}) — refusing to recognize confirmation for an unrecognized transaction`
      )
    }

    const livePolicy = await this.distributionPolicyService.findLivePolicy()

    await this.runInTransaction(async (tx) => {
      await this.evidenceRepo.record({
        feeObligationId,
        kind: 'CONFIRMED',
        txid,
        vout: lastBroadcast.vout ?? undefined,
        scriptPubKey: lastBroadcast.scriptPubKey ?? undefined,
        amount: lastBroadcast.amount ?? undefined,
        confirmedAtHeight,
        distributionPolicyVersionId: livePolicy?.id ?? null,
      }, tx)
      await this.obligationService.transitionCollectionStatus(feeObligationId, 'IN_PROGRESS', 'COLLECTED', tx)
    })
  }

  /**
   * §8 RBF/replacement — the old transaction's evidence is preserved
   * append-only (never edited, never deleted); this records the
   * replacement relation as a new REPLACED row. The obligation itself
   * stays IN_PROGRESS (or wherever it already was) — a later, genuine
   * broadcast of the replacement transaction is its own separate
   * recordBroadcastAndAdvance()-equivalent call by the caller, using the
   * NEW txid; this method's only job is to make the old evidence's fate
   * auditable, never to advance status on the caller's behalf.
   */
  async recordReplacement(feeObligationId: string, oldTxid: string, newTxid: string): Promise<void> {
    await this.evidenceRepo.record({
      feeObligationId,
      kind: 'REPLACED',
      txid: oldTxid,
      note: `Replaced by ${newTxid}`,
    })
  }

  /**
   * §8 dropped/unconfirmed transaction — an IN_PROGRESS obligation whose
   * broadcast transaction disappeared from the mempool with no
   * replacement observed. Records DROPPED evidence. Deliberately does
   * NOT itself revert collectionStatus — an obligation left IN_PROGRESS
   * (never revenue, per the core invariant) is already safe; whether to
   * revert further (e.g. back toward PENDING_COLLECTION, implying the
   * seller's reserve needs re-collection via a fresh settlement) is a
   * judgment call for the caller/reconciliation, not this append-only
   * evidence writer.
   */
  async recordDropped(feeObligationId: string, txid: string, note?: string): Promise<void> {
    await this.evidenceRepo.record({ feeObligationId, kind: 'DROPPED', txid, note })
  }

  /**
   * §8 reorg — a previously-CONFIRMED transaction is no longer in the
   * best chain. Fase 2.1's own design principle: collection state may
   * need to move back to IN_PROGRESS before distribution ever treats it
   * as final — this method performs exactly that automatic backward
   * transition (COLLECTED -> IN_PROGRESS, already a legal edge in
   * VALID_COLLECTION_TRANSITIONS). If the obligation has ALREADY been
   * DISTRIBUTED, this deliberately refuses to auto-revert — Fase 5 §8's
   * own explicit instruction: "do not improvise automatic financial
   * reversal unless the architecture already supports it... detect and
   * surface as an exceptional reconciliation condition." A logged error
   * (not a throw — the reorg is a real chain event that already
   * happened; refusing to even record it would be worse) is that surface
   * today; a real remediation workflow for this specific case is
   * explicitly out of this phase's scope.
   */
  async recordReorgAndRevert(feeObligationId: string, txid: string): Promise<{ reverted: boolean }> {
    const obligation = await this.obligationRepo.findById(feeObligationId)
    if (!obligation) {
      throw new EscrowError(`recordReorgAndRevert: FeeObligation ${feeObligationId} not found`)
    }
    await this.evidenceRepo.record({ feeObligationId, kind: 'REORGED_OUT', txid })

    if (obligation.collectionStatus === 'DISTRIBUTED') {
      log.error({
        msg: 'Reorg detected on an ALREADY-DISTRIBUTED FeeObligation — NOT auto-reverting (would require improvising a financial reversal this architecture does not support). Flagging as an exceptional reconciliation condition requiring manual review.',
        feeObligationId, txid,
      })
      return { reverted: false }
    }
    if (obligation.collectionStatus === 'COLLECTED') {
      await this.obligationService.transitionCollectionStatus(feeObligationId, 'COLLECTED', 'IN_PROGRESS')
      return { reverted: true }
    }
    // Already IN_PROGRESS (or earlier) — evidence recorded for the
    // forensic trail, nothing to revert since it was never COLLECTED.
    return { reverted: false }
  }
}

export const feeCollectionRecognitionService = new FeeCollectionRecognitionService()
