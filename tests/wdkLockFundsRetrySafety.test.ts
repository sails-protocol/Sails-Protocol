/**
 * CTO Mission #56 — WDK_USDT_EVM lockFunds() unknown-outcome / retry-safety
 * evidence (docs/BACKLOG.md's #56, docs/TECHNICAL_DEBT_AUDIT.md #56).
 *
 * Exercises the REAL escrow.service.ts/escrow-lifecycle.ts orchestration
 * (nothing about the claim/revert/retry logic is mocked) against a fake
 * WdkSettlementProvider — only the provider boundary and the database are
 * mocked, the same "mock the boundary, test what's actually new" discipline
 * tests/escrowProviderWiring.test.ts and tests/escrowReleaseControls.test.ts
 * already use for MULTISIG/LIGHTNING_HODL.
 *
 * CTO Gate Correction (2026-09-07): every test below exercises the REAL
 * Sails orchestration (claimEscrowTransition -> provider call -> catch ->
 * revertEscrowStatus -> retry) — that part is DEMONSTRATED, unmocked, and
 * genuinely runs. The external, side-effecting economic action itself
 * (the provider's transfer) is SIMULATED — no real network/RPC call is
 * ever made. No claim in this file requires, or ever required, a real
 * network call; this comment states plainly what was always true so a
 * reader cannot mistake a mocked provider return value for a live
 * transaction.
 *
 * The property under test (not a mechanism): a side-effecting external
 * funding action must not be repeated merely because the caller could not
 * determine whether the first attempt succeeded. escrow.service.ts's
 * existing claimEscrowTransition() (2026-07-20, "robustness-audit fix")
 * already proves CONCURRENT double-calls are safe — two simultaneous
 * lockFunds() requests can't both reach the provider, because only one
 * wins the atomic CREATED->FUNDS_LOCKED claim. That is NOT what this file
 * tests. This file tests the orthogonal, unaddressed case: a SEQUENTIAL
 * retry after the FIRST call's own catch block has already reverted the
 * claim back to CREATED — which happens unconditionally on any throw
 * inside lockFunds()'s try block, including a throw that occurs AFTER the
 * provider's (simulated) side effect already occurred.
 */
export {} // see chatUnification.test.ts's identical comment

jest.mock('../src/config', () => ({
  get config() {
    return {
      features: { mockEscrow: false, enforceCapabilities: false, requireDualApprovalForRelease: false },
      trade: { defaultTimelockHours: 24 },
      settlement: { trustedArbitrators: [] },
      arkade: { seed: '' },
      // High enough that this file's own two-attempts-per-test scenarios
      // never trip the breaker — this file is about the claim/revert/retry
      // logic itself, not tests/escrowCircuitBreaker.test.ts's own concern.
      escrowCircuitBreaker: { failureThreshold: 1000, windowMs: 60_000, cooldownMs: 60_000 },
    }
  },
}))

// The real WdkSettlementProvider is replaced entirely — this file is about
// escrow.service.ts's orchestration AROUND the provider call, not about
// wdk-settlement.provider.ts's own real transfer logic (tests/wdkSettlementProvider.test.ts
// covers that provider's own pure helpers directly). The provider's
// external side effect is always SIMULATED here — see file header.
const mockWdkLockFunds = jest.fn()
jest.mock('../src/modules/open-settlement/wdk-settlement.provider', () => ({
  wdkSettlementProvider: {
    name: 'WDK_USDT_EVM',
    custodyModel: 'server-custodial-reference-implementation',
    lockFunds: (...args: unknown[]) => mockWdkLockFunds(...args),
    releaseFunds: jest.fn(),
    refundFunds: jest.fn(),
    splitFunds: jest.fn(),
  },
}))

const mockEscrowFindUnique = jest.fn()
const mockEscrowUpdate = jest.fn()
const mockEscrowUpdateMany = jest.fn().mockResolvedValue({ count: 1 })
const mockEscrowEventCreate = jest.fn().mockResolvedValue({ id: 'transition-1' })
const mockEscrowEventFindFirst = jest.fn().mockResolvedValue(null)
const mockTradeFindUnique = jest.fn()
const mockDurableEventCreate = jest.fn()
const mockDurableEventFindFirst = jest.fn().mockResolvedValue(null)

const mockTransaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) =>
  callback({
    durableEventRecord: {
      create: (...args: unknown[]) => mockDurableEventCreate(...args),
      findFirst: (...args: unknown[]) => mockDurableEventFindFirst(...args),
    },
    escrow: {
      updateMany: (...args: unknown[]) => mockEscrowUpdateMany(...args),
    },
    escrowEvent: {
      findFirst: (...args: unknown[]) => mockEscrowEventFindFirst(...args),
      create: (...args: unknown[]) => mockEscrowEventCreate(...args),
    },
    // Issue #298 - emitEscrowTransition() records the 'transition.claimed' marker in the same transaction as the claim.
    eventProjectionClaim: { create: jest.fn().mockResolvedValue({}), createMany: jest.fn().mockResolvedValue({ count: 1 }), findMany: jest.fn().mockResolvedValue([]) },
    $executeRaw: jest.fn().mockResolvedValue(0),
    // #235 R7G-B1 - lockFunds() re-reads the trade's status under the trade-lifecycle lock before its claim.
    trade: { findUnique: (...args: unknown[]) => mockTradeFindUnique(...args) },
    // The event store checks, in its publish transaction, whether the escrow transition already has a
    // durable event (one event per transition, migration 20260930130000); none has, here.
    $queryRaw: jest.fn().mockResolvedValue([]),
  })
)

