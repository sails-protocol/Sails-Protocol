/**
 * RFC-007 D8/D9 Outcome Engine — the dispute-aware branching in
 * common/events/handlers.ts's settlement.escrow.released/refunded
 * reactions. This is the one genuinely new piece of business logic in
 * the open-reputation pass (everything else is route wiring around an
 * existing service) — worth verifying directly, the same way
 * disputeFlow.test.ts verifies dispute.service.ts's own branching rather
 * than only exercising it through an HTTP round-trip.
 */
export {} // forces this file to be an ES module — see chatUnification.test.ts's
// identical comment for why this matters (no top-level import/export
// otherwise means top-level `const`s leak into the global scope and can
// collide with another require()-only test file's identically-named ones).

const mockTradeUpdate = jest.fn()
// Issue #294/#298 - the settlement handlers now read the Trade row (findUnique) and project its status
// through TradeRepository.projectEscrowStatus (derived from the persisted Escrow), so the row and the
// projection are separate mocks; mockTradeUpdate remains only for settlement.escrow.created (Trade.escrowId).
const mockTradeFindUnique = jest.fn()
const mockProjectEscrowStatus = jest.fn().mockResolvedValue({ applied: true })
const mockDisputeFindFirst = jest.fn()
// Issue #254 - checked BEFORE the legacy mockDisputeFindFirst fallback; null by default so every existing
// test in this file (which asserts against the legacy Dispute-based query) is unaffected unless a test
// explicitly wants to exercise the new MULTISIG semantic_transition_records provenance path instead.
const mockSemanticTransitionRecordFindFirst = jest.fn().mockResolvedValue(null)
const mockUserUpdate = jest.fn()
const mockEscrowFindUnique = jest.fn()
// RFC-021 D7 — vouch.service.ts's burn is now applied from the same
// settlement.escrow.released/refunded reactions this file tests.
// Defaults to "no active vouch" so every pre-existing test above is
// unaffected; the dedicated D7 describe block below overrides these.
const mockVouchFindMany = jest.fn().mockResolvedValue([])
const mockVouchUpdate = jest.fn().mockResolvedValue({ count: 1 })

// Issue #298 - a faithful in-memory model of the projection-claim table: createMany({skipDuplicates})
// returns count 0 for an identity already claimed, exactly as ON CONFLICT DO NOTHING does.
const claimStore = new Set<string>()
const fakeTx = {
  $executeRaw: jest.fn().mockResolvedValue(0),
  eventProjectionClaim: {
    createMany: async ({ data }: { data: Array<{ eventId: string; projectionKey: string; subjectId: string }> }) => {
      let count = 0
      for (const d of data) {
        const key = `${d.eventId}|${d.projectionKey}|${d.subjectId}`
        if (!claimStore.has(key)) { claimStore.add(key); count++ }
      }
      return { count }
    },
  },
  user: { update: (...args: unknown[]) => mockUserUpdate(...args) },
  escrow: { findUnique: (...args: unknown[]) => mockEscrowFindUnique(...args) },
  vouch: {
    findMany: (...args: unknown[]) => mockVouchFindMany(...args),
    updateMany: (...args: unknown[]) => mockVouchUpdate(...args),
  },
}

jest.mock('../src/common/database', () => ({
  prisma: {
    trade: {
      update: (...args: unknown[]) => mockTradeUpdate(...args),
      findUnique: (...args: unknown[]) => mockTradeFindUnique(...args),
    },
    dispute: { findFirst: (...args: unknown[]) => mockDisputeFindFirst(...args) },
    semanticTransitionRecord: { findFirst: (...args: unknown[]) => mockSemanticTransitionRecordFindFirst(...args) },
    user: { update: (...args: unknown[]) => mockUserUpdate(...args) },
    escrow: { findUnique: (...args: unknown[]) => mockEscrowFindUnique(...args) },
    $transaction: (cb: (tx: unknown) => Promise<unknown>) => cb(fakeTx),
  },
}))

jest.mock('../src/modules/open-p2p/trade-repository', () => ({
  tradeRepository: { projectEscrowStatus: (...args: unknown[]) => mockProjectEscrowStatus(...args) },
}))

