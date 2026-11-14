import { prisma } from '../../common/database'
import { Prisma } from '@prisma/client'
import { config } from '../../config'
import { EscrowError, SettlementResultConflictError } from '../../common/errors'
import { withEscrowFundingLock, loadParticipantPubkeys, emitEscrowTransition, claimEscrowTransition, EVENT_NAME_BY_TARGET_STATUS, resolvePayoutAddress } from './escrow-lifecycle'
import { eventBus } from '../../common/events/event-bus'
import { listHeldSettlementProvenance, TRANSITION_CLAIMED_KEY, TRANSITION_PROJECTED_KEY } from '../../common/events/event-projection'
import { escrowRepository } from './escrow-repository'
import { tradeRepository } from '../open-p2p/trade-repository'
import { feeObligationService } from './fee-obligation.service'
import { feeCollectionRecognitionService } from './fee-collection-recognition.service'
import { multisigProvider, identifyFeeOutput, networkFor, type MultisigEscrowInput } from './multisig.provider'
import { BroadcastRejected, SubmissionDefinitelyFailed } from './broadcast-outcome'
import { wdkSettlementProvider } from './wdk-settlement.provider'
import { wdkTransferAttemptRepository } from './wdk-transfer-attempt-repository'
import { recordLiveCorrespondenceIfApplicable } from './dispute-correspondence'
import { childLogger } from '../../common/logger'
import { authorizePendingExecution } from './capability-execution-authorization'
import { authorizeDisputedPendingExecution } from './economic-disposition-authority'
import type { DeferredRulingFinalization } from './dispute.service' // type only: the module itself is required lazily below

const log = childLogger('escrow-settlement-reconciliation')

// Issue #239 - external funding-spend watch dependencies (kept apart from the import block above).
import { fetchOutpointSpendStatus, fetchTransactionConfirmationStatus, fetchTransactionHex } from './multisig.provider'
import { roundUnsignedTxid, proveExternalCompletion } from './multisig-round-proofs'
import { isFullySigned } from './pending-round-retirement'
import { VALID_TRANSITIONS } from './escrow-lifecycle'
import { escrowFundingEvidenceService } from './escrow-funding-evidence.service'
import { capabilityOperationDigest } from './capability-execution-authorization'
import { assertCooperativeOriginProvable, CooperativeOriginNotProvable, DisputedTranslationRefused } from './economic-disposition-authority'

/**
 * Sails OpenSettlement — settlement crash-recovery reconciliation
 * (Missão 11 Fase 9.6, closes Kimi K3 R2's CONC-03, independently
 * confirmed CONFIRMED/P1 during Fase 9.5's triage; extended Missão 11
 * Fase 9.7 to close the "C5" gap the Fase 9.6 report explicitly
 * disclosed rather than silently claimed closed).
 *
 * Two structurally different gaps, two passes:
 *
 * PASS 1 (Fase 9.6) — "did the real fund movement happen at all?"
 * escrow.service.ts's releaseFunds()/refundFunds()/splitFunds() and
 * escrow-pending-tx.ts's submitTransactionSignature() all claim a
 * TERMINAL escrow status BEFORE the real settlement provider call, and
 * only persist `txReleaseId` AFTER it returns. A crash in that window
 * leaves txReleaseId null with no way to know whether the fund movement
 * itself already happened (Estado B) or never did (Estado A) — CTO's
 * own "Regra Zero": never guess. reconcileTxReleaseId() below asks the
 * chain, for MULTISIG only (the only rail with an authoritative,
 * independently-queryable truth source — see multisig.provider.ts's
 * reconcilePendingSettlement()). Every other rail fails closed.
 *
 * PASS 2 (Fase 9.7) — "the fund movement is CONFIRMED (txReleaseId is
 * already set) — did the DOWNSTREAM completion effects (fee obligation,
 * Trade.status, reputation, volume, the settlement.escrow.* event)
 * actually run?" A crash between txReleaseId persistence and
 * emitEscrowTransition() succeeding leaves those effects silently
 * missing — not duplicated, MISSING (Fase 9.7's own audit found several
 * of them — recordTradeCompletion()'s totalTrades/totalVolumeBtc
 * increments, reputationService.recordOutcome()'s reputationScore
 * increment — have no idempotency key of their own, so a NAIVE re-run
 * would risk double-counting; a MISSING run just silently leaves stats
 * wrong forever). This gap is NOT rail-specific — once txReleaseId is
 * confirmed, no further on-chain truth-seeking is needed for ANY rail,
 * only the SAME downstream chain every rail's own normal completion
 * path already runs. reconcileMissingCompletionEffects() below handles
 * this for every rail, gated by emitEscrowTransition()'s own new
 * (escrowId, toStatus) idempotency claim (escrow-lifecycle.ts, Fase
 * 9.7) — the single authoritative "has this already run" signal, not a
 * second one invented here.
 *
 * CTO's own explicit principle for Fase 9.7: not exactly-once delivery
 * — idempotent effects + at-least-once execution + observable
 * convergence, where technically appropriate. That's exactly what both
 * passes now provide: PASS 1 never broadcasts a second real Bitcoin
 * transaction (verified against chain truth first); PASS 2 never
 * double-applies a downstream effect (gated by emitEscrowTransition()'s
 * own atomic per-transition claim) and safely catches up a missing one.
 */

export interface ReconciliationReport {
  // Issue #251 - 'ALREADY_CONFIRMED' is WDK_USDT_EVM RELEASE/REFUND's own outcome label: unlike
  // MULTISIG (which may itself broadcast a fully-signed PSBT during reconciliation), this reconciler
  // never submits anything - it only ever finds and consumes an already-confirmed provider fact.
  recovered: Array<{ escrowId: string; txId: string; outcome: 'ALREADY_BROADCAST' | 'NEWLY_BROADCAST' | 'ALREADY_CONFIRMED' }>
  completionEffectsRecovered: Array<{ escrowId: string; obligationSkipped: boolean }>
  requiresManualReview: Array<{ escrowId: string; reason: string }>
  failed: Array<{ escrowId: string; error: string }>
  // Sails Core Implementation Program M9-R (Recovery Closure) — PASS 0,
  // crash window C8: all required signatures were durably persisted but
  // the process died before claimEscrowTransition() ever ran. Distinct
  // from `recovered` above (PASS 1's own field, which only ever sees an
  // escrow that is ALREADY terminal) — kept separate so a reader of this
  // report can tell "the transition itself had to be resumed" apart from
  // "the transition already happened, only txReleaseId was missing."
  resumedUnclaimed: Array<{ escrowId: string; txId: string; outcome: 'ALREADY_BROADCAST' | 'NEWLY_BROADCAST' }>
  alreadyClaimedConcurrently: string[]
  // Issue #298 - PASS 3: claimed-but-not-fully-projected transitions that were re-driven.
  projectionsRecovered: Array<{ escrowId: string; transitionId: string; action: 'REPUBLISHED' | 'REDELIVERED' }>
  // Issue #253 - disputes whose arbiter ruling finalization was re-driven (dispute.service.ts's recoverMissingRulingFinalization()).
  rulingFinalizationsRecovered: string[]
  // D11-R - ruling generations recovery deferred because they can still be rolled back (not failures; retried each tick).
  rulingFinalizationsDeferred: DeferredRulingFinalization[]
  // Issue #238 - opened disputes whose arbiter assignment was finished here (dispute.service.ts's recoverUnassignedDisputes()).
  disputeArbitersRecovered: string[]
  // Issue #239 - fully signed cooperative rounds ADR-005 refused (escrow is or was disputed): held, never failed.
  heldIncompatibleRounds: Array<{ escrowId: string; pendingTransactionId: string }>
  // Issue #239 - the external funding-spend watch (reconcileExternalFundingSpends()).
  externallyCompleted: Array<{ escrowId: string; txId: string }>
  externalSpendUnreadable: string[]
  externalSpendPendingConfirmation: string[]
  externalSpendFundingUncertain: string[]
}

// The audit-trail "from" state for the reconciliation-driven
// emitEscrowTransition() call below — the escrow's own last recorded
// EscrowEvent.toStatus (i.e., the real state it was actually in right
// before the crashed attempt), not a guess. computeEscrowEventHash()'s
// hash chain stays valid regardless of what `from` is supplied (it only
// ever consumes the previous row's own entryHash), so this is purely for
// a human reading the audit log to see an honest prior state rather than
// a self-referential one — falls back to the escrow's own current
// (terminal) status only in the structurally-impossible case where no
// prior event exists at all.
async function lastKnownStatus(escrowId: string, fallback: string): Promise<string> {
  const last = await prisma.escrowEvent.findFirst({ where: { escrowId }, orderBy: { createdAt: 'desc' } })
  return last?.toStatus ?? fallback
}

type PendingRow = {
  id: string; kind: string
  feeCollectionSats: number | null; feeCollectionWaived: boolean | null
  buyerBps: number | null; unsignedPsbtBase64: string
} | null

