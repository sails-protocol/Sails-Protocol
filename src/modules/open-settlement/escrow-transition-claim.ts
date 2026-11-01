/**
 * Sails OpenSettlement — the durable CLAIM of an escrow transition: its hash-chained EscrowEvent row
 * and, for a transition whose downstream must converge, the 'transition.claimed' marker that puts it in
 * settlement reconciliation PASS 3's queue (Issue #298). Written inside the caller's transaction, so a
 * caller that changes escrow state in that same transaction (the timelock expiry) commits the state and
 * its claimed transition together or not at all.
 *
 * Kept free of the event bus and the settlement services (only Prisma and the projection markers), so
 * the semantic-transition-record primitive can use it without loading them. emitEscrowTransition()
 * (escrow-lifecycle.ts) re-exports everything here.
 */
import { createHash } from 'crypto'
import type { Prisma } from '@prisma/client'
import { TRANSITION_CLAIMED_KEY } from '../../common/events/event-projection'

// RFC-008 D2 amendment (Missão 05.5, 2026-08-15) — EscrowEvent's own hash
// chain, same composition and same reasoning as intent-engine.ts's
// writeIntentEvent(): sha256(fromStatus + toStatus + triggeredBy +
// prevHash). Deliberately excludes `note` and `createdAt` from the hash —
// mirroring IntentEvent's own precedent exactly, not inventing a new
// composition. Exported so verifyEscrowEventChain() (and its own
// tests) can recompute and compare against the stored entryHash — the
// only way to catch an entry mutated in place, not just prevHash links
// reordered.
export function computeEscrowEventHash(fromStatus: string, toStatus: string, triggeredBy: string, prevHash: string): string {
  return createHash('sha256').update(`${fromStatus}|${toStatus}|${triggeredBy}|${prevHash}`).digest('hex')
}

// Issue #298 - escrow transitions whose downstream (Trade/Intent/counters/reputation) projections
// must converge, keyed to the event name each publishes. Other transitions are untouched.
// The timelock expiry's only downstream is its canonical durable event itself (the Timeline and every
// other reader of the event log learn of the expiry only from it), so PASS 3 owes it publication.
export const RECOVERABLE_TRANSITION_EVENTS: ReadonlySet<string> = new Set([
  'settlement.escrow.locked',
  'settlement.escrow.disputed',
  'settlement.escrow.released',
  'settlement.escrow.refunded',
  'settlement.escrow.split',
  'settlement.escrow.expired',
])
// EscrowEvent.toStatus -> the event name emitEscrowTransition() publishes for it.
export const EVENT_NAME_BY_TARGET_STATUS: Record<string, string> = {
  FUNDS_LOCKED: 'settlement.escrow.locked',
  DISPUTED: 'settlement.escrow.disputed',
  COMPLETED: 'settlement.escrow.released',
  REFUNDED: 'settlement.escrow.refunded',
  SPLIT: 'settlement.escrow.split',
  EXPIRED: 'settlement.escrow.expired',
}

const TERMINAL_ESCROW_STATUSES: ReadonlySet<string> = new Set(['COMPLETED', 'REFUNDED', 'SPLIT'])

export interface EscrowTransitionClaim {
  escrowId: string
  from: string
  to: string
  triggeredBy: string
  eventName: string
  note?: string
}

/**
 * Claims the transition inside `tx`: the first claim of (escrowId, to) - a pair the escrow state machine
 * never revisits - writes the hash-chained EscrowEvent (plus the PASS 3 marker for a recoverable event)
 * and returns its id, the transition's identity; any later claim of the same pair returns false.
 * The caller must hold the escrow's advisory lock (hashtext(escrowId)) in `tx`, which serializes the
 * hash chain and the existence check.
 */
export async function claimEscrowTransitionRecord(tx: Prisma.TransactionClient, claim: EscrowTransitionClaim): Promise<string | false> {
  const { escrowId, from, to, triggeredBy, eventName, note } = claim
  // entryHash/prevHash are never accepted from a caller — they can only ever be what the server itself
  // derives here.
  const alreadyEmitted = await tx.escrowEvent.findFirst({ where: { escrowId, toStatus: to as any } })
  if (alreadyEmitted) return false

  const last = await tx.escrowEvent.findFirst({ where: { escrowId }, orderBy: { createdAt: 'desc' } })
  const prevHash = last?.entryHash ?? 'genesis'
  const entryHash = computeEscrowEventHash(from, to, triggeredBy, prevHash)

  const transition = await tx.escrowEvent.create({
    data: { escrowId, fromStatus: from as any, toStatus: to as any, triggeredBy, note, entryHash, prevHash },
  })
  // Issue #298 - claim != publish != projection. For the transitions whose downstream projections
  // must converge, record atomically WITH the claim that a projection is now owed. Its completion
  // ('transition.projected', written by the handler) is a separate fact, so recovery can tell
  // "claimed but never published" and "published but not fully projected" apart from "done".
  // eventId here holds the transition (EscrowEvent) id - no durable event exists yet.
  if (RECOVERABLE_TRANSITION_EVENTS.has(eventName)) {
    await tx.eventProjectionClaim.create({ data: { eventId: transition.id, projectionKey: TRANSITION_CLAIMED_KEY, subjectId: escrowId } })
  }
  // #239D - an escrow's terminal disposition while a dispute is still open (no ruling decided it - a ruling
  // marks its dispute RESOLVED before dispatching) leaves that dispute without an object: MOOT, in this same
  // transaction as the terminal transition record, so the two never diverge durably (PASS 2/PASS 3 replay
  // this claim, not the status change). No ruling field is written. APPEALED disputes are left as they are.
  if (TERMINAL_ESCROW_STATUSES.has(to)) {
    await tx.$executeRaw`
      UPDATE disputes SET status = 'MOOT', "mootedAt" = ${new Date()}, "mootedByTransitionId" = ${transition.id}, "updatedAt" = ${new Date()}
      WHERE "escrowId" = ${escrowId} AND status IN ('OPENED', 'EVIDENCE_SUBMITTED', 'ARBITRATED', 'AUTO_PROPOSED')`
  }
  return transition.id
}
