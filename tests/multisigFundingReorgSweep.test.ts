// tests/multisigFundingReorgSweep.test.ts
//
// Missão 11 Fase 9.1 §1/§3 — sweepMultisigFundingReorgs() unit-level
// proof of the full evidence-writing state machine (supersedes the
// Fase 8.1 LB-08(A) log-only version). Mocked Prisma + mocked
// multisigProvider.rescanFunding(), no real database or network.

jest.mock('../src/config', () => ({
  config: { multisig: { requiredConfirmations: 2 } },
}))

const mockEscrowFindMany = jest.fn()
const mockParticipantKeyFindMany = jest.fn()
// Missão 11 Fase 9.3 — sweepMultisigFundingReorgs()'s per-escrow body now
// runs inside withEscrowFundingLock() (escrow-lifecycle.ts), a real
// prisma.$transaction() acquiring a pg_advisory_xact_lock before calling
// back into the (mocked, module-level) escrowFundingEvidenceRepository —
// this suite mocks the repository directly, not through tx, so a trivial
// passthrough (no real transactional semantics needed) is enough here.
// tests/integration/escrowFundingUncertainty.test.ts and the new
// tests/integration/escrowFundingConcurrency.test.ts prove the real
// locked behavior against real Postgres.
const mockTransaction = jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({ $executeRaw: jest.fn().mockResolvedValue(0) }))
jest.mock('../src/common/database', () => ({
  prisma: {
    escrow: { findMany: (...args: unknown[]) => mockEscrowFindMany(...args) },
    escrowParticipantKey: { findMany: (...args: unknown[]) => mockParticipantKeyFindMany(...args) },
    $transaction: (...args: unknown[]) => mockTransaction(...(args as [any])),
  },
}))

const mockListForEscrow = jest.fn()
const mockRecord = jest.fn()
jest.mock('../src/modules/open-settlement/escrow-funding-evidence-repository', () => ({
  escrowFundingEvidenceRepository: {
    listForEscrow: (...args: unknown[]) => mockListForEscrow(...args),
    record: (...args: unknown[]) => mockRecord(...args),
  },
}))

const mockRescanFunding = jest.fn()
jest.mock('../src/modules/open-settlement/multisig.provider', () => ({
  multisigProvider: { rescanFunding: (...args: unknown[]) => mockRescanFunding(...args) },
}))

import { sweepMultisigFundingReorgs } from '../src/modules/open-settlement/multisig-funding-reorg-sweep'

function escrowFixture(overrides: Record<string, any> = {}) {
  return {
    id: 'escrow-1', tradeId: 'trade-1', type: 'MULTISIG', status: 'FUNDS_LOCKED',
    txLockId: 'a'.repeat(64), lockedAmount: { toString: () => '0.001' },
    feePolicyVersionId: null, snapshotProtocolFeeRate: null,
    snapshotFeeCollectionAddress: null, snapshotFeeCollectionWaivedPreFunding: null,
    ...overrides,
  }
}

function evidenceRow(kind: string, txid = 'a'.repeat(64)) {
  return { id: 'ev', escrowId: 'escrow-1', kind, txid, vout: 0, recordedAt: new Date() }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockParticipantKeyFindMany.mockResolvedValue([])
})

