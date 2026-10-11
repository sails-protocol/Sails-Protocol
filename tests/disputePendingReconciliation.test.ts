// tests/disputePendingReconciliation.test.ts
//
// Sails Core Implementation Program M9 (Recovery, Execution Uncertainty &
// Semantic Reconciliation) — orchestration-level proof of
// reconcileStalePendingDisputeTranslations(): candidate filtering (age,
// signature presence), the fail-closed "no durable Outcome" path, and the
// re-run-the-guard convergence decision. The guard's own logic
// (assertTranslationMatchesOutcome/validateTranslatedOutputsAgainstOutcome)
// is proven separately, with real PSBTs, in tests/dispatchTranslationGuard.test.ts;
// here it's a controlled mock so this suite can focus on the orchestration
// around it — same division of labor tests/escrowSettlementReconciliation.test.ts
// already establishes for the sibling PASS 1/PASS 2 reconciliation module.

jest.mock('../src/config', () => ({
  config: { multisig: { network: 'testnet' } },
}))

jest.mock('../src/modules/open-settlement/multisig.provider', () => ({
  networkFor: jest.fn(() => 'testnet'),
}))

const mockLoadDisputeRulingRecord = jest.fn()
const mockFromDisputeRulingRow = jest.fn()
jest.mock('../src/modules/open-settlement/dispute-outcome', () => ({
  loadDisputeRulingRecord: (...args: unknown[]) => mockLoadDisputeRulingRecord(...args),
  fromDisputeRulingRow: (...args: unknown[]) => mockFromDisputeRulingRow(...args),
}))

const mockValidateTranslatedOutputsAgainstOutcome = jest.fn()
jest.mock('../src/modules/open-settlement/dispatch-translation-guard', () => ({
  validateTranslatedOutputsAgainstOutcome: (...args: unknown[]) => mockValidateTranslatedOutputsAgainstOutcome(...args),
}))

const mockPendingFindMany = jest.fn()
const mockPendingDelete = jest.fn()
const mockPendingStillThere = jest.fn()
const mockDisputeFindUnique = jest.fn()
const mockCommittedFindUnique = jest.fn()
const mockDurableOutcomeFindUnique = jest.fn()
const mockLock = jest.fn().mockResolvedValue(0)
const mockDisputeFindFirst = jest.fn()
jest.mock('../src/common/database', () => ({
  prisma: {
    escrowPendingTransaction: {
      findMany: (...args: unknown[]) => mockPendingFindMany(...args),
    },
    dispute: { findFirst: (...args: unknown[]) => mockDisputeFindFirst(...args) },
    // Issue #244 - the delete runs as deletePendingRoundIfStillUnsigned(): escrow lock, then a delete
    // conditioned on the same round still having zero signatures, then (if nothing matched) a re-read.
    $transaction: (callback: (tx: unknown) => Promise<unknown>) => callback({
      $executeRaw: (...args: unknown[]) => mockLock(...args),
      escrowPendingTransaction: {
        deleteMany: (...args: unknown[]) => mockPendingDelete(...args),
        findUnique: (...args: unknown[]) => mockPendingStillThere(...args),
      },
      dispute: { findUnique: (...args: unknown[]) => mockDisputeFindUnique(...args) },
      economicDispositionAuthorization: { findUnique: (...args: unknown[]) => mockCommittedFindUnique(...args) },
      semanticTransitionRecord: { findUnique: (...args: unknown[]) => mockDurableOutcomeFindUnique(...args) },
    }),
  },
}))

import { reconcileStalePendingDisputeTranslations, deletePendingRoundIfStillUnsigned } from '../src/modules/open-settlement/dispute-pending-reconciliation'

const SIX_MIN_AGO = new Date(Date.now() - 6 * 60 * 1000)
const NOW = new Date()

function pendingFixture(overrides: Record<string, any> = {}) {
  return {
    id: 'pending-1',
    escrowId: 'escrow-1',
    unsignedPsbtBase64: 'unsigned-psbt-b64',
    createdAt: SIX_MIN_AGO,
    signatures: [],
    disputeId: 'dispute-1', rulingAppealRound: 0, rulingArbiterId: 'arbiter-1',
    rulingOutcome: 'RELEASE', rulingAuthoritySignature: 'authority-1',
    rulingAuthorityIssuedAt: new Date('2026-10-01T00:00:00Z'),
    escrow: { id: 'escrow-1', type: 'MULTISIG' },
    ...overrides,
  }
}

const RESOLVED_DISPUTE = { id: 'dispute-1', escrowId: 'escrow-1', status: 'RESOLVED', appealRound: 0, arbiterId: 'arbiter-1', ruling: 'RELEASE', authoritySignature: 'authority-1', authorityIssuedAt: new Date('2026-10-01T00:00:00Z') }
const RULING_ROW_WITH_OUTCOME = { outcomeContent: { ruling: 'RELEASE' }, toState: 'RESOLVED' }
const FAKE_RECORD_WITH_OUTCOME = { outcome: { content: { ruling: 'RELEASE' } } }

