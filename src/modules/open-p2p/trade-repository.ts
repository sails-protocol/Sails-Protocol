/**
 * TradeRepository — Sails OpenP2P Component
 *
 * ARCHITECTURE_AUDIT_REPORT.md recommendation #3 ("... TradeRepository,
 * EscrowRepository — dependência via injeção no construtor"), step 3 of
 * the incremental rollout (step 1: CapabilityGrantRepository, step 2:
 * IntentRepository, both in src/core/). Unlike those two, Trade is not a
 * core-protocol entity — every consumer (trade.service.ts,
 * negotiation.service.ts, reconciliation.service.ts, trade.routes.ts,
 * chat.routes.ts) lives under modules/open-p2p, so this is co-located
 * here rather than in src/core/ — the same "module-owned DI interface
 * next to the service that uses it" precedent
 * modules/open-settlement/arbitration-provider.ts already established
 * for DisputeService's own constructor-injected dependency.
 *
 * Every method here is a verbatim move of an existing Prisma query — no
 * behavior change. findOfferById() bundles the one prisma.offer.* read
 * createTrade() needs alongside prisma.trade.*, the same "one repository
 * per *consumer*, not strictly one per table" precedent IntentRepository
 * already set by bundling prisma.intentEvent.* alongside prisma.intent.*.
 *
 * findById() (bare row, no relations) is the one shared shape behind
 * updateStatus()'s own ownership-check read, negotiationService.open()'s
 * existence check, and TradeService.assertParticipant() — itself the one
 * implementation behind 4 lightweight authorization-gate call sites this
 * step also closes (trade.routes.ts's /reconcile handler,
 * chat.routes.ts's JOIN_TRADE/SEND_MESSAGE/GET messages).
 * findByIdWithDetails()/findByIntentId()/findByIdWithEscrow() are three
 * DIFFERENT include shapes for "by id" — getTrade() needs
 * escrow+messages+offer, getTradeByIntentId() needs only escrow+offer,
 * reconciliationService.reconcileTrade() needs only escrow — collapsing
 * these into one over-fetching method would be exactly the
 * "getTrade() over-fetches for what's just an authorization gate"
 * problem assertParticipant() itself exists to avoid, just moved one
 * level down.
 *
 * negotiation.service.ts's open() and reconciliation.service.ts's
 * reconcileTrade()/reconcilePeerPair() also moved onto this repository
 * (findById/findByIdWithEscrow/findActiveTradeIdsBetween) even though
 * the audit doc's own operative rollout section named only
 * trade.service.ts/trade.routes.ts/chat.routes.ts — both files are
 * same-module (open-p2p) direct Trade access, the exact pattern this
 * repository exists to close, per escrow.service.ts's own header
 * comment: "cross-module read is fine, cross-module write requires the
 * owning module's abstraction" applied evenly to same-module reads too.
 */
import { randomUUID } from 'crypto'
import { prisma } from '../../common/database'
import type { Prisma } from '@prisma/client'
import type { AssetType, TradeStatus } from '../../common/types'
import type { EscrowType } from '../../common/types/trade'
import { TradeAdmissionError } from '../../common/errors'
import { lockTradeLifecycle } from './trade-lifecycle-lock'
import { unilateralRevocationBlocker } from '../open-settlement/unilateral-revocation'

/** '<CODE>: <reason>' from escrow_economic_binding_violation(): the policy refusing the rail or method, or a binding the new trade lacks. */
function tradeAdmissionRefused(violation: string): TradeAdmissionError {
  const policy = /^(RAIL_NOT_ELIGIBLE|METHOD_NOT_ELIGIBLE):/.test(violation)
  return new TradeAdmissionError(`Trade refused by the economic authorization binding — ${violation}`, policy ? 'DISABLED' : 'INELIGIBLE')
}

type TradeRow = NonNullable<Awaited<ReturnType<typeof prisma.trade.findUnique>>>
type OfferRow = NonNullable<Awaited<ReturnType<typeof prisma.offer.findUnique>>>
type TradeWithEscrowRow = Prisma.TradeGetPayload<{ include: { escrow: true } }>
type TradeWithEscrowAndOfferRow = Prisma.TradeGetPayload<{ include: { escrow: true; offer: true } }>
type TradeWithDetailsRow = Prisma.TradeGetPayload<{
  include: { escrow: true; messages: true; offer: true }
}>

