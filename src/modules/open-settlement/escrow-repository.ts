/**
 * EscrowRepository — Sails OpenSettlement Component
 *
 * ARCHITECTURE_AUDIT_REPORT.md recommendation #3, step 4 (final step) of
 * the incremental rollout (step 1: CapabilityGrantRepository, step 2:
 * IntentRepository, step 3: TradeRepository). Real fund-moving code
 * (Bitcoin multisig / EVM Safe-guard settlement) — every method here is
 * a verbatim 1:1 move of an existing Prisma call, no behavior change.
 *
 * Scope, deliberately narrow: wraps `prisma.escrow.*` only, plus one
 * bundled-in read no other repository owns — findDisputeByTradeAndArbiter()
 * (isSellerOrAssignedArbiter()'s fallback check) — same "bundle in the
 * one extra read a consumer needs" precedent TradeRepository already set
 * with findOfferById(). Escrow's own satellite/child tables
 * (escrowParticipantKey, escrowEvent, feeDistribution,
 * escrowReleaseApproval, escrowPendingTransaction,
 * escrowTransactionSignature) are deliberately NOT wrapped here — they're
 * already fully confined to open-settlement's own files (never a
 * cross-module violation, the actual problem this rollout exists to
 * fix), so including them would roughly double this step's size without
 * closing any new architectural violation. Deferred, disclosed, not
 * silently dropped.
 *
 * claimTransition() returns the raw affected-row count — no EscrowError/
 * VALID_TRANSITIONS logic lives here. Both stay exactly where they are
 * today: escrow-lifecycle.ts's claimEscrowTransition() keeps its own
 * VALID_TRANSITIONS pre-check + throw; escrow.service.ts's
 * markPaymentSent() keeps its own separate, pre-existing, undeduplicated
 * throw (it never had the VALID_TRANSITIONS gate — this pass does not
 * add one as a side effect of moving the persistence call). Mirrors
 * IntentRepository.claimTransition()'s own precedent exactly.
 */
import { prisma } from '../../common/database'
import type { Prisma } from '@prisma/client'
import type { AssetType } from '../../common/types'
import type { EscrowType } from '../../common/types/trade'
import { EscrowError, SettlementResultConflictError } from '../../common/errors'
import { assertFirstEscrowAllowed, lockTradeLifecycle } from '../open-p2p/trade-lifecycle-lock'

/** #247/#248 - the economic intent a direct-call execution freezes on its first claim. */
export type DirectExecutionDisposition = 'COMPLETED' | 'REFUNDED' | 'SPLIT'
export interface DirectExecutionIntent {
  triggeredBy: string
  /** SPLIT only. */
  splitBuyerBps?: number
}

export interface SettlementResultInput {
  txReleaseId: string
  /** Proposed timestamp: used only if the slot is empty / releasedAt is still null; never replaces an existing one. */
  releasedAt?: Date
  feeCharged?: Prisma.Decimal | null
}

export interface SettlementResultWriteOptions {
  /** Run inside an existing transaction (e.g. the reconciler's escrow lock). */
  tx?: Prisma.TransactionClient
  /** Sails-owned immutable operation identity this evidence belongs to. */
  operation?: { pendingOperationId: string }
}

type EscrowRow = NonNullable<Awaited<ReturnType<typeof prisma.escrow.findUnique>>>
// Missão 11 Fase 7.2 §L — the query this type describes already includes
// participantKeys/feeObligation (added below); this type previously only
// listed events/disputes, a stale mismatch predating this phase, fixed
// here since this exact area was already being touched.
type EscrowWithDetailsRow = Prisma.EscrowGetPayload<{
  include: {
    events: true
    disputes: true
    participantKeys: true
    feeObligation: {
      include: {
        evidence: {
          include: { distributionPolicyVersion: { include: { recipients: { include: { recipient: true } } } } }
        }
      }
    }
  }
}>
type DisputeRow = NonNullable<Awaited<ReturnType<typeof prisma.dispute.findFirst>>>