beforeEach(() => {
  jest.clearAllMocks()
  mockDisputeFindFirst.mockResolvedValue(RESOLVED_DISPUTE)
  mockLoadDisputeRulingRecord.mockResolvedValue(RULING_ROW_WITH_OUTCOME)
  mockFromDisputeRulingRow.mockReturnValue(FAKE_RECORD_WITH_OUTCOME)
  mockPendingDelete.mockResolvedValue({ count: 1 })
  mockPendingStillThere.mockResolvedValue(pendingFixture())
  mockDisputeFindUnique.mockResolvedValue(RESOLVED_DISPUTE)
  mockCommittedFindUnique.mockResolvedValue(null)
  mockDurableOutcomeFindUnique.mockResolvedValue(RULING_ROW_WITH_OUTCOME)
})

const CONDITIONAL_DELETE = { where: { id: 'pending-1', escrowId: 'escrow-1', signatures: { none: {} }, disputeId: 'dispute-1', rulingAppealRound: 0, rulingArbiterId: 'arbiter-1', rulingOutcome: 'RELEASE', rulingAuthoritySignature: 'authority-1', rulingAuthorityIssuedAt: new Date('2026-10-01T00:00:00Z') } }

describe('reconcileStalePendingDisputeTranslations() — M9 stale pending-artifact reconciliation', () => {
  it('no candidates — a clean, empty report', async () => {
    mockPendingFindMany.mockResolvedValue([])
    const report = await reconcileStalePendingDisputeTranslations()
    expect(report).toEqual({ reconciled: [], skippedTooYoung: [], skippedHasSignatures: [], alreadyCleaned: [], failed: [] })
  })

  it('a row with at least one collected signature is skipped, never touched — funds may already be in flight', async () => {
    mockPendingFindMany.mockResolvedValue([pendingFixture({ signatures: [{ participantId: 'buyer-1' }] })])
    const report = await reconcileStalePendingDisputeTranslations()
    expect(report.skippedHasSignatures).toEqual(['escrow-1'])
    expect(mockPendingDelete).not.toHaveBeenCalled()
    expect(mockValidateTranslatedOutputsAgainstOutcome).not.toHaveBeenCalled()
  })

  it('a row younger than the safety margin is skipped — may still be a live, in-flight request', async () => {
    mockPendingFindMany.mockResolvedValue([pendingFixture({ createdAt: NOW })])
    const report = await reconcileStalePendingDisputeTranslations()
    expect(report.skippedTooYoung).toEqual(['escrow-1'])
    expect(mockPendingDelete).not.toHaveBeenCalled()
  })

  it('old enough, zero signatures, re-run guard PASSES — left alone, not deleted (a legitimate pending transaction still awaiting signature collection)', async () => {
    mockPendingFindMany.mockResolvedValue([pendingFixture()])
    mockValidateTranslatedOutputsAgainstOutcome.mockReturnValue({ ok: true, mismatches: [] })

    const report = await reconcileStalePendingDisputeTranslations()

    expect(report.reconciled).toEqual([{ escrowId: 'escrow-1', pendingTransactionId: 'pending-1', verdict: 'LEFT_GUARD_PASSED' }])
    expect(mockPendingDelete).not.toHaveBeenCalled()
  })

  it('old enough, zero signatures, re-run guard FAILS — deleted (zero signatures means zero fund-movement risk)', async () => {
    mockPendingFindMany.mockResolvedValue([pendingFixture()])
    mockValidateTranslatedOutputsAgainstOutcome.mockReturnValue({ ok: false, mismatches: ['destination mismatch'] })

    const report = await reconcileStalePendingDisputeTranslations()

    expect(report.reconciled).toEqual([{ escrowId: 'escrow-1', pendingTransactionId: 'pending-1', verdict: 'DELETED_GUARD_FAILED' }])
    expect(mockLock).toHaveBeenCalledTimes(2) // economic disposition D, then escrow E
    expect(mockPendingDelete).toHaveBeenCalledWith(CONDITIONAL_DELETE)
  })

  it('the re-check finds no RESOLVED dispute at all — structurally shouldn\'t happen (the candidate query itself required one) — fails closed, reported, never deleted on an assumption', async () => {
    mockPendingFindMany.mockResolvedValue([pendingFixture()])
    mockDisputeFindFirst.mockResolvedValue(null)

    const report = await reconcileStalePendingDisputeTranslations()

    expect(report.failed).toEqual([{ escrowId: 'escrow-1', error: 'candidate query matched but no RESOLVED dispute found on re-check' }])
    expect(mockPendingDelete).not.toHaveBeenCalled()
  })

  it('a RESOLVED dispute without a durable Outcome fails closed and preserves the pending', async () => {
    mockPendingFindMany.mockResolvedValue([pendingFixture()])
    mockLoadDisputeRulingRecord.mockResolvedValue(null)

    const report = await reconcileStalePendingDisputeTranslations()

    expect(report.reconciled).toEqual([])
    expect(report.failed).toEqual([{ escrowId: 'escrow-1', error: 'missing durable Core-authoritative Outcome; refusing cleanup' }])
    expect(mockPendingDelete).not.toHaveBeenCalled()
    expect(mockValidateTranslatedOutputsAgainstOutcome).not.toHaveBeenCalled()
  })

  it('a ruling row with null outcomeContent fails closed and preserves the pending', async () => {
    mockPendingFindMany.mockResolvedValue([pendingFixture()])
    mockLoadDisputeRulingRecord.mockResolvedValue({ outcomeContent: null })

    const report = await reconcileStalePendingDisputeTranslations()

    expect(report.reconciled).toEqual([])
    expect(report.failed).toEqual([{ escrowId: 'escrow-1', error: 'missing durable Core-authoritative Outcome; refusing cleanup' }])
    expect(mockPendingDelete).not.toHaveBeenCalled()
  })

  it('fromDisputeRulingRow() produces a record with no Outcome despite outcomeContent being present — reported as failed, not silently deleted or crashed on', async () => {
    mockPendingFindMany.mockResolvedValue([pendingFixture()])
    mockFromDisputeRulingRow.mockReturnValue({ outcome: null })

    const report = await reconcileStalePendingDisputeTranslations()

    expect(report.failed).toEqual([{ escrowId: 'escrow-1', error: 'durable record has no Outcome despite outcomeContent being present' }])
    expect(mockPendingDelete).not.toHaveBeenCalled()
  })

  it('an escrow that throws mid-reconciliation lands in `failed`, not silently dropped — and does not stop the rest of the batch', async () => {
    mockPendingFindMany.mockResolvedValue([
      pendingFixture({ id: 'pending-broken', escrowId: 'escrow-broken' }),
      pendingFixture({ id: 'pending-ok', escrowId: 'escrow-ok' }),
    ])
    mockDisputeFindFirst.mockImplementation(async ({ where }: any) =>
      where.escrowId === 'escrow-broken' ? Promise.reject(new Error('DB unavailable')) : RESOLVED_DISPUTE
    )
    mockValidateTranslatedOutputsAgainstOutcome.mockReturnValue({ ok: true, mismatches: [] })

    const report = await reconcileStalePendingDisputeTranslations()

    expect(report.failed).toEqual([{ escrowId: 'escrow-broken', error: 'DB unavailable' }])
    expect(report.reconciled).toEqual([{ escrowId: 'escrow-ok', pendingTransactionId: 'pending-ok', verdict: 'LEFT_GUARD_PASSED' }])
  })

  // Issue #244 - the zero-signature snapshot nominates; only the lock-protected delete decides, and the
  // report says what it actually found (the old unconditional delete reported "deleted" regardless).
  it('a signature that arrived after the snapshot keeps the round: nothing deleted, reported as having signatures', async () => {
    mockPendingFindMany.mockResolvedValue([pendingFixture()])
    mockValidateTranslatedOutputsAgainstOutcome.mockReturnValue({ ok: false, mismatches: ['mismatch'] })
    mockPendingDelete.mockResolvedValueOnce({ count: 0 })
    mockPendingStillThere.mockResolvedValueOnce(pendingFixture({ signatures: [{ participantId: 'buyer-1' }] }))

    const report = await reconcileStalePendingDisputeTranslations()

    expect(report.reconciled).toEqual([])
    expect(report.skippedHasSignatures).toEqual(['escrow-1'])
  })

  it('a round a concurrent run already cleaned is reported as already cleaned, not as deleted by this run', async () => {
    mockPendingFindMany.mockResolvedValue([pendingFixture()])
    mockPendingDelete.mockResolvedValueOnce({ count: 0 })
    mockPendingStillThere.mockResolvedValueOnce(pendingFixture()).mockResolvedValueOnce(null)

    const report = await reconcileStalePendingDisputeTranslations()

    expect(report.reconciled).toEqual([])
    expect(report.alreadyCleaned).toEqual(['escrow-1'])
    expect(report.failed).toEqual([])
  })

  it('a delete that errors is reported as failed, never as reconciled', async () => {
    mockPendingFindMany.mockResolvedValue([pendingFixture()])
    mockValidateTranslatedOutputsAgainstOutcome.mockReturnValue({ ok: false, mismatches: ['mismatch'] })
    mockPendingDelete.mockRejectedValueOnce(new Error('connection lost'))

    const report = await reconcileStalePendingDisputeTranslations()

    expect(report.reconciled).toEqual([])
    expect(report.failed).toEqual([{ escrowId: 'escrow-1', error: 'connection lost' }])
  })
})