// Missão 11 Fase 9.7 — the ONE shared downstream-completion-effects
// implementation, used by BOTH reconciliation passes (and conceptually
// the same sequence escrow-pending-tx.ts's submitTransactionSignature()
// already runs on its own normal, non-crashed path — not a second,
// independently-reimplemented one). recordObligationForEscrowSettlement()
// is itself idempotent (findByEscrowId() check + a DB-unique-constraint
// backstop, confirmed Fase 9.5) — safe to call even if a previous,
// since-crashed attempt partially ran it. emitEscrowTransition() is now
// ALSO idempotent per (escrowId, toStatus) (escrow-lifecycle.ts, Fase
// 9.7) — the actual gate preventing this function from ever double-
// firing the trade-completion/reputation/volume cascade, regardless of
// how many times or from how many concurrent callers this function
// itself gets invoked for the same already-converged escrow.
//
// `pending` is null for a direct-call-rail escrow (MOCK/WDK_USDT_EVM —
// no EscrowPendingTransaction concept exists for them) or for a
// signature-collection escrow whose pending row was already cleaned up
// by an earlier, since-crashed attempt that got far enough to delete it
// (only reachable after emitEscrowTransition() already succeeded once —
// meaning this call would be a safe no-op via the idempotency claim
// anyway). A SPLIT outcome with pending === null cannot recover its
// buyerBps (the direct-call splitFunds() path never persists it
// anywhere durable, unlike EscrowPendingTransaction.buyerBps for the
// signature-collection path) — obligation recording is skipped and
// reported, not guessed.
async function applyDownstreamCompletionEffects(
  escrowId: string,
  tradeId: string,
  targetStatus: 'COMPLETED' | 'REFUNDED' | 'SPLIT',
  triggeredBy: string,
  txId: string,
  escrowRow: NonNullable<Awaited<ReturnType<typeof escrowRepository.findById>>>,
  pending: PendingRow,
  // Sails Core Implementation Program M9 (Recovery) — the exact,
  // deterministically-reconstructed transaction bytes, when the caller
  // already has them (PASS 1 always does, from its own
  // reconcilePendingSettlement() call; PASS 2 only if the pending row +
  // signatures still survive — see reconcileMissingCompletionEffects()'s
  // own comment). Optional: recordLiveCorrespondenceIfApplicable() below
  // already no-ops safely when this is undefined (M8.6's own established
  // contract), so a case where reconstruction genuinely is not possible
  // here is a safe, honest no-op, never a guess.
  rawTxHex: string | undefined,
  // Issue #239 (B-1) - the transition's persisted note when the default ("after a process crash") is not true:
  // only reconcileExternalFundingSpends() passes one. Same single emission, no new event.
  note?: string
): Promise<{ obligationSkipped: boolean; emitted: boolean }> {
  const feeOutcome = targetStatus === 'COMPLETED' ? 'RELEASE' as const : targetStatus === 'REFUNDED' ? 'FULL_REFUND' as const : 'SPLIT' as const

  let obligationSkipped = false
  let feeRecorded = true // false only when a due fee recording failed: the pending row is then kept (Issue #245, Phase 2)
  if (targetStatus === 'SPLIT' && !pending) {
    obligationSkipped = true
    log.error({
      msg: 'Reconciliation: SPLIT completion effects recovered, but buyerBps is unrecoverable for a direct-call-rail escrow with no surviving pending-transaction row — fee obligation NOT recorded, flagged for manual review',
      escrowId,
    })
  } else {
    const actualCollection = pending?.feeCollectionSats !== null && pending?.feeCollectionSats !== undefined
      ? { feeSats: pending.feeCollectionSats, waived: pending.feeCollectionWaived ?? false }
      : undefined
    await feeObligationService.recordObligationForEscrowSettlement(escrowRow, feeOutcome, pending?.buyerBps ?? undefined, actualCollection)

    // Same broadcast-evidence recording escrow-pending-tx.ts's own
    // submitTransactionSignature() runs, same non-throwing failure
    // handling — this is strictly secondary accounting, never allowed to
    // undo a settlement whose funds already moved (real, before this
    // module ever ran, in every case this function is called for).
    if (pending && pending.kind !== 'refund' && actualCollection && !actualCollection.waived) {
      feeRecorded = await recordFeeBroadcast(escrowRow, pending.unsignedPsbtBase64, actualCollection.feeSats, txId)
    }
  }

  const eventName = targetStatus === 'COMPLETED' ? 'settlement.escrow.released' as const
    : targetStatus === 'REFUNDED' ? 'settlement.escrow.refunded' as const
    : 'settlement.escrow.split' as const
  const fromStatus = await lastKnownStatus(escrowId, targetStatus)
  const emitted = await emitEscrowTransition(
    escrowId, tradeId, fromStatus, targetStatus, triggeredBy, eventName, { txId },
    note ?? 'Recovered by settlement reconciliation after a process crash — see escrow-settlement-reconciliation.service.ts'
  )

  // Sails Core Implementation Program M9 (Recovery) — closes crash window
  // C13/C14 (external effect + local reference recovered, but M6
  // correspondence for an M8-R Core-authoritative dispute was never
  // computed/recorded because the ORIGINAL attempt crashed first).
  // Narrowly discriminated INSIDE recordLiveCorrespondenceIfApplicable()
  // itself (MULTISIG + a RESOLVED Dispute with a durable Outcome must
  // actually exist) — a safe no-op for every cooperative settlement and
  // every other rail, exactly like the happy path
  // (escrow-pending-tx.ts's submitTransactionSignature()).
  // recordLiveCorrespondenceIfApplicable() ALSO owns its own idempotency
  // guard (keyed on tradeId+escrowId+appealRound against the durable
  // event log) — this call site does not need to know or check whether
  // correspondence was already recorded; a repeat call safely no-ops.
  // Placed BEFORE the pending-row cleanup below so a crash between this
  // call and that delete still leaves the row available for a LATER
  // reconciliation pass to retry from, rather than losing the only
  // remaining source of the signed PSBT.
  await recordLiveCorrespondenceIfApplicable(escrowId, tradeId, escrowRow.type, rawTxHex)

  if (pending && feeRecorded) {
    await prisma.escrowPendingTransaction.delete({ where: { id: pending.id } }).catch(() => {})
  }

  return { obligationSkipped, emitted }
}

// Issue #245 (Phase 2) — the ONE place the reconciler records a settlement's fee BROADCAST evidence, always through
// recordBroadcastAndAdvance() (the single recognition rule; it is idempotent and conflict-detecting). Returns true when
// the recording is durable or there is nothing to record, false when it failed (logged; never thrown — the settlement's
// funds already moved), in which case the caller keeps the pending row, the only durable source of the PSBT.
async function recordFeeBroadcast(
  escrowRow: NonNullable<Awaited<ReturnType<typeof escrowRepository.findById>>>,
  unsignedPsbtBase64: string, feeSats: number, txId: string
): Promise<boolean> {
  try {
    // Every caller has already established that a BROADCAST IS due (not a refund, fee not waived, feeSats recorded), so a
    // missing precondition here is a broken invariant, never "nothing to record": fail closed (false => the caller keeps the
    // pending row, the only durable source of the PSBT) with a diagnostic, and let a later pass retry.
    const obligation = await feeObligationService.findByEscrowId(escrowRow.id)
    if (!obligation || !escrowRow.snapshotFeeCollectionAddress) {
      log.error({
        msg: 'FEE_BROADCAST_PRECONDITION_MISSING — a fee BROADCAST is due but its preconditions are absent; nothing was recorded and the pending row is kept for a later retry',
        escrowId: escrowRow.id, txId, missing: [!obligation && 'FeeObligation', !escrowRow.snapshotFeeCollectionAddress && 'snapshotFeeCollectionAddress'].filter(Boolean),
      })
      return false
    }
    const network = networkFor(config.multisig.network)
    const evidence = identifyFeeOutput(unsignedPsbtBase64, escrowRow.snapshotFeeCollectionAddress, feeSats, network)
    await feeCollectionRecognitionService.recordBroadcastAndAdvance(obligation.id, {
      txid: txId, vout: evidence.vout, scriptPubKey: evidence.scriptPubKeyHex, amountSats: evidence.amountSats,
    })
    return true
  } catch (err) {
    log.error({
      msg: 'Reconciliation: broadcast-evidence recording failed after a successful settlement — nothing was written by this call; the FeeObligation was not advanced by it (current state not asserted); the pending row is kept for the next pass',
      escrowId: escrowRow.id, err: err instanceof Error ? err.message : err,
    })
    return false
  }
}

const NON_TERMINAL_QUERY_STATUSES = ['COMPLETED', 'REFUNDED', 'SPLIT'] as const

// PASS 0 (Sails Core Implementation Program M9-R, Recovery Closure,
// Part 3) — crash window C8, found during the M9 analytical gate: every
// required signature was durably persisted (submitTransactionSignature()'s
// own `allSubmitted` check would already be true), but the process died
// BEFORE claimEscrowTransition() ever ran — leaving the escrow
// non-terminal with a fully-signed pending row. Neither PASS 1 below
// (requires an ALREADY-terminal escrow) nor
// dispute-pending-reconciliation.ts's stale-artifact cleanup (requires
// ZERO collected signatures, by design — that module's whole safety
// argument rests on there being nothing to sign yet) ever looks at this
// combination. A participant re-submitting their own (already-recorded)
// signature happens to nudge this forward today, but that is client-
// driven, not automatic.
//
// CHAIN TRUTH BEFORE ECONOMIC ACTION (the mission's own explicit
// requirement): this function NEVER calls provider.finalizeRelease/
// Refund/Split() again — it reuses Mission11's own
// reconcilePendingSettlement() (the exact same on-chain-truth decision
// procedure PASS 1 already trusts) to determine whether the exact,
// deterministically-reconstructed transaction is already known to the
// network BEFORE claiming the local transition or touching any
// bookkeeping. Only once that is known does it claim the transition
// (claimEscrowTransition() — the same real, atomic, VALID_TRANSITIONS-
// gated primitive every live signer call already uses) and run the same
// shared downstream effects PASS 1 and PASS 2 both already use. No new
// finalize/retry primitive was invented.
// Only the SPECIFIC "lost the atomic claim" error (claimedCount === 0 — see claimEscrowTransition()'s own message) is
// a benign concurrent-claim outcome: someone else (a live signer's own retry, a concurrent recovery worker, or an
// openDispute() that won) already moved this escrow, and their call path owns what follows. Any OTHER error (an
// invalid transition, the circuit breaker open, a genuine DB failure) is a real anomaly, never reclassified.
function isLostEscrowClaim(err: unknown): boolean {
  return err instanceof EscrowError && /already transitioned by a concurrent request/.test(err.message)
}

// GK-M9R-D R1 (CTO 25) - a recovery broadcast of a round that is NOT already on the network is a first economic
// effect, even when the escrow was claimed (or the result recorded) by code that predates R1: it passes the same
// ADR-005 + Outcome gate as PASS 0 and the live path, immediately before the broadcast. A transaction the network
// already has (ALREADY_BROADCAST) never reaches the callback: chain truth is converged, never reverted or erased.
// `refused` tells the caller the gate refused, as opposed to the chain or the node failing.
function recoveryBroadcastGate(pending: Parameters<typeof authorizeDisputedPendingExecution>[0]) {
  const gate = {
    refused: undefined as unknown,
    check: async () => {
      try { await authorizeDisputedPendingExecution(pending) } catch (err) { gate.refused = err; throw err }
    },
  }
  return gate
}

