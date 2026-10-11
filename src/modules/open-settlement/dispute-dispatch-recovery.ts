/**
 * dispute-dispatch-recovery.ts — Sails Core Implementation Program M9-R
 * (Recovery Closure), Part 2. Closes crash window C4, found during the
 * M9 analytical gate: a dispute ruling can commit its durable,
 * Core-authoritative Outcome (`SemanticTransitionRecord`, via
 * `commitAuthoritativeDisputeRuling()`) and then the process can die
 * BEFORE `initiateRelease()`/`initiateRefund()`/`initiateSplit()` ever
 * persists the unsigned PSBT — leaving a RESOLVED Dispute with a
 * committed Outcome, a non-terminal escrow, and no
 * `EscrowPendingTransaction` row at all. Nothing in Mission11's own
 * reconciliation (`escrow-settlement-reconciliation.service.ts`, both
 * passes require a TERMINAL escrow) or M9's stale-pending cleanup
 * (`dispute-pending-reconciliation.ts`, requires an EXISTING pending
 * row) ever looks at this combination. `resolveDispute()`'s own top-level
 * guard (`dispute.status === 'RESOLVED'` -> reject) also means the
 * client cannot simply retry the original request.
 *
 * WHAT THIS MODULE DOES NOT DO (mission's own explicit constraints):
 *   - Never re-runs discretionary authority. The arbiter does not sign
 *     again — `commitAuthoritativeDisputeRuling()`'s Ed25519 verification
 *     already happened once, durably, at ruling time; this module never
 *     calls it again and never asks for a new signature.
 *   - Never reinterprets the ruling. `record.outcome.content` (ruling,
 *     allocations, remainder) is loaded verbatim from the durably
 *     committed `SemanticTransitionRecord` — never re-derived from
 *     current request parameters (there is no current request).
 *   - Never re-resolves the beneficiary destination from CURRENT
 *     `PayoutAddress` state. `record.outcome.destinationBinding.reference`
 *     is the historical snapshot taken atomically at ruling-commit time
 *     (`dispute-outcome.ts`'s own `resolveBeneficiaryDestination()`); this
 *     module passes those values as the EXPLICIT address argument to
 *     `initiateRelease`/`initiateRefund`/`initiateSplit`, which (per
 *     `resolvePayoutAddress()`'s own `if (explicitAddress) return
 *     explicitAddress` short-circuit) means the current PayoutAddress
 *     table is never consulted for this dispatch.
 *
 * WHAT THIS MODULE DOES: reuses the EXACT same real entry points a live
 * ruling already uses (`escrowService.initiateRelease/Refund/Split`,
 * `assertDisputeDispatchEligible`, `assertTranslationMatchesOutcome`) —
 * this is "recovery is derived from facts," not a parallel dispatch
 * mechanism. The verb is RESUME_AUTHORIZED_DISPATCH: build the
 * previously-never-built PSBT from an authorization that was already,
 * durably, and independently verified — never RETRY_DISPUTE,
 * RE-RUN_AUTHORITY, or RE-RUN_RESOLVE_DISPUTE.
 *
 * DUPLICATE WORKERS: `initiateSignatureCollectionCore()` (escrow-pending-tx.ts)
 * already has a real, durable `@@unique(escrowId)` constraint on
 * `EscrowPendingTransaction`, enforced inside `withEscrowFundingLock()`'s
 * own `pg_advisory_xact_lock`. Two workers racing the same C4 escrow both
 * reach that same real write path; exactly one wins, the other gets a
 * `P2002` that `initiateSignatureCollectionCore()` converts into an
 * `EscrowError` ("...already has a pending transaction... (concurrent
 * initiate)"). This module treats that specific, recognizable error as a
 * benign "someone else already resumed this" outcome, never a failure —
 * no new locking primitive was invented; the existing one is reused.
 *
 * BOUNDED PASSES (M9-R bounded recovery): one invocation attempts at most
 * `limit` dispatches. The candidate predicate is evaluated in SQL, so
 * already-dispatched and legacy disputes are never loaded or re-checked
 * row by row. A candidate whose dispatch keeps failing (for example an
 * unreachable explorer, or a revoked capability grant) is still retried on
 * every sweep, but it can no longer make every pass do work proportional
 * to the whole failing backlog. Fair order comes from
 * `Dispute.dispatchRecoveryAttemptedAt`: see `claimCandidates()`.
 */
