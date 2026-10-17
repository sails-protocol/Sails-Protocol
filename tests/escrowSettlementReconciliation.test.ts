// tests/escrowSettlementReconciliation.test.ts
//
// Missão 11 Fase 9.6 — CONC-03 crash recovery (Kimi K3 R2, CONFIRMED/P1
// during Fase 9.5's independent triage). Orchestrator-level proof of
// reconcilePendingSettlements(): candidate detection, per-type dispatch,
// fail-closed manual-review paths, and the full convergence write
// sequence. multisig.provider.ts's own reconcilePendingSettlement() —
// the actual on-chain-truth decision logic — is proven separately, with
// real signed PSBTs and real fetch mocks, in
// tests/multisigProvider.test.ts; here it's a controlled mock so this
// suite can focus on the orchestration around it.

jest.mock('../src/config', () => ({
  // M9-R (Part 3, C8) — claimEscrowTransition() (real, from
  // escrow-lifecycle.ts) reads config.escrowCircuitBreaker on its own
  // failure path (recordEscrowConflict()); this mock previously omitted
  // it entirely because nothing in this file called claimEscrowTransition()
  // before this pass. Real production defaults, not arbitrary test values.
  config: { multisig: { network: 'testnet' }, escrowCircuitBreaker: { failureThreshold: 5, windowMs: 30_000, cooldownMs: 120_000 } },
}))

const mockFindTerminalWithoutTxReleaseId = jest.fn()
const mockFindTerminalWithTxReleaseId = jest.fn()
// M9-R (Recovery Closure, Part 3, C8) — claimEscrowTransition() (the
// REAL, unmocked function from escrow-lifecycle.ts) calls through to
// escrowRepository.claimTransition(); since this whole module is
// jest.mock()'d, that method needs its own stub here too, even though
// only the new C8-specific tests below actually exercise it.
const mockClaimTransition = jest.fn()
const mockUpdateSignatureCollectionResult = jest.fn()
jest.mock('../src/modules/open-settlement/escrow-repository', () => ({
  escrowRepository: {
    findTerminalWithoutTxReleaseId: (...args: unknown[]) => mockFindTerminalWithoutTxReleaseId(...args),
    findTerminalWithTxReleaseId: (...args: unknown[]) => mockFindTerminalWithTxReleaseId(...args),
    claimTransition: (...args: unknown[]) => mockClaimTransition(...args),
    updateSignatureCollectionResult: (...args: unknown[]) => mockUpdateSignatureCollectionResult(...args),
  },
}))

const mockTradeFindById = jest.fn()
jest.mock('../src/modules/open-p2p/trade-repository', () => ({
  tradeRepository: { findById: (...args: unknown[]) => mockTradeFindById(...args) },
}))

const mockReconcilePendingSettlement = jest.fn()
jest.mock('../src/modules/open-settlement/multisig.provider', () => ({
  multisigProvider: { reconcilePendingSettlement: (...args: unknown[]) => mockReconcilePendingSettlement(...args) },
  identifyFeeOutput: jest.fn(() => ({ vout: 0, scriptPubKeyHex: 'deadbeef', amountSats: 1000 })),
  networkFor: jest.fn(() => 'testnet'),
}))

const mockRecordObligation = jest.fn()
const mockFindObligationByEscrowId = jest.fn()
jest.mock('../src/modules/open-settlement/fee-obligation.service', () => ({
  feeObligationService: {
    recordObligationForEscrowSettlement: (...args: unknown[]) => mockRecordObligation(...args),
    findByEscrowId: (...args: unknown[]) => mockFindObligationByEscrowId(...args),
  },
}))

const mockRecordBroadcastAndAdvance = jest.fn()
jest.mock('../src/modules/open-settlement/fee-collection-recognition.service', () => ({
  feeCollectionRecognitionService: { recordBroadcastAndAdvance: (...args: unknown[]) => mockRecordBroadcastAndAdvance(...args) },
}))

jest.mock('../src/common/events/event-bus', () => ({
  eventBus: { emit: jest.fn().mockResolvedValue(undefined) },
}))

// Sails Core Implementation Program M9 (Recovery, Execution Uncertainty &
// Semantic Reconciliation) — mocked the same way multisig.provider's
// reconcilePendingSettlement() already is above: this suite proves the
// ORCHESTRATION (is correspondence recovery attempted, when, with what
// arguments), not the real crypto/DB logic inside
// recordLiveCorrespondenceIfApplicable() itself, which is separately,
// thoroughly proven against real Postgres in
// tests/integration/disputeOutcomeMultisigLive.test.ts.
const mockRecordLiveCorrespondenceIfApplicable = jest.fn().mockResolvedValue(undefined)
jest.mock('../src/modules/open-settlement/dispute-correspondence', () => ({
  recordLiveCorrespondenceIfApplicable: (...args: unknown[]) => mockRecordLiveCorrespondenceIfApplicable(...args),
}))

const mockAuthorizePendingExecution = jest.fn().mockResolvedValue({ id: 'cap-auth-1' })
jest.mock('../src/modules/open-settlement/capability-execution-authorization', () => ({
  authorizePendingExecution: (...args: unknown[]) => mockAuthorizePendingExecution(...args),
}))
const mockAuthorizeDisputedPendingExecution = jest.fn().mockResolvedValue({ id: 'eda-auth-1' })
jest.mock('../src/modules/open-settlement/economic-disposition-authority', () => ({
  authorizeDisputedPendingExecution: (...args: unknown[]) => mockAuthorizeDisputedPendingExecution(...args),
}))

