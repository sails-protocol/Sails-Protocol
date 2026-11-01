/**
 * MultisigReleaseReorgSweep — Sails Core Implementation Program M9-F
 * (Release-Leg Finality & Reorg Closure).
 *
 * Closes C18, the one recovery gap M9-R's own final report explicitly
 * disclosed rather than silently claimed closed: a previously observed/
 * confirmed main MULTISIG payout transaction (Escrow.txReleaseId — the
 * RELEASE/REFUND/SPLIT buyer/seller leg, not the fee sub-output) can
 * later disappear from the canonical Bitcoin chain because of a reorg,
 * with nothing in this codebase ever noticing. `multisig-fee-reorg-sweep.ts`
 * only monitors the FEE sub-output (via FeeCollectionEvidence, itself
 * keyed off a real fee collection actually happening) — a REFUND (never
 * has a fee output at all) or a fee-waived RELEASE/SPLIT had, and until
 * this file, still has, zero reorg coverage for their own main payout.
 *
 * OBSERVATION ≠ FINALITY (mission §3): this sweep NEVER mutates or
 * deletes a prior EscrowReleaseEvidence row. A reorg is always recorded
 * as a NEW fact ("this txid was later found gone"), never a correction
 * of the historical "T was observed confirmed at height H" fact. It also
 * NEVER touches CorrespondenceEvaluation — a correspondence result that
 * was MATCH when evaluated against the real, decoded transaction bytes
 * stays MATCH; this sweep answers a different, later question (is that
 * same execution still canonically included) that correspondence was
 * never designed to re-answer.
 *
 * REORG ≠ DIVERGENCE (mission §4): nothing here ever writes DIVERGENT,
 * reinterprets the Outcome, or claims the destination/authority became
 * invalid. A reorg changes the current ledger-inclusion status of an
 * already-authorized, already-correspondence-evaluated execution — never
 * its economic meaning.
 *
 * CHAIN TRUTH DOMINATES (mission §5, reusing the M9-R rule): this sweep
 * never trusts a cached "it was CONFIRMED at recognition time" belief —
 * every run re-asks the real explorer (fetchTransactionExistence for the
 * release txid itself, fetchOutpointSpendStatus for the ORIGINAL funding
 * outpoint when the release txid is no longer found).
 *
 * WHAT THIS SWEEP DOES NOT DO (deliberately, disclosed in the mission's
 * own final report, not silently omitted): it does NOT automatically
 * rebroadcast a replacement transaction when the confirmed release
 * disappears and the funding outpoint is found still unspent (World C).
 * Doing so safely would require replaying the EXACT, byte-identical
 * historically-broadcast transaction (mission §10's own "RECOVERY
 * REPLAYS AUTHORIZED EXECUTION, RECOVERY DOES NOT REAUTHORIZE ECONOMIC
 * INTENT") — but the raw finalized transaction bytes are NOT durably
 * persisted anywhere past `EscrowPendingTransaction`'s own cleanup
 * (deleted the moment the settlement completes, by
 * `applyDownstreamCompletionEffects()`/`submitTransactionSignature()`).
 * Reconstructing a NEW transaction from current state (current
 * PayoutAddress, current fee config) would not be "replaying T" — it
 * would be authorizing a new, merely semantically-equivalent execution,
 * which this program's own constitutional boundary (mission §20)
 * forbids without a genuinely new authority decision. World C is
 * therefore recorded and flagged for MANUAL review, identically to
 * World D (conflict) — a real, bounded residual, not a silently
 * papered-over one. See this mission's own final report §10/§33/§34.
 *
 * BOUNDED AND IDEMPOTENT: the chain tip is fetched once per pass. Only
 * escrows whose latest evidence is not buried past the safety window are
 * re-checked (buried = latest is OBSERVED_CONFIRMED/RECONFIRMED at a
 * height deeper than the window), plus at most BASELINE_BATCH_SIZE
 * escrows that have no evidence yet (see claimBaselineBatch()) — so the
 * first pass after enabling this sweep never walks the whole release
 * history at once. Explorer observations happen outside any transaction; every
 * write then happens under the escrow's lock and only if the escrow's
 * latest evidence row is still the one the observation was made against
 * (otherwise the observation is stale and discarded as `superseded`).
 * An unresolved condition (REORGED_INVALIDATED, or AMBIGUOUS for the same
 * conflicting spend) is recorded once and then reported as
 * `alreadyFlagged`, never re-recorded every pass.
 */
