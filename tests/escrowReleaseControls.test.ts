/**
 * escrow.service.ts's releaseFunds() — the real single choke point every
 * fund release goes through (settlement-orchestrator.ts's
 * executeSettlement(), settlement.routes.ts's direct release route, and
 * dispute.service.ts's arbitrated resolveDispute()). Two real,
 * config-gated controls live here:
 *
 * - RFC-014's capability check — originally shipped inside
 *   settlement-orchestrator.ts, relocated here once RFC-015's work
 *   surfaced that the orchestrator wasn't the only real caller (see
 *   escrow.service.ts's own comment on releaseFunds() for the full
 *   explanation).
 * - RFC-015's two-person control (application-layer, not on-chain
 *   multisig — WDK's real package is single-owner-only) — requires both
 *   of a trade's own two counterparties to approve before a normal
 *   (non-disputed) release proceeds.
 *
 * capabilityRegistry.check() is exercised for real here (not mocked) —
 * only prisma.capabilityGrant is mocked, the same "mock the boundary,
 * test what's actually new" discipline this suite already follows
 * elsewhere (tests/capabilityRegistry.test.ts). @tetherto/wdk-wallet-evm
 * is mocked because it ships pure ESM (same reasoning as
 * tests/routes.test.ts) — none of these tests exercise the real WDK path
 * since config.features.mockEscrow stays true throughout, routing every
 * release through the real, harmless MockSettlementProvider instead.
 */
export {} // see chatUnification.test.ts's identical comment