export interface CreateEscrowData {
  tradeId: string
  type: EscrowType
  lockedAmount: string
  asset: AssetType
  network: string | undefined
  timelockHours: number
  // #235 R7H-E3 — refuse a rail no trade-limit policy has ever governed (set in production: every economically
  // executable rail must be governed, see escrow_rail_governed()).
  requireGovernedRail?: boolean
  // Missão 11 Fase 4.1 §4 — the fee-policy snapshot, computed BEFORE this
  // escrow exists (escrow-fee-snapshot.service.ts's computeSnapshotFields())
  // and folded into this SAME insert rather than a separate update
  // afterward. Optional/undefined for every legacy escrow (no PUBLISHED
  // policy for this rail) — identical to today's behavior in that case.
  feeSnapshot?: {
    feePolicyVersionId: string
    snapshotProtocolFeeRate: Prisma.Decimal
    snapshotPayerModel: Prisma.EscrowCreateInput['snapshotPayerModel']
    snapshotEconomicBasis: Prisma.EscrowCreateInput['snapshotEconomicBasis']
    snapshotFeeCollectionAddress: string | null
    snapshotFeeCollectionWaivedPreFunding: boolean
  }
}

/** '<CODE>: <reason>' from escrow_economic_binding_violation(): the policy refusing a rail or method, or a binding the trade does not satisfy. */
function economicBindingRefused(violation: string): EscrowError {
  const policy = /^(RAIL_NOT_ELIGIBLE|METHOD_NOT_ELIGIBLE):/.test(violation)
  return new EscrowError(`Escrow refused by the economic authorization binding — ${violation}`, policy ? 'DISABLED' : 'INELIGIBLE')
}

export interface EscrowRepository {
  create(input: CreateEscrowData): Promise<EscrowRow>

  /** Bare row, no relations — the one shape behind every read in this module that just needs the current escrow before deciding what to do next. */
  findById(escrowId: string): Promise<EscrowRow | null>

  /** events(createdAt asc) + disputes — getEscrow()'s own shape. */
  findByIdWithDetails(escrowId: string): Promise<EscrowWithDetailsRow | null>

  /** Same include shape as findByIdWithDetails(), keyed by tradeId — getEscrowByTrade()'s own shape. */
  findByTradeIdWithDetails(tradeId: string): Promise<EscrowWithDetailsRow | null>

  /** The timelock sweep's candidates: claims up to `limit` FUNDS_LOCKED escrows
   *  with expiresAt <= now, stamping expirySweepAttemptedAt in the same
   *  statement (see the implementation for the order). `<=`, not `<`, so the
   *  exact deadline instant reaches the Core evaluator (M4); the refund
   *  branch keeps its own strict `<` in sweepExpiredEscrows(). Queue position
   *  only — every claimed escrow is still decided by the expiry authority. */
  claimExpiryCandidates(now: Date, limit: number): Promise<EscrowRow[]>

  /** Settlement reconciliation PASS 1 (Missão 11 Fase 9.6, CONC-03) —
   *  claims up to `limit` escrows whose status already claims a terminal
   *  outcome (COMPLETED/REFUNDED/SPLIT) but whose txReleaseId was never
   *  persisted: a crash between claimEscrowTransition() and the later
   *  updateXResult() write, or a rail with no automated recovery that stays
   *  in this set for manual review. See claimRecoveryQueue() for the order. */
  claimSettlementResultRecoveryBatch(limit: number): Promise<EscrowRow[]>

  /** Settlement reconciliation PASS 2 (Missão 11 Fase 9.7, CONC-03 "C5")
   *  — claims up to `limit` terminal escrows whose txReleaseId is persisted
   *  but whose completion has not been verified yet (completionVerifiedAt
   *  null). Reconciliation decides per escrow whether anything is actually
   *  missing. */
  claimCompletionVerificationBatch(limit: number): Promise<EscrowRow[]>

  /** Sets completionVerifiedAt iff the settlement has converged: the
   *  EscrowEvent for its terminal status exists and no pending transaction
   *  row survives (the two facts PASS 2 acts on). One conditional UPDATE,
   *  so it never marks a settlement that still needs work. Returns whether
   *  this call marked it. */
  markCompletionVerifiedIfConverged(escrowId: string): Promise<boolean>

