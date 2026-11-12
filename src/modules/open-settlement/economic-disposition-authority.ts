/**
 * ADR-005 / #218 — Economic Disposition Commit Gate.
 *
 * Closes the gap ADR-004's Execution Commit Gate (capability-execution-
 * authorization.ts) deliberately does not cover: a technically valid,
 * fully-signed pending transaction can still be attributable to a ruling
 * generation the Dispute has since moved past (appeal/reassignment). ADR-004
 * proves the ORIGINAL initiator still has Capability/Eligibility Authority.
 * This module proves the pending operation's recorded Economic Disposition
 * Authority — the ruling generation that actually authorized its economic
 * disposition — is still the dispute's current authoritative generation.
 * Neither gate substitutes for the other (ADR-005 §7).
 *
 * Immediately before the first provider side effect:
 *   1) serializes with appeal() and the disputed-ruling resolve-write in
 *      Postgres, on the same `economic-disposition:<disputeId>` lock scope
 *      ADR-005 §3 names;
 *   2) re-loads the LIVE Dispute row (never trusts transient request
 *      memory) and compares it against the generation snapshotted on the
 *      pending operation at creation time (escrow-pending-tx.ts's
 *      initiateSignatureCollectionCore());
 *   3) fails closed if the dispute has moved to a different generation;
 *   4) otherwise durably commits economic-disposition execution
 *      authorization before returning.
 *
 * A retry for the exact same immutable pending operation reuses that durable
 * authorization and does NOT re-validate against the (possibly by-then-
 * superseded) live dispute state — ADR-005 §4/§5E: "later appeal/revocation
 * is prospective with respect to an already committed execution attempt."
 *
 * CTO Gate R1 (#222) finding 1 — absence of recorded provenance
 * (`disputeId: null`) does NOT by itself prove a cooperative origin. It is
 * true both for a genuinely cooperative pending operation and for a legacy
 * row created before this migration shipped (which may itself have been a
 * disputed-ruling settlement action, just never recorded as one). The two
 * are distinguished here by an independent, already-durable fact this
 * module does not fabricate: whether ANY Dispute row exists at all for this
 * escrow. `Dispute` is effectively one-per-trade for its entire lifetime
 * (schema.prisma's own `@@unique([tradeId])` comment: "no reopen-after-
 * RESOLVED path... one Dispute per Trade for its entire lifetime") — so "no
 * Dispute row exists for this escrow" is a durable, provable fact that this
 * escrow's trade was NEVER disputed, at any point, which makes every pending
 * operation on it provably cooperative. Any escrow that WAS ever disputed
 * keeps that Dispute row forever, even after resolution — so its presence
 * alone (regardless of current status) is enough to make a disputeId-null
 * pending row on that escrow ambiguous, not provably cooperative, and this
 * gate fails it closed rather than guessing.
 *
 * No fabricated provenance: a row is never promoted to "provenance
 * verified" by inference — either it durably carries the full recorded
 * generation (the normal gate path below), or its escrow is durably proven
 * to have never had a Dispute at all (the fast-path below), or it is
 * rejected. `UNKNOWN provenance ≠ cooperative provenance`.
 */
import { createHash } from 'crypto'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../common/database'
import { EscrowError } from '../../common/errors'

type DisputedPendingFacts = {
  id: string
  escrowId: string
  kind: string
  toAddress: string
  toAddressSecondary: string | null
  buyerBps: number | null
  feeCollectionSats: number | null
  feeCollectionWaived: boolean | null
  minerFeeSats: number | null
  unsignedPsbtBase64: string
  requiredSigners: string[]
  triggeredBy: string
  disputeId: string | null
  rulingAppealRound: number | null
  rulingArbiterId: string | null
  rulingOutcome: string | null
  rulingAuthoritySignature: string | null
  rulingAuthorityIssuedAt: Date | null
}

export function economicDispositionLockKey(disputeId: string): string {
  return `economic-disposition:${disputeId}`
}

