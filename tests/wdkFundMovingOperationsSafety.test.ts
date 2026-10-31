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

describe('WDK_USDT_EVM releaseFunds()/refundFunds()/splitFunds() — fund-moving operations safety sweep', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockEscrowUpdateMany.mockResolvedValue({ count: 1 })
    mockEscrowEventFindFirst.mockResolvedValue(null)
    mockDurableEventFindFirst.mockResolvedValue(null)
    mockDisputeFindFirst.mockResolvedValue(null)
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' })
    resetEscrowCircuitBreaker()
  })

  // ─── releaseFunds() — the true "submit then throw" scenario ──────────
  // Mirrors #56's own critical test exactly, for a different WDK method:
  // the provider records that its (simulated) side effect happened, then
  // throws before ever returning a txId. escrow.service.ts's structure
  // here is IDENTICAL to lockFunds()'s (claim -> provider call -> catch
  // -> revertEscrowStatus), so this test demonstrates the same class of
  // gap, not a new mechanism.
  describe('releaseFunds()', () => {
    it('a provider call that performs its (simulated) side effect and THEN throws still allows the same logical operation to reach the provider a second time', async () => {
      const externalEffects: string[] = []
      mockEscrowFindUnique.mockResolvedValue({ ...baseEscrowPaymentPending })

      mockWdkReleaseFunds.mockImplementationOnce(async () => {
        externalEffects.push('release-attempt-1')
        throw new Error('simulated: response lost after submission')
      })

      await expect(escrowService.releaseFunds('escrow-1', '0xbuyer', 'seller-1')).rejects.toThrow(
        'simulated: response lost after submission'
      )
      expect(externalEffects).toHaveLength(1)
      // Only the revert write happened — updateReleaseResult() was never
      // reached, since the provider call itself threw.
      expect(mockEscrowUpdate).not.toHaveBeenCalled()
      expect(mockEscrowUpdateMany).toHaveBeenCalledWith({ where: { id: 'escrow-1', status: 'COMPLETED' }, data: { status: 'PAYMENT_PENDING' } })

      // Retry: the same logical release is invoked again.
      mockEscrowFindUnique.mockResolvedValue({ ...baseEscrowPaymentPending })
      mockWdkReleaseFunds.mockImplementationOnce(async () => {
        externalEffects.push('release-attempt-2')
        return { txId: '0xSIMULATED_RELEASE_TX' }
      })
      mockEscrowUpdate.mockResolvedValueOnce({ ...baseEscrowPaymentPending, status: 'COMPLETED', txReleaseId: '0xSIMULATED_RELEASE_TX' })

      const retried = await escrowService.releaseFunds('escrow-1', '0xbuyer', 'seller-1')
      expect(retried.status).toBe('COMPLETED')

      // Permitted claim: Sails orchestration demonstrates retry after a
      // simulated post-submission unknown outcome. Not claimed: a real
      // on-chain duplicate transfer.
      expect(externalEffects).toEqual(['release-attempt-1', 'release-attempt-2'])
      expect(mockWdkReleaseFunds).toHaveBeenCalledTimes(2)
    })

    it('once COMPLETED is durably persisted, a further releaseFunds() call is rejected — the already-protected boundary', async () => {
      mockEscrowFindUnique.mockResolvedValue({ ...baseEscrowPaymentPending, status: 'COMPLETED' })
      await expect(escrowService.releaseFunds('escrow-1', '0xbuyer', 'seller-1')).rejects.toThrow(/Invalid escrow transition/)
      expect(mockWdkReleaseFunds).not.toHaveBeenCalled()
    })
  })

  // ─── refundFunds() — identical property, identical mechanism ─────────
  describe('refundFunds()', () => {
    it('a provider call that performs its (simulated) side effect and THEN throws still allows the same logical operation to reach the provider a second time', async () => {
      const externalEffects: string[] = []
      mockEscrowFindUnique.mockResolvedValue({ ...baseEscrowFundsLocked })

      mockWdkRefundFunds.mockImplementationOnce(async () => {
        externalEffects.push('refund-attempt-1')
        throw new Error('simulated: response lost after submission')
      })

      await expect(escrowService.refundFunds('escrow-1', 'seller-1')).rejects.toThrow(
        'simulated: response lost after submission'
      )
      expect(externalEffects).toHaveLength(1)
      expect(mockEscrowUpdate).not.toHaveBeenCalled()
      expect(mockEscrowUpdateMany).toHaveBeenCalledWith({ where: { id: 'escrow-1', status: 'REFUNDED' }, data: { status: 'FUNDS_LOCKED' } })

      mockEscrowFindUnique.mockResolvedValue({ ...baseEscrowFundsLocked })
      mockWdkRefundFunds.mockImplementationOnce(async () => {
        externalEffects.push('refund-attempt-2')
        return { txId: '0xSIMULATED_REFUND_TX' }
      })
      mockEscrowUpdate.mockResolvedValueOnce({ ...baseEscrowFundsLocked, status: 'REFUNDED', txReleaseId: '0xSIMULATED_REFUND_TX' })

      const retried = await escrowService.refundFunds('escrow-1', 'seller-1')
      expect(retried.status).toBe('REFUNDED')
      expect(externalEffects).toEqual(['refund-attempt-1', 'refund-attempt-2'])
      expect(mockWdkRefundFunds).toHaveBeenCalledTimes(2)
    })

    it('once REFUNDED is durably persisted, a further refundFunds() call is rejected — the already-protected boundary', async () => {
      mockEscrowFindUnique.mockResolvedValue({ ...baseEscrowFundsLocked, status: 'REFUNDED' })
      await expect(escrowService.refundFunds('escrow-1', 'seller-1')).rejects.toThrow(/Invalid escrow transition/)
      expect(mockWdkRefundFunds).not.toHaveBeenCalled()
    })
  })

  // ─── splitFunds() — Property B: multi-leg partial execution ──────────
  // WdkSettlementProvider.splitFunds() (wdk-settlement.provider.ts) makes
  // TWO SEQUENTIAL, independent transfer() calls with no shared-recipient
  // primitive and no partial-result return path: if the second call
  // throws, the function itself throws, and the FIRST leg's result
  // (already a real, side-effecting call if it had run against a live
  // provider) is discarded entirely — never returned, never logged, never
  // persisted anywhere. These tests model that exact shape with a fake
  // provider standing in for the two legs.
  describe('splitFunds()', () => {
    beforeEach(() => {
      mockDisputeFindFirst.mockResolvedValue({ id: 'dispute-1', tradeId: 'trade-1', arbiterId: 'arbiter-1' })
    })

    // Scenario named explicitly by the mission: leg 1 succeeds, leg 2
    // throws WITHOUT leg 2 ever attempting its own side effect (leg 2
    // fails "before submission" — e.g. a pre-flight validation/gas-quote
    // failure specific to the second transfer).
    it('leg 1 succeeds (simulated) and leg 2 throws before its own side effect — retry repeats leg 1', async () => {
      const legEffects: string[] = []
      mockEscrowFindUnique.mockResolvedValue({ ...baseEscrowDisputed })

      mockWdkSplitFunds.mockImplementationOnce(async () => {
        legEffects.push('leg1-attempt-1') // leg 1's (simulated) transfer happens
        throw new Error('simulated: leg 2 failed before its own side effect') // leg 2 never attempted
      })

      await expect(
        escrowService.splitFunds('escrow-1', '0xbuyer', '0xseller', 6000, 'arbiter-1')
      ).rejects.toThrow('simulated: leg 2 failed before its own side effect')

      expect(legEffects).toEqual(['leg1-attempt-1'])
      // The dispositive check for Property B: updateSplitResult() is
      // NEVER called on a partial failure (it only runs after the whole
      // provider.splitFunds() promise resolves with BOTH txIds) — so
      // Sails persists ZERO knowledge that leg 1's side effect happened.
      // Only the revert write occurred.
      expect(mockEscrowUpdate).not.toHaveBeenCalled()
      expect(mockEscrowUpdateMany).toHaveBeenCalledWith({ where: { id: 'escrow-1', status: 'SPLIT' }, data: { status: 'DISPUTED' } })

      // Retry: the same logical split is invoked again. Because Sails
      // never learned leg 1 already happened, the ONLY operation it can
      // request is the whole splitFunds() call again — there is no
      // "resume from leg 2" path anywhere in this orchestration.
      mockEscrowFindUnique.mockResolvedValue({ ...baseEscrowDisputed })
      mockWdkSplitFunds.mockImplementationOnce(async () => {
        legEffects.push('leg1-attempt-2') // leg 1's side effect happens AGAIN
        legEffects.push('leg2-attempt-1')
        return { txIds: ['0xSIMULATED_LEG1_TX', '0xSIMULATED_LEG2_TX'] }
      })
      mockEscrowUpdate.mockResolvedValueOnce({ ...baseEscrowDisputed, status: 'SPLIT', txReleaseId: '0xSIMULATED_LEG1_TX,0xSIMULATED_LEG2_TX' })

      const retried = await escrowService.splitFunds('escrow-1', '0xbuyer', '0xseller', 6000, 'arbiter-1')
      expect(retried.status).toBe('SPLIT')

      // Permitted claim, demonstrated: Sails orchestration permits partial
      // simulated multi-leg execution without durable knowledge sufficient
      // to safely resume — the retry re-triggered leg 1's side effect a
      // second time. NOT claimed: "two successful token transfers" (only
      // two tx hashes were ever returned from the mock, on the successful
      // call) or "funds were duplicated" (no live network was used).
      expect(legEffects).toEqual(['leg1-attempt-1', 'leg1-attempt-2', 'leg2-attempt-1'])
      expect(mockWdkSplitFunds).toHaveBeenCalledTimes(2)
    })

    // Desirable second scenario named by the mission: leg 2 ALSO performs
    // its own (simulated) side effect before throwing — never returning
    // its identity to the caller. Distinguishes "leg 2 never attempted"
    // (above) from "leg 2 attempted but its result was lost" — both
    // collapse into the identical observable behavior from
    // escrow.service.ts's point of view (a rejected promise, whole-escrow
    // revert), which is itself part of the finding: Sails cannot tell
    // these two cases apart today.
    it('leg 1 succeeds and leg 2 ALSO performs its (simulated) side effect before throwing — indistinguishable from leg 2 never attempting at all', async () => {
      const legEffects: string[] = []
      mockEscrowFindUnique.mockResolvedValue({ ...baseEscrowDisputed })

      mockWdkSplitFunds.mockImplementationOnce(async () => {
        legEffects.push('leg1-attempt-1')
        legEffects.push('leg2-attempt-1') // leg 2's side effect ALSO happens this time
        throw new Error('simulated: leg 2 response lost after its own submission')
      })

      await expect(
        escrowService.splitFunds('escrow-1', '0xbuyer', '0xseller', 6000, 'arbiter-1')
      ).rejects.toThrow('simulated: leg 2 response lost after its own submission')

      // Same observable outcome as the previous test from
      // escrow.service.ts's side: one failed call, one revert, zero
      // persistence — even though this time BOTH legs' side effects
      // actually occurred. This is the dispositive evidence that Sails
      // cannot distinguish "leg 2 never tried" from "leg 2 tried and its
      // result was lost" — both look identical: a rejected promise.
      expect(legEffects).toEqual(['leg1-attempt-1', 'leg2-attempt-1'])
      expect(mockEscrowUpdate).not.toHaveBeenCalled()
      expect(mockEscrowUpdateMany).toHaveBeenCalledWith({ where: { id: 'escrow-1', status: 'SPLIT' }, data: { status: 'DISPUTED' } })
    })

    it('once SPLIT is durably persisted, a further splitFunds() call is rejected — the already-protected boundary', async () => {
      mockEscrowFindUnique.mockResolvedValue({ ...baseEscrowDisputed, status: 'SPLIT' })
      await expect(
        escrowService.splitFunds('escrow-1', '0xbuyer', '0xseller', 6000, 'arbiter-1')
      ).rejects.toThrow(/Invalid escrow transition/)
      expect(mockWdkSplitFunds).not.toHaveBeenCalled()
    })
  })
})
