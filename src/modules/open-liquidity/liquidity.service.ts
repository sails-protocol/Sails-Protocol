import { AssetType, TradeSide, PaymentMethod, OfferStatus } from '../../common/types'
import { prisma } from '../../common/database'
import { NotFoundError, ForbiddenError, ValidationError } from '../../common/errors'
import { eventBus } from '../../common/events/event-bus'
import { intentEngine } from '../../core/intent-engine'
import { intentRepository } from '../../core/intent-repository'
import { childLogger } from '../../common/logger'
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '../../common/pagination'
import type { TradeIntentPayload } from '../../common/types/intent'
import type { Prisma } from '@prisma/client'
import { config } from '../../config'
import { qvacDetectionInvocationsTotal, qvacDetectionFailuresTotal } from '../../common/metrics'
import { withIdempotency, isUniqueConstraintError } from '../../common/idempotency'
import { paymentAccountService } from '../open-settlement/payment-account.service'

const log = childLogger('liquidity')

/**
 * Sails OpenLiquidity — Reference Implementation
 *
 * MOVED from src/modules/routing/routing.service.ts (folder name "routing"
 * did not match any of the 8 official module names in MASTER_COORDINATION.md).
 *
 * Fix applied: getOffers() and matchOrder() previously duplicated the same
 * 8-field object-literal mapping from a Prisma Offer row to a LiquidityOffer.
 * Extracted into mapOfferToLiquidityOffer() below — one source of truth for
 * that shape, so changing the LiquidityOffer contract only requires editing
 * one place instead of two (and future providers only implement the same
 * helper pattern instead of re-deriving the mapping).
 */

// ─── Protocol interface (Sails Protocol Spec — LiquidityProvider) ─────────────
export interface LiquidityOffer {
  id: string
  source: 'internal' | 'hodlhodl' | 'robosats' | string
  asset: AssetType
  side: TradeSide
  priceUsd: string    // decimal string — RFC-009, never a JS number
  minAmount: string    // decimal string — RFC-009
  maxAmount: string    // decimal string — RFC-009
  paymentMethods: string[]
  traderReputation?: number
}

// Real gap found dogfooding @satsails/p2p-trading-sdk (examples/simple-wallet,
// docs/TODO.md §25): getOffers()/getAggregatedOffers() had a hard
// `take: 10` with no way for a caller to reach anything beyond the 10
// cheapest active offers for an asset/side — on any marketplace with
// more than 10 active offers (a certainty at real scale), a caller has
// no way to discover the rest. `limit` defaults to 10 (unchanged
// behavior for every existing caller that doesn't pass it) and is
// capped at 50 to keep a single query bounded.
export interface OfferPagination {
  limit?: number
  offset?: number
}

// Production Readiness Audit (2026-08-09) — API_REFERENCE.md always
// documented GET /v1/liquidity/offers as filterable by
// "asset/side/paymentMethod/price range," but the route only ever
// accepted asset/side; this closes that gap for real instead of just
// correcting the doc. A separate type from OfferPagination on purpose —
// filters and pagination are different concerns, and every provider's
// getOffers() already takes pagination independently of them.
export interface OfferFilters {
  paymentMethod?: PaymentMethod
  /** Decimal string, inclusive lower bound on Offer.priceUsd — same RFC-009 convention as every other price/amount field. */
  priceMin?: string
  /** Decimal string, inclusive upper bound on Offer.priceUsd. */
  priceMax?: string
}

// Missão 02 Fase 4 — the single-shot, non-persisted counterproposal
// proposeForIntent() returns when no existing Offer clears the Intent's
// own limits, but a real one clears amount/reputation and misses only on
// price. `referenceOfferId` is informational/audit-trail only — never an
// id this protocol accepts back into any trade-creation or settlement
// call, and never wired to one (Missão 02's explicit "settlement autonomy
// not enabled" boundary).
export interface CounterProposal {
  referenceOfferId: string
  listedPriceUsd: string
  suggestedPriceUsd: string
  reasoning: string
}

export interface LiquidityProvider {
  name: string
  isAvailable(): Promise<boolean>
  getOffers(asset: AssetType, side: TradeSide, pagination?: OfferPagination, filters?: OfferFilters): Promise<LiquidityOffer[]>
  /** True count of matching offers, same filters as getOffers() — Missão 07.1, getAggregatedOffers()'s own real `total`/`hasMore`, not the size of whatever page happened to be fetched. */
  countOffers(asset: AssetType, side: TradeSide, filters?: OfferFilters): Promise<number>
  matchOrder(asset: AssetType, side: TradeSide, amount: string): Promise<LiquidityOffer | null>
}

// ─── Pagination ────────────────────────────────────────────────────────────────
// One source of truth for limit/offset clamping — same convention every other
// paginated list in this codebase already follows (trade.service.ts's
// getTrades(), dispute.service.ts's listForArbiter(), routes.test.ts's own
// zod schemas). Keep it as a pure helper so both providers and the router can
// reuse it. `maxLimit` defaults to MAX_PAGE_LIMIT (the real page-size ceiling
// ever shown to an API caller) but getOffers() below passes a distinct,
// higher ceiling for its own internal deep-fetch use (Missão 07.1) — a
// different concern with a different, deliberately looser bound, not the
// same "page size" this default protects.
function normalizePagination(pagination?: OfferPagination, maxLimit: number = MAX_PAGE_LIMIT): { limit: number; offset: number } {
  const limit = Math.min(Math.max(pagination?.limit ?? DEFAULT_PAGE_LIMIT, 1), maxLimit)
  const offset = Math.max(pagination?.offset ?? 0, 0)
  return { limit, offset }
}

