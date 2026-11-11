/**
 * Intent publication recovery - Issue #253 (Intent atomicity).
 *
 * IntentEngine.transition() commits the status change together with an IntentEvent that records the domain event
 * it owes (intent-repository.ts applyTransition), and only then publishes it. The event bus cannot join that
 * database transaction, so a crash between the commit and the publication leaves an IntentEvent with a NULL
 * `publishedAt`. This pass publishes those from the durable record - it never re-derives or re-decides anything.
 *
 * Safe to run concurrently from several instances and repeatedly: each event is published under a per-event
 * advisory lock, and an event whose durable copy already exists is only marked, never published twice. The grace
 * period keeps it away from a live publisher that is still about to publish. A live publisher stalled for longer
 * than the grace can still lose that race (a duplicated Timeline entry, never a lost one); no economic effect
 * hangs off an intent.* event.
 *
 * Rows written before the outbox columns existed have a NULL eventName and are not owed anything.
 */
import { eventBus } from '../common/events/event-bus'
import { childLogger } from '../common/logger'
import { intentRepository, type IntentRepository } from './intent-repository'

const log = childLogger('intent-publication-recovery')

export const INTENT_PUBLICATION_GRACE_MS = 5 * 60 * 1000
const BATCH = 200

export interface IntentPublicationRecoveryReport {
  republished: string[]
  markedPublished: string[]
  failed: Array<{ intentEventId: string; error: string }>
}

export async function recoverUnpublishedIntentEvents(
  opts: { graceMs?: number; repo?: IntentRepository } = {}
): Promise<IntentPublicationRecoveryReport> {
  const repo = opts.repo ?? intentRepository
  const report: IntentPublicationRecoveryReport = { republished: [], markedPublished: [], failed: [] }
  const owed = await repo.findUnpublishedEvents(new Date(Date.now() - (opts.graceMs ?? INTENT_PUBLICATION_GRACE_MS)), BATCH)

  for (const row of owed) {
    try {
      const outcome = await repo.publishOwedEvent(row.id, async (r) => {
        await eventBus.emit(r.eventName as any, { ...(r.eventPayload as object), transitionId: r.id } as any, r.intentId)
      })
      if (outcome === 'PUBLISHED') report.republished.push(row.id)
      else if (outcome === 'ALREADY_PUBLISHED') report.markedPublished.push(row.id)
    } catch (err) {
      report.failed.push({ intentEventId: row.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
  if (report.republished.length || report.markedPublished.length || report.failed.length) {
    log.info({ msg: 'Intent publication recovery', republished: report.republished.length, markedPublished: report.markedPublished.length, failed: report.failed.length })
  }
  return report
}
