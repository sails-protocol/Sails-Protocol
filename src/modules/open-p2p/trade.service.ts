/**
 * Sails OpenP2P — Trade Service
 *
 * negotiation.service.ts already owns the negotiation channel/state
 * machine (RFC-004) but assumes a `Trade` row already exists — nothing
 * created one. This is that missing piece: turning an accepted Offer
 * into a real Trade row, the other half of TODO.md §1's "modules/open-p2p/
 * — trade routes ... only service-layer logic survived" gap.
 */
import { NotFoundError, ValidationError, ForbiddenError, AmbiguousIntentError, IdempotencyOutcomeUnknownError, IdempotencyKeyConflictError } from '../../common/errors'
import { eventBus } from '../../common/events/event-bus'
import { negotiationService } from './negotiation.service'
import { intentEngine } from '../../core/intent-engine'
import { tradeRepository, type TradeRepository, type AdmissionClaim } from './trade-repository'
import { lifecycleIntentId, legacySharedIntentCancelDecision } from './trade-intent'
import { observeLegacyTradeClaim } from './trade-claim-reconciliation'
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '../../common/pagination'
import type { AssetType, TradeStatus } from '../../common/types'
import type { TradeIntentPayload } from '../../common/types/intent'
import type { EscrowType } from '../../common/types/trade'
import { hashIdempotentPayload } from '../../common/idempotency'
import { childLogger } from '../../common/logger'
import { paymentAccountService } from '../open-settlement/payment-account.service'
import { translateLegacyAssetType } from '../../common/settlement-scope-legacy'
import { resolveSingleStructurallyCompatibleImplementation } from '../../common/execution-candidates'

/**
 * #235 R7H-E3C — the rail a trade in `asset` is escrowed on in production: the canonical implementation
 * escrow.service.ts's resolveEscrowType() resolves (ADR-002 §11 translation, then the single registered
 * implementation), without its MOCK conveniences, which production refuses to boot with (config RT-001). null when
 * the asset has no canonical route — untranslated (LN_BTC, SPARK, …) or no registered implementation (LIQUID_BTC,
 * USDT_TRC20, USDT_LIQUID) — so no governed escrow can exist for it and admission has nothing to check.
 * Trade admission is checked against this rail (trade-repository.ts).
 */
function canonicalEscrowRail(asset: AssetType): { type: EscrowType; asset: AssetType } | null {
  const scope = translateLegacyAssetType(asset)
  if (!scope) return null
  const resolution = resolveSingleStructurallyCompatibleImplementation(scope.asset, scope.rail)
  return 'error' in resolution ? null : { type: resolution.implementation, asset }
}

const log = childLogger('trade-service')

/** The actor recorded on a trade's own Intent history: admission is a system-derived action, not a user request. */
const TRADE_ADMISSION_ACTOR = 'system:trade-admission'

export interface CreateTradeInput {
  offerId: string
  counterpartyId: string // the participant accepting the offer (caller)
  amount: string          // decimal string — RFC-009
  // CROSS-LAYER-SEMANTIC-CORRECTIVE-1 (item 37) — optional; omitted means
  // exactly today's behavior (a retry can create a second Trade). See
  // src/common/idempotency.ts's own header for why this is a caller-
  // supplied key, not a composite-business-key uniqueness constraint.
  idempotencyKey?: string
  // #235 R7C — on a BUY offer the caller is the seller (fiat receiver) and
  // may bind their own PaymentAccount here, by its public hash. Rejected on
  // a SELL offer, where the seller already declared it on the Offer.
  paymentAccountHash?: string
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