import type { EscrowFundingEvidenceKind } from '@prisma/client'
import { prisma } from '../../common/database'
import { config } from '../../config'
import { childLogger } from '../../common/logger'
import { escrowReleaseEvidenceRepository } from './escrow-release-evidence-repository'
import { withEscrowFundingLock } from './escrow-lifecycle'
import { fetchTransactionExistence, fetchTransactionConfirmationStatus, fetchChainTipHeight, fetchOutpointSpendStatus } from './multisig.provider'

const log = childLogger('multisig-release-reorg-sweep')

/** At most this many escrows with no release evidence yet are observed for the first time per pass. */
export const BASELINE_BATCH_SIZE = 50

export interface ReleaseReorgSweepResult {
  observedBaseline: string[]
  reconfirmed: string[]
  stillGood: string[]
  stillPending: string[]
  // The escrow's latest evidence changed after it was observed (a concurrent pass or node wrote first) — the stale observation was discarded.
  superseded: string[]
  // The unresolved condition this pass observed is already durably recorded — nothing new written.
  alreadyFlagged: string[]
  requiresManualReview: Array<{ escrowId: string; reason: string }>
  failed: Array<{ escrowId: string; error: string }>
}

interface ReleaseCandidate {
  id: string
  txReleaseId: string
  txLockId: string | null
  txLockVout: number | null
  lastEvidenceId: string | null
  lastKind: EscrowFundingEvidenceKind | null
  lastTxid: string | null
}

