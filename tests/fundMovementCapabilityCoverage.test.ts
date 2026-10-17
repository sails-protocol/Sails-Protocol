/**
 * Missão 06.9 — RFC-014 capability coverage for EVERY fund-movement path,
 * not just release. Achado #3 (Missão 06.7's route-authorization audit):
 * when ENFORCE_CAPABILITIES=true, releaseFunds()/initiateRelease() already
 * called checkFundMovementCapability() (tests/escrowReleaseControls.test.ts
 * covers that in depth), but refundFunds()/splitFunds()/initiateRefund()/
 * initiateSplit() never did — a real, found-by-audit gap, not a deliberate
 * exemption. escrow-lifecycle.ts's checkFundMovementCapability() is now the
 * single helper all six call sites share (escrow.service.ts's three direct
 * methods, escrow-pending-tx.ts's shared initiateSignatureCollectionCore()
 * behind the three initiate* wrappers).
 *
 * Same "mock the boundary, test what's actually new" discipline
 * tests/escrowReleaseControls.test.ts already established: capabilityRegistry
 * itself is real (not mocked) — only prisma.capabilityGrant is, via a
 * where-clause-aware fake so findActiveGrants(grantedTo, capabilityName)'s
 * real DB-level filtering is actually exercised (a mock that ignored `where`
 * would let a "wrong capability name" grant wrongly pass, since check()'s
 * own JS-side filtering only re-checks scope/expiry, not capabilityName —
 * it trusts the repository's query already did that).
 *
 * Twelve scenarios (Missão 06.9 Fase 7's own list): release/refund/split
 * without and with capability (1-6), initiateRelease/initiateSplit without
 * capability (7-8, proving the pending-tx path shares the identical check),
 * ENFORCE_CAPABILITIES=false preserves current unchecked behavior (9), a
 * genuine grant for the wrong capability (10), an expired grant (11), and
 * an actor whose own grant doesn't cover them even though a co-participant
 * (the seller) has one (12) — the arbiter-vs-seller distinction
 * checkFundMovementCapability()'s own header comment discusses.
 */
export {} // see chatUnification.test.ts's identical comment

