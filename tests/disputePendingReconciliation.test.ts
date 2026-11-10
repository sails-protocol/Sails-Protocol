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
const mockPendingDeleteMany = jest.fn()
const mockPendingCount = jest.fn()
const mockLock = jest.fn()
const mockDisputeFindFirst = jest.fn()
jest.mock('../src/common/database', () => ({
  prisma: {
    escrowPendingTransaction: {
      findMany: (...args: unknown[]) => mockPendingFindMany(...args),
    },
    dispute: { findFirst: (...args: unknown[]) => mockDisputeFindFirst(...args) },
  },
}))

// Issue #244 - the delete runs under the escrow lock; the mocked lock hands the callback a client with only the delete-side calls.
jest.mock('../src/modules/open-settlement/escrow-lifecycle', () => ({
  withEscrowFundingLock: (escrowId: string, fn: (tx: unknown) => unknown) => {
    mockLock(escrowId)
    return fn({ escrowPendingTransaction: { deleteMany: (...a: unknown[]) => mockPendingDeleteMany(...a), count: (...a: unknown[]) => mockPendingCount(...a) } })
  },
}))

import { reconcileStalePendingDisputeTranslations } from '../src/modules/open-settlement/dispute-pending-reconciliation'

const SIX_MIN_AGO = new Date(Date.now() - 6 * 60 * 1000)
const NOW = new Date()

function pendingFixture(overrides: Record<string, any> = {}) {
  return {
    id: 'pending-1',
    escrowId: 'escrow-1',
    unsignedPsbtBase64: 'unsigned-psbt-b64',
    createdAt: SIX_MIN_AGO,
    signatures: [],
    escrow: { id: 'escrow-1', type: 'MULTISIG' },
    ...overrides,
  }
}

const RESOLVED_DISPUTE = { id: 'dispute-1', escrowId: 'escrow-1', status: 'RESOLVED', appealRound: 0 }
const RULING_ROW_WITH_OUTCOME = { outcomeContent: { ruling: 'RELEASE' } }
const FAKE_RECORD_WITH_OUTCOME = { outcome: { content: { ruling: 'RELEASE' } } }
const CONDITIONAL_DELETE = { where: { id: 'pending-1', escrowId: 'escrow-1', signatures: { none: {} } } }

beforeEach(() => {
  jest.clearAllMocks()
  mockDisputeFindFirst.mockResolvedValue(RESOLVED_DISPUTE)
  mockLoadDisputeRulingRecord.mockResolvedValue(RULING_ROW_WITH_OUTCOME)
  mockFromDisputeRulingRow.mockReturnValue(FAKE_RECORD_WITH_OUTCOME)
  mockPendingDeleteMany.mockResolvedValue({ count: 1 })
  mockPendingCount.mockResolvedValue(0)
})

