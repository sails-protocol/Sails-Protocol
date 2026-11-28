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
 * `signPaymentAccount()` deliberately reuses D1's narrow-attestation
 * framing (the same reasoning `market-arbitration.provider.ts`'s header
 * comment states for arbiters): the signer is attesting "this specific
 * trade completed without dispute," never "this person is trustworthy."
 */
import { createHash } from 'node:crypto'
import { prisma } from '../../common/database'
import { ForbiddenError, NotFoundError } from '../../common/errors'
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
        data: { ownerId, accountHash, paymentMethod, signed: true, signedBy: activeVouch.voucherId, signedAt: new Date() },
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
   * D5's real attestation — narrow, factual, matches D1's arbiter
   * framing exactly: "I saw this specific trade complete without a
   * chargeback," not a KYC/compliance vouch. Only meaningful on an
   * account's first clean trade (`signed` is a one-way flag); calling
   * this again on an already-signed account is a no-op, not an error —
   * a second attestation adds nothing signing didn't already establish.
   */
  async signPaymentAccount(accountHash: string, signedBy: string) {
    const account = await this.getByHash(accountHash)
    // An attestation is someone else's: an owner never signs their own account.
    if (account.ownerId === signedBy) throw new ForbiddenError('A payment account cannot be signed by its owner')
    if (account.signed) return account
    return prisma.paymentAccount.update({
      where: { accountHash },
      data: { signed: true, signedBy, signedAt: new Date() },
    })
  }

  /** Called on a real completed (non-disputed, non-chargeback) trade using this account. */
  async recordCompletedTrade(accountHash: string) {
    return prisma.paymentAccount.update({
      where: { accountHash },
      data: { completedTrades: { increment: 1 } },
    })
  }

  /** Called when a chargeback/reversal is reported against this account. */
  async recordChargeback(accountHash: string) {
    return prisma.paymentAccount.update({
      where: { accountHash },
      data: { chargebacks: { increment: 1 } },
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