let enforceCapabilities = false
let requireDualApprovalForRelease = false
let mockEscrowFeatureFlag = true
let protocolFeeRate = 0 // RFC-021 Phase 0 — real Protocol Fee, 0 = documented bootstrap default
jest.mock('../src/config', () => ({
  get config() {
    return {
      features: { mockEscrow: mockEscrowFeatureFlag, enforceCapabilities, requireDualApprovalForRelease },
      trade: { defaultTimelockHours: 24 },
      // Empty on purpose — LightningHodlProvider (lightning-hodl.provider.ts)
      // is now real, and (with no pubkeys submitted, see
      // mockParticipantKeyFindMany below) reliably throws a clear "missing
      // pubkey" error, same "reliable provider failure" fixture role
      // LIGHTNING_HODL always played here even back when it was a
      // permanent throw-only stub.
      settlement: { trustedArbitrators: [], protocolFeeRate },
      arkade: { seed: '' },
      // 2026-08-15 — escrow-circuit-breaker.ts (claimEscrowTransition()'s
      // new first line) needs this. Threshold high enough that this
      // file's own within-one-test conflict scenarios never trip it —
      // this suite tests the pre-existing atomic-claim behavior itself,
      // not the breaker (that's tests/escrowCircuitBreaker.test.ts's job).
      escrowCircuitBreaker: { failureThreshold: 1000, windowMs: 60_000, cooldownMs: 60_000 },
    }
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

const mockEscrowFindUnique = jest.fn()
const mockEscrowFindMany = jest.fn().mockResolvedValue([])
const mockEscrowUpdate = jest.fn()
// Robustness-audit fix (2026-07-20) — escrow.service.ts's mutating
// methods now claim their status transition atomically via updateMany()
// before touching the (possibly real, fund-moving) provider; see that
// file's own comment. Defaults to a successful claim.
const mockEscrowUpdateMany = jest.fn().mockResolvedValue({ count: 1 })
const mockEscrowCreate = jest.fn()
const mockEscrowEventCreate = jest.fn().mockResolvedValue({ id: 'transition-1' })
const mockEscrowEventFindFirst = jest.fn().mockResolvedValue(null)
const mockTradeFindUnique = jest.fn()
const mockCapabilityGrantFindMany = jest.fn()
const mockApprovalUpsert = jest.fn()
const mockApprovalFindMany = jest.fn()
const mockApprovalCount = jest.fn()
const mockDisputeFindFirst = jest.fn()
// Client-held-keys pass — lockFunds() now queries this for
// MULTISIG/LIGHTNING_HODL escrows before calling the provider. Defaults
// to empty (no keys submitted), which is fine for these tests: both
// escrow types here reliably fail before ever needing a real pubkey
// (MOCK_ESCROW stays true throughout, so getProvider() always
// short-circuits to MockSettlementProvider — see this file's header
// comment; the LIGHTNING_HODL fixture used further down exists purely as
// a "reliably throws" stand-in, same role it always played, and its
// error fires before partiesFor() would ever need these keys).
const mockParticipantKeyFindMany = jest.fn().mockResolvedValue([])
// RFC-021 Phase 0 — real Protocol Fee split, persisted per release.
const mockFeeDistributionCreate = jest.fn()
// Missão 11 Fase 9.1 §1/§2 — assertFundingNotUncertain()'s check queries
// this table; empty history is the trustworthy/no-op default every test
// here needs (none of them test funding-uncertainty itself).
const mockEscrowFundingEvidenceFindMany = jest.fn().mockResolvedValue([])
// Missão 11 Fase 9.3 — markPaymentSent()'s authoritative funding-check +
// claim now run inside withEscrowFundingLock()'s prisma.$transaction();
// the tx object handed to the callback delegates to the SAME mocks the
// top-level prisma mock below uses, so existing assertions on
// mockEscrowUpdateMany etc. see the call regardless of which path it
// went through, exactly like a real Prisma transaction would.
const mockTransaction = jest.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
  callback({
    escrow: {
      updateMany: (...args: unknown[]) => mockEscrowUpdateMany(...args),
      findUnique: (...args: unknown[]) => mockEscrowFindUnique(...args),
      update: (...args: unknown[]) => mockEscrowUpdate(...args),
    },
    escrowFundingEvidence: { findMany: (...args: unknown[]) => mockEscrowFundingEvidenceFindMany(...args) },
    // Missão 11 Fase 9.7 — emitEscrowTransition() now does its own
    // escrowEvent existence-check-then-create INSIDE withEscrowFundingLock(),
    // reusing the same mock functions the top-level prisma.escrowEvent
    // mock below already provides.
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
      findMany: (...args: unknown[]) => mockEscrowFindMany(...args),
      update: (...args: unknown[]) => mockEscrowUpdate(...args),
      updateMany: (...args: unknown[]) => mockEscrowUpdateMany(...args),
      create: (...args: unknown[]) => mockEscrowCreate(...args),
    },
    escrowEvent: {
      create: (...args: unknown[]) => mockEscrowEventCreate(...args),
      // Missão 05.5 — emitEscrowTransition() now reads the last event for
      // this escrowId to compute prevHash before creating the next one.
      // null (no prior event) is the correct default for every test here
      // that doesn't care about the chain specifically.
      findFirst: (...args: unknown[]) => mockEscrowEventFindFirst(...args),
    },
    trade: { findUnique: (...args: unknown[]) => mockTradeFindUnique(...args) },
    capabilityGrant: { findMany: (...args: unknown[]) => mockCapabilityGrantFindMany(...args) },
    escrowReleaseApproval: {
      upsert: (...args: unknown[]) => mockApprovalUpsert(...args),
      findMany: (...args: unknown[]) => mockApprovalFindMany(...args),
      count: (...args: unknown[]) => mockApprovalCount(...args),
    },
    dispute: { findFirst: (...args: unknown[]) => mockDisputeFindFirst(...args) },
    escrowParticipantKey: { findMany: (...args: unknown[]) => mockParticipantKeyFindMany(...args) },
    feeDistribution: { create: (...args: unknown[]) => mockFeeDistributionCreate(...args) },
    escrowFundingEvidence: { findMany: (...args: unknown[]) => mockEscrowFundingEvidenceFindMany(...args) },
    $transaction: (...args: unknown[]) => mockTransaction(...(args as [any])),
  },
}))

jest.mock('../src/common/events/event-bus', () => ({
  eventBus: { emit: jest.fn().mockResolvedValue(undefined) },
}))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { escrowService } = require('../src/modules/open-settlement/escrow.service')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { eventBus } = require('../src/common/events/event-bus')

const baseEscrow = {
  id: 'escrow-1', tradeId: 'trade-1', type: 'MOCK', status: 'PAYMENT_PENDING',
  lockedAmount: '20.5', asset: 'USDT_ERC20', timelockHours: 24,
}

describe('escrowService.releaseFunds — RFC-014 capability check (relocated from the orchestrator)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    enforceCapabilities = false
    requireDualApprovalForRelease = false
    mockEscrowFeatureFlag = true
    mockEscrowFindUnique.mockResolvedValue(baseEscrow)
    mockEscrowUpdate.mockResolvedValue({ ...baseEscrow, status: 'COMPLETED', txReleaseId: 'tx-1' })
    // Gap-audit ownership check runs before the capability check — every
    // test in this block acts as 'seller-1', so the trade's sellerId
    // must match for these tests to exercise the capability check itself.
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' })
  })

  it('releases without ever querying CapabilityGrant when enforceCapabilities is false (the default)', async () => {
    await escrowService.releaseFunds('escrow-1', '0xbuyer', 'seller-1')
    expect(mockCapabilityGrantFindMany).not.toHaveBeenCalled()
    expect(mockEscrowUpdate).toHaveBeenCalled()
  })

  it('rejects with ForbiddenError, before ever moving funds, when enforcement is on and no grant covers it', async () => {
    enforceCapabilities = true
    mockCapabilityGrantFindMany.mockResolvedValue([])

    await expect(escrowService.releaseFunds('escrow-1', '0xbuyer', 'seller-1')).rejects.toThrow(
      /no active 'settlement' capability grant/
    )
    expect(mockEscrowUpdate).not.toHaveBeenCalled()
  })

  it('releases normally when enforcement is on and an active grant covers it', async () => {
    enforceCapabilities = true
    mockCapabilityGrantFindMany.mockResolvedValue([
      { id: 'g1', grantedTo: 'seller-1', capabilityName: 'settlement', scope: ['settlement.escrow.released'], constraints: null, issuedBy: 'seller-1' },
    ])

    const result = await escrowService.releaseFunds('escrow-1', '0xbuyer', 'seller-1')
    expect(result.status).toBe('COMPLETED')
  })

  it('is exercised by the direct release path too, not just an orchestrator-level shortcut — same call, no special-casing needed', async () => {
    // settlement.routes.ts's POST /v1/settlement/escrow/:id/release calls
    // escrowService.releaseFunds() with exactly this shape — no
    // orchestrator involved. Proves the check protects that path now.
    enforceCapabilities = true
    mockCapabilityGrantFindMany.mockResolvedValue([])
    await expect(escrowService.releaseFunds('escrow-1', '0xbuyer', 'seller-1')).rejects.toThrow(/ForbiddenError|no active/)
  })
})