const mockPendingTxFindUnique = jest.fn()
const mockPendingTxFindMany = jest.fn()
const mockPendingTxDelete = jest.fn()
const mockEscrowFindUnique = jest.fn()
const mockEscrowUpdate = jest.fn()
const mockParticipantKeyFindMany = jest.fn()
const mockEscrowEventFindFirst = jest.fn()
const mockEscrowEventCreate = jest.fn().mockResolvedValue({ id: 'transition-1' })
// Same passthrough shape multisigFundingReorgSweep.test.ts's own
// withEscrowFundingLock() mock uses — no real transactional semantics
// needed for a unit-level proof of the orchestration; the real locked
// behavior is proven against real Postgres by
// tests/integration/escrowFundingConcurrency.test.ts.
const mockTransaction = jest.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
  callback({
    // Issue #298 - emitEscrowTransition() records the 'transition.claimed' marker in the same transaction as the claim.
    eventProjectionClaim: { create: jest.fn().mockResolvedValue({}), createMany: jest.fn().mockResolvedValue({ count: 1 }), findMany: jest.fn().mockResolvedValue([]) },
    $executeRaw: jest.fn().mockResolvedValue(0),
    escrow: { findUnique: (...args: unknown[]) => mockEscrowFindUnique(...args), update: (...args: unknown[]) => mockEscrowUpdate(...args) },
    // Missão 11 Fase 9.7 — emitEscrowTransition() now does its own
    // escrowEvent existence-check-then-create INSIDE withEscrowFundingLock()
    // (escrow-lifecycle.ts), so its `tx` needs the same escrowEvent shape
    // the top-level `prisma.escrowEvent` mock below already provides —
    // reusing the SAME mock functions for both, since in a real
    // transaction both are the same underlying table.
    escrowEvent: {
      findFirst: (...args: unknown[]) => mockEscrowEventFindFirst(...args),
      create: (...args: unknown[]) => mockEscrowEventCreate(...args),
    },
  })
)
jest.mock('../src/common/database', () => ({
  prisma: {
    // Issue #298 - PASS 3 scans for claimed-but-unprojected transitions; none by default.
    eventProjectionClaim: { findMany: jest.fn().mockResolvedValue([]) },
    // PASS 3 now pages incomplete claimed transitions with one raw anti-join query; none by default.
    $queryRaw: jest.fn().mockResolvedValue([]),
    // Issue #291 hardening - durable WDK attempt evidence attached to the manual-review reason.
    wdkTransferAttempt: { findMany: jest.fn().mockResolvedValue([{ operationType: 'RELEASE', status: 'CONFIRMED', txHash: '0xabc' }]) },
    $transaction: (...args: unknown[]) => mockTransaction(...(args as [any])),
    escrowPendingTransaction: {
      findUnique: (...args: unknown[]) => mockPendingTxFindUnique(...args),
      findMany: (...args: unknown[]) => mockPendingTxFindMany(...args),
      delete: (...args: unknown[]) => mockPendingTxDelete(...args),
    },
    escrowParticipantKey: { findMany: (...args: unknown[]) => mockParticipantKeyFindMany(...args) },
    escrowEvent: {
      findFirst: (...args: unknown[]) => mockEscrowEventFindFirst(...args),
      create: (...args: unknown[]) => mockEscrowEventCreate(...args),
    },
  },
}))

import { reconcilePendingSettlements } from '../src/modules/open-settlement/escrow-settlement-reconciliation.service'
import { resetEscrowCircuitBreaker } from '../src/modules/open-settlement/escrow-circuit-breaker'

function multisigEscrowFixture(overrides: Record<string, any> = {}) {
  return {
    id: 'escrow-1', tradeId: 'trade-1', type: 'MULTISIG', status: 'COMPLETED', txReleaseId: null,
    lockedAmount: { toString: () => '0.001' }, txLockId: 'a'.repeat(64), txLockVout: 0,
    snapshotFeeCollectionAddress: null,
    ...overrides,
  }
}

function pendingTxFixture(overrides: Record<string, any> = {}) {
  return {
    id: 'pending-1', escrowId: 'escrow-1', kind: 'release', unsignedPsbtBase64: 'unsigned-psbt-b64',
    requiredSigners: ['buyer-1', 'seller-1'],
    signatures: [
      { participantId: 'buyer-1', signedPsbtBase64: 'buyer-signed' },
      { participantId: 'seller-1', signedPsbtBase64: 'seller-signed' },
    ],
    triggeredBy: 'seller-1', feeCollectionSats: null, feeCollectionWaived: null, buyerBps: null,
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  resetEscrowCircuitBreaker()
  mockParticipantKeyFindMany.mockResolvedValue([])
  mockEscrowEventFindFirst.mockResolvedValue(null)
  mockTradeFindById.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' })
  mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', txReleaseId: null })
  mockEscrowUpdate.mockResolvedValue({ id: 'escrow-1' })
  mockPendingTxDelete.mockResolvedValue({})
  mockClaimTransition.mockResolvedValue(1)
  mockUpdateSignatureCollectionResult.mockResolvedValue({ id: 'escrow-1' })
  // PASS 0 (M9-R, C8) candidates default to none — tests that specifically
  // want one set mockPendingTxFindMany explicitly.
  mockPendingTxFindMany.mockResolvedValue([])
  // PASS 2 (Fase 9.7) candidates default to none, so every PASS-1-only
  // (Fase 9.6) test below exercises exactly the scenario it names —
  // tests that specifically want a PASS 2 candidate set it explicitly.
  mockFindTerminalWithTxReleaseId.mockResolvedValue([])
})

