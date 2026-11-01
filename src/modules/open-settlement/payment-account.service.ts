/**
 * PaymentAccountService — Sails OpenSettlement
 * RFC-021 D5 (`docs/rfcs/RFC-021-market-based-arbitration-and-payment-trust.md`).
 *
 * Real payment-account trust ramp, modeled on Bisq's actual "Payment
 * account age witness"/account signing (verified against Bisq's own
 * docs before writing this, not invented). A SEPARATE risk dimension
 * from `reputation.service.ts`'s `User.reputationScore`: this measures
 * whether a specific payment rail (a PIX key, a bank account) has
 * survived a completed trade without a chargeback — an otherwise
 * reputable trader's account can still be stolen/compromised, which is
 * exactly the "conta laranja" (mule account) risk trader reputation
 * alone does not cover.
 *
 * `attestFromTrade()` deliberately reuses D1's narrow-attestation
 * framing (the same reasoning `market-arbitration.provider.ts`'s header
 * comment states for arbiters): the signer is attesting "this specific
 * trade completed without dispute," never "this person is trustworthy."
 *
 * #235 R7C — who may attest, and which account. A PaymentAccount is the
 * fiat receiver's (seller's) rail. The seller binds it to a trade when the
 * trade is created (bindableAccountId() below, the one check every binding
 * path uses), and only the BUYER of a clean COMPLETED trade may then attest
 * that trade's bound account — never the owner, never anyone else, never a
 * different account. The server cannot prove that a client-computed
 * accountHash matches the free-text payment details the buyer actually paid
 * to; the buyer's attestation, made with the hash of what they paid to, is
 * the witness that the declared account was the one used.
 */
import { createHash } from 'node:crypto'
import { prisma } from '../../common/database'
import { ForbiddenError, NotFoundError, ValidationError } from '../../common/errors'
import { eventBus } from '../../common/events/event-bus'
import { applyEventProjectionOnce } from '../../common/events/event-projection'
import { isUniqueConstraintError } from '../../common/idempotency'
import type { PaymentMethod } from '../../common/types'

// RFC-021 D5 — trade-limit ramp. Deliberately reuses SECURITY_MODEL.md
// §1.4's exact tier values (0.001/0.01/0.05 BTC, unlimited) rather than
// inventing a second, conflicting number scale — a trader should see
// one coherent limit, not two systems disagreeing. Starting proposal,
// not final (PROTOCOL_ECONOMY.md §7's own "not fixed forever" precedent
// applies here too).
export const UNSIGNED_TRADE_LIMIT = '0.001'
export const SIGNED_TRADE_LIMIT = '0.01'
export const ESTABLISHED_TRADE_LIMIT = '0.05'
export const ESTABLISHED_TRADE_COUNT = 5
export const TRUSTED_TRADE_COUNT = 20 // + zero chargebacks -> unlimited

// Missão 11 Fase 9.3.1 — the ONLY shape ever returned to an unauthenticated
// caller (GET /v1/settlement/payment-accounts/:accountHash, no requireAuth
// — deliberately public by design, RFC-021 D5's own "verify a payment
// account has been used before... without revealing the account's real
// details"). Deliberately excludes `id` (internal relational identifier,
// no verification value), `ownerId` and `signedBy` (platform User ids —
// exposing either turns "verify this payment rail's trust history" into
// "deanonymize which platform identity owns/attested a real-world payment
// identifier," a privacy leak the RFC's own age-witness design was
// explicitly built to avoid), and `moduleId`/`protocolVersion`/`updatedAt`
// (operator-internal bookkeeping, zero verification value). Every field
// kept here is either the literal subject of verification (accountHash,
// paymentMethod, signed, firstUsedAt — the "age" in "age witness") or lets
// an independent client-side implementation of the SAME public trade-limit
// formula (UNSIGNED_TRADE_LIMIT/SIGNED_TRADE_LIMIT/etc. above are exported
// SDK constants) verify the server's own tradeLimit computation is
// correct — genuine verifiability, not identity disclosure.
export interface PublicPaymentAccountView {
  accountHash: string
  paymentMethod: PaymentMethod
  signed: boolean
  signedAt: Date | null
  firstUsedAt: Date
  completedTrades: number
  chargebacks: number
  tradeLimit: string
}

