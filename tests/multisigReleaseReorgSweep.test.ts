// tests/multisigReleaseReorgSweep.test.ts
//
// Sails Core Implementation Program M9-F (Release-Leg Finality & Reorg
// Closure) — sweepMultisigReleaseReorgs() unit-level proof, mirroring
// tests/multisigFeeReorgSweep.test.ts's own established pattern: mocked
// Prisma + mocked explorer fetch, no real database or network. Proves
// the DETECTION/CLASSIFICATION logic (Worlds A-E) and that the real
// chain — never a cached evidence row — decides the outcome. The two
// candidate queries (window-bounded monitored escrows, newest-first
// baseline batch) run against real PostgreSQL in
// tests/integration/feeReleaseReorgIdempotency.test.ts; here they are
// answered with the rows they would return.

jest.mock('../src/config', () => ({
  config: {
    trade: { multisigReorgSafetyWindowBlocks: 100 },
    multisig: { explorerApiUrl: 'https://mempool.space/testnet/api' },
  },
}))

// The sweep asks three questions: does any terminal MULTISIG release exist
// (EXISTS), which escrows with evidence are not yet buried (LATERAL), and
// which escrows still have no evidence at all (NOT EXISTS, batched).
const mockAnyRelease = jest.fn()
const mockMonitored = jest.fn()
const mockBaseline = jest.fn()
jest.mock('../src/common/database', () => ({
  prisma: {
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?')
      if (sql.includes('LATERAL')) return mockMonitored(sql, ...values)
      if (sql.includes('NOT EXISTS')) return mockBaseline(sql, ...values)
      return mockAnyRelease()
    },
  },
}))

const mockRecord = jest.fn()
const mockListForEscrow = jest.fn()
jest.mock('../src/modules/open-settlement/escrow-release-evidence-repository', () => ({
  escrowReleaseEvidenceRepository: {
    record: (...args: unknown[]) => mockRecord(...args),
    listForEscrow: (...args: unknown[]) => mockListForEscrow(...args),
  },
}))

// Every write happens inside the escrow's lock; the fake lock hands the
// callback a marker transaction so the tests can see the write used it.
const LOCK_TX = { lockTx: true }
const mockWithEscrowFundingLock = jest.fn()
jest.mock('../src/modules/open-settlement/escrow-lifecycle', () => ({
  withEscrowFundingLock: (escrowId: string, fn: (tx: unknown) => Promise<unknown>) => mockWithEscrowFundingLock(escrowId, fn),
}))

const fetchMock = jest.fn()

import { sweepMultisigReleaseReorgs, BASELINE_BATCH_SIZE } from '../src/modules/open-settlement/multisig-release-reorg-sweep'

const TXID = 'a'.repeat(64)
const CONFLICT_TXID = 'c'.repeat(64)

// A candidate row as the sweep's queries return it: the escrow plus its
// latest release evidence (all null for a baseline candidate).
function escrowFixture(overrides: Record<string, any> = {}) {
  return {
    id: 'escrow-1', txReleaseId: TXID, txLockId: 'f'.repeat(64), txLockVout: 0,
    lastEvidenceId: null, lastKind: null, lastTxid: null,
    ...overrides,
  }
}

function withLast(kind: string, overrides: Record<string, any> = {}) {
  return escrowFixture({ lastEvidenceId: 'evidence-1', lastKind: kind, lastTxid: TXID, ...overrides })
}

// The escrow's evidence as re-read under the lock.
function evidenceRow(id: string, kind: string, overrides: Record<string, any> = {}) {
  return { id, kind, txid: TXID, observedAtHeight: 800_000, recordedAt: new Date('2026-09-01T00:00:00Z'), ...overrides }
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(global as any).fetch = fetchMock
  mockAnyRelease.mockResolvedValue([{ any: true }])
  mockMonitored.mockResolvedValue([])
  mockBaseline.mockResolvedValue([])
  mockListForEscrow.mockResolvedValue([])
  mockRecord.mockResolvedValue({})
  mockWithEscrowFundingLock.mockImplementation((_escrowId: string, fn: (tx: unknown) => Promise<unknown>) => fn(LOCK_TX))
})