// Missão 07.1 — getAggregatedOffers() asks each provider for its own top
// `offset + limit` matches so a deep `offset` can be answered correctly
// (see that method's own comment for the full reasoning) — that request
// is never itself shown to an API caller (MAX_PAGE_LIMIT, unchanged,
// still bounds what actually comes back from getAggregatedOffers()), it's
// how deep this one provider query needs to look internally. Kept
// generous but real, not unbounded, so a pathological offset still can't
// turn into an unbounded query.
const MAX_PROVIDER_FETCH = 500

// Number() coercion here is intentional and safe — a sort comparator only
// needs correct relative order, not exact arithmetic, so float precision
// is immaterial (unlike a stored/computed amount). See RFC-009.
function compareByPriceDesc(a: LiquidityOffer, b: LiquidityOffer): number {
  return Number(b.priceUsd) - Number(a.priceUsd)
}

function compareByPriceAsc(a: LiquidityOffer, b: LiquidityOffer): number {
  return Number(a.priceUsd) - Number(b.priceUsd)
}

// ─── Shared mapping helper (was duplicated in getOffers + matchOrder) ────────
// priceUsd/minAmount/maxAmount are Prisma.Decimal here (internal, module-local
// shape reading straight off a query result) — converted to decimal string
// only where they cross into the protocol-level LiquidityOffer shape below,
// per RFC-009.
type OfferRow = {
  id: string
  asset: string
  side: string
  priceUsd: Prisma.Decimal
  minAmount: Prisma.Decimal
  maxAmount: Prisma.Decimal
  paymentMethod: string
  user: { reputationScore: number }
}

function mapOfferToLiquidityOffer(offer: OfferRow): LiquidityOffer {
  return {
    id: offer.id,
    source: 'internal',
    asset: offer.asset as AssetType,
    side: offer.side as TradeSide,
    priceUsd: offer.priceUsd.toString(),
    minAmount: offer.minAmount.toString(),
    maxAmount: offer.maxAmount.toString(),
    paymentMethods: [offer.paymentMethod],
    traderReputation: offer.user.reputationScore,
  }
}

// ─── Public single-offer detail (Technical Debt #61 bounded remediation, 2026-09-10) ──
// The explicit, dedicated public disclosure contract for one internal
// offer — deliberately its own type, not an extension of LiquidityOffer
// above (which stays scoped to aggregated multi-provider discovery/book
// semantics; a `source: 'hodlhodl' | ...` offer has no single-offer
// detail view here at all). getOffer() below is this type's only real
// producer.
//
// Seller disclosure here is capped at — never a third, broader
// definition beyond — this protocol's two existing canonical public
// views: identity.service.ts's getPublicView() (id/publicKey/
// displayName/peerId/verified) and reputation.service.ts's getScore()
// (reputationScore/totalTrades/disputeRate). Any future field beyond
// this union requires an explicit product/protocol decision, not a
// silent addition here.
export interface PublicOfferSeller {
  id: string
  publicKey: string
  displayName: string | null
  peerId: string | null
  verified: boolean
  reputationScore: number
  totalTrades: number
  disputeRate: number
}

export interface PublicOfferDetail {
  id: string
  asset: AssetType
  side: TradeSide
  priceUsd: string
  priceBrl: string | null
  minAmount: string
  maxAmount: string
  paymentMethod: PaymentMethod
  status: OfferStatus
  network: string | null
  description: string | null
  createdAt: string
  updatedAt: string
  /**
   * #235 R7H-E3C — whether a SELL offer carries its seller's committed PaymentAccount (never which one). On a
   * governed rail an unbound SELL offer admits no trade (trade-repository.ts), so a client can say so up front.
   * Always false for a BUY offer: its seller is whoever takes it, and declares the account then.
   */
  paymentAccountBound: boolean
  seller: PublicOfferSeller
}

type PublicOfferDetailRow = {
  id: string
  asset: string
  side: string
  priceUsd: Prisma.Decimal
  priceBrl: Prisma.Decimal | null
  minAmount: Prisma.Decimal
  maxAmount: Prisma.Decimal
  paymentMethod: string
  status: string
  network: string | null
  description: string | null
  createdAt: Date
  updatedAt: Date
  paymentAccountId?: string | null
  user: {
    id: string
    publicKey: string
    displayName: string | null
    peerId: string | null
    verified: boolean
    reputationScore: number
    totalTrades: number
    disputeCount: number
  }
}

// Same disputeRate formula reputation.service.ts's getScore() already
// uses — one derived stat, not the raw count, matching this repo's own
// established canonical public reputation semantics exactly.
function mapOfferToPublicDetail(offer: PublicOfferDetailRow): PublicOfferDetail {
  return {
    id: offer.id,
    asset: offer.asset as AssetType,
    side: offer.side as TradeSide,
    priceUsd: offer.priceUsd.toString(),
    priceBrl: offer.priceBrl?.toString() ?? null,
    minAmount: offer.minAmount.toString(),
    maxAmount: offer.maxAmount.toString(),
    paymentMethod: offer.paymentMethod as PaymentMethod,
    status: offer.status as OfferStatus,
    network: offer.network,
    description: offer.description,
    createdAt: offer.createdAt.toISOString(),
    updatedAt: offer.updatedAt.toISOString(),
    paymentAccountBound: offer.paymentAccountId != null,
    seller: {
      id: offer.user.id,
      publicKey: offer.user.publicKey,
      displayName: offer.user.displayName,
      peerId: offer.user.peerId,
      verified: offer.user.verified,
      reputationScore: offer.user.reputationScore,
      totalTrades: offer.user.totalTrades,
      disputeRate: offer.user.totalTrades > 0 ? offer.user.disputeCount / offer.user.totalTrades : 0,
    },
  }
}