// Sails Core Implementation Program M9-R (Recovery Closure, Part 3) —
// PASS 0: crash window C8, a fully-signed pending transaction whose
// escrow never got claimed. mockReconcilePendingSettlement is the SAME
// mock PASS 1's own tests already use — proves CHAIN TRUTH BEFORE
// ECONOMIC ACTION is honored (the claim/downstream-effects code below
// only ever runs after that mock resolves), without re-testing the
// chain-truth decision logic itself (already proven with real signed
// PSBTs in tests/multisigProvider.test.ts).
describe('reconcilePendingSettlements() — Sails M9-R, C8 unclaimed-fully-signed-pending recovery (PASS 0)', () => {
  it('no PASS 0 candidates — a clean report on that side', async () => {
    mockPendingTxFindMany.mockResolvedValue([])
    mockFindTerminalWithoutTxReleaseId.mockResolvedValue([])
    const report = await reconcilePendingSettlements()
    expect(report.resumedUnclaimed).toEqual([])
    expect(report.alreadyClaimedConcurrently).toEqual([])
  })

  it('a pending row still collecting signatures (not fully signed) is silently not a candidate — the ordinary C7 state', async () => {
    mockPendingTxFindMany.mockResolvedValue([{
      ...pendingTxFixture(), signatures: [{ participantId: 'buyer-1', signedPsbtBase64: 'buyer-signed' }],
      escrow: multisigEscrowFixture({ status: 'DISPUTED' }),
    }])
    mockFindTerminalWithoutTxReleaseId.mockResolvedValue([])

    const report = await reconcilePendingSettlements()

    expect(report.resumedUnclaimed).toEqual([])
    expect(mockReconcilePendingSettlement).not.toHaveBeenCalled()
    expect(mockClaimTransition).not.toHaveBeenCalled()
  })

  it('fully signed, escrow non-terminal — asks the chain FIRST, then claims the transition and runs the shared downstream effects', async () => {
    mockPendingTxFindMany.mockResolvedValue([{
      ...pendingTxFixture(), escrow: multisigEscrowFixture({ status: 'DISPUTED' }),
    }])
    mockFindTerminalWithoutTxReleaseId.mockResolvedValue([])
    mockReconcilePendingSettlement.mockImplementation(async (_input, _unsigned, _signed, beforeFirstBroadcast) => {
      await beforeFirstBroadcast()
      return { outcome: 'NEWLY_BROADCAST', txId: 'c8-txid-1', detail: 'broadcast for the first time', rawTxHex: 'c8-raw-hex' }
    })

    const report = await reconcilePendingSettlements()

    expect(mockReconcilePendingSettlement).toHaveBeenCalledTimes(1)
    expect(mockAuthorizeDisputedPendingExecution).toHaveBeenCalledWith(expect.objectContaining({ id: 'pending-1' }))
    expect(mockAuthorizePendingExecution).toHaveBeenCalledWith(expect.objectContaining({ id: 'pending-1' }))
    expect(mockAuthorizeDisputedPendingExecution.mock.invocationCallOrder[0]).toBeLessThan(mockAuthorizePendingExecution.mock.invocationCallOrder[0])
    expect(mockClaimTransition).toHaveBeenCalledWith('escrow-1', 'DISPUTED', 'COMPLETED')
    expect(mockUpdateSignatureCollectionResult).toHaveBeenCalledWith('escrow-1', { txReleaseId: 'c8-txid-1', releasedAt: expect.any(Date) }, { operation: { pendingOperationId: 'pending-1' } })
    expect(report.resumedUnclaimed).toEqual([{ escrowId: 'escrow-1', txId: 'c8-txid-1', outcome: 'NEWLY_BROADCAST' }])
    expect(mockRecordObligation).toHaveBeenCalledWith(expect.objectContaining({ id: 'escrow-1' }), 'RELEASE', undefined, undefined)
    expect(mockRecordLiveCorrespondenceIfApplicable).toHaveBeenCalledWith('escrow-1', 'trade-1', 'MULTISIG', 'c8-raw-hex')
  })

  it('ALREADY_BROADCAST recovery converges external truth without asking for fresh execution authority', async () => {
    mockPendingTxFindMany.mockResolvedValue([{
      ...pendingTxFixture(), escrow: multisigEscrowFixture({ status: 'DISPUTED' }),
    }])
    mockFindTerminalWithoutTxReleaseId.mockResolvedValue([])
    mockReconcilePendingSettlement.mockResolvedValue({ outcome: 'ALREADY_BROADCAST', txId: 'c8-known', detail: 'already known', rawTxHex: 'c8-known-raw' })

    const report = await reconcilePendingSettlements()

    expect(mockAuthorizeDisputedPendingExecution).not.toHaveBeenCalled()
    expect(mockAuthorizePendingExecution).not.toHaveBeenCalled()
    expect(report.resumedUnclaimed).toEqual([{ escrowId: 'escrow-1', txId: 'c8-known', outcome: 'ALREADY_BROADCAST' }])
  })

  it('NEWLY_BROADCAST recovery fails closed when ADR-005 commit gate rejects before the provider side effect', async () => {
    mockPendingTxFindMany.mockResolvedValue([{
      ...pendingTxFixture(), escrow: multisigEscrowFixture({ status: 'DISPUTED' }),
    }])
    mockFindTerminalWithoutTxReleaseId.mockResolvedValue([])
    mockAuthorizeDisputedPendingExecution.mockRejectedValueOnce(new Error('ruling generation no longer current'))
    mockReconcilePendingSettlement.mockImplementation(async (_input, _unsigned, _signed, beforeFirstBroadcast) => {
      await beforeFirstBroadcast()
      throw new Error('provider broadcast must never be reached')
    })

    const report = await reconcilePendingSettlements()

    expect(mockAuthorizeDisputedPendingExecution).toHaveBeenCalledTimes(1)
    expect(mockAuthorizePendingExecution).not.toHaveBeenCalled()
    expect(mockClaimTransition).not.toHaveBeenCalled()
    expect(report.failed[0].error).toMatch(/ruling generation no longer current/)
  })

  it('ANOMALY (unexpected outpoint spend) — fails closed, transition never claimed, reported for manual review as C8', async () => {
    mockPendingTxFindMany.mockResolvedValue([{
      ...pendingTxFixture(), escrow: multisigEscrowFixture({ status: 'DISPUTED' }),
    }])
    mockFindTerminalWithoutTxReleaseId.mockResolvedValue([])
    mockReconcilePendingSettlement.mockResolvedValue({ outcome: 'ANOMALY', detail: 'unexpected spend — manual review required' })

    const report = await reconcilePendingSettlements()

    expect(mockClaimTransition).not.toHaveBeenCalled()
    expect(report.resumedUnclaimed).toEqual([])
    expect(report.requiresManualReview).toEqual([{ escrowId: 'escrow-1', reason: 'C8 (fully-signed, unclaimed): unexpected spend — manual review required' }])
  })

  it('duplicate workers: claimEscrowTransition losing the atomic race is reported as a benign concurrent claim, not a failure', async () => {
    mockPendingTxFindMany.mockResolvedValue([{
      ...pendingTxFixture(), escrow: multisigEscrowFixture({ status: 'DISPUTED' }),
    }])
    mockFindTerminalWithoutTxReleaseId.mockResolvedValue([])
    mockReconcilePendingSettlement.mockResolvedValue({ outcome: 'ALREADY_BROADCAST', txId: 'c8-txid-2', detail: 'already known', rawTxHex: 'c8-raw-hex-2' })
    mockClaimTransition.mockResolvedValue(0) // lost the atomic claim — a concurrent caller (or a resubmitting signer) already won it

    const report = await reconcilePendingSettlements()

    expect(report.alreadyClaimedConcurrently).toEqual(['escrow-1'])
    expect(report.resumedUnclaimed).toEqual([])
    expect(report.failed).toEqual([])
    expect(mockUpdateSignatureCollectionResult).not.toHaveBeenCalled()
  })
})