  /** Settlement reconciliation PASS 0 (M9-R, crash window C8) — claims the
   *  next fully-signed pending operation of an open MULTISIG escrow (the
   *  escrow never claimed its transition) and returns its id, or null when
   *  there is none. One per call, so a run stops between candidates without
   *  having moved any unprocessed one back in the queue. Operations claimed
   *  at or after `runStartedAt` (by this run, or by another instance's run
   *  since) are not claimed again: one visit per operation per run. */
  claimUnclaimedSignedPendingOperation(runStartedAt: Date): Promise<string | null>

  /** isSellerOrAssignedArbiter()'s fallback existence check — the one Dispute-by-this-shape read nobody else owns. */
  findDisputeByTradeAndArbiter(tradeId: string, arbiterId: string): Promise<DisputeRow | null>

  /** submitParticipantKey()'s own write, once both buyer/seller keys exist. */
  updateMultisigAddr(escrowId: string, multisigAddr: string): Promise<EscrowRow>

  /** lockFunds()'s own write. txLockVout is null for providers with no
   *  Bitcoin-style outpoint (everything but MULTISIG) — the DB's
   *  @@unique([txLockId, txLockVout]) constraint only ever fires when
   *  BOTH columns are non-null for two different rows (Missão 10).
   *  fundedAmount (Missão 11 Fase 4) is purely observational — undefined
   *  for legacy escrows and any provider that doesn't report it, keeping
   *  the column NULL exactly as it already is for every existing row. */
  updateLockResult(escrowId: string, data: { txLockId: string; txLockVout: number | null; multisigAddr: string; lockedAt: Date; expiresAt: Date; fundedAmount?: number }): Promise<EscrowRow>

  /** Atomic conditional update — returns the affected-row count (0 = a concurrent caller already transitioned this Escrow).
   *  Optional tx (Missão 11 Fase 9.3) — lets markPaymentSent() run this
   *  update through the same locked transaction as its authoritative
   *  funding-uncertainty re-check (escrow-funding-lock.ts). Omitted by
   *  every other existing caller, unchanged behavior. */
  claimTransition(escrowId: string, fromStatus: string, toStatus: string, tx?: Prisma.TransactionClient): Promise<number>

  /** #247/#248 - claimTransition() for a direct-call RELEASE/REFUND/SPLIT that also freezes its
   *  economic intent in the same conditional update, in the slot of the escrow's current authority
   *  phase: from DISPUTED the arbitrated slot (disposition + SPLIT buyerBps; the caller must already
   *  have verified the current assigned arbiter, recorded as arbitratedTriggeredBy), otherwise the
   *  cooperative slot (disposition + actor). Claims only when that slot is empty (and freezes it) or
   *  holds the identical intent (a retry after a provider-failure revert); a different frozen intent
   *  claims 0 rows. Never clears or rewrites a frozen intent, and never touches the other slot. */
  claimDirectExecution(escrowId: string, fromStatus: string, toStatus: DirectExecutionDisposition, intent: DirectExecutionIntent): Promise<number>

  /**
   * Issue #291 - THE one settlement-result persistence primitive; the four
   * updateXResult() methods below are thin wrappers over it, and the
   * reconciliation writers (C8, PASS 1) use it too, so every writer has
   * identical conflict semantics:
   *   empty slot       -> write (and record releasedAt once)
   *   same txReleaseId -> idempotent no-op (original releasedAt preserved)
   *   different        -> SettlementResultConflictError, nothing overwritten
   * txReleaseId is PROVIDER EVIDENCE (txid / arkTxid / userOpHash / hash), not
   * Sails' operation identity. When `operation.pendingOperationId` is given
   * the first write is additionally bound to that immutable, Sails-owned
   * pending operation (it must still exist for this escrow).
   */
  persistSettlementResult(escrowId: string, result: SettlementResultInput, opts?: SettlementResultWriteOptions): Promise<EscrowRow>

  /** releaseFunds()'s own write. */
  updateReleaseResult(escrowId: string, data: { txReleaseId: string; releasedAt: Date; feeCharged: Prisma.Decimal | null }, opts?: SettlementResultWriteOptions): Promise<EscrowRow>