describe('sweepMultisigFundingReorgs() — Missão 11 Fase 9.1 §1/§3', () => {
  it('skips an escrow with no recorded evidence at all — never invents a retroactive baseline', async () => {
    mockEscrowFindMany.mockResolvedValue([escrowFixture()])
    mockListForEscrow.mockResolvedValue([])

    const result = await sweepMultisigFundingReorgs()

    expect(result.skippedNoBaseline).toEqual(['escrow-1'])
    expect(mockRescanFunding).not.toHaveBeenCalled()
    expect(mockRecord).not.toHaveBeenCalled()
  })

  it('same txid, still deep enough — no write, stillGood', async () => {
    mockEscrowFindMany.mockResolvedValue([escrowFixture()])
    mockListForEscrow.mockResolvedValue([evidenceRow('OBSERVED_CONFIRMED')])
    mockRescanFunding.mockResolvedValue({ txId: 'a'.repeat(64), vout: 0, depth: 3, confirmedAtHeight: 100, tipHeightAtObservation: 102 })

    const result = await sweepMultisigFundingReorgs()

    expect(result.stillGood).toEqual(['escrow-1'])
    expect(mockRecord).not.toHaveBeenCalled()
  })

  it('nothing found at all, previous state trustworthy — records REORGED_INVALIDATED', async () => {
    mockEscrowFindMany.mockResolvedValue([escrowFixture()])
    mockListForEscrow.mockResolvedValue([evidenceRow('OBSERVED_CONFIRMED')])
    mockRescanFunding.mockResolvedValue(null)

    const result = await sweepMultisigFundingReorgs()

    expect(result.reverted).toEqual(['escrow-1'])
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ escrowId: 'escrow-1', kind: 'REORGED_INVALIDATED' }), expect.anything())
  })

  it('nothing found at all, previous state ALREADY REORGED_INVALIDATED — no duplicate write (idempotent across duplicate sweeps)', async () => {
    mockEscrowFindMany.mockResolvedValue([escrowFixture()])
    mockListForEscrow.mockResolvedValue([evidenceRow('OBSERVED_CONFIRMED'), evidenceRow('REORGED_INVALIDATED')])
    mockRescanFunding.mockResolvedValue(null)

    const result = await sweepMultisigFundingReorgs()

    expect(result.stillPending).toEqual(['escrow-1'])
    expect(mockRecord).not.toHaveBeenCalled()
  })

  it('same txid reappears deep enough after being invalidated — records RECONFIRMED (never deletes the REORGED_INVALIDATED row)', async () => {
    mockEscrowFindMany.mockResolvedValue([escrowFixture()])
    mockListForEscrow.mockResolvedValue([evidenceRow('OBSERVED_CONFIRMED'), evidenceRow('REORGED_INVALIDATED')])
    mockRescanFunding.mockResolvedValue({ txId: 'a'.repeat(64), vout: 0, depth: 2, confirmedAtHeight: 100, tipHeightAtObservation: 101 })

    const result = await sweepMultisigFundingReorgs()

    expect(result.reconfirmed).toEqual(['escrow-1'])
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ kind: 'RECONFIRMED', txid: 'a'.repeat(64) }), expect.anything())
  })

  it('a DIFFERENT txid now satisfies the funding criteria — records REPLACEMENT_OBSERVED, not auto-trusted', async () => {
    mockEscrowFindMany.mockResolvedValue([escrowFixture()])
    mockListForEscrow.mockResolvedValue([evidenceRow('OBSERVED_CONFIRMED', 'a'.repeat(64)), evidenceRow('REORGED_INVALIDATED', 'a'.repeat(64))])
    mockRescanFunding.mockResolvedValue({ txId: 'b'.repeat(64), vout: 0, depth: 3, confirmedAtHeight: 200, tipHeightAtObservation: 203 })

    const result = await sweepMultisigFundingReorgs()

    expect(result.replacementObserved).toEqual(['escrow-1'])
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ kind: 'REPLACEMENT_OBSERVED', txid: 'b'.repeat(64) }), expect.anything())
  })

  it('duplicate sweep after a reconfirmation is idempotent — the second run sees RECONFIRMED as the last row and writes nothing new', async () => {
    mockEscrowFindMany.mockResolvedValue([escrowFixture()])
    // The state right after a RECONFIRMED write of the recorded outpoint ('a', txLockId): a second run observing the
    // same outpoint must not write again.
    mockListForEscrow.mockResolvedValue([evidenceRow('OBSERVED_CONFIRMED', 'a'.repeat(64)), evidenceRow('REORGED_INVALIDATED', 'a'.repeat(64)), evidenceRow('RECONFIRMED', 'a'.repeat(64))])
    mockRescanFunding.mockResolvedValue({ txId: 'a'.repeat(64), vout: 0, depth: 3, confirmedAtHeight: 200, tipHeightAtObservation: 203 })

    const result = await sweepMultisigFundingReorgs()

    expect(result.stillGood).toEqual(['escrow-1'])
    expect(mockRecord).not.toHaveBeenCalled()
  })

  it('a RECONFIRMED row on a txid other than the recorded outpoint (written before 2026-11-12) is no longer trusted: REPLACEMENT_OBSERVED', async () => {
    mockEscrowFindMany.mockResolvedValue([escrowFixture()])
    mockListForEscrow.mockResolvedValue([evidenceRow('OBSERVED_CONFIRMED', 'a'.repeat(64)), evidenceRow('REPLACEMENT_OBSERVED', 'b'.repeat(64)), evidenceRow('RECONFIRMED', 'b'.repeat(64))])
    mockRescanFunding.mockResolvedValue({ txId: 'b'.repeat(64), vout: 0, depth: 3, confirmedAtHeight: 200, tipHeightAtObservation: 203 })

    const result = await sweepMultisigFundingReorgs()

    expect(result.replacementObserved).toEqual(['escrow-1'])
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ kind: 'REPLACEMENT_OBSERVED', txid: 'b'.repeat(64) }), expect.anything())
  })

  // CTO 25 funding binding (2026-11-12): this used to promote the replacement to RECONFIRMED on its second sighting.
  // Every spend uses the recorded outpoint (txLockId:txLockVout) and nothing re-records it, so trusting another txid
  // vouched for funding the escrow never spends. A replacement now stays REPLACEMENT_OBSERVED (uncertain).
  it('the same replacement candidate seen a second time, both times deep enough — stays REPLACEMENT_OBSERVED, never RECONFIRMED', async () => {
    mockEscrowFindMany.mockResolvedValue([escrowFixture()])
    mockListForEscrow.mockResolvedValue([evidenceRow('OBSERVED_CONFIRMED', 'a'.repeat(64)), evidenceRow('REORGED_INVALIDATED', 'a'.repeat(64)), evidenceRow('REPLACEMENT_OBSERVED', 'b'.repeat(64))])
    mockRescanFunding.mockResolvedValue({ txId: 'b'.repeat(64), vout: 0, depth: 3, confirmedAtHeight: 200, tipHeightAtObservation: 203 })

    const result = await sweepMultisigFundingReorgs()

    expect(result.reconfirmed).toEqual([])
    expect(result.stillPending).toEqual(['escrow-1'])
    expect(mockRecord).not.toHaveBeenCalled()
  })

  it('a confirmed-but-shallow candidate exists, previous state trustworthy — records REORGED_INVALIDATED (regression from trusted)', async () => {
    mockEscrowFindMany.mockResolvedValue([escrowFixture()])
    mockListForEscrow.mockResolvedValue([evidenceRow('OBSERVED_CONFIRMED')])
    mockRescanFunding.mockResolvedValue({ txId: 'a'.repeat(64), vout: 0, depth: 1, confirmedAtHeight: 100, tipHeightAtObservation: 100 })

    const result = await sweepMultisigFundingReorgs()

    expect(result.reverted).toEqual(['escrow-1'])
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ kind: 'REORGED_INVALIDATED' }), expect.anything())
  })

  it('a confirmed-but-shallow candidate exists, previous state already uncertain — no new write, stillPending', async () => {
    mockEscrowFindMany.mockResolvedValue([escrowFixture()])
    mockListForEscrow.mockResolvedValue([evidenceRow('OBSERVED_CONFIRMED'), evidenceRow('REORGED_INVALIDATED')])
    mockRescanFunding.mockResolvedValue({ txId: 'a'.repeat(64), vout: 0, depth: 1, confirmedAtHeight: 100, tipHeightAtObservation: 100 })

    const result = await sweepMultisigFundingReorgs()

    expect(result.stillPending).toEqual(['escrow-1'])
    expect(mockRecord).not.toHaveBeenCalled()
  })

  it('does not query anything when there are no FUNDS_LOCKED MULTISIG escrows', async () => {
    mockEscrowFindMany.mockResolvedValue([])
    const result = await sweepMultisigFundingReorgs()
    expect(result.stillGood).toEqual([])
    expect(mockListForEscrow).not.toHaveBeenCalled()
  })
})