export async function sweepMultisigReleaseReorgs(): Promise<ReleaseReorgSweepResult> {
  const result: ReleaseReorgSweepResult = {
    observedBaseline: [], reconfirmed: [], stillGood: [], stillPending: [], superseded: [], alreadyFlagged: [], requiresManualReview: [], failed: [],
  }

  // No explorer call at all while there is nothing that could ever need checking.
  const [{ any }] = await prisma.$queryRaw<Array<{ any: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM escrows e
      WHERE e.type = 'MULTISIG' AND e.status IN ('COMPLETED', 'REFUNDED', 'SPLIT') AND e."txReleaseId" IS NOT NULL
    ) AS "any"`
  if (!any) return result

  const tipHeight = await fetchChainTipHeight()
  // depth = tip - observedAtHeight + 1; still inside the window while depth <= window.
  const lowestInWindow = tipHeight - config.trade.multisigReorgSafetyWindowBlocks + 1

  const monitored = await prisma.$queryRaw<ReleaseCandidate[]>`
    SELECT e.id, e."txReleaseId", e."txLockId", e."txLockVout",
           l.id AS "lastEvidenceId", l.kind::text AS "lastKind", l.txid AS "lastTxid"
    FROM escrows e
    JOIN LATERAL (
      SELECT r.id, r.kind, r.txid, r."observedAtHeight" FROM escrow_release_evidence r
      WHERE r."escrowId" = e.id
      ORDER BY r."recordedAt" DESC, r.id COLLATE "C" DESC LIMIT 1
    ) l ON true
    WHERE e.type = 'MULTISIG' AND e.status IN ('COMPLETED', 'REFUNDED', 'SPLIT') AND e."txReleaseId" IS NOT NULL
      AND NOT (l.kind IN ('OBSERVED_CONFIRMED', 'RECONFIRMED') AND l."observedAtHeight" IS NOT NULL AND l."observedAtHeight" < ${lowestInWindow})`

  const baseline = await claimBaselineBatch()

  for (const escrow of [...monitored, ...baseline]) {
    try {
      await checkReleaseLeg(escrow, tipHeight, result)
    } catch (err) {
      // World E (explorer UNKNOWN/unavailable) lands here via the thrown
      // EscrowError every fetch* helper raises on a non-404 failure —
      // never coerced into "absent," never silently retried as success.
      result.failed.push({ escrowId: escrow.id, error: err instanceof Error ? err.message : String(err) })
    }
  }

  if (result.requiresManualReview.length || result.reconfirmed.length || result.failed.length) {
    log.info({
      msg: 'MULTISIG release-leg reorg sweep completed',
      observedBaseline: result.observedBaseline.length,
      reconfirmed: result.reconfirmed.length,
      stillGood: result.stillGood.length,
      stillPending: result.stillPending.length,
      superseded: result.superseded.length,
      alreadyFlagged: result.alreadyFlagged.length,
      requiresManualReview: result.requiresManualReview.length,
      failed: result.failed.length,
    })
  }

  return result
}

/**
 * Claims the next escrows that still have no release evidence at all
 * (typically the whole release history when this sweep is first enabled,
 * then each newly settled escrow), and stamps them in the same statement.
 *
 * Order: never-attempted escrows first, newest release first (a fresh
 * release is the one a reorg can still take away), then escrows already
 * attempted without success (still unconfirmed, or the explorer failed),
 * least recently attempted first. A row that keeps failing therefore
 * moves behind every other candidate instead of holding a slot, and the
 * stamp is durable, so the order survives restarts. SKIP LOCKED gives two
 * concurrent nodes disjoint batches; it only saves duplicate explorer
 * work — duplicate evidence is prevented by recordIfLatestUnchanged().
 * The stamp decides order only: a crash after it commits costs the escrow
 * one turn, never its observation.
 */
async function claimBaselineBatch(): Promise<ReleaseCandidate[]> {
  const stampedAt = new Date()
  return prisma.$queryRaw<ReleaseCandidate[]>`
    WITH picked AS (
      SELECT e.id, e."releaseBaselineAttemptedAt" AS "attemptedAt", COALESCE(e."releasedAt", e."updatedAt") AS "settledAt"
      FROM escrows e
      WHERE e.type = 'MULTISIG' AND e.status IN ('COMPLETED', 'REFUNDED', 'SPLIT') AND e."txReleaseId" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM escrow_release_evidence r WHERE r."escrowId" = e.id)
      ORDER BY e."releaseBaselineAttemptedAt" ASC NULLS FIRST, COALESCE(e."releasedAt", e."updatedAt") DESC, e.id
      LIMIT ${BASELINE_BATCH_SIZE}
      FOR UPDATE OF e SKIP LOCKED
    )
    UPDATE escrows e SET "releaseBaselineAttemptedAt" = ${stampedAt}
    FROM picked
    WHERE e.id = picked.id
    RETURNING e.id, e."txReleaseId", e."txLockId", e."txLockVout",
              NULL::text AS "lastEvidenceId", NULL::text AS "lastKind", NULL::text AS "lastTxid"`
}

async function checkReleaseLeg(escrow: ReleaseCandidate, tipHeight: number, result: ReleaseReorgSweepResult): Promise<void> {
  const { txReleaseId } = escrow

  const existence = await fetchTransactionExistence(txReleaseId)
  if (existence.exists) {
    if (!existence.confirmed) {
      // World B — mempool-only. Not yet a reorg concern (nothing was
      // ever confirmed to reorg away); nothing to record yet.
      result.stillPending.push(escrow.id)
      return
    }
    // World A — canonical and confirmed.
    if (escrow.lastEvidenceId === null || escrow.lastKind === 'REORGED_INVALIDATED' || escrow.lastKind === 'AMBIGUOUS') {
      // No evidence yet: nothing in the release/refund/split dispatch
      // path waits for or records confirmation depth at broadcast time
      // (by design — settlement completion does not block on
      // confirmations), so this sweep is the FIRST real observer for this
      // leg and records an honest, contemporaneous baseline, never a
      // fabricated retroactive one. After REORGED_INVALIDATED/AMBIGUOUS:
      // the SAME (or, per World F, a re-appeared) txid is confirmed again
      // — a real, new fact, never a silent correction of the earlier row.
      const status = await fetchTransactionConfirmationStatus(txReleaseId)
      const kind = escrow.lastEvidenceId === null ? 'OBSERVED_CONFIRMED' : 'RECONFIRMED'
      const recorded = await recordIfLatestUnchanged(escrow, {
        kind, txid: txReleaseId,
        ...(status.blockHeight !== null ? { observedAtHeight: status.blockHeight } : {}),
        tipHeightAtObservation: tipHeight,
      })
      if (!recorded) result.superseded.push(escrow.id)
      else if (kind === 'OBSERVED_CONFIRMED') result.observedBaseline.push(escrow.id)
      else result.reconfirmed.push(escrow.id)
    } else {
      result.stillGood.push(escrow.id)
    }
    return
  }

  // existence.exists === false — genuinely absent from the network
  // (fetchTransactionExistence distinguishes a real 404 from every
  // other failure mode, which throws instead — see that function's
  // own header). World C or World D — determined by asking the
  // ORIGINAL funding outpoint's own current spend status, a durable
  // fact (Escrow.txLockId/txLockVout) that never changes regardless
  // of what happened to the release transaction itself.
  if (escrow.txLockId === null || escrow.txLockVout === null) {
    // Legacy escrow with no recorded vout — never guess which output
    // to check. Fails closed, exactly this codebase's own established
    // discipline for an unresolvable outpoint identity.
    result.requiresManualReview.push({ escrowId: escrow.id, reason: `Release txid ${txReleaseId} is no longer observed on chain, but this escrow has no recorded funding vout to check for a conflicting spend — cannot safely classify.` })
    return
  }

  const outspend = await fetchOutpointSpendStatus(escrow.txLockId, escrow.txLockVout)
  if (!outspend.spent) {
    // World C — funding outpoint still unspent. The confirmed release
    // genuinely disappeared. Recorded and flagged — NOT auto-
    // rebroadcast (see this file's own header for why: the raw
    // finalized transaction bytes do not survive past pending-row
    // cleanup, so there is no exact T left to safely replay).
    if (escrow.lastKind === 'REORGED_INVALIDATED') {
      result.alreadyFlagged.push(escrow.id)
      return
    }
    const recorded = await recordIfLatestUnchanged(escrow, {
      kind: 'REORGED_INVALIDATED', txid: txReleaseId, tipHeightAtObservation: tipHeight,
      note: 'Release transaction no longer observed on chain and its funding outpoint is unspent — exact rebroadcast is not possible (raw finalized transaction bytes are not durably persisted past settlement completion). Manual review required.',
    })
    if (!recorded) result.superseded.push(escrow.id)
    else result.requiresManualReview.push({ escrowId: escrow.id, reason: `Release transaction ${txReleaseId} disappeared (reorg) and funding outpoint ${escrow.txLockId}:${escrow.txLockVout} is unspent — cannot safely auto-recover; see recorded evidence.` })
  } else if (outspend.spendingTxid === txReleaseId) {
    // Explorer inconsistency (existence check 404'd, outspend lookup
    // confirms the SAME txid actually did spend it) — a transient
    // indexing lag, not a genuine reorg. Converges without recording
    // a spurious REORGED_INVALIDATED fact.
    result.stillGood.push(escrow.id)
  } else {
    // World D — the funding outpoint was spent by something OTHER
    // than the escrow's own authorized release transaction. A real
    // conflict — never silently reinterpreted as success, never
    // auto-resolved.
    if (escrow.lastKind === 'AMBIGUOUS' && escrow.lastTxid === (outspend.spendingTxid ?? null)) {
      result.alreadyFlagged.push(escrow.id)
      return
    }
    const recorded = await recordIfLatestUnchanged(escrow, {
      kind: 'AMBIGUOUS', txid: outspend.spendingTxid ?? undefined, tipHeightAtObservation: tipHeight,
      note: `Funding outpoint ${escrow.txLockId}:${escrow.txLockVout} was spent by ${outspend.spendingTxid ?? '(unknown txid)'}, not the escrow's own authorized release transaction ${txReleaseId}. Manual review required.`,
    })
    if (!recorded) result.superseded.push(escrow.id)
    else result.requiresManualReview.push({ escrowId: escrow.id, reason: `Funding outpoint spent by an unexpected transaction (${outspend.spendingTxid ?? 'unknown'}), not the authorized release ${txReleaseId}.` })
  }
}