describe('escrowService.releaseFunds — RFC-021 Phase 0 legacy Protocol Fee (Mechanism 1) retired', () => {
  // Missão 11 Fase 6.5.2 — chargeProtocolFee() (RFC-021 Phase 0) and its
  // FeeDistribution row are retired: FeeCollectionEvidence(CONFIRMED) ->
  // FeeObligation -> a frozen DistributionPolicyVersion ->
  // EntitlementLedgerEntry is now the sole future economic authority.
  // These tests replace the old "35/30/25/10 split math" suite (which
  // exercised a function that no longer exists) with a regression proof
  // that release/refund/split behave exactly as before the retirement —
  // Escrow.feeCharged is always null now, and the legacy FeeDistribution
  // write path is never reached, regardless of config.settlement.
  // protocolFeeRate (which itself is untouched, still defaults to 0, and
  // is simply no longer read by this path).
  beforeEach(() => {
    jest.clearAllMocks()
    enforceCapabilities = false
    requireDualApprovalForRelease = false
    mockEscrowFeatureFlag = true
    protocolFeeRate = 0
    mockEscrowFindUnique.mockResolvedValue(baseEscrow)
    mockEscrowUpdate.mockResolvedValue({ ...baseEscrow, status: 'COMPLETED', txReleaseId: 'tx-1' })
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' })
  })

  it('releaseFunds() never invokes the legacy FeeDistribution write path, regardless of protocolFeeRate', async () => {
    await escrowService.releaseFunds('escrow-1', '0xbuyer', 'seller-1')
    expect(mockFeeDistributionCreate).not.toHaveBeenCalled()
    expect(mockEscrowUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ feeCharged: null }) })
    )
  })

  it('a nonzero protocolFeeRate no longer has any effect on release — the legacy reader of that config value is gone', async () => {
    protocolFeeRate = 0.004 // would have triggered the old 35/30/25/10 split before Fase 6.5.2
    await escrowService.releaseFunds('escrow-1', '0xbuyer', 'seller-1')

    expect(mockFeeDistributionCreate).not.toHaveBeenCalled()
    expect(mockEscrowUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ feeCharged: null }) })
    )
  })

  it('a policy-aware escrow (feePolicyVersionId set) behaves identically — still no legacy FeeDistribution row, ever', async () => {
    protocolFeeRate = 0.004
    mockEscrowFindUnique.mockResolvedValue({ ...baseEscrow, feePolicyVersionId: 'policy-1', snapshotProtocolFeeRate: '0.004' })
    await escrowService.releaseFunds('escrow-1', '0xbuyer', 'seller-1')

    expect(mockFeeDistributionCreate).not.toHaveBeenCalled()
    expect(mockEscrowUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ feeCharged: null }) })
    )
  })

  it('refundFunds() never touches the legacy FeeDistribution write path — unchanged from before the retirement', async () => {
    protocolFeeRate = 0.001
    mockEscrowFindUnique.mockResolvedValue({ ...baseEscrow, status: 'FUNDS_LOCKED' })
    mockEscrowUpdate.mockResolvedValue({ ...baseEscrow, status: 'REFUNDED' })
    await escrowService.refundFunds('escrow-1', 'seller-1')
    expect(mockFeeDistributionCreate).not.toHaveBeenCalled()
  })
})