/**
 * CTO Gate R1 (#222) finding 2 — a dedicated, ADR-005-specific digest.
 * ADR-004's `capabilityOperationDigest()` only covers immutable economic/
 * execution facts (operation-bound); Economic Disposition Authority is
 * operation-bound AND ruling-generation-bound (ADR-005 §1), so this digest
 * additionally binds the exact recorded generation — disputeId, appeal
 * round, arbiter, ruling outcome, and the signed authority fingerprint/
 * timestamp. A mutation of ANY of these (the pending row's own recorded
 * provenance diverging from what an already-committed
 * EconomicDispositionAuthorization captured) changes this digest and is
 * therefore caught by the reuse check below — never silently reused.
 * Deliberately NOT reusing or modifying capability-execution-authorization.ts's
 * own digest — that stays exactly what ADR-004 requires.
 */
export function economicDispositionOperationDigest(pending: DisputedPendingFacts): string {
  const canonical = JSON.stringify({
    pendingOperationId: pending.id,
    escrowId: pending.escrowId,
    kind: pending.kind,
    toAddress: pending.toAddress,
    toAddressSecondary: pending.toAddressSecondary,
    buyerBps: pending.buyerBps,
    feeCollectionSats: pending.feeCollectionSats,
    feeCollectionWaived: pending.feeCollectionWaived,
    minerFeeSats: pending.minerFeeSats,
    unsignedPsbtBase64: pending.unsignedPsbtBase64,
    requiredSigners: pending.requiredSigners,
    triggeredBy: pending.triggeredBy,
    disputeId: pending.disputeId,
    rulingAppealRound: pending.rulingAppealRound,
    rulingArbiterId: pending.rulingArbiterId,
    rulingOutcome: pending.rulingOutcome,
    rulingAuthoritySignature: pending.rulingAuthoritySignature,
    rulingAuthorityIssuedAt: pending.rulingAuthorityIssuedAt ? pending.rulingAuthorityIssuedAt.toISOString() : null,
  })
  return createHash('sha256').update(canonical).digest('hex')
}

/** Issue #239 - the no-provenance refusal below, typed so callers classify it without matching message text. */
export class CooperativeOriginNotProvable extends EscrowError {}

/**
 * The cooperative-origin rule for a pending operation with no recorded ruling generation: provable only when
 * this escrow was never disputed. `client` lets a caller evaluate it inside its own escrow-locked transaction.
 */
export async function assertCooperativeOriginProvable(
  pending: { id: string; escrowId: string },
  client: Pick<typeof prisma, 'dispute' | 'escrow' | 'escrowEvent'> = prisma
): Promise<void> {
  const everDisputed = await client.dispute.findFirst({ where: { escrowId: pending.escrowId } })
  if (everDisputed) {
    throw new CooperativeOriginNotProvable(
      `Pending operation ${pending.id} on escrow ${pending.escrowId} carries no recorded Economic Disposition ` +
      'Authority provenance, but this escrow has a Dispute record — its cooperative origin cannot be proven ' +
      'from durable current/historical facts. Refusing to execute an ambiguous-origin pending operation (ADR-005).'
    )
  }
  // A missing Dispute row alone proves nothing: openDispute() makes the escrow DISPUTED before raiseDispute()
  // writes the row, and a row can be deleted. The escrow's own status and its recorded transitions decide.
  const escrow = await client.escrow.findUnique({ where: { id: pending.escrowId }, select: { status: true } })
  const disputedTransition = await client.escrowEvent.findFirst({
    where: { escrowId: pending.escrowId, OR: [{ toStatus: 'DISPUTED' }, { fromStatus: 'DISPUTED' }] },
    select: { id: true },
  })
  if (!escrow || escrow.status === 'DISPUTED' || disputedTransition) {
    throw new CooperativeOriginNotProvable(
      `Pending operation ${pending.id} on escrow ${pending.escrowId} carries no recorded Economic Disposition ` +
      'Authority provenance, and this escrow is or was DISPUTED — refusing to execute it as a cooperative ' +
      'operation (ADR-005).'
    )
  }
}

/** GK-M9R-D R1 - a disputed MULTISIG round that does not correspond to its durable authoritative Outcome. */
export class DisputedTranslationRefused extends EscrowError {
  constructor(message: string, readonly mismatches: readonly string[]) {
    super(message)
  }
}