async function reconcileUnclaimedFullySignedPending(report: ReconciliationReport): Promise<void> {
  const candidates = await prisma.escrowPendingTransaction.findMany({
    where: { escrow: { type: 'MULTISIG', status: { notIn: [...NON_TERMINAL_QUERY_STATUSES] } } },
    include: { signatures: true, escrow: true },
  })

  for (const pending of candidates) {
    const escrow = pending.escrow
    try {
      const signedList = pending.requiredSigners.map(
        (id: string) => pending.signatures.find((s: { participantId: string; signedPsbtBase64: string }) => s.participantId === id)?.signedPsbtBase64
      )
      if (signedList.some((s: string | undefined) => s === undefined)) {
        // Still genuinely collecting signatures — the ordinary, expected
        // C7 state, not a gap. Silently not a candidate (this is the
        // overwhelming common case for any escrow with a pending row).
        continue
      }

      const targetStatus = pending.kind === 'release' ? 'COMPLETED' as const
        : pending.kind === 'refund' ? 'REFUNDED' as const
        : 'SPLIT' as const

      const trade = await tradeRepository.findById(escrow.tradeId)
      if (!trade) {
        report.requiresManualReview.push({ escrowId: escrow.id, reason: `Trade ${escrow.tradeId} not found (C8 recovery — fully-signed pending transaction, escrow non-terminal).` })
        continue
      }

      const { buyerPubkey, sellerPubkey, arbiterPubkey } = await loadParticipantPubkeys(escrow.id)
      const input: MultisigEscrowInput = {
        tradeId: trade.id, lockedAmount: escrow.lockedAmount.toString(),
        buyerId: trade.buyerId, sellerId: trade.sellerId,
        buyerPubkey, sellerPubkey, arbiterPubkey,
        txLockId: escrow.txLockId, txLockVout: escrow.txLockVout,
        id: escrow.id, multisigAddr: escrow.multisigAddr, fundedAmount: escrow.fundedAmount,
        status: escrow.status,
      }

      // Ask chain truth before deciding whether this is merely convergence
      // of an effect that already happened, or a recovery attempt that would
      // become the FIRST broadcaster. Existing external truth must remain
      // recoverable even if authority changed after the original broadcast
      // (UNKNOWN != FAILED). A genuinely new economic side effect, however,
      // must pass the same ADR-005 + ADR-004 commit gates as the live path.
      //
      // The escrow claim is taken before the first broadcast, not after it. It is the same conditional status claim
      // openDispute() contends on, so it serializes the two: a dispute opened first makes this claim fail and nothing
      // is broadcast; once this claim wins, the escrow is no longer disputable and a later openDispute() is refused.
      // The claim is never reverted: a failed broadcast may still have reached the network (UNKNOWN), and PASS 1
      // converges a claimed escrow without txReleaseId from chain truth.
      let claimedBeforeBroadcast = false
      let result: Awaited<ReturnType<typeof multisigProvider.reconcilePendingSettlement>>
      try {
        result = await multisigProvider.reconcilePendingSettlement(
          input,
          pending.unsignedPsbtBase64,
          signedList as string[],
          async () => {
            await authorizeDisputedPendingExecution(pending)
            await authorizePendingExecution(pending)
            await claimEscrowTransition(escrow.id, escrow.status, targetStatus)
            claimedBeforeBroadcast = true
          }
        )
      } catch (err) {
        if (isLostEscrowClaim(err)) {
          report.alreadyClaimedConcurrently.push(escrow.id)
          continue
        }
        // Issue #239 (R5) - a fully signed cooperative round on an escrow that is or was disputed: ADR-005 refused it
        // before any broadcast. It is never superseded or deleted (it may still be broadcast by its signers); held,
        // not failed, until the chain or a human decides (#418).
        if (err instanceof CooperativeOriginNotProvable) {
          report.heldIncompatibleRounds.push({ escrowId: escrow.id, pendingTransactionId: pending.id })
          continue
        }
        throw err
      }
      if (result.outcome === 'ANOMALY') {
        // FULLY_SIGNED_NOT_FINALIZED, surfaced explicitly rather than
        // left invisible — see this file's own C8 header comment. Fails
        // closed: no transition claimed, no funds moved by this pass.
        log.error({ msg: 'C8 reconciliation anomaly — no automated recovery attempted', escrowId: escrow.id, detail: result.detail })
        report.requiresManualReview.push({ escrowId: escrow.id, reason: `C8 (fully-signed, unclaimed): ${result.detail}` })
        continue
      }

      if (!claimedBeforeBroadcast) {
        try {
          await claimEscrowTransition(escrow.id, escrow.status, targetStatus)
        } catch (err) {
          if (isLostEscrowClaim(err)) {
            report.alreadyClaimedConcurrently.push(escrow.id)
            continue
          }
          throw err
        }
      }

      const updateData = targetStatus === 'REFUNDED' ? { txReleaseId: result.txId } : { txReleaseId: result.txId, releasedAt: new Date() }
      try {
        // Issue #291 - same write-once primitive as every live writer, bound to the
        // immutable pending operation. Never overwrites a converged result.
        await escrowRepository.updateSignatureCollectionResult(escrow.id, updateData, { operation: { pendingOperationId: pending.id } })
      } catch (writeErr) {
        if (writeErr instanceof SettlementResultConflictError) {
          log.error({ msg: 'C8 recovery: settlement result integrity conflict - persisted evidence NOT overwritten', escrowId: escrow.id, err: writeErr.message })
          report.requiresManualReview.push({ escrowId: escrow.id, reason: writeErr.message })
          continue
        }
        throw writeErr
      }

      log.info({ msg: 'C8 recovery: claimed a previously-unclaimed, fully-signed pending transaction after asking the chain first', escrowId: escrow.id, outcome: result.outcome, txId: result.txId })
      await applyDownstreamCompletionEffects(escrow.id, escrow.tradeId, targetStatus, pending.triggeredBy, result.txId, escrow, pending, result.rawTxHex)
      report.resumedUnclaimed.push({ escrowId: escrow.id, txId: result.txId, outcome: result.outcome })
    } catch (err) {
      report.failed.push({ escrowId: escrow.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
}

// PASS 1 (Fase 9.6) — MULTISIG only. Determines whether the real fund
// movement happened (asking the chain, never guessing — see
// multisig.provider.ts's reconcilePendingSettlement() for the full
// on-chain-truth procedure) and, once known, runs the shared downstream
// completion effects above.
async function reconcileTxReleaseId(escrow: NonNullable<Awaited<ReturnType<typeof escrowRepository.findById>>>, report: ReconciliationReport): Promise<void> {
  if (escrow.type === 'WDK_USDT_EVM') {
    await reconcileWdkTerminalTransfer(escrow, report)
    return
  }

  if (escrow.type === 'LIGHTNING_HODL' || escrow.type === 'SAFE_GUARD_EVM') {
    await reconcileSignatureCollectionTerminalTransfer(escrow, report)
    return
  }

  if (escrow.type !== 'MULTISIG') {
    // No authoritative-truth primitive exists for this rail in this mission's scope (LIGHTNING_HODL/
    // SAFE_GUARD_EVM are handled above by reconcileSignatureCollectionTerminalTransfer();
    // WDK_USDT_EVM RELEASE/REFUND is handled above by reconcileWdkTerminalTransfer() - neither branch
    // is ever reached for those types) — fail closed
    // rather than guess. A real operator response requires a human to inspect this escrow's actual
    // provider-side state.
    report.requiresManualReview.push({
      escrowId: escrow.id,
      reason: `Escrow type '${escrow.type}' has no automated crash-recovery reconciliation primitive in this mission's scope — status is '${escrow.status}' with no txReleaseId. Manual review required.`,
    })
    return
  }

  const pending = await prisma.escrowPendingTransaction.findUnique({
    where: { escrowId: escrow.id },
    include: { signatures: true },
  })
  if (!pending) {
    // The pending row (and its signatures) is only ever deleted AFTER
    // a fully-successful convergence completes — if it's already
    // gone but txReleaseId is still null, something outside this
    // module's own model happened. Fail closed.
    report.requiresManualReview.push({
      escrowId: escrow.id,
      reason: `MULTISIG escrow ${escrow.id} is terminal with no txReleaseId, but its EscrowPendingTransaction row no longer exists — nothing to reconstruct from. Manual review required.`,
    })
    return
  }

  const targetStatus = pending.kind === 'release' ? 'COMPLETED' as const
    : pending.kind === 'refund' ? 'REFUNDED' as const
    : 'SPLIT' as const
  if (targetStatus !== escrow.status) {
    // Structurally shouldn't happen (the pending row's own `kind` is
    // set once, matching the exact status submitTransactionSignature()
    // claimed) — fail closed rather than assume which is stale.
    report.requiresManualReview.push({
      escrowId: escrow.id,
      reason: `MULTISIG escrow ${escrow.id} has status '${escrow.status}' but its pending transaction kind ('${pending.kind}') implies '${targetStatus}' — mismatch. Manual review required.`,
    })
    return
  }

  const signedList = pending.requiredSigners.map(
    (id: string) => pending.signatures.find((s: { participantId: string }) => s.participantId === id)?.signedPsbtBase64
  )
  if (signedList.some((s: string | undefined) => s === undefined)) {
    // Not every required signature is present — the escrow could not
    // structurally have reached submitTransactionSignature()'s
    // all-submitted branch (which is the ONLY place a terminal status
    // gets claimed for a signature-collection escrow), so this
    // combination (terminal status, incomplete signatures) should be
    // impossible. Fail closed.
    report.requiresManualReview.push({
      escrowId: escrow.id,
      reason: `MULTISIG escrow ${escrow.id} is terminal ('${escrow.status}') but its pending transaction is missing one or more required signatures — cannot reconstruct. Manual review required.`,
    })
    return
  }

  const trade = await tradeRepository.findById(escrow.tradeId)
  if (!trade) {
    report.requiresManualReview.push({ escrowId: escrow.id, reason: `Trade ${escrow.tradeId} not found.` })
    return
  }

  const { buyerPubkey, sellerPubkey, arbiterPubkey } = await loadParticipantPubkeys(escrow.id)
  const input: MultisigEscrowInput = {
    tradeId: trade.id, lockedAmount: escrow.lockedAmount.toString(),
    buyerId: trade.buyerId, sellerId: trade.sellerId,
    buyerPubkey, sellerPubkey, arbiterPubkey,
    txLockId: escrow.txLockId, txLockVout: escrow.txLockVout,
    id: escrow.id, multisigAddr: escrow.multisigAddr, fundedAmount: escrow.fundedAmount,
    status: escrow.status,
  }

  const gate = recoveryBroadcastGate(pending)
  let result: Awaited<ReturnType<typeof multisigProvider.reconcilePendingSettlement>>
  try {
    result = await multisigProvider.reconcilePendingSettlement(input, pending.unsignedPsbtBase64, signedList as string[], gate.check)
  } catch (err) {
    // GK-M9R-D R1 - the round is claimed but not on the network, and the gate refused it: nothing is sent. The claim,
    // the round, its signatures and any earlier authorization stay as evidence (the claim is never reverted: an
    // earlier broadcast may still surface); refused the same way every tick until the chain or a human decides.
    if (gate.refused) {
      const code = err instanceof DisputedTranslationRefused ? 'DISPUTED_TRANSLATION_REFUSED' : 'EXECUTION_GATE_REFUSED'
      log.error({ msg: 'PASS 1: claimed MULTISIG round refused by the execution gate - not broadcast, manual review', escrowId: escrow.id, pendingTransactionId: pending.id, code, err: err instanceof Error ? err.message : String(err) })
      report.requiresManualReview.push({ escrowId: escrow.id, reason: `${code}: escrow is ${escrow.status} with no txReleaseId, round ${pending.id} is not on the network and was not broadcast. ${err instanceof Error ? err.message : String(err)}` })
      return
    }
    // Issue #299 (CTO D3) - no automatic convergence from here: the node rejected the round's transaction (still
    // UNKNOWN - another node may have it) or the round cannot be built. Structured manual review (code, txid, round),
    // never a rollback or a new disposition; the claim stays and the same transaction is re-sent next tick.
    if (err instanceof BroadcastRejected || err instanceof SubmissionDefinitelyFailed) {
      const code = err instanceof BroadcastRejected ? 'BROADCAST_REJECTED' : 'ROUND_UNBUILDABLE'
      log.error({ msg: 'PASS 1: claimed MULTISIG escrow cannot converge automatically - manual review', escrowId: escrow.id, pendingTransactionId: pending.id, code, err: err.message })
      report.requiresManualReview.push({ escrowId: escrow.id, reason: `${code}: escrow is ${escrow.status} with no txReleaseId, round ${pending.id}. ${err.message}` })
      return
    }
    throw err
  }

  if (result.outcome === 'ANOMALY') {
    log.error({ msg: 'Reconciliation anomaly — no automated recovery attempted', escrowId: escrow.id, detail: result.detail })
    report.requiresManualReview.push({ escrowId: escrow.id, reason: result.detail })
    return
  }

  // Authoritative re-check, inside the same escrowId-scoped lock the
  // downstream effects step below also uses — a concurrent second
  // reconciliation run (or, structurally impossible but checked
  // anyway, a live request) may have already converged this exact
  // escrow between this module's unlocked chain-truth determination
  // above and this write.
  // Issue #291 - PASS 1 uses the SAME write-once primitive as every other
  // writer: empty -> write, same -> idempotent, DIFFERENT -> integrity
  // conflict (previously this branch silently ignored a differing value).
  let wroteTxReleaseId = false
  let movedTo = null as string | null
  try {
    wroteTxReleaseId = await withEscrowFundingLock(escrow.id, async (tx) => {
      const fresh = await tx.escrow.findUnique({ where: { id: escrow.id } })
      if (!fresh) return false
      // Issue #299 (GK S1, CTO C1) - a live rollback took the lock first: the claim is gone, so no result and no
      // completion event here. The round is still fully signed, so PASS 0 re-claims and converges it from the chain.
      if (fresh.status !== targetStatus) { movedTo = fresh.status; return false }
      const updateData = targetStatus === 'REFUNDED' ? { txReleaseId: result.txId } : { txReleaseId: result.txId, releasedAt: new Date() }
      await escrowRepository.updateSignatureCollectionResult(escrow.id, updateData, { tx, operation: { pendingOperationId: pending.id } })
      return fresh.txReleaseId === null
    })
  } catch (writeErr) {
    if (writeErr instanceof SettlementResultConflictError) {
      log.error({ msg: 'PASS 1: settlement result integrity conflict - persisted evidence NOT overwritten, downstream effects NOT run', escrowId: escrow.id, err: writeErr.message })
      report.requiresManualReview.push({ escrowId: escrow.id, reason: writeErr.message })
      return
    }
    throw writeErr
  }
  if (movedTo) {
    log.warn({ msg: 'PASS 1: escrow left its claimed status before the result was recorded - not recorded, PASS 0 converges it', escrowId: escrow.id, pendingTransactionId: pending.id, expected: targetStatus, status: movedTo, txId: result.txId })
    report.failed.push({ escrowId: escrow.id, error: `PASS 1: escrow ${escrow.id} is ${movedTo}, no longer ${targetStatus}; result ${result.txId} not recorded, PASS 0 converges the fully signed round` })
    return
  }

  log.info({ msg: 'Reconciliation: convergence path determined', escrowId: escrow.id, outcome: result.outcome, txId: result.txId, detail: result.detail, wroteTxReleaseId })
  // Downstream effects still run even if wroteTxReleaseId is false (a
  // concurrent writer already claimed it) — emitEscrowTransition()'s own
  // (escrowId, toStatus) idempotency claim (Fase 9.7) is what actually
  // prevents a double-fire, not this flag; this call is always safe.
  await applyDownstreamCompletionEffects(escrow.id, escrow.tradeId, targetStatus, pending.triggeredBy, result.txId, escrow, pending, result.rawTxHex)
  report.recovered.push({ escrowId: escrow.id, txId: result.txId, outcome: result.outcome })
}

// Issue #251 - WDK_USDT_EVM RELEASE/REFUND restart convergence. Direct-call rails (unlike MULTISIG)
// have no EscrowPendingTransaction/signed-PSBT trail to reconstruct from - the durable evidence is
// WdkTransferAttempt instead, consumed here through wdkSettlementProvider's own READ-ONLY
// reconcileTerminalTransfer() (see that method's own header comment for why it never writes to
// WdkTransferAttempt or calls transfer()). SPLIT is explicitly out of this mission's scope (Issue
// #250 owns it) and falls through to the generic manual-review path below unchanged.
async function reconcileWdkTerminalTransfer(escrow: NonNullable<Awaited<ReturnType<typeof escrowRepository.findById>>>, report: ReconciliationReport): Promise<void> {
  if (escrow.status === 'SPLIT') {
    await reconcileWdkSplitTransfer(escrow, report)
    return
  }
  if (escrow.status !== 'COMPLETED' && escrow.status !== 'REFUNDED') {
    report.requiresManualReview.push({
      escrowId: escrow.id,
      reason: `WDK_USDT_EVM escrow ${escrow.id} is terminal ('${escrow.status}') with no txReleaseId, but automated restart convergence in this mission is scoped to RELEASE/REFUND/SPLIT only. Manual review required.`,
    })
    return
  }
  const operationType: 'RELEASE' | 'REFUND' = escrow.status === 'COMPLETED' ? 'RELEASE' : 'REFUND'

  const trade = await tradeRepository.findById(escrow.tradeId)
  if (!trade) {
    report.requiresManualReview.push({ escrowId: escrow.id, reason: `Trade ${escrow.tradeId} not found (WDK terminal recovery).` })
    return
  }

  // The expected destination is independently re-derived, never trusted blindly from the attempt row
  // itself (Case D) - REFUND always pays the treasury account (index 0), fully deterministic. RELEASE
  // pays the buyer's own registered PayoutAddress in the ordinary cooperative case; an arbitrated
  // release may instead carry an arbiter-supplied explicit destination that this reconciler has no
  // durable way to re-derive (a disclosed, pre-existing residual - see escrow-lifecycle.ts's own
  // resolvePayoutAddress() "AUTHORITY BOUNDARY" comment) - such a mismatch is surfaced as manual
  // review rather than either silently trusted or treated as proven corruption.
  let expectedDestination: string
  try {
    expectedDestination = operationType === 'REFUND'
      ? await wdkSettlementProvider.getAccountAddress(0)
      : await resolvePayoutAddress(undefined, trade.buyerId, escrow.asset)
  } catch (err) {
    report.requiresManualReview.push({
      escrowId: escrow.id,
      reason: `WDK ${operationType} terminal recovery for escrow ${escrow.id}: could not independently derive the expected destination (${err instanceof Error ? err.message : String(err)}) — cannot corroborate the durable attempt; manual review required.`,
    })
    return
  }

  const result = await wdkSettlementProvider.reconcileTerminalTransfer(
    { id: escrow.id, tradeId: escrow.tradeId, lockedAmount: escrow.lockedAmount.toString() },
    operationType,
    expectedDestination,
    escrow.lockedAmount.toString() // RELEASE/REFUND always transfer the full locked amount
  )

  if (result.outcome !== 'CONFIRMED') {
    report.requiresManualReview.push({
      escrowId: escrow.id,
      reason: `WDK ${operationType} terminal recovery for escrow ${escrow.id}: ${result.reason} (outcome=${result.outcome}).`,
    })
    return
  }

  // Same write-once primitive + same idempotent completion-effects path PASS 1 already uses for
  // MULTISIG above - no parallel authority system, no second write path for Escrow.txReleaseId.
  let wroteTxReleaseId = false
  try {
    wroteTxReleaseId = await withEscrowFundingLock(escrow.id, async (tx) => {
      const fresh = await tx.escrow.findUnique({ where: { id: escrow.id } })
      if (!fresh) return false
      if (operationType === 'RELEASE') {
        await escrowRepository.updateReleaseResult(escrow.id, { txReleaseId: result.txHash, releasedAt: new Date(), feeCharged: null }, { tx })
      } else {
        await escrowRepository.updateRefundResult(escrow.id, result.txHash, { tx })
      }
      return fresh.txReleaseId === null
    })
  } catch (writeErr) {
    if (writeErr instanceof SettlementResultConflictError) {
      log.error({ msg: 'WDK terminal recovery: settlement result integrity conflict - persisted evidence NOT overwritten, downstream effects NOT run', escrowId: escrow.id, err: writeErr.message })
      report.requiresManualReview.push({ escrowId: escrow.id, reason: writeErr.message })
      return
    }
    throw writeErr
  }

  log.info({ msg: 'WDK terminal recovery: convergence path determined', escrowId: escrow.id, operationType, txHash: result.txHash, wroteTxReleaseId })
  // Downstream effects still run even if wroteTxReleaseId is false (a concurrent writer - live or
  // another reconciler pass - already claimed it): emitEscrowTransition()'s own (escrowId, toStatus)
  // idempotency claim is what actually prevents a double-fire, exactly as the MULTISIG path above.
  await applyDownstreamCompletionEffects(escrow.id, escrow.tradeId, escrow.status as 'COMPLETED' | 'REFUNDED', trade.sellerId, result.txHash, escrow, null, undefined)
  report.recovered.push({ escrowId: escrow.id, txId: result.txHash, outcome: 'ALREADY_CONFIRMED' })
}

// Issue #250 - WDK_USDT_EVM SPLIT restart convergence. A SPLIT is two INDEPENDENT external transfers
// (SPLIT_BUYER, SPLIT_SELLER - distinct WdkTransferAttempt operationType, distinct activeKey, distinct
// durable identity: see wdk-transfer-attempt-repository.ts's own schema comment). The live path
// (wdk-settlement.provider.ts's splitFunds()) never attempts the seller leg until the buyer leg is
// durably CONFIRMED, so "buyer CONFIRMED, seller not started/pending/unknown" is a real, expected crash
// window, not a corruption. The FINAL settlement result is a SINGLE joined string
// (`${buyerTxHash},${sellerTxHash}` - escrow.service.ts's own splitFunds() `result.txIds.join(',')`,
// unchanged here, see persistSettlementResult()'s own write-once comparison of it) and becomes
// authoritative ONLY once BOTH legs independently classify as CONFIRMED - an externally confirmed
// PARTIAL effect (one leg) never by itself authorizes declaring the split complete, nor resubmitting
// the other leg.
async function reconcileWdkSplitTransfer(escrow: NonNullable<Awaited<ReturnType<typeof escrowRepository.findById>>>, report: ReconciliationReport): Promise<void> {
  const trade = await tradeRepository.findById(escrow.tradeId)
  if (!trade) {
    report.requiresManualReview.push({ escrowId: escrow.id, reason: `Trade ${escrow.tradeId} not found (WDK SPLIT terminal recovery).` })
    return
  }

  let buyerDestination: string
  let sellerDestination: string
  try {
    // Same "explicit trusted-internal-caller only" resolution the live splitFunds() call itself uses
    // for the cooperative (non-arbitrated) case - see reconcileWdkTerminalTransfer()'s own comment on
    // this same disclosed, pre-existing residual for an arbitrated destination override.
    buyerDestination = await resolvePayoutAddress(undefined, trade.buyerId, escrow.asset)
    sellerDestination = await resolvePayoutAddress(undefined, trade.sellerId, escrow.asset)
  } catch (err) {
    report.requiresManualReview.push({
      escrowId: escrow.id,
      reason: `WDK SPLIT terminal recovery for escrow ${escrow.id}: could not independently derive the expected buyer/seller destinations (${err instanceof Error ? err.message : String(err)}) — cannot corroborate the durable attempts; manual review required.`,
    })
    return
  }

  // No amount check inside reconcileTerminalTransfer() for either leg (see that method's own comment
  // on why buyerBps is not durably recoverable here) - classify both legs first, then apply the one
  // amount invariant that IS independently true regardless of bps, below.
  const [buyerResult, sellerResult] = await Promise.all([
    wdkSettlementProvider.reconcileTerminalTransfer({ id: escrow.id, tradeId: escrow.tradeId, lockedAmount: escrow.lockedAmount.toString() }, 'SPLIT_BUYER', buyerDestination),
    wdkSettlementProvider.reconcileTerminalTransfer({ id: escrow.id, tradeId: escrow.tradeId, lockedAmount: escrow.lockedAmount.toString() }, 'SPLIT_SELLER', sellerDestination),
  ])

  if (buyerResult.outcome !== 'CONFIRMED' || sellerResult.outcome !== 'CONFIRMED') {
    report.requiresManualReview.push({
      escrowId: escrow.id,
      reason: `WDK SPLIT terminal recovery for escrow ${escrow.id}: buyer leg ${buyerResult.outcome === 'CONFIRMED' ? `CONFIRMED (${buyerResult.txHash})` : `${buyerResult.outcome} - ${buyerResult.reason}`}; seller leg ${sellerResult.outcome === 'CONFIRMED' ? `CONFIRMED (${sellerResult.txHash})` : `${sellerResult.outcome} - ${sellerResult.reason}`}. The split is not yet fully proven — no result written, neither leg resubmitted.`,
    })
    return
  }

  // Case D - the one amount invariant independently true regardless of buyerBps: both legs' own
  // durably-recorded amounts must sum to the escrow's full locked amount. Re-reads each attempt's
  // recorded amount fresh (not trusted from the classification result above, which deliberately
  // carries no amount) so this check is against the same durable row reconcileTerminalTransfer() itself
  // just validated the destination/status of.
  const [buyerAttempt, sellerAttempt] = await Promise.all([
    wdkTransferAttemptRepository.findLatest(escrow.id, 'SPLIT_BUYER'),
    wdkTransferAttemptRepository.findLatest(escrow.id, 'SPLIT_SELLER'),
  ])
  if (!buyerAttempt || !sellerAttempt) {
    // Structurally shouldn't happen immediately after both legs classified CONFIRMED above - fail
    // closed rather than assume.
    report.requiresManualReview.push({ escrowId: escrow.id, reason: `WDK SPLIT terminal recovery for escrow ${escrow.id}: a leg attempt disappeared between classification and amount verification. Manual review required.` })
    return
  }
  const sum = new Prisma.Decimal(buyerAttempt.amount.toString()).plus(sellerAttempt.amount.toString())
  if (!sum.equals(new Prisma.Decimal(escrow.lockedAmount.toString()))) {
    report.requiresManualReview.push({
      escrowId: escrow.id,
      reason: `WDK SPLIT terminal recovery for escrow ${escrow.id}: buyer leg amount ${buyerAttempt.amount.toString()} + seller leg amount ${sellerAttempt.amount.toString()} = ${sum.toString()}, which does not equal escrow.lockedAmount ${escrow.lockedAmount.toString()} — refusing to treat these attempts as authoritative evidence.`,
    })
    return
  }

  // Buyer leg first, then seller — the exact order escrow.service.ts's own splitFunds() joins
  // result.txIds.join(',') in, so this recovered value compares byte-for-byte equal to what the live
  // path would have written, under the same write-once primitive.
  const joinedTxHash = `${buyerResult.txHash},${sellerResult.txHash}`

  let wroteTxReleaseId = false
  try {
    wroteTxReleaseId = await withEscrowFundingLock(escrow.id, async (tx) => {
      const fresh = await tx.escrow.findUnique({ where: { id: escrow.id } })
      if (!fresh) return false
      await escrowRepository.updateSplitResult(escrow.id, { txReleaseId: joinedTxHash, releasedAt: new Date() }, { tx })
      return fresh.txReleaseId === null
    })
  } catch (writeErr) {
    if (writeErr instanceof SettlementResultConflictError) {
      log.error({ msg: 'WDK SPLIT terminal recovery: settlement result integrity conflict - persisted evidence NOT overwritten, downstream effects NOT run', escrowId: escrow.id, err: writeErr.message })
      report.requiresManualReview.push({ escrowId: escrow.id, reason: writeErr.message })
      return
    }
    throw writeErr
  }

  log.info({ msg: 'WDK SPLIT terminal recovery: convergence path determined', escrowId: escrow.id, buyerTxHash: buyerResult.txHash, sellerTxHash: sellerResult.txHash, wroteTxReleaseId })
  await applyDownstreamCompletionEffects(escrow.id, escrow.tradeId, 'SPLIT', trade.sellerId, joinedTxHash, escrow, null, undefined)
  report.recovered.push({ escrowId: escrow.id, txId: joinedTxHash, outcome: 'ALREADY_CONFIRMED' })
}

// Issue #240 - LIGHTNING_HODL/SAFE_GUARD_EVM RELEASE/REFUND restart convergence. Unlike WDK_USDT_EVM
// (a self-initiated direct-call transfer with a real receipt-query primitive) or MULTISIG (Bitcoin
// broadcast is idempotent by construction and has a real explorer-based reconciliation primitive),
// neither Ark's submission protocol nor an ERC-4337 bundler's resubmission behavior is proven
// idempotent anywhere in this codebase, and neither provider exposes a verified, live-tested external
// query. This function therefore consumes ONLY the durable pre/post-submission evidence
// signature-collection-finalization-truth.ts's own ensureFinalizationAttempt()/recordFinalizationOutcome()
// already write (see that file's own header comment) - it never queries anything external itself, and
// it NEVER converges a SUBMITTED (SAFE_GUARD_EVM's bundler-accepted-but-not-chain-confirmed case) or
// SUBMISSION_UNKNOWN attempt automatically: that is this mission's own disclosed, honest limitation
// ("IMPLEMENTED but NOT PRODUCTION-ELIGIBLE for automated convergence" - Issue #240), not a gap this
// function silently papers over.
async function reconcileSignatureCollectionTerminalTransfer(escrow: NonNullable<Awaited<ReturnType<typeof escrowRepository.findById>>>, report: ReconciliationReport): Promise<void> {
  if (escrow.status !== 'COMPLETED' && escrow.status !== 'REFUNDED') {
    // Neither provider implements SPLIT (both throw UNSUPPORTED - buildUnsignedSplit()'s own comment
    // in each provider file) - structurally unreachable, but fail closed rather than assume.
    report.requiresManualReview.push({
      escrowId: escrow.id,
      reason: `${escrow.type} escrow ${escrow.id} is terminal ('${escrow.status}') with no txReleaseId, but automated restart convergence for this rail is scoped to RELEASE/REFUND only. Manual review required.`,
    })
    return
  }

  const [pending, attempt] = await Promise.all([
    prisma.escrowPendingTransaction.findUnique({ where: { escrowId: escrow.id } }),
    prisma.signatureCollectionFinalizationAttempt.findUnique({ where: { escrowId: escrow.id } }),
  ])

  if (!attempt) {
    // The finalize call was never reached - a crash strictly between claimEscrowTransition() and
    // ensureFinalizationAttempt() ever running (or before claimEscrowTransition() itself, though
    // that leaves the escrow non-terminal and never reaches this reconciler at all). No external
    // effect could possibly have happened yet, but this function has no authority to un-claim the
    // escrow's terminal status either (the same disclosed, out-of-scope residual #251/#250 already
    // carry for their own NOT_STARTED case) - surfaced for manual review.
    report.requiresManualReview.push({
      escrowId: escrow.id,
      reason: `${escrow.type} escrow ${escrow.id} is terminal ('${escrow.status}') with no txReleaseId and no durable finalization attempt exists — the finalize call was never reached. Manual review required.`,
    })
    return
  }

  if (!pending || attempt.pendingTxId !== pending.id) {
    // Case D - fail closed on any mismatch. A missing pending row here (unlike MULTISIG's own PASS 1,
    // which reconstructs from it) means this function has nothing left to bind the durable attempt to.
    report.requiresManualReview.push({
      escrowId: escrow.id,
      reason: `${escrow.type} escrow ${escrow.id}: SignatureCollectionFinalizationAttempt ${attempt.id} is bound to pending operation ${attempt.pendingTxId}, which is not the escrow's current pending transaction (${pending?.id ?? 'none'}) — refusing to treat it as authoritative evidence. Manual review required.`,
    })
    return
  }

  if (attempt.status !== 'CONFIRMED') {
    report.requiresManualReview.push({
      escrowId: escrow.id,
      reason: `${escrow.type} ${attempt.kind} finalization attempt (${attempt.id}) is ${attempt.status} — no automated external reconciliation exists for this provider (Issue #240)${attempt.txHash ? `; durable evidence so far: ${attempt.txHash}` : ''}. Manual review required.`,
    })
    return
  }
  if (!attempt.txHash) {
    report.requiresManualReview.push({ escrowId: escrow.id, reason: `${escrow.type} finalization attempt ${attempt.id} is CONFIRMED but has no persisted txHash — data integrity violation, refusing to resume. Manual review required.` })
    return
  }

  const trade = await tradeRepository.findById(escrow.tradeId)
  if (!trade) {
    report.requiresManualReview.push({ escrowId: escrow.id, reason: `Trade ${escrow.tradeId} not found (${escrow.type} terminal recovery).` })
    return
  }

  // Same write-once wrapper the LIVE submitTransactionSignature() path itself uses for every
  // signature-collection rail (updateSignatureCollectionResult -> persistSettlementResult, bound to
  // the exact live pending operation, Issue #291), and the same idempotent completion-effects path
  // PASS 1's MULTISIG branch and reconcileWdkTerminalTransfer() above already use.
  let wroteTxReleaseId = false
  try {
    wroteTxReleaseId = await withEscrowFundingLock(escrow.id, async (tx) => {
      const fresh = await tx.escrow.findUnique({ where: { id: escrow.id } })
      if (!fresh) return false
      const updateData = attempt.kind === 'refund' ? { txReleaseId: attempt.txHash! } : { txReleaseId: attempt.txHash!, releasedAt: new Date() }
      await escrowRepository.updateSignatureCollectionResult(escrow.id, updateData, { tx, operation: { pendingOperationId: pending.id } })
      return fresh.txReleaseId === null
    })
  } catch (writeErr) {
    if (writeErr instanceof SettlementResultConflictError) {
      log.error({ msg: `${escrow.type} terminal recovery: settlement result integrity conflict - persisted evidence NOT overwritten, downstream effects NOT run`, escrowId: escrow.id, err: writeErr.message })
      report.requiresManualReview.push({ escrowId: escrow.id, reason: writeErr.message })
      return
    }
    throw writeErr
  }

  log.info({ msg: `${escrow.type} terminal recovery: convergence path determined`, escrowId: escrow.id, kind: attempt.kind, txHash: attempt.txHash, wroteTxReleaseId })
  await applyDownstreamCompletionEffects(escrow.id, escrow.tradeId, escrow.status as 'COMPLETED' | 'REFUNDED', pending.triggeredBy, attempt.txHash, escrow, pending, undefined)
  report.recovered.push({ escrowId: escrow.id, txId: attempt.txHash, outcome: 'ALREADY_CONFIRMED' })
}

// NOTE (Issue #298): the EscrowEvent existence peek below decides ONLY whether the (idempotent)
// completion effects still need to run. It is NOT proof that the durable event was published or that
// its projections completed - PASS 3 (reconcileIncompleteProjections) owns that distinction.
// PASS 2 (Fase 9.7) — every rail. txReleaseId is already confirmed set
// (the fund movement itself is a settled fact); the only open question
// is whether the downstream completion chain ran. Cheap, unlocked peek
// via EscrowEvent existence — not authoritative on its own (a race is
// still possible between this peek and the actual write), but the
// actual serialization/idempotency guarantee comes from
// emitEscrowTransition()'s own atomic claim inside
// applyDownstreamCompletionEffects(), the same "cheap peek outside,
// authoritative check inside the real write" shape this codebase
// already uses for the funding-reorg sweep.
async function reconcileMissingCompletionEffects(escrow: NonNullable<Awaited<ReturnType<typeof escrowRepository.findById>>>, report: ReconciliationReport): Promise<void> {
  const alreadyEmitted = await prisma.escrowEvent.findFirst({ where: { escrowId: escrow.id, toStatus: escrow.status as any } })

  // Sails Core Implementation Program M9 (Recovery) — closes crash window
  // C13/C14 for the case PASS 1 does NOT cover: the completion event
  // ALREADY fired (Fase 9.7's own bookkeeping is NOT missing) but M6
  // correspondence for an M8-R Core-authoritative dispute was never
  // computed/recorded, because the crash landed strictly between this
  // module's own emitEscrowTransition() call and the correspondence call
  // that now follows it. This is checked and repaired INDEPENDENTLY of
  // the `alreadyEmitted` gate below — an early return on that gate must
  // never also skip this, or exactly this crash window would remain
  // silently unclosed. Cheap for the overwhelmingly common case (nothing
  // missing): one MULTISIG-and-RESOLVED-dispute check inside
  // recordLiveCorrespondenceIfApplicable() itself is a fast no-op for
  // every other escrow.
  if (escrow.type === 'MULTISIG' && escrow.txReleaseId) {
    const pendingForCorrespondence = await prisma.escrowPendingTransaction.findUnique({
      where: { escrowId: escrow.id },
      include: { signatures: true }, // the full row: the recovery broadcast gate below reads its ruling facts
    })
    let rawTxHex: string | undefined
    let reconstructionFailed = false
    if (pendingForCorrespondence) {
      const signedList = pendingForCorrespondence.requiredSigners.map(
        (id: string) => pendingForCorrespondence.signatures.find((s: { participantId: string; signedPsbtBase64: string }) => s.participantId === id)?.signedPsbtBase64
      )
      if (signedList.every((s: string | undefined): s is string => s !== undefined)) {
        const catchUpGate = recoveryBroadcastGate(pendingForCorrespondence)
        try {
          const trade = await tradeRepository.findById(escrow.tradeId)
          if (trade) {
            const { buyerPubkey, sellerPubkey, arbiterPubkey } = await loadParticipantPubkeys(escrow.id)
            const reconciled = await multisigProvider.reconcilePendingSettlement(
              {
                tradeId: trade.id, lockedAmount: escrow.lockedAmount.toString(),
                buyerId: trade.buyerId, sellerId: trade.sellerId,
                buyerPubkey, sellerPubkey, arbiterPubkey,
                txLockId: escrow.txLockId, txLockVout: escrow.txLockVout,
                id: escrow.id, multisigAddr: escrow.multisigAddr, fundedAmount: escrow.fundedAmount,
                status: escrow.status,
              },
              pendingForCorrespondence.unsignedPsbtBase64, signedList,
              catchUpGate.check
            )
            if (reconciled.outcome === 'ANOMALY' && reconciled.code === 'ROUND_INPUT_MISMATCH') {
              // CTO 25 funding binding - the persisted round does not spend this escrow's recorded funding: no
              // correspondence, fee recording or completion effects from it, and the round and signatures stay as evidence.
              log.error({ msg: 'Completion-effects catch-up: persisted round does not bind to the recorded funding - manual review, nothing recorded', escrowId: escrow.id, detail: reconciled.detail })
              report.requiresManualReview.push({ escrowId: escrow.id, reason: reconciled.detail })
              return
            }
            if (reconciled.outcome !== 'ANOMALY') rawTxHex = reconciled.rawTxHex
          }
        } catch (err) {
          reconstructionFailed = true
          if (catchUpGate.refused) {
            // GK-M9R-D R1 - the recorded transaction is not on the network and the round may not be sent: nothing here
            // completes it. No correspondence, no completion effects, no deletion: the round stays as evidence and
            // every tick refuses it again, until the chain or a human decides.
            log.error({ msg: 'PASS 2: recorded MULTISIG result not on the network and its round refused by the execution gate - not re-broadcast, manual review', escrowId: escrow.id, pendingTransactionId: pendingForCorrespondence.id, err: err instanceof Error ? err.message : String(err) })
            report.requiresManualReview.push({ escrowId: escrow.id, reason: `${err instanceof DisputedTranslationRefused ? 'DISPUTED_TRANSLATION_REFUSED' : 'EXECUTION_GATE_REFUSED'}: escrow is ${escrow.status} with txReleaseId ${escrow.txReleaseId}, but that transaction is not on the network and the round was not re-broadcast. ${err instanceof Error ? err.message : String(err)}` })
            return
          }
          log.error({ msg: 'M9: exact reconstruction for correspondence catch-up failed — proceeding without it', escrowId: escrow.id, err: err instanceof Error ? err.message : String(err) })
        }
      }
    }
    // recordLiveCorrespondenceIfApplicable() itself re-derives everything
    // it needs from the database (the RESOLVED dispute, the durable
    // Outcome) — it is not told whether this is a "recovery" call versus
    // the original happy-path call, because it does not need to be: the
    // same deterministic function, given the same historical Outcome and
    // the same real transaction bytes, always recomputes the identical
    // result and safely no-ops (MULTISIG+RESOLVED-dispute check) for
    // every escrow this mission does not migrate.
    await recordLiveCorrespondenceIfApplicable(escrow.id, escrow.tradeId, escrow.type, rawTxHex)

    // Issue #245 (Phase 2) — fee recovery, INDEPENDENT of the `alreadyEmitted` gate (like the correspondence catch-up
    // above): when the live path emitted the completion event but its fee recording failed, it kept the pending row.
    // Retry through recordBroadcastAndAdvance() (idempotent; never re-emits the event, never writes a second row), and
    // delete the row only once the recording is durable — and not while the correspondence reconstruction above still
    // needed it. The not-yet-emitted case is handled by applyDownstreamCompletionEffects() below.
    if (
      alreadyEmitted && pendingForCorrespondence && pendingForCorrespondence.kind !== 'refund' && escrow.status !== 'REFUNDED' &&
      pendingForCorrespondence.feeCollectionSats !== null && pendingForCorrespondence.feeCollectionSats !== undefined &&
      !pendingForCorrespondence.feeCollectionWaived
    ) {
      const recorded = await recordFeeBroadcast(escrow, pendingForCorrespondence.unsignedPsbtBase64, pendingForCorrespondence.feeCollectionSats, escrow.txReleaseId)
      if (recorded && !reconstructionFailed) {
        await prisma.escrowPendingTransaction.delete({ where: { id: pendingForCorrespondence.id } }).catch(() => {})
      }
    }
  }

  if (alreadyEmitted) return // nothing missing for the completion-effects concern — the overwhelmingly common case

  const trade = await tradeRepository.findById(escrow.tradeId)
  if (!trade) {
    report.requiresManualReview.push({ escrowId: escrow.id, reason: `Trade ${escrow.tradeId} not found (completion-effects catch-up).` })
    return
  }

  const targetStatus = escrow.status as 'COMPLETED' | 'REFUNDED' | 'SPLIT'
  const pendingRow = await prisma.escrowPendingTransaction.findUnique({
    where: { escrowId: escrow.id },
    select: { id: true, kind: true, feeCollectionSats: true, feeCollectionWaived: true, buyerBps: true, unsignedPsbtBase64: true, triggeredBy: true },
  })
  // triggeredBy fallback: for a direct-call-rail escrow with no pending
  // row, the original triggeredBy was never durably persisted anywhere
  // this module can read back (escrow.service.ts's direct-call
  // releaseFunds()/refundFunds()/splitFunds() don't store it on the
  // Escrow row itself) — the seller is the only party this codebase's
  // own existing precedent (sweepExpiredEscrows()'s own
  // "triggeredBy is always the trade's own sellerId, never a fabricated
  // system actor" comment) already treats as a safe, real stand-in for
  // an escrow-level action, so the same choice is reused here rather
  // than inventing a new one.
  const triggeredBy = pendingRow?.triggeredBy ?? trade.sellerId

  log.info({ msg: 'Reconciliation: recovering missing downstream completion effects (C5)', escrowId: escrow.id, targetStatus })
  // rawTxHex: undefined here — this call's own job is bookkeeping
  // catch-up, not correspondence (already independently handled above,
  // regardless of which branch of this function reaches it).
  const { obligationSkipped } = await applyDownstreamCompletionEffects(
    escrow.id, escrow.tradeId, targetStatus, triggeredBy, escrow.txReleaseId!, escrow, pendingRow ?? null, undefined
  )
  report.completionEffectsRecovered.push({ escrowId: escrow.id, obligationSkipped })
}

// ─── PASS 3 (Issue #298) - incomplete PROJECTIONS of a claimed escrow transition ──────────────
//
// Three distinct facts must never be conflated:
//   1. the transition was CLAIMED        (EscrowEvent + a 'transition.claimed' marker, one transaction)
//   2. the durable event was PUBLISHED   (a durable_events row carrying the same transitionId)
//   3. its projections were APPLIED      (a 'transition.projected' marker, written by the handlers
//                                         only after every projection of that event succeeded)
// PASS 2 above treats "EscrowEvent exists" as proof of 2 and 3; it is neither. This pass finds
// transitions that are claimed but not projected (older than a grace period, so a live in-flight
// handler is not raced) and RE-DRIVES the canonical event:
//   - no durable event yet (crash between claim and publish) -> re-publish it;
//   - durable event exists (crash/loss during projection)     -> redeliver it to the handlers.
// Neither path writes to foreign modules: the handlers own their projections, and every projection
// is idempotent per (source transition, projectionKey, subject), so redelivery completes what is missing and
// never repeats what already committed. Publish is serialized per transition so two workers cannot
// mint two durable events (two delivery identities) for one transition.
const PROJECTION_RECOVERY_GRACE_MS = 5 * 60 * 1000
const PROJECTION_RECOVERY_BATCH = 200
const PROJECTION_RECOVERY_MAX_PAGES = 50

// Bound per invocation: BATCH x MAX_PAGES = 10,000 INCOMPLETE transitions. Only incomplete ones (claimed and NOT yet
// projected) are paged - completed history never consumes the budget. Because a permanently stuck transition stays
// incomplete forever, every invocation resumes AFTER where the previous one stopped (a per-process rotating cursor)
// and wraps to the oldest only after a short page, so a backlog larger than the bound is worked through across ticks
// instead of the same first 10,000 stuck rows being revisited forever. The cursor is a pure optimization: correctness
// of each re-drive comes from the per-transition advisory lock and the projection-claim identity, not from it.
let projectionRecoveryCursor: { appliedAt: Date; id: string } | null = null

export async function reconcileIncompleteProjections(report: ReconciliationReport, graceMs: number, opts: { maxPages?: number } = {}): Promise<void> {
  const cutoff = new Date(Date.now() - graceMs)
  const maxPages = opts.maxPages ?? PROJECTION_RECOVERY_MAX_PAGES
  for (let page = 0; page < maxPages; page++) {
    const after = projectionRecoveryCursor
    const claimed = await prisma.$queryRaw<Array<{ id: string; eventId: string; subjectId: string; appliedAt: Date }>>`
      SELECT c.id, c."eventId", c."subjectId", c."appliedAt"
      FROM event_projection_claims c
      WHERE c."projectionKey" = ${TRANSITION_CLAIMED_KEY}
        AND c."appliedAt" < ${cutoff}
        AND (${after === null} OR (c."appliedAt", c.id) > (${after?.appliedAt ?? new Date(0)}, ${after?.id ?? ''}))
        AND NOT EXISTS (
          SELECT 1 FROM event_projection_claims p
          WHERE p."projectionKey" = ${TRANSITION_PROJECTED_KEY} AND p."subjectId" = c."eventId")
      ORDER BY c."appliedAt" ASC, c.id ASC
      LIMIT ${PROJECTION_RECOVERY_BATCH}`
    if (claimed.length === 0) { projectionRecoveryCursor = null; return }
    const last = claimed[claimed.length - 1]
    projectionRecoveryCursor = { appliedAt: last.appliedAt, id: last.id }
    await redriveClaimedPage(claimed, report)
    if (claimed.length < PROJECTION_RECOVERY_BATCH) { projectionRecoveryCursor = null; return }
  }
  // Bound reached: keep the cursor so the next invocation continues from here.
}

async function redriveClaimedPage(claimed: Array<{ id: string; eventId: string; subjectId: string }>, report: ReconciliationReport): Promise<void> {

  const projected = await prisma.eventProjectionClaim.findMany({
    where: { projectionKey: TRANSITION_PROJECTED_KEY, subjectId: { in: claimed.map((c) => c.eventId) } },
    select: { subjectId: true },
  })
  const done = new Set(projected.map((p) => p.subjectId))

  for (const claim of claimed) {
    const transitionId = claim.eventId // for transition markers eventId holds the EscrowEvent (transition) id
    if (done.has(transitionId)) continue
    try {
      const transition = await prisma.escrowEvent.findUnique({ where: { id: transitionId } })
      if (!transition) continue
      const eventName = EVENT_NAME_BY_TARGET_STATUS[transition.toStatus as string]
      const escrow = await prisma.escrow.findUnique({ where: { id: transition.escrowId } })
      if (!eventName || !escrow) continue

      const action = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'transition-publish:' + transitionId})::bigint)`
        const existing = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM durable_events
          WHERE "correlationId" = ${escrow.tradeId} AND "eventName" = ${eventName} AND payload->>'transitionId' = ${transitionId}
          ORDER BY "publishedAt" ASC LIMIT 1`
        if (existing.length === 0) {
          await eventBus.emit(eventName as any, {
            escrowId: escrow.id,
            tradeId: escrow.tradeId,
            from: transition.fromStatus,
            to: transition.toStatus,
            triggeredBy: transition.triggeredBy,
            ...(escrow.txReleaseId ? { txId: escrow.txReleaseId } : {}),
            transitionId,
          } as any, escrow.tradeId)
          return 'REPUBLISHED' as const
        }
        await eventBus.redeliver(existing[0].id)
        return 'REDELIVERED' as const
      }, { timeout: 30_000 })

      log.info({ msg: 'PASS 3: re-drove an incompletely projected escrow transition', escrowId: escrow.id, transitionId, action })
      report.projectionsRecovered.push({ escrowId: escrow.id, transitionId, action })
    } catch (err) {
      report.failed.push({ escrowId: claim.subjectId, error: err instanceof Error ? err.message : String(err) })
    }
  }
}