  /** refundFunds()'s own write - no releasedAt/feeCharged (PROTOCOL_ECONOMY.md s3: the Protocol Fee never attaches to a refund). */
  updateRefundResult(escrowId: string, txReleaseId: string, opts?: SettlementResultWriteOptions): Promise<EscrowRow>

  /** splitFunds()'s own write - txReleaseId is the joined multi-tx-id string. */
  updateSplitResult(escrowId: string, data: { txReleaseId: string; releasedAt: Date }, opts?: SettlementResultWriteOptions): Promise<EscrowRow>

  /** submitTransactionSignature()'s own write (escrow-pending-tx.ts) - releasedAt present for release/split, absent for refund; the caller decides which, exactly as today. */
  updateSignatureCollectionResult(escrowId: string, data: { txReleaseId: string; releasedAt?: Date }, opts?: SettlementResultWriteOptions): Promise<EscrowRow>

  /** Conditional rollback: restore fromStatus only while this invocation still owns claimedStatus. */
  revertStatus(escrowId: string, claimedStatus: string, fromStatus: string): Promise<number>
}

class PrismaEscrowRepository implements EscrowRepository {
  async create(input: CreateEscrowData) {
    // #235 R7G-A — the trade's status is read under the trade-lifecycle lock a
    // manual cancellation also takes, and the escrow is inserted in the same
    // transaction: a cancellation that won is seen here, and one that comes later
    // sees this escrow (trade-lifecycle-lock.ts).
    return prisma.$transaction(async (tx) => {
      await lockTradeLifecycle(tx, input.tradeId)
      const trade = await tx.trade.findUnique({ where: { id: input.tradeId }, select: { status: true } })
      assertFirstEscrowAllowed(input.tradeId, trade?.status)
      // #235 R7H-E3 — the seller / PaymentAccount / payment-method binding, decided inside this transaction under
      // the trade lock (the database function locks the trade, offer and account rows it reads). The insert trigger
      // escrows_trade_economic_binding_guard re-checks the same function, so a direct write is held to it too.
      // hasEscrow: a retry that lands before Trade.escrowId is projected (by the settlement.escrow.created handler)
      // gets the same clean refusal as one after it, not a unique-constraint error.
      const [binding] = await tx.$queryRaw<Array<{ violation: string | null; governed: boolean; hasEscrow: boolean }>>`
        SELECT escrow_economic_binding_violation(${input.tradeId}, ${input.type}::"EscrowType", ${input.asset}::"AssetType") AS violation,
               escrow_rail_governed(${input.type}::"EscrowType", ${input.asset}::"AssetType") AS governed,
               EXISTS (SELECT 1 FROM escrows WHERE "tradeId" = ${input.tradeId}) AS "hasEscrow"`
      if (binding.hasEscrow) throw new EscrowError('Trade already has an escrow')
      if (binding.violation) throw economicBindingRefused(binding.violation)
      if (input.requireGovernedRail && !binding.governed) {
        throw new EscrowError(`Escrow rail ${input.type}/${input.asset} is not governed by any trade-limit policy version: no escrow can be created on it here`, 'DISABLED')
      }
      return tx.escrow.create({
        data: {
          tradeId: input.tradeId,
          type: input.type as any,
          status: 'CREATED',
          lockedAmount: input.lockedAmount,
          asset: input.asset as any,
          network: input.network,
          timelockHours: input.timelockHours,
          ...(input.feeSnapshot ? {
            feePolicyVersionId: input.feeSnapshot.feePolicyVersionId,
            snapshotProtocolFeeRate: input.feeSnapshot.snapshotProtocolFeeRate,
            snapshotPayerModel: input.feeSnapshot.snapshotPayerModel,
            snapshotEconomicBasis: input.feeSnapshot.snapshotEconomicBasis,
            snapshotFeeCollectionAddress: input.feeSnapshot.snapshotFeeCollectionAddress,
            snapshotFeeCollectionWaivedPreFunding: input.feeSnapshot.snapshotFeeCollectionWaivedPreFunding,
          } : {}),
        },
      }).catch((err: unknown) => {
        const refused = err instanceof Error ? /economic binding refused — ([^\n]*)/.exec(err.message) : null
        throw refused ? economicBindingRefused(refused[1]) : err
      })
    })
  }

