/**
 * Fase 1, Task 1 (Qwen brief) — race condition on escrow release/refund.
 *
 * Before writing this, read escrow.service.ts directly: the "Robustness-
 * audit fix (2026-07-20)" already claims every status transition
 * atomically via a conditional `prisma.escrow.updateMany({ where: { id,
 * status: <the status this call observed> }, data: { status: <next> } })`
 * *before* ever calling the (possibly fund-moving) SettlementProvider —
 * see that file's own comments on lockFunds()/releaseFunds()/refundFunds().
 * No `version` integer field and no Redis distributed lock exist there,
 * and neither is needed: Postgres's own row-level `UPDATE ... WHERE`
 * semantics already make the database the sole arbiter of which
 * concurrent caller's write actually lands — a `version` column would be
 * a second, redundant optimistic-lock discriminant doing the same job
 * `status` already does, given `status` is exactly what every one of
 * these transitions is conditioned on; a Redis lock would only add value
 * if multiple independent processes/lock managers weren't already backed
 * by that same single Postgres row, which they are. So this test does
 * NOT add either — it proves the existing atomic-claim design actually
 * holds under concurrent calls, which the existing test suite
 * (escrowReleaseControls.test.ts) never did: every test there mocks
 * `updateMany` to a hardcoded `{ count: 1 }`, so none of them exercise
 * what happens when a second concurrent caller's WHERE clause stops
 * matching.
 *
 * What this test can and can't prove, stated precisely (same discipline
 * transportFallback.test.ts's own doc comment uses): a mocked Prisma
 * client with real shared mutable state proves the *service-layer*
 * logic correctly treats `updateMany`'s `count` as the sole source of
 * truth for "did my transition actually win" and rejects when it
 * didn't. It does not (and cannot, without a live Postgres instance
 * under real concurrent transactions) prove Postgres's own MVCC/row-lock
 * guarantees — that property is Postgres's, not this codebase's, the
 * same boundary escrow.service.ts's own comments already draw ("Postgres
 * itself is the arbiter").
 *
 * The scenario: an escrow in DISPUTED status (VALID_TRANSITIONS allows
 * both COMPLETED and REFUNDED from there) with an assigned arbiter who
 * calls releaseFunds() and refundFunds() concurrently — the literal
 * "releaseFunds e requestRefund concorrentes" scenario the brief named,
 * using this codebase's real method name (refundFunds, not
 * requestRefund — no method by that name exists here).
 */
export {} // same forced-module reasoning as chatUnification.test.ts

jest.mock('../src/config', () => ({
  config: {
    features: { mockEscrow: true, enforceCapabilities: false, requireDualApprovalForRelease: false },
    trade: { defaultTimelockHours: 24 },
    // RFC-021 Phase 0 — releaseFunds() now always reads
    // config.settlement.protocolFeeRate; 0 matches the documented
    // bootstrap default and keeps this race-condition test focused on
    // its own concern (the atomic-claim guarantee), not fee math.
    settlement: { protocolFeeRate: 0 },
    // 2026-08-15 — escrow-circuit-breaker.ts (claimEscrowTransition()'s
    // new first line) needs this. High threshold so it never interferes
    // with what this file actually tests (the atomic-claim guarantee
    // itself, exercised via many concurrent losing attempts on one
    // escrow within a single test) — the breaker's own behavior is
    // covered separately in tests/escrowCircuitBreaker.test.ts.
    escrowCircuitBreaker: { failureThreshold: 1000, windowMs: 60_000, cooldownMs: 60_000 },
  },
}))

jest.mock('@tetherto/wdk-wallet-evm', () => ({
  __esModule: true,
  default: class FakeWalletManagerEvm {},
}))

// @arkade-os/sdk's CJS build still transitively requires @scure/btc-signer,
// which ships pure ESM (no CJS build) — same "Unexpected token 'export'"
// problem as @tetherto/wdk-wallet-evm above, same fix. None of these tests
// exercise lightning-hodl.provider.ts's real Arkade calls.
jest.mock('@arkade-os/sdk', () => ({
  SeedIdentity: { fromSeed: jest.fn() },
  MultisigTapscript: { encode: jest.fn() },
  CSVMultisigTapscript: { encode: jest.fn() },
  VtxoScript: class FakeVtxoScript {},
  RestArkProvider: class FakeRestArkProvider {},
  RestIndexerProvider: class FakeRestIndexerProvider {},
  buildOffchainTx: jest.fn(),
  combineTapscriptSigs: jest.fn(),
  verifyTapscriptSignatures: jest.fn(),
}))

// lightning-hodl.provider.ts's Phase 2 addition imports @scure/btc-signer
// directly (pure ESM, same reason @arkade-os/sdk itself is mocked above)
// — this test never reaches those code paths, a bare stub is enough.
jest.mock('@scure/btc-signer', () => ({ Transaction: { fromPSBT: jest.fn() } }))

// A minimal, real (not stubbed-out) simulation of what actually makes the
// atomic-claim pattern safe: one shared mutable row, and updateMany()
// only applying (and reporting count: 1) when its WHERE.status still
// matches the row's *current* status at the moment it runs — exactly
// Postgres's own conditional-UPDATE semantics, just single-threaded.
const fakeDb = {
  escrow: {
    id: 'escrow-1',
    tradeId: 'trade-1',
    type: 'MOCK',
    status: 'DISPUTED',
    lockedAmount: '20.5',
    asset: 'USDT_ERC20',
    timelockHours: 24,
    txReleaseId: null as string | null,
  },
}

const mockDisputeFindFirst = jest.fn().mockResolvedValue({ id: 'dispute-1', tradeId: 'trade-1', arbiterId: 'arbiter-1' })