/**
 * The main entry point — call periodically (same operational shape as
 * sweepExpiredEscrows()/sweepMultisigFundingReorgs(): a plain async
 * function, not wired to an HTTP route, callable from a cron/ops
 * process). Idempotent by construction on both passes: PASS 1 only ever
 * returns an escrow whose txReleaseId is still null (an already-
 * converged escrow is structurally excluded from a later run); PASS 2's
 * actual double-fire protection is emitEscrowTransition()'s own atomic
 * per-transition claim, not this function's own peek.
 */
// ─── Issue #239 - external funding-spend watch (MULTISIG) ─────────────────────
// A signing round's signatures are handed to its signers, so a round Sails never finished (or retired) can still
// be completed and broadcast outside Sails. This pass watches the funding outpoint of every non-terminal MULTISIG
// escrow that has, or had, a round. It converges ONLY a live, cooperative, not-fully-signed round proven
// byte-identical and signed by exactly its required signers, through the same primitives every other pass uses
// (claim + write-once result in one locked transaction, then applyDownstreamCompletionEffects()). Everything else
// is reported, never claimed and never classified FAILED. Fully signed rounds stay PASS 0's.
const EXTERNAL_SPEND_BATCH = 50
// The watch is explorer I/O (one to three reads per candidate, each up to the explorer timeout), so it never holds
// up the recovery passes: it runs last, at most once per EXTERNAL_SPEND_MIN_INTERVAL_MS (the default reconcile
// interval), and stops within EXTERNAL_SPEND_TICK_BUDGET_MS, the cursor resuming where it stopped.
const EXTERNAL_SPEND_TICK_BUDGET_MS = 15_000
const EXTERNAL_SPEND_MIN_INTERVAL_MS = 60_000
let externalSpendCursor: string | null = null
let lastExternalSpendRunAt = 0
const TERMINAL_FOR_SPEND_WATCH = ['COMPLETED', 'REFUNDED', 'SPLIT']
const TARGET_BY_KIND: Record<string, 'COMPLETED' | 'REFUNDED' | 'SPLIT'> = { release: 'COMPLETED', refund: 'REFUNDED', split: 'SPLIT' }

