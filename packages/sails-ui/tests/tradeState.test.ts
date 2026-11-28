import { canCancelTrade, deriveTradeState, ESCROW_STATE_LABEL, type TradeStateInput } from '../src/lib/tradeState'
import { deriveCurrentAction } from '../src/lib/currentAction'
import type { EscrowStatus, TradeStatus } from '../src/types'

const BUYER = { isBuyer: true, isSeller: false }
const SELLER = { isBuyer: false, isSeller: true }
const OTHER = { isBuyer: false, isSeller: false }
const ROLES = [BUYER, SELLER, OTHER]
const STATUSES: EscrowStatus[] = ['CREATED', 'FUNDS_LOCKED', 'PAYMENT_PENDING', 'COMPLETED', 'DISPUTED', 'REFUNDED', 'EXPIRED', 'SPLIT']
// Same Escrow -> Trade projection the server applies (trade-repository.ts).
const TRADE_FOR: Record<EscrowStatus, TradeStatus> = {
  CREATED: 'ACTIVE', FUNDS_LOCKED: 'ACTIVE', PAYMENT_PENDING: 'ACTIVE', COMPLETED: 'COMPLETED',
  DISPUTED: 'DISPUTED', REFUNDED: 'CANCELLED', SPLIT: 'COMPLETED', EXPIRED: 'ACTIVE',
}
const LOCKED_AT = '2026-11-01T10:00:00.000Z'

function input(escrowStatus: EscrowStatus | null, role = BUYER, patch: Partial<TradeStateInput> = {}): TradeStateInput {
  const locked = escrowStatus !== null && escrowStatus !== 'CREATED'
  return {
    tradeStatus: escrowStatus ? TRADE_FOR[escrowStatus] : 'PENDING',
    escrowStatus, signingRoundKind: null, ...role,
    createdAt: '2026-11-01T09:00:00.000Z', escrowCreatedAt: escrowStatus ? '2026-11-01T09:30:00.000Z' : null,
    lockedAt: locked ? LOCKED_AT : null, completedAt: null, cancelledAt: null, ...patch,
  }
}
const stepIds = (s: ReturnType<typeof deriveTradeState>, state: string) => s.steps.filter((x) => x.state === state).map((x) => x.id)

