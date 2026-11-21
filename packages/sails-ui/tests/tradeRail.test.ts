import { batonLabel, custodyModelLabel, deriveTradeState, escrowDeadlinePassed, payoutTxLabel, stageTone, type StepActor, type TradeStateInput } from '../src/lib/tradeState'
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
const NOW = Date.parse('2026-11-20T12:00:00.000Z')
const FUTURE = '2026-11-21T12:00:00.000Z', PAST = '2026-11-19T12:00:00.000Z'
const round = (signed: string[]) => ({ requiredSigners: [S, B], signedBy: signed.map((participantId) => ({ participantId, submittedAt: '2026-11-02T00:00:00.000Z' })) })

describe('trade rail stages', () => {
  it('adds the deposit stage only for MULTISIG, done only once the lock recorded it, with the recorded outpoint', () => {
    expect(ids(input('CREATED'))).not.toContain('deposit')
    const created = input('CREATED', { escrowType: 'MULTISIG' })
    expect(ids(created)).toEqual(['opened', 'escrow', 'deposit', 'locked', 'paymentSent', 'completed'])
    expect(current(created)?.id).toBe('deposit')
    const locked = deriveTradeState(input('FUNDS_LOCKED', { escrowType: 'MULTISIG', txLockId: 'abc', txLockVout: 1 })).steps.find((s) => s.id === 'deposit')
    expect(locked).toMatchObject({ state: 'done', evidence: [{ label: 'Saída registrada', value: 'abc:1', mono: true }] })
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
    expect(done[done.length - 1]).toMatchObject({ state: 'done', label: 'Transação de pagamento registrada pelo nó Sails', evidence: [{ value: 'tx-1' }] })
    expect(payoutTxLabel()).toBe('Transação de pagamento registrada pelo nó Sails')
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
    const disputed = (status: 'OPENED' | 'EVIDENCE_SUBMITTED' | 'AUTO_PROPOSED' | 'RESOLVED' | 'APPEALED', arbiterId: string | null = ARB) => current(input('DISPUTED', { now: NOW, dispute: { status, arbiterId, autoResolutionDeadline: FUTURE } }))?.actors
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
    const t = (actors: StepActor[] | undefined, viewer: 'buyer' | 'seller' | null, names = {}) => batonLabel(actors ? { actors } : undefined, viewer, names)
    expect(t(undefined, 'buyer')).toBeNull()
    expect(t([], 'buyer')).toBeNull()
    expect(t(['buyer'], 'buyer')).toEqual({ text: 'Sua vez', tone: 'brand' })
    expect(t(['seller', 'buyer'], 'buyer')?.text).toBe('Sua vez')
    expect(t(['seller'], 'buyer', { seller: 'Bob' })?.text).toBe('Vez de Bob (vendedor)')
    expect(t(['seller'], 'buyer', { seller: null })?.text).toBe('Vez do vendedor')
    expect(t(['buyer'], null, { buyer: 'Erin' })?.text).toBe('Vez de Erin (comprador)')
    expect(t(['arbiter'], 'seller')?.text).toBe('Com o árbitro')
    expect(t(['parties'], 'seller')?.text).toBe('Partes podem contestar até o prazo')
    expect(t(['unknown'], 'seller')?.text).toBe('Vez de participante não identificado')
    expect(t(['seller', 'buyer'], null)?.text).toBe('Vez do comprador e do vendedor')
    expect(t(['arbiter', 'seller'], 'buyer')?.text).toBe('Vez de mais de um participante')
  })
})