/** Test-only: restart the bounded watch from the first escrow, as if it had never run. */
export function resetExternalSpendCursor(): void {
  externalSpendCursor = null
  lastExternalSpendRunAt = 0
}

async function reconcileExternalFundingSpends(report: ReconciliationReport): Promise<void> {
  const started = Date.now()
  const page = await prisma.escrow.findMany({
    where: {
      type: 'MULTISIG',
      status: { notIn: TERMINAL_FOR_SPEND_WATCH as any },
      txLockId: { not: null },
      txLockVout: { not: null },
      OR: [{ pendingTransaction: { isNot: null } }, { pendingRoundRetirements: { some: {} } }],
      ...(externalSpendCursor ? { id: { gt: externalSpendCursor } } : {}),
    },
    orderBy: { id: 'asc' },
    take: EXTERNAL_SPEND_BATCH,
    select: { id: true },
  })
  // Keyset cursor, a pure optimization (same shape as the projection recovery cursor): the next tick resumes after
  // this page (or after the last escrow checked, when the time budget ran out), and an incomplete page starts over.
  externalSpendCursor = page.length === EXTERNAL_SPEND_BATCH ? page[page.length - 1].id : null
  let lastChecked: string | null = null
  for (const { id } of page) {
    if (Date.now() - started > EXTERNAL_SPEND_TICK_BUDGET_MS) {
      externalSpendCursor = lastChecked
      break
    }
    lastChecked = id
    try {
      await watchFundingSpend(id, report)
    } catch (err) {
      if (isLostEscrowClaim(err)) {
        report.alreadyClaimedConcurrently.push(id)
        continue
      }
      report.failed.push({ escrowId: id, error: err instanceof Error ? err.message : String(err) })
    }
  }
}

