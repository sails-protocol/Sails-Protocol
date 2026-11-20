import { deriveCurrentAction } from '../src/lib/currentAction'
import type { EscrowStatus } from '../src/types'

const STATUSES: EscrowStatus[] = ['CREATED', 'FUNDS_LOCKED', 'PAYMENT_PENDING', 'COMPLETED', 'DISPUTED', 'REFUNDED', 'EXPIRED', 'SPLIT']
const ROLES = [
  { isBuyer: false, isSeller: true },
  { isBuyer: true, isSeller: false },
  { isBuyer: false, isSeller: false },
]

// The former EscrowActions.tsx gating, verbatim.
function legacy(status: EscrowStatus, isBuyer: boolean, isSeller: boolean) {
  const primary = isSeller && status === 'CREATED' ? 'lock'
    : isBuyer && status === 'FUNDS_LOCKED' ? 'markPaymentSent'
    : isSeller && status === 'PAYMENT_PENDING' ? 'release'
    : undefined
  const isTerminal = status === 'COMPLETED' || status === 'DISPUTED' || status === 'REFUNDED'
  return { primary, canDispute: !isTerminal && (isBuyer || isSeller) }
}

const all = STATUSES.flatMap((status) => ROLES.map((r) => ({ status, ...r, view: deriveCurrentAction({ status, ...r }) })))

describe('current action derivation (CTO 437)', () => {
  it('matches the former EscrowActions gating for every role x status', () => {
    for (const { status, isBuyer, isSeller, view } of all) {
      expect({ primary: view.primary?.action, canDispute: view.canDispute }).toEqual(legacy(status, isBuyer, isSeller))
    }
  })

  it('never claims payment was confirmed or verified', () => {
    for (const { view } of all) {
      const text = `${view.actorLabel} ${view.title} ${view.description} ${view.primary?.label ?? ''}`.toLowerCase()
      expect(text).not.toMatch(/confirm|verificad/)
    }
  })

  it('does not treat EXPIRED as open', () => {
    for (const r of ROLES) {
      const view = deriveCurrentAction({ status: 'EXPIRED', ...r })
      expect(view.primary).toBeUndefined()
      expect(view.tone).not.toBe('action')
      expect(view.tone).not.toBe('waiting')
      expect(view.title).toMatch(/prazo/i)
    }
  })

  it('offers dispute only to trade parties and never after COMPLETED/DISPUTED/REFUNDED', () => {
    for (const s of ['COMPLETED', 'DISPUTED', 'REFUNDED'] as const) {
      for (const r of ROLES) expect(deriveCurrentAction({ status: s, ...r }).canDispute).toBe(false)
    }
    expect(deriveCurrentAction({ status: 'FUNDS_LOCKED', isBuyer: false, isSeller: false }).canDispute).toBe(false)
    expect(deriveCurrentAction({ status: 'FUNDS_LOCKED', isBuyer: true, isSeller: false }).canDispute).toBe(true)
  })

  it('names what is awaited when the viewer has no action', () => {
    expect(deriveCurrentAction({ status: 'CREATED', isBuyer: true, isSeller: false }).title).toBe('Aguardando o vendedor bloquear os fundos')
    expect(deriveCurrentAction({ status: 'FUNDS_LOCKED', isBuyer: false, isSeller: true }).title).toBe('Aguardando o comprador marcar o pagamento como enviado')
    expect(deriveCurrentAction({ status: 'PAYMENT_PENDING', isBuyer: true, isSeller: false }).title).toBe('Aguardando o vendedor liberar')
  })

  it('never offers a release the interface cannot complete (releaseUnavailable)', () => {
    const v = deriveCurrentAction({ status: 'PAYMENT_PENDING', isBuyer: false, isSeller: true, releaseUnavailable: true })
    expect(v.primary).toBeUndefined()
    expect(v.title).toBe('Liberação indisponível nesta interface para este tipo de escrow')
    expect(v.canDispute).toBe(true)
  })

  it('never offers "Liberar" next to a signing round this interface cannot sign (HOLD)', () => {
    for (const r of [{ isBuyer: false, isSeller: true }, { isBuyer: true, isSeller: false }]) {
      const v = deriveCurrentAction({ status: 'PAYMENT_PENDING', ...r, signingUnavailable: true })
      expect(v.tone).toBe('attention')
      expect(v.primary).toBeUndefined()
      expect(v.actorLabel).not.toMatch(/Ação necessária/)
      expect(v.canDispute).toBe(true)
    }
    expect(deriveCurrentAction({ status: 'PAYMENT_PENDING', isBuyer: false, isSeller: true }).primary?.action).toBe('release')
  })
})