export class PaymentAccountService {
  /**
   * Privacy-preserving hash — the raw account identifier (PIX key, bank
   * account number) is never stored, matching Bisq's own
   * AccountAgeWitness shape: a hash both sides can check without either
   * seeing the other's real account data.
   */
  hashAccountIdentifier(paymentMethod: string, rawIdentifier: string): string {
    return createHash('sha256').update(`${paymentMethod}:${rawIdentifier}`).digest('hex')
  }

  /**
   * Idempotent: returns the existing PaymentAccount if this hash was
   * already seen, otherwise creates it.
   *
   * RFC-021 D7 — a brand-new owner's FIRST payment account is created
   * already `signed` if a peer vouched for them (`Vouch`,
   * `vouch.service.ts`, OpenReputation's own table). This is a
   * cross-module READ done directly against Prisma, not a call into
   * `vouchService` — the same "reading another module's table directly
   * is fine, only writes must go through the owning module" boundary
   * `escrow.service.ts` already relies on for its own Trade reads.
   * Explicitly scoped to a NEW account only: an owner's second/third
   * payment account gets no special treatment from a vouch — the vouch
   * bootstraps the person's first rail, exactly the cold-start gap D7
   * exists to close, not a blanket exemption from ever needing to sign
   * an account for real.
   */
  async getOrCreate(ownerId: string, accountHash: string, paymentMethod: PaymentMethod) {
    const existing = await prisma.paymentAccount.findUnique({ where: { accountHash } })
    if (existing) return existing
    try {
      return await this.createAccount(ownerId, accountHash, paymentMethod)
    } catch (err) {
      // #235 R7H-E3B — two registrations of one new hash racing (a double submit, two participants): the unique
      // index admits exactly one; the other caller gets that row, never a 500. Its owner decides what they see.
      if (!isUniqueConstraintError(err)) throw err
      const winner = await prisma.paymentAccount.findUnique({ where: { accountHash } })
      if (!winner) throw err
      return winner
    }
  }

  private async createAccount(ownerId: string, accountHash: string, paymentMethod: PaymentMethod) {

    // "First rail" checked precisely, not just "this exact hash is new" —
    // an already-established owner adding a second/third payment method
    // gets no special treatment from a vouch, only a genuinely new owner
    // does.
    const isOwnersFirstAccount = (await prisma.paymentAccount.count({ where: { ownerId } })) === 0
    const activeVouch = isOwnersFirstAccount
      ? await prisma.vouch.findFirst({ where: { voucheeId: ownerId, burnedAt: null } })
      : null

    if (activeVouch) {
      return prisma.paymentAccount.create({
        data: { ownerId, accountHash, paymentMethod, signed: true, signedBy: activeVouch.voucherId, signedAt: new Date(), attestationSource: 'VOUCHER' },
      })
    }

    return prisma.paymentAccount.create({ data: { ownerId, accountHash, paymentMethod } })
  }

  async getByHash(accountHash: string) {
    const account = await prisma.paymentAccount.findUnique({ where: { accountHash } })
    if (!account) throw new NotFoundError('PaymentAccount', accountHash)
    return account
  }

  /**
   * #235 R7C — the one check every trade binding goes through: the account
   * exists, belongs to the trade's seller, and is on the offer's payment
   * method. Returns the account id to persist on the Offer/Trade. Accepts
   * the account by its public hash (the seller's own selection) or by id
   * (re-verifying a binding an Offer already carries).
   */
  async bindableAccountId(account: { accountHash: string } | { id: string }, sellerId: string, paymentMethod: PaymentMethod): Promise<string> {
    const row = await prisma.paymentAccount.findUnique({ where: 'id' in account ? { id: account.id } : { accountHash: account.accountHash } })
    if (!row) throw new NotFoundError('PaymentAccount', 'id' in account ? account.id : account.accountHash)
    if (row.ownerId !== sellerId) {
      throw new ForbiddenError('Only a payment account owned by the seller can be bound to this trade')
    }
    if (row.paymentMethod !== paymentMethod) {
      throw new ValidationError(`Payment account is for ${row.paymentMethod}, but this offer is paid by ${paymentMethod}`)
    }
    return row.id
  }