describe('reconcileStalePendingDisputeTranslations() — M9 stale pending-artifact reconciliation', () => {
  it('no candidates — a clean, empty report', async () => {
    mockPendingFindMany.mockResolvedValue([])
    const report = await reconcileStalePendingDisputeTranslations()
    expect(report).toEqual({ reconciled: [], skippedTooYoung: [], skippedHasSignatures: [], failed: [] })
  })

  it('a row with at least one collected signature is skipped, never touched — funds may already be in flight', async () => {
    mockPendingFindMany.mockResolvedValue([pendingFixture({ signatures: [{ participantId: 'buyer-1' }] })])
    const report = await reconcileStalePendingDisputeTranslations()
    expect(report.skippedHasSignatures).toEqual(['escrow-1'])
    expect(mockPendingDeleteMany).not.toHaveBeenCalled()
    expect(mockValidateTranslatedOutputsAgainstOutcome).not.toHaveBeenCalled()
  })

  it('a row younger than the safety margin is skipped — may still be a live, in-flight request', async () => {
    mockPendingFindMany.mockResolvedValue([pendingFixture({ createdAt: NOW })])
    const report = await reconcileStalePendingDisputeTranslations()
    expect(report.skippedTooYoung).toEqual(['escrow-1'])
    expect(mockPendingDeleteMany).not.toHaveBeenCalled()
  })

  it('old enough, zero signatures, re-run guard PASSES — left alone, not deleted (a legitimate pending transaction still awaiting signature collection)', async () => {
    mockPendingFindMany.mockResolvedValue([pendingFixture()])
    mockValidateTranslatedOutputsAgainstOutcome.mockReturnValue({ ok: true, mismatches: [] })

    const report = await reconcileStalePendingDisputeTranslations()

    expect(report.reconciled).toEqual([{ escrowId: 'escrow-1', pendingTransactionId: 'pending-1', verdict: 'LEFT_GUARD_PASSED' }])
    expect(mockPendingDeleteMany).not.toHaveBeenCalled()
  })

  it('old enough, zero signatures, re-run guard FAILS — deleted (zero signatures means zero fund-movement risk)', async () => {
    mockPendingFindMany.mockResolvedValue([pendingFixture()])
    mockValidateTranslatedOutputsAgainstOutcome.mockReturnValue({ ok: false, mismatches: ['destination mismatch'] })

    const report = await reconcileStalePendingDisputeTranslations()

    expect(report.reconciled).toEqual([{ escrowId: 'escrow-1', pendingTransactionId: 'pending-1', verdict: 'DELETED_GUARD_FAILED' }])
    expect(mockLock).toHaveBeenCalledWith('escrow-1')
    expect(mockPendingDeleteMany).toHaveBeenCalledWith(CONDITIONAL_DELETE)
  })

  it('the re-check finds no RESOLVED dispute at all — structurally shouldn\'t happen (the candidate query itself required one) — fails closed, reported, never deleted on an assumption', async () => {
    mockPendingFindMany.mockResolvedValue([pendingFixture()])
    mockDisputeFindFirst.mockResolvedValue(null)

    const report = await reconcileStalePendingDisputeTranslations()

    expect(report.failed).toEqual([{ escrowId: 'escrow-1', error: 'candidate query matched but no RESOLVED dispute found on re-check' }])
    expect(mockPendingDeleteMany).not.toHaveBeenCalled()
  })

  it('a RESOLVED dispute exists but has no durable Core-authoritative Outcome record — deleted (zero signatures, no fund-movement risk), reported distinctly as DELETED_NO_OUTCOME, never folded into a guard-failure', async () => {
    mockPendingFindMany.mockResolvedValue([pendingFixture()])
    mockLoadDisputeRulingRecord.mockResolvedValue(null)

    const report = await reconcileStalePendingDisputeTranslations()

    expect(report.reconciled).toEqual([{ escrowId: 'escrow-1', pendingTransactionId: 'pending-1', verdict: 'DELETED_NO_OUTCOME' }])
    expect(mockValidateTranslatedOutputsAgainstOutcome).not.toHaveBeenCalled()
  })

  it('a ruling row exists but outcomeContent is null — same DELETED_NO_OUTCOME path, not a crash', async () => {
    mockPendingFindMany.mockResolvedValue([pendingFixture()])
    mockLoadDisputeRulingRecord.mockResolvedValue({ outcomeContent: null })

    const report = await reconcileStalePendingDisputeTranslations()

    expect(report.reconciled).toEqual([{ escrowId: 'escrow-1', pendingTransactionId: 'pending-1', verdict: 'DELETED_NO_OUTCOME' }])
  })

  it('fromDisputeRulingRow() produces a record with no Outcome despite outcomeContent being present — reported as failed, not silently deleted or crashed on', async () => {
    mockPendingFindMany.mockResolvedValue([pendingFixture()])
    mockFromDisputeRulingRow.mockReturnValue({ outcome: null })

    const report = await reconcileStalePendingDisputeTranslations()

    expect(report.failed).toEqual([{ escrowId: 'escrow-1', error: 'durable record has no Outcome despite outcomeContent being present' }])
    expect(mockPendingDeleteMany).not.toHaveBeenCalled()
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

  // Issue #244 - corrected 2026-11-09: a failed delete used to be swallowed and still reported as reconciled.
  it('a delete that itself fails lands in `failed` and is never reported as reconciled', async () => {
    mockPendingFindMany.mockResolvedValue([pendingFixture()])
    mockValidateTranslatedOutputsAgainstOutcome.mockReturnValue({ ok: false, mismatches: ['mismatch'] })
    mockPendingDeleteMany.mockRejectedValueOnce(new Error('connection reset'))

    const report = await reconcileStalePendingDisputeTranslations()

    expect(report.failed).toEqual([{ escrowId: 'escrow-1', error: 'connection reset' }])
    expect(report.reconciled).toEqual([])
  })

  it.each([
    ['guard failed', () => mockValidateTranslatedOutputsAgainstOutcome.mockReturnValue({ ok: false, mismatches: ['mismatch'] })],
    ['no durable Outcome', () => mockLoadDisputeRulingRecord.mockResolvedValue(null)],
  ])('#244 (%s): a signature that arrived after the zero-signature snapshot keeps the round - skipped, never reported deleted', async (_label, arrange) => {
    mockPendingFindMany.mockResolvedValue([pendingFixture()])
    arrange()
    mockPendingDeleteMany.mockResolvedValueOnce({ count: 0 })
    mockPendingCount.mockResolvedValueOnce(1)

    const report = await reconcileStalePendingDisputeTranslations()

    expect(mockPendingDeleteMany).toHaveBeenCalledWith(CONDITIONAL_DELETE)
    expect(report.skippedHasSignatures).toEqual(['escrow-1'])
    expect(report.reconciled).toEqual([])
  })

  it('#244: a round another run already removed is neither reported deleted nor failed', async () => {
    mockPendingFindMany.mockResolvedValue([pendingFixture()])
    mockValidateTranslatedOutputsAgainstOutcome.mockReturnValue({ ok: false, mismatches: ['mismatch'] })
    mockPendingDeleteMany.mockResolvedValueOnce({ count: 0 })

    const report = await reconcileStalePendingDisputeTranslations()

    expect(report).toEqual({ reconciled: [], skippedTooYoung: [], skippedHasSignatures: [], failed: [] })
  })
})