describe('trade state derivation (single source for chip, timeline, action)', () => {
  it('keeps the action gating identical to deriveCurrentAction for every escrow status x role', () => {
    for (const status of STATUSES) for (const r of ROLES) {
      expect(deriveTradeState(input(status, r)).action).toEqual(deriveCurrentAction({ status, ...r }))
    }
  })

  it('never marks the escrow step done before an escrow exists', () => {
    const s = deriveTradeState(input(null, BUYER))
    expect(stepIds(s, 'done')).toEqual(['opened'])
    expect(s.steps.find((x) => x.id === 'escrow')?.state).toBe('current')
    expect(s.status.label).toBe('Escrow ainda não criado')
  })

  it('marks the lock step done (not current) once funds are recorded as locked', () => {
    const s = deriveTradeState(input('FUNDS_LOCKED'))
    expect(stepIds(s, 'done')).toEqual(['opened', 'escrow', 'locked'])
    expect(stepIds(s, 'current')).toEqual(['paymentSent'])
    expect(s.steps.find((x) => x.id === 'locked')?.at).toBe(LOCKED_AT)
  })

  it('checks every step on completion and the chip agrees, even if the trade record lags', () => {
    const s = deriveTradeState(input('COMPLETED', SELLER, { tradeStatus: 'ACTIVE', completedAt: '2026-11-02T00:00:00.000Z' }))
    expect(s.steps.every((x) => x.state === 'done')).toBe(true)
    expect(s.status).toEqual({ label: 'Escrow marcado como concluído', tone: 'neutral' })
    expect(s.action.tone).toBe('terminal')
  })

  it('has exactly one current step on the happy path and none once terminal', () => {
    for (const status of ['CREATED', 'FUNDS_LOCKED', 'PAYMENT_PENDING'] as const) {
      expect(stepIds(deriveTradeState(input(status)), 'current')).toHaveLength(1)
    }
    expect(stepIds(deriveTradeState(input(null)), 'current')).toHaveLength(1)
  })

  it('never shows a per-transition time the records do not carry', () => {
    const s = deriveTradeState(input('PAYMENT_PENDING'))
    expect(s.steps.find((x) => x.id === 'paymentSent')?.at).toBeUndefined()
    expect(s.steps.find((x) => x.id === 'completed')?.at).toBeNull()
  })

  it('on a dispute keeps only proven steps (payment-sent is not recorded) and ends in the dispute', () => {
    const s = deriveTradeState(input('DISPUTED'))
    expect(s.steps.map((x) => x.id)).toEqual(['opened', 'escrow', 'locked', 'outcome'])
    expect(s.steps[s.steps.length - 1]).toMatchObject({ label: 'Em disputa', state: 'current', tone: 'danger' })
    expect(s.status.tone).toBe('danger')
  })

  it('labels a signing round only from its real kind and removes the primary action', () => {
    const label = (kind: 'release' | 'refund' | 'split' | 'unknown') => deriveTradeState(input('PAYMENT_PENDING', SELLER, { signingRoundKind: kind }))
    expect(label('release').status.label).toBe('Liberação em andamento')
    expect(label('refund').status.label).toBe('Devolução em andamento')
    expect(label('split').status.label).toBe('Divisão em andamento')
    expect(label('unknown').status).toEqual({ label: 'Rodada de assinatura em andamento', tone: 'neutral' })
    for (const k of ['release', 'refund', 'split', 'unknown'] as const) expect(label(k).action.primary).toBeUndefined()
    // A refund round on an expired escrow is never called a release.
    expect(deriveTradeState(input('EXPIRED', SELLER, { signingRoundKind: 'refund' })).status.label).toBe('Devolução em andamento')
    // The dispute stays the headline while a ruling round exists.
    expect(deriveTradeState(input('DISPUTED', BUYER, { signingRoundKind: 'split' })).status.label).toBe('Em disputa')
  })

  it('gives each recorded escrow state one name: chip, timeline and the specs/dialog label agree', () => {
    for (const status of STATUSES) for (const r of ROLES) {
      const s = deriveTradeState(input(status, r))
      expect(s.status.label).toBe(ESCROW_STATE_LABEL[status])
      // The timeline step that records this state carries the same words.
      expect(s.steps.map((x) => x.label)).toContain(ESCROW_STATE_LABEL[status])
    }
    // On the happy path the chip is the last step recorded as done.
    const s = deriveTradeState(input('PAYMENT_PENDING', BUYER))
    expect(s.steps.filter((x) => x.state === 'done').pop()?.label).toBe(s.status.label)
  })

  it('a resolved dispute that can be appealed never says nothing is left to do', () => {
    for (const status of ['COMPLETED', 'REFUNDED', 'SPLIT'] as const) {
      const a = deriveTradeState(input(status, BUYER, { appealAvailable: true })).action
      expect(a.tone).toBe('terminal')
      expect(a.description).not.toMatch(/não há mais ações/i)
      expect(a.description).toMatch(/contestar a decisão/i)
    }
    expect(deriveTradeState(input('COMPLETED', BUYER)).action.description).toMatch(/não há mais ações/i)
    // Only terminal cards change: an open trade keeps its action.
    expect(deriveTradeState(input('FUNDS_LOCKED', BUYER, { appealAvailable: true })).action.primary?.action).toBe('markPaymentSent')
  })

  it('is open only while the normal trade steps can still happen', () => {
    expect(deriveTradeState(input(null)).open).toBe(true)
    for (const status of ['CREATED', 'FUNDS_LOCKED', 'PAYMENT_PENDING'] as const) expect(deriveTradeState(input(status)).open).toBe(true)
    for (const status of ['COMPLETED', 'DISPUTED', 'REFUNDED', 'SPLIT', 'EXPIRED'] as const) expect(deriveTradeState(input(status)).open).toBe(false)
    expect(deriveTradeState(input('FUNDS_LOCKED', BUYER, { tradeStatus: 'CANCELLED' })).open).toBe(false)
  })

  it('offers Criar Escrow only to the seller and no dispute before an escrow exists', () => {
    expect(deriveTradeState(input(null, SELLER)).action.primary?.action).toBe('createEscrow')
    expect(deriveTradeState(input(null, BUYER)).action.primary).toBeUndefined()
    for (const r of ROLES) expect(deriveTradeState(input(null, r)).action.canDispute).toBe(false)
  })

  it('D7: the buyer waits for the seller to create the escrow and is told why', () => {
    const a = deriveTradeState(input(null, BUYER)).action
    expect(a.tone).toBe('waiting')
    expect(a.title).toBe('Aguardando o vendedor criar o escrow')
    expect(a.description).toMatch(/^Neste protocolo, quem vende cria o escrow\. /)
  })

  it('a cancelled trade without escrow is terminal, and a refund keeps the escrow outcome', () => {
    const c = deriveTradeState(input(null, BUYER, { tradeStatus: 'CANCELLED' }))
    expect(c.status.label).toBe('Trade cancelado')
    expect(c.action.tone).toBe('terminal')
    expect(deriveTradeState(input('REFUNDED')).status.label).toBe('Escrow marcado como devolvido ao vendedor')
  })

  it('gates the buyer payment instructions on the recorded lock; the seller always sees their own', () => {
    expect(deriveTradeState(input(null, BUYER)).instructions).toBe('hidden')
    expect(deriveTradeState(input('CREATED', BUYER)).instructions).toBe('hidden')
    expect(deriveTradeState(input('FUNDS_LOCKED', BUYER)).instructions).toBe('active')
    expect(deriveTradeState(input('PAYMENT_PENDING', BUYER)).instructions).toBe('active')
    expect(deriveTradeState(input('DISPUTED', BUYER)).instructions).toBe('inactive')
    expect(deriveTradeState(input('COMPLETED', BUYER)).instructions).toBe('inactive')
    // Disputed straight from CREATED: never unlocked, stays hidden.
    expect(deriveTradeState(input('DISPUTED', BUYER, { lockedAt: null })).instructions).toBe('hidden')
    expect(deriveTradeState(input('CREATED', SELLER)).instructions).toBe('active')
    expect(deriveTradeState(input('COMPLETED', SELLER)).instructions).toBe('inactive')
  })

  it('asks the buyer for a payout address only while release can still happen', () => {
    expect(deriveTradeState(input('FUNDS_LOCKED', BUYER, { payoutAddressMissing: true })).payoutStep).toBe('missing')
    expect(deriveTradeState(input(null, BUYER, { payoutAddressMissing: true })).payoutStep).toBe('missing')
    expect(deriveTradeState(input('FUNDS_LOCKED', BUYER, { payoutAddressMissing: false })).payoutStep).toBeNull()
    expect(deriveTradeState(input('FUNDS_LOCKED', SELLER, { payoutAddressMissing: true })).payoutStep).toBeNull()
    expect(deriveTradeState(input('COMPLETED', BUYER, { payoutAddressMissing: true })).payoutStep).toBeNull()
    expect(deriveTradeState(input('DISPUTED', BUYER, { payoutAddressMissing: true })).payoutStep).toBeNull()
  })

  it('a failed address check never prompts to register; it reports the check failed', () => {
    expect(deriveTradeState(input('FUNDS_LOCKED', BUYER, { payoutAddressCheckFailed: true })).payoutStep).toBe('checkFailed')
    expect(deriveTradeState(input('FUNDS_LOCKED', BUYER, { payoutAddressCheckFailed: true, payoutAddressMissing: true })).payoutStep).toBe('checkFailed')
    expect(deriveTradeState(input('COMPLETED', BUYER, { payoutAddressCheckFailed: true })).payoutStep).toBeNull()
  })

  it('never claims payment was verified or that release settled', () => {
    for (const status of STATUSES) for (const r of ROLES) {
      const s = deriveTradeState(input(status, r))
      const text = [s.status.label, ...s.steps.map((x) => x.label)].join(' ').toLowerCase()
      expect(text).not.toMatch(/verificad|confirmad|liquidad|garant/)
      // No bare "Concluído" chip and no success (financial) framing for any status.
      expect(s.status.label).not.toMatch(/^conclu[ií]do$/i)
      expect(s.status.tone).not.toBe('success')
    }
  })
})