const mockEmit = jest.fn().mockResolvedValue(undefined)
const handlers: Record<string, (payload: unknown) => Promise<void>> = {}
let eventSeq = 0
jest.mock('../src/common/events/event-bus', () => ({
  eventBus: {
    emit: (...args: unknown[]) => mockEmit(...args),
    on: (event: string, handler: (payload: unknown) => Promise<void>) => {
      handlers[event] = handler
    },
    // The settlement handlers are durable consumers now (Issue #298): they receive the DurableEvent
    // (eventId + payload). Each invocation here models ONE distinct durable event.
    onDurable: (event: string, handler: (e: unknown) => Promise<void>) => {
      handlers[event] = (payload: unknown) =>
        handler({ eventId: `evt-${++eventSeq}`, eventName: event, correlationId: 'trade-1', payload, publishedAt: '', entryHash: '', prevHash: '' })
    },
  },
}))

jest.mock('../src/modules/open-p2p/reconciliation.service', () => ({
  reconciliationService: { reconcilePeerPair: jest.fn().mockResolvedValue([]) },
}))

// RFC-018 — handlers.ts now calls intentEngine.transition() from these
// same reactions; mocked wholesale (rather than the internal prisma
// chain intentEngine.transition() itself makes) so this file can assert
// on the call without re-deriving that chain — that internal mechanism
// is already covered by tests/intentFlow.test.ts.
const mockIntentTransition = jest.fn().mockResolvedValue(undefined)
jest.mock('../src/core/intent-engine', () => ({
  intentEngine: { transition: (...args: unknown[]) => mockIntentTransition(...args) },
}))

// @tetherto/wdk-wallet-evm ships pure ESM (no CJS build) — handlers.ts now
// transitively imports it via settlement-orchestrator.ts/escrow.service.ts/
// wdk-settlement.provider.ts (executeSettlement()'s auto-settle-on-match
// wiring). None of this suite's tests trigger openp2p.trade.created, so
// it's mocked out entirely, same reasoning as routes.test.ts.
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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { registerEventHandlers } = require('../src/common/events/handlers')

describe('RFC-007 D8/D9 Outcome Engine (dispute-aware, via settlement.escrow.released/refunded handlers)', () => {
  beforeAll(() => {
    registerEventHandlers()
  })

  beforeEach(() => {
    jest.clearAllMocks()
    claimStore.clear()
    mockProjectEscrowStatus.mockResolvedValue({ applied: true })
    mockVouchUpdate.mockResolvedValue({ count: 1 })
    mockTradeUpdate.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1', amount: '0.01', intentId: 'intent-1' })
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1', amount: '0.01', intentId: 'intent-1' })
    mockUserUpdate.mockResolvedValue({ id: 'x', reputationScore: 0, totalTrades: 0 })
    // RFC-021 D4, Phase 3 default: bootstrap-phase escrow, no protocol fee
    // charged (config.settlement.protocolFeeRate === 0, the documented
    // default) — most tests below don't care about this dimension at all.
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', feeCharged: null })
  })

  it('happy-path completion (no dispute): both parties get POSITIVE outcomes', async () => {
    mockDisputeFindFirst.mockResolvedValueOnce(null) // no resolved RELEASE dispute for this trade

    await handlers['settlement.escrow.released']({ tradeId: 'trade-1', escrowId: 'escrow-1', triggeredBy: 'buyer-1', from: 'PAYMENT_PENDING', to: 'COMPLETED' })

    // 2 calls for totalTrades/totalVolumeBtc + 2 calls inside recordOutcome
    // (buyer, seller) — reputationScore increments are the ones that matter here.
    const scoreUpdates = mockUserUpdate.mock.calls.filter((c) => c[0]?.data?.reputationScore)
    expect(scoreUpdates).toHaveLength(2)
    expect(scoreUpdates.find((c) => c[0].where.id === 'buyer-1')?.[0].data.reputationScore).toEqual({ increment: 2 })
    expect(scoreUpdates.find((c) => c[0].where.id === 'seller-1')?.[0].data.reputationScore).toEqual({ increment: 2 })
  })

  it('completion via a RELEASE dispute ruling: buyer POSITIVE, seller NEGATIVE — not both Positive', async () => {
    mockDisputeFindFirst.mockResolvedValueOnce({ id: 'dispute-1', tradeId: 'trade-1', status: 'RESOLVED', ruling: 'RELEASE' })

    await handlers['settlement.escrow.released']({ tradeId: 'trade-1', escrowId: 'escrow-1', triggeredBy: 'arbiter-1', from: 'DISPUTED', to: 'COMPLETED' })

    const scoreUpdates = mockUserUpdate.mock.calls.filter((c) => c[0]?.data?.reputationScore)
    expect(scoreUpdates.find((c) => c[0].where.id === 'buyer-1')?.[0].data.reputationScore).toEqual({ increment: 2 })
    expect(scoreUpdates.find((c) => c[0].where.id === 'seller-1')?.[0].data.reputationScore).toEqual({ increment: -5 })
  })

  it('plain refund with no dispute ever raised: both parties NEUTRAL (RFC-007 D9 — never Negative)', async () => {
    mockDisputeFindFirst.mockResolvedValueOnce(null)

    await handlers['settlement.escrow.refunded']({ tradeId: 'trade-1', escrowId: 'escrow-1', triggeredBy: 'seller-1', from: 'FUNDS_LOCKED', to: 'REFUNDED' })

    const scoreUpdates = mockUserUpdate.mock.calls.filter((c) => c[0]?.data?.reputationScore)
    expect(scoreUpdates.find((c) => c[0].where.id === 'buyer-1')?.[0].data.reputationScore).toEqual({ increment: 0 })
    expect(scoreUpdates.find((c) => c[0].where.id === 'seller-1')?.[0].data.reputationScore).toEqual({ increment: 0 })
  })

  it('refund via a REFUND dispute ruling: seller POSITIVE, buyer NEGATIVE — not both Neutral', async () => {
    mockDisputeFindFirst.mockResolvedValueOnce({ id: 'dispute-1', tradeId: 'trade-1', status: 'RESOLVED', ruling: 'REFUND' })

    await handlers['settlement.escrow.refunded']({ tradeId: 'trade-1', escrowId: 'escrow-1', triggeredBy: 'arbiter-1', from: 'DISPUTED', to: 'REFUNDED' })

    const scoreUpdates = mockUserUpdate.mock.calls.filter((c) => c[0]?.data?.reputationScore)
    expect(scoreUpdates.find((c) => c[0].where.id === 'buyer-1')?.[0].data.reputationScore).toEqual({ increment: -5 })
    expect(scoreUpdates.find((c) => c[0].where.id === 'seller-1')?.[0].data.reputationScore).toEqual({ increment: 2 })
  })
})

