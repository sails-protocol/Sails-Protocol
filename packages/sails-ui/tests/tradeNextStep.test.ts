import { tradeNextStep } from '../src/lib/tradeNextStep'

const SELLER = { isBuyer: false, isSeller: true }
const BUYER = { isBuyer: true, isSeller: false }

describe('trade list next step', () => {
  it('follows Trade.tsx when no escrow exists yet: the seller creates it', () => {
    expect(tradeNextStep(undefined, SELLER)).toEqual({ yourTurn: true, text: 'Sua vez: criar o escrow' })
    expect(tradeNextStep(undefined, BUYER)?.yourTurn).toBe(false)
  })

  it('marks only the party with the primary action as "Sua vez"', () => {
    expect(tradeNextStep('FUNDS_LOCKED', BUYER)).toEqual({ yourTurn: true, text: 'Sua vez: marcar o pagamento como enviado' })
    expect(tradeNextStep('FUNDS_LOCKED', SELLER)).toEqual({ yourTurn: false, text: 'Aguardando o comprador marcar o pagamento como enviado' })
    expect(tradeNextStep('PAYMENT_PENDING', SELLER)?.yourTurn).toBe(true)
    expect(tradeNextStep('DISPUTED', SELLER)?.yourTurn).toBe(false)
  })

  it('shows nothing when the escrow status could not be loaded', () => {
    expect(tradeNextStep(null, SELLER)).toBeNull()
  })
})