describe('canCancelTrade (Principal 8f80d4b6: trade cancel only before any escrow exists)', () => {
  const TRADE_STATUSES: TradeStatus[] = ['PENDING', 'ACTIVE', 'COMPLETED', 'DISPUTED', 'CANCELLED']
  it('buyer or seller, trade PENDING/ACTIVE, no escrow: true', () => {
    for (const r of [BUYER, SELLER]) for (const tradeStatus of ['PENDING', 'ACTIVE'] as const) {
      expect(canCancelTrade({ tradeStatus, hasEscrow: false, ...r })).toBe(true)
    }
  })
  it('never once an escrow exists, for any role, escrow status or trade status', () => {
    for (const r of ROLES) for (const status of STATUSES) for (const tradeStatus of [...TRADE_STATUSES, TRADE_FOR[status]]) {
      expect(canCancelTrade({ tradeStatus, hasEscrow: true, ...r })).toBe(false)
    }
  })
  it('never on a closed trade or for a non-party', () => {
    for (const r of [BUYER, SELLER]) for (const tradeStatus of ['COMPLETED', 'DISPUTED', 'CANCELLED'] as const) {
      expect(canCancelTrade({ tradeStatus, hasEscrow: false, ...r })).toBe(false)
    }
    for (const tradeStatus of TRADE_STATUSES) expect(canCancelTrade({ tradeStatus, hasEscrow: false, ...OTHER })).toBe(false)
  })
})