async function watchFundingSpend(escrowId: string, report: ReconciliationReport): Promise<void> {
  const escrow = await prisma.escrow.findUnique({ where: { id: escrowId } })
  if (!escrow || escrow.txLockId === null || escrow.txLockVout === null) return
  let spend: Awaited<ReturnType<typeof fetchOutpointSpendStatus>>
  try {
    spend = await fetchOutpointSpendStatus(escrow.txLockId, escrow.txLockVout)
  } catch {
    report.externalSpendUnreadable.push(escrowId)
    return
  }
  if (!spend.spent) return
  const txId = spend.spendingTxid
  if (!txId) {
    report.requiresManualReview.push({ escrowId, reason: `AMBIGUOUS: funding outpoint ${escrow.txLockId}:${escrow.txLockVout} is spent, but the explorer reported no spending txid.` })
    return
  }
  // Mempool never authorizes a claim (CTO threshold: 1 confirmation). Once claimed, a later reorg is the release
  // reorg sweep's (multisig-release-reorg-sweep.ts), which watches txReleaseId from its first confirmed observation.
  let confirmation: Awaited<ReturnType<typeof fetchTransactionConfirmationStatus>>
  try {
    confirmation = await fetchTransactionConfirmationStatus(txId)
  } catch {
    report.externalSpendUnreadable.push(escrowId)
    return
  }
  if (!confirmation.confirmed) {
    report.externalSpendPendingConfirmation.push(escrowId)
    return
  }

  const network = networkFor(config.multisig.network)
  const live = await prisma.escrowPendingTransaction.findUnique({ where: { escrowId }, include: { signatures: true } })
  if (live && roundUnsignedTxid(live.unsignedPsbtBase64, network) === txId) {
    if (isFullySigned(live)) return // PASS 0 converges it (ALREADY_BROADCAST)
    if (live.disputeId) {
      report.requiresManualReview.push({ escrowId, reason: `Disputed round ${live.id} was completed outside Sails by ${txId}; automatic convergence would drop its dispute provenance from the settlement event — manual review.` })
      return
    }
    await convergeExternallyCompletedRound(escrow, live, txId, network, report)
    return
  }
  const retired = await prisma.escrowPendingRoundRetirement.findFirst({ where: { escrowId, unsignedTxid: txId } })
  if (retired) {
    report.requiresManualReview.push({ escrowId, reason: `RETIRED_ROUND_EXECUTED_EXTERNALLY: retired round ${retired.pendingOperationId} (${retired.reason}, retirement ${retired.id}, digest ${retired.operationDigest}) spent the funding outpoint in confirmed transaction ${txId}.` })
    return
  }
  report.requiresManualReview.push({ escrowId, reason: `AMBIGUOUS: funding outpoint ${escrow.txLockId}:${escrow.txLockVout} was spent by confirmed transaction ${txId}, which matches no round of this escrow.` })
}

