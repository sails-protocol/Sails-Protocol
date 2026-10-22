export {}

const mockExecuteRaw = jest.fn().mockResolvedValue(0)
const mockAuthFindUnique = jest.fn()
const mockAuthCreate = jest.fn()
const mockDisputeFindUnique = jest.fn()
// CTO Gate R1 (#222) finding 1 — the ambiguous-legacy-row check runs OUTSIDE
// the $transaction (it decides whether to even enter the locked gate at
// all), via a plain top-level prisma.dispute.findFirst({ where: { escrowId } }).
const mockDisputeFindFirst = jest.fn()

const tx = {
  $executeRaw: mockExecuteRaw,
  economicDispositionAuthorization: {
    findUnique: mockAuthFindUnique,
    create: mockAuthCreate,
  },
  dispute: {
    findUnique: mockDisputeFindUnique,
  },
}

const mockRoundFindUnique = jest.fn().mockResolvedValue(null)
const mockTransaction = jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx))

jest.mock('../src/common/database', () => ({
  prisma: {
    dispute: { findFirst: (...args: unknown[]) => mockDisputeFindFirst(...args) },
    // #239D D1 - the gate reads the cooperative round itself to recognise complete bilateral intent.
    escrowPendingTransaction: { findUnique: (...args: unknown[]) => mockRoundFindUnique(...args) },
    $transaction: (...args: unknown[]) => mockTransaction(...(args as [any])),
  },
}))

import {
  authorizeDisputedPendingExecution,
  economicDispositionLockKey,
  economicDispositionOperationDigest,
} from '../src/modules/open-settlement/economic-disposition-authority'

const cooperativePending = {
  id: 'pending-1',
  escrowId: 'escrow-1',
  kind: 'release',
  toAddress: 'bc1qbuyer',
  toAddressSecondary: null,
  buyerBps: null,
  feeCollectionSats: 100,
  feeCollectionWaived: false,
  minerFeeSats: 250,
  unsignedPsbtBase64: 'cHNidP8BAA==',
  requiredSigners: ['buyer-1', 'seller-1'],
  triggeredBy: 'seller-1',
  disputeId: null,
  rulingAppealRound: null,
  rulingArbiterId: null,
  rulingOutcome: null,
  rulingAuthoritySignature: null,
  rulingAuthorityIssuedAt: null,
}

const disputedPending = {
  ...cooperativePending,
  id: 'pending-2',
  triggeredBy: 'arbiter-1',
  disputeId: 'dispute-1',
  rulingAppealRound: 0,
  rulingArbiterId: 'arbiter-1',
  rulingOutcome: 'RELEASE',
  rulingAuthoritySignature: 'sig-generation-0',
  rulingAuthorityIssuedAt: new Date('2026-09-18T00:00:00.000Z'),
}

function liveDispute(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dispute-1',
    status: 'RESOLVED',
    appealRound: 0,
    arbiterId: 'arbiter-1',
    ruling: 'RELEASE',
    authoritySignature: 'sig-generation-0',
    ...overrides,
  }
}

