/**
 * Sails OpenP2P — Trade Service
 *
 * negotiation.service.ts already owns the negotiation channel/state
 * machine (RFC-004) but assumes a `Trade` row already exists — nothing
 * created one. This is that missing piece: turning an accepted Offer
 * into a real Trade row, the other half of TODO.md §1's "modules/open-p2p/
 * — trade routes ... only service-layer logic survived" gap.
 */
import { randomUUID } from 'crypto'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../common/database'
import { AppError, NotFoundError, ValidationError, ForbiddenError } from '../../common/errors'
import { eventBus } from '../../common/events/event-bus'
import type { DurableEvent } from '../../common/events/event-store'
import { childLogger } from '../../common/logger'
import { negotiationService } from './negotiation.service'
import { intentEngine, type OwedIntentEvent } from '../../core/intent-engine'
import { tradeRepository, type TradeRepository } from './trade-repository'
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '../../common/pagination'
import type { TradeStatus } from '../../common/types'
import {
  claimCompletedInTransaction, findIdempotencyClaim, hashIdempotentPayload, isUniqueConstraintError,
  type IdempotencyRecord,
} from '../../common/idempotency'

const log = childLogger('trade')

const TRADE_CREATE_SCOPE = 'openp2p.trade.create'
// Same-key requests wait on the claim's unique index until the first one commits; Prisma's 2 s / 5 s defaults are
// too short for that under load. Generous on purpose: a lost wait is a 500 for a request that could have replayed.
const ADMISSION_TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 }
const TERMINAL_INTENT_STATUSES: readonly string[] = ['FULFILLED', 'FAILED', 'CANCELLED', 'EXPIRED']

type TradeRow = Awaited<ReturnType<TradeRepository['create']>>
interface Admission {
  trade: TradeRow
  tradeIntent: OwedIntentEvent
  events: DurableEvent[]
}

export interface CreateTradeInput {
  offerId: string
  counterpartyId: string // the participant accepting the offer (caller)
  amount: string          // decimal string — RFC-009
  // CROSS-LAYER-SEMANTIC-CORRECTIVE-1 (item 37) — optional; omitted means
  // exactly today's behavior (a retry can create a second Trade). See
  // src/common/idempotency.ts's own header for why this is a caller-
  // supplied key, not a composite-business-key uniqueness constraint.
  idempotencyKey?: string
}

export interface TradePagination {
  limit?: number
  offset?: number
}

// Missão 04 hardening finding — updateStatus() below previously wrote
// `status` unconditionally, with no check on the trade's *current*
// status at all. Escrow.status has a rigorous VALID_TRANSITIONS map
// (escrow-lifecycle.ts); Trade.status had nothing equivalent for the one
// write path a client can call directly. Concretely: a trade already
// COMPLETED (settlement.escrow.released already fired, real funds
// already moved) or DISPUTED could have its Trade.status silently
// overwritten back to CANCELLED by either party calling
// PATCH /v1/openp2p/trades/:id/status — not a path to re-move funds
// (Escrow's own state machine is untouched and remains authoritative
// for that), but a real state-integrity/audit-trail corruption: the
// Trade record would misrepresent what actually happened. Every other
// Trade.status transition (ACTIVE/COMPLETED/DISPUTED/the event-driven
// CANCELLED-via-refund) is already driven automatically by a real,
// separately-gated Escrow transition (common/events/handlers.ts) — this
// map only needs to cover the two targets a client can request directly.
const MANUAL_TRADE_TRANSITIONS: Record<string, Array<'ACTIVE' | 'CANCELLED'>> = {
  PENDING: ['ACTIVE', 'CANCELLED'],
  ACTIVE: ['CANCELLED'],
}

export class TradeService {
  constructor(private readonly repo: TradeRepository = tradeRepository) {}

