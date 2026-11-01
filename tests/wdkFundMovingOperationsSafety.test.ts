/**
 * CTO Mission — WDK Fund-Moving Operations Safety Sweep (investigation
 * obligation derived from #56, docs/BACKLOG.md). Extends #56's
 * lockFunds()-only retry-safety investigation to releaseFunds(),
 * refundFunds(), and splitFunds() — the three other WDK_USDT_EVM methods
 * that self-initiate a real external transfer via
 * WalletAccountEvm.transfer().
 *
 * Same discipline as tests/wdkLockFundsRetrySafety.test.ts: the real,
 * unmocked Sails orchestration (escrow.service.ts/escrow-lifecycle.ts) is
 * DEMONSTRATED to run exactly as written — only the provider boundary and
 * the database are mocked. The provider's external side effect itself is
 * always SIMULATED — an in-memory test double, never a real network call.
 * No test in this file claims a real on-chain duplicate transfer or a
 * real partial fund loss; each demonstrates only what the real,
 * unmocked orchestration code does when a simulated side effect is
 * followed by an ambiguous or failed outcome.
 *
 * Full evidence and analysis: docs/WDK_FUND_MOVING_OPERATIONS_SAFETY.md.
 */
export {} // see chatUnification.test.ts's identical comment

jest.mock('../src/config', () => ({
  get config() {
    return {
      features: { mockEscrow: false, enforceCapabilities: false, requireDualApprovalForRelease: false },
      trade: { defaultTimelockHours: 24 },
      settlement: { trustedArbitrators: [] },
      arkade: { seed: '' },
      escrowCircuitBreaker: { failureThreshold: 1000, windowMs: 60_000, cooldownMs: 60_000 },
    }
  },
}))

