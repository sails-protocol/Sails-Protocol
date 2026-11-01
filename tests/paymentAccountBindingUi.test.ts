// tests/paymentAccountBindingUi.test.ts
//
// #235 R7H-E3B — the branches of packages/sails-ui/src/lib/paymentAccountBinding.ts that the real-PostgreSQL
// journeys (tests/integration/sellerPaymentAccountJourney.test.ts) cannot reach under policy V1: a governed rail
// the policy in force no longer lists, refusal codes that are not binding refusals, and inputs refused before
// any request is made. The policy documents here are shaped exactly as GET /v1/settlement/economic-policy returns.

import type { EconomicPolicy } from '../packages/sails-sdk/src/index'
import {
  PaymentAccountBindingError,
  bindSellerPaymentAccount,
  escrowBindingRefusalMessage,
  protectedEscrowBlocker,
  protectedEscrowEligibility,
  tradeAdmissionRefusalMessage,
  unboundSellOfferBlocked,
} from '../packages/sails-ui/src/lib/paymentAccountBinding'

const policy = (railEligible: boolean, methods: EconomicPolicy['paymentMethods']): EconomicPolicy => ({
  version: 2, label: 'test', rails: [{ escrowType: 'MULTISIG', asset: 'BTC', eligible: railEligible }], paymentMethods: methods,
})

describe('#235 R7H-E3B — UI payment-account binding helpers', () => {
  it('a governed rail absent from the version in force blocks every method; an ungoverned asset is not under the policy', () => {
    const p = policy(false, [{ paymentMethod: 'PIX', eligible: true }])
    expect(protectedEscrowEligibility(p, 'BTC', 'PIX')).toEqual({ governed: true, eligible: false, reason: 'RAIL_NOT_ELIGIBLE', eligibleMethods: [] })
    expect(protectedEscrowEligibility(p, 'USDT_ERC20', 'PIX')).toEqual({ governed: false })
    expect(protectedEscrowEligibility(policy(true, [{ paymentMethod: 'PIX', eligible: false }]), 'BTC', 'PIX'))
      .toEqual({ governed: true, eligible: false, reason: 'METHOD_NOT_ELIGIBLE', eligibleMethods: [] })
  })

  it('the Trade page notice: nothing for ungoverned or bound trades, the legacy notice for an unbound one', () => {
    const ok = protectedEscrowEligibility(policy(true, [{ paymentMethod: 'PIX', eligible: true }]), 'BTC', 'PIX')
    expect(protectedEscrowBlocker({ governed: false }, null)).toBeNull()
    expect(protectedEscrowBlocker(null, null)).toBeNull()
    expect(protectedEscrowBlocker(ok, 'acct-1')).toBeNull()
    expect(protectedEscrowBlocker(ok, null)).toMatch(/sem uma conta de recebimento/)
    expect(protectedEscrowBlocker(ok, undefined)).toMatch(/sem uma conta de recebimento/)
  })

  it('only E3 binding refusals are rewritten; anything else keeps its own message', () => {
    const refusal = (code: string) => new Error(`Escrow refused by the economic authorization binding — ${code}: detail`)
    for (const code of ['UNBOUND_ACCOUNT', 'METHOD_NOT_ELIGIBLE', 'RAIL_NOT_ELIGIBLE', 'FOREIGN_ACCOUNT', 'METHOD_MISMATCH', 'SELLER_NOT_COMMITTED']) {
      expect(escrowBindingRefusalMessage(refusal(code))).toEqual(expect.any(String))
    }
    expect(escrowBindingRefusalMessage(refusal('TRADE_MISSING'))).toBeNull()
    expect(escrowBindingRefusalMessage(new Error('Only the seller can create the escrow'))).toBeNull()
    expect(escrowBindingRefusalMessage('not an error')).toBeNull()
  })

  it('an empty key is refused before any request; an answer without the caller\'s ownership is never accepted', async () => {
    const register = jest.fn()
    await expect(bindSellerPaymentAccount({ paymentAccounts: { register } } as any, 'u1', 'PIX', '   ')).rejects.toThrow(PaymentAccountBindingError)
    expect(register).not.toHaveBeenCalled()
    // The public view (another owner), a row for a different method or hash: all refused.
    const answers = [
      { accountHash: 'h', paymentMethod: 'PIX', signed: false },
      { ownerId: 'u2', accountHash: 'h', paymentMethod: 'PIX' },
    ]
    for (const answer of answers) {
      register.mockResolvedValueOnce(answer)
      await expect(bindSellerPaymentAccount({ paymentAccounts: { register } } as any, 'u1', 'PIX', 'key')).rejects.toThrow(PaymentAccountBindingError)
    }
    register.mockImplementationOnce(async (hash: string) => ({ ownerId: 'u1', accountHash: hash, paymentMethod: 'TED' }))
    await expect(bindSellerPaymentAccount({ paymentAccounts: { register } } as any, 'u1', 'PIX', 'key')).rejects.toThrow(PaymentAccountBindingError)
    register.mockImplementationOnce(async () => ({ ownerId: 'u1', accountHash: 'other', paymentMethod: 'PIX' }))
    await expect(bindSellerPaymentAccount({ paymentAccounts: { register } } as any, 'u1', 'PIX', 'key')).rejects.toThrow(PaymentAccountBindingError)
  })

  it('#235 R7H-E3C — a governed SELL offer without a committed account is shown as non-executable; BUY offers and ungoverned rails are not', () => {
    const governed = protectedEscrowEligibility(policy(true, [{ paymentMethod: 'PIX', eligible: true }]), 'BTC', 'PIX')
    expect(unboundSellOfferBlocked(governed, 'SELL', false)).toBe(true)
    expect(unboundSellOfferBlocked(governed, 'SELL', true)).toBe(false)
    expect(unboundSellOfferBlocked(governed, 'BUY', false)).toBe(false) // the taker binds on a BUY offer
    expect(unboundSellOfferBlocked({ governed: false }, 'SELL', false)).toBe(false)
    expect(unboundSellOfferBlocked(null, 'SELL', false)).toBe(false)
  })

  it('#235 R7H-E3C — only trade-admission refusals are rewritten, never an escrow refusal or another error', () => {
    const admission = (code: string) => new Error(`Trade refused by the economic authorization binding — ${code}: detail`)
    expect(tradeAdmissionRefusalMessage(admission('UNBOUND_ACCOUNT'))).toMatch(/não tem uma conta de recebimento/)
    expect(tradeAdmissionRefusalMessage(admission('METHOD_NOT_ELIGIBLE'))).toMatch(/não é aceito/)
    expect(tradeAdmissionRefusalMessage(admission('FOREIGN_ACCOUNT'))).toEqual(expect.any(String))
    expect(tradeAdmissionRefusalMessage(new Error('Escrow refused by the economic authorization binding — UNBOUND_ACCOUNT: x'))).toBeNull()
    expect(escrowBindingRefusalMessage(admission('UNBOUND_ACCOUNT'))).toBeNull()
    expect(tradeAdmissionRefusalMessage(new Error('Offer x is not active'))).toBeNull()
  })
})