  async findById(escrowId: string) {
    return prisma.escrow.findUnique({ where: { id: escrowId } })
  }

  async findByIdWithDetails(escrowId: string) {
    return prisma.escrow.findUnique({
      where: { id: escrowId },
      // Missão 10, Fase 6.10 — participantKeys added so escrow.service.ts's
      // getEscrow() can expose registered public keys to this escrow's own
      // authorized readers (same GET route, same authorization gate as
      // events/disputes above — no new query, no new auth logic). The
      // relation itself already existed on Escrow (schema.prisma), unused
      // by any query until now — zero migration.
      //
      // Missão 11 Fase 7.2 §L — feeObligation.evidence(CONFIRMED)'s own
      // frozen distributionPolicyVersion + recipients, so this escrow's
      // own authorized readers can independently verify which
      // DistributionPolicyVersion actually governed each of its collected
      // generations, without needing general EntitlementLedgerEntry
      // access (Decision D). Every CONFIRMED row is returned (normally
      // one; more than one only after a reorg + reconfirmation), each
      // with its own independently-frozen policy reference — never
      // collapsed to "the latest," since that is exactly the
      // binding-time bug this phase exists to prevent from leaking into
      // a read surface too.
      include: {
        events: { orderBy: { createdAt: 'asc' } },
        disputes: true,
        participantKeys: true,
        feeObligation: {
          include: {
            evidence: {
              where: { kind: 'CONFIRMED' },
              orderBy: { recordedAt: 'asc' },
              include: { distributionPolicyVersion: { include: { recipients: { include: { recipient: true } } } } },
            },
          },
        },
      },
    })
  }

  async findByTradeIdWithDetails(tradeId: string) {
    return prisma.escrow.findUnique({
      where: { tradeId },
      include: {
        events: { orderBy: { createdAt: 'asc' } },
        disputes: true,
        participantKeys: true,
        feeObligation: {
          include: {
            evidence: {
              where: { kind: 'CONFIRMED' },
              orderBy: { recordedAt: 'asc' },
              include: { distributionPolicyVersion: { include: { recipients: { include: { recipient: true } } } } },
            },
          },
        },
      },
    })
  }

  /**
   * Order: by a candidate's last claim, or by its expiry if never claimed, oldest first. A claimed
   * candidate's key becomes the claim time, later than every key of a row due at that time, so a
   * candidate that keeps failing (a provider refusing its refund, a fail-closed integrity check) moves
   * behind every other one after each claim instead of holding a slot: each candidate is reached within
   * ceil(rows ahead / limit) claims, a backlog cannot starve new expiries and new expiries cannot starve a
   * backlog, across restarts and instances. SKIP LOCKED gives overlapping claims disjoint rows. The stamp
   * decides order only: a crash after the claim costs the escrow one turn, nothing is owned, and the
   * expiry itself is still decided by evaluateExpiryAuthority(), the status CAS and the atomic transition
   * claim. The claim reads escrows_expiry_sweep_queue_idx (migration 20261002120000) in key order and
   * stops after `limit` due rows.
   */
  async claimExpiryCandidates(now: Date, limit: number) {
    const claimed = await prisma.$queryRaw<Array<{ id: string }>>`
      WITH picked AS (
        SELECT e.id FROM escrows e
        WHERE e.status = 'FUNDS_LOCKED' AND e."expiresAt" <= ${now}
        ORDER BY COALESCE(e."expirySweepAttemptedAt", e."expiresAt"), e.id
        LIMIT ${limit}
        FOR UPDATE OF e SKIP LOCKED
      )
      UPDATE escrows e SET "expirySweepAttemptedAt" = ${new Date()}
      FROM picked WHERE e.id = picked.id
      RETURNING e.id`
    if (claimed.length === 0) return []
    return prisma.escrow.findMany({ where: { id: { in: claimed.map((row) => row.id) } } })
  }

  async claimSettlementResultRecoveryBatch(limit: number) {
    return this.claimRecoveryQueue('RESULT_MISSING', limit)
  }