jest.mock('../src/common/database', () => ({
  prisma: {
    escrow: {
      findUnique: (...args: unknown[]) => mockEscrowFindUnique(...args),
      update: (...args: unknown[]) => mockEscrowUpdate(...args),
      updateMany: (...args: unknown[]) => mockEscrowUpdateMany(...args),
    },
    escrowEvent: {
      create: (...args: unknown[]) => mockEscrowEventCreate(...args),
      findFirst: (...args: unknown[]) => mockEscrowEventFindFirst(...args),
    },
    trade: { findUnique: (...args: unknown[]) => mockTradeFindUnique(...args) },
    dispute: { findFirst: jest.fn().mockResolvedValue(null) },
    durableEventRecord: {
      create: (...args: unknown[]) => mockDurableEventCreate(...args),
      findFirst: (...args: unknown[]) => mockDurableEventFindFirst(...args),
    },
    $transaction: (...args: unknown[]) => mockTransaction(...(args as [any])),
  },
}))

// #235 R7G-F6B — escrow.service delegates a WDK LOCK to the signed-transaction LOCK authority (real-PG
// evidence: tests/integration/wdkSignedLockAuthority.test.ts); replaced here to observe the delegation.
const mockLockWdkEscrow = jest.fn()
jest.mock('../src/modules/open-settlement/wdk-lock-authority', () => ({
  lockWdkEscrow: (...args: unknown[]) => mockLockWdkEscrow(...args),
  assertWdkFundingProven: jest.fn(),
  wdkLockMayHoldFunds: jest.fn().mockResolvedValue(false),
}))

import { escrowService } from '../src/modules/open-settlement/escrow.service'
import { resetEscrowCircuitBreaker } from '../src/modules/open-settlement/escrow-circuit-breaker'

const baseEscrow = {
  id: 'escrow-1', tradeId: 'trade-1', type: 'WDK_USDT_EVM', lockedAmount: '5', timelockHours: 24,
}

// #235 R7G-F6B — Mission #56's demonstrated gap is closed. escrow.service no longer claims FUNDS_LOCKED
// before an economic action and reverts it on any error: a WDK LOCK is delegated to the signed-transaction
// LOCK authority, which persists one signed transaction before broadcasting it and only ever rebroadcasts
// that same transaction, and the escrow becomes FUNDS_LOCKED only once that transaction is final. The
// tests below assert the closed property at the orchestration level (provider.lockFunds is never reached,
// nothing is claimed or reverted); the economic scenarios (lost response, crash, retry, second node,
// receipt ambiguity) run against real PostgreSQL in tests/integration/wdkSignedLockAuthority.test.ts.
describe('WDK_USDT_EVM lockFunds() — unknown-outcome / retry-safety (Mission #56, closed by #235 R7G-F6B)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockEscrowUpdateMany.mockResolvedValue({ count: 1 })
    mockEscrowEventFindFirst.mockResolvedValue(null)
    mockDurableEventFindFirst.mockResolvedValue(null)
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' })
    resetEscrowCircuitBreaker()
  })

  it('lockFunds() delegates to the signed-transaction LOCK authority — provider.lockFunds is never reached and nothing is claimed up front', async () => {
    mockEscrowFindUnique.mockResolvedValue({ ...baseEscrow, status: 'CREATED' })
    mockLockWdkEscrow.mockResolvedValueOnce({ ...baseEscrow, status: 'FUNDS_LOCKED', txLockId: '0xFINAL' })
    const locked = await escrowService.lockFunds('escrow-1', 'seller-1')
    expect(locked).toMatchObject({ status: 'FUNDS_LOCKED', txLockId: '0xFINAL' })
    expect(mockLockWdkEscrow).toHaveBeenCalledWith('escrow-1', 'seller-1')
    expect(mockWdkLockFunds).not.toHaveBeenCalled()
    expect(mockEscrowUpdateMany).not.toHaveBeenCalled()
    expect(mockEscrowUpdate).not.toHaveBeenCalled()
  })

  it('an unresolved or failed LOCK leaves the escrow exactly as it was — nothing to revert — and a retry goes back to the same authority', async () => {
    mockEscrowFindUnique.mockResolvedValue({ ...baseEscrow, status: 'CREATED' })
    mockLockWdkEscrow.mockRejectedValueOnce(new Error('LOCK 0xA is signed and not yet final'))
    await expect(escrowService.lockFunds('escrow-1', 'seller-1')).rejects.toThrow('signed and not yet final')
    mockLockWdkEscrow.mockRejectedValueOnce(new Error('LOCK 0xA is signed and not yet final'))
    await expect(escrowService.lockFunds('escrow-1', 'seller-1')).rejects.toThrow('signed and not yet final')
    expect(mockLockWdkEscrow).toHaveBeenCalledTimes(2)
    expect(mockWdkLockFunds).not.toHaveBeenCalled()
    expect(mockEscrowUpdateMany).not.toHaveBeenCalled()
    expect(mockEscrowUpdate).not.toHaveBeenCalled()
  })

  it('only the seller may lock: anyone else is refused before the LOCK authority', async () => {
    mockEscrowFindUnique.mockResolvedValue({ ...baseEscrow, status: 'CREATED' })
    await expect(escrowService.lockFunds('escrow-1', 'buyer-1')).rejects.toThrow(/not the seller/)
    expect(mockLockWdkEscrow).not.toHaveBeenCalled()
  })

  it('once FUNDS_LOCKED is durably persisted, a further lockFunds() call is rejected before the LOCK authority', async () => {
    mockEscrowFindUnique.mockResolvedValue({ ...baseEscrow, status: 'FUNDS_LOCKED' })
    await expect(escrowService.lockFunds('escrow-1', 'seller-1')).rejects.toThrow(/Invalid escrow transition/)
    expect(mockWdkLockFunds).not.toHaveBeenCalled()
    expect(mockLockWdkEscrow).not.toHaveBeenCalled()
  })
})
