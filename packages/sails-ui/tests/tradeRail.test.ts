import { batonLabel, deriveTradeState, type TradeStateInput } from '../src/lib/tradeState'
import type { EscrowStatus, TradeStatus } from '../src/types'

// Trade rail (trade workspace L4): stages and the bastão come only from record fields.
const B = 'buyer-id', S = 'seller-id', ARB = 'arbiter-id'
const TRADE_FOR: Record<EscrowStatus, TradeStatus> = {
  CREATED: 'ACTIVE', FUNDS_LOCKED: 'ACTIVE', PAYMENT_PENDING: 'ACTIVE', COMPLETED: 'COMPLETED',
  DISPUTED: 'DISPUTED', REFUNDED: 'CANCELLED', SPLIT: 'COMPLETED', EXPIRED: 'ACTIVE',
}
function input(escrowStatus: EscrowStatus | null, patch: Partial<TradeStateInput> = {}): TradeStateInput {
  const locked = escrowStatus !== null && escrowStatus !== 'CREATED'
  return {
    tradeStatus: escrowStatus ? TRADE_FOR[escrowStatus] : 'PENDING', escrowStatus, signingRoundKind: null,
    isBuyer: true, isSeller: false, buyerId: B, sellerId: S, escrowId: escrowStatus ? 'esc-1' : null, escrowType: 'MOCK',
    createdAt: '2026-11-01T09:00:00.000Z', escrowCreatedAt: escrowStatus ? '2026-11-01T09:30:00.000Z' : null,
    lockedAt: locked ? '2026-11-01T10:00:00.000Z' : null, completedAt: null, cancelledAt: null, ...patch,
  }
}
const ids = (i: TradeStateInput) => deriveTradeState(i).steps.map((s) => s.id)
const current = (i: TradeStateInput) => deriveTradeState(i).steps.find((s) => s.state === 'current')
const round = (signed: string[]) => ({ requiredSigners: [S, B], signedBy: signed.map((participantId) => ({ participantId, submittedAt: '2026-11-02T00:00:00.000Z' })) })

describe('trade rail stages', () => {
  it('adds the deposit stage only for MULTISIG, done only once the lock recorded it, with the recorded outpoint', () => {
    expect(ids(input('CREATED'))).not.toContain('deposit')
    const created = input('CREATED', { escrowType: 'MULTISIG' })
    expect(ids(created)).toEqual(['opened', 'escrow', 'deposit', 'locked', 'paymentSent', 'completed'])
    expect(current(created)?.id).toBe('deposit')
    const locked = deriveTradeState(input('FUNDS_LOCKED', { escrowType: 'MULTISIG', txLockId: 'abc', txLockVout: 1 })).steps.find((s) => s.id === 'deposit')
    expect(locked).toMatchObject({ state: 'done', evidence: [{ label: 'Depósito registrado', value: 'abc:1', mono: true }] })
    // No outpoint recorded: no evidence invented.
    expect(deriveTradeState(input('FUNDS_LOCKED', { escrowType: 'MULTISIG' })).steps.find((s) => s.id === 'deposit')?.evidence).toBeUndefined()
  })

  it('adds the signatures stage only while a round exists on PAYMENT_PENDING, as the current stage', () => {
    expect(ids(input('PAYMENT_PENDING'))).not.toContain('signatures')
    // A round kind without the round record is not enough.
    expect(ids(input('PAYMENT_PENDING', { signingRoundKind: 'release' }))).not.toContain('signatures')
    const i = input('PAYMENT_PENDING', { signingRoundKind: 'release', round: round([B]) })
    expect(ids(i)).toEqual(['opened', 'escrow', 'locked', 'paymentSent', 'signatures', 'completed'])
    expect(current(i)).toMatchObject({ id: 'signatures', label: 'Assinaturas da liberação', evidence: [{ label: 'Assinaturas', value: '1 de 2 assinaturas' }] })
  })

  it('counts only required signers that signed', () => {
    const i = input('PAYMENT_PENDING', { signingRoundKind: 'release', round: { requiredSigners: [S, B], signedBy: [{ participantId: 'stranger', submittedAt: '' }] } })
    expect(current(i)?.evidence?.[0].value).toBe('0 de 2 assinaturas')
  })

  it('shows the transaction stage only when txReleaseId is recorded, never as confirmed', () => {
    expect(ids(input('COMPLETED'))).not.toContain('transaction')
    const done = deriveTradeState(input('COMPLETED', { txReleaseId: 'tx-1' })).steps
    expect(done.map((s) => s.id).slice(-2)).toEqual(['completed', 'transaction'])
    expect(done[done.length - 1]).toMatchObject({ state: 'done', label: 'Transação registrada pelo servidor', evidence: [{ value: 'tx-1' }] })
    expect(done[done.length - 1].label).not.toMatch(/confirmad|liquidad|finaliz/i)
    // Refund/split payouts carry the same field, after their outcome.
    expect(ids(input('REFUNDED', { txReleaseId: 'tx-2' })).slice(-2)).toEqual(['outcome', 'transaction'])
    // Not on an open escrow, even if the field were present.
    expect(ids(input('PAYMENT_PENDING', { txReleaseId: 'tx-3' }))).not.toContain('transaction')
  })

  it('puts a round on a disputed or expired escrow as evidence on the outcome, not as a happy-path stage', () => {
    const d = deriveTradeState(input('EXPIRED', { signingRoundKind: 'refund', round: round([]) }))
    expect(d.steps.map((s) => s.id)).not.toContain('signatures')
    expect(d.steps[d.steps.length - 1].evidence).toEqual([{ label: 'Rodada de reembolso', value: '0 de 2 assinaturas' }])
  })

  it('shows the escrow id as evidence only once an escrow exists', () => {
    expect(deriveTradeState(input(null)).steps.find((s) => s.id === 'escrow')?.evidence).toBeUndefined()
    expect(deriveTradeState(input('CREATED')).steps.find((s) => s.id === 'escrow')?.evidence).toEqual([{ label: 'ID do escrow', value: 'esc-1', mono: true }])
  })
})