export interface CreateTradeData {
  offerId: string
  buyerId: string
  sellerId: string
  asset: AssetType
  amount: string
  priceUsd: Prisma.Decimal | string
  totalUsd: string
  network: string | null
  intentId: string | null
  /** #235 R7C — the seller's PaymentAccount bound to this trade, already verified by the caller; null = unbound. */
  sellerPaymentAccountId?: string | null
  /**
   * #235 R7H-E3C — the canonical rail this trade would be escrowed on. When set, the trade is admitted only if that
   * escrow could be authorized: escrow_economic_binding_violation() is evaluated on the new, uncommitted trade row
   * in the inserting transaction (it returns NULL for ungoverned rails). null/absent: no trade-backed escrow exists
   * for the asset, nothing to check.
   */
  escrowRail?: { type: EscrowType; asset: AssetType } | null
}

/** The idempotency scope of trade creation (idempotency_keys.scope). */
export const TRADE_CREATE_SCOPE = 'openp2p.trade.create'

/** A committed or legacy-stuck idempotency claim row for a trade creation request. */
export interface AdmissionClaim {
  id: string
  status: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'UNKNOWN'
  requestHash: string
  resultRef: string | null
  createdAt: Date
}

/**
 * #235 R7H-NF-E3C-5 — everything the ATOMIC ADMISSION UNIT needs. One PostgreSQL transaction holds, in this order:
 * (1) the idempotency claim, inserted already COMPLETED with its result reference; (2) `beforeTrade` — the trade's own
 * Intent and its durable events, written by the service's callback; (3) the Trade; (4) the unchanged E3C admission
 * check (`escrow_economic_binding_violation`); (5) `afterAdmission` — the trade/negotiation durable events. A refusal
 * at any step rolls ALL of it back: no claim, no Intent, no trade, no event. After COMMIT the caller dispatches.
 */
export interface AdmitTradeInput extends CreateTradeData {
  /** Absent: no idempotency key was given, so there is no claim row (the rest of the unit is unchanged). */
  claim?: { participantId: string; key: string; requestHash: string }
  /** Writes the trade's own Intent (and its durable events) in `tx`; returns its id and the post-commit dispatch. */
  beforeTrade(tx: Prisma.TransactionClient, ctx: { tradeId: string }): Promise<{ tradeIntentId: string; dispatch: () => void }>
  /** Writes the trade's durable events in `tx` once the trade passed admission; returns the post-commit dispatch. */
  afterAdmission(tx: Prisma.TransactionClient, trade: TradeRow): Promise<{ dispatch: () => void }>
}

export type AdmitTradeResult =
  /** `dispatches` run AFTER commit, each independently; the caller owns the failure boundary (non-authoritative). */
  | { kind: 'ADMITTED'; trade: TradeRow; dispatches: Array<() => void> }
  /** The key already has a claim (committed by another request, or a legacy row): nothing was written. */
  | { kind: 'EXISTING_CLAIM'; claim: AdmissionClaim }

export interface TradeRepository {
  /** The claim row for (caller, key) in the trade-creation scope, if any — read BEFORE validation so a replay is never re-validated. */
  findAdmissionClaim(participantId: string, key: string): Promise<AdmissionClaim | null>

  /** The atomic admission unit — see AdmitTradeInput. */
  admit(input: AdmitTradeInput): Promise<AdmitTradeResult>

  /** createTrade()'s own Offer existence check — see this file's header comment for why an Offer read lives on TradeRepository rather than a separate repository. */
  findOfferById(offerId: string): Promise<OfferRow | null>

  create(input: CreateTradeData): Promise<TradeRow>

  /** Bare row, no relations. Shared by updateStatus()'s ownership-check read, negotiationService.open()'s existence check, and TradeService.assertParticipant() — the one shape 4 separate lightweight auth-gate call sites go through. */
  findById(tradeId: string): Promise<TradeRow | null>

  /** escrow + messages(createdAt asc) + offer — getTrade()'s full detail view. */
  findByIdWithDetails(tradeId: string): Promise<TradeWithDetailsRow | null>