// RFC-021 D9 (2026-08-02) — settlement.escrow.split has no happy-path
// equivalent (SPLIT only ever comes from a dispute ruling) and no clean
// winner/loser, unlike released/refunded above — both parties get NEUTRAL,
// same "always Neutral, never Negative" precedent RFC-007 D9 already sets
// for a plain refund, and no vouch is burned on either side.
describe('settlement.escrow.split (RFC-021 D9) — NEUTRAL for both, no vouch burned, Trade -> COMPLETED', () => {
  beforeAll(() => {
    registerEventHandlers()
  })

  beforeEach(() => {
    jest.clearAllMocks()
    claimStore.clear()
    mockProjectEscrowStatus.mockResolvedValue({ applied: true })
    mockVouchUpdate.mockResolvedValue({ count: 1 })
    mockTradeUpdate.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1', amount: '0.01', intentId: 'intent-1' })
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1', amount: '0.01', intentId: 'intent-1' })
    mockUserUpdate.mockResolvedValue({ id: 'x', reputationScore: 0, totalTrades: 0 })
  })

  it('scores both parties NEUTRAL and never touches vouches', async () => {
    await handlers['settlement.escrow.split']({ tradeId: 'trade-1', escrowId: 'escrow-1', triggeredBy: 'arbiter-1', from: 'DISPUTED', to: 'SPLIT' })

    // Issue #294 - the Trade status is projected from the persisted Escrow (never from the event payload).
    expect(mockProjectEscrowStatus).toHaveBeenCalledWith('trade-1', 'escrow-1', { tx: expect.anything() })

    const scoreUpdates = mockUserUpdate.mock.calls.filter((c) => c[0]?.data?.reputationScore)
    expect(scoreUpdates.find((c) => c[0].where.id === 'buyer-1')?.[0].data.reputationScore).toEqual({ increment: 0 })
    expect(scoreUpdates.find((c) => c[0].where.id === 'seller-1')?.[0].data.reputationScore).toEqual({ increment: 0 })

    expect(mockVouchFindMany).not.toHaveBeenCalled()
    expect(mockVouchUpdate).not.toHaveBeenCalled()
  })

  it('increments totalTrades/totalVolumeBtc for both parties, same as a real settlement action', async () => {
    await handlers['settlement.escrow.split']({ tradeId: 'trade-1', escrowId: 'escrow-1', triggeredBy: 'arbiter-1', from: 'DISPUTED', to: 'SPLIT' })

    const volumeUpdates = mockUserUpdate.mock.calls.filter((c) => c[0]?.data?.totalTrades)
    expect(volumeUpdates.find((c) => c[0].where.id === 'buyer-1')?.[0].data).toMatchObject({ totalTrades: { increment: 1 }, totalVolumeBtc: { increment: '0.01' } })
    expect(volumeUpdates.find((c) => c[0].where.id === 'seller-1')?.[0].data).toMatchObject({ totalTrades: { increment: 1 }, totalVolumeBtc: { increment: '0.01' } })
  })

  it('walks the Intent through SETTLING then FULFILLED, in order', async () => {
    await handlers['settlement.escrow.split']({ tradeId: 'trade-1', escrowId: 'escrow-1', triggeredBy: 'arbiter-1', from: 'DISPUTED', to: 'SPLIT' })

    expect(mockIntentTransition).toHaveBeenNthCalledWith(2, 'intent-1', 'SETTLING', 'system:trade-lifecycle', 'intent.settling', expect.objectContaining({ intentId: 'intent-1' }))
    // Issue #291 hardening: a settled escrow proves the funds were locked, so the Intent is first caught up to COMMITTED
    expect(mockIntentTransition).toHaveBeenNthCalledWith(1, 'intent-1', 'COMMITTED', 'system:trade-lifecycle', 'intent.committed', expect.objectContaining({ intentId: 'intent-1' }))
    expect(mockIntentTransition).toHaveBeenNthCalledWith(3, 'intent-1', 'FULFILLED', 'system:trade-lifecycle', 'intent.fulfilled', expect.objectContaining({ intentId: 'intent-1', outcome: 'SPLIT' }))
  })
})