import { prisma } from '../../common/database'
import { config } from '../../config'
import { EscrowError, NotFoundError } from '../../common/errors'
import { escrowService } from './escrow.service'
import { tradeRepository } from '../open-p2p/trade-repository'
import { loadDisputeRulingRecord, fromDisputeRulingRow } from './dispute-outcome'
import { evaluateDisputeDispatchEligibility } from './dispute-dispatch'
import { blocksRulingDispatch } from './pending-round-supersession'
import { assertTranslationMatchesOutcome, TranslationGuardError } from './dispatch-translation-guard'
import { networkFor } from './multisig.provider'
import { deletePendingRoundIfStillUnsigned } from './dispute-pending-reconciliation'
import { ESCROW_DISPUTE_RULING_TRANSITION_TYPE } from './discretionary-authority'
import { childLogger } from '../../common/logger'

const log = childLogger('dispute-dispatch-recovery')

/**
 * Upper bound on dispatch attempts per invocation. The bound is on
 * attempts, not rows scanned, because each attempt can do external I/O:
 * the MULTISIG explorer UTXO lookup, up to 3 x MULTISIG_EXPLORER_TIMEOUT_MS
 * during an explorer outage. At the defaults that caps one pass at about
 * 10 x 24s even when every attempt times out. A C4 crash is rare, so a
 * larger backlog is simply worked through over later sweeps.
 */
export const DISPATCH_RECOVERY_BATCH = 10

export interface DispatchRecoveryReport {
  /** Escrow ids claimed by this invocation, in queue order. Never longer than `limit`. */
  claimed: string[]
  resumed: Array<{ escrowId: string; disputeId: string; ruling: 'RELEASE' | 'REFUND' | 'SPLIT' }>
  alreadyResumedConcurrently: string[]
  notEligible: Array<{ escrowId: string; reason: string }>
  guardFailed: Array<{ escrowId: string; mismatches: readonly string[] }>
  failed: Array<{ escrowId: string; error: string }>
}

function isConcurrentPendingConflict(err: unknown): boolean {
  return err instanceof EscrowError && /already has a pending/i.test(err.message)
}

interface ClaimedCandidate {
  id: string
  escrowId: string
  escrowTradeId: string
  appealRound: number
  arbiterId: string | null
  queueKey: Date
}

/**
 * Candidate predicate: a RESOLVED Dispute on a MULTISIG escrow that is NOT
 * terminal, has NO surviving `EscrowPendingTransaction` row, and has a
 * durable Core-authoritative ruling record with an Outcome. This is the
 * durable fact combination C4 leaves behind — nothing else in this
 * codebase's own model can produce it except a crash in exactly that
 * window (a live, successful ruling always reaches at least the pending-
 * transaction write before returning to the caller). The predicate is the
 * same one the previous in-memory loop applied, now evaluated in SQL.
 *
 * Order is strict round-robin by queue key =
 * COALESCE(dispatchRecoveryAttemptedAt, resolvedAt, createdAt), ties
 * broken by id. Claiming a candidate stamps it in the same statement, which
 * moves it behind every candidate not attempted since. Starvation-free:
 * only candidates with a smaller key are ahead of a given one, that set is
 * finite, and each of them moves behind it once it is served. So every
 * candidate is attempted within ceil(ahead / limit) sweeps, however large
 * the history and however many other candidates keep failing. A crash
 * after the stamp commits costs one queue turn, never the candidate itself:
 * the stamp decides order only, and eligibility is re-derived below from
 * durable facts on every attempt. SKIP LOCKED gives two concurrent workers
 * disjoint batches while their claims overlap in time. It is not what
 * prevents duplicate dispatch; EscrowPendingTransaction's unique constraint
 * still is (see header).
 */