  /**
   * #235 R7H-NF-E3C-5 (F-7) — escrow + offer, every trade the CALLER is a party to that references `intentId`,
   * oldest first. Never an arbitrary `findFirst`, and never a trade the caller is not a party to: the caller scope is
   * part of the query, so nothing about other participants' trades is read or revealed.
   */
  findByIntentForParticipant(intentId: string, participantId: string): Promise<TradeWithEscrowAndOfferRow[]>

  /** escrow only — reconciliationService.reconcileTrade()'s own shape. */
  findByIdWithEscrow(tradeId: string): Promise<TradeWithEscrowRow | null>

  /** Trades where participantId is buyer OR seller, newest first — getTrades()'s page of results. Caller (TradeService) already clamps limit/offset before calling. */
  findManyByParticipant(participantId: string, take: number, skip: number): Promise<TradeWithEscrowRow[]>

  /** Same (buyerId OR sellerId) filter as findManyByParticipant() — kept as its own method (not a combined {trades,total} call) so each method stays a literal 1:1 Prisma-call wrap; TradeService's own Promise.all still does the composition, unchanged from today. */
  countByParticipant(participantId: string): Promise<number>

  /** id-only projection of every still-active (PENDING/ACTIVE) trade between two participants — reconciliationService.reconcilePeerPair()'s own shape. The active-status list moves here from reconciliation.service.ts since it's this query's own where-clause detail, not a general trade-lifecycle constant. */
  findActiveTradeIdsBetween(participantAId: string, participantBId: string): Promise<{ id: string }[]>

  /** updateStatus()'s own write — cancelledAt is the caller's job to compute (status === 'CANCELLED' ? new Date() : undefined), same as today. */
  updateStatus(tradeId: string, status: TradeStatus, cancelledAt: Date | undefined): Promise<TradeRow>

  /**
   * Issue #294 - project the PERSISTED Escrow state onto the Trade (Escrow is
   * authoritative, Trade is only a projection). Runs under the escrow-scoped
   * advisory lock, reads the escrow's CURRENT persisted status (never the state
   * an event payload claims), and applies it monotonically:
   *   - a stale/reordered event can never regress the Trade (terminal never
   *     goes back to ACTIVE/DISPUTED; DISPUTED never goes back to ACTIVE);
   *   - completedAt / cancelledAt are write-once (a replay never re-stamps them);
   *   - a terminal Escrow state converges the Trade to it (Escrow outranks a
   *     conflicting Trade terminal, e.g. an earlier manual cancel).
   */
  projectEscrowStatus(tradeId: string, escrowId: string, opts?: { tx?: Prisma.TransactionClient }): Promise<TradeProjectionResult>

  /**
   * Issue #294 - a participant-requested Trade transition (PENDING/ACTIVE ->
   * ACTIVE/CANCELLED) with the same authoritative-state discipline as the
   * Escrow-derived projection: CAS on the Trade's expected current status,
   * serialized under the escrow lock, and refused once the Escrow already
   * governs the economic outcome (DISPUTED / COMPLETED / SPLIT / REFUNDED / EXPIRED).
   * #235 R7G-B1 - a cancellation is also refused once funds may exist for the
   * trade (unilateral-revocation.ts), and `withinTransaction` runs after the
   * Trade write in the same transaction: if it throws, nothing is persisted.
   */
  transitionManually(
    tradeId: string, from: TradeStatus, to: TradeStatus, cancelledAt: Date | undefined,
    withinTransaction?: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<ManualTradeTransitionResult>
}

export type TradeProjectionResult =
  | { applied: true; from: TradeStatus; to: TradeStatus }
  | { applied: false; reason: 'ESCROW_NOT_FOUND' | 'TRADE_MISMATCH' | 'NO_PROJECTION' | 'ALREADY_PROJECTED' | 'STALE_OR_WEAKER'; tradeStatus?: TradeStatus }

export type ManualTradeTransitionResult =
  | { ok: true; trade: NonNullable<Awaited<ReturnType<typeof prisma.trade.findUnique>>> }
  | { ok: false; reason: 'STALE_STATUS' | 'ESCROW_GOVERNED'; escrowStatus?: string }
  | { ok: false; reason: 'ECONOMIC_COMMITMENT'; escrowStatus: string; detail: string }

// Escrow (authoritative) -> the Trade status it projects. EXPIRED/CREATED project nothing.
const ESCROW_TO_TRADE_STATUS: Record<string, TradeStatus | undefined> = {
  FUNDS_LOCKED: 'ACTIVE',
  PAYMENT_PENDING: 'ACTIVE',
  DISPUTED: 'DISPUTED',
  COMPLETED: 'COMPLETED',
  SPLIT: 'COMPLETED',
  REFUNDED: 'CANCELLED',
}
const TRADE_RANK: Record<string, number> = { PENDING: 0, ACTIVE: 1, DISPUTED: 2, COMPLETED: 3, CANCELLED: 3 }
// #235 R7G-B1 - EXPIRED is economically governed: funds are still locked and its recovery path decides.
const ESCROW_GOVERNED_STATUSES = new Set(['DISPUTED', 'COMPLETED', 'SPLIT', 'REFUNDED', 'EXPIRED'])

const ACTIVE_TRADE_STATUSES = ['PENDING', 'ACTIVE'] as const

class PrismaTradeRepository implements TradeRepository {
  async findOfferById(offerId: string) {
    return prisma.offer.findUnique({ where: { id: offerId } })
  }