  /**
   * E21 slice 1 (Issue #105, CTO 24 6811594078 / 6811766719, CTO 223) - transactional, idempotent admission.
   *
   * ONE PostgreSQL transaction holds the whole admission: the idempotency claim (written COMPLETED), the Offer
   * re-validation under FOR SHARE, the trade's own Intent (born NEGOTIATING, genesis IntentEvent), the Trade, the
   * durable openp2p.trade.created event and the durable opening of the negotiation. Lock order, always the same:
   * claim (unique index) -> Offer row (FOR SHARE) -> event-store advisory lock (trade id). Either all of it commits
   * or none of it exists, so a refusal or a crash before the commit leaves the key reusable.
   *
   * After the commit, dispatch and the owed `intent.created` publication are best effort and never turn a committed
   * admission into an error. R-a (CTO 223): a lost openp2p.trade.created dispatch is NOT redelivered automatically -
   * its durable row stays and an operator redelivers it with eventBus.redeliver(eventId) (only consumer today:
   * autoSettleOnMatch, off by default). The `intent.created` owed by the Trade Intent is recovered by
   * recoverUnpublishedIntentEvents().
   *
   * The Offer Intent (`intentId`) is copied as before and never transitioned by a trade (A1 invariant 1). The
   * economic checks inside the transaction are the ones main already had (3a); the seller's PaymentAccount binding
   * (3b, E22) is NOT enforced here.
   */
  async createTrade(input: CreateTradeInput) {
    const claim = input.idempotencyKey
      ? { key: input.idempotencyKey, requestHash: hashIdempotentPayload({ offerId: input.offerId, amount: input.amount }) }
      : null

    if (claim) {
      const existing = await findIdempotencyClaim(TRADE_CREATE_SCOPE, input.counterpartyId, claim.key)
      if (existing) return this.replay(existing, claim.requestHash, input)
    }

    let admission: Admission
    try {
      admission = await prisma.$transaction((tx) => this.admit(tx, input, claim), ADMISSION_TX_OPTIONS)
    } catch (err) {
      // A concurrent request with the same key committed first: its claim, and only its claim, is the answer.
      if (claim && isUniqueConstraintError(err)) {
        const existing = await findIdempotencyClaim(TRADE_CREATE_SCOPE, input.counterpartyId, claim.key)
        if (existing) return this.replay(existing, claim.requestHash, input)
      }
      throw err
    }

    this.afterAdmissionCommit(admission)
    await this.publishTradeIntentCreated(admission.tradeIntent)
    return admission.trade
  }

  private async admit(
    tx: Prisma.TransactionClient,
    input: CreateTradeInput,
    claim: { key: string; requestHash: string } | null
  ): Promise<Admission> {
    const tradeId = randomUUID()
    if (claim) {
      await claimCompletedInTransaction(tx, {
        scope: TRADE_CREATE_SCOPE, participantId: input.counterpartyId, key: claim.key, requestHash: claim.requestHash, resultRef: tradeId,
      })
    }

    const offer = await this.repo.findOfferForAdmission(tx, input.offerId)
    if (!offer) throw new NotFoundError('Offer', input.offerId)
    if (offer.status !== 'ACTIVE') {
      throw new ValidationError(`Offer ${input.offerId} is not active (status: ${offer.status})`)
    }
    if (offer.userId === input.counterpartyId) {
      throw new ValidationError('Cannot start a trade against your own offer')
    }

    // Robustness-audit fix (2026-07-20): createTrade() never validated
    // `input.amount` at all — neither that it's a sane positive number,
    // nor that it falls within the very `minAmount`/`maxAmount` bounds
    // the Offer publishes and the UI displays as a hard constraint
    // (OfferDetail.tsx's "Limites 10-100 USDT"). A caller could request
    // any amount, including one wildly outside what the seller actually
    // offered, and a real Trade would be created for it — an accepted
    // "trade" the counterparty never agreed to, not just a UX gap.
    // `Number()` here is the same "bounds check, not exact arithmetic"
    // precedent RFC-009 already established (policy-engine.ts's
    // validateFinancialSanity(), liquidity.service.ts's sort comparator)
    // — the decimal string itself is still what's persisted below.
    const amountNum = Number(input.amount)
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      throw new ValidationError(`amount must be a positive decimal string, got "${input.amount}"`)
    }
    if (amountNum < Number(offer.minAmount) || amountNum > Number(offer.maxAmount)) {
      throw new ValidationError(
        `amount ${input.amount} is outside Offer ${offer.id}'s limits (${offer.minAmount}-${offer.maxAmount})`
      )
    }