describe('trade rail: actions this interface cannot do (truth audit fixes)', () => {
  const holdRound = (patch: Partial<TradeStateInput> = {}) => input('PAYMENT_PENDING', { isBuyer: false, isSeller: true, signingRoundKind: 'release', round: round([B]), signingUnavailable: true, ...patch })

  it('never says Sua vez for a signing round this interface cannot sign (HOLD, mismatch, unsupported, disputed)', () => {
    const step = current(holdRound())
    expect(step).toMatchObject({ id: 'signatures', actors: ['seller'], blocked: 'signing' })
    expect(batonLabel(step, 'seller')).toEqual({ text: 'Assinatura indisponível aqui', tone: 'neutral' })
    // The other side is a plain wait, not "Vez de", and neutral.
    expect(batonLabel(step, 'buyer', { seller: 'Erin' })).toEqual({ text: 'Aguardando Erin (vendedor)', tone: 'neutral' })
    // A signable round keeps the brand baton.
    const ok = current(holdRound({ signingUnavailable: false }))
    expect(ok?.blocked).toBeUndefined()
    expect(batonLabel(ok, 'seller')).toEqual({ text: 'Sua vez', tone: 'brand' })
  })

  it('a ruling round on a disputed escrow is blocked when signing is unavailable', () => {
    const step = current(input('DISPUTED', { signingRoundKind: 'refund', signingUnavailable: true, dispute: { status: 'RESOLVED', arbiterId: ARB }, round: { requiredSigners: [S], signedBy: [] } }))
    expect(step).toMatchObject({ id: 'outcome', actors: ['seller'], blocked: 'signing' })
    expect(batonLabel(step, 'buyer')).toEqual({ text: 'Aguardando o vendedor', tone: 'neutral' })
  })

  it('never names the seller as able to release when release is unavailable for the escrow type', () => {
    const step = current(input('PAYMENT_PENDING', { isBuyer: false, isSeller: true, releaseUnavailable: true }))
    expect(step).toMatchObject({ id: 'completed', actors: ['seller'], blocked: 'release' })
    expect(batonLabel(step, 'seller')).toEqual({ text: 'Liberação indisponível aqui', tone: 'neutral' })
    expect(batonLabel(step, 'buyer', { seller: 'Bob' })).toEqual({ text: 'Aguardando Bob (vendedor)', tone: 'neutral' })
    expect(current(input('PAYMENT_PENDING'))?.blocked).toBeUndefined()
  })

  it('attaches round actors only on the signatures or outcome stage; otherwise the escrow status decides', () => {
    // A round reported while the escrow is CREATED or FUNDS_LOCKED is not a rail stage there.
    const created = current(input('CREATED', { signingRoundKind: 'release', round: round([]) }))
    expect(created).toMatchObject({ id: 'locked', actors: ['seller'] })
    expect(created?.blocked).toBeUndefined()
    const locked = current(input('FUNDS_LOCKED', { signingRoundKind: 'release', round: round([]), signingUnavailable: true }))
    expect(locked).toMatchObject({ id: 'paymentSent', actors: ['buyer'] })
    expect(locked?.blocked).toBeUndefined()
  })

  it('AUTO_PROPOSED names the parties only before the deadline', () => {
    const at = (deadline: string | null) => current(input('DISPUTED', { now: NOW, dispute: { status: 'AUTO_PROPOSED', arbiterId: ARB, autoResolutionDeadline: deadline } }))?.actors
    expect(at(FUTURE)).toEqual(['parties'])
    expect(at(PAST)).toBeUndefined()
    expect(at(null)).toBeUndefined()
    expect(at('not-a-date')).toBeUndefined()
  })

  it('labels the deposit stage as recorded at the escrow address', () => {
    expect(deriveTradeState(input('CREATED', { escrowType: 'MULTISIG' })).steps.find((s) => s.id === 'deposit')?.label).toBe('Depósito registrado no endereço do escrow')
  })

  it('maps declared custody models to words and anything else to not declared', () => {
    expect(custodyModelLabel('client-held-buyer-seller-keys-server-held-arbiter')).toBe('Comprador e vendedor guardam as próprias chaves. A chave que o árbitro usa para movimentar os fundos numa disputa fica com o nó Sails')
    expect(custodyModelLabel('server-custodial-reference-implementation')).toMatch(/^Custódia do nó Sails/)
    expect(custodyModelLabel('client-held-buyer-seller-keys-server-held-kms-arbiter')).toMatch(/KMS/)
    for (const v of [null, undefined, '', 'something-new', 'toString']) expect(custodyModelLabel(v)).toBe('Não declarado pelo provedor')
  })
})