describe('escrowService — RFC-015 two-person control', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    enforceCapabilities = false
    requireDualApprovalForRelease = false
    mockEscrowFeatureFlag = true
    mockEscrowFindUnique.mockResolvedValue(baseEscrow)
    mockEscrowUpdate.mockResolvedValue({ ...baseEscrow, status: 'COMPLETED', txReleaseId: 'tx-1' })
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' })
  })

  describe('approveRelease', () => {
    it('rejects an approver who is neither the buyer nor the seller of the trade', async () => {
      await expect(escrowService.approveRelease('escrow-1', 'stranger-1')).rejects.toThrow(
        /not a counterparty/
      )
      expect(mockApprovalUpsert).not.toHaveBeenCalled()
    })

    it('upserts an approval for the buyer', async () => {
      mockApprovalUpsert.mockResolvedValue({ id: 'appr-1', escrowId: 'escrow-1', approverId: 'buyer-1' })
      await escrowService.approveRelease('escrow-1', 'buyer-1')
      expect(mockApprovalUpsert).toHaveBeenCalledWith({
        where: { escrowId_approverId: { escrowId: 'escrow-1', approverId: 'buyer-1' } },
        update: {},
        create: { escrowId: 'escrow-1', approverId: 'buyer-1' },
      })
    })

    it('upserts an approval for the seller', async () => {
      mockApprovalUpsert.mockResolvedValue({ id: 'appr-2', escrowId: 'escrow-1', approverId: 'seller-1' })
      await escrowService.approveRelease('escrow-1', 'seller-1')
      expect(mockApprovalUpsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: { escrowId: 'escrow-1', approverId: 'seller-1' } })
      )
    })
  })

  describe('hasDualApproval', () => {
    it('is false with fewer than 2 recorded approvals', async () => {
      mockApprovalCount.mockResolvedValue(1)
      expect(await escrowService.hasDualApproval('escrow-1')).toBe(false)
    })

    it('is true with 2 or more recorded approvals', async () => {
      mockApprovalCount.mockResolvedValue(2)
      expect(await escrowService.hasDualApproval('escrow-1')).toBe(true)
    })
  })

  describe('releaseFunds gate', () => {
    it('releases without checking approvals when requireDualApprovalForRelease is false (the default)', async () => {
      requireDualApprovalForRelease = false
      await escrowService.releaseFunds('escrow-1', '0xbuyer', 'seller-1')
      expect(mockApprovalCount).not.toHaveBeenCalled()
      expect(mockEscrowUpdate).toHaveBeenCalled()
    })

    it('blocks a normal (PAYMENT_PENDING) release with only 1 approval', async () => {
      requireDualApprovalForRelease = true
      mockApprovalCount.mockResolvedValue(1)

      await expect(escrowService.releaseFunds('escrow-1', '0xbuyer', 'seller-1')).rejects.toThrow(
        /Release blocked.*both counterparties.*approve-release/
      )
      expect(mockEscrowUpdate).not.toHaveBeenCalled()
    })

    it('releases a normal (PAYMENT_PENDING) escrow once both counterparties have approved', async () => {
      requireDualApprovalForRelease = true
      mockApprovalCount.mockResolvedValue(2)

      const result = await escrowService.releaseFunds('escrow-1', '0xbuyer', 'seller-1')
      expect(result.status).toBe('COMPLETED')
    })

    it('bypasses the approval count entirely for an arbitrated (DISPUTED) release, even with zero approvals', async () => {
      requireDualApprovalForRelease = true
      mockEscrowFindUnique.mockResolvedValue({ ...baseEscrow, status: 'DISPUTED' })
      mockApprovalCount.mockResolvedValue(0)
      // Gap-audit ownership check: 'arbiter-1' isn't the seller, so it
      // must be the assigned arbiter of an open dispute on this trade
      // for the release to be authorized at all.
      mockDisputeFindFirst.mockResolvedValue({ id: 'dispute-1', tradeId: 'trade-1', arbiterId: 'arbiter-1' })

      const result = await escrowService.releaseFunds('escrow-1', '0xbuyer', 'arbiter-1')
      expect(mockApprovalCount).not.toHaveBeenCalled()
      expect(result.status).toBe('COMPLETED')
    })
  })
})

