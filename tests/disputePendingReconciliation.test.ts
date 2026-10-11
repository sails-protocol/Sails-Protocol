// tests/disputePendingReconciliation.test.ts
//
// Sails Core Implementation Program M9 (Recovery, Execution Uncertainty &
// Semantic Reconciliation) - orchestration-level proof of
// reconcileStalePendingDisputeTranslations(): candidate filtering (age,
// signature presence), the fail-closed "no durable Outcome" path, and the
// re-run-the-guard convergence decision. The guard's own logic
// (assertTranslationMatchesOutcome/validateTranslatedOutputsAgainstOutcome)
// is proven separately, with real PSBTs, in tests/dispatchTranslationGuard.test.ts;
// here it's a controlled mock so this suite can focus on the orchestration
// around it - same division of labor tests/escrowSettlementReconciliation.test.ts
// already establishes for the sibling PASS 1/PASS 2 reconciliation module.
//
// ST-1: the decision (generation, dispute, Outcome, guard, signatures) is taken inside ONE transaction, after
// the dispute lock (D) and then the escrow lock (E). The mocked transaction below hands the callback exactly
// the surface that decision uses; the real lock order and the real interleavings are proven against
// PostgreSQL in tests/integration/st1TemporalCleanupAuthority.test.ts.

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
const mockPendingFindUnique = jest.fn()
const mockPendingDelete = jest.fn()
const mockDisputeRow = jest.fn()
const mockCommittedFindUnique = jest.fn()
const mockExecuteRaw = jest.fn()
jest.mock('../src/common/database', () => ({
  prisma: {
    escrowPendingTransaction: {
      findMany: (...args: unknown[]) => mockPendingFindMany(...args),
    },
    // ST-1 - the decision runs as deletePendingRoundIfStillUnsigned(): lock_timeout, the dispute lock, the
    // escrow lock, then the in-transaction re-reads and, only if everything is re-proven, a conditional delete.
    $transaction: (callback: (tx: unknown) => Promise<unknown>) => callback({
      $executeRaw: (...args: unknown[]) => mockExecuteRaw(...args),
      $queryRaw: (...args: unknown[]) => mockDisputeRow(...args),
      escrowPendingTransaction: {
        findUnique: (...args: unknown[]) => mockPendingFindUnique(...args),
        deleteMany: (...args: unknown[]) => mockPendingDelete(...args),
      },
      economicDispositionAuthorization: { findUnique: (...args: unknown[]) => mockCommittedFindUnique(...args) },
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

const ISSUED_AT = new Date('2026-10-01T00:00:00Z')
const RESOLVED_DISPUTE_ROW = { escrowId: 'escrow-1', status: 'RESOLVED', appealRound: 0, arbiterId: 'arbiter-1', ruling: 'RELEASE', authoritySignature: 'authority-1', authorityIssuedAt: ISSUED_AT }
const RULING_ROW_WITH_OUTCOME = { outcomeContent: { ruling: 'RELEASE' }, toState: 'RESOLVED' }
const FAKE_RECORD_WITH_OUTCOME = { outcome: { content: { ruling: 'RELEASE' } } }

beforeEach(() => {
  // clearMocks does not drop queued once-values: a once-value a test leaves behind would be consumed by the
  // next test. Every mock this suite scripts is reset, then given its default.
  for (const m of [mockPendingFindMany, mockPendingFindUnique, mockPendingDelete, mockDisputeRow, mockCommittedFindUnique,
    mockExecuteRaw, mockLoadDisputeRulingRecord, mockFromDisputeRulingRow, mockValidateTranslatedOutputsAgainstOutcome]) m.mockReset()
  mockExecuteRaw.mockResolvedValue(0)
  mockPendingFindUnique.mockResolvedValue(pendingFixture())
  mockDisputeRow.mockResolvedValue([RESOLVED_DISPUTE_ROW])
  mockCommittedFindUnique.mockResolvedValue(null)
  mockLoadDisputeRulingRecord.mockResolvedValue(RULING_ROW_WITH_OUTCOME)
  mockFromDisputeRulingRow.mockReturnValue(FAKE_RECORD_WITH_OUTCOME)
  mockPendingDelete.mockResolvedValue({ count: 1 })
})

const CONDITIONAL_DELETE = { where: { id: 'pending-1', escrowId: 'escrow-1', signatures: { none: {} }, disputeId: 'dispute-1', rulingAppealRound: 0, rulingArbiterId: 'arbiter-1', rulingOutcome: 'RELEASE', rulingAuthoritySignature: 'authority-1', rulingAuthorityIssuedAt: new Date('2026-10-01T00:00:00Z') } }

// The values of the two advisory-lock statements, in the order they were issued (the first $executeRaw is
// lock_timeout; its value is the timeout, not a lock key).
function lockKeysInOrder(): string[] {
  return mockExecuteRaw.mock.calls
    .filter(([strings]) => String(strings.join('')).includes('pg_advisory_xact_lock'))
    .map(([, value]) => String(value))
}

describe('reconcileStalePendingDisputeTranslations() - M9 stale pending-artifact reconciliation', () => {
  it('no candidates - a clean, empty report', async () => {
    mockPendingFindMany.mockResolvedValue([])
    const report = await reconcileStalePendingDisputeTranslations()
    expect(report).toEqual({ reconciled: [], skippedTooYoung: [], skippedHasSignatures: [], alreadyCleaned: [], failed: [] })
  })

  it('a row with at least one collected signature is skipped, never touched - funds may already be in flight', async () => {
    mockPendingFindMany.mockResolvedValue([pendingFixture({ signatures: [{ participantId: 'buyer-1' }] })])
    const report = await reconcileStalePendingDisputeTranslations()
    expect(report.skippedHasSignatures).toEqual(['escrow-1'])
    expect(mockExecuteRaw).not.toHaveBeenCalled()
    expect(mockPendingDelete).not.toHaveBeenCalled()
    expect(mockValidateTranslatedOutputsAgainstOutcome).not.toHaveBeenCalled()
  })

  it('a row younger than the safety margin is skipped - may still be a live, in-flight request', async () => {
    mockPendingFindMany.mockResolvedValue([pendingFixture({ createdAt: NOW })])
    const report = await reconcileStalePendingDisputeTranslations()
    expect(report.skippedTooYoung).toEqual(['escrow-1'])
    expect(mockExecuteRaw).not.toHaveBeenCalled()
    expect(mockPendingDelete).not.toHaveBeenCalled()
  })

  it('a row without a complete recorded ruling generation is reported, never deleted', async () => {
    mockPendingFindMany.mockResolvedValue([pendingFixture({ disputeId: null })])
    const report = await reconcileStalePendingDisputeTranslations()
    expect(report.failed).toEqual([{ escrowId: 'escrow-1', error: 'missing or ambiguous pending ruling provenance; refusing cleanup' }])
    expect(mockExecuteRaw).not.toHaveBeenCalled()
    expect(mockPendingDelete).not.toHaveBeenCalled()
  })

  it('old enough, zero signatures, re-run guard PASSES - left alone, not deleted (a legitimate pending transaction still awaiting signature collection)', async () => {
    mockPendingFindMany.mockResolvedValue([pendingFixture()])
    mockValidateTranslatedOutputsAgainstOutcome.mockReturnValue({ ok: true, mismatches: [] })

    const report = await reconcileStalePendingDisputeTranslations()

    expect(report.reconciled).toEqual([{ escrowId: 'escrow-1', pendingTransactionId: 'pending-1', verdict: 'LEFT_GUARD_PASSED' }])
    expect(mockPendingDelete).not.toHaveBeenCalled()
  })

  it('old enough, zero signatures, re-run guard FAILS - deleted, after the dispute lock and then the escrow lock', async () => {
    mockPendingFindMany.mockResolvedValue([pendingFixture()])
    mockValidateTranslatedOutputsAgainstOutcome.mockReturnValue({ ok: false, mismatches: ['destination mismatch'] })

    const report = await reconcileStalePendingDisputeTranslations()

    expect(report.reconciled).toEqual([{ escrowId: 'escrow-1', pendingTransactionId: 'pending-1', verdict: 'DELETED_GUARD_FAILED' }])
    expect(lockKeysInOrder()).toEqual(['economic-disposition:dispute-1', 'escrow-1'])
    expect(mockPendingDelete).toHaveBeenCalledWith(CONDITIONAL_DELETE)
    // the Outcome is read through the transaction, for this exact appeal round
    expect(mockLoadDisputeRulingRecord).toHaveBeenCalledWith('escrow-1', 0, expect.anything())
  })

  it('the dispute is no longer RESOLVED for the recorded generation (appealed, re-ruled, reassigned) - the round no longer authorizes cleanup: reported, never deleted', async () => {
    mockPendingFindMany.mockResolvedValue([pendingFixture()])
    mockValidateTranslatedOutputsAgainstOutcome.mockReturnValue({ ok: false, mismatches: ['mismatch'] })
    for (const moved of [
      { status: 'APPEALED', ruling: null, appealRound: 1 },
      { appealRound: 1 },
      { arbiterId: 'arbiter-2' },
      { ruling: 'REFUND' },
      { authoritySignature: 'authority-2' },
      { authorityIssuedAt: new Date('2026-10-01T00:00:01Z') },
      { authorityIssuedAt: null },
      { escrowId: 'escrow-other' },
    ]) {
      mockDisputeRow.mockResolvedValueOnce([{ ...RESOLVED_DISPUTE_ROW, ...moved }])
      const report = await reconcileStalePendingDisputeTranslations()
      expect(report.failed).toEqual([{ escrowId: 'escrow-1', error: 'pending ruling generation no longer authorizes cleanup' }])
    }
    mockDisputeRow.mockResolvedValueOnce([])
    expect((await reconcileStalePendingDisputeTranslations()).failed).toHaveLength(1)
    expect(mockPendingDelete).not.toHaveBeenCalled()
  })

  it('the pending row was replaced by another generation between snapshot and lock - rejected, the new generation untouched', async () => {
    mockPendingFindMany.mockResolvedValue([pendingFixture()])
    mockPendingFindUnique.mockResolvedValue(pendingFixture({ rulingAppealRound: 1, rulingAuthoritySignature: 'authority-2' }))

    const report = await reconcileStalePendingDisputeTranslations()

    expect(report.failed).toEqual([{ escrowId: 'escrow-1', error: 'pending ruling generation no longer authorizes cleanup' }])
    expect(mockPendingDelete).not.toHaveBeenCalled()
  })

  it('a committed Economic Disposition Authorization names the round - deletion is refused', async () => {
    mockPendingFindMany.mockResolvedValue([pendingFixture()])
    mockCommittedFindUnique.mockResolvedValue({ pendingOperationId: 'pending-1' })
    mockValidateTranslatedOutputsAgainstOutcome.mockReturnValue({ ok: false, mismatches: ['mismatch'] })

    const report = await reconcileStalePendingDisputeTranslations()

    expect(report.failed).toEqual([{ escrowId: 'escrow-1', error: 'pending ruling generation no longer authorizes cleanup' }])
    expect(mockPendingDelete).not.toHaveBeenCalled()
  })

  it('a RESOLVED dispute has no durable Core-authoritative Outcome record - fails closed: reported, NEVER deleted (there is no DELETED_NO_OUTCOME)', async () => {
    mockPendingFindMany.mockResolvedValue([pendingFixture()])
    mockLoadDisputeRulingRecord.mockResolvedValue(null)

    const report = await reconcileStalePendingDisputeTranslations()

    expect(report.reconciled).toEqual([])
    expect(report.failed).toEqual([{ escrowId: 'escrow-1', error: 'no durable Core-authoritative Outcome for the pending ruling generation; refusing cleanup' }])
    expect(mockPendingDelete).not.toHaveBeenCalled()
    expect(mockValidateTranslatedOutputsAgainstOutcome).not.toHaveBeenCalled()
  })

  it('an Outcome that is not the RESOLVED transition of THIS ruling is inconsistent durable state: reported, never deleted', async () => {
    mockPendingFindMany.mockResolvedValue([pendingFixture()])
    mockValidateTranslatedOutputsAgainstOutcome.mockReturnValue({ ok: false, mismatches: ['mismatch'] })
    for (const row of [
      { outcomeContent: { ruling: 'REFUND' }, toState: 'RESOLVED' }, // another ruling
      { outcomeContent: { ruling: 'RELEASE' }, toState: 'OPENED' }, // not a terminal transition
      { outcomeContent: {}, toState: 'RESOLVED' }, // no typed ruling
      { outcomeContent: 'RELEASE', toState: 'RESOLVED' }, // non-object JSON is not authority
      { outcomeContent: ['RELEASE'], toState: 'RESOLVED' },
    ]) {
      mockLoadDisputeRulingRecord.mockResolvedValueOnce(row)
      const report = await reconcileStalePendingDisputeTranslations()
      expect(report.failed).toEqual([{ escrowId: 'escrow-1', error: 'durable Outcome does not match pending ruling generation; refusing cleanup' }])
    }
    expect(mockPendingDelete).not.toHaveBeenCalled()
  })

  it('a ruling row exists but outcomeContent is null - the same fail-closed path, not a crash and not a delete', async () => {
    mockPendingFindMany.mockResolvedValue([pendingFixture()])
    mockLoadDisputeRulingRecord.mockResolvedValue({ outcomeContent: null })

    const report = await reconcileStalePendingDisputeTranslations()

    expect(report.reconciled).toEqual([])
    expect(report.failed).toHaveLength(1)
    expect(mockPendingDelete).not.toHaveBeenCalled()
  })

  it('fromDisputeRulingRow() produces a record with no Outcome despite outcomeContent being present - fails closed, not deleted', async () => {
    mockPendingFindMany.mockResolvedValue([pendingFixture()])
    mockFromDisputeRulingRow.mockReturnValue({ outcome: null })

    const report = await reconcileStalePendingDisputeTranslations()

    expect(report.failed).toHaveLength(1)
    expect(mockPendingDelete).not.toHaveBeenCalled()
  })

  it('an escrow that throws mid-reconciliation lands in `failed`, not silently dropped - and does not stop the rest of the batch', async () => {
    mockPendingFindMany.mockResolvedValue([
      pendingFixture({ id: 'pending-broken', escrowId: 'escrow-broken' }),
      pendingFixture({ id: 'pending-ok', escrowId: 'escrow-ok' }),
    ])
    mockPendingFindUnique.mockImplementation(async ({ where }: any) =>
      where.id === 'pending-broken' ? Promise.reject(new Error('DB unavailable')) : pendingFixture({ id: 'pending-ok', escrowId: 'escrow-ok' })
    )
    mockDisputeRow.mockResolvedValue([{ ...RESOLVED_DISPUTE_ROW, escrowId: 'escrow-ok' }])
    mockValidateTranslatedOutputsAgainstOutcome.mockReturnValue({ ok: true, mismatches: [] })

    const report = await reconcileStalePendingDisputeTranslations()

    expect(report.failed).toEqual([{ escrowId: 'escrow-broken', error: 'DB unavailable' }])
    expect(report.reconciled).toEqual([{ escrowId: 'escrow-ok', pendingTransactionId: 'pending-ok', verdict: 'LEFT_GUARD_PASSED' }])
  })

  it('a lock wait that times out is reported as failed and deletes nothing (retried by the next sweep)', async () => {
    mockPendingFindMany.mockResolvedValue([pendingFixture()])
    mockExecuteRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      if (String(strings.join('')).includes('pg_advisory_xact_lock')) throw new Error('canceling statement due to lock timeout')
      return 0
    })

    const report = await reconcileStalePendingDisputeTranslations()

    expect(report.failed).toEqual([{ escrowId: 'escrow-1', error: 'canceling statement due to lock timeout' }])
    expect(mockPendingDelete).not.toHaveBeenCalled()
  })

  // ST-1 / #244 - the zero-signature snapshot nominates; only the lock-protected decision deletes, and the
  // report says what it actually found.
  it('a signature that arrived after the snapshot keeps the round: nothing deleted, reported as having signatures', async () => {
    mockPendingFindMany.mockResolvedValue([pendingFixture()])
    mockPendingFindUnique.mockResolvedValue(pendingFixture({ signatures: [{ participantId: 'buyer-1' }] }))

    const report = await reconcileStalePendingDisputeTranslations()

    expect(report.reconciled).toEqual([])
    expect(report.skippedHasSignatures).toEqual(['escrow-1'])
    expect(mockPendingDelete).not.toHaveBeenCalled()
  })

  it('a round a concurrent run already cleaned is reported as already cleaned, not as deleted by this run', async () => {
    mockPendingFindMany.mockResolvedValue([pendingFixture()])
    mockPendingFindUnique.mockResolvedValue(null)

    const report = await reconcileStalePendingDisputeTranslations()

    expect(report.reconciled).toEqual([])
    expect(report.alreadyCleaned).toEqual(['escrow-1'])
    expect(report.failed).toEqual([])
  })

  it('the conditional delete matches nothing and the round is still there - treated as signed meanwhile, not as deleted', async () => {
    mockPendingFindMany.mockResolvedValue([pendingFixture()])
    mockValidateTranslatedOutputsAgainstOutcome.mockReturnValue({ ok: false, mismatches: ['mismatch'] })
    mockPendingDelete.mockResolvedValue({ count: 0 })
    mockPendingFindUnique.mockResolvedValueOnce(pendingFixture()).mockResolvedValueOnce({ id: 'pending-1' })

    const report = await reconcileStalePendingDisputeTranslations()

    expect(report.reconciled).toEqual([])
    expect(report.skippedHasSignatures).toEqual(['escrow-1'])
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

describe('deletePendingRoundIfStillUnsigned() - ST-1 transaction boundary', () => {
  const generation = {
    disputeId: 'dispute-1', rulingAppealRound: 0, rulingArbiterId: 'arbiter-1',
    rulingOutcome: 'RELEASE', rulingAuthoritySignature: 'authority-1', rulingAuthorityIssuedAt: ISSUED_AT,
  }
  const decide = () => deletePendingRoundIfStillUnsigned('pending-1', 'escrow-1', generation)

  beforeEach(() => {
    mockValidateTranslatedOutputsAgainstOutcome.mockReturnValue({ ok: false, mismatches: ['mismatch'] })
  })

  it('refuses a legacy caller without a complete generation before taking any lock', async () => {
    expect(await deletePendingRoundIfStillUnsigned('pending-1', 'escrow-1')).toBe('PROVENANCE_REJECTED')
    expect(mockExecuteRaw).not.toHaveBeenCalled()
    expect(mockPendingDelete).not.toHaveBeenCalled()
  })

  it('takes the dispute lock, then the escrow lock, and deletes only a round that is still the recorded generation', async () => {
    expect(await decide()).toBe('DELETED')
    expect(lockKeysInOrder()).toEqual(['economic-disposition:dispute-1', 'escrow-1'])
    expect(mockPendingDelete).toHaveBeenCalledWith(CONDITIONAL_DELETE)
  })

  it('a round that passes the guard is left alone', async () => {
    mockValidateTranslatedOutputsAgainstOutcome.mockReturnValue({ ok: true, mismatches: [] })
    expect(await decide()).toBe('GUARD_PASSED')
    expect(mockPendingDelete).not.toHaveBeenCalled()
  })

  it('refuses a pending row of another escrow', async () => {
    mockPendingFindUnique.mockResolvedValue(pendingFixture({ escrowId: 'escrow-other' }))
    expect(await decide()).toBe('PROVENANCE_REJECTED')
    expect(mockPendingDelete).not.toHaveBeenCalled()
  })

  it('refuses a round whose recorded generation differs from the one the caller holds (any field)', async () => {
    for (const changed of [
      { rulingAuthoritySignature: 'authority-2' }, { rulingAppealRound: 1 }, { rulingArbiterId: 'arbiter-2' },
      { rulingOutcome: 'REFUND' }, { disputeId: 'dispute-2' }, { rulingAuthorityIssuedAt: new Date('2026-10-01T00:00:01Z') },
    ]) {
      mockPendingFindUnique.mockResolvedValueOnce(pendingFixture(changed))
      expect(await decide()).toBe('PROVENANCE_REJECTED')
    }
    expect(mockPendingDelete).not.toHaveBeenCalled()
  })

  it('preserves a round that has a signature even though the snapshot of the caller had none', async () => {
    mockPendingFindUnique.mockResolvedValue(pendingFixture({ signatures: [{ participantId: 'buyer-1' }] }))
    expect(await decide()).toBe('SIGNED_MEANWHILE')
    expect(mockPendingDelete).not.toHaveBeenCalled()
  })

  it('reports an already deleted round without recreating anything', async () => {
    mockPendingFindUnique.mockResolvedValue(null)
    expect(await decide()).toBe('ALREADY_GONE')
    expect(mockPendingDelete).not.toHaveBeenCalled()
  })

  it('refuses when the durable Outcome disappears between the scan and the locked transaction', async () => {
    mockLoadDisputeRulingRecord.mockResolvedValue(null)
    expect(await decide()).toBe('OUTCOME_ABSENT')
    expect(mockPendingDelete).not.toHaveBeenCalled()
  })

  it('refuses an Outcome whose immutable ruling differs from the generation', async () => {
    mockLoadDisputeRulingRecord.mockResolvedValue({ outcomeContent: { ruling: 'REFUND' }, toState: 'RESOLVED' })
    expect(await decide()).toBe('OUTCOME_MISMATCH')
    expect(mockPendingDelete).not.toHaveBeenCalled()
  })

  it('refuses a changed live authority issuance timestamp despite a matching signature', async () => {
    mockDisputeRow.mockResolvedValue([{ ...RESOLVED_DISPUTE_ROW, authorityIssuedAt: new Date('2026-10-01T00:00:01Z') }])
    expect(await decide()).toBe('PROVENANCE_REJECTED')
    expect(mockPendingDelete).not.toHaveBeenCalled()
  })

  it('refuses when a committed economic disposition authorization exists', async () => {
    mockCommittedFindUnique.mockResolvedValue({ pendingOperationId: 'pending-1' })
    expect(await decide()).toBe('PROVENANCE_REJECTED')
    expect(mockPendingDelete).not.toHaveBeenCalled()
  })

  it('refuses when the dispute generation advanced after the snapshot', async () => {
    mockDisputeRow.mockResolvedValue([{ ...RESOLVED_DISPUTE_ROW, appealRound: 1, status: 'APPEALED', ruling: null }])
    expect(await decide()).toBe('PROVENANCE_REJECTED')
    expect(mockPendingDelete).not.toHaveBeenCalled()
  })
})
