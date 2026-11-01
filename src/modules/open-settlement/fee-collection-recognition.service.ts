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
import { feeObligationService, FeeObligationService, CollectionStatusClaimLostError } from './fee-obligation.service'
import { distributionPolicyService as defaultDistributionPolicyService, DistributionPolicyService } from './distribution-policy.service'

const log = childLogger('fee-collection-recognition')

export interface BroadcastEvidenceInput {
  txid: string
  vout: number
  scriptPubKey: string
  amountSats: number
}

/**
 * 'RECORDED': this call wrote the evidence and advanced the obligation. 'ALREADY_RECORDED': an exact retry of a
 * committed broadcast; nothing written. 'ADVANCED_EXISTING_EVIDENCE': this call advanced the obligation on matching
 * BROADCAST evidence that pre-existed (a pre-fix orphan); no second row written.
 */
export type BroadcastRecordOutcome = 'RECORDED' | 'ALREADY_RECORDED' | 'ADVANCED_EXISTING_EVIDENCE'

/**
 * Issue #245 — a BROADCAST retry that cannot be proven identical to what is already recorded. Auditable:
 * it carries the obligation id and the reason, and the service logs the incoming and recorded picture.
 * It never means "a second evidence row was written": nothing is written when it is thrown.
 */
export class FeeBroadcastEvidenceConflictError extends EscrowError {
  constructor(readonly feeObligationId: string, readonly conflictReason: string) {
    super(`FEE_BROADCAST_EVIDENCE_CONFLICT for FeeObligation ${feeObligationId}: ${conflictReason}`)
    this.name = 'FeeBroadcastEvidenceConflictError'
  }
}

// txid and scriptPubKey are hex: compare case-insensitively; a null on the recorded side never matches.
const sameHex = (a: string | null | undefined, b: string | null | undefined): boolean =>
  a != null && b != null && a.toLowerCase() === b.toLowerCase()