// RFC-021 D4, Phase 3 — the cost-to-fabricate-reputation floor. Only the
// settlement.escrow.released reaction wires this (refunds never charge a
// protocol fee — escrow.service.ts's chargeProtocolFee() is only called
// from releaseFunds()).
describe('RFC-021 D4 — cumulativeFeesObserved wiring (settlement.escrow.released)', () => {
  beforeAll(() => {
    registerEventHandlers()
  })

  beforeEach(() => {
    jest.clearAllMocks()
    claimStore.clear()
    mockProjectEscrowStatus.mockResolvedValue({ applied: true })
    mockVouchUpdate.mockResolvedValue({ count: 1 })
    mockTradeUpdate.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1', amount: '0.01', intentId: 'intent-1' })
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1', amount: '0.01', intentId: 'intent-1' })
    mockUserUpdate.mockResolvedValue({ id: 'x', reputationScore: 0, totalTrades: 0 })
    mockDisputeFindFirst.mockResolvedValue(null)
  })

  it('accrues Escrow.feeCharged onto both parties when a real fee was charged', async () => {
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', feeCharged: '0.0205' })

    await handlers['settlement.escrow.released']({ tradeId: 'trade-1', escrowId: 'escrow-1', triggeredBy: 'buyer-1', from: 'PAYMENT_PENDING', to: 'COMPLETED' })

    const feeUpdates = mockUserUpdate.mock.calls.filter((c) => c[0]?.data?.cumulativeFeesObserved)
    expect(feeUpdates).toHaveLength(2)
    expect(feeUpdates.find((c) => c[0].where.id === 'buyer-1')?.[0].data.cumulativeFeesObserved).toEqual({ increment: '0.0205' })
    expect(feeUpdates.find((c) => c[0].where.id === 'seller-1')?.[0].data.cumulativeFeesObserved).toEqual({ increment: '0.0205' })
  })

  it('leaves cumulativeFeesObserved untouched when no fee was charged (bootstrap-phase default)', async () => {
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', feeCharged: null })

    await handlers['settlement.escrow.released']({ tradeId: 'trade-1', escrowId: 'escrow-1', triggeredBy: 'buyer-1', from: 'PAYMENT_PENDING', to: 'COMPLETED' })

    const feeUpdates = mockUserUpdate.mock.calls.filter((c) => c[0]?.data?.cumulativeFeesObserved)
    expect(feeUpdates).toHaveLength(0)
  })
})