// Shared by getOffers()/countOffers() below — one source of truth for
// "which offers match this asset/side/filters query," same reasoning as
// mapOfferToLiquidityOffer() above (the mapping half of the same split).
function buildOfferWhere(asset: AssetType, side: TradeSide, filters?: OfferFilters): Prisma.OfferWhereInput {
  return {
    asset,
    side,
    status: 'ACTIVE',
    ...(filters?.paymentMethod ? { paymentMethod: filters.paymentMethod } : {}),
    ...(filters?.priceMin || filters?.priceMax
      ? {
          priceUsd: {
            ...(filters?.priceMin ? { gte: filters.priceMin } : {}),
            ...(filters?.priceMax ? { lte: filters.priceMax } : {}),
          },
        }
      : {}),
  }
}

// ─── Internal P2P Order Book ──────────────────────────────────────────────────
class InternalOrderBook implements LiquidityProvider {
  name = 'internal'

  async isAvailable() {
    return true
  }

  async getOffers(asset: AssetType, side: TradeSide, pagination?: OfferPagination, filters?: OfferFilters): Promise<LiquidityOffer[]> {
    const { limit, offset } = normalizePagination(pagination, MAX_PROVIDER_FETCH)
    const offers = await prisma.offer.findMany({
      where: buildOfferWhere(asset, side, filters),
      orderBy: { priceUsd: side === 'SELL' ? 'asc' : 'desc' },
      take: limit,
      skip: offset,
      include: { user: { select: { reputationScore: true } } },
    })
    return offers.map(mapOfferToLiquidityOffer)
  }

  async countOffers(asset: AssetType, side: TradeSide, filters?: OfferFilters): Promise<number> {
    return prisma.offer.count({ where: buildOfferWhere(asset, side, filters) })
  }

  async matchOrder(asset: AssetType, side: TradeSide, amount: string): Promise<LiquidityOffer | null> {
    const counterSide: TradeSide = side === 'BUY' ? 'SELL' : 'BUY'

    const offer = await prisma.offer.findFirst({
      where: {
        asset,
        side: counterSide,
        status: 'ACTIVE',
        minAmount: { lte: amount },
        maxAmount: { gte: amount },
      },
      orderBy: { priceUsd: counterSide === 'SELL' ? 'asc' : 'desc' },
      include: { user: { select: { reputationScore: true } } },
    })

    return offer ? mapOfferToLiquidityOffer(offer) : null
  }
}

// ─── Offer creation/lifecycle — local to the Internal Order Book, since only
// internal offers can be created/paused/cancelled through this reference
// implementation (HodlHodl offers are theirs to manage, read-only here) ──────
export interface CreateOfferInput {
  userId: string
  asset: AssetType
  side: TradeSide
  priceUsd: string
  priceBrl?: string
  minAmount: string
  maxAmount: string
  paymentMethod: PaymentMethod
  paymentDetails?: string
  network?: string
  description?: string
  // CROSS-LAYER-SEMANTIC-CORRECTIVE-1 (item 37) — optional; omitted means
  // exactly today's behavior. See src/common/idempotency.ts's own header.
  idempotencyKey?: string
  // #235 R7C — on a SELL offer the maker is the seller (fiat receiver) and
  // may declare the PaymentAccount buyers will pay into, by its public hash.
  // Rejected on a BUY offer (the maker is the fiat sender there).
  paymentAccountHash?: string
}

// RFC-018 (rfcs/RFC-018-intent-as-canonical-trade-entry-point.md) — an Offer is
// conceptually a published, discoverable TradeIntent
// (PROTOCOL_SPECIFICATION.md §1.11); the payload's maxValue/minValue are the
// offer's total fiat range (priceUsd × the amount bounds already validated by
// this route's caller), decimal strings per RFC-009 — never a JS number.
function buildTradeIntentPayload(input: CreateOfferInput): TradeIntentPayload {
  return {
    asset: input.asset,
    side: input.side,
    maxValue: (Number(input.priceUsd) * Number(input.maxAmount)).toFixed(8),
    minValue: (Number(input.priceUsd) * Number(input.minAmount)).toFixed(8),
    fiatMethod: input.paymentMethod,
    network: input.network,
  }
}