describe('reconcilePendingSettlements() — Missão 11 Fase 9.6, CONC-03 crash recovery orchestration', () => {
  it('no candidates — a clean, empty report', async () => {
    mockFindTerminalWithoutTxReleaseId.mockResolvedValue([])
    const report = await reconcilePendingSettlements()
    expect(report).toEqual({ recovered: [], completionEffectsRecovered: [], requiresManualReview: [], failed: [], resumedUnclaimed: [], alreadyClaimedConcurrently: [], projectionsRecovered: [] })
  })

  it('a non-MULTISIG rail has no automated recovery primitive in scope — fails closed, flagged for manual review, no chain calls attempted', async () => {
    mockFindTerminalWithoutTxReleaseId.mockResolvedValue([multisigEscrowFixture({ type: 'WDK_USDT_EVM' })])
    const report = await reconcilePendingSettlements()
    expect(report.requiresManualReview).toHaveLength(1)
    expect(report.requiresManualReview[0].escrowId).toBe('escrow-1')
    expect(report.requiresManualReview[0].reason).toMatch(/no automated crash-recovery reconciliation primitive/)
    expect(report.requiresManualReview[0].reason).toContain("RELEASE=CONFIRMED(0xabc)")
    expect(mockReconcilePendingSettlement).not.toHaveBeenCalled()
  })

  it('a MULTISIG escrow with no surviving pending-transaction row — nothing to reconstruct from, fails closed', async () => {
    mockFindTerminalWithoutTxReleaseId.mockResolvedValue([multisigEscrowFixture()])
    mockPendingTxFindUnique.mockResolvedValue(null)
    const report = await reconcilePendingSettlements()
    expect(report.requiresManualReview).toHaveLength(1)
    expect(report.requiresManualReview[0].reason).toMatch(/no longer exists/)
  })

  it('a pending-transaction kind that does not match the escrow\'s claimed terminal status — structurally shouldn\'t happen, fails closed rather than guess', async () => {
    mockFindTerminalWithoutTxReleaseId.mockResolvedValue([multisigEscrowFixture({ status: 'REFUNDED' })])
    mockPendingTxFindUnique.mockResolvedValue(pendingTxFixture({ kind: 'release' })) // implies COMPLETED, not REFUNDED
    const report = await reconcilePendingSettlements()
    expect(report.requiresManualReview).toHaveLength(1)
    expect(report.requiresManualReview[0].reason).toMatch(/mismatch/)
  })

  it('a required signer\'s signature is missing — structurally shouldn\'t happen (the escrow could not have reached a terminal status without all of them), fails closed', async () => {
    mockFindTerminalWithoutTxReleaseId.mockResolvedValue([multisigEscrowFixture()])
    mockPendingTxFindUnique.mockResolvedValue(pendingTxFixture({ signatures: [{ participantId: 'buyer-1', signedPsbtBase64: 'buyer-signed' }] }))
    const report = await reconcilePendingSettlements()
    expect(report.requiresManualReview).toHaveLength(1)
    expect(report.requiresManualReview[0].reason).toMatch(/missing one or more required signatures/)
    expect(mockReconcilePendingSettlement).not.toHaveBeenCalled()
  })

  it('an ANOMALY outcome from the on-chain-truth check is never auto-resolved — fails closed, full detail preserved for manual review', async () => {
    mockFindTerminalWithoutTxReleaseId.mockResolvedValue([multisigEscrowFixture()])
    mockPendingTxFindUnique.mockResolvedValue(pendingTxFixture())
    mockReconcilePendingSettlement.mockResolvedValue({ outcome: 'ANOMALY', detail: 'unexpected spend — manual review required' })

    const report = await reconcilePendingSettlements()

    expect(report.requiresManualReview).toEqual([{ escrowId: 'escrow-1', reason: 'unexpected spend — manual review required' }])
    expect(report.recovered).toEqual([])
    expect(mockEscrowUpdate).not.toHaveBeenCalled()
  })

  it('Estado B (ALREADY_BROADCAST) converges local state — persists txReleaseId, records the fee obligation, emits the settlement event, deletes the pending row — without a new broadcast (that already happened before this reconciliation ever ran)', async () => {
    mockFindTerminalWithoutTxReleaseId.mockResolvedValue([multisigEscrowFixture()])
    mockPendingTxFindUnique.mockResolvedValue(pendingTxFixture())
    mockReconcilePendingSettlement.mockResolvedValue({ outcome: 'ALREADY_BROADCAST', txId: 'real-txid-1', detail: 'already known to the network', rawTxHex: 'raw-hex-1' })

    const report = await reconcilePendingSettlements()

    expect(report.recovered).toEqual([{ escrowId: 'escrow-1', txId: 'real-txid-1', outcome: 'ALREADY_BROADCAST' }])
    // Issue #291 - PASS 1 now writes through the shared write-once primitive, bound to the pending operation.
    expect(mockUpdateSignatureCollectionResult).toHaveBeenCalledWith('escrow-1', { txReleaseId: 'real-txid-1', releasedAt: expect.any(Date) }, { tx: expect.anything(), operation: { pendingOperationId: 'pending-1' } })
    expect(mockRecordObligation).toHaveBeenCalledWith(expect.objectContaining({ id: 'escrow-1' }), 'RELEASE', undefined, undefined)
    expect(mockPendingTxDelete).toHaveBeenCalledWith({ where: { id: 'pending-1' } })
    // M9 — PASS 1 threads its own exact-reconstruction rawTxHex straight
    // through to correspondence recovery, never re-deriving it a second time.
    expect(mockRecordLiveCorrespondenceIfApplicable).toHaveBeenCalledWith('escrow-1', 'trade-1', 'MULTISIG', 'raw-hex-1')
  })

  it('Estado A (NEWLY_BROADCAST) converges the same way — the broadcast itself already happened inside reconcilePendingSettlement(), this orchestrator never calls a provider a second time', async () => {
    mockFindTerminalWithoutTxReleaseId.mockResolvedValue([multisigEscrowFixture()])
    mockPendingTxFindUnique.mockResolvedValue(pendingTxFixture())
    mockReconcilePendingSettlement.mockResolvedValue({ outcome: 'NEWLY_BROADCAST', txId: 'real-txid-2', detail: 'broadcast for the first time' })

    const report = await reconcilePendingSettlements()

    expect(report.recovered).toEqual([{ escrowId: 'escrow-1', txId: 'real-txid-2', outcome: 'NEWLY_BROADCAST' }])
    expect(mockReconcilePendingSettlement).toHaveBeenCalledTimes(1) // never called twice — no retry loop, no second attempt
    expect(mockUpdateSignatureCollectionResult).toHaveBeenCalledWith('escrow-1', { txReleaseId: 'real-txid-2', releasedAt: expect.any(Date) }, { tx: expect.anything(), operation: { pendingOperationId: 'pending-1' } })
  })

  it('a refund convergence omits releasedAt — matches submitTransactionSignature()\'s own refund-vs-release/split field shape exactly', async () => {
    mockFindTerminalWithoutTxReleaseId.mockResolvedValue([multisigEscrowFixture({ status: 'REFUNDED' })])
    mockPendingTxFindUnique.mockResolvedValue(pendingTxFixture({ kind: 'refund' }))
    mockReconcilePendingSettlement.mockResolvedValue({ outcome: 'ALREADY_BROADCAST', txId: 'real-txid-3', detail: 'already known' })

    await reconcilePendingSettlements()

    expect(mockUpdateSignatureCollectionResult).toHaveBeenCalledWith('escrow-1', { txReleaseId: 'real-txid-3' }, { tx: expect.anything(), operation: { pendingOperationId: 'pending-1' } })
    expect(mockRecordObligation).toHaveBeenCalledWith(expect.objectContaining({ id: 'escrow-1' }), 'FULL_REFUND', undefined, undefined)
  })

  it('a concurrent convergence already ran (txReleaseId no longer null when the lock is acquired) — the authoritative re-check inside the lock skips the write, no double-write', async () => {
    mockFindTerminalWithoutTxReleaseId.mockResolvedValue([multisigEscrowFixture()])
    mockPendingTxFindUnique.mockResolvedValue(pendingTxFixture())
    mockReconcilePendingSettlement.mockResolvedValue({ outcome: 'ALREADY_BROADCAST', txId: 'real-txid-4', detail: 'already known' })
    // A concurrent reconciliation run (or, structurally impossible but
    // defended anyway, a live request) already converged this escrow
    // between this test's own chain-truth determination and the lock.
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', txReleaseId: 'already-set-by-someone-else' })

    await reconcilePendingSettlements()

    // Issue #291 - the decision "same result -> idempotent no-op" now lives INSIDE the shared write-once
    // primitive (escrow-repository.ts), so PASS 1 always routes through it; it never writes around it.
    expect(mockEscrowUpdate).not.toHaveBeenCalled()
    expect(mockUpdateSignatureCollectionResult).toHaveBeenCalledTimes(1)
    // Downstream side effects (obligation/event/pending-row cleanup)
    // still run — recordObligationForEscrowSettlement() is independently
    // idempotent (findByEscrowId() check), and emitEscrowTransition()
    // itself (Fase 9.7) is what actually decides whether the event
    // cascade fires — its own (escrowId, toStatus) claim, not this
    // txReleaseId write, is the real double-fire guard (see the
    // dedicated emitEscrowTransition() idempotency tests below).
  })

  // Issue #291 - PASS 1 and C8 use the same write-once semantics as every live writer: a DIFFERENT
  // persisted result is an integrity conflict (manual review), never silently ignored and never overwritten.
  it('PASS 1: a conflicting persisted settlement result is surfaced for manual review - no overwrite, no downstream effects', async () => {
    const { SettlementResultConflictError } = require('../src/common/errors')
    mockFindTerminalWithoutTxReleaseId.mockResolvedValue([multisigEscrowFixture()])
    mockPendingTxFindUnique.mockResolvedValue(pendingTxFixture())
    mockReconcilePendingSettlement.mockResolvedValue({ outcome: 'ALREADY_BROADCAST', txId: 'chain-txid', detail: 'already known' })
    mockUpdateSignatureCollectionResult.mockRejectedValueOnce(new SettlementResultConflictError('durable txReleaseId A cannot be replaced by chain-txid'))

    const report = await reconcilePendingSettlements()

    expect(report.requiresManualReview).toEqual([{ escrowId: 'escrow-1', reason: expect.stringContaining('cannot be replaced') }])
    expect(report.recovered).toEqual([])
    expect(mockRecordObligation).not.toHaveBeenCalled()
    expect(mockEscrowUpdate).not.toHaveBeenCalled()
  })

  it('an escrow that throws mid-reconciliation lands in `failed`, not `recovered` or silently dropped — and does not stop the rest of the batch', async () => {
    mockFindTerminalWithoutTxReleaseId.mockResolvedValue([
      multisigEscrowFixture({ id: 'escrow-broken' }),
      multisigEscrowFixture({ id: 'escrow-ok' }),
    ])
    mockPendingTxFindUnique.mockImplementation(async ({ where }: any) =>
      where.escrowId === 'escrow-broken' ? Promise.reject(new Error('DB unavailable')) : pendingTxFixture({ escrowId: 'escrow-ok' })
    )
    mockReconcilePendingSettlement.mockResolvedValue({ outcome: 'ALREADY_BROADCAST', txId: 'ok-txid', detail: 'already known' })

    const report = await reconcilePendingSettlements()

    expect(report.failed).toEqual([{ escrowId: 'escrow-broken', error: 'DB unavailable' }])
    expect(report.recovered).toEqual([{ escrowId: 'escrow-ok', txId: 'ok-txid', outcome: 'ALREADY_BROADCAST' }])
  })
})

