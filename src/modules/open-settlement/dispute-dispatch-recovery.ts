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
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '../../common/database'
import { config } from '../../config'
import { EscrowError, NotFoundError } from '../../common/errors'
import { escrowService } from './escrow.service'
import { tradeRepository } from '../open-p2p/trade-repository'
import { loadDisputeRulingRecord, fromDisputeRulingRow } from './dispute-outcome'
import { evaluateDisputeDispatchEligibility, isSupersedableCooperativeRound, issueRulingSupersessionGrant } from './dispute-dispatch'
import { assertTranslationMatchesOutcome, TranslationGuardError } from './dispatch-translation-guard'
import { networkFor } from './multisig.provider'
import { ESCROW_DISPUTE_RULING_TRANSITION_TYPE } from './discretionary-authority'
import { childLogger } from '../../common/logger'

const log = childLogger('dispute-dispatch-recovery')

const TERMINAL_ESCROW_STATUSES = ['COMPLETED', 'REFUNDED', 'SPLIT'] as const

export interface DispatchRecoveryReport {
  resumed: Array<{ escrowId: string; disputeId: string; ruling: 'RELEASE' | 'REFUND' | 'SPLIT' }>
  alreadyResumedConcurrently: string[]
  notEligible: Array<{ escrowId: string; reason: string }>
  guardFailed: Array<{ escrowId: string; mismatches: readonly string[] }>
  failed: Array<{ escrowId: string; error: string }>
  /** Bounded runs only (see DispatchRecoveryOptions): how many candidates this call took on, and why it stopped. */
  budget?: { processed: number; stoppedBy: 'MAX_CANDIDATES' | 'BUDGET_MS' | 'SWEEP_COMPLETE' }
}

/**
 * PE-M9R-B - a bounded run, so recovery cannot monopolize a reconciler tick however large the backlog is:
 *   - at most `maxCandidates` candidates are loaded and taken on per call;
 *   - no new candidate (and no new page) is started once `budgetMs` has elapsed. A candidate already started always
 *     finishes: its dispatch is never cut off mid-transaction, so a call can overrun by one candidate's duration,
 *     itself bounded by the explorer request timeout (MULTISIG_EXPLORER_TIMEOUT_MS) of the calls it makes.
 * Fairness: calls continue round-robin from the last candidate taken on by THIS process, wrap once to the start, and
 * stop after one full circle, so every eligible candidate - failing ones included, and ones added mid-sweep - is taken
 * on within ceil(eligible / maxCandidates) + 1 calls, and never twice in one call. The position is process-local and
 * starts at a random point, so a restart (or another instance) does not keep favoring the head of the list; several
 * instances may take on the same candidate, which the dispatch path already makes harmless (one pending round per
 * escrow, the concurrent loser reported in alreadyResumedConcurrently). Without options the call is unbounded and
 * starts from the beginning, exactly as before.
 */
export interface DispatchRecoveryOptions {
  maxCandidates: number
  budgetMs: number
  /** Injectable clock (milliseconds), for deterministic tests. */
  now?: () => number
}

let boundedRunCursor: string = randomUUID()

/** Tests only: where the next bounded run of this process resumes ('' = the start of the candidate order). */
export function setDispatchRecoveryCursor(afterId: string): void {
  boundedRunCursor = afterId
}

function isConcurrentPendingConflict(err: unknown): boolean {
  return err instanceof EscrowError && /already has a pending/i.test(err.message)
}

/**
 * Candidate query: a RESOLVED Dispute on a MULTISIG escrow that is NOT terminal, whose Core-authoritative ruling
 * record exists, and whose dispatch never persisted - no `EscrowPendingTransaction` row, or (#239) only a
 * cooperative round still missing a signature, which this ruling supersedes. This is the durable fact combination
 * C4 leaves behind (a live, successful ruling always reaches the pending-transaction write before returning).
 *
 * Issue #343 - selected in SQL, one keyset page at a time, so the cost follows unresolved recovery work, never
 * retained history: dispatched, legacy (no Core record) and settled disputes are never loaded or probed one by one.
 */