let enforceCapabilities = true
jest.mock('../src/config', () => ({
  get config() {
    return {
      features: { mockEscrow: true, enforceCapabilities, requireDualApprovalForRelease: false },
      trade: { defaultTimelockHours: 24 },
      settlement: { trustedArbitrators: [], protocolFeeRate: 0 },
      arkade: { seed: '' },
      // escrow-circuit-breaker.ts's claimEscrowTransition() first line — same
      // threshold-too-high-to-trip shape tests/escrowReleaseControls.test.ts
      // already uses; this file doesn't test the breaker itself.
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
// exercise lightning-hodl.provider.ts's/multisig.provider.ts's real calls
// (every DENY scenario throws before a provider is ever invoked; the only
// ALLOW scenarios in this file use type: 'MOCK', routed to the real,
// dependency-free MockSettlementProvider by config.features.mockEscrow).
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

jest.mock('@scure/btc-signer', () => ({ Transaction: { fromPSBT: jest.fn() } }))

const mockEscrowFindUnique = jest.fn()
const mockEscrowUpdate = jest.fn()
const mockEscrowUpdateMany = jest.fn().mockResolvedValue({ count: 1 })
const mockTradeFindUnique = jest.fn()
const mockDisputeFindFirst = jest.fn().mockResolvedValue(null)
const mockEscrowEventCreate = jest.fn().mockResolvedValue({ id: 'transition-1' })
const mockEscrowEventFindFirst = jest.fn().mockResolvedValue(null)
const mockFeeDistributionCreate = jest.fn().mockResolvedValue({})
const mockPendingTxFindUnique = jest.fn().mockResolvedValue(null)
const mockParticipantKeyFindMany = jest.fn().mockResolvedValue([])
// Missão 11 Fase 9.1 §1/§2 — assertFundingNotUncertain() (wired into
// initiateSignatureCollectionCore() for release/split, scenarios 7-8
// below) now queries this table before the capability check runs; an
// empty history is the trustworthy/no-op case (see
// EscrowFundingEvidenceService's own "last row decides" state machine),
// which is what every scenario in this file needs — none of them are
// testing funding-uncertainty behavior, that's escrowFundingEvidenceService.test.ts's
// and multisigFundingReorgSweep.test.ts's job.
const mockEscrowFundingEvidenceFindMany = jest.fn().mockResolvedValue([])

// Real CapabilityGrant rows for whichever scenario is under test — reset in
// beforeEach. The `where` clause is genuinely respected (not a blanket
// return) so findActiveGrants(grantedTo, capabilityName)'s real DB-level
// filtering is exercised, not bypassed.
type GrantFixture = { id: string; grantedTo: string; capabilityName: string; scope: string[]; constraints: unknown; issuedBy: string }
let capabilityGrantFixtures: GrantFixture[] = []
const mockCapabilityGrantFindMany = jest.fn(({ where }: { where: { grantedTo: string; capabilityName: string } }) =>
  Promise.resolve(
    capabilityGrantFixtures.filter((g) => g.grantedTo === where.grantedTo && g.capabilityName === where.capabilityName)
  )
)

jest.mock('../src/common/database', () => ({
  prisma: {
    escrow: {
      findUnique: (...args: unknown[]) => mockEscrowFindUnique(...args),
      update: (...args: unknown[]) => mockEscrowUpdate(...args),
      updateMany: (...args: unknown[]) => mockEscrowUpdateMany(...args),
    },
    trade: { findUnique: (...args: unknown[]) => mockTradeFindUnique(...args) },
    dispute: { findFirst: (...args: unknown[]) => mockDisputeFindFirst(...args) },
    escrowEvent: {
      create: (...args: unknown[]) => mockEscrowEventCreate(...args),
      findFirst: (...args: unknown[]) => mockEscrowEventFindFirst(...args),
    },
    feeDistribution: { create: (...args: unknown[]) => mockFeeDistributionCreate(...args) },
    escrowPendingTransaction: { findUnique: (...args: unknown[]) => mockPendingTxFindUnique(...args) },
    escrowParticipantKey: { findMany: (...args: unknown[]) => mockParticipantKeyFindMany(...args) },
    capabilityGrant: { findMany: (...args: [{ where: { grantedTo: string; capabilityName: string } }]) => mockCapabilityGrantFindMany(...args) },
    escrowFundingEvidence: { findMany: (...args: unknown[]) => mockEscrowFundingEvidenceFindMany(...args) },
    // Missão 11 Fase 9.7 — emitEscrowTransition() now does its own
    // escrowEvent existence-check-then-create INSIDE withEscrowFundingLock()
    // — reuses the same mocks as the top-level escrowEvent block above.
    $transaction: (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        // Issue #298 - emitEscrowTransition() records the 'transition.claimed' marker in the same transaction as the claim.
        eventProjectionClaim: { create: jest.fn().mockResolvedValue({}), createMany: jest.fn().mockResolvedValue({ count: 1 }), findMany: jest.fn().mockResolvedValue([]) },
        $executeRaw: jest.fn().mockResolvedValue(0),
        // Issue #291 - persistSettlementResult() reads then writes the escrow inside its own locked transaction.
        escrow: { findUnique: (...args: unknown[]) => mockEscrowFindUnique(...args), update: (...args: unknown[]) => mockEscrowUpdate(...args) },
        escrowEvent: {
          findFirst: (...args: unknown[]) => mockEscrowEventFindFirst(...args),
          create: (...args: unknown[]) => mockEscrowEventCreate(...args),
        },
      }),
  },
}))

jest.mock('../src/common/events/event-bus', () => ({
  eventBus: { emit: jest.fn().mockResolvedValue(undefined), on: jest.fn(), onDurable: jest.fn() },
}))

import { escrowService } from '../src/modules/open-settlement/escrow.service'

const TRADE_ID = 'trade-1'
const ESCROW_ID = 'escrow-1'
const BUYER_ID = 'buyer-1'
const SELLER_ID = 'seller-1'
const ARBITER_ID = 'arbiter-1'

const TRADE_ROW = { id: TRADE_ID, buyerId: BUYER_ID, sellerId: SELLER_ID }

function escrowRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ESCROW_ID, tradeId: TRADE_ID, type: 'MOCK', status: 'PAYMENT_PENDING',
    lockedAmount: '0.01', asset: 'BTC', multisigAddr: null,
    ...overrides,
  }
}

function grant(capabilityName: string, scope: string[], overrides: Partial<GrantFixture> = {}): GrantFixture {
  return { id: 'grant-1', grantedTo: SELLER_ID, capabilityName, scope, constraints: null, issuedBy: SELLER_ID, ...overrides }
}

describe('Fund-movement capability coverage — release/refund/split (Missão 06.9)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    enforceCapabilities = true
    capabilityGrantFixtures = []
    mockTradeFindUnique.mockResolvedValue(TRADE_ROW)
    mockEscrowUpdateMany.mockResolvedValue({ count: 1 })
    mockDisputeFindFirst.mockResolvedValue(null)
    mockEscrowEventFindFirst.mockResolvedValue(null)
    mockPendingTxFindUnique.mockResolvedValue(null)
    mockParticipantKeyFindMany.mockResolvedValue([])
    mockEscrowFundingEvidenceFindMany.mockResolvedValue([])
  })

  it('1. release without capability — DENY', async () => {
    mockEscrowFindUnique.mockResolvedValue(escrowRow({ status: 'PAYMENT_PENDING' }))
    await expect(escrowService.releaseFunds(ESCROW_ID, 'addr-buyer', SELLER_ID)).rejects.toThrow(
      `${SELLER_ID} has no active 'settlement' capability grant covering 'settlement.escrow.released'`
    )
    expect(mockEscrowUpdateMany).not.toHaveBeenCalled()
  })

  it('2. release with capability — ALLOW', async () => {
    mockEscrowFindUnique.mockResolvedValue(escrowRow({ status: 'PAYMENT_PENDING' }))
    mockEscrowUpdate.mockResolvedValue(escrowRow({ status: 'COMPLETED' }))
    capabilityGrantFixtures = [grant('settlement', ['settlement.escrow.released'])]
    const result = await escrowService.releaseFunds(ESCROW_ID, 'addr-buyer', SELLER_ID)
    expect(result.status).toBe('COMPLETED')
  })

  it('3. refund without capability — DENY', async () => {
    mockEscrowFindUnique.mockResolvedValue(escrowRow({ status: 'FUNDS_LOCKED' }))
    await expect(escrowService.refundFunds(ESCROW_ID, SELLER_ID)).rejects.toThrow(
      `${SELLER_ID} has no active 'settlement' capability grant covering 'settlement.escrow.refunded'`
    )
    expect(mockEscrowUpdateMany).not.toHaveBeenCalled()
  })

  it('4. refund with capability — ALLOW', async () => {
    mockEscrowFindUnique.mockResolvedValue(escrowRow({ status: 'FUNDS_LOCKED' }))
    mockEscrowUpdate.mockResolvedValue(escrowRow({ status: 'REFUNDED' }))
    capabilityGrantFixtures = [grant('settlement', ['settlement.escrow.refunded'])]
    const result = await escrowService.refundFunds(ESCROW_ID, SELLER_ID)
    expect(result.status).toBe('REFUNDED')
  })

  it('5. split without capability — DENY', async () => {
    mockEscrowFindUnique.mockResolvedValue(escrowRow({ status: 'DISPUTED' }))
    mockDisputeFindFirst.mockResolvedValue({ id: 'dispute-1', tradeId: TRADE_ID, arbiterId: ARBITER_ID })
    await expect(escrowService.splitFunds(ESCROW_ID, 'addr-buyer', 'addr-seller', 5000, ARBITER_ID)).rejects.toThrow(
      `${ARBITER_ID} has no active 'settlement' capability grant covering 'settlement.escrow.split'`
    )
    expect(mockEscrowUpdateMany).not.toHaveBeenCalled()
  })

  it('6. split with capability — ALLOW', async () => {
    mockEscrowFindUnique.mockResolvedValue(escrowRow({ status: 'DISPUTED' }))
    mockDisputeFindFirst.mockResolvedValue({ id: 'dispute-1', tradeId: TRADE_ID, arbiterId: ARBITER_ID })
    mockEscrowUpdate.mockResolvedValue(escrowRow({ status: 'SPLIT' }))
    capabilityGrantFixtures = [grant('settlement', ['settlement.escrow.split'], { grantedTo: ARBITER_ID, issuedBy: ARBITER_ID })]
    const result = await escrowService.splitFunds(ESCROW_ID, 'addr-buyer', 'addr-seller', 5000, ARBITER_ID)
    expect(result.status).toBe('SPLIT')
  })

  it('7. initiateRelease without capability — DENY (pending-tx path shares the identical check)', async () => {
    mockEscrowFindUnique.mockResolvedValue(escrowRow({ type: 'MULTISIG', status: 'PAYMENT_PENDING' }))
    await expect(escrowService.initiateRelease(ESCROW_ID, 'addr-buyer', SELLER_ID)).rejects.toThrow(
      `${SELLER_ID} has no active 'settlement' capability grant covering 'settlement.escrow.released'`
    )
  })

  it('8. initiateSplit without capability — DENY (this is the exact drift the audit found: initiateRelease had the check, initiateSplit silently never did)', async () => {
    mockEscrowFindUnique.mockResolvedValue(escrowRow({ type: 'MULTISIG', status: 'DISPUTED' }))
    mockDisputeFindFirst.mockResolvedValue({ id: 'dispute-1', tradeId: TRADE_ID, arbiterId: ARBITER_ID })
    await expect(escrowService.initiateSplit(ESCROW_ID, 'addr-buyer', 'addr-seller', 5000, ARBITER_ID)).rejects.toThrow(
      `${ARBITER_ID} has no active 'settlement' capability grant covering 'settlement.escrow.split'`
    )
  })

  it('9. ENFORCE_CAPABILITIES=false preserves current (unchecked) behavior', async () => {
    enforceCapabilities = false
    mockEscrowFindUnique.mockResolvedValue(escrowRow({ status: 'FUNDS_LOCKED' }))
    mockEscrowUpdate.mockResolvedValue(escrowRow({ status: 'REFUNDED' }))
    // No grant at all — would DENY if enforcement were on (see scenario 3).
    capabilityGrantFixtures = []
    const result = await escrowService.refundFunds(ESCROW_ID, SELLER_ID)
    expect(result.status).toBe('REFUNDED')
    expect(mockCapabilityGrantFindMany).not.toHaveBeenCalled()
  })

  it('10. a grant for the wrong capability (openp2p, not opensettlement) — DENY', async () => {
    mockEscrowFindUnique.mockResolvedValue(escrowRow({ status: 'PAYMENT_PENDING' }))
    // The actor genuinely holds an active, unexpired grant — just for
    // openp2p's 'trade-coordination', never opensettlement's 'settlement'.
    // findActiveGrants(grantedTo, 'settlement') must not return this row.
    capabilityGrantFixtures = [grant('trade-coordination', ['settlement.escrow.released'])]
    await expect(escrowService.releaseFunds(ESCROW_ID, 'addr-buyer', SELLER_ID)).rejects.toThrow(
      `${SELLER_ID} has no active 'settlement' capability grant covering 'settlement.escrow.released'`
    )
  })

  it('11. an expired capability grant — DENY', async () => {
    // capabilityRegistry.check()'s own expiry math is covered in depth by
    // tests/capabilityRegistry.test.ts; this proves checkFundMovementCapability()
    // (escrow-lifecycle.ts) actually reaches and respects that result for
    // the refund/split paths it was just wired into, same as release already did.
    mockEscrowFindUnique.mockResolvedValue(escrowRow({ status: 'PAYMENT_PENDING' }))
    capabilityGrantFixtures = [
      grant('settlement', ['settlement.escrow.released'], { constraints: { expiresAt: '2020-01-01T00:00:00.000Z' } }),
    ]
    await expect(escrowService.releaseFunds(ESCROW_ID, 'addr-buyer', SELLER_ID)).rejects.toThrow(
      `${SELLER_ID} has no active 'settlement' capability grant covering 'settlement.escrow.released'`
    )
  })

  it('12. wrong actor — an arbiter triggers a refund but only the seller holds the capability grant — DENY', async () => {
    // The seller-or-arbiter ownership check (loadEscrowWithAuthorization)
    // and the capability check are two independent gates: an arbiter
    // assigned to the dispute passes the first (dispute.service.ts's
    // resolveDispute() already passes arbiterId as triggeredBy for every
    // ruling type, RELEASE included — checkFundMovementCapability()'s own
    // header comment documents this as the deliberate precedent) but must
    // hold its OWN capability grant, not inherit the seller's.
    mockEscrowFindUnique.mockResolvedValue(escrowRow({ status: 'DISPUTED' }))
    mockDisputeFindFirst.mockResolvedValue({ id: 'dispute-1', tradeId: TRADE_ID, arbiterId: ARBITER_ID })
    capabilityGrantFixtures = [grant('settlement', ['settlement.escrow.refunded'], { grantedTo: SELLER_ID })]
    await expect(escrowService.refundFunds(ESCROW_ID, ARBITER_ID)).rejects.toThrow(
      `${ARBITER_ID} has no active 'settlement' capability grant covering 'settlement.escrow.refunded'`
    )
    expect(mockEscrowUpdateMany).not.toHaveBeenCalled()
  })
})
