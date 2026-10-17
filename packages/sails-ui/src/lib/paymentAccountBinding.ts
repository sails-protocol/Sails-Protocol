/**
 * #235 R7H-E3B — committing the seller's PaymentAccount before any protected escrow exists.
 *
 * Under R7H-E3 an escrow on a governed rail (V1: MULTISIG/BTC) is created only for a trade bound to a payment
 * account the seller owns, whose method is the offer's and is eligible under the policy in force. The server and
 * the database enforce all of it; this module makes the UI collect the right binding up front and say clearly when
 * an offer cannot carry a protected escrow, instead of letting the user reach a refusal at escrow creation.
 *
 * Ownership is never inferred from knowing a key: the account is registered (or re-resolved) through
 * `paymentAccounts.register()`, which returns the full row ONLY to its owner, and the binding proceeds only when
 * that row names the authenticated seller. A foreign, ambiguous or unreachable answer stops the flow.
 *
 * Privacy, stated precisely: the server stores only SHA-256("<method>:<key>"); the raw key never leaves this
 * client except where the user already chose to publish it as the offer's payment details. The hash is unsalted
 * and PIX keys (phone, CPF, e-mail, random key) are low-entropy, so the hash does not keep a known key secret —
 * anyone can recompute it. It identifies an account; it does not hide one.
 */
import { hashPaymentAccount, recommendedEscrowType, type EconomicPolicy, type SailsClient } from '@satsails/p2p-trading-sdk'
import type { AssetType, PaymentMethod } from '@satsails/p2p-trading-sdk'

export type ProtectedEscrowEligibility =
  /** The asset's rail is not under the trade-limit policy (development / test rails): no binding applies. */
  | { governed: false }
  | { governed: true; eligible: true }
  | { governed: true; eligible: false; reason: 'RAIL_NOT_ELIGIBLE' | 'METHOD_NOT_ELIGIBLE'; eligibleMethods: PaymentMethod[] }

/** Whether an offer in `asset` paid by `paymentMethod` can carry a protected escrow, per the policy in force. */
export function protectedEscrowEligibility(policy: EconomicPolicy, asset: AssetType, paymentMethod: PaymentMethod): ProtectedEscrowEligibility {
  const escrowType = recommendedEscrowType(asset)
  const rail = escrowType && policy.rails.find((r) => r.escrowType === escrowType && r.asset === asset)
  if (!rail) return { governed: false }
  const eligibleMethods = policy.paymentMethods.filter((m) => m.eligible).map((m) => m.paymentMethod)
  if (!rail.eligible) return { governed: true, eligible: false, reason: 'RAIL_NOT_ELIGIBLE', eligibleMethods: [] }
  return eligibleMethods.includes(paymentMethod)
    ? { governed: true, eligible: true }
    : { governed: true, eligible: false, reason: 'METHOD_NOT_ELIGIBLE', eligibleMethods }
}

export class PaymentAccountBindingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PaymentAccountBindingError'
  }
}

/**
 * Registers or re-resolves the seller's receiving account and proves it is theirs. Returns the hash to bind
 * (`liquidity.publish({ paymentAccountHash })` for a SELL offer, `openp2p.trade(…, paymentAccountHash)` when the
 * taker of a BUY offer is the seller). Idempotent: repeating it never creates a second account.
 */
export async function bindSellerPaymentAccount(
  client: Pick<SailsClient, 'paymentAccounts'>,
  sellerId: string,
  paymentMethod: PaymentMethod,
  rawIdentifier: string,
): Promise<{ accountHash: string }> {
  const identifier = rawIdentifier.trim()
  if (!identifier) throw new PaymentAccountBindingError('Informe a sua chave de recebimento.')
  const accountHash = hashPaymentAccount(paymentMethod, identifier)
  const account = await client.paymentAccounts.register(accountHash, paymentMethod)
  // The owner's row carries ownerId; anyone else gets the public view without it.
  const owned = 'ownerId' in account && account.ownerId === sellerId && account.accountHash === accountHash && account.paymentMethod === paymentMethod
  if (!owned) {
    throw new PaymentAccountBindingError('Esta chave já está registrada por outro participante. Use uma chave de recebimento que seja sua.')
  }
  return { accountHash }
}

const UNBOUND_TRADE_MESSAGE =
  'Este trade foi criado sem uma conta de recebimento do vendedor vinculada (antes desta regra) e não pode receber escrow protegido. Inicie um novo trade a partir da oferta.'
const NOT_ELIGIBLE_MESSAGE = 'O método de pagamento deste trade não é aceito para escrow protegido pela política vigente.'

/**
 * Why the seller cannot create a protected escrow for a trade, when that is already known from the policy and the
 * trade itself (null: nothing known — the server still decides, and its refusal is mapped below).
 */
export function protectedEscrowBlocker(eligibility: ProtectedEscrowEligibility | null, sellerPaymentAccountId: string | null | undefined): string | null {
  if (!eligibility?.governed) return null
  if (!eligibility.eligible) return NOT_ELIGIBLE_MESSAGE
  return sellerPaymentAccountId ? null : UNBOUND_TRADE_MESSAGE
}

/**
 * #235 R7H-E3C — a SELL offer on a governed rail whose seller never committed a receiving account admits no new
 * trade (the server refuses it); a client says so instead of offering a button that can only fail.
 */
export function unboundSellOfferBlocked(eligibility: ProtectedEscrowEligibility | null, side: 'BUY' | 'SELL', paymentAccountBound: boolean): boolean {
  return side === 'SELL' && eligibility?.governed === true && !paymentAccountBound
}

/** A trade-admission refusal (TRADE_ADMISSION_REFUSED) from the same binding, said in terms a trader can act on (null: not one). */
export function tradeAdmissionRefusalMessage(err: unknown): string | null {
  const message = err instanceof Error ? err.message : ''
  const code = /^Trade refused by the economic authorization binding — ([A-Z_]+):/.exec(message)?.[1]
  switch (code) {
    case 'UNBOUND_ACCOUNT':
      return 'Esta oferta não tem uma conta de recebimento do vendedor vinculada e não pode ser negociada com escrow protegido.'
    case 'METHOD_NOT_ELIGIBLE':
    case 'RAIL_NOT_ELIGIBLE':
      return 'O método de pagamento desta oferta não é aceito para escrow protegido pela política vigente.'
    case 'FOREIGN_ACCOUNT':
    case 'METHOD_MISMATCH':
    case 'SELLER_NOT_COMMITTED':
      return 'A conta de recebimento informada não pertence ao vendedor ou não corresponde ao método da oferta.'
    default:
      return null
  }
}

/** An escrow refusal from the R7H-E3 binding, said in terms a seller can act on (null: not a binding refusal). */
export function escrowBindingRefusalMessage(err: unknown): string | null {
  const message = err instanceof Error ? err.message : ''
  const code = /^Escrow refused by the economic authorization binding — ([A-Z_]+):/.exec(message)?.[1]
  switch (code) {
    case 'UNBOUND_ACCOUNT':
      return UNBOUND_TRADE_MESSAGE
    case 'METHOD_NOT_ELIGIBLE':
    case 'RAIL_NOT_ELIGIBLE':
      return NOT_ELIGIBLE_MESSAGE
    case 'FOREIGN_ACCOUNT':
    case 'METHOD_MISMATCH':
    case 'SELLER_NOT_COMMITTED':
      return 'A conta de recebimento vinculada a este trade não corresponde ao vendedor ou ao método do anúncio. O escrow protegido foi recusado.'
    default:
      return null
  }
}