/**
 * Records `input` under the escrow's lock, but only if the escrow's latest
 * release evidence is still the row the observation was made against —
 * a concurrent pass or another node that wrote first makes this
 * observation stale, and it is discarded instead of written again.
 */
async function recordIfLatestUnchanged(
  escrow: ReleaseCandidate,
  input: { kind: EscrowFundingEvidenceKind; txid?: string; observedAtHeight?: number; tipHeightAtObservation: number; note?: string }
): Promise<boolean> {
  return withEscrowFundingLock(escrow.id, async (tx) => {
    const history = await escrowReleaseEvidenceRepository.listForEscrow(escrow.id, tx)
    if ((latestRow(history)?.id ?? null) !== escrow.lastEvidenceId) return false
    await escrowReleaseEvidenceRepository.record({ escrowId: escrow.id, ...input }, tx)
    return true
  })
}

/** Latest by (recordedAt, id) — the same order the candidate query uses, so equal timestamps never disagree. */
function latestRow<T extends { id: string; recordedAt: Date }>(rows: T[]): T | undefined {
  return rows.reduce<T | undefined>((latest, row) => {
    if (!latest) return row
    const byTime = row.recordedAt.getTime() - latest.recordedAt.getTime()
    return byTime > 0 || (byTime === 0 && row.id > latest.id) ? row : latest
  }, undefined)
}
