// tests/integration/economicFixtures.ts
//
// #235 R7H-E3 — fixture preconditions for escrows on a governed rail (MULTISIG/BTC under the trade-limit policy).
//
// Since R7H-E3 the database and the escrow service refuse an escrow on a governed rail unless, under the policy
// version in force: the trade's seller created it, the trade is bound to a PaymentAccount that seller owns, the
// account's method is the offer's method, and that method is eligible (V1: PIX). These helpers build exactly those
// preconditions, explicitly, so a suite written before E3 keeps proving its own invariant on a trade E3 accepts.
// They grant nothing: every row goes through the same guards as production data.
//
//   const acct = await sellerPixAccount(prisma, seller.id)
//   offer:  liquidityRouter.createOffer({ ..., ...boundOfferInput(acct) })      (service, SELL offer)
//           prisma.offer.create({ data: { ..., ...boundOfferRow(acct) } })      (row)
//   trade:  tradeService.createTrade(...)  inherits the binding from a SELL offer; for a row:
//           prisma.trade.create({ data: { ..., ...boundTradeRow(acct) } })
//   escrow: escrowService.createEscrow(input, trade.sellerId)                     (the seller, never the buyer)
//   cleanup: await deleteFixtureAccounts(prisma, userIds) after trades and offers, before users.

import { randomBytes } from 'crypto'

type AccountRow = { id: string; accountHash: string }
type Db = {
  paymentAccount: { create(args: { data: Record<string, unknown> }): Promise<AccountRow> }
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>
}

/** A PIX PaymentAccount owned by `sellerId`: the account a governed-rail trade must be bound to. */
export function sellerPixAccount(db: Db, sellerId: string): Promise<AccountRow> {
  return db.paymentAccount.create({ data: { ownerId: sellerId, accountHash: `fixture-pix-${randomBytes(12).toString('hex')}`, paymentMethod: 'PIX' } })
}

/** liquidityRouter.createOffer() input binding `account` (SELL offer: the trade taken from it inherits the binding). */
export const boundOfferInput = (account: AccountRow) => ({ paymentMethod: 'PIX' as const, paymentAccountHash: account.accountHash })

/** prisma.offer.create() data binding `account`. */
export const boundOfferRow = (account: AccountRow) => ({ paymentMethod: 'PIX' as const, paymentAccountId: account.id })

/** prisma.trade.create() data binding `account` (write-once: only at creation). */
export const boundTradeRow = (account: AccountRow) => ({ sellerPaymentAccountId: account.id })

type TradeDb = { trade: { create(args: { data: Record<string, unknown> }): Promise<any>; count(args: { where: Record<string, unknown> }): Promise<number> } }
type OfferForTrade = { id: string; userId: string; side: string; asset: string; priceUsd: unknown; network?: string | null; intentId?: string | null }

/**
 * #235 R7H-E3C — since E3C a trade whose canonical escrow could not be authorized (unbound, foreign, mismatched or
 * ineligible-method, on a governed rail) is never admitted. Suites whose SUBJECT is a guard downstream of admission
 * (the escrow trigger, attestation, the trust ramp) still need such a trade, as it exists from before E3C. This first
 * proves a new admission of it is refused with `code` and leaves no trade, then plants exactly what the pre-E3C
 * service committed: the same row (parties, amount, price, network, intent, binding) by a direct insert, followed by
 * the pre-B2 post-commit step (events, the offer Intent's walk to NEGOTIATING, the negotiation — legacyPostCommit()).
 * A historical fixture scoped to that one trade; no guard is lifted (no trigger guards a trade insert).
 */
export async function refusedThenHistoricalTrade(
  db: TradeDb,
  tradeService: unknown,
  admit: () => Promise<unknown>,
  code: string,
  offer: OfferForTrade,
  takerId: string,
  amount: string,
  sellerPaymentAccountId: string | null = null,
): Promise<any> {
  await expect(admit()).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining(`economic authorization binding — ${code}:`) })
  expect(await db.trade.count({ where: { offerId: offer.id } })).toBe(0)
  const [buyerId, sellerId] = offer.side === 'SELL' ? [takerId, offer.userId] : [offer.userId, takerId]
  const priceUsd = String(offer.priceUsd)
  const trade = await db.trade.create({
    data: {
      offerId: offer.id, buyerId, sellerId, asset: offer.asset, amount, priceUsd,
      totalUsd: (Number(priceUsd) * Number(amount)).toFixed(8), network: offer.network ?? null, intentId: offer.intentId ?? null,
      sellerPaymentAccountId,
    },
  })
  await legacyPostCommit(trade, takerId)
  return trade
}

/**
 * The post-commit step the service ran for every trade BEFORE #235 R7H-NF-E3C-5 (B2): the trade-created event, the walk
 * of the OFFER's shared Intent to NEGOTIATING, and the negotiation opening. B2 no longer does this (each trade is born
 * with its own Intent, atomically); a historical-trade fixture reproduces it so the downstream guard under test sees
 * exactly the state such a trade really had. The Intent is walked only if still COORDINATED (a second historical
 * trade on one offer finds it already past that — which was the pre-B2 defect, not something to re-create).
 */
async function legacyPostCommit(trade: any, takerId: string): Promise<void> {
  const { eventBus } = require('../../src/common/events/event-bus')
  const { intentEngine } = require('../../src/core/intent-engine')
  const { negotiationService } = require('../../src/modules/open-p2p/negotiation.service')
  await eventBus.emit('openp2p.trade.created', {
    tradeId: trade.id, offerId: trade.offerId, buyerId: trade.buyerId, sellerId: trade.sellerId,
    asset: trade.asset, amount: trade.amount.toString(), priceUsd: trade.priceUsd.toString(),
  }, trade.id)
  if (trade.intentId) {
    const { prisma } = require('../../src/common/database')
    const intent = await prisma.intent.findUnique({ where: { id: trade.intentId } })
    if (intent?.status === 'COORDINATED') {
      const by = 'system:trade-lifecycle'
      await intentEngine.transition(trade.intentId, 'DISCOVERING', by, 'intent.discovering', { intentId: trade.intentId })
      await intentEngine.transition(trade.intentId, 'MATCHED', by, 'intent.matched', { intentId: trade.intentId, candidateIds: [takerId] })
      await intentEngine.transition(trade.intentId, 'NEGOTIATING', by, 'intent.negotiating', { intentId: trade.intentId, negotiationId: trade.id })
    }
  }
  await negotiationService.open(trade.id, trade.buyerId, trade.sellerId)
}

/** Fixture accounts are removed after the trades and offers that reference them, before their owners. */
export async function deleteFixtureAccounts(db: Db, ownerIds: string[]): Promise<void> {
  await db.$executeRaw`DELETE FROM payment_accounts WHERE "ownerId" = ANY(${ownerIds})`
}
