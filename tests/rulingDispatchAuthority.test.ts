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
  authorizationIdentityGaps,
  type CommittedAuthorizationEvidence,
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
    expect(await proveRoundIsThisDispatch(tx, round, dispute, intent)).toEqual({ ok: true, warnings: [] })
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
    // AUD1X-R3: toAddress is no longer a refusal reason (AR2-03), so the third divergence is the initiator.
    const proof = await proveRoundIsThisDispatch(tx, { ...round, kind: 'refund', triggeredBy: 'someone-else', buyerBps: 1 }, dispute, intent)

    expect(!proof.ok && proof.reasons).toHaveLength(3)
  })

  // AUD1X-R3 (AR2-03) - the row's destination columns are a copy no executor pays from; the transaction is what pays,
  // and the AUD-1 binding judges it against the durable Outcome. So the copy alone neither refuses nor proves.
  it.each<[string, Partial<ExistingRound>, RegExp]>([
    ['primary', { toAddress: 'tb1-stale-copy' }, /primary destination/],
    ['secondary', { toAddressSecondary: 'tb1-stale-copy' }, /secondary destination/],
  ])('AR2-03 - a %s destination copy that disagrees while the transaction pays the Outcome: accepted, reported as a metadata warning', async (_name, patch, warning) => {
    const proof = await proveRoundIsThisDispatch(tx, { ...round, ...patch }, dispute, intent)

    expect(proof.ok).toBe(true)
    expect(proof.ok && proof.warnings.join(' | ')).toMatch(warning)
    expect(mockBinding).toHaveBeenCalledTimes(1) // the transaction itself was judged
  })

  it('AR2-03 - a correct destination copy over a transaction that pays someone else: refused by the binding (the gate is not weakened)', async () => {
    mockBinding.mockRejectedValueOnce(new Error('AUD-1: expected an output of 99180 sats at tb1-buyer - no such output exists'))

    const proof = await proveRoundIsThisDispatch(tx, round, dispute, intent)

    expect(proof.ok).toBe(false)
    expect(!proof.ok && proof.reasons.join(' | ')).toMatch(/AUD-1 binding/)
  })

  it('AR2-03 - a wrong copy AND a transaction that pays someone else: refused (the warning never turns a binding failure into a pass)', async () => {
    mockBinding.mockRejectedValueOnce(new Error('AUD-1: expected an output of 99180 sats at tb1-buyer - no such output exists'))

    const proof = await proveRoundIsThisDispatch(tx, { ...round, toAddress: 'tb1-attacker' }, dispute, intent)

    expect(proof.ok).toBe(false)
  })
})