  async claimCompletionVerificationBatch(limit: number) {
    return this.claimRecoveryQueue('COMPLETION_UNVERIFIED', limit)
  }

  /**
   * Claims the next `limit` escrows of one reconciliation queue and stamps
   * settlementRecoveryAttemptedAt in the same statement.
   *
   * Order: never-attempted escrows first, most recently settled first (a
   * fresh crash is recovered on the next tick even while an old backlog is
   * being worked through), then escrows already attempted, least recently
   * attempted first. An escrow that keeps needing attention (a manual-review
   * rail, a failing provider) therefore moves behind every other candidate
   * after each attempt instead of holding a slot: every candidate is reached
   * within ceil(queue / limit) runs, and the stamp is durable, so the order
   * survives restarts. The stamp decides order only — a crash after it
   * commits costs the escrow one turn, never its recovery; no lease exists
   * because nothing is owned. SKIP LOCKED gives concurrent instances
   * disjoint batches while their claims overlap in time; it only saves
   * duplicate work, the per-escrow write-once result and emitEscrowTransition()'s
   * claim are what make recovery safe to run twice. Each queue reads its
   * own partial index (migration 20260929120000), so the claim never walks
   * the settlement history.
   */
  private async claimRecoveryQueue(queue: 'RESULT_MISSING' | 'COMPLETION_UNVERIFIED', limit: number) {
    const stampedAt = new Date()
    const claimed = queue === 'RESULT_MISSING'
      ? await prisma.$queryRaw<Array<{ id: string }>>`
          WITH picked AS (
            SELECT e.id FROM escrows e
            WHERE e.status IN ('COMPLETED', 'REFUNDED', 'SPLIT') AND e."txReleaseId" IS NULL
            ORDER BY e."settlementRecoveryAttemptedAt" ASC NULLS FIRST, e."updatedAt" DESC, e.id
            LIMIT ${limit}
            FOR UPDATE OF e SKIP LOCKED
          )
          UPDATE escrows e SET "settlementRecoveryAttemptedAt" = ${stampedAt}
          FROM picked WHERE e.id = picked.id
          RETURNING e.id`
      : await prisma.$queryRaw<Array<{ id: string }>>`
          WITH picked AS (
            SELECT e.id FROM escrows e
            WHERE e.status IN ('COMPLETED', 'REFUNDED', 'SPLIT') AND e."txReleaseId" IS NOT NULL AND e."completionVerifiedAt" IS NULL
            ORDER BY e."settlementRecoveryAttemptedAt" ASC NULLS FIRST, e."updatedAt" DESC, e.id
            LIMIT ${limit}
            FOR UPDATE OF e SKIP LOCKED
          )
          UPDATE escrows e SET "settlementRecoveryAttemptedAt" = ${stampedAt}
          FROM picked WHERE e.id = picked.id
          RETURNING e.id`
    if (claimed.length === 0) return []
    return prisma.escrow.findMany({ where: { id: { in: claimed.map((row) => row.id) } } })
  }

  async markCompletionVerifiedIfConverged(escrowId: string) {
    const marked = await prisma.$executeRaw`
      UPDATE escrows e SET "completionVerifiedAt" = ${new Date()}
      WHERE e.id = ${escrowId} AND e."completionVerifiedAt" IS NULL
        AND e.status IN ('COMPLETED', 'REFUNDED', 'SPLIT') AND e."txReleaseId" IS NOT NULL
        AND EXISTS (SELECT 1 FROM escrow_events v WHERE v."escrowId" = e.id AND v."toStatus" = e.status)
        AND NOT EXISTS (SELECT 1 FROM escrow_pending_transactions p WHERE p."escrowId" = e.id)`
    return marked === 1
  }

