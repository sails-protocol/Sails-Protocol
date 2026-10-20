/**
 * settlement-recovery-schedule.ts — the production tick for settlement crash
 * recovery (Issue #291/#298 hardening), started by app.ts's startServer()
 * when config.features.escrowSettlementReconciler is on (the default).
 *
 * One tick runs, in order:
 *   1. reconcilePendingSettlements() — terminal escrows missing a result,
 *      completion effects or projections (PASS 0-3).
 *   2. reconcileMissingDispatch() — M9-R/C4: a dispute ruling committed
 *      durably but the process died before the payout PSBT was persisted.
 *      Same class of work as step 1 (finishing an already-authorised
 *      settlement a crash left half done, never a new disposition), which is
 *      why it shares this tick instead of getting its own scheduler.
 *
 * Each step's failure is logged and contained; step 1 failing never skips
 * step 2. One tick makes ONE reconcileMissingDispatch() call with its
 * default bound (DISPATCH_RECOVERY_BATCH), never a catch-up loop: a backlog
 * is worked through across ticks, fairly (see dispute-dispatch-recovery.ts).
 *
 * A tick never starts while the previous one in this process is still
 * running (a pass can take minutes during an explorer outage), so the
 * number of concurrent invocations per process is at most one. That flag is
 * operational only. Correctness across ticks, restarts and instances comes
 * from PostgreSQL: the write-once/idempotent passes of step 1 and, for step
 * 2, EscrowPendingTransaction's @@unique(escrowId) plus the durable
 * round-robin stamp. Several instances may run this tick concurrently.
 */
import type { FastifyBaseLogger } from 'fastify'
import { startGuardedInterval } from '../../common/guarded-interval'
import { reconcilePendingSettlements } from './escrow-settlement-reconciliation.service'
import { reconcileMissingDispatch } from './dispute-dispatch-recovery'
import { reconcileResidualRecoveries } from './multisig-residual-recovery'

export interface SettlementRecoverySchedule {
  /**
   * Stops future ticks and resolves once a tick already running has finished, so a graceful shutdown can
   * drain it before closing Postgres/Redis. Never rejects. If the process is killed before the drain
   * completes, nothing is lost: an interrupted tick leaves only durable, retryable state.
   */
  stop: () => Promise<void>
}

export async function runSettlementRecoveryTick(log: FastifyBaseLogger): Promise<void> {
  try {
    const report = await reconcilePendingSettlements()
    // Moved verbatim from app.ts. (projectionsRecovered is an array, so this condition is always true today.)
    if (report.failed.length || report.requiresManualReview.length || report.projectionsRecovered.length) {
      log.warn({ msg: 'Settlement reconciliation completed with findings', module: 'settlement-reconciler', failed: report.failed.length, requiresManualReview: report.requiresManualReview.length, projectionsRecovered: report.projectionsRecovered.length })
    }
  } catch (err) {
    log.error({ msg: 'Settlement reconciliation failed', module: 'settlement-reconciler', err: err instanceof Error ? err.message : err })
  }

  try {
    const report = await reconcileMissingDispatch()
    if (report.resumed.length || report.failed.length || report.guardFailed.length || report.notEligible.length) {
      log.warn({
        msg: 'C4 dispatch recovery completed with findings', module: 'dispute-dispatch-recovery',
        claimed: report.claimed.length, resumed: report.resumed.length, alreadyResumedConcurrently: report.alreadyResumedConcurrently.length,
        notEligible: report.notEligible.length, guardFailed: report.guardFailed.length, failed: report.failed.length,
      })
    }
  } catch (err) {
    log.error({ msg: 'C4 dispatch recovery failed', module: 'dispute-dispatch-recovery', err: err instanceof Error ? err.message : err })
  }

  // #235 R7G F8A — signed residual recoveries converge with their one persisted transaction (never rebuilt).
  try {
    const report = await reconcileResidualRecoveries()
    if (report.review.length || report.failed.length) {
      log.warn({ msg: 'Residual recovery reconciliation completed with findings', module: 'multisig-residual-recovery', review: report.review, failed: report.failed })
    }
  } catch (err) {
    log.error({ msg: 'Residual recovery reconciliation failed', module: 'multisig-residual-recovery', err: err instanceof Error ? err.message : err })
  }
}

export function startSettlementRecoverySchedule(log: FastifyBaseLogger, intervalMs: number): SettlementRecoverySchedule {
  // The canonical guarded lifecycle every background sweeper uses: no overlapping tick, unref()'d,
  // stop() drains a tick in flight.
  return startGuardedInterval(() => runSettlementRecoveryTick(log), intervalMs)
}