async function convergeExternallyCompletedRound(
  escrow: { id: string; tradeId: string; txLockId: string | null; txLockVout: number | null },
  live: Prisma.EscrowPendingTransactionGetPayload<{ include: { signatures: true } }>,
  txId: string,
  network: ReturnType<typeof networkFor>,
  report: ReconciliationReport
): Promise<void> {
  let hex: string
  try {
    hex = await fetchTransactionHex(txId)
  } catch {
    report.externalSpendUnreadable.push(escrow.id)
    return
  }
  const keys = await prisma.escrowParticipantKey.findMany({ where: { escrowId: escrow.id } })
  const scriptKeys = ['buyer', 'seller', 'arbiter'].map((role) => keys.find((k) => k.role === role)?.pubkey)
  const requiredKeys = live.requiredSigners.map((id) => keys.find((k) => k.participantId === id && k.role !== 'arbiter')?.pubkey)
  if (scriptKeys.some((k) => !k) || requiredKeys.some((k) => !k)) {
    report.requiresManualReview.push({ escrowId: escrow.id, reason: `External spend ${txId} of round ${live.id}: participant keys are incomplete, nothing can be proven.` })
    return
  }
  const proof = proveExternalCompletion({
    spendingTxHex: hex, spendingTxid: txId, unsignedPsbtBase64: live.unsignedPsbtBase64,
    fundingTxid: escrow.txLockId!, fundingVout: escrow.txLockVout!,
    scriptPubkeysHex: scriptKeys as string[], requiredSignerPubkeysHex: requiredKeys as string[], network,
  })
  if (!proof.ok) {
    report.requiresManualReview.push({ escrowId: escrow.id, reason: `External spend ${txId} of round ${live.id} is not proven to be this round: ${proof.reason}.` })
    return
  }

  const targetStatus = TARGET_BY_KIND[live.kind]
  const decision = await withEscrowFundingLock(escrow.id, async (tx) => {
    const current = await tx.escrow.findUnique({ where: { id: escrow.id } })
    if (!current || current.txReleaseId || TERMINAL_FOR_SPEND_WATCH.includes(current.status)) return { kind: 'skip' as const }
    if (await escrowFundingEvidenceService.isFundingUncertain(escrow.id, tx)) return { kind: 'uncertain' as const }
    const round = await tx.escrowPendingTransaction.findFirst({ where: { id: live.id, escrowId: escrow.id }, include: { signatures: true } })
    if (!round || capabilityOperationDigest(round) !== capabilityOperationDigest(live)) {
      return { kind: 'review' as const, reason: `round ${live.id} changed while its external spend ${txId} was being proven` }
    }
    if (isFullySigned(round)) return { kind: 'skip' as const }
    try {
      await assertCooperativeOriginProvable(round, tx)
    } catch (err) {
      if (err instanceof CooperativeOriginNotProvable) return { kind: 'review' as const, reason: err.message }
      throw err
    }
    if (!(VALID_TRANSITIONS[current.status] ?? []).includes(targetStatus)) {
      return { kind: 'review' as const, reason: `external spend ${txId} completed a ${round.kind} round, but ${current.status} → ${targetStatus} is not an allowed transition` }
    }
    // Claim and write-once result commit together: no window leaves the escrow terminal without txReleaseId,
    // which PASS 1 could not rebuild from partial signatures.
    await claimEscrowTransition(escrow.id, current.status, targetStatus, tx)
    await escrowRepository.updateSignatureCollectionResult(
      escrow.id,
      targetStatus === 'REFUNDED' ? { txReleaseId: txId } : { txReleaseId: txId, releasedAt: new Date() },
      { tx, operation: { pendingOperationId: round.id } }
    )
    return { kind: 'converged' as const, round }
  })
  if (decision.kind === 'skip') return
  if (decision.kind === 'uncertain') {
    report.externalSpendFundingUncertain.push(escrow.id)
    return
  }
  if (decision.kind === 'review') {
    report.requiresManualReview.push({ escrowId: escrow.id, reason: `External spend not converged: ${decision.reason}.` })
    return
  }
  const settled = await escrowRepository.findById(escrow.id)
  const note = `Completed externally: transaction ${txId} was broadcast outside Sails; byte identity and the signatures of [${live.requiredSigners.join(', ')}] were verified by settlement reconciliation (Issue #239).`
  await applyDownstreamCompletionEffects(escrow.id, escrow.tradeId, targetStatus, decision.round.triggeredBy, txId, settled!, decision.round, hex, note)
  report.externallyCompleted.push({ escrowId: escrow.id, txId })
}