function broadcastMatches(
  row: { txid: string | null; vout: number | null; scriptPubKey: string | null; amount: Prisma.Decimal | null },
  incoming: BroadcastEvidenceInput, amount: Prisma.Decimal,
): boolean {
  return sameHex(row.txid, incoming.txid)
    && row.vout === incoming.vout
    && sameHex(row.scriptPubKey, incoming.scriptPubKey)
    && row.amount != null && new Prisma.Decimal(row.amount).equals(amount)
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
   * no fee output to have evidence for in any of those cases) — the two
   * real call sites (escrow-pending-tx.ts's live path and
   * escrow-settlement-reconciliation.service.ts's recovery path) only
   * reach this method when a real, non-waived Sails output was actually
   * constructed.
   *
   * Issue #245 (CTO decision D-245) — the status claim and the evidence insert are ONE
   * transaction. The claim (the existing CAS, `UPDATE ... WHERE collectionStatus =
   * 'PENDING_COLLECTION'`) runs FIRST: it takes the row lock, so of two concurrent callers
   * exactly one proceeds to insert; the other blocks until the winner commits, re-evaluates its
   * WHERE clause and affects 0 rows. An insert or any later failure rolls the claim back too, so a
   * crash between the two can leave neither a BROADCAST row without its transition nor the reverse.
   *
   * A caller that LOST the claim does not get a blind success and does not get a blind failure: in
   * the same transaction it reads what is now committed and decides —
   *   - status IN_PROGRESS/COLLECTED/DISTRIBUTED, no REPLACED row for this txid, and EVERY BROADCAST
   *     row of the obligation matches this call on txid + vout + scriptPubKey + amount
   *       => idempotent retry, returns 'ALREADY_RECORDED', writes nothing;
   *   - anything else (no BROADCAST row, a different output, several different broadcasts, a REPLACED
   *     row for this txid, a status that cannot hold a broadcast) => FeeBroadcastEvidenceConflictError,
   *     logged with the full picture, nothing written, nothing advanced. Ambiguity is a conflict, never
   *     an assumed success; no ordering by `recordedAt` is relied on (it has no tie-break).
   * Replacement/RBF is NOT handled here (recordReplacement() and a later BROADCAST for the new txid
   * are a separate flow): a divergent txid is reported as a conflict, never absorbed as a retry.
   *
   * A caller that WON the claim first looks for BROADCAST rows already on the obligation: before this
   * fix a crash between the two old writes left such an orphan next to a PENDING_COLLECTION
   * obligation. Orphans are never deleted and never duplicated: if every existing row matches this
   * call the obligation is advanced on that evidence ('ADVANCED_EXISTING_EVIDENCE', logged, no new
   * row); if any differs it is a conflict and the claim is rolled back with the throw.
   *
   * The on-chain broadcast happened BEFORE this method and outside PostgreSQL; this transaction
   * protects only the local accounting facts. A failure here never un-broadcasts anything.
   */
  async recordBroadcastAndAdvance(feeObligationId: string, evidence: BroadcastEvidenceInput): Promise<BroadcastRecordOutcome> {
    const amount = new Prisma.Decimal(evidence.amountSats).dividedBy(1e8)
    return this.runInTransaction(async (tx): Promise<BroadcastRecordOutcome> => {
      try {
        await this.obligationService.transitionCollectionStatus(feeObligationId, 'PENDING_COLLECTION', 'IN_PROGRESS', tx)
      } catch (err) {
        if (!(err instanceof CollectionStatusClaimLostError)) throw err
        return this.verifyAlreadyRecorded(feeObligationId, evidence, amount, tx)
      }
      const existing = (await this.evidenceRepo.listForObligation(feeObligationId, tx)).filter((e) => e.kind === 'BROADCAST')
      if (existing.length > 0) {
        if (!existing.every((e) => broadcastMatches(e, evidence, amount))) {
          return this.conflict(feeObligationId, evidence, 'BROADCAST evidence already exists on a PENDING_COLLECTION obligation and differs from this call; the claim is rolled back', 'PENDING_COLLECTION', existing.length)
        }
        log.warn({
          msg: 'FEE_BROADCAST_ORPHAN_ADOPTED — matching BROADCAST evidence pre-existed on a PENDING_COLLECTION obligation (a pre-fix crash window); the obligation was advanced on it and no second row was written',
          feeObligationId, txid: evidence.txid, broadcastRows: existing.length,
        })
        return 'ADVANCED_EXISTING_EVIDENCE'
      }
      await this.evidenceRepo.record({
        feeObligationId,
        kind: 'BROADCAST',
        txid: evidence.txid,
        vout: evidence.vout,
        scriptPubKey: evidence.scriptPubKey,
        amount,
      }, tx)
      return 'RECORDED'
    })
  }

  /** Logs the full picture (auditable) and throws; nothing is written by the caller that reaches this. */
  private conflict(feeObligationId: string, evidence: BroadcastEvidenceInput, reason: string, status: string | null, broadcasts: number): never {
    log.error({
      msg: 'FEE_BROADCAST_EVIDENCE_CONFLICT — a BROADCAST call could not be proven identical to the recorded evidence; nothing was written',
      feeObligationId, reason, status, broadcastRows: broadcasts,
      incoming: { txid: evidence.txid, vout: evidence.vout, scriptPubKey: evidence.scriptPubKey, amountSats: evidence.amountSats },
    })
    throw new FeeBroadcastEvidenceConflictError(feeObligationId, reason)
  }

  /**
   * The claim was lost: decide, from committed state read inside the same transaction, whether this
   * call is an exact retry of what is already recorded (no write) or a conflict (throw, no write).
   */
  private async verifyAlreadyRecorded(
    feeObligationId: string, evidence: BroadcastEvidenceInput, amount: Prisma.Decimal, tx: Prisma.TransactionClient,
  ): Promise<BroadcastRecordOutcome> {
    const conflict = (reason: string, status: string | null, broadcasts: number): never =>
      this.conflict(feeObligationId, evidence, reason, status, broadcasts)

    const obligation = await this.obligationRepo.findById(feeObligationId, tx)
    if (!obligation) {
      throw new EscrowError(`recordBroadcastAndAdvance: FeeObligation ${feeObligationId} not found`)
    }
    const status = obligation.collectionStatus as string | null
    if (status !== 'IN_PROGRESS' && status !== 'COLLECTED' && status !== 'DISTRIBUTED') {
      return conflict(`the obligation is '${status}', a status that cannot hold a recorded broadcast`, status, 0)
    }
    const rows = await this.evidenceRepo.listForObligation(feeObligationId, tx)
    const broadcasts = rows.filter((e) => e.kind === 'BROADCAST')
    if (broadcasts.length === 0) {
      return conflict('the obligation advanced but no BROADCAST evidence exists (historical orphan or another path); not repaired here', status, 0)
    }
    if (rows.some((e) => e.kind === 'REPLACED' && sameHex(e.txid, evidence.txid))) {
      return conflict(`txid ${evidence.txid} was REPLACED; replaying it is not an idempotent retry`, status, broadcasts.length)
    }
    if (!broadcasts.every((e) => broadcastMatches(e, evidence, amount))) {
      return conflict('recorded BROADCAST evidence differs from this call (txid, vout, scriptPubKey or amount) or there are several different broadcasts', status, broadcasts.length)
    }
    return 'ALREADY_RECORDED'
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