// Two DISTINCT chain-truth primitives (fetchTransactionExistence,
// fetchTransactionConfirmationStatus) hit the IDENTICAL `/tx/:txid/status`
// URL — the sweep calls the first, then (only for a genuinely NEW
// baseline/RECONFIRMED observation) the second, in that fixed order. A
// stateless URL-keyed mock cannot tell them apart; a small call-order
// queue can.
function mockChain({
  tipHeight,
  existence,
  confirmedStatus,
  outspend,
}: {
  tipHeight: number
  existence?: { exists: boolean; confirmed: boolean }
  confirmedStatus?: { confirmed: boolean; block_height?: number }
  outspend?: { spent: boolean; txid?: string }
}) {
  const statusResponses: any[] = []
  if (existence) {
    statusResponses.push(existence.exists ? { ok: true, json: async () => ({ confirmed: existence.confirmed }) } : { status: 404, ok: false })
  }
  statusResponses.push({ ok: true, json: async () => (confirmedStatus ?? { confirmed: true, block_height: 800_000 }) })
  let statusCallCount = 0

  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/blocks/tip/height')) return Promise.resolve({ ok: true, text: async () => String(tipHeight) })
    if (url.includes('/outspend/')) {
      return Promise.resolve({ ok: true, json: async () => (outspend ?? { spent: false }) })
    }
    if (url.includes('/status')) {
      const response = statusResponses[Math.min(statusCallCount, statusResponses.length - 1)]
      statusCallCount += 1
      return Promise.resolve(response)
    }
    return Promise.resolve({ ok: true, json: async () => ({}) })
  })
}

