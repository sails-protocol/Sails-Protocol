// AUD1X-R2 - the two decisions of ruling-dispatch-authority.ts, field by field.
//
// The PostgreSQL scenarios (tests/integration/aud1xR2DispatchAuthority.test.ts) prove the behaviour end to end. They
// cannot isolate each compared fact: a divergent round usually differs in several (a wrong payee is caught by the
// destination comparison AND by the AUD-1 binding), so removing one comparison does not change the scenario's verdict.
// Here the binding is a stub that always passes, so every comparison is exercised on its own: change exactly one fact of
// an otherwise identical round and exactly that reason must appear. The binding itself is stubbed, not reimplemented:
// its own proofs are disputedOutcomeBinding.test.ts / tests/integration/disputedOutcomeBinding.test.ts.
const mockBinding = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock('../src/modules/open-settlement/disputed-outcome-binding', () => ({
  assertRoundBoundToDisputeAuthority: (...args: unknown[]) => mockBinding(...args),
}))

import {
  proveRoundIsThisDispatch,
  decideRulingRevert,
  type ExistingRound,
  type LockedDispute,
  type DispatchIntent,
} from '../src/modules/open-settlement/ruling-dispatch-authority'

const ISSUED = new Date('2026-10-11T12:00:00.000Z')
const dispute: LockedDispute = {
  id: 'dispute-1', escrowId: 'escrow-1', status: 'RESOLVED', appealRound: 0, arbiterId: 'arbiter-1', ruling: 'RELEASE',
  authoritySignature: 'sig-1', authorityIssuedAt: ISSUED, authorityBuyerBps: null,
}
const intent: DispatchIntent = {
  escrowId: 'escrow-1', escrowType: 'MULTISIG', kind: 'release', triggeredBy: 'arbiter-1',
  toAddress: 'tb1-buyer', toAddressSecondary: null, buyerBps: null,
}
const round: ExistingRound = {
  id: 'round-1', escrowId: 'escrow-1', kind: 'release', toAddress: 'tb1-buyer', toAddressSecondary: null, buyerBps: null,
  feeCollectionSats: null, feeCollectionWaived: null, minerFeeSats: 820, unsignedPsbtBase64: 'psbt', triggeredBy: 'arbiter-1',
  disputeId: 'dispute-1', rulingAppealRound: 0, rulingArbiterId: 'arbiter-1', rulingOutcome: 'RELEASE',
  rulingAuthoritySignature: 'sig-1', rulingAuthorityIssuedAt: ISSUED,
}
const tx = {} as never

beforeEach(() => { mockBinding.mockReset(); mockBinding.mockResolvedValue(undefined) })

describe('proveRoundIsThisDispatch - exactly the round the ruling decided', () => {
  it('accepts the round that matches on every fact, and judges the stored PSBT against the live ruling', async () => {
    expect(await proveRoundIsThisDispatch(tx, round, dispute, intent)).toEqual({ ok: true })
    expect(mockBinding).toHaveBeenCalledTimes(1)
    expect(mockBinding.mock.calls[0][1]).toMatchObject({ unsignedPsbtBase64: 'psbt', minerFeeSats: 820, disputeId: 'dispute-1', rulingAppealRound: 0, rulingOutcome: 'RELEASE' })
    expect(mockBinding.mock.calls[0][2]).toMatchObject({ id: 'dispute-1', status: 'RESOLVED', ruling: 'RELEASE' })
  })

  it.each<[string, Partial<ExistingRound>, Partial<LockedDispute>, Partial<DispatchIntent>, RegExp]>([
    ['another escrow (round)', { escrowId: 'escrow-2' }, {}, {}, /another escrow/],
    ['another escrow (dispute)', {}, { escrowId: 'escrow-2' }, {}, /another escrow/],
    ['an unresolved dispute', {}, { status: 'OPENED' }, {}, /not resolved/],
    ['a dispute without a ruling', {}, { ruling: null }, {}, /not resolved/],
    ['another dispute', { disputeId: 'dispute-2' }, {}, {}, /records dispute dispute-2/],
    ['another appeal round', { rulingAppealRound: 1 }, {}, {}, /appeal round 1/],
    ['another arbiter', { rulingArbiterId: 'arbiter-2' }, {}, {}, /another arbiter/],
    ['no recorded arbiter', { rulingArbiterId: null }, {}, {}, /another arbiter/],
    ['another recorded ruling', { rulingOutcome: 'REFUND' }, {}, {}, /records ruling REFUND/],
    ['another signed authority', { rulingAuthoritySignature: 'sig-0' }, {}, {}, /another signed authority/],
    ['no recorded signed authority', { rulingAuthoritySignature: null }, {}, {}, /another signed authority/],
    ['another authority issue time', { rulingAuthorityIssuedAt: new Date('2026-10-11T12:00:01.000Z') }, {}, {}, /another authority issue time/],
    ['no authority issue time', { rulingAuthorityIssuedAt: null }, {}, {}, /another authority issue time/],
    ['another kind', { kind: 'refund' }, {}, {}, /is a refund, this dispatch is a release/],
    ['another initiator', { triggeredBy: 'someone-else' }, {}, {}, /another identity/],
    ['another primary destination', { toAddress: 'tb1-attacker' }, {}, {}, /primary destination/],
    ['another secondary destination', { toAddressSecondary: 'tb1-attacker' }, {}, {}, /secondary destination/],
    ['another SPLIT allocation', { buyerBps: 5000 }, {}, {}, /SPLIT allocation/],
  ])('refuses %s, naming exactly that reason, and never reaches the binding as a pass', async (_name, roundPatch, disputePatch, intentPatch, reason) => {
    const proof = await proveRoundIsThisDispatch(tx, { ...round, ...roundPatch }, { ...dispute, ...disputePatch }, { ...intent, ...intentPatch })

    expect(proof.ok).toBe(false)
    expect(!proof.ok && proof.reasons.join(' | ')).toMatch(reason)
    expect(mockBinding).not.toHaveBeenCalled() // a scalar mismatch is decided before the stored PSBT is even judged
  })

  it('refuses a round whose scalar facts all match but whose stored PSBT does not pay what the Outcome authorized (the AUD-1 binding)', async () => {
    mockBinding.mockRejectedValueOnce(new Error('AUD-1: expected an output of 99180 sats at tb1-buyer - no such output exists'))

    const proof = await proveRoundIsThisDispatch(tx, round, dispute, intent)

    expect(proof.ok).toBe(false)
    expect(!proof.ok && proof.reasons.join(' | ')).toMatch(/AUD-1 binding: .*no such output/)
  })

  it('reports every divergence, not only the first (evidence for the reconciling operator)', async () => {
    const proof = await proveRoundIsThisDispatch(tx, { ...round, kind: 'refund', toAddress: 'tb1-attacker', buyerBps: 1 }, dispute, intent)

    expect(!proof.ok && proof.reasons).toHaveLength(3)
  })
})