// 2026-08-15 security review — an Offer is public before any trade or
// chat room exists, so scam text in its own free-text fields reaches
// more people, faster, than the same text in a private chat (which
// social-engineering-agent.ts already screens). Cheap pre-filter: no
// text, no QVAC call. Fire-and-forget: QVAC's own doc comment measures
// cached calls at ~8-9s, too slow to await in a publish path. Detects,
// never acts — same posture as every QVAC agent in this codebase.
//
// The provider import below is dynamic, placed after both guards, on
// purpose — a static import pulls in the real @qvac/sdk package (uses
// `import.meta`, which Jest's CJS transform can't parse) at module-load
// time, crashing every test file that merely imports this service
// whether or not it exercises this function. Found running the full
// suite, not assumed. Deferring past the guards means that never
// happens with the flag off.
export function screenOfferContent(offerId: string, userId: string, description: string | undefined, paymentDetails: string | undefined): void {
  if (!config.features.socialEngineeringDetection) return
  if (!description?.trim() && !paymentDetails?.trim()) return

  // F8 (docs/TECHNICAL_DEBT_AUDIT.md #54) — marks the start of one
  // protective-evaluation attempt, right after both path-specific
  // pre-filters above accept this offer (same "attempt after
  // pre-filters" placement social-engineering-agent.ts's evaluate()
  // uses, since this path has no separate context-prep step between
  // the pre-filters and the QVAC call itself).
  qvacDetectionInvocationsTotal.inc({ path: 'offer_screening' })

  import('../open-agents/qvac-agent.provider')
    .then(({ qvacAgentProvider }) => qvacAgentProvider.assessOfferContentRisk(description, paymentDetails))
    .then(async (signal) => {
      if (signal.pattern === 'none') return
      log.warn({ msg: 'Offer content risk detected', offerId, userId, pattern: signal.pattern, riskScore: signal.riskScore, reasoning: signal.reasoning })
      await eventBus.emit('liquidity.offer.content_risk_detected', {
        offerId,
        userId,
        pattern: signal.pattern as 'off_channel_migration' | 'payment_instruction_change',
        riskScore: signal.riskScore,
        reasoning: signal.reasoning,
        detectedAt: new Date().toISOString(),
      }, offerId)
    })
    .catch((err) => {
      qvacDetectionFailuresTotal.inc({ path: 'offer_screening' })
      log.error({ msg: 'Offer content risk screening failed', offerId, err: err instanceof Error ? err.message : String(err) })
    })
}

// ─── Router: tries providers in order, aggregates and ranks ──────────────────
export class LiquidityRouter {
  private readonly providers: LiquidityProvider[]

  // HodlHodl aggregation (pulling their public order book into search
  // results) was a stubbed LiquidityProvider here — always isAvailable()
  // === false, zero test coverage, no runtime effect. Removed 2026-08-09
  // per project-owner decision: not needed for the current milestone,
  // stays a roadmap line in BACKLOG.md instead of dead code in the tree.
  // The unrelated real code that cites HodlHodl as a design precedent
  // (multisig.provider.ts, lightning-hodl.provider.ts's 2-of-3 escrow
  // model) is untouched — that's shipped, working code, not this stub.
  constructor() {
    this.providers = [new InternalOrderBook()]
  }

  async createOffer(input: CreateOfferInput) {
    return withIdempotency(
      {
        scope: 'liquidity.offer.create',
        participantId: input.userId,
        key: input.idempotencyKey,
        // CROSS-LAYER-SEMANTIC-CORRECTIVE-1-R3 — request-hash field
        // review. `priceBrl`, `paymentDetails`, and `network` are real
        // execution-defining terms of the offer (a different BRL price,
        // a different real-world payment destination, or a different
        // settlement rail is a materially different offer, not a retry
        // of the same one) — omitting them would let a caller reuse a
        // key across two requests that genuinely differ in what's being
        // offered, and silently get back the FIRST one's terms via
        // recover() (e.g. the seller's actual payment destination
        // silently staying whatever the first attempt said, even though
        // the retried request asked for a different one — the exact
        // "silent replay of a differing request" this key exists to
        // prevent). `description` is included too: it's part of what
        // the caller explicitly submitted as this offer's content, on
        // the same footing as every other field already hashed here
        // (this hash was never scoped to "only the fields that move
        // funds" — `paymentMethod`, already present, isn't fund-moving
        // either) — a genuine content edit deserves a fresh key, not a
        // silent no-op replay.
        requestPayload: {
          asset: input.asset, side: input.side, priceUsd: input.priceUsd, priceBrl: input.priceBrl,
          minAmount: input.minAmount, maxAmount: input.maxAmount, paymentMethod: input.paymentMethod,
          paymentDetails: input.paymentDetails, network: input.network, description: input.description,
          paymentAccountHash: input.paymentAccountHash,
        },
      },
      (claimId) => this.persistOffer(input, claimId),
      (offer) => this.postPersistOffer(input, offer),
      async (offerId) => {
        const offer = await prisma.offer.findUnique({ where: { id: offerId } })
        if (!offer) throw new NotFoundError('Offer', offerId)
        return offer
      }
    )
  }