  // #235 R7H-NF-E3C-5 (B2, contract D12) — ATOMIC ADMISSION. For this scope (and only this one: withIdempotency() is
  // unchanged for every other operation) one PostgreSQL transaction (trade-repository.ts admit()) commits, or rolls
  // back as a whole: the idempotency result, the trade's OWN Intent with its IntentEvents, the Trade, the unchanged
  // E3C admission check, and the durable trade / negotiation / Intent events. Consequences:
  //   - a committed trade always has its COMPLETED claim and its durable events, and no `IN_PROGRESS` row ever exists
  //     in this scope again (the former crash window between the trade commit and the claim settlement is gone);
  //   - the shared-Offer-Intent walk that made every second-and-later trade on an offer "fail" after commit is gone —
  //     each trade owns an Intent no other trade touches;
  //   - whatever happens after COMMIT (event dispatch, in-memory negotiation bookkeeping) is non-authoritative: it is
  //     logged by its own layer and can never turn a committed trade into an error response.
  // A request replayed with a key that already has a claim is answered from that claim BEFORE any validation (so a
  // replay never depends on the offer still being active); a key whose claim belongs to another in-flight
  // transaction is resolved by the database (ON CONFLICT waits for it), never by catching a unique violation.
  async createTrade(input: CreateTradeInput) {
    const key = input.idempotencyKey
    const requestHash = key
      ? hashIdempotentPayload({ offerId: input.offerId, amount: input.amount, paymentAccountHash: input.paymentAccountHash })
      : undefined

    if (key) {
      const existing = await this.repo.findAdmissionClaim(input.counterpartyId, key)
      if (existing) {
        const settled = await this.settleExistingClaim(existing, key, requestHash!, input.counterpartyId)
        if (settled) return settled
      }
    }

    const draft = await this.prepareAdmission(input)

    const result = await this.repo.admit({
      ...draft.data,
      claim: key ? { participantId: input.counterpartyId, key, requestHash: requestHash! } : undefined,
      beforeTrade: async (tx, { tradeId }) => {
        const intent = await intentEngine.createInTransaction(tx, {
          type: 'TradeIntent',
          payload: draft.tradeIntentPayload,
          participantId: input.counterpartyId,
          parentIntentId: draft.offerIntentId,
          triggeredBy: TRADE_ADMISSION_ACTOR,
          note: `trade admission against offer ${draft.data.offerId}`,
          metadata: { origin: 'trade-admission', tradeId, offerId: draft.data.offerId },
          matchedCandidateIds: [draft.makerId],
          negotiationId: tradeId,
        })
        return { tradeIntentId: intent.id, dispatch: intent.dispatch }
      },
      afterAdmission: async (tx, trade) => {
        const dispatch = await eventBus.publishInTransaction(tx, [
          {
            eventName: 'openp2p.trade.created',
            correlationId: trade.id,
            payload: {
              tradeId: trade.id,
              offerId: trade.offerId,
              buyerId: trade.buyerId,
              sellerId: trade.sellerId,
              asset: trade.asset,
              amount: trade.amount.toString(),   // RFC-009 — Decimal -> decimal string at the event boundary
              priceUsd: trade.priceUsd.toString(),
            },
          },
          { eventName: 'negotiation.opened', correlationId: trade.id, payload: { tradeId: trade.id, buyerId: trade.buyerId, sellerId: trade.sellerId } },
          {
            eventName: 'openp2p.trade.status_changed',
            correlationId: trade.id,
            payload: { tradeId: trade.id, from: 'PENDING', to: 'NEGOTIATING', triggeredBy: trade.buyerId },
          },
        ])
        return { dispatch }
      },
    })

    if (result.kind === 'EXISTING_CLAIM') {
      // Lost the race for the key (or met a legacy row): nothing of ours was written. Answer from the winner.
      const settled = await this.settleExistingClaim(result.claim, key!, requestHash!, input.counterpartyId)
      if (settled) return settled
      throw new IdempotencyKeyConflictError(
        `A request with idempotency key '${key}' is already being retried by another request — wait and try again.`
      )
    }

    // COMMITTED. This is the ONE failure boundary of everything after the commit: the events are already durable, so
    // a handler that throws is logged and never becomes an error response for a trade that exists (S3/S4 before B2).
    for (const dispatch of result.dispatches) {
      try {
        dispatch()
      } catch (err) {
        log.error({ msg: 'Post-commit dispatch failed after trade admission (the trade and its events are durable; not an operation failure)', tradeId: result.trade.id, err: err instanceof Error ? err.message : String(err) })
      }
    }
    negotiationService.markOpened(result.trade.id)
    return result.trade
  }