  /**
   * Candidate: a pending operation on an open (non-terminal) MULTISIG escrow
   * whose every required signer has a stored signature. Order: by the
   * operation's last claim, or its creation if never claimed, oldest first,
   * stamped in the same statement. Keys only grow, so an operation that stays
   * a candidate (an anomaly, an explorer outage) moves behind every other one
   * after each claim, and each candidate is reached within ceil(rows ahead /
   * claims per run) runs: old and new candidates cannot starve each other,
   * across restarts and instances. SKIP LOCKED gives overlapping claims
   * different rows. The stamp decides order only: what happens to a claimed
   * operation is still decided by chain truth, claimEscrowTransition() and
   * the write-once result, and a crash after the claim only moves it back one
   * lap. The escrows side reads escrows_open_multisig_idx (migration
   * 20260930140000), never the settled history.
   */
  async claimUnclaimedSignedPendingOperation(runStartedAt: Date) {
    const [claimed] = await prisma.$queryRaw<Array<{ id: string }>>`
      WITH open_escrows AS MATERIALIZED (
        -- First, and separately: the open MULTISIG escrows (escrows_open_multisig_idx). Left to itself
        -- the planner may instead start from every pending row ever written (leaked history included)
        -- and run the signature check against each one.
        SELECT id FROM escrows WHERE type = 'MULTISIG' AND status NOT IN ('COMPLETED', 'REFUNDED', 'SPLIT')
      ), picked AS (
        SELECT p.id FROM open_escrows o
        JOIN escrow_pending_transactions p ON p."escrowId" = o.id
        WHERE (p."unclaimedRecoveryAttemptedAt" IS NULL OR p."unclaimedRecoveryAttemptedAt" < ${runStartedAt})
          AND NOT EXISTS (
            SELECT 1 FROM unnest(p."requiredSigners") AS r(id)
            WHERE NOT EXISTS (SELECT 1 FROM escrow_transaction_signatures s WHERE s."pendingTxId" = p.id AND s."participantId" = r.id))
        ORDER BY COALESCE(p."unclaimedRecoveryAttemptedAt", p."createdAt"), p.id
        LIMIT 1
        FOR UPDATE OF p SKIP LOCKED
      )
      UPDATE escrow_pending_transactions p SET "unclaimedRecoveryAttemptedAt" = ${new Date()}
      FROM picked WHERE p.id = picked.id
      RETURNING p.id`
    return claimed?.id ?? null
  }

  async findDisputeByTradeAndArbiter(tradeId: string, arbiterId: string) {
    return prisma.dispute.findFirst({ where: { tradeId, arbiterId } })
  }

  async updateMultisigAddr(escrowId: string, multisigAddr: string) {
    return prisma.escrow.update({ where: { id: escrowId }, data: { multisigAddr } })
  }

  async updateLockResult(escrowId: string, data: { txLockId: string; txLockVout: number | null; multisigAddr: string; lockedAt: Date; expiresAt: Date; fundedAmount?: number }) {
    try {
      return await prisma.escrow.update({ where: { id: escrowId }, data })
    } catch (err: any) {
      // Missão 10 — the @@unique([txLockId, txLockVout]) constraint
      // firing here means another escrow already claimed this exact
      // outpoint (only possible when data.txLockVout is non-null — see
      // that column's own schema comment for why legacy/null-vout rows
      // never trigger this). Same P2002-to-EscrowError wrap
      // escrow-pending-tx.ts's initiateSignatureCollectionCore() already
      // uses for its own unique-constraint race.
      if (err?.code === 'P2002') {
        throw new EscrowError(
          `Funding outpoint ${data.txLockId}:${data.txLockVout} is already claimed by another escrow — refusing to double-assign the same Bitcoin UTXO.`
        )
      }
      throw err
    }
  }

  async claimTransition(escrowId: string, fromStatus: string, toStatus: string, tx?: Prisma.TransactionClient): Promise<number> {
    const client = tx ?? prisma
    const claim = await client.escrow.updateMany({
      where: { id: escrowId, status: fromStatus as any },
      data: { status: toStatus as any },
    })
    return claim.count
  }