  /**
   * D5's real attestation — narrow, factual, matches D1's framing: "I paid
   * into this account in this specific trade and it completed cleanly," not
   * a KYC/compliance vouch. Every fact comes from durable state: the trade,
   * its bound account, its buyer, its completion. `accountHash` is the hash
   * of the account the buyer actually paid to; it must equal the bound one.
   *
   * One-way and atomic: the account is written only `WHERE signed = false`,
   * so concurrent attestations have exactly one winner and nothing ever
   * overwrites an earlier attestation (the database enforces the same).
   * An authorized repeat on an already-signed account is a no-op.
   */
  async attestFromTrade(tradeId: string, accountHash: string, attesterId: string) {
    const trade = await prisma.trade.findUnique({
      where: { id: tradeId },
      select: { id: true, buyerId: true, sellerId: true, status: true, sellerPaymentAccountId: true, escrow: { select: { status: true } } },
    })
    if (!trade) throw new NotFoundError('Trade', tradeId)
    if (trade.buyerId !== attesterId) {
      throw new ForbiddenError('Only the buyer of this trade may attest the payment account it paid into')
    }
    if (!trade.sellerPaymentAccountId) {
      throw new ValidationError(`Trade ${tradeId} has no bound payment account, so there is nothing to attest`)
    }
    // Clean completion: the escrow released normally (Trade COMPLETED also
    // covers SPLIT) and no dispute ever existed. Both are final: a COMPLETED
    // escrow has no further transition, so no dispute can appear later.
    const disputes = await prisma.dispute.count({ where: { tradeId } })
    if (trade.status !== 'COMPLETED' || trade.escrow?.status !== 'COMPLETED' || disputes > 0) {
      throw new ValidationError(`Trade ${tradeId} did not complete cleanly (no dispute, escrow released), so it cannot attest a payment account`)
    }
    const account = await prisma.paymentAccount.findUnique({ where: { id: trade.sellerPaymentAccountId } })
    if (!account || account.ownerId !== trade.sellerId) {
      throw new ValidationError(`Trade ${tradeId}'s bound payment account is not the seller's`)
    }
    if (account.accountHash !== accountHash) {
      throw new ValidationError('This is not the payment account bound to this trade')
    }

    const won = await prisma.paymentAccount.updateMany({
      where: { id: account.id, signed: false },
      data: { signed: true, signedBy: attesterId, signedAt: new Date(), attestationSource: 'PEER', attestedTradeId: trade.id },
    })
    if (won.count === 1) {
      await eventBus.emit('settlement.payment_account.attested', {
        accountHash: account.accountHash, tradeId: trade.id, attesterId, attestationSource: 'PEER',
      }, trade.id)
    }
    return this.getByHash(account.accountHash)
  }