describe('sweepMultisigReleaseReorgs() — Sails M9-F, C18 closure', () => {
  it('no candidates — a clean, empty result, no explorer call at all', async () => {
    mockAnyRelease.mockResolvedValue([{ any: false }])
    const result = await sweepMultisigReleaseReorgs()
    expect(result.observedBaseline).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mockMonitored).not.toHaveBeenCalled()
    expect(mockBaseline).not.toHaveBeenCalled()
  })

  it('World A, first-ever observation: canonical + confirmed, no prior baseline — records OBSERVED_CONFIRMED under the escrow lock', async () => {
    mockBaseline.mockResolvedValue([escrowFixture()])
    mockListForEscrow.mockResolvedValue([])
    mockChain({ tipHeight: 800_010, existence: { exists: true, confirmed: true }, confirmedStatus: { confirmed: true, block_height: 800_000 } })

    const result = await sweepMultisigReleaseReorgs()

    expect(result.observedBaseline).toEqual(['escrow-1'])
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ escrowId: 'escrow-1', kind: 'OBSERVED_CONFIRMED', txid: TXID, observedAtHeight: 800_000, tipHeightAtObservation: 800_010 }), LOCK_TX)
  })

  it('World A, trustworthy baseline already recorded and still within the safety window — left alone, no new evidence written', async () => {
    mockMonitored.mockResolvedValue([withLast('OBSERVED_CONFIRMED')])
    mockChain({ tipHeight: 800_010, existence: { exists: true, confirmed: true } })

    const result = await sweepMultisigReleaseReorgs()

    expect(result.stillGood).toEqual(['escrow-1'])
    expect(mockRecord).not.toHaveBeenCalled()
  })

  it('World A after a prior REORGED_INVALIDATED — the same txid confirmed again records RECONFIRMED, never silently overwriting the old row', async () => {
    mockMonitored.mockResolvedValue([withLast('REORGED_INVALIDATED', { lastEvidenceId: 'evidence-2' })])
    mockListForEscrow.mockResolvedValue([evidenceRow('evidence-1', 'OBSERVED_CONFIRMED'), evidenceRow('evidence-2', 'REORGED_INVALIDATED', { observedAtHeight: null, recordedAt: new Date('2026-09-02T00:00:00Z') })])
    mockChain({ tipHeight: 800_010, existence: { exists: true, confirmed: true }, confirmedStatus: { confirmed: true, block_height: 800_005 } })

    const result = await sweepMultisigReleaseReorgs()

    expect(result.reconfirmed).toEqual(['escrow-1'])
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ kind: 'RECONFIRMED', txid: TXID }), LOCK_TX)
  })

  it('World B: mempool-only (exists but not confirmed) — waits, records nothing yet', async () => {
    mockBaseline.mockResolvedValue([escrowFixture()])
    mockChain({ tipHeight: 800_010, existence: { exists: true, confirmed: false } })

    const result = await sweepMultisigReleaseReorgs()

    expect(result.stillPending).toEqual(['escrow-1'])
    expect(mockRecord).not.toHaveBeenCalled()
  })

  it('World C: T absent, funding outpoint unspent — records REORGED_INVALIDATED and flags manual review, never auto-rebroadcasts', async () => {
    mockMonitored.mockResolvedValue([withLast('OBSERVED_CONFIRMED')])
    mockListForEscrow.mockResolvedValue([evidenceRow('evidence-1', 'OBSERVED_CONFIRMED')])
    mockChain({ tipHeight: 800_010, existence: { exists: false, confirmed: false }, outspend: { spent: false } })

    const result = await sweepMultisigReleaseReorgs()

    expect(result.requiresManualReview).toHaveLength(1)
    expect(result.requiresManualReview[0].escrowId).toBe('escrow-1')
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ kind: 'REORGED_INVALIDATED', txid: TXID, note: expect.stringContaining('exact rebroadcast is not possible') }), LOCK_TX)
  })

  it('World C already recorded — the next pass reports it as already flagged and writes nothing', async () => {
    mockMonitored.mockResolvedValue([withLast('REORGED_INVALIDATED')])
    mockChain({ tipHeight: 800_010, existence: { exists: false, confirmed: false }, outspend: { spent: false } })

    const result = await sweepMultisigReleaseReorgs()

    expect(result.alreadyFlagged).toEqual(['escrow-1'])
    expect(result.requiresManualReview).toEqual([])
    expect(mockRecord).not.toHaveBeenCalled()
    expect(mockWithEscrowFundingLock).not.toHaveBeenCalled()
  })

  it('World D: T absent, funding outpoint spent by a DIFFERENT transaction — records AMBIGUOUS, fails closed, never reinterprets as success', async () => {
    mockMonitored.mockResolvedValue([withLast('OBSERVED_CONFIRMED')])
    mockListForEscrow.mockResolvedValue([evidenceRow('evidence-1', 'OBSERVED_CONFIRMED')])
    mockChain({ tipHeight: 800_010, existence: { exists: false, confirmed: false }, outspend: { spent: true, txid: CONFLICT_TXID } })

    const result = await sweepMultisigReleaseReorgs()

    expect(result.requiresManualReview).toHaveLength(1)
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ kind: 'AMBIGUOUS', txid: CONFLICT_TXID }), LOCK_TX)
  })

  it('World D already recorded for the same conflicting spend — reported as already flagged, not re-recorded', async () => {
    mockMonitored.mockResolvedValue([withLast('AMBIGUOUS', { lastTxid: CONFLICT_TXID })])
    mockChain({ tipHeight: 800_010, existence: { exists: false, confirmed: false }, outspend: { spent: true, txid: CONFLICT_TXID } })

    const result = await sweepMultisigReleaseReorgs()

    expect(result.alreadyFlagged).toEqual(['escrow-1'])
    expect(result.requiresManualReview).toEqual([])
    expect(mockRecord).not.toHaveBeenCalled()
  })

  it('World D with a DIFFERENT conflicting spend than the one already recorded — a new fact, recorded', async () => {
    const OTHER_CONFLICT = 'd'.repeat(64)
    mockMonitored.mockResolvedValue([withLast('AMBIGUOUS', { lastTxid: OTHER_CONFLICT })])
    mockListForEscrow.mockResolvedValue([evidenceRow('evidence-1', 'AMBIGUOUS', { txid: OTHER_CONFLICT })])
    mockChain({ tipHeight: 800_010, existence: { exists: false, confirmed: false }, outspend: { spent: true, txid: CONFLICT_TXID } })

    const result = await sweepMultisigReleaseReorgs()

    expect(result.requiresManualReview.map((r) => r.escrowId)).toEqual(['escrow-1'])
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ escrowId: 'escrow-1', kind: 'AMBIGUOUS', txid: CONFLICT_TXID }), LOCK_TX)
  })

  it('a stale observation — the latest evidence changed after this pass read it — is discarded, never written a second time', async () => {
    mockMonitored.mockResolvedValue([withLast('OBSERVED_CONFIRMED')])
    // Another node recorded REORGED_INVALIDATED between this pass's read and its lock.
    mockListForEscrow.mockResolvedValue([evidenceRow('evidence-1', 'OBSERVED_CONFIRMED'), evidenceRow('evidence-2', 'REORGED_INVALIDATED', { recordedAt: new Date('2026-09-02T00:00:00Z') })])
    mockChain({ tipHeight: 800_010, existence: { exists: false, confirmed: false }, outspend: { spent: false } })

    const result = await sweepMultisigReleaseReorgs()

    expect(result.superseded).toEqual(['escrow-1'])
    expect(result.requiresManualReview).toEqual([])
    expect(mockRecord).not.toHaveBeenCalled()
  })

  it('explorer indexing lag: existence check 404s but outspend confirms the SAME txid actually spent it — converges without a spurious reorg record', async () => {
    mockMonitored.mockResolvedValue([withLast('OBSERVED_CONFIRMED')])
    mockChain({ tipHeight: 800_010, existence: { exists: false, confirmed: false }, outspend: { spent: true, txid: TXID } })

    const result = await sweepMultisigReleaseReorgs()

    expect(result.stillGood).toEqual(['escrow-1'])
    expect(result.requiresManualReview).toEqual([])
    expect(mockRecord).not.toHaveBeenCalled()
  })

  it('legacy escrow with no recorded funding vout — never guesses, fails closed as manual review, no outspend call attempted', async () => {
    mockMonitored.mockResolvedValue([withLast('OBSERVED_CONFIRMED', { txLockVout: null })])
    mockChain({ tipHeight: 800_010, existence: { exists: false, confirmed: false } })

    const result = await sweepMultisigReleaseReorgs()

    expect(result.requiresManualReview).toHaveLength(1)
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/outspend/'))
    expect(mockRecord).not.toHaveBeenCalled()
  })

  it('buried deep enough (past the safety window) — never selected: the query bound is tip - window + 1, and only the tip-height call is made', async () => {
    mockChain({ tipHeight: 800_010 }) // an escrow observed at 700_000 (100_011 deep) is not returned by the monitored query

    const result = await sweepMultisigReleaseReorgs()

    const [sql, lowestInWindow] = mockMonitored.mock.calls[0]
    expect(sql).toMatch(/"observedAtHeight" < \?/)
    expect(lowestInWindow).toBe(800_010 - 100 + 1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.stillGood).toEqual([])
  })

  it('escrows with no evidence yet are claimed in a bounded batch: never-attempted newest first, then least recently attempted, stamped durably', async () => {
    mockChain({ tipHeight: 800_010 })

    await sweepMultisigReleaseReorgs()

    const [sql, batchSize, stampedAt] = mockBaseline.mock.calls[0]
    expect(sql).toMatch(/ORDER BY e\."releaseBaselineAttemptedAt" ASC NULLS FIRST, COALESCE\(e\."releasedAt", e\."updatedAt"\) DESC, e\.id/)
    expect(sql).toMatch(/FOR UPDATE OF e SKIP LOCKED/)
    expect(sql).toMatch(/SET "releaseBaselineAttemptedAt" = \?/)
    expect(batchSize).toBe(BASELINE_BATCH_SIZE)
    expect(stampedAt).toBeInstanceOf(Date)
  })

  it('World E: explorer UNKNOWN (non-404 failure) — lands in failed, never coerced into "absent"', async () => {
    mockBaseline.mockResolvedValue([escrowFixture()])
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/blocks/tip/height')) return Promise.resolve({ ok: true, text: async () => '800010' })
      if (url.includes('/status')) return Promise.resolve({ status: 503, ok: false })
      return Promise.resolve({ ok: true, json: async () => ({}) })
    })

    const result = await sweepMultisigReleaseReorgs()

    expect(result.failed).toHaveLength(1)
    expect(result.requiresManualReview).toEqual([])
  })

  it('an escrow that throws mid-sweep lands in failed, not silently dropped — and does not stop the rest of the batch', async () => {
    mockBaseline.mockResolvedValue([escrowFixture({ id: 'escrow-broken' }), escrowFixture({ id: 'escrow-ok' })])
    mockWithEscrowFundingLock.mockImplementation((escrowId: string, fn: (tx: unknown) => Promise<unknown>) =>
      escrowId === 'escrow-broken' ? Promise.reject(new Error('DB unavailable')) : fn(LOCK_TX))
    mockChain({ tipHeight: 800_010, existence: { exists: true, confirmed: true }, confirmedStatus: { confirmed: true, block_height: 800_000 } })

    const result = await sweepMultisigReleaseReorgs()

    expect(result.failed).toEqual([{ escrowId: 'escrow-broken', error: 'DB unavailable' }])
    expect(result.observedBaseline).toEqual(['escrow-ok'])
  })
})