    // Offer.side is the offer creator's side — the caller takes the
    // opposite role. A SELL offer means the creator is the seller; a BUY
    // offer means the creator is the buyer.
    const [buyerId, sellerId] =
      offer.side === 'SELL' ? [input.counterpartyId, offer.userId] : [offer.userId, input.counterpartyId]

    const priceUsd = offer.priceUsd
    const totalUsd = (Number(priceUsd) * Number(input.amount)).toFixed(8)

    const tradeIntent = await intentEngine.createTradeIntentInTransaction(tx, {
      intentId: randomUUID(),
      participantId: input.counterpartyId,
      parentIntentId: offer.intentId,
      payload: { asset: offer.asset, side: offer.side === 'SELL' ? 'BUY' : 'SELL', minValue: input.amount, maxValue: input.amount, network: offer.network },
      metadata: { tradeId, offerId: offer.id },
    })

    const trade = await this.repo.create({
      id: tradeId,
      offerId: offer.id,
      buyerId,
      sellerId,
      asset: offer.asset,
      amount: input.amount,
      priceUsd,
      totalUsd,
      network: offer.network,
      intentId: offer.intentId, // RFC-018 — carried over from the accepted Offer (published meaning unchanged)
      tradeIntentId: tradeIntent.intentId,
    }, tx)

    const created = await eventBus.publishInTransaction(tx, 'openp2p.trade.created', {
      tradeId: trade.id,
      offerId: trade.offerId,
      buyerId,
      sellerId,
      asset: trade.asset,
      amount: trade.amount.toString(),   // RFC-009 — Decimal -> decimal string at the event boundary
      priceUsd: trade.priceUsd.toString(),
    }, trade.id)
    const negotiation = await negotiationService.openInTransaction(tx, trade)