describe('ADR-005 economic disposition commit gate', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAuthFindUnique.mockResolvedValue(null)
    mockAuthCreate.mockImplementation(async ({ data }) => ({
      id: 'eda-1',
      authorizedAt: new Date(),
      ...data,
    }))
    mockDisputeFindUnique.mockResolvedValue(liveDispute())
    // Default: this escrow's trade was never disputed — the durable fact
    // that makes a disputeId-null pending row provably cooperative.
    mockDisputeFindFirst.mockResolvedValue(null)
  })

  it('is a no-op for a pending operation with no recorded ruling generation and a durably-never-disputed escrow (cooperative release)', async () => {
    await expect(authorizeDisputedPendingExecution(cooperativePending)).resolves.toBeNull()
    expect(mockDisputeFindFirst).toHaveBeenCalledWith({ where: { escrowId: 'escrow-1' } })
    expect(mockTransaction).not.toHaveBeenCalled()
    expect(mockAuthCreate).not.toHaveBeenCalled()
  })

  // CTO Gate R1 (#222) finding 1, test 1/3 — legacy cooperative pending
  // whose cooperative origin IS provable (alias of the test above, named
  // explicitly per the required test list).
  it('legacy row (no recorded provenance) on a never-disputed escrow is provably cooperative and proceeds', async () => {
    mockDisputeFindFirst.mockResolvedValue(null)
    await expect(authorizeDisputedPendingExecution(cooperativePending)).resolves.toBeNull()
  })

  // CTO Gate R1 (#222) finding 1, test 2/3 — legacy/ambiguous pending: no
  // recorded provenance, but this escrow DOES have a Dispute record (at any
  // status) — cooperative origin cannot be proven, must fail closed.
  it('legacy row (no recorded provenance) on an escrow that has ANY dispute record is ambiguous and fails closed', async () => {
    mockDisputeFindFirst.mockResolvedValue({ id: 'dispute-1', escrowId: 'escrow-1', status: 'RESOLVED' })

    await expect(authorizeDisputedPendingExecution(cooperativePending)).rejects.toThrow(
      /cooperative origin cannot be proven/
    )
    expect(mockTransaction).not.toHaveBeenCalled()
    expect(mockAuthCreate).not.toHaveBeenCalled()
  })

  // CTO Gate R1 (#222) finding 1, test 3/3 — ambiguity check itself never
  // depends on the dispute's current status (RESOLVED, APPEALED, OPENED —
  // all equally disqualifying), proving it can't be worked around by a
  // dispute that has since settled.
  it('an ambiguous legacy row stays rejected regardless of the found dispute\'s own status', async () => {
    mockDisputeFindFirst.mockResolvedValue({ id: 'dispute-1', escrowId: 'escrow-1', status: 'OPENED' })
    await expect(authorizeDisputedPendingExecution(cooperativePending)).rejects.toThrow(/ADR-005/)
  })

  // #239D D1 - the one exception to the rule above: the cooperative round's complete bilateral set was
  // accepted (under the escrow lock) before any dispute existed. Anything less stays fail-closed.
  describe('D1 complete bilateral intent (#239D)', () => {
    const round = (overrides: Record<string, unknown> = {}) => ({
      id: 'pending-1', escrowId: 'escrow-1', disputeId: null, requiredSigners: ['buyer-1', 'seller-1'],
      signatures: [{ participantId: 'buyer-1' }, { participantId: 'seller-1' }], bilateralAuthorityAt: new Date(), ...overrides,
    })
    beforeEach(() => mockDisputeFindFirst.mockResolvedValue({ id: 'dispute-1', escrowId: 'escrow-1', status: 'OPENED' }))

    it('a cooperative round completed before the dispute is the frozen intent: it proceeds despite the dispute', async () => {
      mockRoundFindUnique.mockResolvedValueOnce(round())
      await expect(authorizeDisputedPendingExecution(cooperativePending)).resolves.toBeNull()
      expect(mockRoundFindUnique).toHaveBeenCalledWith({ where: { id: 'pending-1' }, include: { signatures: { select: { participantId: true } } } })
    })

    it.each([
      ['a partial set', { signatures: [{ participantId: 'seller-1' }] }],
      ['a complete set with no pre-dispute authority marker (completed after the dispute, or legacy)', { bilateralAuthorityAt: null }],
      ['a ruling round', { disputeId: 'dispute-1' }],
      ['a round of another escrow', { escrowId: 'escrow-2' }],
    ])('%s does not qualify and stays fail-closed', async (_label, overrides) => {
      mockRoundFindUnique.mockResolvedValueOnce(round(overrides))
      await expect(authorizeDisputedPendingExecution(cooperativePending)).rejects.toThrow(/cooperative origin cannot be proven/)
    })
  })

  it('commits economic disposition authority when the recorded generation is still current', async () => {
    const result = await authorizeDisputedPendingExecution(disputedPending)

    expect(mockExecuteRaw).toHaveBeenCalled()
    expect(mockDisputeFindUnique).toHaveBeenCalledWith({ where: { id: 'dispute-1' } })
    expect(mockAuthCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        pendingOperationId: 'pending-2',
        escrowId: 'escrow-1',
        disputeId: 'dispute-1',
        appealRound: 0,
        arbiterId: 'arbiter-1',
        ruling: 'RELEASE',
        operationDigest: economicDispositionOperationDigest(disputedPending),
      }),
    })
    expect(result).toEqual(expect.objectContaining({ disputeId: 'dispute-1' }))
  })

  it('uses the economic-disposition:<disputeId> lock scope shared with appeal()/applyRuling()', () => {
    expect(economicDispositionLockKey('dispute-1')).toBe('economic-disposition:dispute-1')
  })

  it('fails closed when an appeal advanced the appeal round before commit', async () => {
    mockDisputeFindUnique.mockResolvedValue(liveDispute({ status: 'APPEALED', appealRound: 1, arbiterId: 'arbiter-2', ruling: null }))

    await expect(authorizeDisputedPendingExecution(disputedPending)).rejects.toThrow(/no longer current/)
    expect(mockAuthCreate).not.toHaveBeenCalled()
  })

  it('fails closed when the current arbiter no longer matches the recorded generation', async () => {
    mockDisputeFindUnique.mockResolvedValue(liveDispute({ arbiterId: 'arbiter-2' }))

    await expect(authorizeDisputedPendingExecution(disputedPending)).rejects.toThrow(/no longer current/)
    expect(mockAuthCreate).not.toHaveBeenCalled()
  })

  it('fails closed when the dispute is not RESOLVED (e.g. reopened) even if appealRound/arbiterId coincidentally match', async () => {
    mockDisputeFindUnique.mockResolvedValue(liveDispute({ status: 'EVIDENCE_SUBMITTED' }))

    await expect(authorizeDisputedPendingExecution(disputedPending)).rejects.toThrow(/no longer current/)
    expect(mockAuthCreate).not.toHaveBeenCalled()
  })

  it('reuses an already-committed authorization without re-consulting the live dispute state — retry after a later appeal', async () => {
    const existing = {
      id: 'eda-1',
      pendingOperationId: disputedPending.id,
      escrowId: disputedPending.escrowId,
      disputeId: 'dispute-1',
      appealRound: 0,
      arbiterId: 'arbiter-1',
      ruling: 'RELEASE',
      operationDigest: economicDispositionOperationDigest(disputedPending),
      authorizedAt: new Date(),
    }
    mockAuthFindUnique.mockResolvedValue(existing)
    // Even though the dispute has since moved to a new generation, a
    // committed attempt is allowed to retry-to-completion (ADR-005 §4) —
    // this mock proves the live dispute row is never consulted on reuse.
    mockDisputeFindUnique.mockRejectedValue(new Error('must not be called on reuse'))

    await expect(authorizeDisputedPendingExecution(disputedPending)).resolves.toBe(existing)
    expect(mockDisputeFindUnique).not.toHaveBeenCalled()
    expect(mockAuthCreate).not.toHaveBeenCalled()
  })

  it('rejects reuse if the pending operation was mutated since the original commit', async () => {
    mockAuthFindUnique.mockResolvedValue({
      id: 'eda-1',
      pendingOperationId: disputedPending.id,
      escrowId: disputedPending.escrowId,
      disputeId: 'dispute-1',
      appealRound: 0,
      arbiterId: 'arbiter-1',
      ruling: 'RELEASE',
      operationDigest: 'different-digest',
      authorizedAt: new Date(),
    })

    await expect(authorizeDisputedPendingExecution(disputedPending)).rejects.toThrow(/no longer matches its committed economic disposition authorization/)
    expect(mockAuthCreate).not.toHaveBeenCalled()
  })

  // CTO Gate R1 (#222) finding 2 — economicDispositionOperationDigest() must
  // bind the full generation identity, not just the ADR-004 operation
  // facts. Each case below commits a real authorization for the BASELINE
  // generation, then retries with a pending row whose own recorded
  // provenance has ONE dimension mutated relative to what was committed —
  // proving reuse is rejected because the digest itself changed, not
  // because of any separate field-by-field check.
  describe('reuse rejects on any generation-dimension mutation (digest is generation-bound, not just operation-bound)', () => {
    async function committedFor(pending: typeof disputedPending) {
      return {
        id: 'eda-1',
        pendingOperationId: pending.id,
        escrowId: pending.escrowId,
        disputeId: pending.disputeId,
        appealRound: pending.rulingAppealRound,
        arbiterId: pending.rulingArbiterId,
        ruling: pending.rulingOutcome,
        operationDigest: economicDispositionOperationDigest(pending),
        authorizedAt: new Date(),
      }
    }

    it('rejects when rulingAppealRound was mutated since the original commit', async () => {
      mockAuthFindUnique.mockResolvedValue(await committedFor(disputedPending))
      const mutated = { ...disputedPending, rulingAppealRound: 1 }
      await expect(authorizeDisputedPendingExecution(mutated)).rejects.toThrow(/no longer matches/)
    })

    it('rejects when rulingArbiterId was mutated since the original commit', async () => {
      mockAuthFindUnique.mockResolvedValue(await committedFor(disputedPending))
      const mutated = { ...disputedPending, rulingArbiterId: 'arbiter-2' }
      await expect(authorizeDisputedPendingExecution(mutated)).rejects.toThrow(/no longer matches/)
    })

    it('rejects when rulingOutcome was mutated since the original commit', async () => {
      mockAuthFindUnique.mockResolvedValue(await committedFor(disputedPending))
      const mutated = { ...disputedPending, rulingOutcome: 'REFUND' }
      await expect(authorizeDisputedPendingExecution(mutated)).rejects.toThrow(/no longer matches/)
    })

    it('rejects when rulingAuthoritySignature was mutated since the original commit', async () => {
      mockAuthFindUnique.mockResolvedValue(await committedFor(disputedPending))
      const mutated = { ...disputedPending, rulingAuthoritySignature: 'sig-generation-1-forged' }
      await expect(authorizeDisputedPendingExecution(mutated)).rejects.toThrow(/no longer matches/)
    })

    it('rejects when rulingAuthorityIssuedAt was mutated since the original commit', async () => {
      mockAuthFindUnique.mockResolvedValue(await committedFor(disputedPending))
      const mutated = { ...disputedPending, rulingAuthorityIssuedAt: new Date('2026-09-19T00:00:00.000Z') }
      await expect(authorizeDisputedPendingExecution(mutated)).rejects.toThrow(/no longer matches/)
    })

    it('the digest changes even when the ADR-004 operation facts are byte-identical — proving it is not just capabilityOperationDigest under a new name', () => {
      const generation0 = economicDispositionOperationDigest(disputedPending)
      const generation1 = economicDispositionOperationDigest({ ...disputedPending, rulingAppealRound: 1, rulingArbiterId: 'arbiter-2', rulingOutcome: 'REFUND', rulingAuthoritySignature: 'sig-1', rulingAuthorityIssuedAt: new Date('2026-09-19T00:00:00.000Z') })
      expect(generation0).not.toBe(generation1)
    })
  })
})