describe('trade rail actor (bastão)', () => {
  it('follows the escrow gating on the happy path', () => {
    expect(current(input(null))?.actors).toEqual(['seller'])
    expect(current(input('CREATED'))?.actors).toEqual(['seller'])
    expect(current(input('FUNDS_LOCKED'))?.actors).toEqual(['buyer'])
    expect(current(input('PAYMENT_PENDING'))?.actors).toEqual(['seller'])
  })

  it('a round waits on its missing signers, by role', () => {
    expect(current(input('PAYMENT_PENDING', { signingRoundKind: 'release', round: round([B]) }))?.actors).toEqual(['seller'])
    expect(current(input('PAYMENT_PENDING', { signingRoundKind: 'release', round: round([]) }))?.actors).toEqual(['seller', 'buyer'])
    // All signed: the server has to act; no actor is claimed.
    expect(current(input('PAYMENT_PENDING', { signingRoundKind: 'release', round: round([S, B]) }))?.actors).toBeUndefined()
    // An id the trade does not identify stays unknown.
    expect(current(input('PAYMENT_PENDING', { signingRoundKind: 'release', round: { requiredSigners: ['x'], signedBy: [] } }))?.actors).toEqual(['unknown'])
  })

  it('in a dispute: the arbiter while it decides, the parties while a suggestion can be contested, nobody when unknown', () => {
    const disputed = (status: 'OPENED' | 'EVIDENCE_SUBMITTED' | 'AUTO_PROPOSED' | 'RESOLVED' | 'APPEALED', arbiterId: string | null = ARB) => current(input('DISPUTED', { dispute: { status, arbiterId } }))?.actors
    expect(disputed('OPENED')).toEqual(['arbiter'])
    expect(disputed('EVIDENCE_SUBMITTED')).toEqual(['arbiter'])
    expect(disputed('APPEALED')).toEqual(['arbiter'])
    expect(disputed('AUTO_PROPOSED')).toEqual(['parties'])
    expect(disputed('OPENED', null)).toBeUndefined()
    expect(disputed('RESOLVED')).toBeUndefined()
    expect(current(input('DISPUTED'))?.actors).toBeUndefined()
    // A ruling round: the arbiter is mapped from the dispute when it is a required signer.
    expect(current(input('DISPUTED', { signingRoundKind: 'refund', dispute: { status: 'RESOLVED', arbiterId: ARB }, round: { requiredSigners: [ARB, S], signedBy: [] } }))?.actors).toEqual(['arbiter', 'seller'])
  })

  it('has no actor on expired, terminal or cancelled trades', () => {
    expect(current(input('EXPIRED'))?.actors).toBeUndefined()
    for (const s of ['COMPLETED', 'REFUNDED', 'SPLIT'] as const) expect(deriveTradeState(input(s)).steps.some((x) => x.actors)).toBe(false)
    expect(deriveTradeState(input('FUNDS_LOCKED', { tradeStatus: 'CANCELLED' })).steps.some((x) => x.actors)).toBe(false)
  })

  it('only the current stage carries an actor', () => {
    for (const s of ['CREATED', 'FUNDS_LOCKED', 'PAYMENT_PENDING', 'DISPUTED'] as const) {
      const steps = deriveTradeState(input(s, { dispute: { status: 'OPENED', arbiterId: ARB } })).steps
      expect(steps.filter((x) => x.actors).every((x) => x.state === 'current')).toBe(true)
    }
  })

  it('labels the bastão from the viewer side without inventing names', () => {
    expect(batonLabel(undefined, 'buyer')).toBeNull()
    expect(batonLabel([], 'buyer')).toBeNull()
    expect(batonLabel(['buyer'], 'buyer')).toBe('Sua vez')
    expect(batonLabel(['seller', 'buyer'], 'buyer')).toBe('Sua vez')
    expect(batonLabel(['seller'], 'buyer', { seller: 'Bob' })).toBe('Vez de Bob (vendedor)')
    expect(batonLabel(['seller'], 'buyer', { seller: null })).toBe('Vez do vendedor')
    expect(batonLabel(['buyer'], null, { buyer: 'Erin' })).toBe('Vez de Erin (comprador)')
    expect(batonLabel(['arbiter'], 'seller')).toBe('Com o árbitro')
    expect(batonLabel(['parties'], 'seller')).toBe('Partes podem contestar')
    expect(batonLabel(['unknown'], 'seller')).toBe('Vez de participante não identificado')
    expect(batonLabel(['seller', 'buyer'], null)).toBe('Vez do comprador e do vendedor')
    expect(batonLabel(['arbiter', 'seller'], 'buyer')).toBe('Vez de mais de um participante')
  })
})