export async function reconcilePendingSettlements(options: { projectionGraceMs?: number; externalSpendMinIntervalMs?: number } = {}): Promise<ReconciliationReport> {
  const report: ReconciliationReport = {
    recovered: [], completionEffectsRecovered: [], requiresManualReview: [], failed: [],
    resumedUnclaimed: [], alreadyClaimedConcurrently: [], projectionsRecovered: [], rulingFinalizationsRecovered: [], rulingFinalizationsDeferred: [], disputeArbitersRecovered: [],
    heldIncompatibleRounds: [], externallyCompleted: [], externalSpendUnreadable: [], externalSpendPendingConfirmation: [], externalSpendFundingUncertain: [],
  }

  await reconcileUnclaimedFullySignedPending(report)

  const txReleaseIdCandidates = await escrowRepository.findTerminalWithoutTxReleaseId()
  for (const escrow of txReleaseIdCandidates) {
    try {
      await reconcileTxReleaseId(escrow, report)
    } catch (err) {
      report.failed.push({ escrowId: escrow.id, error: err instanceof Error ? err.message : String(err) })
    }
  }

  const completionEffectCandidates = await escrowRepository.findTerminalWithTxReleaseId()
  for (const escrow of completionEffectCandidates) {
    try {
      await reconcileMissingCompletionEffects(escrow, report)
    } catch (err) {
      report.failed.push({ escrowId: escrow.id, error: err instanceof Error ? err.message : String(err) })
    }
  }

  await reconcileIncompleteProjections(report, options.projectionGraceMs ?? PROJECTION_RECOVERY_GRACE_MS)

  // Issue #253 - arbiter ruling finalization has its own claim (dispute.service.ts) and nothing else retries it
  // once the dispute is RESOLVED, so this tick is what re-drives a finalization that never committed.
  // Required lazily: dispute.service.ts depends on this module's escrow machinery.
  try {
    const { getDisputeService } = require('./dispute.service') // eslint-disable-line @typescript-eslint/no-var-requires
    const { recovered, deferred, failed, held } = await getDisputeService().recoverMissingRulingFinalization()
    report.rulingFinalizationsRecovered.push(...recovered)
    report.rulingFinalizationsDeferred.push(...deferred)
    for (const id of held) report.requiresManualReview.push({ escrowId: `dispute:${id}`, reason: 'Ruling resolved before finalization was recorded, with no proof its bookkeeping ran: held from automatic recovery.' })
    for (const f of failed) report.failed.push({ escrowId: `dispute:${f.disputeId}`, error: f.error })
  } catch (err) {
    report.failed.push({ escrowId: 'dispute:*', error: err instanceof Error ? err.message : String(err) })
  }

  // Issue #238 - an opened dispute whose process died before its arbiter was assigned. Fail-closed until then.
  try {
    const { getDisputeService } = require('./dispute.service') // eslint-disable-line @typescript-eslint/no-var-requires
    const { recovered, failed } = await getDisputeService().recoverUnassignedDisputes()
    report.disputeArbitersRecovered.push(...recovered)
    for (const f of failed) report.failed.push({ escrowId: `dispute:${f.disputeId}`, error: f.error })
  } catch (err) {
    report.failed.push({ escrowId: 'dispute:*', error: err instanceof Error ? err.message : String(err) })
  }

  try {
    for (const { effectId, escrowId } of await listHeldSettlementProvenance()) {
      report.requiresManualReview.push({ escrowId, reason: `Settlement ${effectId} has a Dispute but no immutable provenance: reputation outcomes held for a human decision.` })
    }
  } catch (err) {
    report.failed.push({ escrowId: 'settlement-provenance:*', error: err instanceof Error ? err.message : String(err) })
  }

  // Issue #239 - the external funding-spend watch runs last (PASS 0 above owns fully signed rounds), throttled and
  // time-boxed so its explorer I/O never delays the recovery passes above.
  if (Date.now() - lastExternalSpendRunAt >= (options.externalSpendMinIntervalMs ?? EXTERNAL_SPEND_MIN_INTERVAL_MS)) {
    lastExternalSpendRunAt = Date.now()
    try {
      await reconcileExternalFundingSpends(report)
    } catch (err) {
      report.failed.push({ escrowId: 'external-spend:*', error: err instanceof Error ? err.message : String(err) })
    }
  }

  return report
}