/**
 * GK-M9R-D R1 - a disputed MULTISIG round must correspond to its durable authoritative Outcome before ANY execution
 * step. Checked here, inside the one gate every executing path calls (submitTransactionSignature and settlement
 * reconciliation PASS 0/1), before the economic disposition authorization is created or reused and before any claim
 * or broadcast. So a round persisted by any path (the live ruling, C4 recovery, a crash between persisting the round
 * and its creation-time guard, a row already in the database) can never be finalized unless it matches. No durable
 * Outcome refuses: since M8-R every MULTISIG ruling commits one before it dispatches. Pure check over persisted facts:
 * deterministic, no side effect, no key, no signature. Reads through the caller's transaction (no second pool
 * connection). Required lazily. dispute-outcome is a real runtime cycle (it imports this module). The other three
 * are not cycles (multisig.provider's escrow.service import is type-only); they are lazy so this small module, which
 * every settlement path and its test mocks load, does not pull in the Bitcoin stack and config at load time.
 * shortcut: lazy requires, until economicDispositionLockKey moves to a leaf module (CTO 25: separate evaluation).
 */
async function assertDisputedTranslationMatchesOutcome(pending: DisputedPendingFacts, tx: Prisma.TransactionClient): Promise<void> {
  const escrow = await tx.escrow.findUnique({ where: { id: pending.escrowId }, select: { type: true } })
  if (!escrow) throw new EscrowError(`Escrow ${pending.escrowId} not found while validating disputed pending operation ${pending.id}`)
  if (escrow.type !== 'MULTISIG') return // the translation guard reads a Bitcoin PSBT; other rails do not dispatch one
  const { loadDisputeRulingRecord, fromDisputeRulingRow } = require('./dispute-outcome') // eslint-disable-line @typescript-eslint/no-var-requires
  const { assertTranslationMatchesOutcome, TranslationGuardError } = require('./dispatch-translation-guard') // eslint-disable-line @typescript-eslint/no-var-requires
  const { networkFor } = require('./multisig.provider') // eslint-disable-line @typescript-eslint/no-var-requires
  const { config } = require('../../config') // eslint-disable-line @typescript-eslint/no-var-requires
  const row = pending.rulingAppealRound == null ? null : await loadDisputeRulingRecord(pending.escrowId, pending.rulingAppealRound, tx)
  const outcome = row?.outcomeContent ? fromDisputeRulingRow(row).outcome : undefined
  if (!outcome) {
    throw new DisputedTranslationRefused(
      `Pending operation ${pending.id} on escrow ${pending.escrowId} is bound to dispute ${pending.disputeId} (appeal round ` +
      `${pending.rulingAppealRound}) but no durable authoritative Outcome exists for it - refusing to execute (GK-M9R-D R1).`,
      ['NO_DURABLE_OUTCOME'],
    )
  }
  // PE-M9R R-4 (#618) - the outputs alone cannot tell RELEASE from REFUND when buyer and seller share an address:
  // the round's kind must be the kind the durable Outcome's ruling authorizes (anchored on the Outcome, not on the
  // row's provenance: the reuse path above does not re-run the generation check), or it would settle misclassified.
  const { RULING_KIND } = require('./dispute-dispatch') // eslint-disable-line @typescript-eslint/no-var-requires
  if (RULING_KIND[outcome.content?.ruling] !== pending.kind) {
    throw new DisputedTranslationRefused(
      `Pending operation ${pending.id} on escrow ${pending.escrowId} is a ${pending.kind} round, but the authoritative Outcome of ` +
      `dispute ${pending.disputeId} is ${outcome.content?.ruling} - refusing to execute (GK-M9R-D R1, R-4).`,
      ['KIND_MISMATCH'],
    )
  }
  try {
    assertTranslationMatchesOutcome(pending.unsignedPsbtBase64, outcome, networkFor(config.multisig.network), pending.minerFeeSats ?? undefined)
  } catch (err) {
    const mismatches: readonly string[] = err instanceof TranslationGuardError ? (err as { mismatches: readonly string[] }).mismatches : [err instanceof Error ? err.message : String(err)]
    throw new DisputedTranslationRefused(
      `Pending operation ${pending.id} on escrow ${pending.escrowId} does not correspond to the authoritative Outcome of ` +
      `dispute ${pending.disputeId} - refusing to execute (GK-M9R-D R1): ${mismatches.join('; ')}`,
      mismatches,
    )
  }
}