describe('trade rail colors (DECISIONS.md: O avanço do trade tem cor)', () => {
  const tones = (i: TradeStateInput, viewer: 'buyer' | 'seller' | null) => deriveTradeState(i).steps.map((s) => stageTone(s, viewer))

  it("done is blue, the viewer's actionable stage is yours, the other side waits, the rest is upcoming", () => {
    // FUNDS_LOCKED: the buyer marks the payment.
    expect(tones(input('FUNDS_LOCKED'), 'buyer')).toEqual(['done', 'done', 'done', 'yours', 'upcoming'])
    expect(tones(input('FUNDS_LOCKED', { isBuyer: false, isSeller: true }), 'seller')).toEqual(['done', 'done', 'done', 'waiting', 'upcoming'])
    // An observer never gets "yours".
    expect(tones(input('FUNDS_LOCKED', { isBuyer: false }), null)).toEqual(['done', 'done', 'done', 'waiting', 'upcoming'])
  })

  it('yours agrees with the "Sua vez" baton', () => {
    for (const s of ['CREATED', 'FUNDS_LOCKED', 'PAYMENT_PENDING'] as const) {
      for (const viewer of ['buyer', 'seller'] as const) {
        const step = current(input(s, { isBuyer: viewer === 'buyer', isSeller: viewer === 'seller' }))!
        expect(stageTone(step, viewer) === 'yours').toBe(batonLabel(step, viewer)?.text === 'Sua vez')
      }
    }
  })

  it('blocked, disputed and expired stages are attention, even for the viewer', () => {
    const blocked = current(input('PAYMENT_PENDING', { isBuyer: false, isSeller: true, releaseUnavailable: true }))!
    expect(stageTone(blocked, 'seller')).toBe('attention')
    expect(tones(input('DISPUTED', { dispute: { status: 'OPENED', arbiterId: ARB } }), 'buyer').slice(-1)[0]).toBe('attention')
    expect(tones(input('EXPIRED'), 'buyer').slice(-1)[0]).toBe('attention')
  })

  it('a completed escrow is all done (blue), never a success tone', () => {
    expect(tones(input('COMPLETED', { completedAt: '2026-11-02T00:00:00.000Z' }), 'buyer').every((t) => t === 'done')).toBe(true)
  })
})

describe('escrow deadline passed before the node enforces it (UX-035)', () => {
  it('detects only FUNDS_LOCKED past expiresAt, and the baton never says "Sua vez"', () => {
    const now = Date.parse('2026-11-20T12:00:00Z')
    expect(escrowDeadlinePassed({ escrowStatus: 'FUNDS_LOCKED', escrowExpiresAt: '2026-11-20T11:59:00Z', now })).toBe(true)
    expect(escrowDeadlinePassed({ escrowStatus: 'FUNDS_LOCKED', escrowExpiresAt: '2026-11-20T12:01:00Z', now })).toBe(false)
    expect(escrowDeadlinePassed({ escrowStatus: 'PAYMENT_PENDING', escrowExpiresAt: '2026-11-20T11:00:00Z', now })).toBe(false)
    expect(escrowDeadlinePassed({ escrowStatus: 'FUNDS_LOCKED', escrowExpiresAt: null, now })).toBe(false)
    expect(batonLabel({ actors: ['buyer'], blocked: 'deadline' }, 'buyer')).toEqual({ text: 'Prazo do escrow encerrado', tone: 'neutral' })
    expect(batonLabel({ actors: ['buyer'], blocked: 'deadline' }, 'seller')).toEqual({ text: 'Prazo do escrow encerrado', tone: 'neutral' })
  })
})