// Missão 05.5 — emitEscrowTransition() reads the last event for this
// escrowId (findFirst) before creating the next one, to compute
// prevHash. null is correct here: every race scenario in this file
// starts a fresh escrow with no prior event.
//
// Missão 11 Fase 9.7 — emitEscrowTransition() now does its own
// escrowEvent existence-check-then-create INSIDE withEscrowFundingLock()
// (an escrowId-scoped pg_advisory_xact_lock, via prisma.$transaction()) —
// these same two mocks are reused on the `tx` object below so both the
// top-level and transactional escrowEvent access route through one
// shared, observable mock.
const mockEscrowEventCreate = jest.fn().mockResolvedValue({ id: 'transition-1' })
const mockEscrowEventFindFirst = jest.fn().mockResolvedValue(null)

jest.mock('../src/common/database', () => ({
  prisma: {
    escrow: {
      findUnique: jest.fn(async () => ({ ...fakeDb.escrow })),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (fakeDb.escrow.status !== where.status) return { count: 0 }
        fakeDb.escrow.status = data.status
        return { count: 1 }
      }),
      update: jest.fn(async ({ data }: any) => {
        Object.assign(fakeDb.escrow, data)
        return { ...fakeDb.escrow }
      }),
    },
    escrowEvent: { create: (...args: unknown[]) => mockEscrowEventCreate(...args), findFirst: (...args: unknown[]) => mockEscrowEventFindFirst(...args) },
    trade: {
      findUnique: jest.fn().mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' }),
    },
    dispute: { findFirst: (...args: unknown[]) => mockDisputeFindFirst(...args) },
    capabilityGrant: { findMany: jest.fn().mockResolvedValue([]) },
    escrowReleaseApproval: { count: jest.fn().mockResolvedValue(0) },
    // withEscrowFundingLock() (escrow-lifecycle.ts) — a no-real-locking
    // passthrough is enough here (this file's own concern is the
    // updateMany-based atomic claim above, not the funding-reorg lock;
    // that mechanism has its own dedicated real-Postgres proof in
    // tests/integration/escrowFundingConcurrency.test.ts).
    $transaction: jest.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        // Issue #298 - emitEscrowTransition() records the 'transition.claimed' marker in the same transaction as the claim.
        eventProjectionClaim: { create: jest.fn().mockResolvedValue({}), createMany: jest.fn().mockResolvedValue({ count: 1 }), findMany: jest.fn().mockResolvedValue([]) },
        $executeRaw: jest.fn().mockResolvedValue(0),
        // Issue #291 - persistSettlementResult() reads then writes the escrow inside its own locked transaction.
        escrow: {
          findUnique: jest.fn(async () => ({ ...fakeDb.escrow })),
          update: jest.fn(async ({ data }: any) => { Object.assign(fakeDb.escrow, data); return { ...fakeDb.escrow } }),
        },
        escrowEvent: { findFirst: (...args: unknown[]) => mockEscrowEventFindFirst(...args), create: (...args: unknown[]) => mockEscrowEventCreate(...args) },
      })
    ),
  },
}))

jest.mock('../src/common/events/event-bus', () => ({
  eventBus: { emit: jest.fn().mockResolvedValue(undefined) },
}))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { escrowService } = require('../src/modules/open-settlement/escrow.service')

describe('Race condition — concurrent releaseFunds() vs refundFunds() on the same escrow', () => {
  beforeEach(() => {
    fakeDb.escrow.status = 'DISPUTED'
    fakeDb.escrow.txReleaseId = null
    jest.clearAllMocks()
    mockDisputeFindFirst.mockResolvedValue({ id: 'dispute-1', tradeId: 'trade-1', arbiterId: 'arbiter-1' })
  })

  it('lets exactly one of two concurrent calls succeed — the loser is rejected, not double-applied', async () => {
    const results = await Promise.allSettled([
      escrowService.releaseFunds('escrow-1', '0xbuyer', 'arbiter-1'),
      escrowService.refundFunds('escrow-1', 'arbiter-1'),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(
      /already transitioned by a concurrent request/
    )

    // The escrow ended up in exactly one terminal state, never both —
    // the actual property "no double-payment" reduces to: the row's
    // final status is either COMPLETED (release won) or REFUNDED
    // (refund won), and whichever it is matches which promise fulfilled.
    expect(['COMPLETED', 'REFUNDED']).toContain(fakeDb.escrow.status)
  })

  it('never lets both a release AND a refund land — repeated across many interleavings, not just one lucky ordering', async () => {
    // Promise resolution order in a single-threaded mock is still
    // deterministic per run, so this repeats the race under slightly
    // different microtask timings (a resolved-immediately findUnique vs
    // one delayed by a tick) to avoid the result being an artifact of
    // one specific interleaving rather than the guard itself.
    for (let i = 0; i < 20; i++) {
      fakeDb.escrow.status = 'DISPUTED'
      // Each iteration models a FRESH escrow: a settlement result is write-once (Issue #291), so a
      // result left over from the previous iteration would (correctly) make the next one a conflict.
      fakeDb.escrow.txReleaseId = null
      const delayFirst = i % 2 === 0
      const release = (delayFirst ? Promise.resolve().then(() => null) : Promise.resolve()).then(() =>
        escrowService.releaseFunds('escrow-1', '0xbuyer', 'arbiter-1')
      )
      const refund = escrowService.refundFunds('escrow-1', 'arbiter-1')

      const results = await Promise.allSettled([release, refund])
      const fulfilledCount = results.filter((r) => r.status === 'fulfilled').length
      expect(fulfilledCount).toBe(1)
    }
  })
})