    return { trade, tradeIntent, events: [created, ...negotiation] }
  }

  // Post-commit, never throws: the admission is already durable and authoritative; dispatch and in-memory state
  // are not. A failure is logged with the eventId an operator needs for eventBus.redeliver() (R-a).
  private afterAdmissionCommit(admission: Admission): void {
    for (const event of admission.events) {
      try {
        eventBus.dispatchCommitted(event)
      } catch (err) {
        log.error({ msg: 'Post-commit dispatch failed; the durable event stays redeliverable via eventBus.redeliver()', eventName: event.eventName, eventId: event.eventId, tradeId: admission.trade.id, err: err instanceof Error ? err.message : String(err) })
      }
    }
    negotiationService.markOpened(admission.trade.id)
  }

  private async publishTradeIntentCreated(owed: OwedIntentEvent): Promise<void> {
    try {
      await intentEngine.publishCommittedIntentEvent(owed)
    } catch (err) {
      log.error({ msg: 'Owed intent.created not published yet; recoverUnpublishedIntentEvents() will publish it', intentId: owed.intentId, intentEventId: owed.intentEventId, err: err instanceof Error ? err.message : String(err) })
    }
  }

  // A key that already has a claim. Only a recorded outcome (resultRef) answers a replay; a LEGACY claim without one
  // (IN_PROGRESS, or FAILED - a failed call is not proof of no side effect) stays unresolved: it is never attributed
  // by correlation and never reused. Hints are the caller's own candidate trades, explicitly not authoritative.
  private async replay(existing: IdempotencyRecord, requestHash: string, input: CreateTradeInput) {
    if (existing.requestHash !== requestHash) {
      throw new ValidationError(
        `Idempotency key '${input.idempotencyKey}' was already used for a different request. ` +
        'Reusing an idempotency key for a new logical action is not allowed — use a new key for a new request.'
      )
    }
    if ((existing.status === 'COMPLETED' || existing.status === 'UNKNOWN') && existing.resultRef) {
      const trade = await this.repo.findById(existing.resultRef)
      // resultRef only ever names a trade committed with this claim — a miss is a data-integrity anomaly.
      if (!trade) throw new NotFoundError('Trade', existing.resultRef)
      return trade
    }
    const unverifiedCandidateTradeIds = existing.createdAt
      ? await this.repo.findLegacyAdmissionCandidateIds(input.counterpartyId, input.offerId, existing.createdAt)
      : []
    throw new AppError(
      `The outcome of the earlier request with idempotency key '${input.idempotencyKey}' is unknown — use GET /v1/openp2p/trades to check, and a new key for a new request.`,
      409, 'IDEMPOTENCY_OUTCOME_UNKNOWN', { authoritative: false, unverifiedCandidateTradeIds }
    )
  }

  // Closes the real gap @satsails/p2p-trading-sdk's intent-facade.ts's dispute() needed:
  // resolving an intentId (the caller's own vocabulary — createIntent()
  // is the entry point) to the Trade/Escrow RFC-018 already links it to
  // server-side.
  // E21 slice 1 - deterministic and caller-scoped: a trade's own Intent resolves to that trade for its buyer and
  // seller; an Offer/legacy Intent resolves to the caller's trade on it if there is exactly one, 409 AMBIGUOUS_INTENT
  // (only the caller's ids) if several. Everything else - a stranger, or an unknown Intent - is the same 404.
  async getTradeByIntentId(intentId: string, participantId: string) {
    const notFound = () => new NotFoundError('Trade for this intent', intentId)
    const owner = await this.repo.findByTradeIntentId(intentId)
    if (owner) {
      if (participantId !== owner.buyerId && participantId !== owner.sellerId) throw notFound()
      return owner
    }
    const mine = await this.repo.findByIntentIdForParticipant(intentId, participantId)
    if (mine.length === 1) return mine[0]
    if (mine.length > 1) {
      throw new AppError(`Intent ${intentId} resolves to ${mine.length} of your trades`, 409, 'AMBIGUOUS_INTENT', { tradeIds: mine.map((t) => t.id) })
    }
    throw notFound()
  }

  // escrow + messages(asc) + offer include — found while auditing a real
  // gap: the buyer has nowhere to see *where* to send fiat (the seller's
  // Offer.paymentDetails) once a trade is already underway — OfferDetail
  // shows it, but Trade never re-fetched the Offer at all.
  // paymentMethod/paymentDetails are the two fields this exists for; the
  // rest of Offer comes along for free via the relation, same low-risk
  // tradeoff every other `include` this shape makes (see
  // trade-repository.ts's findByIdWithDetails()).
  async getTrade(tradeId: string) {
    const trade = await this.repo.findByIdWithDetails(tradeId)
    if (!trade) throw new NotFoundError('Trade', tradeId)
    return trade
  }

  // trade.routes.ts's own /reconcile handler and chat.routes.ts's 3 call
  // sites (JOIN_TRADE, SEND_MESSAGE, GET messages) all did this exact
  // fetch+ownership-check+throw inline — extracted here so all 4 share
  // one implementation. Deliberately uses the bare findById() shape (no
  // escrow/messages/offer include), not getTrade(), because none of
  // these 4 call sites need anything beyond buyerId/sellerId for the
  // check.
  async assertParticipant(tradeId: string, participantId: string) {
    const trade = await this.repo.findById(tradeId)
    if (!trade) throw new NotFoundError('Trade', tradeId)
    if (participantId !== trade.buyerId && participantId !== trade.sellerId) {
      throw new ForbiddenError(`${participantId} is not a party to trade ${tradeId}`)
    }
    return trade
  }

  // Fase 2 (SDK React) — closes a real gap found while scoping
  // useSailsTrades(): no "list my trades" endpoint existed anywhere
  // (packages/sails-ui's own TradeHistory.tsx uses MOCK_TRADE_HISTORY
  // for exactly this reason). Scoped to trades where the caller is
  // buyer OR seller — never a global listing, which would leak every
  // participant's trade activity to every other participant. Same
  // limit/offset clamping convention liquidity.service.ts's
  // InternalOrderBook.getOffers() already established (limit 1-50,
  // default 10) — matched here rather than inventing a second
  // pagination convention or a cursor-based one.
  async getTrades(participantId: string, pagination?: TradePagination) {
    const limit = Math.min(Math.max(pagination?.limit ?? DEFAULT_PAGE_LIMIT, 1), MAX_PAGE_LIMIT)
    const offset = Math.max(pagination?.offset ?? 0, 0)

    const [trades, total] = await Promise.all([
      this.repo.findManyByParticipant(participantId, limit, offset),
      this.repo.countByParticipant(participantId),
    ])

    return { trades, total, hasMore: offset + trades.length < total }
  }

  // Only the subset of transitions a participant can trigger directly —
  // COMPLETED is driven exclusively by settlement.escrow.released
  // (common/events/handlers.ts), never set here, so this method never
  // needs to duplicate that reaction.
  async updateStatus(tradeId: string, status: Extract<TradeStatus, 'ACTIVE' | 'CANCELLED'>, triggeredBy: string) {
    const trade = await this.repo.findById(tradeId)
    if (!trade) throw new NotFoundError('Trade', tradeId)
    if (triggeredBy !== trade.buyerId && triggeredBy !== trade.sellerId) {
      throw new ForbiddenError(`${triggeredBy} is not a party to trade ${tradeId}`)
    }

    const allowed = MANUAL_TRADE_TRANSITIONS[trade.status] ?? []
    if (!allowed.includes(status)) {
      throw new ValidationError(
        `Trade ${tradeId} cannot transition from ${trade.status} to ${status} — only ${allowed.join('/') || 'no'} ` +
        `transition(s) are valid from ${trade.status}`
      )
    }

    // Issue #294 - CAS on the status just validated, serialized under the escrow lock, and refused
    // once the Escrow already governs the economic outcome. Escrow stays authoritative; a manual
    // request can never race an Escrow-derived projection into a contradictory Trade state.
    const transition = await this.repo.transitionManually(tradeId, trade.status as TradeStatus, status, status === 'CANCELLED' ? new Date() : undefined)
    if (!transition.ok) {
      throw new ValidationError(
        transition.reason === 'ESCROW_GOVERNED'
          ? `Trade ${tradeId} can no longer be changed manually: its escrow is ${transition.escrowStatus} and governs the outcome`
          : `Trade ${tradeId} changed concurrently (it is no longer ${trade.status}) - reload and retry`
      )
    }
    const updated = transition.trade

    await eventBus.emit('openp2p.trade.status_changed', {
      tradeId,
      from: trade.status,
      to: status,
      triggeredBy,
    }, tradeId)

    // RFC-018 gap found by a CTO-role review after the initial rollout
    // ("garantir que os testes cubram cenários de falha... trade
    // cancelado"): a Trade cancelled before escrow ever locks left its
    // Intent stuck at NEGOTIATING forever — nothing transitioned it.
    // CANCELLED is a valid direct transition from every pre-COMMITTED
    // state (core/state-machine.ts), so this is safe regardless of
    // which one the Intent is actually in.
    if (status === 'CANCELLED') await this.cancelLifecycleIntent(trade, triggeredBy)

    return updated
  }

  // E21 slice 1 - a trade with its own Intent cancels exactly that Intent. A LEGACY trade (L1, no own Intent) shares
  // the Offer Intent: it is left intact, with an audited openp2p.trade.intent_unchanged, when another trade on it is
  // still live or it is already terminal (both explained by OTHER trades, never inferred for this one). Otherwise,
  // and always when the trade has an escrow of its own, the previous behaviour applies unchanged.
  private async cancelLifecycleIntent(trade: { id: string; intentId: string | null; tradeIntentId?: string | null }, triggeredBy: string) {
    const intentId = trade.tradeIntentId ?? trade.intentId
    if (!intentId) return
    if (!trade.tradeIntentId) {
      const ctx = await this.repo.legacyIntentCancelContext(trade.id, intentId)
      const reason = ctx.tradeHasEscrow ? null
        : ctx.liveSiblingTrades > 0 ? 'SHARED_INTENT_SIBLING_TRADES_LIVE' as const
        : ctx.intentStatus && TERMINAL_INTENT_STATUSES.includes(ctx.intentStatus) ? 'SHARED_INTENT_ALREADY_TERMINAL' as const
        : null
      if (reason) {
        await eventBus.emit('openp2p.trade.intent_unchanged', { tradeId: trade.id, intentId, reason, triggeredBy }, trade.id)
        return
      }
    }
    await intentEngine.transition(intentId, 'CANCELLED', triggeredBy, 'intent.cancelled', { intentId, cancelledBy: triggeredBy })
  }
}

export const tradeService = new TradeService()