describe('ST-1 transactional cleanup authority (mocked service boundary; PostgreSQL proof separate)', () => {
  const authority = () => ({
    disputeId: 'dispute-1',
    rulingAppealRound: 0,
    rulingArbiterId: 'arbiter-1',
    rulingOutcome: 'RELEASE',
    rulingAuthoritySignature: 'authority-1',
    rulingAuthorityIssuedAt: new Date('2026-10-01T00:00:00Z'),
  })

  it('preserves a signed pending even if the caller snapshot had zero signatures', async () => {
    mockPendingStillThere.mockResolvedValue(pendingFixture({ signatures: [{ participantId: 'buyer-1' }] }))
    expect(await deletePendingRoundIfStillUnsigned('pending-1', 'escrow-1', authority())).toBe('SIGNED_MEANWHILE')
    expect(mockDurableOutcomeFindUnique).not.toHaveBeenCalled()
    expect(mockPendingDelete).not.toHaveBeenCalled()
  })

  it('reports an already deleted pending without recreating economic state', async () => {
    mockPendingStillThere.mockResolvedValue(null)
    expect(await deletePendingRoundIfStillUnsigned('pending-1', 'escrow-1', authority())).toBe('ALREADY_GONE')
    expect(mockPendingDelete).not.toHaveBeenCalled()
  })

  it('refuses deletion when the durable Outcome disappears between scan and locked transaction', async () => {
    mockDurableOutcomeFindUnique.mockResolvedValue(null)
    expect(await deletePendingRoundIfStillUnsigned('pending-1', 'escrow-1', authority())).toBe('PROVENANCE_REJECTED')
    expect(mockLock).toHaveBeenCalledTimes(2)
    expect(mockPendingDelete).not.toHaveBeenCalled()
  })

  it('refuses an Outcome whose immutable ruling differs from the pending generation', async () => {
    mockDurableOutcomeFindUnique.mockResolvedValue({ outcomeContent: { ruling: 'REFUND' }, toState: 'RESOLVED' })
    expect(await deletePendingRoundIfStillUnsigned('pending-1', 'escrow-1', authority())).toBe('PROVENANCE_REJECTED')
    expect(mockPendingDelete).not.toHaveBeenCalled()
  })

  it('refuses a durable record that is not a RESOLVED transition', async () => {
    mockDurableOutcomeFindUnique.mockResolvedValue({ outcomeContent: { ruling: 'RELEASE' }, toState: 'OPEN' })
    expect(await deletePendingRoundIfStillUnsigned('pending-1', 'escrow-1', authority())).toBe('PROVENANCE_REJECTED')
    expect(mockPendingDelete).not.toHaveBeenCalled()
  })

  it('refuses an Outcome without a typed ruling instead of treating non-null JSON as authority', async () => {
    mockDurableOutcomeFindUnique.mockResolvedValue({ outcomeContent: { allocations: [] }, toState: 'RESOLVED' })
    expect(await deletePendingRoundIfStillUnsigned('pending-1', 'escrow-1', authority())).toBe('PROVENANCE_REJECTED')
    expect(mockPendingDelete).not.toHaveBeenCalled()
  })

  it('refuses a changed authority issuance timestamp despite matching signature', async () => {
    mockDisputeFindUnique.mockResolvedValue({ ...RESOLVED_DISPUTE, authorityIssuedAt: new Date('2026-10-02T00:00:00Z') })
    expect(await deletePendingRoundIfStillUnsigned('pending-1', 'escrow-1', authority())).toBe('PROVENANCE_REJECTED')
    expect(mockPendingDelete).not.toHaveBeenCalled()
  })

  it('refuses deletion when a committed economic disposition authorization exists', async () => {
    mockCommittedFindUnique.mockResolvedValue({ id: 'committed-1' })
    expect(await deletePendingRoundIfStillUnsigned('pending-1', 'escrow-1', authority())).toBe('PROVENANCE_REJECTED')
    expect(mockPendingDelete).not.toHaveBeenCalled()
  })

  it('refuses deletion when the dispute generation advances after the snapshot', async () => {
    mockDisputeFindUnique.mockResolvedValue({ ...RESOLVED_DISPUTE, appealRound: 1 })
    expect(await deletePendingRoundIfStillUnsigned('pending-1', 'escrow-1', authority())).toBe('PROVENANCE_REJECTED')
    expect(mockPendingDelete).not.toHaveBeenCalled()
  })
})