describe('decideRulingRevert - what a dispatch failure may do to a committed ruling', () => {
  const ids = { escrowId: 'escrow-1', disputeId: 'dispute-1', appealRound: 0, authoritySignature: 'sig-1' }
  function fakeTx(opts: { round?: Partial<ExistingRound> | null; escrowStatus?: string; authorization?: boolean; dispute?: LockedDispute | null }) {
    const roundRow = opts.round === null ? null : { ...round, ...(opts.round ?? {}) }
    return {
      $executeRaw: jest.fn(async () => 0),
      $queryRaw: jest.fn(async () => (opts.dispute === null ? [] : [opts.dispute ?? dispute])),
      escrowPendingTransaction: { findUnique: jest.fn(async () => roundRow) },
      escrow: { findUnique: jest.fn(async () => ({ status: opts.escrowStatus ?? 'DISPUTED' })) },
      economicDispositionAuthorization: { findFirst: jest.fn(async () => (opts.authorization ? { id: 'eda-1' } : null)) },
    } as never
  }

  it('takes the escrow lock (after the dispute lock the caller holds) before reading anything', async () => {
    const t = fakeTx({ round: null }) as any
    await decideRulingRevert(t, ids, intent)
    expect(t.$executeRaw).toHaveBeenCalledTimes(1)
    expect(t.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(t.escrowPendingTransaction.findUnique.mock.invocationCallOrder[0])
  })

  it('state 1 - nothing durable depends on the ruling: REVERT', async () => {
    expect(await decideRulingRevert(fakeTx({ round: null }), ids, intent)).toEqual({ action: 'REVERT' })
  })

  it('state 2 - a round of this ruling that is proven its dispatch: ADOPT', async () => {
    expect(await decideRulingRevert(fakeTx({}), ids, intent)).toEqual({ action: 'ADOPT', reason: 'EQUIVALENT_ROUND' })
  })

  it('state 3 - a round of this ruling that is not its dispatch: PRESERVE with the evidence', async () => {
    const decision = await decideRulingRevert(fakeTx({ round: { toAddress: 'tb1-attacker' } }), ids, intent)
    expect(decision.action).toBe('PRESERVE')
    expect(decision.action === 'PRESERVE' && decision.error.message).toMatch(/not the dispatch of the ruling.*primary destination/)
  })

  it.each([
    ['another signed authority (a round left by an earlier, reverted ruling)', { rulingAuthoritySignature: 'sig-0' }],
    ['another appeal round', { rulingAppealRound: 1 }],
    ['another dispute', { disputeId: 'dispute-2' }],
  ])('a round of %s is not this ruling\'s: REVERT, unchanged', async (_name, patch) => {
    expect(await decideRulingRevert(fakeTx({ round: patch }), ids, intent)).toEqual({ action: 'REVERT' })
  })

  it('state 4 - no round any more, the escrow is terminal and an authorization of this generation exists (executed): ADOPT', async () => {
    for (const escrowStatus of ['COMPLETED', 'REFUNDED', 'SPLIT']) {
      expect(await decideRulingRevert(fakeTx({ round: null, escrowStatus, authorization: true }), ids, intent)).toEqual({ action: 'ADOPT', reason: 'AUTHORIZATION_COMMITTED' })
    }
  })

  it('#239D - a terminal escrow with NO authorization of this generation (bilateral completion): REVERT, as before', async () => {
    expect(await decideRulingRevert(fakeTx({ round: null, escrowStatus: 'COMPLETED', authorization: false }), ids, intent)).toEqual({ action: 'REVERT' })
  })

  it('an authorization on a non-terminal escrow with no round is not an executed dispatch: REVERT', async () => {
    expect(await decideRulingRevert(fakeTx({ round: null, escrowStatus: 'DISPUTED', authorization: true }), ids, intent)).toEqual({ action: 'REVERT' })
  })

  it('a missing dispute row cannot prove anything: PRESERVE', async () => {
    const decision = await decideRulingRevert(fakeTx({ dispute: null }), ids, intent)
    expect(decision.action).toBe('PRESERVE')
  })
})
