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
import { prisma } from '../../common/database'
import type { Prisma } from '@prisma/client'
import type { AssetType, TradeStatus } from '../../common/types'

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
}

export interface TradeRepository {
  /** createTrade()'s own Offer existence check — see this file's header comment for why an Offer read lives on TradeRepository rather than a separate repository. */
  findOfferById(offerId: string): Promise<OfferRow | null>

  create(input: CreateTradeData): Promise<TradeRow>

  /** Bare row, no relations. Shared by updateStatus()'s ownership-check read, negotiationService.open()'s existence check, and TradeService.assertParticipant() — the one shape 4 separate lightweight auth-gate call sites go through. */
  findById(tradeId: string): Promise<TradeRow | null>

  /** escrow + messages(createdAt asc) + offer — getTrade()'s full detail view. */
  findByIdWithDetails(tradeId: string): Promise<TradeWithDetailsRow | null>

  /** escrow + offer, first match on intentId — getTradeByIntentId()'s own shape for @satsails/p2p-trading-sdk's dispute() facade. */
  findByIntentId(intentId: string): Promise<TradeWithEscrowAndOfferRow | null>

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
   * governs the economic outcome (DISPUTED / COMPLETED / SPLIT / REFUNDED).
   */
  transitionManually(tradeId: string, from: TradeStatus, to: TradeStatus, cancelledAt: Date | undefined): Promise<ManualTradeTransitionResult>
}

export type TradeProjectionResult =
  | { applied: true; from: TradeStatus; to: TradeStatus }
  | { applied: false; reason: 'ESCROW_NOT_FOUND' | 'TRADE_MISMATCH' | 'NO_PROJECTION' | 'ALREADY_PROJECTED' | 'STALE_OR_WEAKER'; tradeStatus?: TradeStatus }

export type ManualTradeTransitionResult =
  | { ok: true; trade: NonNullable<Awaited<ReturnType<typeof prisma.trade.findUnique>>> }
  | { ok: false; reason: 'STALE_STATUS' | 'ESCROW_GOVERNED'; escrowStatus?: string }

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
const ESCROW_GOVERNED_STATUSES = new Set(['DISPUTED', 'COMPLETED', 'SPLIT', 'REFUNDED'])

const ACTIVE_TRADE_STATUSES = ['PENDING', 'ACTIVE'] as const

class PrismaTradeRepository implements TradeRepository {
  async findOfferById(offerId: string) {
    return prisma.offer.findUnique({ where: { id: offerId } })
  }

  async create(input: CreateTradeData) {
    return prisma.trade.create({
      data: {
        offerId: input.offerId,
        buyerId: input.buyerId,
        sellerId: input.sellerId,
        asset: input.asset,
        amount: input.amount,
        priceUsd: input.priceUsd,
        totalUsd: input.totalUsd,
        network: input.network,
        intentId: input.intentId,
      },
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

  async findByIntentId(intentId: string) {
    return prisma.trade.findFirst({
      where: { intentId },
      include: { escrow: true, offer: true },
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

  async transitionManually(tradeId: string, from: TradeStatus, to: TradeStatus, cancelledAt: Date | undefined): Promise<ManualTradeTransitionResult> {
    return prisma.$transaction(async (tx) => {
      const escrow = await tx.escrow.findUnique({ where: { tradeId } })
      if (escrow) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${escrow.id})::bigint)`
        const fresh = await tx.escrow.findUnique({ where: { id: escrow.id } })
        if (fresh && ESCROW_GOVERNED_STATUSES.has(fresh.status)) {
          return { ok: false, reason: 'ESCROW_GOVERNED', escrowStatus: fresh.status } as const
        }
      }
      const claimed = await tx.trade.updateMany({
        where: { id: tradeId, status: from },
        data: { status: to, ...(cancelledAt ? { cancelledAt } : {}) },
      })
      if (claimed.count === 0) return { ok: false, reason: 'STALE_STATUS' } as const
      const trade = await tx.trade.findUnique({ where: { id: tradeId } })
      return { ok: true, trade: trade! } as const
    })
  }
}

export const tradeRepository: TradeRepository = new PrismaTradeRepository()