  // CROSS-LAYER-SEMANTIC-CORRECTIVE-1-R2/R3/R4/R5 — the durable side
  // effect of createOffer() is TWO independently-durable writes:
  // `intentEngine.create()` (its own internally-durable Intent row — not
  // decomposed further here; it is a widely-shared function used by many
  // other callers, and splitting IT further is out of this bounded
  // mission's scope) followed by `prisma.offer.create()`. R2 treated
  // these as one unit; R3/R4 closed the Intent side's own unknown-outcome
  // window (see `Intent.idempotencyClaimId`'s doc comment). R5 closes the
  // SAME window one write later: if `prisma.offer.create()` itself
  // genuinely commits but the caller never learns that (a lost
  // acknowledgement, not a real failure), a naive retry would call
  // `prisma.offer.create()` again against the SAME reconciled Intent,
  // producing a SECOND Offer for the same logical attempt.
  //
  // Architecture truth check (not a convenience decision — see
  // `Intent.offers`'s own doc comment for the full reasoning): one
  // canonical Intent maps to AT MOST ONE Offer, genuinely, not merely
  // "in practice" — every `createOffer()` call creates a brand-new
  // Intent; the only way two Offers could ever share one Intent is
  // exactly this reconciliation path, which by definition is the SAME
  // logical attempt. `Offer.intentId` now carries a real `@unique`
  // constraint reflecting that truth (this is asymmetric with
  // `Trade.intentId`, deliberately NOT unique — multiple Trades
  // legitimately share one Intent via a still-`ACTIVE` Offer).
  //
  // Fix: no separate Offer-side idempotency-claim column needed at all
  // — `intentId` is ALREADY a 1:1 correlation key for "this logical
  // attempt" once R4 made Intent itself uniquely tied to the idempotency
  // claim. A retry looks up an existing Offer by `intentId` (a direct,
  // already-committed-row read, exactly the same "ask the database what
  // actually exists" discipline R4 uses for the Intent side, never
  // "was the previous attempt's throw proof of anything") BEFORE
  // attempting a new insert; the `isUniqueConstraintError()` catch below
  // handles the residual, genuinely-concurrent case the same way R4's
  // Intent-side reconciliation does.
  private async persistOffer(input: CreateOfferInput, claimId: string | null) {
    // #235 R7C — verified before any write (the Intent below is the first),
    // so a rejected declaration leaves nothing behind.
    let paymentAccountId: string | undefined
    if (input.paymentAccountHash) {
      if (input.side !== 'SELL') {
        throw new ValidationError('Only a SELL offer declares a payment account: on a BUY offer the maker sends the fiat, the seller who takes it receives it')
      }
      paymentAccountId = await paymentAccountService.bindableAccountId({ accountHash: input.paymentAccountHash }, input.userId, input.paymentMethod)
    }

    let intentId: string
    if (!claimId) {
      const intent = await intentEngine.create('TradeIntent', buildTradeIntentPayload(input), input.userId)
      intentId = intent.id
    } else {
      const existingIntent = await intentRepository.findByIdempotencyClaimId(claimId)
      if (existingIntent) {
        intentId = existingIntent.id
      } else {
        try {
          const intent = await intentEngine.create('TradeIntent', buildTradeIntentPayload(input), input.userId, undefined, claimId)
          intentId = intent.id
        } catch (err) {
          if (!isUniqueConstraintError(err)) throw err
          // A concurrent retry (or this same retry racing itself across
          // two application instances) already won — reconcile to their
          // Intent rather than assume ours failed for some other reason.
          const winner = await intentRepository.findByIdempotencyClaimId(claimId)
          if (!winner) throw err // genuinely unexpected — surface the original error rather than guess
          intentId = winner.id
        }
      }
    }

    const offerData = {
      userId: input.userId,
      asset: input.asset,
      side: input.side,
      priceUsd: input.priceUsd,
      priceBrl: input.priceBrl,
      minAmount: input.minAmount,
      maxAmount: input.maxAmount,
      paymentMethod: input.paymentMethod,
      paymentDetails: input.paymentDetails,
      network: input.network,
      description: input.description,
      intentId,
      paymentAccountId,
    }

    if (!claimId) {
      return prisma.offer.create({ data: offerData })
    }

    // CROSS-LAYER-SEMANTIC-CORRECTIVE-1-R5 — the Intent above is
    // canonical for this logical attempt; if an Offer already exists for
    // it, a PRIOR attempt's `prisma.offer.create()` already durably
    // succeeded (whether or not that attempt itself ever learned that),
    // and this is that same Offer, recovered by direct lookup, never by
    // re-running the insert.
    const existingOffer = await prisma.offer.findUnique({ where: { intentId } })
    if (existingOffer) return existingOffer

    try {
      return await prisma.offer.create({ data: offerData })
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err
      // Genuinely concurrent race on the same reconciled Intent (two
      // application instances retrying the same reclaimed claim) — the
      // loser reconciles via the identical lookup, never assumes its own
      // insert failing means nothing was created.
      const winner = await prisma.offer.findUnique({ where: { intentId } })
      if (!winner) throw err // genuinely unexpected — surface the original error rather than guess
      return winner
    }
  }

  // CROSS-LAYER-SEMANTIC-CORRECTIVE-1-R2 — runs AFTER the Offer already
  // durably exists. `eventBus.emit()`'s failure is real and propagates
  // to createOffer()'s original caller, but idempotency.ts's
  // runAndSettle() has already settled the claim to COMPLETED/UNKNOWN by
  // the time this runs — a retry with the same key always recovers the
  // existing Offer via recover() above, never calls persistOffer() again,
  // and can never create a second Offer row. screenOfferContent() was
  // already fire-and-forget (never awaited, failures only logged/metered
  // internally) before this correction and stays exactly that — moving
  // it here changes nothing about its own error handling.
  private async postPersistOffer(input: CreateOfferInput, offer: Awaited<ReturnType<LiquidityRouter['persistOffer']>>) {
    await eventBus.emit('liquidity.offer.created', {
      offerId: offer.id,
      userId: offer.userId,
      asset: offer.asset,
      side: offer.side,
      priceUsd: offer.priceUsd.toString(),   // RFC-009 — Decimal -> decimal string at the event boundary
    }, offer.id)   // correlationId (RFC-010) — no tradeId exists yet for an offer

    screenOfferContent(offer.id, offer.userId, input.description, input.paymentDetails)
  }