const mockWdkReleaseFunds = jest.fn()
const mockWdkRefundFunds = jest.fn()
const mockWdkSplitFunds = jest.fn()
jest.mock('../src/modules/open-settlement/wdk-settlement.provider', () => ({
  wdkSettlementProvider: {
    name: 'WDK_USDT_EVM',
    custodyModel: 'server-custodial-reference-implementation',
    lockFunds: jest.fn(),
    releaseFunds: (...args: unknown[]) => mockWdkReleaseFunds(...args),
    refundFunds: (...args: unknown[]) => mockWdkRefundFunds(...args),
    splitFunds: (...args: unknown[]) => mockWdkSplitFunds(...args),
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
const mockDisputeFindFirst = jest.fn().mockResolvedValue(null)

const mockTransaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) =>
  callback({
    durableEventRecord: {
      create: (...args: unknown[]) => mockDurableEventCreate(...args),
      findFirst: (...args: unknown[]) => mockDurableEventFindFirst(...args),
    },
    escrow: {
      updateMany: (...args: unknown[]) => mockEscrowUpdateMany(...args),
      findUnique: (...args: unknown[]) => mockEscrowFindUnique(...args),
      update: (...args: unknown[]) => mockEscrowUpdate(...args),
    },
    escrowEvent: {
      findFirst: (...args: unknown[]) => mockEscrowEventFindFirst(...args),
      create: (...args: unknown[]) => mockEscrowEventCreate(...args),
    },
    // Issue #298 - emitEscrowTransition() records the 'transition.claimed' marker in the same transaction as the claim.
    eventProjectionClaim: { create: jest.fn().mockResolvedValue({}), createMany: jest.fn().mockResolvedValue({ count: 1 }), findMany: jest.fn().mockResolvedValue([]) },
    $executeRaw: jest.fn().mockResolvedValue(0),
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
    dispute: { findFirst: (...args: unknown[]) => mockDisputeFindFirst(...args) },
    durableEventRecord: {
      create: (...args: unknown[]) => mockDurableEventCreate(...args),
      findFirst: (...args: unknown[]) => mockDurableEventFindFirst(...args),
    },
    $transaction: (...args: unknown[]) => mockTransaction(...(args as [any])),
  },
}))

import { escrowService } from '../src/modules/open-settlement/escrow.service'
import { resetEscrowCircuitBreaker } from '../src/modules/open-settlement/escrow-circuit-breaker'

// feeObligationService.recordObligationForEscrowSettlement() is a real,
// unmocked no-op here: it returns immediately whenever
// escrow.feePolicyVersionId is falsy (fee-obligation.service.ts's own
// first line) — none of these fixtures set it, matching every other
// pre-existing release/refund/split test in this repository's own suite
// (tests/escrowReleaseControls.test.ts) that doesn't test fee policy
// specifically.

const baseEscrowPaymentPending = {
  id: 'escrow-1', tradeId: 'trade-1', type: 'WDK_USDT_EVM', lockedAmount: '5', timelockHours: 24, status: 'PAYMENT_PENDING',
}
const baseEscrowFundsLocked = {
  id: 'escrow-1', tradeId: 'trade-1', type: 'WDK_USDT_EVM', lockedAmount: '5', timelockHours: 24, status: 'FUNDS_LOCKED',
}
const baseEscrowDisputed = {
  id: 'escrow-1', tradeId: 'trade-1', type: 'WDK_USDT_EVM', lockedAmount: '5', timelockHours: 24, status: 'DISPUTED',
}

// #235 R7G-F6B / R7G-F6C — the gap this file demonstrated (a retry after a provider call that had already moved
// funds reached the provider again) cannot occur here: WDK outbound never reaches the provider's (transfer())
// methods at all - it is executed by the signed outbound authority (wdk-outbound-authority.ts, proven on real
// PostgreSQL in tests/integration/wdkOutboundAuthority.test.ts), and without its network policy (no chain, no
// finality rule, no corroborating RPC, no gas caps - as in this unit environment) release, refund and split are
// refused before any claim, so a first call and a retry both reach the provider zero times.
describe('WDK_USDT_EVM releaseFunds()/refundFunds()/splitFunds() — fund-moving operations safety sweep', () => {
  const refused = /WDK_USDT_EVM outbound settlement for escrow escrow-1 is unavailable: no .* configured \(network policy\)/

  beforeEach(() => {
    jest.clearAllMocks()
    mockEscrowUpdateMany.mockResolvedValue({ count: 1 })
    mockEscrowEventFindFirst.mockResolvedValue(null)
    mockDurableEventFindFirst.mockResolvedValue(null)
    mockDisputeFindFirst.mockResolvedValue(null)
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' })
    resetEscrowCircuitBreaker()
  })

  const nothingClaimed = () => expect(mockEscrowUpdateMany.mock.calls.filter(([a]: any[]) => a?.data?.status)).toHaveLength(0)

  it('releaseFunds(): the first call and a retry are both refused before any claim — the provider is reached zero times', async () => {
    mockEscrowFindUnique.mockResolvedValue({ ...baseEscrowPaymentPending })
    await expect(escrowService.releaseFunds('escrow-1', '0xbuyer', 'seller-1')).rejects.toThrow(refused)
    await expect(escrowService.releaseFunds('escrow-1', '0xbuyer', 'seller-1')).rejects.toThrow(refused)
    expect(mockWdkReleaseFunds).not.toHaveBeenCalled()
    nothingClaimed()
  })

  it('refundFunds(): the first call and a retry are both refused before any claim — the provider is reached zero times', async () => {
    mockEscrowFindUnique.mockResolvedValue({ ...baseEscrowFundsLocked })
    await expect(escrowService.refundFunds('escrow-1', 'seller-1')).rejects.toThrow(refused)
    await expect(escrowService.refundFunds('escrow-1', 'seller-1')).rejects.toThrow(refused)
    expect(mockWdkRefundFunds).not.toHaveBeenCalled()
    nothingClaimed()
  })

  it('splitFunds(): both legs are unreachable — the first call and a retry are refused before any claim', async () => {
    mockEscrowFindUnique.mockResolvedValue({ ...baseEscrowDisputed })
    mockDisputeFindFirst.mockResolvedValue({ id: 'dispute-1', tradeId: 'trade-1', arbiterId: 'arbiter-1' })
    await expect(escrowService.splitFunds('escrow-1', '0xbuyer', '0xseller', 6000, 'arbiter-1')).rejects.toThrow(refused)
    await expect(escrowService.splitFunds('escrow-1', '0xbuyer', '0xseller', 6000, 'arbiter-1')).rejects.toThrow(refused)
    expect(mockWdkSplitFunds).not.toHaveBeenCalled()
    nothingClaimed()
  })

  it('the refusal is a capability refusal (UNAVAILABLE), distinguishable from an economic failure', async () => {
    mockEscrowFindUnique.mockResolvedValue({ ...baseEscrowPaymentPending })
    await expect(escrowService.releaseFunds('escrow-1', '0xbuyer', 'seller-1')).rejects.toMatchObject({ reason: 'UNAVAILABLE', statusCode: 409 })
  })

  it('a non-transitionable state is still refused by the state machine first', async () => {
    mockEscrowFindUnique.mockResolvedValue({ ...baseEscrowPaymentPending, status: 'COMPLETED' })
    await expect(escrowService.releaseFunds('escrow-1', '0xbuyer', 'seller-1')).rejects.toThrow(/Invalid escrow transition/)
    expect(mockWdkReleaseFunds).not.toHaveBeenCalled()
  })
})