  async findAdmissionClaim(participantId: string, key: string): Promise<AdmissionClaim | null> {
    const [row] = await prisma.$queryRaw<Array<AdmissionClaim>>`
      SELECT id, status::text AS status, "requestHash", "resultRef", "createdAt"
      FROM idempotency_keys
      WHERE scope = ${TRADE_CREATE_SCOPE} AND "participantId" = ${participantId} AND key = ${key}`
    return row ?? null
  }

  async admit(input: AdmitTradeInput): Promise<AdmitTradeResult> {
    const tradeId = randomUUID()
    const rail = input.escrowRail
    return prisma.$transaction(async (tx) => {
      // (1) The claim FIRST, as INSERT ... ON CONFLICT DO NOTHING: a unique-key conflict inside a PostgreSQL
      // transaction aborts it (25P02 for every following statement), so a conflict must never be an exception here.
      // If another transaction owns the key this statement WAITS for it, then returns no row: its committed result
      // is read, nothing of ours was written, and the (empty) transaction ends — the caller recovers or refuses.
      if (input.claim) {
        const { participantId, key, requestHash } = input.claim
        const inserted = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO idempotency_keys (id, scope, "participantId", key, "requestHash", status, "resultRef", "completedAt")
          VALUES (${randomUUID()}, ${TRADE_CREATE_SCOPE}, ${participantId}, ${key}, ${requestHash},
                  'COMPLETED'::"IdempotencyKeyStatus", ${tradeId}, now())
          ON CONFLICT (scope, "participantId", key) DO NOTHING
          RETURNING id`
        if (inserted.length === 0) {
          const [existing] = await tx.$queryRaw<AdmissionClaim[]>`
            SELECT id, status::text AS status, "requestHash", "resultRef", "createdAt"
            FROM idempotency_keys
            WHERE scope = ${TRADE_CREATE_SCOPE} AND "participantId" = ${participantId} AND key = ${key}`
          if (!existing) throw new Error(`Idempotency claim for key '${key}' vanished during trade admission`)
          // A claim an old-code request marked FAILED (its persist() threw before any trade existed) is reclaimed
          // for this attempt, atomically with it — the same semantics as the legacy reclaimFailed().
          if (existing.status !== 'FAILED' || existing.requestHash !== requestHash) {
            return { kind: 'EXISTING_CLAIM', claim: existing } as const
          }
          const reclaimed = await tx.$queryRaw<Array<{ id: string }>>`
            UPDATE idempotency_keys
            SET status = 'COMPLETED'::"IdempotencyKeyStatus", "resultRef" = ${tradeId}, "completedAt" = now()
            WHERE id = ${existing.id} AND status = 'FAILED'::"IdempotencyKeyStatus"
            RETURNING id`
          if (reclaimed.length === 0) return { kind: 'EXISTING_CLAIM', claim: { ...existing, status: 'IN_PROGRESS' } } as const
        }
      }

      // (2) The trade's own Intent (FK target of trades.tradeIntentId) and its durable events.
      const intent = await input.beforeTrade(tx, { tradeId })

      // (3) The trade, with its originating Offer Intent (`intentId`) and its own (`tradeIntentId`).
      const trade = await tx.trade.create({
        data: {
          id: tradeId,
          offerId: input.offerId,
          buyerId: input.buyerId,
          sellerId: input.sellerId,
          asset: input.asset,
          amount: input.amount,
          priceUsd: input.priceUsd,
          totalUsd: input.totalUsd,
          network: input.network,
          intentId: input.intentId,
          tradeIntentId: intent.tradeIntentId,
          sellerPaymentAccountId: input.sellerPaymentAccountId ?? null,
        },
      })

      // (4) The unchanged E3C admission check (the E3 authority, on the uncommitted row). A violation aborts the
      // whole unit: the claim, the Intent, the trade and every event above are rolled back together.
      if (rail) {
        const [admission] = await tx.$queryRaw<Array<{ violation: string | null }>>`
          SELECT escrow_economic_binding_violation(${tradeId}, ${rail.type}::"EscrowType", ${rail.asset}::"AssetType") AS violation`
        if (admission?.violation) throw tradeAdmissionRefused(admission.violation)
      }

      // (5) The trade's durable events. Committed with the trade, dispatched after.
      const events = await input.afterAdmission(tx, trade)
      return { kind: 'ADMITTED', trade, dispatches: [intent.dispatch, events.dispatch] } as const
    })
  }

  async create(input: CreateTradeData) {
    const data = {
      offerId: input.offerId,
      buyerId: input.buyerId,
      sellerId: input.sellerId,
      asset: input.asset,
      amount: input.amount,
      priceUsd: input.priceUsd,
      totalUsd: input.totalUsd,
      network: input.network,
      intentId: input.intentId,
      sellerPaymentAccountId: input.sellerPaymentAccountId ?? null,
    }
    const rail = input.escrowRail
    if (!rail) return prisma.trade.create({ data })
    // #235 R7H-E3C — the same authority escrow creation answers to (migration 20261017120000), asked about the
    // trade before it is committed: the function locks the offer and the bound account FOR SHARE until this
    // transaction ends, and a refusal rolls the insert back — no trade, nothing downstream.
    return prisma.$transaction(async (tx) => {
      const trade = await tx.trade.create({ data })
      const [admission] = await tx.$queryRaw<Array<{ violation: string | null }>>`
        SELECT escrow_economic_binding_violation(${trade.id}, ${rail.type}::"EscrowType", ${rail.asset}::"AssetType") AS violation`
      if (admission?.violation) throw tradeAdmissionRefused(admission.violation)
      return trade
    })
  }

  async findById(tradeId: string) {
    return prisma.trade.findUnique({ where: { id: tradeId } })
  }

  async findByIdWithDetails(tradeId: string) {
    return prisma.trade.findUnique({
      where: { id: tradeId },
      include: { escrow: true, messages: { orderBy: { createdAt: 'asc' } }, offer: true },
    })
  }

  async findByIntentForParticipant(intentId: string, participantId: string) {
    return prisma.trade.findMany({
      // `intentId` is the originating Offer's (or a legacy trade's shared) Intent; `tradeIntentId` is one trade's OWN
      // Intent. Both resolve here, always intersected with "the caller is a party".
      where: {
        AND: [
          { OR: [{ intentId }, { tradeIntentId: intentId }] },
          { OR: [{ buyerId: participantId }, { sellerId: participantId }] },
        ],
      },
      include: { escrow: true, offer: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
  }

  async findByIdWithEscrow(tradeId: string) {
    return prisma.trade.findUnique({ where: { id: tradeId }, include: { escrow: true } })
  }

  async findManyByParticipant(participantId: string, take: number, skip: number) {
    return prisma.trade.findMany({
      where: { OR: [{ buyerId: participantId }, { sellerId: participantId }] },
      orderBy: { createdAt: 'desc' },
      take,
      skip,
      include: { escrow: true },
    })
  }

  async countByParticipant(participantId: string) {
    return prisma.trade.count({
      where: { OR: [{ buyerId: participantId }, { sellerId: participantId }] },
    })
  }

  async findActiveTradeIdsBetween(participantAId: string, participantBId: string) {
    return prisma.trade.findMany({
      where: {
        status: { in: [...ACTIVE_TRADE_STATUSES] },
        OR: [
          { buyerId: participantAId, sellerId: participantBId },
          { buyerId: participantBId, sellerId: participantAId },
        ],
      },
      select: { id: true },
    })
  }

  async updateStatus(tradeId: string, status: TradeStatus, cancelledAt: Date | undefined) {
    return prisma.trade.update({ where: { id: tradeId }, data: { status, cancelledAt } })
  }

  async projectEscrowStatus(tradeId: string, escrowId: string, opts: { tx?: Prisma.TransactionClient } = {}): Promise<TradeProjectionResult> {
    const run = async (tx: Prisma.TransactionClient): Promise<TradeProjectionResult> => {
      // Same escrow-scoped advisory lock emitEscrowTransition()/withEscrowFundingLock()/persistSettlementResult() take.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${escrowId})::bigint)`
      const escrow = await tx.escrow.findUnique({ where: { id: escrowId } })
      if (!escrow) return { applied: false, reason: 'ESCROW_NOT_FOUND' } as const
      if (escrow.tradeId !== tradeId) return { applied: false, reason: 'TRADE_MISMATCH' } as const

      const target = ESCROW_TO_TRADE_STATUS[escrow.status]
      if (!target) return { applied: false, reason: 'NO_PROJECTION' } as const

      const trade = await tx.trade.findUnique({ where: { id: tradeId } })
      if (!trade) return { applied: false, reason: 'TRADE_MISMATCH' } as const
      const current = trade.status as TradeStatus

      const targetIsTerminal = TRADE_RANK[target] === 3
      const converges =
        TRADE_RANK[target] > TRADE_RANK[current] ||
        // Authoritative terminal Escrow state outranks a different Trade terminal.
        (targetIsTerminal && TRADE_RANK[current] === 3 && current !== target)

      if (!converges) {
        // Same status: only backfill a missing write-once timestamp (never re-stamp).
        if (current === target && targetIsTerminal) {
          const needsStamp = target === 'COMPLETED' ? trade.completedAt == null : trade.cancelledAt == null
          if (needsStamp) {
            await tx.trade.update({
              where: { id: tradeId },
              data: target === 'COMPLETED' ? { completedAt: new Date() } : { cancelledAt: new Date() },
            })
          }
        }
        return current === target
          ? ({ applied: false, reason: 'ALREADY_PROJECTED', tradeStatus: current } as const)
          : ({ applied: false, reason: 'STALE_OR_WEAKER', tradeStatus: current } as const)
      }

      await tx.trade.update({
        where: { id: tradeId },
        data: {
          status: target,
          ...(target === 'COMPLETED' && trade.completedAt == null ? { completedAt: new Date() } : {}),
          ...(target === 'CANCELLED' && trade.cancelledAt == null ? { cancelledAt: new Date() } : {}),
        },
      })
      return { applied: true, from: current, to: target } as const
    }
    return opts.tx ? run(opts.tx) : prisma.$transaction(run)
  }

  async transitionManually(
    tradeId: string, from: TradeStatus, to: TradeStatus, cancelledAt: Date | undefined,
    withinTransaction?: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<ManualTradeTransitionResult> {
    return prisma.$transaction(async (tx) => {
      // #235 R7G-A — serialized against the creation of the trade's first escrow
      // (trade-lifecycle-lock.ts), so the escrow read below is authoritative.
      await lockTradeLifecycle(tx, tradeId)
      const escrow = await tx.escrow.findUnique({ where: { tradeId } })
      if (escrow) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${escrow.id})::bigint)`
        const fresh = await tx.escrow.findUnique({ where: { id: escrow.id } })
        if (fresh && ESCROW_GOVERNED_STATUSES.has(fresh.status)) {
          return { ok: false, reason: 'ESCROW_GOVERNED', escrowStatus: fresh.status } as const
        }
        const blocker = fresh && to === 'CANCELLED' ? await unilateralRevocationBlocker(tx, fresh) : null
        if (blocker) return { ok: false, reason: 'ECONOMIC_COMMITMENT', escrowStatus: fresh!.status, detail: blocker } as const
      }
      const claimed = await tx.trade.updateMany({
        where: { id: tradeId, status: from },
        data: { status: to, ...(cancelledAt ? { cancelledAt } : {}) },
      })
      if (claimed.count === 0) return { ok: false, reason: 'STALE_STATUS' } as const
      if (withinTransaction) await withinTransaction(tx)
      const trade = await tx.trade.findUnique({ where: { id: tradeId } })
      return { ok: true, trade: trade! } as const
    })
  }
}

export const tradeRepository: TradeRepository = new PrismaTradeRepository()