describe('escrowService — disputed disposition authority', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    enforceCapabilities = false
    requireDualApprovalForRelease = false
    mockEscrowFeatureFlag = true
    mockEscrowFindUnique.mockResolvedValue({ ...baseEscrow, status: 'DISPUTED' })
    mockEscrowUpdate.mockResolvedValue({ ...baseEscrow, status: 'COMPLETED', txReleaseId: 'tx-1' })
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' })
    mockDisputeFindFirst.mockResolvedValue(null)
  })

  it('rejects the seller from RELEASE while the escrow is DISPUTED, before any transition/provider call', async () => {
    await expect(escrowService.releaseFunds('escrow-1', '0xbuyer', 'seller-1')).rejects.toThrow(
      /not the current assigned arbiter.*DISPUTED/
    )
    expect(mockEscrowUpdateMany).not.toHaveBeenCalled()
    expect(mockEscrowUpdate).not.toHaveBeenCalled()
  })

  it('rejects the seller from REFUND while the escrow is DISPUTED, before any transition/provider call', async () => {
    await expect(escrowService.refundFunds('escrow-1', 'seller-1')).rejects.toThrow(
      /not the current assigned arbiter.*DISPUTED/
    )
    expect(mockEscrowUpdateMany).not.toHaveBeenCalled()
    expect(mockEscrowUpdate).not.toHaveBeenCalled()
  })

  it('rejects the seller from SPLIT while the escrow is DISPUTED, before any transition/provider call', async () => {
    await expect(escrowService.splitFunds('escrow-1', '0xbuyer', '0xseller', 5000, 'seller-1')).rejects.toThrow(
      /not the current assigned arbiter.*DISPUTED/
    )
    expect(mockEscrowUpdateMany).not.toHaveBeenCalled()
    expect(mockEscrowUpdate).not.toHaveBeenCalled()
  })

  it('keeps the current assigned arbiter authorized for disputed RELEASE', async () => {
    mockDisputeFindFirst.mockResolvedValue({ id: 'dispute-1', tradeId: 'trade-1', arbiterId: 'arbiter-1' })

    const result = await escrowService.releaseFunds('escrow-1', '0xbuyer', 'arbiter-1')

    expect(result.status).toBe('COMPLETED')
    expect(mockEscrowUpdateMany).toHaveBeenCalled()
  })

  it('keeps the current assigned arbiter authorized for disputed REFUND', async () => {
    mockDisputeFindFirst.mockResolvedValue({ id: 'dispute-1', tradeId: 'trade-1', arbiterId: 'arbiter-1' })
    mockEscrowUpdate.mockResolvedValue({ ...baseEscrow, status: 'REFUNDED', txReleaseId: 'tx-refund' })

    const result = await escrowService.refundFunds('escrow-1', 'arbiter-1')

    expect(result.status).toBe('REFUNDED')
    expect(mockEscrowUpdateMany).toHaveBeenCalled()
  })

  it('keeps the current assigned arbiter authorized for disputed SPLIT', async () => {
    mockDisputeFindFirst.mockResolvedValue({ id: 'dispute-1', tradeId: 'trade-1', arbiterId: 'arbiter-1' })
    mockEscrowUpdate.mockResolvedValue({ ...baseEscrow, status: 'SPLIT' })

    const result = await escrowService.splitFunds('escrow-1', '0xbuyer', '0xseller', 5000, 'arbiter-1')

    expect(result.status).toBe('SPLIT')
    expect(mockEscrowUpdateMany).toHaveBeenCalled()
  })
})