describe('decideRulingRevert - what a dispatch failure may do to a committed ruling', () => {
  const ids = { escrowId: 'escrow-1', disputeId: 'dispute-1', appealRound: 0, authoritySignature: 'sig-1' }
  // AUD1X-R3 - an authorization carries the ruling identity the gate recorded; this one is the decided ruling's own.
  const provenAuthorization: CommittedAuthorizationEvidence = {
    id: 'eda-1', pendingOperationId: 'round-0', arbiterId: 'arbiter-1', ruling: 'RELEASE',
    rulingAuthoritySignature: 'sig-1', outcomeRecordId: 'outcome-1', currentOutcomeRecordId: 'outcome-1',
  }
  function fakeTx(opts: {
    round?: Partial<ExistingRound> | null; escrowStatus?: string; txReleaseId?: string | null
    authorization?: boolean; authorizations?: Partial<CommittedAuthorizationEvidence>[]; dispute?: LockedDispute | null
  }) {
    const roundRow = opts.round === null ? null : { ...round, ...(opts.round ?? {}) }
    const authorizations = opts.authorizations?.map((a) => ({ ...provenAuthorization, ...a })) ?? (opts.authorization ? [provenAuthorization] : [])
    return {
      $executeRaw: jest.fn(async () => 0),
      $queryRaw: jest.fn(async (strings: TemplateStringsArray) => strings.join('?').includes('FROM economic_disposition_authorizations')
        ? authorizations
        : (opts.dispute === null ? [] : [opts.dispute ?? dispute])),
      escrowPendingTransaction: { findUnique: jest.fn(async () => roundRow) },
      escrow: { findUnique: jest.fn(async () => ({ status: opts.escrowStatus ?? 'DISPUTED', txReleaseId: opts.txReleaseId === undefined ? 'f'.repeat(64) : opts.txReleaseId })) },
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
    // AUD1X-R3: the divergence is the SPLIT allocation (a destination copy is no longer a refusal reason, AR2-03).
    const decision = await decideRulingRevert(fakeTx({ round: { buyerBps: 5000 } }), ids, intent)
    expect(decision.action).toBe('PRESERVE')
    expect(decision.action === 'PRESERVE' && decision.error.message).toMatch(/not the dispatch of the ruling.*SPLIT allocation/)
  })

  it('state 3 - a round whose transaction does not pay the Outcome (binding): PRESERVE with the evidence', async () => {
    mockBinding.mockRejectedValueOnce(new Error('AUD-1: expected an output of 99180 sats at tb1-buyer - no such output exists'))
    const decision = await decideRulingRevert(fakeTx({}), ids, intent)
    expect(decision.action).toBe('PRESERVE')
    expect(decision.action === 'PRESERVE' && decision.error.message).toMatch(/AUD-1 binding/)
  })

  it.each([
    ['another signed authority (a round left by an earlier, reverted ruling)', { rulingAuthoritySignature: 'sig-0' }],
    ['another appeal round', { rulingAppealRound: 1 }],
    ['another dispute', { disputeId: 'dispute-2' }],
  ])('a round of %s is not this ruling\'s: REVERT, unchanged', async (_name, patch) => {
    expect(await decideRulingRevert(fakeTx({ round: patch }), ids, intent)).toEqual({ action: 'REVERT' })
  })

  // AUD1X-R3 (AR2-01) - R2 adopted ANY authorization of the same generation on a terminal escrow (the assertion it had:
  // "an authorization of this generation exists (executed): ADOPT" for every terminal status). That is the defect: a
  // new, contradicting ruling of the same appeal round was reported as executed. The CTO policy replaces it: ADOPT
  // only an authorization proven to be THIS ruling's, on an escrow that ended as THIS ruling decides.
  it.each([
    ['RELEASE', 'COMPLETED', null],
    ['REFUND', 'REFUNDED', null],
    ['SPLIT', 'SPLIT', 6000],
  ])('state 4 - an authorization proven to be this %s ruling\'s, escrow ended %s with an executed transaction: ADOPT', async (ruling, escrowStatus, bps) => {
    const d = { ...dispute, ruling, authorityBuyerBps: bps }
    expect(await decideRulingRevert(fakeTx({ round: null, escrowStatus, dispute: d, authorizations: [{ ruling }] }), ids, intent))
      .toEqual({ action: 'ADOPT', reason: 'AUTHORIZATION_COMMITTED' })
  })

  it.each<[string, Partial<CommittedAuthorizationEvidence>, Partial<LockedDispute>]>([
    ['an authorization of another signed ruling (same appeal round)', { rulingAuthoritySignature: 'sig-0' }, {}],
    ['an authorization judged against another durable Outcome record', { outcomeRecordId: 'outcome-0' }, {}],
    ['an authorization whose Outcome record no longer exists', { currentOutcomeRecordId: null }, {}],
    ['a legacy authorization without recorded ruling identity', { rulingAuthoritySignature: null, outcomeRecordId: null }, {}],
    ['a legacy authorization with only part of the identity', { outcomeRecordId: null }, {}],
    ['an authorization of another ruling (REFUND executed, RELEASE decided)', { ruling: 'REFUND' }, {}],
    ['an authorization of another arbiter', { arbiterId: 'arbiter-2' }, {}],
    ['a dispute that no longer holds the decided ruling', {}, { authoritySignature: 'sig-2' }],
    ['a dispute that is no longer resolved', {}, { status: 'OPENED' }],
  ])('state 4 - %s: never ADOPT, REVERT', async (_name, authorizationPatch, disputePatch) => {
    expect(await decideRulingRevert(fakeTx({ round: null, escrowStatus: 'COMPLETED', dispute: { ...dispute, ...disputePatch }, authorizations: [authorizationPatch] }), ids, intent))
      .toEqual({ action: 'REVERT' })
  })

  it('state 4 - REFUND executed, RELEASE now ruled, both proven to different signatures (the AR2-01 reproduction): REVERT', async () => {
    const decision = await decideRulingRevert(fakeTx({ round: null, escrowStatus: 'REFUNDED', authorizations: [{ ruling: 'REFUND', rulingAuthoritySignature: 'sig-0', outcomeRecordId: 'outcome-0' }] }), ids, intent)
    expect(decision).toEqual({ action: 'REVERT' })
  })

  it.each<[string, string, string | null, RegExp]>([
    ['the escrow ended as another disposition', 'REFUNDED', 'f'.repeat(64), /ended REFUNDED/],
    ['no executed transaction is recorded', 'COMPLETED', null, /no executed transaction/],
  ])('state 4 - this ruling\'s own authorization, but %s: PRESERVE (neither success nor revert)', async (_name, escrowStatus, txReleaseId, reason) => {
    const decision = await decideRulingRevert(fakeTx({ round: null, escrowStatus, txReleaseId, authorization: true }), ids, intent)
    expect(decision.action).toBe('PRESERVE')
    expect(decision.action === 'PRESERVE' && decision.error.message).toMatch(reason)
  })

  it('state 4 - a legacy authorization beside this ruling\'s proven one: the proven one decides (ADOPT); the legacy row is never the reason', async () => {
    expect(await decideRulingRevert(fakeTx({ round: null, escrowStatus: 'COMPLETED', authorizations: [{ id: 'eda-0', rulingAuthoritySignature: null, outcomeRecordId: null }, {}] }), ids, intent))
      .toEqual({ action: 'ADOPT', reason: 'AUTHORIZATION_COMMITTED' })
  })

  it('state 4 - a missing dispute row proves nothing: REVERT, never ADOPT', async () => {
    expect(await decideRulingRevert(fakeTx({ round: null, escrowStatus: 'COMPLETED', dispute: null, authorization: true }), ids, intent)).toEqual({ action: 'REVERT' })
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

describe('authorizationIdentityGaps - AUD1X-R3, every compared fact on its own', () => {
  const a: CommittedAuthorizationEvidence = {
    id: 'eda-1', pendingOperationId: 'round-0', arbiterId: 'arbiter-1', ruling: 'RELEASE',
    rulingAuthoritySignature: 'sig-1', outcomeRecordId: 'outcome-1', currentOutcomeRecordId: 'outcome-1',
  }
  const executed = { status: 'COMPLETED', txReleaseId: 'f'.repeat(64) }

  it('no gap for the decided ruling\'s own executed authorization', () => {
    expect(authorizationIdentityGaps(a, dispute, executed, 'sig-1')).toEqual({ identity: [], execution: [] })
  })

  it.each<[string, Partial<CommittedAuthorizationEvidence>, Partial<LockedDispute>, string, RegExp]>([
    ['signature', { rulingAuthoritySignature: 'sig-0' }, {}, 'sig-1', /another signed ruling/],
    ['Outcome record', { outcomeRecordId: 'outcome-0' }, {}, 'sig-1', /another durable Outcome record/],
    ['Outcome record gone', { currentOutcomeRecordId: null }, {}, 'sig-1', /another durable Outcome record/],
    ['legacy signature', { rulingAuthoritySignature: null }, {}, 'sig-1', /legacy/],
    ['legacy Outcome record', { outcomeRecordId: null }, {}, 'sig-1', /legacy/],
    ['ruling', { ruling: 'SPLIT' }, {}, 'sig-1', /for ruling SPLIT/],
    ['arbiter', { arbiterId: 'arbiter-2' }, {}, 'sig-1', /another arbiter/],
    ['decided signature not the dispute\'s', {}, {}, 'sig-9', /no longer holds the ruling being decided/],
    ['dispute not resolved', {}, { status: 'APPEALED' }, 'sig-1', /no longer holds/],
    ['dispute without ruling', {}, { ruling: null }, 'sig-1', /no longer holds/],
  ])('identity gap: %s', (_name, patch, disputePatch, sig, reason) => {
    const gaps = authorizationIdentityGaps({ ...a, ...patch }, { ...dispute, ...disputePatch }, executed, sig)
    expect(gaps.identity.join(' | ')).toMatch(reason)
  })

  it.each<[string, { status: string; txReleaseId: string | null }, RegExp]>([
    ['terminal status of another disposition', { status: 'REFUNDED', txReleaseId: 'f'.repeat(64) }, /ended REFUNDED/],
    ['SPLIT for a RELEASE', { status: 'SPLIT', txReleaseId: 'f'.repeat(64) }, /ended SPLIT/],
    ['no executed transaction', { status: 'COMPLETED', txReleaseId: null }, /no executed transaction/],
  ])('execution gap: %s', (_name, escrow, reason) => {
    const gaps = authorizationIdentityGaps(a, dispute, escrow, 'sig-1')
    expect(gaps.identity).toEqual([])
    expect(gaps.execution.join(' | ')).toMatch(reason)
  })
})