// RFC-018 (rfcs/RFC-018-intent-as-canonical-trade-entry-point.md) —
// the same three handlers above (plus settlement.escrow.locked) also
// drive the originating Intent's lifecycle now. Verified directly here
// since these are the real call sites, not just intent-engine.ts's own
// internal transition() logic (already covered by intentFlow.test.ts).
describe('RFC-018 — Intent lifecycle driven by settlement.escrow.* handlers', () => {
  beforeAll(() => {
    registerEventHandlers()
  })

  beforeEach(() => {
    jest.clearAllMocks()
    claimStore.clear()
    mockProjectEscrowStatus.mockResolvedValue({ applied: true })
    mockVouchUpdate.mockResolvedValue({ count: 1 })
    mockTradeUpdate.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1', amount: '0.01', intentId: 'intent-1' })
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1', amount: '0.01', intentId: 'intent-1' })
    mockUserUpdate.mockResolvedValue({ id: 'x', reputationScore: 0, totalTrades: 0 })
    mockDisputeFindFirst.mockResolvedValue(null)
  })

  it('settlement.escrow.locked transitions the Intent to COMMITTED', async () => {
    await handlers['settlement.escrow.locked']({ tradeId: 'trade-1', escrowId: 'escrow-1', triggeredBy: 'seller-1', from: 'CREATED', to: 'FUNDS_LOCKED' })

    expect(mockIntentTransition).toHaveBeenCalledWith(
      'intent-1', 'COMMITTED', 'system:trade-lifecycle', 'intent.committed',
      expect.objectContaining({ intentId: 'intent-1', settlementId: 'escrow-1' })
    )
  })

  it('settlement.escrow.locked skips Intent transition when the Trade predates RFC-018 (intentId null)', async () => {
    mockTradeFindUnique.mockResolvedValueOnce({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1', amount: '0.01', intentId: null })

    await handlers['settlement.escrow.locked']({ tradeId: 'trade-1', escrowId: 'escrow-1', triggeredBy: 'seller-1', from: 'CREATED', to: 'FUNDS_LOCKED' })

    expect(mockIntentTransition).not.toHaveBeenCalled()
  })

  it('settlement.escrow.released walks the Intent through SETTLING then FULFILLED, in order', async () => {
    await handlers['settlement.escrow.released']({ tradeId: 'trade-1', escrowId: 'escrow-1', triggeredBy: 'buyer-1', from: 'PAYMENT_PENDING', to: 'COMPLETED' })

    const calls = mockIntentTransition.mock.calls.map((c) => c[1]) // toStatus per call
    expect(calls).toEqual(['COMMITTED', 'SETTLING', 'FULFILLED'])
  })

  it('settlement.escrow.refunded transitions the Intent to FAILED', async () => {
    await handlers['settlement.escrow.refunded']({ tradeId: 'trade-1', escrowId: 'escrow-1', triggeredBy: 'seller-1', from: 'FUNDS_LOCKED', to: 'REFUNDED' })

    expect(mockIntentTransition).toHaveBeenCalledWith(
      'intent-1', 'FAILED', 'system:trade-lifecycle', 'intent.failed',
      expect.objectContaining({ intentId: 'intent-1' })
    )
  })
})

// Gap found investigating a CTO-role follow-up ("disputa durante
// negociação" — RFC-018 failure-scenario coverage): createEscrow() emits
// settlement.escrow.created but never itself writes Trade.escrowId (its
// own module-boundary rule forbids writing another module's table), and
// nothing else did either — so Trade.escrowId was permanently null against
// a real database, meaning dispute.service.ts's raiseDispute() guard
// (`if (!trade.escrowId) throw ...`) rejected every dispute, unconditionally,
// regardless of trade status. This is the regression test for the fix.
describe('RFC-018 gap fix — settlement.escrow.created persists Trade.escrowId', () => {
  beforeAll(() => {
    registerEventHandlers()
  })

  beforeEach(() => {
    jest.clearAllMocks()
    claimStore.clear()
    mockProjectEscrowStatus.mockResolvedValue({ applied: true })
    mockVouchUpdate.mockResolvedValue({ count: 1 })
    mockTradeUpdate.mockResolvedValue({ id: 'trade-1', escrowId: 'escrow-1' })
  })

  it('settlement.escrow.created writes escrow.id onto Trade.escrowId — the FK dispute.service.ts requires to raise a dispute at all', async () => {
    await handlers['settlement.escrow.created']({
      tradeId: 'trade-1', escrowId: 'escrow-1', type: 'MOCK', lockedAmount: '20.5', asset: 'USDT_ERC20',
    })

    expect(mockTradeUpdate).toHaveBeenCalledWith({
      where: { id: 'trade-1' },
      data: { escrowId: 'escrow-1' },
    })
  })
})

// RFC-021 D7 — the losing party's active vouch (if any) is burned as part
// of the SAME dispute-aware branch reputationOutcome's own describe block
// above tests, not a separate reaction.
describe('RFC-021 D7 — vouch burned on the losing party of a resolved dispute', () => {
  beforeAll(() => {
    registerEventHandlers()
  })

  beforeEach(() => {
    jest.clearAllMocks()
    claimStore.clear()
    mockProjectEscrowStatus.mockResolvedValue({ applied: true })
    mockVouchUpdate.mockResolvedValue({ count: 1 })
    mockTradeUpdate.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1', amount: '0.01', intentId: 'intent-1' })
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1', amount: '0.01', intentId: 'intent-1' })
    mockUserUpdate.mockResolvedValue({ id: 'x', reputationScore: 0, totalTrades: 0 })
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', feeCharged: null })
    mockVouchFindMany.mockResolvedValue([])
  })

  it('burns the seller\'s active vouch on a RELEASE ruling (seller lost)', async () => {
    mockDisputeFindFirst.mockResolvedValueOnce({ id: 'dispute-1', tradeId: 'trade-1', status: 'RESOLVED', ruling: 'RELEASE' })
    mockVouchFindMany.mockResolvedValueOnce([{ id: 'vouch-1', voucherId: 'voucher-1', voucheeId: 'seller-1', burnedAt: null }])

    await handlers['settlement.escrow.released']({ tradeId: 'trade-1', escrowId: 'escrow-1', triggeredBy: 'arbiter-1', from: 'DISPUTED', to: 'COMPLETED' })

    expect(mockVouchFindMany).toHaveBeenCalledWith({ where: { voucheeId: 'seller-1', burnedAt: null } })
    expect(mockVouchUpdate).toHaveBeenCalledWith({ where: { id: 'vouch-1', burnedAt: null }, data: { burnedAt: expect.any(Date) } })
    const voucherPenalty = mockUserUpdate.mock.calls.find((c) => c[0].where.id === 'voucher-1')
    expect(voucherPenalty?.[0].data.reputationScore).toEqual({ increment: -5 })
  })

  it('burns the buyer\'s active vouch on a REFUND ruling (buyer lost)', async () => {
    mockDisputeFindFirst.mockResolvedValueOnce({ id: 'dispute-1', tradeId: 'trade-1', status: 'RESOLVED', ruling: 'REFUND' })
    mockVouchFindMany.mockResolvedValueOnce([{ id: 'vouch-1', voucherId: 'voucher-1', voucheeId: 'buyer-1', burnedAt: null }])

    await handlers['settlement.escrow.refunded']({ tradeId: 'trade-1', escrowId: 'escrow-1', triggeredBy: 'arbiter-1', from: 'DISPUTED', to: 'REFUNDED' })

    expect(mockVouchFindMany).toHaveBeenCalledWith({ where: { voucheeId: 'buyer-1', burnedAt: null } })
    const voucherPenalty = mockUserUpdate.mock.calls.find((c) => c[0].where.id === 'voucher-1')
    expect(voucherPenalty?.[0].data.reputationScore).toEqual({ increment: -5 })
  })

  it('does nothing when the losing party has no active vouch', async () => {
    mockDisputeFindFirst.mockResolvedValueOnce({ id: 'dispute-1', tradeId: 'trade-1', status: 'RESOLVED', ruling: 'RELEASE' })
    mockVouchFindMany.mockResolvedValueOnce([])

    await handlers['settlement.escrow.released']({ tradeId: 'trade-1', escrowId: 'escrow-1', triggeredBy: 'arbiter-1', from: 'DISPUTED', to: 'COMPLETED' })

    expect(mockVouchUpdate).not.toHaveBeenCalled()
  })

  it('does NOT burn anything on a happy-path completion (no dispute at all)', async () => {
    mockDisputeFindFirst.mockResolvedValueOnce(null)

    await handlers['settlement.escrow.released']({ tradeId: 'trade-1', escrowId: 'escrow-1', triggeredBy: 'buyer-1', from: 'PAYMENT_PENDING', to: 'COMPLETED' })

    expect(mockVouchFindMany).not.toHaveBeenCalled()
  })
})