  /**
   * #235 R7D (N2) — the only writer of `completedTrades`. The seller's bound
   * PaymentAccount gains one completed trade when, and only when, its trade
   * completed cleanly. Every fact is durable and final once the escrow is
   * COMPLETED (it has no further transition): the trade's write-once binding,
   * the escrow's terminal status and its COMPLETED transition, and that no
   * dispute ever existed. The account is always the one bound to the trade,
   * never a caller's choice.
   *
   * Exactly once for any caller: the increment and a projection claim keyed
   * on (the escrow's COMPLETED transition, the trade) — identities derived
   * here, never passed in — commit together (applyEventProjectionOnce()).
   * The settlement.escrow.released handler calls this; PASS 3 re-drives that
   * handler after a crash, so no completion is lost or counted twice.
   * Returns whether this call counted it.
   *
   * There is no writer of `chargebacks`: Sails has no durable fact that a
   * fiat payment into an account was reversed (an escrow refund, a dispute
   * or a ruling is not one), so nothing is inferred.
   */
  async recordCleanBoundCompletion(tradeId: string): Promise<boolean> {
    const trade = await prisma.trade.findUnique({ where: { id: tradeId }, select: { escrowId: true, sellerPaymentAccountId: true } })
    if (!trade?.sellerPaymentAccountId || !trade.escrowId) return false
    const accountId = trade.sellerPaymentAccountId
    const escrow = await prisma.escrow.findUnique({ where: { id: trade.escrowId }, select: { status: true } })
    if (escrow?.status !== 'COMPLETED') return false
    const completion = await prisma.escrowEvent.findFirst({ where: { escrowId: trade.escrowId, toStatus: 'COMPLETED' }, select: { id: true } })
    if (!completion) return false
    if ((await prisma.dispute.count({ where: { tradeId } })) > 0) return false
    return applyEventProjectionOnce(completion.id, 'payment-account.completed-trade', tradeId, async (tx) => {
      await tx.paymentAccount.update({ where: { id: accountId }, data: { completedTrades: { increment: 1 } } })
    })
  }

  /**
   * The real ramp. A brand-new/never-signed account gets
   * UNSIGNED_TRADE_LIMIT regardless of anything else — signing only
   * happens after a completed trade, so this is the genuine floor for
   * an account nobody has ever transacted with. Any real chargeback
   * caps the account at SIGNED_TRADE_LIMIT permanently — a single
   * reversal is treated as a real, disqualifying signal for the
   * "unlimited" tier, not averaged away by later good trades.
   */
  async getTradeLimit(accountHash: string): Promise<string> {
    const account = await this.getByHash(accountHash)
    return this.computeTradeLimit(account)
  }

  /** Shared by getTradeLimit()/getPublicView() — same ramp, one implementation. */
  private computeTradeLimit(account: { signed: boolean; chargebacks: number; completedTrades: number }): string {
    if (!account.signed) return UNSIGNED_TRADE_LIMIT
    if (account.chargebacks > 0) return SIGNED_TRADE_LIMIT
    if (account.completedTrades >= TRUSTED_TRADE_COUNT) return 'unlimited'
    if (account.completedTrades >= ESTABLISHED_TRADE_COUNT) return ESTABLISHED_TRADE_LIMIT
    return SIGNED_TRADE_LIMIT
  }

  /**
   * Missão 11 Fase 9.3.1 — the ONLY method the unauthenticated GET route
   * may call. See PublicPaymentAccountView's own comment for exactly why
   * each field is/isn't here. One getByHash() fetch (the route previously
   * made two — getByHash() then getTradeLimit(), which itself called
   * getByHash() again for the same row).
   */
  async getPublicView(accountHash: string): Promise<PublicPaymentAccountView> {
    const account = await this.getByHash(accountHash)
    return this.toPublicView(account)
  }

  /**
   * Missão 11 Fase 9.6 — the projection half of getPublicView(), split
   * out so a caller that already has the row in hand (settlement.routes.ts's
   * POST /v1/settlement/payment-accounts, closing the INV-OP-10 gap Fase
   * 9.5's Kimi K3 R2 triage found in that route's existing-hash branch —
   * getOrCreate()'s raw row was being sent straight to any authenticated
   * caller, including ownerId/signedBy/id/moduleId/protocolVersion for an
   * account that isn't theirs) never needs a second fetch just to get the
   * same public shape getPublicView() already computes.
   */
  toPublicView(account: {
    accountHash: string; paymentMethod: string; signed: boolean; signedAt: Date | null
    firstUsedAt: Date; completedTrades: number; chargebacks: number
  }): PublicPaymentAccountView {
    return {
      accountHash: account.accountHash,
      paymentMethod: account.paymentMethod as PaymentMethod,
      signed: account.signed,
      signedAt: account.signedAt,
      firstUsedAt: account.firstUsedAt,
      completedTrades: account.completedTrades,
      chargebacks: account.chargebacks,
      tradeLimit: this.computeTradeLimit(account),
    }
  }
}

export const paymentAccountService = new PaymentAccountService()