export async function authorizeDisputedPendingExecution(pending: DisputedPendingFacts) {
  if (!pending.disputeId) {
    // No recorded generation. Fast-path to "cooperative, ADR-005 does not
    // apply" ONLY when durably provable — this escrow's trade was never
    // disputed at all, ever (see header comment). Otherwise this is an
    // ambiguous legacy/undisputed-provenance row and must fail closed
    // rather than being silently allowed through as if proven cooperative.
    await assertCooperativeOriginProvable(pending)
    return null
  }

  const disputeId = pending.disputeId
  const operationDigest = economicDispositionOperationDigest(pending)

  return prisma.$transaction(async (tx) => {
    // Same lock scope appeal() and the disputed-ruling resolve-write
    // (dispute.service.ts's applyRuling(), dispute-outcome.ts's
    // commitAuthoritativeDisputeRuling()) acquire before touching this
    // dispute's authority — ADR-005 §3's single serialization domain.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${economicDispositionLockKey(disputeId)})::bigint)`

    const existing = await tx.economicDispositionAuthorization.findUnique({
      where: { pendingOperationId: pending.id },
    })

    if (existing) {
      // Reuse is legal only for the exact immutable operation previously
      // authorized — a later appeal is prospective with respect to an
      // already-committed attempt (ADR-005 §4), so the live dispute state
      // is deliberately NOT re-checked here.
      if (
        existing.escrowId !== pending.escrowId ||
        existing.disputeId !== disputeId ||
        existing.operationDigest !== operationDigest
      ) {
        throw new EscrowError(
          `Pending operation ${pending.id} no longer matches its committed economic disposition authorization`
        )
      }
      await assertDisputedTranslationMatchesOutcome(pending, tx) // R1: an authorization committed earlier is no excuse
      return existing
    }

    const currentDispute = await tx.dispute.findUnique({ where: { id: disputeId } })
    if (!currentDispute) {
      throw new EscrowError(`Dispute ${disputeId} not found while committing economic disposition authority for pending operation ${pending.id}`)
    }

    // Fail closed on ANY divergence from the recorded generation — this is
    // the exact set of facts ADR-005 §2 requires: the dispute must not
    // have advanced to another appeal round, the assigned ruling authority
    // must still match, no later ruling may have superseded the recorded
    // one, and RESOLVED (not e.g. APPEALED, which nulls `ruling`) must
    // still hold. A stale pending operation is not "failed execution" — it
    // is no longer economically authorized.
    const stillCurrent =
      currentDispute.status === 'RESOLVED' &&
      currentDispute.appealRound === pending.rulingAppealRound &&
      currentDispute.arbiterId === pending.rulingArbiterId &&
      currentDispute.ruling === pending.rulingOutcome &&
      currentDispute.authoritySignature === pending.rulingAuthoritySignature

    if (!stillCurrent) {
      throw new EscrowError(
        `Pending operation ${pending.id} was authorized under dispute ${disputeId}'s appeal round ${pending.rulingAppealRound}, ` +
        `but that ruling generation is no longer current (dispute is now status=${currentDispute.status}, ` +
        `appealRound=${currentDispute.appealRound}, arbiterId=${currentDispute.arbiterId}) — refusing to execute a ` +
        'pending operation whose Economic Disposition Authority has been superseded (ADR-005).'
      )
    }

    await assertDisputedTranslationMatchesOutcome(pending, tx) // R1: after the generation check, before authorizing
    return tx.economicDispositionAuthorization.create({
      data: {
        pendingOperationId: pending.id,
        escrowId: pending.escrowId,
        disputeId,
        appealRound: currentDispute.appealRound,
        arbiterId: currentDispute.arbiterId!,
        ruling: currentDispute.ruling!,
        operationDigest,
      },
    })
  })
}