  // Real gap found wiring the first real caller (packages/sails-ui's
  // OfferDetail screen): no route ever let a caller fetch a single Offer
  // by id, including its owner's public profile fields — discover()/
  // getAggregatedOffers() only support asset+side listing, and the
  // aggregated LiquidityOffer summary shape they return is missing
  // several fields OfferDetail genuinely needs (network, description,
  // the seller's displayName/verified/totalTrades).
  //
  // Technical Debt #61 bounded remediation (2026-09-10) — this used to
  // `include` the full raw Offer row (no `select`) plus a wide `user`
  // projection, and return it directly to this route's unauthenticated
  // caller. `Offer.paymentDetails` (the seller's real payment
  // destination — bank/PIX/wallet instructions) flowed straight through:
  // real payment-execution data reachable by anyone who could guess or
  // enumerate an offer id, before any trade ever formed. `userId`,
  // `moduleId`, `protocolVersion`, `intentType`, `intentId` were also raw
  // persistence-only fields with no discovery/evaluation value.
  //
  // Fixed with an explicit `select` (never the bare row) mapped through
  // mapOfferToPublicDetail() below — same "Persistence Row -> explicit
  // projection -> HTTP" shape mapOfferToLiquidityOffer() above already
  // established for discover()/getOrderBook(); new Prisma columns on
  // Offer/User can never silently reach this route, since only fields
  // named in the `select` are ever fetched, and only fields named in the
  // mapper are ever returned.
  //
  // Seller disclosure is deliberately capped at (not merged beyond)
  // this protocol's two other canonical public views — never a third,
  // broader definition of "public participant profile":
  // identity.service.ts's getPublicView() (id/publicKey/displayName/
  // peerId/verified, GET /v1/identity/participants/:id) and
  // reputation.service.ts's getScore() (reputationScore/totalTrades/
  // disputeRate, GET /v1/reputation/:participantId). `disputeCount` is
  // fetched (needed to derive `disputeRate` the same way getScore()
  // does) but never included in the returned shape; `totalVolumeBtc`
  // and `User.createdAt` are dropped entirely — neither canonical view
  // exposes them, and no separate product decision has expanded them.
  //
  // `paymentDetails` remains reachable exactly once a trade actually
  // forms, via the already-authorized path (tradeService.getTrade(),
  // gated by requireAuth + an explicit buyer/seller ownership check —
  // trade.routes.ts's own GET /v1/openp2p/trades/:id, SECURITY_AUDIT_REPORT.md
  // §2) — unchanged by this remediation.
  async getOffer(offerId: string): Promise<PublicOfferDetail> {
    const offer = await prisma.offer.findUnique({
      where: { id: offerId },
      select: {
        id: true, asset: true, side: true, priceUsd: true, priceBrl: true,
        minAmount: true, maxAmount: true, paymentMethod: true, status: true,
        network: true, description: true, createdAt: true, updatedAt: true, paymentAccountId: true,
        user: { select: {
          id: true, publicKey: true, displayName: true, peerId: true,
          verified: true, reputationScore: true, totalTrades: true, disputeCount: true,
        } },
      },
    })
    if (!offer) throw new NotFoundError('Offer', offerId)
    return mapOfferToPublicDetail(offer)
  }

