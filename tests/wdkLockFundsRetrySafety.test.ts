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

import { escrowService } from '../src/modules/open-settlement/escrow.service'
import { resetEscrowCircuitBreaker } from '../src/modules/open-settlement/escrow-circuit-breaker'

const baseEscrow = {
  id: 'escrow-1', tradeId: 'trade-1', type: 'WDK_USDT_EVM', lockedAmount: '5', timelockHours: 24,
}

describe('WDK_USDT_EVM lockFunds() — unknown-outcome / retry-safety (Mission #56)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockEscrowUpdateMany.mockResolvedValue({ count: 1 })
    mockEscrowEventFindFirst.mockResolvedValue(null)
    mockDurableEventFindFirst.mockResolvedValue(null)
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' })
    resetEscrowCircuitBreaker()
  })

  // ─── DEMONSTRATED RETRY-SAFETY GAP — variant 1: side effect succeeds, a
  // LATER step fails ──────────────────────────────────────────────────────
  // The provider call itself resolves (a SIMULATED side effect — standing
  // in for an externally-visible economic action having occurred), but a
  // step AFTER that call — here, the DB write that would have persisted
  // the resulting txId — throws. escrow.service.ts's catch block does not,
  // and cannot, distinguish "the provider itself failed" from "the
  // provider succeeded and something else failed" — it reverts
  // unconditionally. DEMONSTRATED refers to the real, unmocked
  // orchestration's behavior; the side effect itself is SIMULATED (see
  // file header) — no real network call is made.
  it('a local persistence failure AFTER a successful (simulated) provider call reverts the escrow to CREATED with no record of the txId, and a retry invokes the provider a second time', async () => {
    mockEscrowFindUnique.mockResolvedValue({ ...baseEscrow, status: 'CREATED' })

    // Attempt 1: the (simulated) provider call resolves successfully.
    mockWdkLockFunds.mockResolvedValueOnce({ txId: '0xSIMULATED_TX_1', address: '0xescrowAddr1' })
    // The FIRST prisma.escrow.update() call inside lockFunds() is
    // updateLockResult() — persisting txLockId/lockedAt/expiresAt. Fails
    // here, simulating an ordinary, non-exotic operational fault (a
    // dropped Postgres connection, a pool-exhaustion timeout — nothing
    // provider-specific).
    mockEscrowUpdate.mockRejectedValueOnce(new Error('simulated: Postgres connection lost mid-write'))
    // #241: rollback no longer consumes prisma.escrow.update(); it is a
    // status-bound updateMany(FUNDS_LOCKED -> CREATED). Do not enqueue an
    // update() result for rollback here: doing so would leak into the retry's
    // updateLockResult() mock and falsely make a successful retry look CREATED.

    await expect(escrowService.lockFunds('escrow-1', 'seller-1')).rejects.toThrow(
      'simulated: Postgres connection lost mid-write'
    )

    // The (simulated) provider call happened exactly once.
    expect(mockWdkLockFunds).toHaveBeenCalledTimes(1)

    // Two escrow.update() calls occurred: the failed persistence attempt,
    // then the revert. Confirm the revert is unconditional and blind to
    // *why* the try block failed — it always reverts to the escrow's
    // pre-claim status, never inspecting whether the provider's side
    // effect already completed.
    expect(mockEscrowUpdate).toHaveBeenCalledTimes(1)
    expect(mockEscrowUpdateMany).toHaveBeenCalledWith({ where: { id: 'escrow-1', status: 'FUNDS_LOCKED' }, data: { status: 'CREATED' } })

    // The dispositive check: the txId from the successful (simulated)
    // provider call (0xSIMULATED_TX_1) was NEVER successfully persisted
    // anywhere. The first update() call did attempt to carry it —
    // confirming the attempt was made — but that exact call is the one
    // that REJECTED (already proven above by `.rejects.toThrow('simulated:
    // Postgres connection lost mid-write')`, since that rejection could
    // only have come from this call). The second (revert) call's data has
    // no txLockId field at all. Sails' own durable state therefore
    // retains no trace of the txId the provider returned.
    expect(mockEscrowUpdate).toHaveBeenNthCalledWith(1, {
      where: { id: 'escrow-1' },
      data: expect.objectContaining({ txLockId: '0xSIMULATED_TX_1' }),
    })
    const rollbackCallData = mockEscrowUpdateMany.mock.calls.find((call: any[]) => call[0]?.where?.status === 'FUNDS_LOCKED')?.[0]?.data
    expect(rollbackCallData).not.toHaveProperty('txLockId')

    // Retry: an operator or an automatic caller, seeing lockFunds() throw
    // and observing escrow.status is (once again) CREATED, does the only
    // thing the current design allows — retries the identical logical
    // action. Nothing in escrow.service.ts or the escrow-repository layer
    // remembers that the provider's side effect already occurred.
    mockEscrowFindUnique.mockResolvedValue({ ...baseEscrow, status: 'CREATED' })
    mockWdkLockFunds.mockResolvedValueOnce({ txId: '0xSIMULATED_TX_2', address: '0xescrowAddr1' })
    mockEscrowUpdate.mockResolvedValueOnce({ ...baseEscrow, status: 'FUNDS_LOCKED', txLockId: '0xSIMULATED_TX_2' })

    const retried = await escrowService.lockFunds('escrow-1', 'seller-1')
    expect(retried.status).toBe('FUNDS_LOCKED')

    // DEMONSTRATED (for the real, unmocked Sails orchestration): the
    // provider was invoked a SECOND time for the same logical lock action.
    // This is NOT a claim that real funds were moved twice on a live
    // network — no network call was made anywhere in this test (SIMULATED,
    // see file header). What is demonstrated, precisely: Sails' own
    // orchestration code provides no mechanism that would have prevented
    // a real provider (had one been wired in) from being asked to repeat
    // its side effect after the first attempt's outcome became ambiguous
    // to Sails.
    expect(mockWdkLockFunds).toHaveBeenCalledTimes(2)
  })

  // ─── DEMONSTRATED RETRY-SAFETY GAP — variant 2: the true "submit then
  // throw" / lost-response scenario ──────────────────────────────────────
  // Unlike the test above (where the provider call itself RESOLVES and a
  // later step fails), this models the provider's own call REJECTING
  // after its side effect already occurred — the lost-response case the
  // mission specifically asks for: a real caller would see this as "the
  // provider threw," with no txId ever returned, indistinguishable from a
  // pre-submission failure UNLESS something recorded that the side effect
  // happened first. The fake provider here does exactly that recording,
  // deliberately visible only to the test (never to escrow.service.ts,
  // which sees only a rejected promise) — proving Sails' own orchestration
  // has no way to know the difference.
  it('a provider call that performs its (simulated) side effect and THEN throws — never returning a txId — still allows the same logical operation to reach the provider a second time', async () => {
    const externalEffects: Array<{ escrowId: string; destination: string; amount: string }> = []

    mockEscrowFindUnique.mockResolvedValue({ ...baseEscrow, status: 'CREATED' })

    // Attempt 1: the fake provider records that its side effect happened
    // (visible to this test only, standing in for "a real RPC node
    // accepted the broadcast"), then throws BEFORE returning anything to
    // the caller — modeling a response lost after submission. No txId is
    // ever returned to escrow.service.ts on this call.
    mockWdkLockFunds.mockImplementationOnce(async (escrow: { id: string; lockedAmount: string }) => {
      externalEffects.push({ escrowId: escrow.id, destination: '0xescrowAddr1', amount: escrow.lockedAmount })
      throw new Error('simulated: response lost after submission')
    })

    await expect(escrowService.lockFunds('escrow-1', 'seller-1')).rejects.toThrow(
      'simulated: response lost after submission'
    )

    // The side effect happened exactly once so far, and Sails never saw a
    // txId for it (the provider threw before returning one) — confirmed
    // by the fact that lockFunds() rejected at all, and by the revert
    // below carrying no txLockId.
    expect(externalEffects).toHaveLength(1)
    expect(mockEscrowUpdate).not.toHaveBeenCalled() // updateLockResult() was never reached
    expect(mockEscrowUpdateMany).toHaveBeenCalledWith({ where: { id: 'escrow-1', status: 'FUNDS_LOCKED' }, data: { status: 'CREATED' } })

    // Retry: the same logical lock operation is invoked again. This time
    // the fake provider records a second side effect and succeeds.
    mockEscrowFindUnique.mockResolvedValue({ ...baseEscrow, status: 'CREATED' })
    mockWdkLockFunds.mockImplementationOnce(async (escrow: { id: string; lockedAmount: string }) => {
      externalEffects.push({ escrowId: escrow.id, destination: '0xescrowAddr1', amount: escrow.lockedAmount })
      return { txId: '0xSIMULATED_TX_RETRY', address: '0xescrowAddr1' }
    })
    mockEscrowUpdate.mockResolvedValueOnce({ ...baseEscrow, status: 'FUNDS_LOCKED', txLockId: '0xSIMULATED_TX_RETRY' })

    const retried = await escrowService.lockFunds('escrow-1', 'seller-1')
    expect(retried.status).toBe('FUNDS_LOCKED')

    // The dispositive assertion: the SAME logical operation caused the
    // (simulated) external side effect TWICE.
    //
    // Permitted claim: Sails orchestration demonstrates retry after a
    // simulated post-submission unknown outcome — the real, unmocked
    // claimEscrowTransition -> provider call -> catch -> revertEscrowStatus
    // -> retry path genuinely allows this sequence to occur, exactly as
    // exercised here.
    //
    // Forbidden claim, NOT made: this is not "a real on-chain duplicate
    // transfer" — no network call occurred; `externalEffects` is an
    // in-memory array in this test file, not a blockchain.
    expect(externalEffects).toHaveLength(2)
    expect(externalEffects[0].escrowId).toBe(externalEffects[1].escrowId)
    expect(mockWdkLockFunds).toHaveBeenCalledTimes(2)
  })

  // ─── CONTRAST: the case the existing design DOES handle safely ───────
  // A provider failure that occurs BEFORE any side effect (a pure
  // configuration/validation error — nothing was ever broadcast, real or
  // simulated) is genuinely safe to retry: no external state changed, so
  // reverting to CREATED and trying again is correct. This is the case
  // tests/escrowReleaseControls.test.ts's own "a provider lock failure
  // leaves the escrow unpersisted... Retry" test already exercises for a
  // different provider. Included here as a same-file contrast so the
  // boundary between "safe to retry" and "not yet proven safe to retry"
  // is explicit, not just asserted in prose.
  it('a pre-submission provider failure (no side effect at all) is safe to retry — contrast case', async () => {
    mockEscrowFindUnique.mockResolvedValue({ ...baseEscrow, status: 'CREATED' })
    mockWdkLockFunds.mockRejectedValueOnce(new Error('WDK_USDT_EVM provider requires WDK_SEED_PHRASE configured'))
    // #241 rollback is updateMany(FUNDS_LOCKED -> CREATED), not update().

    await expect(escrowService.lockFunds('escrow-1', 'seller-1')).rejects.toThrow('WDK_SEED_PHRASE')
    expect(mockWdkLockFunds).toHaveBeenCalledTimes(1)

    // Retry with a "fixed" provider — succeeds cleanly, provider called
    // exactly once more (total 2 calls across the whole test — 1 genuine
    // failure + 1 genuine success, never two successful side effects).
    mockEscrowFindUnique.mockResolvedValue({ ...baseEscrow, status: 'CREATED' })
    mockWdkLockFunds.mockResolvedValueOnce({ txId: '0xSIMULATED_TX', address: '0xescrowAddr1' })
    mockEscrowUpdate.mockResolvedValueOnce({ ...baseEscrow, status: 'FUNDS_LOCKED', txLockId: '0xSIMULATED_TX' })

    const result = await escrowService.lockFunds('escrow-1', 'seller-1')
    expect(result.status).toBe('FUNDS_LOCKED')
    expect(mockWdkLockFunds).toHaveBeenCalledTimes(2)
  })

  // ─── The boundary that IS protected today ─────────────────────────────
  // Once an escrow has genuinely, successfully reached FUNDS_LOCKED, a
  // further lockFunds() call is correctly rejected by assertEscrowTransition
  // — this is not in question and this file does not claim otherwise. The
  // gap demonstrated above exists ONLY in the window between "the provider
  // call resolved (or threw after its side effect)" and "the resulting
  // state was durably persisted."
  it('once FUNDS_LOCKED is durably persisted, a further lockFunds() call is rejected — the already-protected case', async () => {
    mockEscrowFindUnique.mockResolvedValue({ ...baseEscrow, status: 'FUNDS_LOCKED' })

    await expect(escrowService.lockFunds('escrow-1', 'seller-1')).rejects.toThrow(/Invalid escrow transition/)
    expect(mockWdkLockFunds).not.toHaveBeenCalled()
  })
})