  async claimDirectExecution(escrowId: string, fromStatus: string, toStatus: DirectExecutionDisposition, intent: DirectExecutionIntent): Promise<number> {
    const frozen = fromStatus === 'DISPUTED'
      ? { arbitratedDisposition: toStatus, splitBuyerBps: intent.splitBuyerBps ?? null }
      : { cooperativeDisposition: toStatus, cooperativeTriggeredBy: intent.triggeredBy }
    const empty = fromStatus === 'DISPUTED' ? { arbitratedDisposition: null } : { cooperativeDisposition: null }
    const authority = fromStatus === 'DISPUTED' ? { arbitratedTriggeredBy: intent.triggeredBy } : {}
    const claim = await prisma.escrow.updateMany({
      where: { id: escrowId, status: fromStatus as any, OR: [empty, frozen] },
      data: { status: toStatus, ...frozen, ...authority },
    })
    return claim.count
  }

  async persistSettlementResult(escrowId: string, result: SettlementResultInput, opts: SettlementResultWriteOptions = {}) {
    const run = async (tx: Prisma.TransactionClient): Promise<EscrowRow> => {
      // Same escrow-scoped advisory lock the reconciler (withEscrowFundingLock)
      // and emitEscrowTransition() take, so a live writer and a recovery
      // writer for one escrow are serialized. Re-entrant inside a caller's
      // own transaction that already holds it.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${escrowId})::bigint)`
      const current = await tx.escrow.findUnique({ where: { id: escrowId } })
      if (!current) throw new EscrowError(`Escrow ${escrowId} not found while persisting settlement result`)

      if (current.txReleaseId == null) {
        if (opts.operation) {
          const live = await tx.escrowPendingTransaction.findFirst({
            where: { id: opts.operation.pendingOperationId, escrowId },
            select: { id: true },
          })
          if (!live) {
            throw new SettlementResultConflictError(
              `Settlement result ${result.txReleaseId} for escrow ${escrowId} is bound to pending operation ` +
              `${opts.operation.pendingOperationId}, which is no longer the escrow's live operation - refusing to record its evidence`
            )
          }
        }
        // Serialized by the advisory lock above against every other writer of this
        // escrow's result; the database trigger (escrows_settlement_result_write_once_guard)
        // is the final backstop for any writer that bypasses this primitive.
        return tx.escrow.update({
          where: { id: escrowId },
          data: {
            txReleaseId: result.txReleaseId,
            ...(result.releasedAt && current.releasedAt == null ? { releasedAt: result.releasedAt } : {}),
            ...(result.feeCharged !== undefined ? { feeCharged: result.feeCharged } : {}),
          },
        })
      }

      if (current.txReleaseId === result.txReleaseId) {
        // Idempotent replay. releasedAt is write-once: fill only if it was never set; never refresh it.
        if (result.releasedAt && current.releasedAt == null) {
          return tx.escrow.update({ where: { id: escrowId }, data: { releasedAt: result.releasedAt } })
        }
        return current
      }

      throw new SettlementResultConflictError(
        `Settlement result integrity conflict for escrow ${escrowId}: durable txReleaseId ${current.txReleaseId} cannot be replaced by ${result.txReleaseId}`
      )
    }
    return opts.tx ? run(opts.tx) : prisma.$transaction(run)
  }

  async updateReleaseResult(escrowId: string, data: { txReleaseId: string; releasedAt: Date; feeCharged: Prisma.Decimal | null }, opts?: SettlementResultWriteOptions) {
    return this.persistSettlementResult(escrowId, data, opts)
  }

  async updateRefundResult(escrowId: string, txReleaseId: string, opts?: SettlementResultWriteOptions) {
    return this.persistSettlementResult(escrowId, { txReleaseId }, opts)
  }

  async updateSplitResult(escrowId: string, data: { txReleaseId: string; releasedAt: Date }, opts?: SettlementResultWriteOptions) {
    return this.persistSettlementResult(escrowId, data, opts)
  }

  async updateSignatureCollectionResult(escrowId: string, data: { txReleaseId: string; releasedAt?: Date }, opts?: SettlementResultWriteOptions) {
    return this.persistSettlementResult(escrowId, data, opts)
  }

  async revertStatus(escrowId: string, claimedStatus: string, fromStatus: string) {
    const reverted = await prisma.escrow.updateMany({
      where: { id: escrowId, status: claimedStatus as any },
      data: { status: fromStatus as any },
    })
    return reverted.count
  }
}

export const escrowRepository: EscrowRepository = new PrismaEscrowRepository()