async function claimCandidates(limit: number): Promise<ClaimedCandidate[]> {
  const stampedAt = new Date()
  const claimed = await prisma.$queryRaw<ClaimedCandidate[]>`
    WITH picked AS (
      SELECT d.id, e."tradeId" AS "escrowTradeId",
             COALESCE(d."dispatchRecoveryAttemptedAt", d."resolvedAt", d."createdAt") AS "queueKey"
      FROM disputes d
      JOIN escrows e ON e.id = d."escrowId"
      WHERE d.status = 'RESOLVED'
        AND e.type = 'MULTISIG'
        AND e.status NOT IN ('COMPLETED', 'REFUNDED', 'SPLIT')
        -- #239 - a dispatch exists if the escrow has an arbitrated round, or a fully signed one (never
        -- superseded); a cooperative round missing a signature is dead and is superseded by the resume.
        AND NOT EXISTS (SELECT 1 FROM escrow_pending_transactions p WHERE p."escrowId" = d."escrowId"
          AND (p."disputeId" IS NOT NULL
               OR cardinality(p."requiredSigners") <= (SELECT count(*) FROM escrow_transaction_signatures s WHERE s."pendingTxId" = p.id)))
        AND EXISTS (
          SELECT 1 FROM semantic_transition_records r
          WHERE r."interactionId" = d."escrowId"
            AND r."transitionType" = ${ESCROW_DISPUTE_RULING_TRANSITION_TYPE}
            AND r."appealRound" = d."appealRound"
            AND r."outcomeContent" IS NOT NULL AND r."outcomeContent" <> 'null'::jsonb)
      ORDER BY "queueKey" ASC, d.id ASC
      LIMIT ${limit}
      FOR UPDATE OF d SKIP LOCKED
    )
    UPDATE disputes d SET "dispatchRecoveryAttemptedAt" = ${stampedAt}
    FROM picked
    WHERE d.id = picked.id
    RETURNING d.id, d."escrowId", picked."escrowTradeId", d."appealRound", d."arbiterId", picked."queueKey"`
  // RETURNING carries no order guarantee — restore the queue order.
  return claimed.sort((a, b) => a.queueKey.getTime() - b.queueKey.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export async function reconcileMissingDispatch(limit: number = DISPATCH_RECOVERY_BATCH): Promise<DispatchRecoveryReport> {
  const report: DispatchRecoveryReport = { claimed: [], resumed: [], alreadyResumedConcurrently: [], notEligible: [], guardFailed: [], failed: [] }

  const candidates = await claimCandidates(limit)
  report.claimed = candidates.map((c) => c.escrowId)

  for (const dispute of candidates) {
    try {
      const existingPending = await prisma.escrowPendingTransaction.findUnique({ where: { escrowId: dispute.escrowId }, include: { signatures: { select: { participantId: true } } } })
      // not a C4 case at all — dispatch already happened; a different reconciler owns whatever state it's in.
      // #239 - except a dead cooperative round, which is no dispatch: the resume below supersedes it (or,
      // for a potentially exposed legacy round, fails closed and is reported - #239D).
      if (existingPending && blocksRulingDispatch(existingPending)) continue

      const row = await loadDisputeRulingRecord(dispute.escrowId, dispute.appealRound)
      if (!row || !row.outcomeContent) continue // not a Core-authoritative-path ruling (legacy applyRuling()) — out of this module's scope, not a gap

      const record = fromDisputeRulingRow(row)
      if (!record.outcome) {
        report.failed.push({ escrowId: dispute.escrowId, error: 'durable record has outcomeContent but fromDisputeRulingRow() produced no Outcome' })
        continue
      }
      const outcome = record.outcome

      // Re-evaluate dispatch eligibility from DURABLE FACTS ONLY — this
      // checks attribution+outcome presence and the same
      // not-already-dispatched signal a live ruling would have checked
      // (EscrowPendingTransaction existence OR terminal status) — it does
      // NOT re-verify the arbiter's signature (already verified once,
      // durably, at commit time) and does NOT accept any new input.
      const eligibility = await evaluateDisputeDispatchEligibility(dispute.escrowId, dispute.appealRound)
      if (!eligibility.eligible) {
        report.notEligible.push({ escrowId: dispute.escrowId, reason: eligibility.reason })
        continue
      }

      const trade = await tradeRepository.findById(dispute.escrowTradeId)
      if (!trade) {
        report.failed.push({ escrowId: dispute.escrowId, error: `Trade ${dispute.escrowTradeId} not found` })
        continue
      }

      const destinations = outcome.destinationBinding?.reference ?? []
      const buyerDestination = destinations.find((d) => d.beneficiary === trade.buyerId)?.destination
      const sellerDestination = destinations.find((d) => d.beneficiary === trade.sellerId)?.destination
      const ruling = outcome.content.ruling

      // Sails Core Implementation Program M9-R — the calling identity for
      // this RESUME action is the historically-committed arbiter
      // (`dispute.arbiterId`, the same identity `commitAuthoritativeDisputeRuling()`
      // already verified and durably recorded as `attributionActor`) —
      // never a fabricated system actor. This is NOT re-running
      // discretionary authority: no signature is requested or checked
      // here, this identity is used only for the ordinary
      // caller-authorization/capability checks `initiateRelease/Refund/Split`
      // already run for every caller, live or recovered alike.
      const triggeredBy = dispute.arbiterId
      if (!triggeredBy) {
        report.failed.push({ escrowId: dispute.escrowId, error: 'RESOLVED dispute has no recorded arbiterId — cannot resume dispatch under a real identity' })
        continue
      }

      let pending: Awaited<ReturnType<typeof escrowService.initiateRelease>>
      try {
        if (ruling === 'RELEASE') {
          pending = await escrowService.initiateRelease(dispute.escrowId, buyerDestination, triggeredBy)
        } else if (ruling === 'REFUND') {
          // M8-RF (Destination Consistency) — the SAME historical
          // sellerDestination (already extracted above from the durable
          // Outcome's own destinationBinding) governs a RESUMED REFUND
          // dispatch exactly as it governs a live one — never re-derived
          // from the seller's multisig key, never re-read from current
          // PayoutAddress state.
          pending = await escrowService.initiateRefund(dispute.escrowId, triggeredBy, sellerDestination)
        } else {
          const buyerBps = outcome.content.allocations.find((a) => a.beneficiary === trade.buyerId)?.basisPoints
          if (buyerBps === undefined) {
            report.failed.push({ escrowId: dispute.escrowId, error: 'SPLIT outcome has no buyer allocation — cannot resume dispatch' })
            continue
          }
          pending = await escrowService.initiateSplit(dispute.escrowId, buyerDestination, sellerDestination, buyerBps, triggeredBy)
        }
      } catch (err) {
        if (isConcurrentPendingConflict(err)) {
          report.alreadyResumedConcurrently.push(dispute.escrowId)
          continue
        }
        throw err
      }

      // Same guard `applyRulingCoreAuthoritative()` itself runs before
      // ever letting a dispatch become collectible — proves the
      // just-resumed translation still corresponds to the same
      // historical Outcome, using the SAME real check, not a new one.
      const network = networkFor(config.multisig.network)
      try {
        assertTranslationMatchesOutcome(pending.unsignedPsbtBase64, outcome, network, pending.minerFeeSats ?? undefined)
      } catch (guardErr) {
        const generation = pending.disputeId && pending.rulingAppealRound !== null &&
          pending.rulingArbiterId && pending.rulingOutcome &&
          pending.rulingAuthoritySignature && pending.rulingAuthorityIssuedAt
          ? {
              disputeId: pending.disputeId,
              rulingAppealRound: pending.rulingAppealRound,
              rulingArbiterId: pending.rulingArbiterId,
              rulingOutcome: pending.rulingOutcome,
              rulingAuthoritySignature: pending.rulingAuthoritySignature,
              rulingAuthorityIssuedAt: pending.rulingAuthorityIssuedAt,
            }
          : undefined
        const deletion = await deletePendingRoundIfStillUnsigned(pending.id, dispute.escrowId, generation)
        if (deletion !== 'DELETED') {
          report.failed.push({
            escrowId: dispute.escrowId,
            error: `ST1-R2 guard rejection; exact pending preserved: ${deletion}`,
          })
          log.error({ msg: 'ST1-R2: guarded C4 deletion refused; pending preserved', escrowId: dispute.escrowId, pendingId: pending.id, deletion })
          continue
        }
        const mismatches = guardErr instanceof TranslationGuardError ? guardErr.mismatches : [guardErr instanceof Error ? guardErr.message : String(guardErr)]
        report.guardFailed.push({ escrowId: dispute.escrowId, mismatches })
        log.error({ msg: 'M9-R: resumed dispatch failed re-validation against its own durable Outcome — deleted, zero signatures collected yet, no fund-movement risk', escrowId: dispute.escrowId, mismatches })
        continue
      }

      log.info({ msg: 'M9-R: resumed authorized dispatch for a dispute ruling whose original dispatch never persisted (C4 recovery)', escrowId: dispute.escrowId, disputeId: dispute.id, ruling })
      report.resumed.push({ escrowId: dispute.escrowId, disputeId: dispute.id, ruling })
    } catch (err) {
      if (err instanceof NotFoundError) {
        report.failed.push({ escrowId: dispute.escrowId, error: err.message })
      } else {
        report.failed.push({ escrowId: dispute.escrowId, error: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  return report
}