  // Real gap found auditing packages/sails-ui's Profile screen
  // (2026-08-01): "Minhas Ofertas" read lib/offersStore.ts/localStorage
  // instead of the real backend, so a just-published offer never showed
  // up on the publisher's own profile. No route/service method existed
  // to list a participant's own offers — discover()/getAggregatedOffers()
  // only ever filter by asset+side, never by userId, and intentionally
  // exclude non-ACTIVE offers (a user's own paused/completed/cancelled
  // offers must still be visible to them). Returns the raw persisted
  // Offer rows (not the LiquidityOffer aggregation summary) — same
  // shape getOffer() above already returns, since a self-view needs
  // status/createdAt/etc., not an aggregation-only summary.
  async getOffersByUser(userId: string) {
    return prisma.offer.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    })
  }

  async updateOfferStatus(offerId: string, status: OfferStatus, triggeredBy: string) {
    const offer = await prisma.offer.findUnique({ where: { id: offerId } })
    if (!offer) throw new NotFoundError('Offer', offerId)
    if (offer.userId !== triggeredBy) {
      throw new ForbiddenError(`${triggeredBy} does not own offer ${offerId}`)
    }

    const updated = await prisma.offer.update({ where: { id: offerId }, data: { status } })

    await eventBus.emit('liquidity.offer.status_changed', {
      offerId,
      from: offer.status,
      to: status,
      triggeredBy,
    }, offerId)

    return updated
  }

  async getOrderBook(asset: AssetType): Promise<{
    asset: AssetType
    bids: LiquidityOffer[]
    asks: LiquidityOffer[]
    spread: string | null
  }> {
    const [bids, asks] = await Promise.all([
      this.getAggregatedOffers(asset, 'BUY'),
      this.getAggregatedOffers(asset, 'SELL'),
    ])

    const bestBid = bids.offers[0]?.priceUsd
    const bestAsk = asks.offers[0]?.priceUsd
    // Number() coercion here is display-only (the spread shown in an order
    // book response), same justification as the sort comparator above —
    // never used for a stored/computed amount. See RFC-009.
    const spread = bestBid && bestAsk ? (Number(bestAsk) - Number(bestBid)).toFixed(8) : null

    return { asset, bids: bids.offers, asks: asks.offers, spread }
  }

  // Missão 07.1 (Golden Path audit, Fase 1) — real bug, confirmed live and
  // disclosed here since 2026-08-09 until this fix: collectFromProviders()
  // used to call every provider's getOffers() with pagination: undefined,
  // so each provider silently capped at its own DEFAULT_PAGE_LIMIT (10)
  // internally, and this method's slice below re-paginated *that* fixed
  // 10-row window, not the true result set. Any offset > 0, or a total
  // matching-offer count > 10, produced a wrong (short/empty) page with a
  // `total`/`hasMore` that lied — both computed from `sorted.length`, the
  // capped window's size, not reality.
  //
  // Fix: ask each provider for its own top `offset + limit` matches
  // (`neededCount` below) instead of an unrelated fixed page. This is
  // sufficient and correct for a k-way merge of independently-sorted
  // sources — the true top-N of the merged set can never draw more than N
  // items from any single source, so N per source is always enough
  // candidates, regardless of how many providers exist (same reasoning
  // proposeForIntent() above already applies with MAX_PAGE_LIMIT, made
  // precise here instead of using one fixed cap for every request). Right
  // now there is exactly one provider (InternalOrderBook), so this also
  // works out to "ask Postgres for exactly the rows this page needs,"
  // still bounded by a real ORDER BY/LIMIT/OFFSET query, not an unbounded
  // fetch-everything. `total`/`hasMore` now come from a real COUNT query
  // (countOffers()) against the same filters, not the fetched window's size.
  async getAggregatedOffers(
    asset: AssetType,
    side: TradeSide,
    pagination?: OfferPagination,
    filters?: OfferFilters
  ): Promise<{ offers: LiquidityOffer[]; sources: string[]; total: number; hasMore: boolean }> {
    const { limit, offset } = normalizePagination(pagination)
    const neededCount = offset + limit

    const [{ offers: all, sources }, total] = await Promise.all([
      this.collectFromProviders(asset, side, filters, neededCount),
      this.countAcrossProviders(asset, side, filters),
    ])

    // Number() coercion here is intentional and safe — a sort comparator only
    // needs correct relative order, not exact arithmetic, so float precision
    // is immaterial (unlike a stored/computed amount). See RFC-009.
    const sorted = all.sort(side === 'BUY' ? compareByPriceDesc : compareByPriceAsc)

    const paginated = sorted.slice(offset, offset + limit)
    const hasMore = offset + limit < total

    return { offers: paginated, sources, total, hasMore }
  }

  // Same `try/continue on failure` discipline the router's findBestMatch()
  // already uses — a single provider going down (e.g. HodlHodl API auth
  // expiring) should never take the whole discovery endpoint down with it.
  // Extracted so the for-loop body is the single source of truth for
  // "what counts as a provider succeeding." `neededCount` is the top-N
  // (offset + limit) each provider is asked for — see getAggregatedOffers()'s
  // own comment for why that's the correct, sufficient amount per provider.
  private async collectFromProviders(asset: AssetType, side: TradeSide, filters: OfferFilters | undefined, neededCount: number): Promise<{ offers: LiquidityOffer[]; sources: string[] }> {
    const offers: LiquidityOffer[] = []
    const sources: string[] = []

    for (const provider of this.providers) {
      try {
        if (!(await provider.isAvailable())) continue
        offers.push(...await provider.getOffers(asset, side, { limit: neededCount, offset: 0 }, filters))
        sources.push(provider.name)
      } catch (err) {
        log.error({ err, provider: provider.name }, '[Router] Provider failed')
      }
    }

    return { offers, sources }
  }

  // Real total across every available provider, same filters — a plain sum
  // is correct here (no double-counting risk: each provider owns a
  // disjoint slice of the marketplace, unlike offers themselves which get
  // merged/sorted above).
  private async countAcrossProviders(asset: AssetType, side: TradeSide, filters?: OfferFilters): Promise<number> {
    let total = 0
    for (const provider of this.providers) {
      try {
        if (!(await provider.isAvailable())) continue
        total += await provider.countOffers(asset, side, filters)
      } catch (err) {
        log.error({ err, provider: provider.name }, '[Router] Provider count failed')
      }
    }
    return total
  }

  async findBestMatch(asset: AssetType, side: TradeSide, amount: string): Promise<LiquidityOffer | null> {
    for (const provider of this.providers) {
      try {
        if (!(await provider.isAvailable())) continue
        const match = await provider.matchOrder(asset, side, amount)
        if (match) return match
      } catch (err) {
        log.error({ err, provider: provider.name }, '[Router] matchOrder failed')
      }
    }
    return null
  }

  // RFC-023 — the backend half of making packages/sails-ui's "AI
  // Negotiator" real. Composes existing pieces rather than a new matching
  // algorithm: getOffers(), plus an application-level filter over price/
  // traderReputation/amount (the join already exists on every returned
  // row, just unused for this purpose until now). Called from
  // POST /v1/intents/:id/propose (core/intent.routes.ts) — this method
  // itself has no knowledge of Intent/auth/ownership, same separation
  // getOffers()/findBestMatch() above already keep from their own
  // route-layer callers.
  //
  // Missão 02 Fase 2/4 — price filtering moved from getOffers()'s own
  // Prisma-level where clause (the original RFC-023 shape) to an
  // in-memory check below. Deliberate: a Prisma-level price filter can
  // only ever return "match" or "nothing," and Fase 4 asks for a real
  // counterproposal when the only reason nothing matched is price — that
  // needs to see the near-miss candidates to reason about them, not just
  // their absence. Reputation/amount are still hard requirements (no
  // counterproposal, computed or otherwise, is offered when either of
  // those two is the blocker — counter-pricing can't fix a reputation or
  // quantity mismatch, only a price one).
  async proposeForIntent(
    asset: AssetType,
    side: TradeSide,
    amount: string,
    limits: { priceMin?: string; priceMax?: string; minReputation?: number }
  ): Promise<{ match: LiquidityOffer | null; counterProposal: CounterProposal | null }> {
    // Same counter-side flip matchOrder() above already applies — `side`
    // here is the Intent's own declared side (what the user wants to do),
    // so the actual counterparty offers to search are the opposite side
    // (a BUY intent needs a SELL offer to match against, and vice versa).
    const counterSide: TradeSide = side === 'BUY' ? 'SELL' : 'BUY'

    const offers: LiquidityOffer[] = []
    for (const provider of this.providers) {
      try {
        if (!(await provider.isAvailable())) continue
        // Explicit MAX_PAGE_LIMIT, not the smaller DEFAULT_PAGE_LIMIT a
        // pagination-less call would use — applying the filters below
        // after only a 10-row page could report "no match" when a valid
        // one sits just past that page (same disclosed-limitation class
        // getAggregatedOffers()'s own comment already flags for a
        // different filter). No price filter passed here anymore — see
        // header comment above.
        offers.push(...await provider.getOffers(asset, counterSide, { limit: MAX_PAGE_LIMIT, offset: 0 }))
      } catch (err) {
        log.error({ err, provider: provider.name }, '[Router] proposeForIntent provider fetch failed')
      }
    }

    // Best-price-for-the-caller direction, same as matchOrder()'s own
    // `orderBy` above: cheapest SELL offer first when buying, highest BUY
    // offer first when selling.
    const sorted = offers.sort(counterSide === 'SELL' ? compareByPriceAsc : compareByPriceDesc)
    const amountNum = Number(amount)
    const minReputation = limits.minReputation ?? 0
    const priceMinNum = limits.priceMin !== undefined ? Number(limits.priceMin) : undefined
    const priceMaxNum = limits.priceMax !== undefined ? Number(limits.priceMax) : undefined

    // Real bug found in a post-implementation review (pre-Missão 02):
    // getOffers()'s OfferFilters only covered price, not amount — unlike
    // matchOrder() above, which explicitly bounds-checks minAmount/
    // maxAmount against the requested amount. Without this check here,
    // this method could return an offer whose own limits don't actually
    // cover the requested trade — createTrade() would still catch it at
    // approval time (its own real bounds check, one layer over), but the
    // whole point of "propose" is to only ever surface an offer that
    // would actually succeed, not one the approval step then rejects.
    const passesAmountAndReputation = (o: LiquidityOffer): boolean =>
      (o.traderReputation ?? 0) >= minReputation &&
      amountNum >= Number(o.minAmount) && amountNum <= Number(o.maxAmount)

    const passesPrice = (o: LiquidityOffer): boolean => {
      const p = Number(o.priceUsd)
      if (priceMinNum !== undefined && p < priceMinNum) return false
      if (priceMaxNum !== undefined && p > priceMaxNum) return false
      return true
    }

    const fullMatch = sorted.find((o) => passesAmountAndReputation(o) && passesPrice(o)) ?? null
    if (fullMatch) return { match: fullMatch, counterProposal: null }

    // Counterproposal — Missão 02 Fase 4, single-shot only (no automated
    // back-and-forth with the counterparty; that's a materially bigger
    // feature, deliberately out of scope here). The relevant bound is the
    // one the Intent's own `side` actually cares about: a BUY intent has
    // a price ceiling (maxPriceUsd), a SELL intent has a price floor
    // (minPriceUsd) — the other bound, if present, isn't what a
    // counterproposal along this axis could fix. The suggested price is
    // always the caller's own already-declared limit, never a fabricated
    // number and never worse than what they already authorized
    // themselves — this cannot be used to silently exceed the Intent's
    // own bounds (Missão 02's explicit "não permitir alteração arbitrária
    // da Intent").
    const relevantBoundNum = side === 'BUY' ? priceMaxNum : priceMinNum
    if (relevantBoundNum === undefined) return { match: null, counterProposal: null }

    const nearMiss = sorted.find((o) => {
      if (!passesAmountAndReputation(o)) return false
      const p = Number(o.priceUsd)
      return side === 'BUY' ? p > relevantBoundNum : p < relevantBoundNum
    })
    if (!nearMiss) return { match: null, counterProposal: null }

    const suggestedPriceUsd = String(relevantBoundNum)
    const boundName = side === 'BUY' ? 'maxPriceUsd' : 'minPriceUsd'

    return {
      match: null,
      counterProposal: {
        referenceOfferId: nearMiss.id,
        listedPriceUsd: nearMiss.priceUsd,
        suggestedPriceUsd,
        reasoning:
          `Nearest real offer (${nearMiss.id}) is listed at ${nearMiss.priceUsd}, outside this ` +
          `Intent's own ${boundName} (${suggestedPriceUsd}). Suggesting your own declared limit as ` +
          `a counter — this is informational only: it does not create or modify any Offer, and ` +
          `trading against ${nearMiss.id} directly still executes at its own listed price, not this suggestion.`,
      },
    }
  }
}

export const liquidityRouter = new LiquidityRouter()