describe('seller refund round with funds locked ("Cancelar e devolver", MULTISIG)', () => {
  const round = { requiredSigners: ['b'], signedBy: [] }
  const refund = (role: typeof BUYER) => deriveTradeState(input('FUNDS_LOCKED', role, { signingRoundKind: 'refund', round, buyerId: 'b', sellerId: 's', escrowType: 'MULTISIG' }))

  it('shows signatures then an upcoming "Devolvido" stage, waiting on the buyer, never the payment step', () => {
    const s = refund(SELLER)
    expect(s.steps.map((x) => x.id)).toEqual(['opened', 'escrow', 'deposit', 'locked', 'signatures', 'outcome'])
    expect(stepIds(s, 'current')).toEqual(['signatures'])
    expect(s.steps.find((x) => x.id === 'outcome')?.state).toBe('upcoming')
    expect(s.steps.find((x) => x.id === 'signatures')?.actors).toEqual(['buyer'])
  })

  it('says only that the refund started (no "Devolvido" before REFUNDED), with no primary action', () => {
    const seller = refund(SELLER).action
    expect(seller.title).toBe('Devolução iniciada')
    expect(seller.description).toMatch(/aguardando a assinatura do comprador/)
    expect(seller.primary).toBeUndefined()
    expect(refund(BUYER).action.description).toMatch(/depende da sua assinatura/)
  })
})

describe('"Abrir disputa" once a dispute exists', () => {
  it('is gone after a ruling, whatever the escrow outcome', () => {
    const dispute = { status: 'RESOLVED' as const, arbiterId: 'a' }
    for (const status of ['SPLIT', 'COMPLETED', 'REFUNDED'] as const) {
      for (const r of ROLES) expect(deriveTradeState(input(status, r, { dispute })).action.canDispute).toBe(false)
    }
  })
})