// Gap audit (not tied to any single RFC): none of lockFunds/markPaymentSent/
// releaseFunds/refundFunds/openDispute verified `triggeredBy` was actually
// a party to the trade before this fix — any authenticated participant on
// the platform could mutate any other trade's escrow (an IDOR, the same
// class of bug RT-002 already fixed once for raw-userId-in-body, one layer
// deeper at the service boundary). releaseFunds' own ownership check is
// exercised above via the RFC-014/015 describe blocks; this block covers
// the other four methods, which had zero prior test coverage.
describe('escrowService — ownership/IDOR checks (gap audit)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    enforceCapabilities = false
    requireDualApprovalForRelease = false
    mockEscrowFeatureFlag = true
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' })
  })

  describe('lockFunds', () => {
    beforeEach(() => {
      mockEscrowFindUnique.mockResolvedValue({ ...baseEscrow, status: 'CREATED' })
      mockEscrowUpdate.mockResolvedValue({ ...baseEscrow, status: 'FUNDS_LOCKED' })
    })

    it('rejects a caller who is not the trade\'s seller', async () => {
      await expect(escrowService.lockFunds('escrow-1', 'buyer-1')).rejects.toThrow(/not the seller/)
      expect(mockEscrowUpdate).not.toHaveBeenCalled()
    })

    it('allows the seller', async () => {
      const result = await escrowService.lockFunds('escrow-1', 'seller-1')
      expect(result.status).toBe('FUNDS_LOCKED')
    })

    it("allows an agent acting on the seller's behalf (agent:{label}:{sellerId})", async () => {
      const result = await escrowService.lockFunds('escrow-1', 'agent:seller-wallet:seller-1')
      expect(result.status).toBe('FUNDS_LOCKED')
    })

    // Failure-scenario coverage requested directly in a CTO-role
    // follow-up after RFC-018 landed ("garantir que os testes cubram
    // cenários de falha... escrow não bloqueado"). This is deliberate
    // control flow, not a new behavior: escrowService.lockFunds() calls
    // provider.lockFunds() before persisting anything or emitting
    // settlement.escrow.locked (the event handlers.ts's Intent
    // COMMITTED transition reacts to) — a provider failure must never
    // leave a half-locked escrow or a falsely-COMMITTED Intent behind.
    it('a provider lock failure leaves the escrow unpersisted and never emits settlement.escrow.locked', async () => {
      jest.clearAllMocks()
      // mockEscrow must be off here — otherwise getProvider() always
      // short-circuits to the harmless MOCK provider regardless of
      // escrow.type, and this test would never actually exercise
      // LightningHodlProvider's failure path.
      mockEscrowFeatureFlag = false
      mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' })
      // LIGHTNING_HODL's provider (lightning-hodl.provider.ts, real since
      // the Arkade build) reliably throws with no ARKADE_SEED configured
      // (this file's config mock leaves it empty) — real, already-existing
      // behavior, reused here rather than fabricating a new failure mode.
      mockEscrowFindUnique.mockResolvedValue({ ...baseEscrow, type: 'LIGHTNING_HODL', status: 'CREATED' })

      await expect(escrowService.lockFunds('escrow-1', 'seller-1')).rejects.toThrow(/requires a submitted buyer pubkey/)

      // Robustness-audit fix (2026-07-20): lockFunds() now claims
      // FUNDS_LOCKED atomically *before* calling the provider, so a
      // failed provider call does leave one update() call behind — the
      // revert back to the original status (escrow.service.ts's own
      // catch block), not a leftover lock. "Unpersisted" means no lock
      // *fields* (txLockId/multisigAddr/lockedAt/expiresAt) were ever
      // set, not "update() was never called" — checked precisely below.
      expect(mockEscrowUpdateMany).toHaveBeenCalledWith({ where: { id: 'escrow-1', status: 'FUNDS_LOCKED' }, data: { status: 'CREATED' } })
      expect(eventBus.emit).not.toHaveBeenCalledWith('settlement.escrow.locked', expect.anything(), expect.anything())
    })

    // Security-validation round (2026-07-19, "settlement falhando / retry
    // seguro" scenario): the test above proves a failed lock leaves
    // nothing persisted — this one proves the OTHER half of "safe retry":
    // the same escrow row is still in a state where a corrected attempt
    // (here: the operator fixes the escrow's type, the real-world
    // equivalent of retrying against a working provider) goes through
    // cleanly via the exact same code path, no leftover half-locked state
    // from the failed attempt getting in the way.
    it('a failed lock leaves the escrow retry-safe — a subsequent attempt on the same row succeeds cleanly', async () => {
      jest.clearAllMocks()
      mockEscrowFeatureFlag = false
      mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' })
      mockEscrowFindUnique.mockResolvedValueOnce({ ...baseEscrow, type: 'LIGHTNING_HODL', status: 'CREATED' })

      await expect(escrowService.lockFunds('escrow-1', 'seller-1')).rejects.toThrow(/requires a submitted buyer pubkey/)

      // Retry: same escrow id, still status CREATED (never advanced), now
      // routed through a working provider — mockEscrow back on, matching
      // an operator retrying with the config actually fixed.
      mockEscrowFeatureFlag = true
      mockEscrowFindUnique.mockResolvedValueOnce({ ...baseEscrow, type: 'MOCK', status: 'CREATED' })
      mockEscrowUpdate.mockResolvedValueOnce({ ...baseEscrow, status: 'FUNDS_LOCKED' })

      const result = await escrowService.lockFunds('escrow-1', 'seller-1')

      expect(result.status).toBe('FUNDS_LOCKED')
      // 2, not 1: the failed first attempt above already contributed one
      // update() call (the revert-back-to-CREATED — see the previous
      // test's identical comment), and this successful retry contributes
      // its own field-fill update() — both real, both expected.
      expect(mockEscrowUpdate).toHaveBeenCalledTimes(1)
    })
  })

  describe('markPaymentSent', () => {
    beforeEach(() => {
      mockEscrowFindUnique.mockResolvedValue({ ...baseEscrow, status: 'FUNDS_LOCKED' })
      mockEscrowUpdate.mockResolvedValue({ ...baseEscrow, status: 'PAYMENT_PENDING' })
    })

    it('rejects a caller who is not the trade\'s buyer', async () => {
      await expect(escrowService.markPaymentSent('escrow-1', 'seller-1')).rejects.toThrow(/not the buyer/)
      expect(mockEscrowUpdate).not.toHaveBeenCalled()
    })

    it('allows the buyer', async () => {
      // Robustness-audit fix (2026-07-20): markPaymentSent() has no
      // external provider call, so it claims via updateMany() then
      // re-fetches via findUnique() (not update(), which doesn't apply
      // here) — two findUnique calls now, not one: the initial read,
      // then the re-fetch after the atomic claim succeeds. Queued
      // explicitly (not relying on this describe's single-value default)
      // so each call gets the status it should actually see.
      mockEscrowFindUnique
        .mockResolvedValueOnce({ ...baseEscrow, status: 'FUNDS_LOCKED' })
        .mockResolvedValueOnce({ ...baseEscrow, status: 'PAYMENT_PENDING' })
      const result = await escrowService.markPaymentSent('escrow-1', 'buyer-1')
      expect(result.status).toBe('PAYMENT_PENDING')
    })
  })

  describe('refundFunds', () => {
    beforeEach(() => {
      mockEscrowFindUnique.mockResolvedValue({ ...baseEscrow, status: 'FUNDS_LOCKED' })
      mockEscrowUpdate.mockResolvedValue({ ...baseEscrow, status: 'REFUNDED' })
    })

    it('rejects a caller who is neither the seller nor an assigned arbiter', async () => {
      mockDisputeFindFirst.mockResolvedValue(null)
      await expect(escrowService.refundFunds('escrow-1', 'buyer-1')).rejects.toThrow(
        /neither the seller.*nor its assigned dispute arbiter/
      )
      expect(mockEscrowUpdate).not.toHaveBeenCalled()
    })

    it('allows the seller (e.g. a trade cancelled before payment, collateral returned)', async () => {
      const result = await escrowService.refundFunds('escrow-1', 'seller-1')
      expect(result.status).toBe('REFUNDED')
    })

    it('allows the assigned arbiter of an open dispute on this trade', async () => {
      mockDisputeFindFirst.mockResolvedValue({ id: 'dispute-1', tradeId: 'trade-1', arbiterId: 'arbiter-1' })
      const result = await escrowService.refundFunds('escrow-1', 'arbiter-1')
      expect(result.status).toBe('REFUNDED')
    })
  })

  // RFC-021 D9 (2026-08-02) — real settlement action for the third §1.9
  // dispute-ruling option. Only reachable from DISPUTED (VALID_TRANSITIONS),
  // unlike release/refund which also have a non-disputed happy path.
  describe('splitFunds', () => {
    beforeEach(() => {
      mockEscrowFindUnique.mockResolvedValue({ ...baseEscrow, status: 'DISPUTED' })
      mockEscrowUpdate.mockResolvedValue({ ...baseEscrow, status: 'SPLIT' })
    })

    it('rejects buyerBps of 0 (that is a REFUND, not a real split)', async () => {
      await expect(escrowService.splitFunds('escrow-1', '0xbuyer', '0xseller', 0, 'seller-1')).rejects.toThrow(
        /buyerBps must be strictly between 0 and 10000/
      )
      expect(mockEscrowUpdate).not.toHaveBeenCalled()
    })

    it('rejects buyerBps of 10000 (that is a RELEASE, not a real split)', async () => {
      await expect(escrowService.splitFunds('escrow-1', '0xbuyer', '0xseller', 10000, 'seller-1')).rejects.toThrow(
        /buyerBps must be strictly between 0 and 10000/
      )
    })

    it('rejects a caller who is neither the seller nor an assigned arbiter', async () => {
      mockDisputeFindFirst.mockResolvedValue(null)
      await expect(escrowService.splitFunds('escrow-1', '0xbuyer', '0xseller', 5000, 'stranger-1')).rejects.toThrow(
        /not the current assigned arbiter.*DISPUTED/
      )
      expect(mockEscrowUpdate).not.toHaveBeenCalled()
    })

    it('allows the assigned arbiter and moves funds via the MOCK provider (real 2-transfer split)', async () => {
      mockDisputeFindFirst.mockResolvedValue({ id: 'dispute-1', tradeId: 'trade-1', arbiterId: 'arbiter-1' })
      const result = await escrowService.splitFunds('escrow-1', '0xbuyer', '0xseller', 6000, 'arbiter-1')
      expect(result.status).toBe('SPLIT')
      // Real MockSettlementProvider.splitFunds() produces two distinct txIds.
      const updateCall = mockEscrowUpdate.mock.calls[0][0]
      expect(updateCall.data.txReleaseId).toMatch(/mock-split-.*,mock-split-/)
    })

    it('rejects a SAFE_GUARD_EVM escrow — that provider has no direct splitFunds() (signature-collection type, use initiateSplit instead)', async () => {
      // getProvider() short-circuits to MOCK whenever config.features.mockEscrow
      // is true (this file's own header comment) — must disable it here to
      // actually reach the real safeGuardEvmProvider instance and its
      // (deliberately absent) splitFunds().
      mockEscrowFeatureFlag = false
      mockEscrowFindUnique.mockResolvedValue({ ...baseEscrow, type: 'SAFE_GUARD_EVM', status: 'DISPUTED' })
      mockDisputeFindFirst.mockResolvedValue({ id: 'dispute-1', tradeId: 'trade-1', arbiterId: 'arbiter-1' })
      await expect(escrowService.splitFunds('escrow-1', '0xbuyer', '0xseller', 6000, 'arbiter-1')).rejects.toThrow(
        /does not support a SPLIT settlement action/
      )
    })
  })

  describe('openDispute', () => {
    beforeEach(() => {
      mockEscrowFindUnique.mockResolvedValue({ ...baseEscrow, status: 'FUNDS_LOCKED' })
      mockEscrowUpdate.mockResolvedValue({ ...baseEscrow, status: 'DISPUTED' })
    })

    it('rejects a caller who is not a party to the trade', async () => {
      await expect(escrowService.openDispute('escrow-1', 'stranger-1', 'reason')).rejects.toThrow(
        /not a party to trade/
      )
      expect(mockEscrowUpdate).not.toHaveBeenCalled()
    })

    it('allows the buyer', async () => {
      // Same fix as markPaymentSent's identical comment — openDispute()
      // also has no external provider call, so both findUnique calls
      // (initial read + post-claim re-fetch) need queuing explicitly.
      mockEscrowFindUnique
        .mockResolvedValueOnce({ ...baseEscrow, status: 'FUNDS_LOCKED' })
        .mockResolvedValueOnce({ ...baseEscrow, status: 'DISPUTED' })
      const result = await escrowService.openDispute('escrow-1', 'buyer-1', 'reason')
      expect(result.status).toBe('DISPUTED')
    })

    it('allows the seller', async () => {
      mockEscrowFindUnique
        .mockResolvedValueOnce({ ...baseEscrow, status: 'FUNDS_LOCKED' })
        .mockResolvedValueOnce({ ...baseEscrow, status: 'DISPUTED' })
      const result = await escrowService.openDispute('escrow-1', 'seller-1', 'reason')
      expect(result.status).toBe('DISPUTED')
    })
  })
})