  /**
   * What a pre-existing claim for this (caller, key) means. Returns the trade for a committed claim, `null` when the
   * claim is FAILED (a legacy request that never created a trade: this attempt may proceed and reclaim it), and
   * throws for a different request, or for a legacy IN_PROGRESS claim, whose outcome is never inferred (409).
   */
  private async settleExistingClaim(claim: AdmissionClaim, key: string, requestHash: string, participantId: string) {
    if (claim.requestHash !== requestHash) {
      throw new ValidationError(
        `Idempotency key '${key}' was already used for a different request. ` +
        'Reusing an idempotency key for a new logical action is not allowed — use a new key for a new request.'
      )
    }
    if ((claim.status === 'COMPLETED' || claim.status === 'UNKNOWN') && claim.resultRef) {
      const trade = await this.repo.findById(claim.resultRef)
      // The claim's resultRef only ever names a real, just-created Trade: a miss means it was deleted out-of-band
      // after the claim completed — a data-integrity anomaly, not a "not found" the caller could have caused.
      if (!trade) throw new NotFoundError('Trade', claim.resultRef)
      return trade
    }
    if (claim.status === 'FAILED') return null
    // IN_PROGRESS (or any status without a result reference): a row only OLD code wrote (this scope never creates one
    // now) whose process died, or an old-code request still in flight during a rolling deploy. Gate C corrective: its
    // outcome is UNKNOWN and STAYS unknown. A legacy trade carries no reference to the claim that produced it, so
    // owner + payload + timestamp only correlate the two; correlation is not causation. No trade is attributed, the
    // claim is neither completed nor failed, and no new trade is created (the key stays reserved). The replay is
    // observed (one immutable audit row) and answered 409 with UNVERIFIED hints — never with a result.
    let hints: string[] = []
    try {
      hints = (await observeLegacyTradeClaim(claim.id, `replay:${participantId}`)).unverifiedCandidateTradeIds
    } catch (err) {
      // Bookkeeping only: failing to record the observation can neither confirm nor refuse the request.
      log.error({ msg: 'Legacy trade claim observation failed; the replay is answered unknown all the same', claimId: claim.id, err: err instanceof Error ? err.message : String(err) })
    }
    throw new IdempotencyOutcomeUnknownError(key, hints)
  }

  // Validation and derivation ONLY — every rule below is the pre-B2 persistTrade() body, unchanged. No write happens
  // here; the single durable write is repo.admit().
  private async prepareAdmission(input: CreateTradeInput) {
    const offer = await this.repo.findOfferById(input.offerId)
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

    // #235 R7C — the seller's (fiat receiver's) PaymentAccount is bound
    // here, in the same single write that creates the Trade, never later.
    // Whoever is the seller declares it: the maker on a SELL offer (already
    // on the Offer, re-verified), the taker on a BUY offer. No declaration
    // means an unbound trade, which can never attest any account.
    let sellerPaymentAccountId: string | null = null
    if (offer.side === 'SELL') {
      if (input.paymentAccountHash) {
        throw new ValidationError('On a SELL offer the seller declares the payment account when publishing the offer; the buyer cannot choose one')
      }
      if (offer.paymentAccountId) {
        sellerPaymentAccountId = await paymentAccountService.bindableAccountId({ id: offer.paymentAccountId }, sellerId, offer.paymentMethod)
      }
    } else if (input.paymentAccountHash) {
      sellerPaymentAccountId = await paymentAccountService.bindableAccountId({ accountHash: input.paymentAccountHash }, sellerId, offer.paymentMethod)
    }

    const priceUsd = offer.priceUsd
    const totalUsd = (Number(priceUsd) * Number(input.amount)).toFixed(8)

    // The trade's own Intent describes ITS negotiation from the taker's side (not the maker's advertisement): the
    // taker's role is the opposite of the offer's side, and its value is exactly this trade's total.
    const tradeIntentPayload: TradeIntentPayload = {
      asset: offer.asset,
      side: offer.side === 'SELL' ? 'BUY' : 'SELL',
      minValue: totalUsd,
      maxValue: totalUsd,
      fiatMethod: offer.paymentMethod,
      ...(offer.network ? { network: offer.network } : {}),
    }

    return {
      data: {
        offerId: offer.id,
        buyerId,
        sellerId,
        asset: offer.asset,
        amount: input.amount,
        priceUsd,
        totalUsd,
        network: offer.network,
        intentId: offer.intentId, // RFC-018 — the originating Offer's Intent, unchanged meaning
        sellerPaymentAccountId,
        escrowRail: canonicalEscrowRail(offer.asset),
      },
      tradeIntentPayload,
      offerIntentId: offer.intentId,
      makerId: offer.userId,
    }
  }