const CANDIDATE_PAGE = 100
const CANDIDATE_INCLUDE = { escrow: { include: { pendingTransaction: { include: { signatures: true } } } } } as const
type CandidateDispute = Prisma.DisputeGetPayload<{ include: typeof CANDIDATE_INCLUDE }>

// `upTo` bounds the page from above (inclusive) in the database's own order, never JavaScript's: a bounded run closes its
// circle with it, and string order in JS need not match the column collation.
async function candidatePage(afterId: string, limit = CANDIDATE_PAGE, upTo: string | null = null): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT d.id FROM disputes d
    JOIN escrows e ON e.id = d."escrowId"
    LEFT JOIN escrow_pending_transactions p ON p."escrowId" = e.id
    WHERE d.status = 'RESOLVED' AND e.type = 'MULTISIG'
      AND e.status NOT IN ('COMPLETED', 'REFUNDED', 'SPLIT')
      AND EXISTS (SELECT 1 FROM semantic_transition_records r
                  WHERE r."interactionId" = d."escrowId" AND r."transitionType" = ${ESCROW_DISPUTE_RULING_TRANSITION_TYPE}
                    AND r."appealRound" = d."appealRound" AND r."outcomeContent" IS NOT NULL)
      AND (p.id IS NULL OR (p."disputeId" IS NULL AND EXISTS (
            SELECT 1 FROM unnest(p."requiredSigners") AS required(id)
            WHERE NOT EXISTS (SELECT 1 FROM escrow_transaction_signatures s WHERE s."pendingTxId" = p.id AND s."participantId" = required.id))))
      AND d.id > ${afterId}
      AND (${upTo}::text IS NULL OR d.id <= ${upTo}::text)
    ORDER BY d.id
    LIMIT ${limit}`
  return rows.map((r) => r.id)
}

async function loadCandidates(ids: string[]): Promise<CandidateDispute[]> {
  return prisma.dispute.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' }, include: CANDIDATE_INCLUDE })
}

async function boundedRun(options: DispatchRecoveryOptions, report: DispatchRecoveryReport): Promise<void> {
  const now = options.now ?? Date.now
  const deadline = now() + options.budgetMs
  const start = boundedRunCursor
  const fromBeginning = start === '' // nothing to wrap back to: the sweep simply ends at the end of the order
  let after = start
  let wrapped = false
  let processed = 0
  let stoppedBy: NonNullable<DispatchRecoveryReport['budget']>['stoppedBy'] = 'SWEEP_COMPLETE'
  sweep: for (;;) {
    if (processed >= options.maxCandidates) { stoppedBy = 'MAX_CANDIDATES'; break }
    if (now() >= deadline) { stoppedBy = 'BUDGET_MS'; break }
    const limit = Math.min(CANDIDATE_PAGE, options.maxCandidates - processed)
    // Past the end: wrap once to the start; after the wrap, the page stops at the starting point, closing the circle.
    const ids = await candidatePage(after, limit, wrapped ? start : null)
    if (ids.length === 0) {
      if (wrapped || fromBeginning) break
      wrapped = true
      after = ''
      continue
    }
    for (const dispute of await loadCandidates(ids)) {
      if (processed >= options.maxCandidates) { stoppedBy = 'MAX_CANDIDATES'; break sweep }
      if (now() >= deadline) { stoppedBy = 'BUDGET_MS'; break sweep }
      await resumeCandidate(dispute, report)
      processed++
      boundedRunCursor = dispute.id
    }
    after = ids[ids.length - 1]
    if (ids.length < limit && (wrapped || fromBeginning)) break // the end of the order (or of the circle) was reached
  }
  report.budget = { processed, stoppedBy }
}

export async function reconcileMissingDispatch(options?: DispatchRecoveryOptions): Promise<DispatchRecoveryReport> {
  const report: DispatchRecoveryReport = { resumed: [], alreadyResumedConcurrently: [], notEligible: [], guardFailed: [], failed: [] }
  if (options) {
    await boundedRun(options, report)
    return report
  }

  for (let afterId = ''; ;) {
    const ids = await candidatePage(afterId)
    if (ids.length === 0) break
    afterId = ids[ids.length - 1]
    const page = await prisma.dispute.findMany({
      where: { id: { in: ids } },
      orderBy: { id: 'asc' },
      include: CANDIDATE_INCLUDE,
    })
    for (const dispute of page) await resumeCandidate(dispute, report)
    if (ids.length < CANDIDATE_PAGE) break
  }

  return report
}

async function resumeCandidate(dispute: CandidateDispute, report: DispatchRecoveryReport): Promise<void> {
  try {
    const existingPending = dispute.escrow.pendingTransaction
    // Not a C4 case: dispatch already happened, a different reconciler owns that state. Issue #239: except a
    // cooperative MULTISIG round that is not fully signed - this ruling's dispatch supersedes it.
    if (existingPending && !(dispute.escrow.type === 'MULTISIG' && isSupersedableCooperativeRound(existingPending))) return

    const row = await loadDisputeRulingRecord(dispute.escrowId, dispute.appealRound)
    if (!row || !row.outcomeContent) return // not a Core-authoritative-path ruling (legacy applyRuling()) — out of this module's scope, not a gap

    const record = fromDisputeRulingRow(row)
    if (!record.outcome) {
      report.failed.push({ escrowId: dispute.escrowId, error: 'durable record has outcomeContent but fromDisputeRulingRow() produced no Outcome' })
      return
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
      return
    }

    const trade = await tradeRepository.findById(dispute.escrow.tradeId)
    if (!trade) {
      report.failed.push({ escrowId: dispute.escrowId, error: `Trade ${dispute.escrow.tradeId} not found` })
      return
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
      return
    }

    // Issue #239 (A-1) - only when a cooperative round is in the way; re-validated under the escrow lock.
    const supersession = existingPending ? issueRulingSupersessionGrant(dispute) : undefined
    let pending: { unsignedPsbtBase64: string; minerFeeSats: number | null }
    try {
      if (ruling === 'RELEASE') {
        pending = await escrowService.initiateRelease(dispute.escrowId, buyerDestination, triggeredBy, supersession)
      } else if (ruling === 'REFUND') {
        // M8-RF (Destination Consistency) — the SAME historical
        // sellerDestination (already extracted above from the durable
        // Outcome's own destinationBinding) governs a RESUMED REFUND
        // dispatch exactly as it governs a live one — never re-derived
        // from the seller's multisig key, never re-read from current
        // PayoutAddress state.
        pending = await escrowService.initiateRefund(dispute.escrowId, triggeredBy, sellerDestination, supersession)
      } else {
        const buyerBps = outcome.content.allocations.find((a) => a.beneficiary === trade.buyerId)?.basisPoints
        if (buyerBps === undefined) {
          report.failed.push({ escrowId: dispute.escrowId, error: 'SPLIT outcome has no buyer allocation — cannot resume dispatch' })
          return
        }
        pending = await escrowService.initiateSplit(dispute.escrowId, buyerDestination, sellerDestination, buyerBps, triggeredBy, supersession)
      }
    } catch (err) {
      if (isConcurrentPendingConflict(err)) {
        report.alreadyResumedConcurrently.push(dispute.escrowId)
        return
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
      await prisma.escrowPendingTransaction.deleteMany({ where: { escrowId: dispute.escrowId } })
      const mismatches = guardErr instanceof TranslationGuardError ? guardErr.mismatches : [guardErr instanceof Error ? guardErr.message : String(guardErr)]
      report.guardFailed.push({ escrowId: dispute.escrowId, mismatches })
      log.error({ msg: 'M9-R: resumed dispatch failed re-validation against its own durable Outcome — deleted, zero signatures collected yet, no fund-movement risk', escrowId: dispute.escrowId, mismatches })
      return
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