// Missão 11 Fase 9.7 — PASS 2: CONC-03's "C5" gap. txReleaseId is
// already confirmed set (no chain-truth-seeking needed, unlike PASS 1
// above) — the only open question is whether the downstream completion
// chain (fee obligation, settlement.escrow.* event -> Trade/reputation/
// volume) ever ran.
describe('reconcilePendingSettlements() — Missão 11 Fase 9.7, C5 missing-completion-effects recovery (PASS 2)', () => {
  it('no PASS 2 candidates — a clean report on that side', async () => {
    mockFindTerminalWithoutTxReleaseId.mockResolvedValue([])
    mockFindTerminalWithTxReleaseId.mockResolvedValue([])
    const report = await reconcilePendingSettlements()
    expect(report.completionEffectsRecovered).toEqual([])
  })

  it('an escrow whose downstream effects already ran (a matching EscrowEvent exists) is left alone — the overwhelmingly common case, zero writes attempted', async () => {
    mockFindTerminalWithoutTxReleaseId.mockResolvedValue([])
    mockFindTerminalWithTxReleaseId.mockResolvedValue([multisigEscrowFixture({ txReleaseId: 'already-set' })])
    mockEscrowEventFindFirst.mockResolvedValue({ id: 'evt-1', escrowId: 'escrow-1', toStatus: 'COMPLETED' }) // the peek query itself
    mockPendingTxFindUnique.mockResolvedValue(null) // no surviving pending row — nothing to reconstruct from

    const report = await reconcilePendingSettlements()

    expect(report.completionEffectsRecovered).toEqual([])
    expect(report.requiresManualReview).toEqual([])
    expect(mockRecordObligation).not.toHaveBeenCalled()
    expect(mockPendingTxDelete).not.toHaveBeenCalled()
    // M9 — even though completion effects are already done (nothing
    // missing on that side), correspondence recovery is STILL attempted:
    // the two concerns are gated independently. rawTxHex is undefined
    // here because no pending row survived to reconstruct from — still
    // a correct, honest attempt, never a guess.
    expect(mockRecordLiveCorrespondenceIfApplicable).toHaveBeenCalledWith('escrow-1', 'trade-1', 'MULTISIG', undefined)
  })

  // Sails Core Implementation Program M9 (Recovery, Execution Uncertainty
  // & Semantic Reconciliation) — closes the crash window PASS 2 did NOT
  // cover before this mission: the completion event (settlement.escrow.*)
  // already fired successfully, but the process crashed before
  // recordLiveCorrespondenceIfApplicable() ever ran (or that call itself
  // crashed). Before this fix, PASS 2's `if (alreadyEmitted) return`
  // early-returned before reaching any correspondence logic, so this
  // exact scenario was silently never repaired. These tests prove the
  // fix: the two concerns (completion-effects catch-up vs. correspondence
  // catch-up) are now checked and repaired independently.
  describe('reconcilePendingSettlements() — Sails M9, correspondence catch-up decoupled from the completion-effects gate', () => {
    it('completion effects ALREADY ran (alreadyEmitted=true) AND the pending row + all signatures still survive — correspondence recovery reconstructs the exact transaction and is attempted with the real rawTxHex, while completion effects are correctly NOT re-run', async () => {
      mockFindTerminalWithoutTxReleaseId.mockResolvedValue([])
      mockFindTerminalWithTxReleaseId.mockResolvedValue([multisigEscrowFixture({ txReleaseId: 'confirmed-txid-m9', status: 'COMPLETED' })])
      mockEscrowEventFindFirst.mockResolvedValue({ id: 'evt-1', escrowId: 'escrow-1', toStatus: 'COMPLETED' }) // completion effects already ran
      mockPendingTxFindUnique.mockResolvedValue(pendingTxFixture()) // pending row survives with all signatures
      mockReconcilePendingSettlement.mockResolvedValue({ outcome: 'ALREADY_BROADCAST', txId: 'confirmed-txid-m9', detail: 'already known', rawTxHex: 'recovered-raw-hex' })

      const report = await reconcilePendingSettlements()

      expect(report.completionEffectsRecovered).toEqual([]) // correctly NOT re-run — nothing was missing on that side
      expect(mockRecordObligation).not.toHaveBeenCalled()
      expect(mockPendingTxDelete).not.toHaveBeenCalled() // this pending row belongs to the completion-effects path, untouched by correspondence-only recovery
      expect(mockRecordLiveCorrespondenceIfApplicable).toHaveBeenCalledWith('escrow-1', 'trade-1', 'MULTISIG', 'recovered-raw-hex')
    })

    it('completion effects already ran AND a required signature is missing from the surviving pending row — reconstruction is skipped (never attempted with a partial/guessed signature set), correspondence is still attempted with rawTxHex undefined, never fatal', async () => {
      mockFindTerminalWithoutTxReleaseId.mockResolvedValue([])
      mockFindTerminalWithTxReleaseId.mockResolvedValue([multisigEscrowFixture({ txReleaseId: 'confirmed-txid-partial', status: 'COMPLETED' })])
      mockEscrowEventFindFirst.mockResolvedValue({ id: 'evt-1', escrowId: 'escrow-1', toStatus: 'COMPLETED' })
      mockPendingTxFindUnique.mockResolvedValue(pendingTxFixture({ signatures: [{ participantId: 'buyer-1', signedPsbtBase64: 'buyer-signed' }] }))

      const report = await reconcilePendingSettlements()

      expect(report.completionEffectsRecovered).toEqual([])
      expect(mockReconcilePendingSettlement).not.toHaveBeenCalled() // never reconstructs from an incomplete signature set
      expect(mockRecordLiveCorrespondenceIfApplicable).toHaveBeenCalledWith('escrow-1', 'trade-1', 'MULTISIG', undefined)
    })

    it('reconstruction itself throws (e.g. transient chain-lookup failure inside reconcilePendingSettlement) — non-fatal, correspondence is still attempted with rawTxHex undefined, and the rest of the pass is unaffected', async () => {
      mockFindTerminalWithoutTxReleaseId.mockResolvedValue([])
      mockFindTerminalWithTxReleaseId.mockResolvedValue([multisigEscrowFixture({ txReleaseId: 'confirmed-txid-throws', status: 'COMPLETED' })])
      mockEscrowEventFindFirst.mockResolvedValue({ id: 'evt-1', escrowId: 'escrow-1', toStatus: 'COMPLETED' })
      mockPendingTxFindUnique.mockResolvedValue(pendingTxFixture())
      // *Once* — this mock has no per-test isolation for its
      // implementation (jest.config.js's clearMocks only clears call
      // history, not implementations/mockResolvedValue), so a persistent
      // .mockRejectedValue() here would silently leak this rejection
      // into every later test in this file that also reaches the
      // correspondence-reconstruction call.
      mockReconcilePendingSettlement.mockRejectedValueOnce(new Error('transient explorer failure'))

      const report = await reconcilePendingSettlements()

      expect(report.failed).toEqual([]) // this is inside reconcileMissingCompletionEffects's own try/catch scope at the top level of the reconciliation loop — never crashes the whole pass
      expect(mockRecordLiveCorrespondenceIfApplicable).toHaveBeenCalledWith('escrow-1', 'trade-1', 'MULTISIG', undefined)
    })

    it('a non-MULTISIG escrow never attempts correspondence recovery in PASS 2 (no authoritative reconstruction primitive exists for that rail)', async () => {
      mockFindTerminalWithoutTxReleaseId.mockResolvedValue([])
      mockFindTerminalWithTxReleaseId.mockResolvedValue([multisigEscrowFixture({ id: 'escrow-mock-2', type: 'MOCK', txReleaseId: 'mock-txid-2', status: 'COMPLETED' })])
      mockEscrowEventFindFirst.mockResolvedValue({ id: 'evt-1', escrowId: 'escrow-mock-2', toStatus: 'COMPLETED' })

      await reconcilePendingSettlements()

      expect(mockRecordLiveCorrespondenceIfApplicable).not.toHaveBeenCalled()
    })

    it('a MULTISIG escrow with no txReleaseId is not a PASS-2 candidate at all — correspondence recovery is never reached for it here (PASS 1\'s own job)', async () => {
      mockFindTerminalWithoutTxReleaseId.mockResolvedValue([])
      mockFindTerminalWithTxReleaseId.mockResolvedValue([]) // findTerminalWithTxReleaseId() itself only returns rows with txReleaseId set — nothing to feed PASS 2 here

      await reconcilePendingSettlements()

      expect(mockRecordLiveCorrespondenceIfApplicable).not.toHaveBeenCalled()
    })
  })

  it('C5 recovery for a MULTISIG (signature-collection-rail) escrow with a surviving pending row — records the obligation, emits the transition, cleans up the pending row', async () => {
    mockFindTerminalWithoutTxReleaseId.mockResolvedValue([])
    mockFindTerminalWithTxReleaseId.mockResolvedValue([multisigEscrowFixture({ txReleaseId: 'confirmed-txid-1', status: 'COMPLETED' })])
    // Peek (outside the write path) finds nothing; the escrowEvent.create
    // mock inside the transaction (same mock function) will now actually
    // record the creation for this escrow's completion.
    mockEscrowEventFindFirst.mockResolvedValue(null)
    mockPendingTxFindUnique.mockResolvedValue(pendingTxFixture({ kind: 'release' }))

    const report = await reconcilePendingSettlements()

    expect(report.completionEffectsRecovered).toEqual([{ escrowId: 'escrow-1', obligationSkipped: false }])
    expect(mockRecordObligation).toHaveBeenCalledWith(expect.objectContaining({ id: 'escrow-1' }), 'RELEASE', undefined, undefined)
    expect(mockEscrowEventCreate).toHaveBeenCalledTimes(1)
    expect(mockPendingTxDelete).toHaveBeenCalledWith({ where: { id: 'pending-1' } })
  })

  it('C5 recovery for a direct-call-rail escrow (MOCK/WDK_USDT_EVM — no pending-transaction concept) still catches up RELEASE/REFUND obligations and the completion event', async () => {
    mockFindTerminalWithoutTxReleaseId.mockResolvedValue([])
    mockFindTerminalWithTxReleaseId.mockResolvedValue([multisigEscrowFixture({ id: 'escrow-mock-1', type: 'MOCK', txReleaseId: 'mock-txid-1', status: 'COMPLETED' })])
    mockEscrowEventFindFirst.mockResolvedValue(null)
    mockPendingTxFindUnique.mockResolvedValue(null) // no such concept for this rail

    const report = await reconcilePendingSettlements()

    expect(report.completionEffectsRecovered).toEqual([{ escrowId: 'escrow-mock-1', obligationSkipped: false }])
    expect(mockRecordObligation).toHaveBeenCalledWith(expect.objectContaining({ id: 'escrow-mock-1' }), 'RELEASE', undefined, undefined)
    // No pending row existed — nothing to delete, no crash from a null-id delete attempt.
    expect(mockPendingTxDelete).not.toHaveBeenCalled()
  })

  it('C5 recovery for a direct-call-rail SPLIT with no surviving pending row — buyerBps is genuinely unrecoverable, obligation recording is SKIPPED (not guessed), but the completion event still fires', async () => {
    mockFindTerminalWithoutTxReleaseId.mockResolvedValue([])
    mockFindTerminalWithTxReleaseId.mockResolvedValue([multisigEscrowFixture({ id: 'escrow-split-1', type: 'MOCK', txReleaseId: 'split-txid-1', status: 'SPLIT' })])
    mockEscrowEventFindFirst.mockResolvedValue(null)
    mockPendingTxFindUnique.mockResolvedValue(null)

    const report = await reconcilePendingSettlements()

    expect(report.completionEffectsRecovered).toEqual([{ escrowId: 'escrow-split-1', obligationSkipped: true }])
    expect(mockRecordObligation).not.toHaveBeenCalled()
    expect(mockEscrowEventCreate).toHaveBeenCalledTimes(1) // the event itself still recovers — only the fee obligation is unrecoverable
  })

  it('a Trade lookup failure during C5 catch-up is reported for manual review, not silently swallowed or crashed on', async () => {
    mockFindTerminalWithoutTxReleaseId.mockResolvedValue([])
    mockFindTerminalWithTxReleaseId.mockResolvedValue([multisigEscrowFixture({ txReleaseId: 'confirmed-txid-2' })])
    mockEscrowEventFindFirst.mockResolvedValue(null)
    mockTradeFindById.mockResolvedValue(null)

    const report = await reconcilePendingSettlements()

    expect(report.requiresManualReview).toEqual([{ escrowId: 'escrow-1', reason: 'Trade trade-1 not found (completion-effects catch-up).' }])
    expect(mockRecordObligation).not.toHaveBeenCalled()
  })
})

