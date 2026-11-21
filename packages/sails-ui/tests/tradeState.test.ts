import { deriveTradeState, type TradeStateInput } from '../src/lib/tradeState'
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
    expect(s.status.label).toBe('Aguardando escrow')
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
    expect(label('refund').status.label).toBe('Reembolso em andamento')
    expect(label('split').status.label).toBe('Divisão em andamento')
    expect(label('unknown').status).toEqual({ label: 'Rodada de assinatura em andamento', tone: 'neutral' })
    for (const k of ['release', 'refund', 'split', 'unknown'] as const) expect(label(k).action.primary).toBeUndefined()
    // A refund round on an expired escrow is never called a release.
    expect(deriveTradeState(input('EXPIRED', SELLER, { signingRoundKind: 'refund' })).status.label).toBe('Reembolso em andamento')
    // The dispute stays the headline while a ruling round exists.
    expect(deriveTradeState(input('DISPUTED', BUYER, { signingRoundKind: 'split' })).status.label).toBe('Em disputa')
  })

  it('chip describes the current state, not the last completed step', () => {
    const s = deriveTradeState(input('PAYMENT_PENDING', BUYER))
    const done = s.steps.filter((x) => x.state === 'done').map((x) => x.label)
    expect(done).not.toContain(s.status.label)
    expect(s.status.label).toBe('Aguardando liberação')
  })

  it('offers Criar Escrow only to the seller and no dispute before an escrow exists', () => {
    expect(deriveTradeState(input(null, SELLER)).action.primary?.action).toBe('createEscrow')
    expect(deriveTradeState(input(null, BUYER)).action.primary).toBeUndefined()
    for (const r of ROLES) expect(deriveTradeState(input(null, r)).action.canDispute).toBe(false)
  })

  it('a cancelled trade without escrow is terminal, and a refund keeps the escrow outcome', () => {
    const c = deriveTradeState(input(null, BUYER, { tradeStatus: 'CANCELLED' }))
    expect(c.status.label).toBe('Cancelado')
    expect(c.action.tone).toBe('terminal')
    expect(deriveTradeState(input('REFUNDED')).status.label).toBe('Reembolsado')
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