  // Closes the real gap @satsails/p2p-trading-sdk's intent-facade.ts's dispute() needed:
  // resolving an intentId (the caller's own vocabulary — createIntent()
  // is the entry point) to the Trade/Escrow RFC-018 already links it to
  // server-side. Same no-auth pattern as getTrade() below — an intentId
  // isn't guessable-and-sensitive any more than a tradeId already is,
  // and getTrade() itself has never required auth.
  //
  // #235 R7H-NF-E3C-5 (F-7) — caller-scoped and deterministic. An Offer/legacy Intent is shared by every trade taken
  // from that offer, so the lookup is limited to the trades the CALLER is a party to: exactly one → that trade;
  // none (including "the Intent exists but only other participants trade on it") → 404, indistinguishable from an
  // unknown Intent; several (typically the maker of a popular offer) → 409 AMBIGUOUS_INTENT listing only the
  // caller's own trade ids. No other participant's trade id or identity is ever disclosed.
  async getTradeByIntentId(intentId: string, participantId: string) {
    const trades = await this.repo.findByIntentForParticipant(intentId, participantId)
    if (trades.length === 1) return trades[0]
    if (trades.length === 0) throw new NotFoundError('Trade for this intent', intentId)
    throw new AmbiguousIntentError(trades.map((t) => t.id))
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
    //
    // RFC-018 gap found by a CTO-role review after the initial rollout
    // ("garantir que os testes cubram cenários de falha... trade
    // cancelado"): a Trade cancelled before escrow ever locks left its
    // Intent stuck at NEGOTIATING forever — nothing transitioned it.
    // #235 R7G-B1 (FAILED_CANCELLATION_NO_DURABLE_EFFECT_V1) - the Intent is
    // cancelled in the same transaction as the Trade, so an Intent that cannot
    // be cancelled (e.g. COMMITTED) refuses the whole cancellation and nothing
    // is persisted or announced. Events are published only after the commit.
    //
    // #235 R7H-NF-E3C-5 (B2): the Intent cancelled is the trade's OWN (`tradeIntentId`); a trade admitted before B2
    // follows the Offer Intent it shared (lifecycleIntentId), under the explicit L1 policy below. Either way this runs
    // only after every economic cancellation guard of transitionManually() passed.
    const lifecycleIntent = lifecycleIntentId(trade)
    let publishIntentEvent: (() => Promise<void>) | undefined
    let publishIntentUnchanged: (() => void) | undefined
    const transition = await this.repo.transitionManually(
      tradeId, trade.status as TradeStatus, status, status === 'CANCELLED' ? new Date() : undefined,
      status === 'CANCELLED' && lifecycleIntent
        ? async (tx) => {
            if (!trade.tradeIntentId) {
              // L1 — a legacy trade shares its Intent with sibling trades. Whether cancelling THIS trade may rewrite
              // that shared record is decided from explicit durable state (never by catching a failed transition).
              const escrow = await tx.escrow.findUnique({ where: { tradeId } })
              const [siblings] = await tx.$queryRaw<Array<{ live: number }>>`
                SELECT count(*)::int AS live FROM trades
                WHERE "intentId" = ${lifecycleIntent} AND id <> ${tradeId} AND status NOT IN ('CANCELLED', 'COMPLETED')`
              const intent = await tx.intent.findUnique({ where: { id: lifecycleIntent } })
              const liveSiblingTrades = siblings?.live ?? 0
              const decision = legacySharedIntentCancelDecision({
                tradeHasEscrow: !!escrow, liveSiblingTrades, intentStatus: String(intent?.status ?? ''),
              })
              if (decision.action === 'SKIP') {
                publishIntentUnchanged = await eventBus.publishInTransaction(tx, [{
                  eventName: 'openp2p.trade.intent_unchanged',
                  correlationId: tradeId,
                  payload: { tradeId, intentId: lifecycleIntent, intentStatus: String(intent?.status ?? ''), reason: decision.reason, liveSiblingTrades, triggeredBy },
                }])
                return
              }
            }
            publishIntentEvent = await intentEngine.transitionInTransaction(
              tx, lifecycleIntent, 'CANCELLED', triggeredBy, 'intent.cancelled', { intentId: lifecycleIntent, cancelledBy: triggeredBy },
            )
          }
        : undefined,
    )
    if (!transition.ok) {
      throw new ValidationError(
        transition.reason === 'ESCROW_GOVERNED'
          ? `Trade ${tradeId} can no longer be changed manually: its escrow is ${transition.escrowStatus} and governs the outcome`
          : transition.reason === 'ECONOMIC_COMMITMENT'
            ? `Trade ${tradeId} can no longer be cancelled unilaterally: ${transition.detail} — it ends through refund, dispute or settlement`
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
    if (publishIntentEvent) await publishIntentEvent()
    if (publishIntentUnchanged) publishIntentUnchanged()

    return updated
  }
}

export const tradeService = new TradeService()
