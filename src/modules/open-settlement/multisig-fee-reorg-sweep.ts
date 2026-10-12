/**
 * MultisigFeeReorgSweep — Missão 11 Fase 8.1 LB-08.
 *
 * The DETECTION half of fee-collection reorg handling. The REVERT/FLAG
 * logic already existed before this file (fee-collection-recognition.
 * service.ts's recordReorgAndRevert(), written in Fase 5 §8) with exactly
 * the right semantics: auto-revert COLLECTED -> IN_PROGRESS when safe,
 * refuse to auto-revert an already-DISTRIBUTED obligation and flag it as
 * an exceptional reconciliation condition instead. Nothing in the
 * codebase ever called it — this sweep is that missing caller, not a new
 * economic-state design. No schema change, no new FeeObligation status.
 *
 * Re-checks only COLLECTED/DISTRIBUTED MULTISIG obligations whose last
 * CONFIRMED evidence is still within config.trade.multisigReorgSafetyWindowBlocks
 * of the current chain tip — once buried deep enough, a further reorg is
 * not a real operational concern this sweep needs to keep re-checking
 * forever (see that config field's own comment for the 100-block
 * justification).
 *
 * What this sweep intentionally does NOT do: reinterpret DROPPED/REPLACED
 * transactions, attempt to detect a transaction reappearing at a
 * DIFFERENT height (the exact same txid remaining confirmed — even at a
 * shifted height — does not invalidate the output/amount/script already
 * verified against it at recognition time), or improvise any financial
 * reversal beyond the pre-existing COLLECTED -> IN_PROGRESS edge.
 *
 * Bounded per pass: the chain tip is fetched once, and one query selects
 * only the obligations whose latest CONFIRMED generation is still inside
 * the window (plus any with no usable CONFIRMED evidence, which are
 * reported as failed). Obligations buried deeper are never loaded, so a
 * pass's explorer calls and row work scale with the window, not with the
 * whole fee history. There is deliberately no row cap: every obligation
 * inside the window must be re-checked before it leaves it.
 *
 * Each observation is handed to recordReorgAndRevert() together with the
 * confirmation generation it was made against; that method re-checks the
 * generation under the obligation's row lock, so a concurrent pass, a
 * restarted node or a stale observation cannot duplicate REORGED_OUT or
 * revert a newer generation.
 */
import { prisma } from '../../common/database'
import { config } from '../../config'
import { childLogger } from '../../common/logger'
import { feeCollectionRecognitionService } from './fee-collection-recognition.service'
import { fetchTransactionConfirmationStatus, fetchChainTipHeight } from './multisig.provider'

const log = childLogger('multisig-fee-reorg-sweep')

export interface ReorgSweepResult {
  reverted: string[]
  flaggedDistributed: string[]
  // A reorg of this generation was already recorded (by an earlier pass or a concurrent node) — nothing new written.
  alreadyRecorded: string[]
  // The obligation changed after it was observed (a newer confirmation generation, or no longer COLLECTED/DISTRIBUTED) — the stale observation was discarded.
  superseded: string[]
  stillGood: string[]
  failed: Array<{ feeObligationId: string; error: string }>
}

interface WindowCandidate {
  feeObligationId: string
  confirmationId: string | null
  txid: string | null
  confirmedAtHeight: number | null
}

export async function sweepMultisigFeeReorgs(): Promise<ReorgSweepResult> {
  const result: ReorgSweepResult = { reverted: [], flaggedDistributed: [], alreadyRecorded: [], superseded: [], stillGood: [], failed: [] }

  // No explorer call at all while there is nothing that could ever need re-checking.
  const [{ any }] = await prisma.$queryRaw<Array<{ any: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM fee_obligations fo JOIN escrows e ON e.id = fo."escrowId"
      WHERE fo."collectionStatus" IN ('COLLECTED', 'DISTRIBUTED') AND e.type = 'MULTISIG'
    ) AS "any"`
  if (!any) return result

  // Fetched once per sweep run, not once per obligation — the chain tip
  // doesn't meaningfully change mid-sweep, and this avoids N redundant
  // explorer calls for a sweep covering many obligations.
  const tipHeight = await fetchChainTipHeight()
  // depth = tip - confirmedAtHeight + 1; still inside the window while depth <= window.
  const lowestInWindow = tipHeight - config.trade.multisigReorgSafetyWindowBlocks + 1

  const candidates = await prisma.$queryRaw<WindowCandidate[]>`
    SELECT fo.id AS "feeObligationId", c.id AS "confirmationId", c.txid, c."confirmedAtHeight"
    FROM fee_obligations fo
    JOIN escrows e ON e.id = fo."escrowId"
    LEFT JOIN LATERAL (
      SELECT ev.id, ev.txid, ev."confirmedAtHeight" FROM fee_collection_evidence ev
      WHERE ev."feeObligationId" = fo.id AND ev.kind = 'CONFIRMED'
      ORDER BY ev."recordedAt" DESC, ev.id COLLATE "C" DESC LIMIT 1
    ) c ON true
    WHERE fo."collectionStatus" IN ('COLLECTED', 'DISTRIBUTED') AND e.type = 'MULTISIG'
      AND (c.txid IS NULL OR c."confirmedAtHeight" IS NULL OR c."confirmedAtHeight" >= ${lowestInWindow})`

  for (const candidate of candidates) {
    const { feeObligationId, confirmationId, txid } = candidate
    try {
      if (!confirmationId || !txid || candidate.confirmedAtHeight === null) {
        // Structurally shouldn't happen — recognizeConfirmation() always
        // writes txid+confirmedAtHeight together in the same transaction
        // that sets COLLECTED. Logged, not silently skipped.
        result.failed.push({ feeObligationId, error: 'COLLECTED/DISTRIBUTED with no usable CONFIRMED evidence (missing txid/confirmedAtHeight)' })
        continue
      }

      const status = await fetchTransactionConfirmationStatus(txid)
      if (!status.confirmed) {
        const { outcome } = await feeCollectionRecognitionService.recordReorgAndRevert(feeObligationId, txid, confirmationId)
        if (outcome === 'REVERTED') result.reverted.push(feeObligationId)
        else if (outcome === 'FLAGGED_DISTRIBUTED') result.flaggedDistributed.push(feeObligationId)
        else if (outcome === 'ALREADY_RECORDED') result.alreadyRecorded.push(feeObligationId)
        else result.superseded.push(feeObligationId)
        continue
      }

      result.stillGood.push(feeObligationId)
    } catch (err) {
      result.failed.push({ feeObligationId, error: err instanceof Error ? err.message : String(err) })
    }
  }

  if (result.reverted.length || result.flaggedDistributed.length || result.failed.length) {
    log.info({
      msg: 'MULTISIG fee reorg sweep completed',
      reverted: result.reverted.length,
      flaggedDistributed: result.flaggedDistributed.length,
      alreadyRecorded: result.alreadyRecorded.length,
      superseded: result.superseded.length,
      stillGood: result.stillGood.length,
      failed: result.failed.length,
    })
  }

  return result
}