// Missão 11 Fase 9.7 — the actual double-fire guard: emitEscrowTransition()
// itself (escrow-lifecycle.ts), exercised directly here rather than
// only indirectly through the reconciliation orchestration above, since
// it now protects EVERY caller in the codebase (releaseFunds()/
// refundFunds()/splitFunds()/submitTransactionSignature()/
// markPaymentSent()/openDispute() included), not just this module.
describe('emitEscrowTransition() — Missão 11 Fase 9.7, atomic per-(escrowId, toStatus) idempotency', () => {
  it('the first call for a given (escrowId, toStatus) creates the EscrowEvent row and fires eventBus.emit', async () => {
    const { emitEscrowTransition } = require('../src/modules/open-settlement/escrow-lifecycle')
    mockEscrowEventFindFirst.mockResolvedValue(null)

    const emitted = await emitEscrowTransition('escrow-x', 'trade-x', 'PAYMENT_PENDING', 'COMPLETED', 'seller-x', 'settlement.escrow.released', { txId: 'tx-x' })

    expect(emitted).toBe(true)
    expect(mockEscrowEventCreate).toHaveBeenCalledTimes(1)
    const { eventBus } = require('../src/common/events/event-bus')
    expect(eventBus.emit).toHaveBeenCalledTimes(1)
  })

  it('a second call for the IDENTICAL (escrowId, toStatus) — simulating a race between a live completion and a reconciliation catch-up — is a safe no-op: no second EscrowEvent row, no second eventBus.emit, the non-idempotent downstream cascade never double-fires', async () => {
    const { emitEscrowTransition } = require('../src/modules/open-settlement/escrow-lifecycle')
    // This time the existence check finds a row already there — the
    // exact signal a second, racing caller would see.
    mockEscrowEventFindFirst.mockResolvedValue({ id: 'evt-existing', escrowId: 'escrow-x', toStatus: 'COMPLETED' })

    const emitted = await emitEscrowTransition('escrow-x', 'trade-x', 'PAYMENT_PENDING', 'COMPLETED', 'seller-x', 'settlement.escrow.released', { txId: 'tx-x' })

    expect(emitted).toBe(false)
    expect(mockEscrowEventCreate).not.toHaveBeenCalled()
    const { eventBus } = require('../src/common/events/event-bus')
    expect(eventBus.emit).not.toHaveBeenCalled()
  })
})