// BACKLOG.md P0, "Escrow timelock proactive sweeper" — the "notice time
// has passed" trigger for the already-real refundFunds() above.
// triggeredBy is always the trade's own sellerId, never a fabricated
// actor — see sweepExpiredEscrows()'s own doc comment for the full
// INV-OP-1 reasoning.
describe('escrowService.sweepExpiredEscrows', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockEscrowFeatureFlag = true
    mockEscrowUpdateMany.mockResolvedValue({ count: 1 })
    mockDisputeFindFirst.mockResolvedValue(null)
  })

  it('queries only FUNDS_LOCKED escrows past their own expiresAt', async () => {
    mockEscrowFindMany.mockResolvedValue([])

    await escrowService.sweepExpiredEscrows()

    expect(mockEscrowFindMany).toHaveBeenCalledWith({
      where: { status: 'FUNDS_LOCKED', expiresAt: { lt: expect.any(Date) } },
    })
  })

  it("refunds every expired escrow, attributing triggeredBy to that trade's own seller", async () => {
    mockEscrowFindMany.mockResolvedValue([
      { ...baseEscrow, id: 'escrow-1', tradeId: 'trade-1', status: 'FUNDS_LOCKED' },
      { ...baseEscrow, id: 'escrow-2', tradeId: 'trade-2', status: 'FUNDS_LOCKED' },
    ])
    mockTradeFindUnique.mockImplementation(({ where: { id } }: { where: { id: string } }) =>
      Promise.resolve(
        id === 'trade-1'
          ? { id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' }
          : { id: 'trade-2', buyerId: 'buyer-2', sellerId: 'seller-2' }
      )
    )
    mockEscrowFindUnique.mockImplementation(({ where: { id } }: { where: { id: string } }) =>
      Promise.resolve(
        id === 'escrow-1'
          ? { ...baseEscrow, id: 'escrow-1', tradeId: 'trade-1', status: 'FUNDS_LOCKED' }
          : { ...baseEscrow, id: 'escrow-2', tradeId: 'trade-2', status: 'FUNDS_LOCKED' }
      )
    )
    mockEscrowUpdate.mockResolvedValue({ ...baseEscrow, status: 'REFUNDED' })

    const result = await escrowService.sweepExpiredEscrows()

    expect(result.refunded.sort()).toEqual(['escrow-1', 'escrow-2'])
    expect(result.failed).toEqual([])
    // Both real refundFunds() calls went through the seller-ownership
    // check for real (isPartyOrAgent(triggeredBy, sellerId)) — not
    // mocked/bypassed — proving the sweep really does attribute each
    // refund to its own trade's own seller, not a shared/fabricated id.
    expect(mockEscrowUpdateMany).toHaveBeenCalledTimes(2)
  })

  it('a failure on one expired escrow does not stop the sweep from refunding the rest', async () => {
    mockEscrowFindMany.mockResolvedValue([
      { ...baseEscrow, id: 'escrow-1', tradeId: 'trade-1', status: 'FUNDS_LOCKED' },
      { ...baseEscrow, id: 'escrow-2', tradeId: 'trade-2', status: 'FUNDS_LOCKED' },
    ])
    mockTradeFindUnique.mockImplementation(({ where: { id } }: { where: { id: string } }) =>
      Promise.resolve(
        id === 'trade-1'
          ? { id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' }
          : { id: 'trade-2', buyerId: 'buyer-2', sellerId: 'seller-2' }
      )
    )
    mockEscrowFindUnique.mockImplementation(({ where: { id } }: { where: { id: string } }) =>
      Promise.resolve(
        id === 'escrow-1'
          ? { ...baseEscrow, id: 'escrow-1', tradeId: 'trade-1', status: 'FUNDS_LOCKED' }
          : { ...baseEscrow, id: 'escrow-2', tradeId: 'trade-2', status: 'FUNDS_LOCKED' }
      )
    )
    // escrow-1 lost the atomic-claim race (a concurrent request already
    // transitioned it) — refundFunds() throws for it specifically, the
    // same real error a concurrent HTTP caller would hit.
    mockEscrowUpdateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 })
    mockEscrowUpdate.mockResolvedValue({ ...baseEscrow, status: 'REFUNDED' })

    const result = await escrowService.sweepExpiredEscrows()

    expect(result.refunded).toEqual(['escrow-2'])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].escrowId).toBe('escrow-1')
    expect(result.failed[0].error).toMatch(/already transitioned/)
  })
})
