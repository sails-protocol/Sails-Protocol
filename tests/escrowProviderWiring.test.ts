/**
 * escrow.service.ts's provider wiring — things found/fixed while building
 * the real MultisigProvider/LightningHodlProvider (multisig.provider.ts,
 * lightning-hodl.provider.ts):
 *
 * 1. getProvider()'s old `PROVIDERS[type] ?? PROVIDERS['MOCK']` fallback
 *    silently mock-processed ANY unregistered escrow type (MULTISIG/
 *    LIGHTNING_HODL before those files existed, still LIQUID_COVENANT
 *    today) — fixed to throw instead of quietly faking a real-money-shaped
 *    escrow.
 * 2. Client-held-keys pass (2026-07-27): createEscrow() no longer
 *    populates Escrow.multisigAddr immediately — it can't, since the
 *    address now depends on buyer/seller pubkeys submitted from their own
 *    clients, not server-derived IDs. submitParticipantKey() is the new
 *    write path: once BOTH buyer and seller pubkeys have arrived, it
 *    derives and persists the real address.
 *
 * multisig.provider.ts/lightning-hodl.provider.ts themselves are mocked
 * here — their own real cryptography is exhaustively covered by
 * tests/multisigProvider.test.ts / tests/lightningHodlProvider.test.ts;
 * this file is only about escrow.service.ts's wiring/routing logic
 * around them.
 */
export {} // see chatUnification.test.ts's identical comment

let mockEscrowFeatureFlag = false // MULTISIG/LIGHTNING_HODL only matter with mockEscrow off
let isProductionFlag = false // Issue #229 — MOCK escrow production-eligibility gate
jest.mock('../src/config', () => ({
  get config() {
    return {
      isProduction: isProductionFlag,
      features: { mockEscrow: mockEscrowFeatureFlag, enforceCapabilities: false, requireDualApprovalForRelease: false },
      trade: { defaultTimelockHours: 24 },
      settlement: { trustedArbitrators: ['arb-1'] },
      // Empty on purpose — lightning-hodl.provider.ts (real since the
      // Arkade build) is inert without it, same "clear config error"
      // pattern as multisig.provider.ts's own empty seed default below.
      arkade: { seed: '' },
    }
  },
}))

jest.mock('@tetherto/wdk-wallet-evm', () => ({
  __esModule: true,
  default: class FakeWalletManagerEvm {},
}))

// File-scope safety net for isProductionFlag (Issue #229 test block below):
// every OTHER describe block in this file resets mockEscrowFeatureFlag in
// its own beforeEach but has no reason to know about isProductionFlag, so a
// production-mode test left it `true` would otherwise leak into whichever
// describe block happens to run next (real jest.config.js file-level
// isolation resets module state between FILES, never between tests within
// one file). A single top-level afterEach is the one place that can
// guarantee this without touching every existing beforeEach individually.
afterEach(() => {
  isProductionFlag = false
})

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
}))

// lightning-hodl.provider.ts's Phase 2 addition imports @scure/btc-signer
// directly (pure ESM, same reason @arkade-os/sdk itself is mocked above)
// — this test never reaches those code paths, a bare stub is enough.
jest.mock('@scure/btc-signer', () => ({ Transaction: { fromPSBT: jest.fn() } }))

const mockGetDepositAddress = jest.fn()
const mockBuildUnsignedRelease = jest.fn()
const mockBuildUnsignedRefund = jest.fn()
// M8-RF (Destination Consistency) — initiateRefund() now resolves the
// seller's registered PayoutAddress (mirroring initiateRelease()'s own
// pre-existing buyer-side resolution exactly) when no explicit
// destination is supplied. Defaults to a real registered address so
// every OTHER pre-existing test in this file — none of which cares
// about this new resolution step — keeps passing unchanged.
const mockPayoutAddressFindUnique = jest.fn()
const mockFinalizeRelease = jest.fn()
const mockFinalizeRefund = jest.fn()
// RFC-021 D9 (2026-08-02)
const mockBuildUnsignedSplit = jest.fn()
const mockFinalizeSplit = jest.fn()
jest.mock('../src/modules/open-settlement/multisig.provider', () => ({
  multisigProvider: {
    name: 'MULTISIG',
    // Missão 11 Fase 9.1 §10 — matches the real provider's own real,
    // distinct custodyModel value exactly, so
    // getCustodyModelForType()'s wiring is genuinely proven, not just
    // "returns whatever the mock has."
    custodyModel: 'client-held-buyer-seller-keys-server-held-arbiter',
    getDepositAddress: (...args: unknown[]) => mockGetDepositAddress(...args),
    lockFunds: jest.fn(),
    releaseFunds: jest.fn(),
    refundFunds: jest.fn(),
    buildUnsignedRelease: (...args: unknown[]) => mockBuildUnsignedRelease(...args),
    buildUnsignedRefund: (...args: unknown[]) => mockBuildUnsignedRefund(...args),
    finalizeRelease: (...args: unknown[]) => mockFinalizeRelease(...args),
    finalizeRefund: (...args: unknown[]) => mockFinalizeRefund(...args),
    buildUnsignedSplit: (...args: unknown[]) => mockBuildUnsignedSplit(...args),
    finalizeSplit: (...args: unknown[]) => mockFinalizeSplit(...args),
  },
}))

const mockEscrowFindUnique = jest.fn()
const mockEscrowUpdate = jest.fn()
const mockEscrowUpdateMany = jest.fn().mockResolvedValue({ count: 1 })
const mockEscrowCreate = jest.fn()
const mockEscrowEventCreate = jest.fn().mockResolvedValue({ id: 'transition-1' })
const mockEscrowEventFindFirst = jest.fn().mockResolvedValue(null)
const mockTradeFindUnique = jest.fn()
const mockDisputeFindFirst = jest.fn().mockResolvedValue(null)
const mockFeePolicyVersionFindMany = jest.fn().mockResolvedValue([])
const mockParticipantKeyUpsert = jest.fn()
const mockParticipantKeyFindMany = jest.fn()
const mockParticipantKeyCreate = jest.fn()
const mockPendingTxFindUnique = jest.fn()
// Missão 11 Fase 9.1 §1/§2 — assertFundingNotUncertain() (wired into
// initiateSignatureCollectionCore() for release/split) now queries this
// table before the provider is ever invoked; empty history is the
// trustworthy/no-op case every test in this file needs (none of them
// are testing funding-uncertainty behavior itself).
const mockEscrowFundingEvidenceFindMany = jest.fn().mockResolvedValue([])
const mockPendingTxCreate = jest.fn()
const mockPendingTxDelete = jest.fn()
const mockTxSignatureUpsert = jest.fn()
const mockTxSignatureFindMany = jest.fn()
// eventBus's default store is PostgresEventStore as of Missão 05.7 — this
// file's real eventBus.emit() calls (via escrow.service.ts/escrow-lifecycle.ts,
// not mocked here) now need prisma.durableEventRecord too.
const mockDurableEventCreate = jest.fn()
const mockDurableEventFindFirst = jest.fn().mockResolvedValue(null)
// PostgresEventStore.publish() (Missão 05.8) wraps its write in a real
// Postgres transaction (pg_advisory_xact_lock-serialized per
// correlationId) — a trivial passthrough is enough here since this file
// doesn't test EventStore concurrency (tests/postgresEventStore.test.ts
// does).
// Missão 11 Fase 9.3 — withEscrowFundingLock() (escrow-lifecycle.ts) now
// also runs markPaymentSent()/initiateRelease()/initiateRefund()/
// initiateSplit()'s final state-changing write through this same
// $transaction mock, so the tx object handed to the callback needs the
// same model methods the top-level prisma mock above already provides
// (delegating to the identical jest.fn()s — a test asserting on
// mockEscrowUpdateMany/mockPendingTxCreate/mockEscrowFundingEvidenceFindMany
// sees the call whether it went through the mocked prisma singleton or
// through this tx passthrough, exactly like a real Prisma transaction).
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
    escrowPendingTransaction: {
      create: (...args: unknown[]) => mockPendingTxCreate(...args),
      // Issue #291 - persistSettlementResult() verifies the live pending operation inside its transaction.
      findFirst: (...args: unknown[]) => (mockPendingTxFindUnique as any)(...args),
    },
    escrowFundingEvidence: {
      findMany: (...args: unknown[]) => mockEscrowFundingEvidenceFindMany(...args),
    },
    // Missão 11 Fase 9.7 — emitEscrowTransition() now does its own
    // escrowEvent existence-check-then-create INSIDE withEscrowFundingLock()
    // — reuses the same mocks as the top-level escrowEvent block below.
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
      create: (...args: unknown[]) => mockEscrowCreate(...args),
    },
    escrowEvent: {
      create: (...args: unknown[]) => mockEscrowEventCreate(...args),
      findFirst: (...args: unknown[]) => mockEscrowEventFindFirst(...args),
    },
    trade: { findUnique: (...args: unknown[]) => mockTradeFindUnique(...args) },
    payoutAddress: { findUnique: (...args: unknown[]) => mockPayoutAddressFindUnique(...args) },
    // Missão 11 Fase 4.1 — createEscrow() now UNGUARDEDLY calls
    // escrowFeeSnapshotService.computeSnapshotFields() before creating the
    // escrow row (fail-closed, see escrow.service.ts's own comment) —
    // findMany() must resolve (not be undefined) so "no PUBLISHED policy
    // for this rail" resolves to its normal, expected null/no-op outcome
    // instead of throwing and failing every createEscrow() test in this
    // file. No test here exercises a real fee policy — that's covered by
    // tests/escrowFeeSnapshotService.test.ts and the real-Postgres
    // integration suite.
    feePolicyVersion: { findMany: (...args: unknown[]) => mockFeePolicyVersionFindMany(...args) },
    escrowParticipantKey: {
      upsert: (...args: unknown[]) => mockParticipantKeyUpsert(...args),
      findMany: (...args: unknown[]) => mockParticipantKeyFindMany(...args),
      create: (...args: unknown[]) => mockParticipantKeyCreate(...args),
    },
    escrowPendingTransaction: {
      findUnique: (...args: unknown[]) => mockPendingTxFindUnique(...args),
      create: (...args: unknown[]) => mockPendingTxCreate(...args),
      delete: (...args: unknown[]) => mockPendingTxDelete(...args),
    },
    escrowTransactionSignature: {
      upsert: (...args: unknown[]) => mockTxSignatureUpsert(...args),
      findMany: (...args: unknown[]) => mockTxSignatureFindMany(...args),
    },
    dispute: { findFirst: (...args: unknown[]) => mockDisputeFindFirst(...args) },
    escrowFundingEvidence: { findMany: (...args: unknown[]) => mockEscrowFundingEvidenceFindMany(...args) },
    durableEventRecord: {
      create: (...args: unknown[]) => mockDurableEventCreate(...args),
      findFirst: (...args: unknown[]) => mockDurableEventFindFirst(...args),
    },
    $transaction: (...args: unknown[]) => mockTransaction(...(args as [any])),
  },
}))

import { escrowService, recommendedEscrowType, resolveEscrowType } from '../src/modules/open-settlement/escrow.service'
import { MULTISIG_CAPABILITY_PROFILE_V1, ESCROW_TYPE_VALUES } from '@satsails/p2p-schemas'
import { EscrowError } from '../src/common/errors'
import { getSettlementProvider, assertDeploymentEligible, getSignatureCollectionProvider } from '../src/modules/open-settlement/escrow-providers'
import * as fs from 'fs'
import * as path from 'path'

const BUYER_PUBKEY = '021744d7bd3cd8e7f62e7aa8f7db8292680b745d09f8f40377c4bbbc0136d4e299'
const SELLER_PUBKEY = '038e41e2cb09677fd4bde9f232871533925c4b628c25efdb9d572546293850ddd4'

describe('createEscrow() — no longer populates multisigAddr immediately (client-held keys)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockEscrowFeatureFlag = false
  })

  it('does NOT call getDepositAddress for a MULTISIG escrow at creation time', async () => {
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1', escrowId: null })
    mockEscrowCreate.mockResolvedValue({ id: 'escrow-1', tradeId: 'trade-1', type: 'MULTISIG', asset: 'BTC', lockedAmount: '0.001', multisigAddr: null })

    const result = await escrowService.createEscrow({ tradeId: 'trade-1', type: 'MULTISIG' as any, lockedAmount: '0.001', asset: 'BTC' as any }, 'buyer-1')

    expect(mockGetDepositAddress).not.toHaveBeenCalled()
    expect(mockEscrowUpdate).not.toHaveBeenCalled()
    expect(result.multisigAddr).toBeNull()
  })

  it('does NOT call getDepositAddress for a non-MULTISIG escrow either', async () => {
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-2', buyerId: 'buyer-1', sellerId: 'seller-1', escrowId: null })
    mockEscrowCreate.mockResolvedValue({ id: 'escrow-2', tradeId: 'trade-2', type: 'WDK_USDT_EVM', asset: 'USDT_ERC20', lockedAmount: '5' })

    await escrowService.createEscrow({ tradeId: 'trade-2', type: 'WDK_USDT_EVM' as any, lockedAmount: '5', asset: 'USDT_ERC20' as any }, 'buyer-1')

    expect(mockGetDepositAddress).not.toHaveBeenCalled()
    expect(mockEscrowUpdate).not.toHaveBeenCalled()
  })
})

describe('createEscrow() — asset-aware default type (multisig-coverage-per-asset audit)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockEscrowFeatureFlag = false
  })

  it('defaults an omitted type to MULTISIG for a BTC trade', async () => {
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1', escrowId: null })
    mockEscrowCreate.mockResolvedValue({ id: 'escrow-1', tradeId: 'trade-1', type: 'MULTISIG', asset: 'BTC', lockedAmount: '0.001' })

    await escrowService.createEscrow({ tradeId: 'trade-1', lockedAmount: '0.001', asset: 'BTC' as any }, 'buyer-1')

    expect(mockEscrowCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'MULTISIG' }) }))
  })

  it('defaults an omitted type to LIGHTNING_HODL for an LN_BTC trade', async () => {
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-2', buyerId: 'buyer-1', sellerId: 'seller-1', escrowId: null })
    mockEscrowCreate.mockResolvedValue({ id: 'escrow-2', tradeId: 'trade-2', type: 'LIGHTNING_HODL', asset: 'LN_BTC', lockedAmount: '0.001' })

    await escrowService.createEscrow({ tradeId: 'trade-2', lockedAmount: '0.001', asset: 'LN_BTC' as any }, 'buyer-1')

    expect(mockEscrowCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'LIGHTNING_HODL' }) }))
  })

  it('defaults an omitted type to WDK_USDT_EVM for a USDT_ERC20 trade', async () => {
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-3', buyerId: 'buyer-1', sellerId: 'seller-1', escrowId: null })
    mockEscrowCreate.mockResolvedValue({ id: 'escrow-3', tradeId: 'trade-3', type: 'WDK_USDT_EVM', asset: 'USDT_ERC20', lockedAmount: '5' })

    await escrowService.createEscrow({ tradeId: 'trade-3', lockedAmount: '5', asset: 'USDT_ERC20' as any }, 'buyer-1')

    expect(mockEscrowCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'WDK_USDT_EVM' }) }))
  })

  it('does NOT silently default to MULTISIG for an asset with no real provider — throws instead', async () => {
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-4', buyerId: 'buyer-1', sellerId: 'seller-1', escrowId: null })

    await expect(escrowService.createEscrow({ tradeId: 'trade-4', lockedAmount: '10', asset: 'SPARK' as any }, 'buyer-1')).rejects.toThrow(
      "No real SettlementProvider is wired for asset 'SPARK'"
    )
    expect(mockEscrowCreate).not.toHaveBeenCalled()
  })

  it('MOCK_ESCROW=true still defaults every asset to MOCK regardless of recommendedEscrowType', async () => {
    mockEscrowFeatureFlag = true
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-5', buyerId: 'buyer-1', sellerId: 'seller-1', escrowId: null })
    mockEscrowCreate.mockResolvedValue({ id: 'escrow-5', tradeId: 'trade-5', type: 'MOCK', asset: 'SPARK', lockedAmount: '10' })

    await escrowService.createEscrow({ tradeId: 'trade-5', lockedAmount: '10', asset: 'SPARK' as any }, 'buyer-1')

    expect(mockEscrowCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'MOCK' }) }))
  })

  it('an explicitly passed type is never overridden, even for an asset with a different recommendation', async () => {
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-6', buyerId: 'buyer-1', sellerId: 'seller-1', escrowId: null })
    mockEscrowCreate.mockResolvedValue({ id: 'escrow-6', tradeId: 'trade-6', type: 'MOCK', asset: 'BTC', lockedAmount: '0.001' })

    await escrowService.createEscrow({ tradeId: 'trade-6', type: 'MOCK', lockedAmount: '0.001', asset: 'BTC' as any }, 'buyer-1')

    expect(mockEscrowCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'MOCK' }) }))
  })
})

describe('createEscrow() — MOCK escrow production-eligibility gate (Issue #229)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockEscrowFeatureFlag = false
    isProductionFlag = false
  })

  it('rejects an explicit type: "MOCK" in production', async () => {
    isProductionFlag = true
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-prod-1', buyerId: 'buyer-1', sellerId: 'seller-1', escrowId: null })

    await expect(
      escrowService.createEscrow({ tradeId: 'trade-prod-1', type: 'MOCK', lockedAmount: '0.001', asset: 'BTC' as any }, 'buyer-1')
    ).rejects.toThrow(/not economically eligible in production/)
    expect(mockEscrowCreate).not.toHaveBeenCalled()
  })

  it('rejects an explicit type: "MOCK" in production regardless of asset (not just BTC)', async () => {
    isProductionFlag = true
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-prod-2', buyerId: 'buyer-1', sellerId: 'seller-1', escrowId: null })

    await expect(
      escrowService.createEscrow({ tradeId: 'trade-prod-2', type: 'MOCK', lockedAmount: '5', asset: 'USDT_ERC20' as any }, 'buyer-1')
    ).rejects.toThrow(/not economically eligible in production/)
    expect(mockEscrowCreate).not.toHaveBeenCalled()
  })

  it('rejects via the standard EscrowError shape (409, ESCROW_ERROR, reason DISABLED) — same envelope every other capability-denial in this file already uses', async () => {
    isProductionFlag = true
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-prod-5', buyerId: 'buyer-1', sellerId: 'seller-1', escrowId: null })

    let caught: unknown
    try {
      await escrowService.createEscrow({ tradeId: 'trade-prod-5', type: 'MOCK', lockedAmount: '0.001', asset: 'BTC' as any }, 'buyer-1')
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(EscrowError)
    const err = caught as InstanceType<typeof EscrowError>
    expect(err.statusCode).toBe(409)
    expect(err.code).toBe('ESCROW_ERROR')
    expect(err.reason).toBe('DISABLED')
  })

  it('still allows an explicit type: "MOCK" outside production (dev/test) — the pre-existing escape hatch is unchanged', async () => {
    isProductionFlag = false
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-dev-1', buyerId: 'buyer-1', sellerId: 'seller-1', escrowId: null })
    mockEscrowCreate.mockResolvedValue({ id: 'escrow-dev-1', tradeId: 'trade-dev-1', type: 'MOCK', asset: 'BTC', lockedAmount: '0.001' })

    await escrowService.createEscrow({ tradeId: 'trade-dev-1', type: 'MOCK', lockedAmount: '0.001', asset: 'BTC' as any }, 'buyer-1')

    expect(mockEscrowCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'MOCK' }) }))
  })

  it('does not affect a real, non-MOCK explicit type in production', async () => {
    isProductionFlag = true
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-prod-3', buyerId: 'buyer-1', sellerId: 'seller-1', escrowId: null })
    mockEscrowCreate.mockResolvedValue({ id: 'escrow-prod-3', tradeId: 'trade-prod-3', type: 'MULTISIG', asset: 'BTC', lockedAmount: '0.001' })

    await escrowService.createEscrow({ tradeId: 'trade-prod-3', type: 'MULTISIG' as any, lockedAmount: '0.001', asset: 'BTC' as any }, 'buyer-1')

    expect(mockEscrowCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'MULTISIG' }) }))
  })

  it('does not affect an omitted type in production — the implicit default (already gated by RT-001/MOCK_ESCROW at boot) is untouched', async () => {
    isProductionFlag = true
    mockEscrowFeatureFlag = false // RT-001 already guarantees this in a real production boot
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-prod-4', buyerId: 'buyer-1', sellerId: 'seller-1', escrowId: null })
    mockEscrowCreate.mockResolvedValue({ id: 'escrow-prod-4', tradeId: 'trade-prod-4', type: 'MULTISIG', asset: 'BTC', lockedAmount: '0.001' })

    await escrowService.createEscrow({ tradeId: 'trade-prod-4', lockedAmount: '0.001', asset: 'BTC' as any }, 'buyer-1')

    expect(mockEscrowCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'MULTISIG' }) }))
  })
})

// Issue #229 R2 (CTO corrective mission) — the R1 pass above only closed
// the CREATION path. CTO Gate found provider DISPATCH still trusted a
// persisted `Escrow.type = 'MOCK'` row unconditionally regardless of
// environment, so a row that existed before the R1 gate (or reached a
// production database out-of-band, e.g. a promoted staging DB) could
// still fabricate lock/release/refund/split "success" forever. These
// tests prove getSettlementProvider() — the single choke point every
// economically active dispatch (lockFunds/releaseFunds/refundFunds/
// splitFunds) funnels through — now refuses MOCK in production BEFORE
// the real MockSettlementProvider (unmocked in this file — only its
// upstream dependencies like multisig.provider.ts are mocked) ever runs,
// proven by asserting the economic-result write (mockEscrowUpdate, which
// updateLockResult()/updateReleaseResult()/updateRefundResult()/
// updateSplitResult() all funnel through) is never reached.
describe('getSettlementProvider() / escrow.service.ts economic methods — persisted MOCK row cannot execute in production (Issue #229 R2/R3)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockEscrowFeatureFlag = false
    mockEscrowUpdateMany.mockResolvedValue({ count: 1 })
  })

  it('getSettlementProvider("MOCK") itself throws in production — the one function every dispatch path shares', () => {
    isProductionFlag = true
    expect(() => getSettlementProvider('MOCK')).toThrow(/not economically eligible in production/)
  })

  it('getSettlementProvider("MOCK") still returns the real MockSettlementProvider outside production — unchanged', () => {
    isProductionFlag = false
    const provider = getSettlementProvider('MOCK')
    expect(provider.name).toBe('MOCK')
  })

  it('a persisted MOCK escrow + production lockFunds() is rejected before any economic write', async () => {
    isProductionFlag = true
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-mock-1', tradeId: 'trade-1', type: 'MOCK', status: 'CREATED', timelockHours: 24 })
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' })

    await expect(escrowService.lockFunds('escrow-mock-1', 'seller-1')).rejects.toThrow(/not economically eligible in production/)
    // mockEscrowUpdate DOES get one call from claimEscrowTransition's own
    // revert-on-failure (a plain `{status: originalStatus}` write, no
    // fabricated economic result) — the real proof of "no side effect" is
    // that no call ever carries the economic-result field the real
    // MockSettlementProvider.lockFunds() would have produced.
    expect(mockEscrowUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ txLockId: expect.anything() }) }))
  })

  it('a persisted MOCK escrow + production releaseFunds() is rejected before any economic write', async () => {
    isProductionFlag = true
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-mock-2', tradeId: 'trade-2', type: 'MOCK', status: 'PAYMENT_PENDING' })
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-2', buyerId: 'buyer-1', sellerId: 'seller-1' })

    await expect(escrowService.releaseFunds('escrow-mock-2', 'tb1qexplicit', 'seller-1')).rejects.toThrow(/not economically eligible in production/)
    expect(mockEscrowUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ txReleaseId: expect.anything() }) }))
  })

  it('a persisted MOCK escrow + production refundFunds() is rejected before any economic write', async () => {
    isProductionFlag = true
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-mock-3', tradeId: 'trade-3', type: 'MOCK', status: 'FUNDS_LOCKED' })
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-3', buyerId: 'buyer-1', sellerId: 'seller-1' })

    await expect(escrowService.refundFunds('escrow-mock-3', 'seller-1')).rejects.toThrow(/not economically eligible in production/)
    expect(mockEscrowUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ txReleaseId: expect.anything() }) }))
  })

  it('a persisted MOCK escrow + production splitFunds() is rejected before any economic write', async () => {
    isProductionFlag = true
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-mock-4', tradeId: 'trade-4', type: 'MOCK', status: 'DISPUTED' })
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-4', buyerId: 'buyer-1', sellerId: 'seller-1' })
    // .mockResolvedValueOnce, not .mockResolvedValue — this file's own
    // documented gotcha (jest.clearAllMocks() does not reset a persistent
    // .mockResolvedValue()): a non-once value here would silently make
    // EVERY later test in this file see a dispute for ANY (tradeId,
    // arbiterId) pair, including ones asserting the opposite (no dispute
    // -> unauthorized caller rejected).
    mockDisputeFindFirst.mockResolvedValueOnce({ id: 'dispute-1', tradeId: 'trade-4', arbiterId: 'arbiter-1' })

    await expect(
      escrowService.splitFunds('escrow-mock-4', 'tb1qbuyer', 'tb1qseller', 6000, 'arbiter-1')
    ).rejects.toThrow(/not economically eligible in production/)
    expect(mockEscrowUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ txReleaseId: expect.anything() }) }))
  })

  it('the signature-collection initiation paths (initiateRelease/initiateRefund/initiateSplit) already reject MOCK unconditionally — no economic-execution seam there either, in any environment', async () => {
    // MOCK is a direct-call rail (SIGNATURE_COLLECTION_PROVIDERS has no
    // 'MOCK' entry — escrow-providers.ts), so these three throw on the
    // provider-lookup guard itself before config is ever consulted; true
    // in production and outside it alike. Proves #229's "signature/
    // reconciliation/recovery path" surface has no separate MOCK seam to
    // gate — initiateSplit()'s own equivalent case is already covered
    // above ("rejects an escrow type with no registered
    // SignatureCollectionProvider").
    isProductionFlag = false
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-mock-5', tradeId: 'trade-5', type: 'MOCK', status: 'PAYMENT_PENDING' })
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-5', buyerId: 'buyer-1', sellerId: 'seller-1' })

    // Explicit destinations passed so resolvePayoutAddress() (which both
    // functions call BEFORE reaching the SIGNATURE_COLLECTION_PROVIDERS
    // guard) never needs a registered PayoutAddress row — keeps this test
    // isolated to the one guard it's actually about.
    await expect(escrowService.initiateRelease('escrow-mock-5', 'tb1qexplicit', 'seller-1')).rejects.toThrow(
      'does not use the client-signature-collection release flow'
    )
    await expect(escrowService.initiateRefund('escrow-mock-5', 'seller-1', 'tb1qexplicit')).rejects.toThrow(
      'does not use the client-signature-collection refund flow'
    )
  })

  it('restart/reconciliation cannot reactivate a persisted MOCK escrow\'s economic execution — reconciliation only ever queries type: MULTISIG, so a MOCK row is structurally never selected, and even a direct getSettlementProvider("MOCK") call after "restart" (a fresh call in this same process) still refuses in production', async () => {
    // escrow-settlement-reconciliation.service.ts's own reconcileUnclaimedFullySignedPending()
    // query is `where: { escrow: { type: 'MULTISIG', ... } }` (audited
    // directly, Issue #229 R2) — a MOCK-typed escrow is never even a
    // candidate row for that service, in any environment, because MOCK
    // is a direct-call rail with no EscrowPendingTransaction ever
    // created for it. "Restart" has no special code path of its own in
    // this codebase (no cached provider instance, no process-lifetime
    // state) — getSettlementProvider() re-evaluates config.isProduction
    // on every call, so there is nothing a restart could do to reactivate
    // access that a fresh call already refuses.
    isProductionFlag = true
    expect(() => getSettlementProvider('MOCK')).toThrow(/not economically eligible in production/)
    isProductionFlag = true // simulate a second, independent call ("after restart") — same outcome
    expect(() => getSettlementProvider('MOCK')).toThrow(/not economically eligible in production/)
  })

  // MULTISIG's own "split" flow goes through initiateSplit()/buildUnsignedSplit()
  // (SIGNATURE_COLLECTION_PROVIDERS — already covered by the existing
  // 'initiateSplit()' describe block elsewhere in this file), not through
  // this direct-call splitFunds() method (that's MOCK/WDK_USDT_EVM only)
  // — lock/release/refund below is the complete, correct set of direct-
  // dispatch economic methods MULTISIG actually uses.
  it('a real, deployment-eligible provider (MULTISIG) retains its exact current production behavior — lock/release/refund all still dispatch normally', async () => {
    isProductionFlag = true
    const { multisigProvider } = jest.requireMock('../src/modules/open-settlement/multisig.provider') as any

    // lockFunds
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-ms-1', tradeId: 'trade-ms-1', type: 'MULTISIG', status: 'CREATED', timelockHours: 24, multisigAddr: 'tb1qaddr' })
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-ms-1', buyerId: 'buyer-1', sellerId: 'seller-1' })
    mockParticipantKeyFindMany.mockResolvedValue([])
    // vout deliberately omitted — a defined vout triggers the separate
    // funding-evidence-recording path (escrowFundingEvidenceRepository),
    // which this file doesn't mock at the top-level (non-$transaction)
    // prisma client and isn't what this test is about.
    multisigProvider.lockFunds.mockResolvedValueOnce({ txId: 'real-lock-txid', address: 'tb1qaddr' })
    mockEscrowUpdate.mockResolvedValueOnce({ id: 'escrow-ms-1', txLockId: 'real-lock-txid' })

    const locked = await escrowService.lockFunds('escrow-ms-1', 'seller-1')
    expect(locked.txLockId).toBe('real-lock-txid')
    expect(multisigProvider.lockFunds).toHaveBeenCalled()

    // releaseFunds
    jest.clearAllMocks()
    mockEscrowFeatureFlag = false
    mockEscrowUpdateMany.mockResolvedValue({ count: 1 })
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-ms-2', tradeId: 'trade-ms-2', type: 'MULTISIG', status: 'PAYMENT_PENDING' })
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-ms-2', buyerId: 'buyer-1', sellerId: 'seller-1' })
    multisigProvider.releaseFunds.mockResolvedValueOnce({ txId: 'real-release-txid' })
    mockEscrowUpdate.mockResolvedValueOnce({ id: 'escrow-ms-2', txReleaseId: 'real-release-txid' })

    const released = await escrowService.releaseFunds('escrow-ms-2', 'tb1qbuyer', 'seller-1')
    expect(released.txReleaseId).toBe('real-release-txid')
    expect(multisigProvider.releaseFunds).toHaveBeenCalled()

    // refundFunds
    jest.clearAllMocks()
    mockEscrowFeatureFlag = false
    mockEscrowUpdateMany.mockResolvedValue({ count: 1 })
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-ms-3', tradeId: 'trade-ms-3', type: 'MULTISIG', status: 'FUNDS_LOCKED' })
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-ms-3', buyerId: 'buyer-1', sellerId: 'seller-1' })
    multisigProvider.refundFunds.mockResolvedValueOnce({ txId: 'real-refund-txid' })
    mockEscrowUpdate.mockResolvedValueOnce({ id: 'escrow-ms-3', txReleaseId: 'real-refund-txid' })

    const refunded = await escrowService.refundFunds('escrow-ms-3', 'seller-1')
    expect(refunded.txReleaseId).toBe('real-refund-txid')
    expect(multisigProvider.refundFunds).toHaveBeenCalled()
  })

  it('the protocol/schema still represents MOCK as a valid escrow type — this mission never removed it from the wire enum', () => {
    expect(ESCROW_TYPE_VALUES).toContain('MOCK')
  })

  // Issue #229 R3 — CTO Gate R2 found assertDeploymentEligible() was only
  // wired into getSettlementProvider()'s `if (type === 'MOCK')` branch and
  // resolveEscrowType()'s `if (explicitType === 'MOCK')` branch, making the
  // "canonical, generic policy" claim false: a future #220 addition to
  // PRODUCTION_INELIGIBLE_TYPES would silently do nothing unless a second,
  // provider-specific `if` were also added at each call site. Both were
  // refactored to call the check unconditionally, once, on whatever type
  // is actually being resolved/dispatched — these tests prove that shape
  // directly, since PRODUCTION_INELIGIBLE_TYPES having only one real
  // member (MOCK) today means no purely-outcome-based test could ever
  // distinguish "checked generically" from "checked only for the literal
  // string MOCK" (both produce byte-identical outward behavior for every
  // input that exists today) — the mission explicitly forbids adding a
  // second real provider classification just to create that difference.
  describe('eligibility check is generic — not a MOCK-only regression (Issue #229 R3)', () => {
    it('assertDeploymentEligible() itself is driven purely by set membership, not a hardcoded MOCK comparison', () => {
      isProductionFlag = true
      expect(() => assertDeploymentEligible('MOCK')).toThrow(/not economically eligible in production/)
      // A type that is NOT in PRODUCTION_INELIGIBLE_TYPES today (a
      // hypothetical/unregistered string, never wired to any real
      // provider or added to that set by this mission) must NOT be
      // rejected by this function even in production — proves the
      // function checks membership in the policy set, not "is this
      // string literally 'MOCK'".
      expect(() => assertDeploymentEligible('HYPOTHETICAL_TYPE_NOT_IN_ANY_POLICY_SET')).not.toThrow()

      isProductionFlag = false
      expect(() => assertDeploymentEligible('MOCK')).not.toThrow()
    })

    it('getSettlementProvider() invokes the eligibility check unconditionally, before its MOCK-specific branch — regression guard against the R2 placement CTO Gate R2 rejected', () => {
      // Behavioral tests above cannot distinguish
      // `assertDeploymentEligible(type); if (type === 'MOCK') return ...`
      // (R3, correct) from
      // `if (type === 'MOCK') { assertDeploymentEligible(type); return ... }`
      // (R2, rejected) — both produce identical results for every type
      // that actually exists in PROVIDERS today. This inspects the real,
      // compiled function's own source to assert the call site's
      // position directly: the eligibility check must appear BEFORE the
      // MOCK-specific branch, not nested inside it.
      const source = getSettlementProvider.toString()
      const eligibilityCallIndex = source.indexOf('assertDeploymentEligible(')
      const mockBranchIndex = source.indexOf("type === 'MOCK'")
      expect(eligibilityCallIndex).toBeGreaterThan(-1)
      expect(mockBranchIndex).toBeGreaterThan(-1)
      expect(eligibilityCallIndex).toBeLessThan(mockBranchIndex)
    })

    it('resolveEscrowType() invokes its provider/eligibility check exactly once, on the final resolved type, not per-branch', () => {
      // Same reasoning as above, applied to the creation path: R2 called
      // assertDeploymentEligible() only from inside the
      // `explicitType === 'MOCK'` branch — the implicit mockEscrow
      // default, canonical-registry, and legacy-fallback branches never
      // passed through it. R3 separated resolution
      // (resolveEscrowTypeCandidate) from a single eligibility assertion
      // running unconditionally on whatever type was resolved.
      //
      // Corrected/Implemented 2026-09-19 (Issue #243) — resolveEscrowType()
      // no longer calls assertDeploymentEligible() directly at all; #243
      // replaced that call with getSettlementProvider(resolved), which
      // performs the exact same eligibility check FIRST internally, and
      // additionally verifies a SettlementProvider is actually registered
      // for the type (closing the "schema-valid + deployment-eligible but
      // zero runtime implementation" gap — see LIQUID_COVENANT tests
      // below). The regression-guard property this test protects is
      // unchanged in spirit: exactly one call, on the final resolved
      // type, not per-branch — only the specific function name changed.
      const source = resolveEscrowType.toString()
      const matches = source.match(/getSettlementProvider\)?\s*\(/g) ?? []
      expect(matches).toHaveLength(1)
    })

    it('a real, registered, always-eligible type (MULTISIG) is unaffected by the generic check — production creation and dispatch both still succeed', async () => {
      isProductionFlag = true
      expect(() => getSettlementProvider('MULTISIG')).not.toThrow()
      expect(resolveEscrowType('BTC' as any, 'MULTISIG' as any)).toBe('MULTISIG')
    })
  })
})

describe('createEscrow() — resolved via canonical SettlementScope/Provider registry (VERTICAL-SLICE-1, generalized by Mission 4)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockEscrowFeatureFlag = false
  })

  it('resolves an omitted type to MULTISIG for BTC via the canonical registry (same outcome as before, new mechanism)', async () => {
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-btc-1', buyerId: 'buyer-1', sellerId: 'seller-1', escrowId: null })
    mockEscrowCreate.mockResolvedValue({ id: 'escrow-btc-1', tradeId: 'trade-btc-1', type: 'MULTISIG', asset: 'BTC', lockedAmount: '0.001' })

    await escrowService.createEscrow({ tradeId: 'trade-btc-1', lockedAmount: '0.001', asset: 'BTC' as any }, 'buyer-1')

    expect(mockEscrowCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'MULTISIG' }) }))
  })

  it('validates a client-supplied type "MULTISIG" for BTC against the canonical registry (simulates the SDK\'s own client-side default, the real Reference UI path)', async () => {
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-btc-2', buyerId: 'buyer-1', sellerId: 'seller-1', escrowId: null })
    mockEscrowCreate.mockResolvedValue({ id: 'escrow-btc-2', tradeId: 'trade-btc-2', type: 'MULTISIG', asset: 'BTC', lockedAmount: '0.001' })

    await escrowService.createEscrow({ tradeId: 'trade-btc-2', type: 'MULTISIG' as any, lockedAmount: '0.001', asset: 'BTC' as any }, 'buyer-1')

    expect(mockEscrowCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'MULTISIG' }) }))
  })

  it('rejects a client-supplied type for BTC that disagrees with the canonical registry (never silently trusts the caller)', async () => {
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-btc-3', buyerId: 'buyer-1', sellerId: 'seller-1', escrowId: null })

    await expect(
      escrowService.createEscrow({ tradeId: 'trade-btc-3', type: 'WDK_USDT_EVM' as any, lockedAmount: '0.001', asset: 'BTC' as any }, 'buyer-1')
    ).rejects.toThrow("type 'WDK_USDT_EVM' does not match 'MULTISIG'")
    expect(mockEscrowCreate).not.toHaveBeenCalled()
  })

  it('MOCK override for BTC still bypasses canonical resolution entirely (pre-existing escape hatch, unchanged)', async () => {
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-btc-4', buyerId: 'buyer-1', sellerId: 'seller-1', escrowId: null })
    mockEscrowCreate.mockResolvedValue({ id: 'escrow-btc-4', tradeId: 'trade-btc-4', type: 'MOCK', asset: 'BTC', lockedAmount: '0.001' })

    await escrowService.createEscrow({ tradeId: 'trade-btc-4', type: 'MOCK', lockedAmount: '0.001', asset: 'BTC' as any }, 'buyer-1')

    expect(mockEscrowCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'MOCK' }) }))
  })

  it('does not affect LN_BTC resolution — no canonical mapping is authorized for it (ADR-002 §11, deliberately ambiguous)', async () => {
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-btc-5', buyerId: 'buyer-1', sellerId: 'seller-1', escrowId: null })
    mockEscrowCreate.mockResolvedValue({ id: 'escrow-btc-5', tradeId: 'trade-btc-5', type: 'LIGHTNING_HODL', asset: 'LN_BTC', lockedAmount: '0.001' })

    await escrowService.createEscrow({ tradeId: 'trade-btc-5', lockedAmount: '0.001', asset: 'LN_BTC' as any }, 'buyer-1')

    expect(mockEscrowCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'LIGHTNING_HODL' }) }))
  })

  // Mission 4 (2026-09-14) — generalizes the canonical-registry path from
  // BTC-only to every ADR-002 §11 legacy mapping. USDT_ERC20's final
  // OUTCOME is unchanged (still WDK_USDT_EVM, already covered by the
  // "asset-aware default type" describe block above) — these tests cover
  // what's newly true: it now goes through the SAME mechanism as BTC
  // (canonical-registry validation, not the separate flat
  // RECOMMENDED_ESCROW_TYPE lookup), and three legacy assets that
  // previously threw a generic "no real SettlementProvider is wired"
  // error now throw a more precise, honest message distinguishing
  // "registered Product Scope, zero providers" from "not wired at all."

  it('validates a client-supplied type "WDK_USDT_EVM" for USDT_ERC20 against the canonical registry (same mechanism as BTC now)', async () => {
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-usdt-1', buyerId: 'buyer-1', sellerId: 'seller-1', escrowId: null })
    mockEscrowCreate.mockResolvedValue({ id: 'escrow-usdt-1', tradeId: 'trade-usdt-1', type: 'WDK_USDT_EVM', asset: 'USDT_ERC20', lockedAmount: '5' })

    await escrowService.createEscrow({ tradeId: 'trade-usdt-1', type: 'WDK_USDT_EVM' as any, lockedAmount: '5', asset: 'USDT_ERC20' as any }, 'buyer-1')

    expect(mockEscrowCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'WDK_USDT_EVM' }) }))
  })

  it('rejects a client-supplied type for USDT_ERC20 that disagrees with the canonical registry', async () => {
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-usdt-2', buyerId: 'buyer-1', sellerId: 'seller-1', escrowId: null })

    await expect(
      escrowService.createEscrow({ tradeId: 'trade-usdt-2', type: 'MULTISIG' as any, lockedAmount: '5', asset: 'USDT_ERC20' as any }, 'buyer-1')
    ).rejects.toThrow("type 'MULTISIG' does not match 'WDK_USDT_EVM'")
    expect(mockEscrowCreate).not.toHaveBeenCalled()
  })

  it('USDT_TRC20 is registered Product Scope ({USDT, TRON}) but has zero providers — precise error, not the generic "no provider wired" message', async () => {
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-usdt-trc', buyerId: 'buyer-1', sellerId: 'seller-1', escrowId: null })

    await expect(
      escrowService.createEscrow({ tradeId: 'trade-usdt-trc', lockedAmount: '5', asset: 'USDT_TRC20' as any }, 'buyer-1')
    ).rejects.toThrow('is registered Product Scope but has zero registered settlement implementations yet')
    expect(mockEscrowCreate).not.toHaveBeenCalled()
  })

  it('USDT_LIQUID is registered Product Scope ({USDT, LIQUID}) but has zero providers — same precise error', async () => {
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-usdt-liquid', buyerId: 'buyer-1', sellerId: 'seller-1', escrowId: null })

    await expect(
      escrowService.createEscrow({ tradeId: 'trade-usdt-liquid', lockedAmount: '5', asset: 'USDT_LIQUID' as any }, 'buyer-1')
    ).rejects.toThrow('is registered Product Scope but has zero registered settlement implementations yet')
  })

  it('LIQUID_BTC is registered Product Scope ({BTC, LIQUID}) but has zero providers — same precise error', async () => {
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-liquid-btc', buyerId: 'buyer-1', sellerId: 'seller-1', escrowId: null })

    await expect(
      escrowService.createEscrow({ tradeId: 'trade-liquid-btc', lockedAmount: '0.001', asset: 'LIQUID_BTC' as any }, 'buyer-1')
    ).rejects.toThrow('is registered Product Scope but has zero registered settlement implementations yet')
  })
})

// Issue #243 (Beta correctness remediation, #220-discovered) — the tests
// above already prove every LEGACY-MAPPED asset (BTC/USDT_ERC20/
// USDT_TRC20/USDT_LIQUID/LIQUID_BTC) is safe: translateLegacyAssetType()
// routes them all through the canonical SettlementScope/Provider
// registry, which only ever returns implementations it already knows are
// registered. The gap #243 closes is the OTHER branch —
// `explicitType ?? recommendedEscrowType(asset)` (resolveEscrowTypeCandidate's
// final fallback, reached for any asset outside that 5-entry map, e.g.
// 'SPARK') — which previously returned an explicit client-supplied type
// completely unchecked. `LIQUID_COVENANT` is the real, frozen example:
// representable in ESCROW_TYPE_VALUES (escrowCreationSchemaParity.test.ts's
// own "remains structurally valid" test proves the schema side is
// unchanged by this fix), not blocked by assertDeploymentEligible (it's
// not in PRODUCTION_INELIGIBLE_TYPES — this is not an eligibility
// question), but absent from PROVIDERS entirely. Before #243, createEscrow()
// would persist this row; the failure only surfaced later, at first
// lockFunds()/releaseFunds() call — see the PRE-EXISTING 'getProvider()'
// describe block below, whose "throws a clear error for LIQUID_COVENANT"
// test exercises exactly that DISPATCH-time behavior on an
// ALREADY-PERSISTED row (a historical-row simulation, unaffected by this
// mission, still green) — distinct from CREATION-time, which these tests
// cover.
describe('createEscrow() — refuses a resolved type with no registered SettlementProvider, before persistence (Issue #243)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockEscrowFeatureFlag = false
  })

  it('LIQUID_COVENANT: creation rejects before persistence — UNAVAILABLE, not DISABLED/FORBIDDEN/invalid-protocol-data', async () => {
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-lc-1', buyerId: 'buyer-1', sellerId: 'seller-1', escrowId: null })

    let caught: unknown
    try {
      await escrowService.createEscrow({ tradeId: 'trade-lc-1', type: 'LIQUID_COVENANT' as any, lockedAmount: '1', asset: 'SPARK' as any }, 'buyer-1')
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(EscrowError)
    const err = caught as InstanceType<typeof EscrowError>
    expect(err.message).toContain("No SettlementProvider registered for escrow type 'LIQUID_COVENANT'")
    expect(err.reason).toBe('UNAVAILABLE') // "no runtime capability", not a policy/eligibility/protocol-validity refusal
    expect(err.statusCode).not.toBe(403) // not FORBIDDEN
    // No repository write, no economic provider call, no trade mutation —
    // createEscrow() throws before ever reaching this.repo.create().
    expect(mockEscrowCreate).not.toHaveBeenCalled()
  })

  it('LIQUID_COVENANT: does not fall back to MOCK, MULTISIG, or any other provider/type', async () => {
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-lc-2', buyerId: 'buyer-1', sellerId: 'seller-1', escrowId: null })

    await expect(
      escrowService.createEscrow({ tradeId: 'trade-lc-2', type: 'LIQUID_COVENANT' as any, lockedAmount: '1', asset: 'SPARK' as any }, 'buyer-1')
    ).rejects.toThrow(/LIQUID_COVENANT/)
    // If any fallback had silently substituted a different type, this call
    // would have succeeded with a DIFFERENT resolved type — asserting the
    // create call never happened at all rules out every such substitution
    // in one assertion, rather than enumerating each candidate type.
    expect(mockEscrowCreate).not.toHaveBeenCalled()
  })

  it('LIQUID_COVENANT remains protocol-representable — the schema/enum itself is untouched by this fix (cross-check against escrowCreationSchemaParity.test.ts\'s own schema-level proof)', () => {
    expect(ESCROW_TYPE_VALUES).toContain('LIQUID_COVENANT')
  })

  it('genericity: an arbitrary future schema-shaped type with no registered provider is refused the same way — not a hardcoded LIQUID_COVENANT-only branch', async () => {
    // TypeScript's CreateEscrowInput.type is a closed union, so a genuinely
    // new type can only be exercised at the runtime/service boundary via
    // an `as any` cast — no zod/schema change is made anywhere by this
    // test. resolveEscrowTypeCandidate() and getSettlementProvider() both
    // operate on plain strings at runtime; this proves the SAME rejection
    // path fires for a type that was never named LIQUID_COVENANT anywhere
    // in this mission's implementation, i.e. the check is driven by
    // PROVIDERS membership, not a string literal comparison.
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-future-1', buyerId: 'buyer-1', sellerId: 'seller-1', escrowId: null })

    await expect(
      escrowService.createEscrow({ tradeId: 'trade-future-1', type: 'FUTURE_UNIMPLEMENTED_RAIL' as any, lockedAmount: '1', asset: 'SPARK' as any }, 'buyer-1')
    ).rejects.toThrow("No SettlementProvider registered for escrow type 'FUTURE_UNIMPLEMENTED_RAIL'")
    expect(mockEscrowCreate).not.toHaveBeenCalled()
  })

  it('a real, registered type (MULTISIG) is unaffected — creation still succeeds normally', async () => {
    // Confirms this mission's fix does not regress the ordinary success
    // path — already proven extensively above (canonical-registry
    // describe block), repeated once here as this block's own explicit
    // positive-path witness.
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-ms-243', buyerId: 'buyer-1', sellerId: 'seller-1', escrowId: null })
    mockEscrowCreate.mockResolvedValue({ id: 'escrow-ms-243', tradeId: 'trade-ms-243', type: 'MULTISIG', asset: 'BTC', lockedAmount: '0.001' })

    await escrowService.createEscrow({ tradeId: 'trade-ms-243', type: 'MULTISIG' as any, lockedAmount: '0.001', asset: 'BTC' as any }, 'buyer-1')

    expect(mockEscrowCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'MULTISIG' }) }))
  })

  it('MOCK semantics are unchanged outside production — still creates successfully (registered AND eligible)', async () => {
    isProductionFlag = false
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-mock-243', buyerId: 'buyer-1', sellerId: 'seller-1', escrowId: null })
    mockEscrowCreate.mockResolvedValue({ id: 'escrow-mock-243', tradeId: 'trade-mock-243', type: 'MOCK', asset: 'BTC', lockedAmount: '0.001' })

    await escrowService.createEscrow({ tradeId: 'trade-mock-243', type: 'MOCK', lockedAmount: '0.001', asset: 'BTC' as any }, 'buyer-1')

    expect(mockEscrowCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'MOCK' }) }))
  })

  it('MOCK in production is still refused for the ORIGINAL reason (DISABLED, deployment-ineligible) — not conflated with the NEW registration check (UNAVAILABLE)', async () => {
    // MOCK is both registered (PROVIDERS has an entry) AND deployment-
    // ineligible in production (#229/#230) — proves this mission's new
    // "is it registered" check and the pre-existing "is it eligible"
    // check remain two genuinely distinct refusals, in the right order
    // (getSettlementProvider() checks eligibility FIRST), not merged into
    // one generic error that would lose the DISABLED/UNAVAILABLE
    // distinction.
    isProductionFlag = true
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-mock-244', buyerId: 'buyer-1', sellerId: 'seller-1', escrowId: null })

    let caught: unknown
    try {
      await escrowService.createEscrow({ tradeId: 'trade-mock-244', type: 'MOCK', lockedAmount: '0.001', asset: 'BTC' as any }, 'buyer-1')
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(EscrowError)
    expect((caught as InstanceType<typeof EscrowError>).reason).toBe('DISABLED')
    expect(mockEscrowCreate).not.toHaveBeenCalled()
  })
})

describe('recommendedEscrowType()', () => {
  it('matches the audited real-provider coverage exactly', () => {
    expect(recommendedEscrowType('BTC' as any)).toBe('MULTISIG')
    expect(recommendedEscrowType('LN_BTC' as any)).toBe('LIGHTNING_HODL')
    expect(recommendedEscrowType('USDT_ERC20' as any)).toBe('WDK_USDT_EVM')
  })

  it('throws for every asset with no real SettlementProvider yet, instead of guessing', () => {
    for (const asset of ['USDT_TRC20', 'USDT_LIQUID', 'USDT_LIGHTNING', 'LIQUID_BTC', 'SPARK', 'STACKS', 'RSK_BTC']) {
      expect(() => recommendedEscrowType(asset as any)).toThrow(`No real SettlementProvider is wired for asset '${asset}'`)
    }
  })
})

describe('submitParticipantKey() — the client-held-keys write path', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockEscrowFeatureFlag = false
  })

  it('persists the first submitted key but does NOT derive an address until both arrive', async () => {
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', tradeId: 'trade-1', type: 'MULTISIG', multisigAddr: null })
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' })
    mockParticipantKeyFindMany.mockResolvedValue([{ escrowId: 'escrow-1', role: 'buyer', participantId: 'buyer-1', pubkey: BUYER_PUBKEY }])

    const result = await escrowService.submitParticipantKey('escrow-1', 'buyer-1', BUYER_PUBKEY)

    expect(mockParticipantKeyUpsert).toHaveBeenCalledWith({
      where: { escrowId_role: { escrowId: 'escrow-1', role: 'buyer' } },
      update: { participantId: 'buyer-1', pubkey: BUYER_PUBKEY, capabilityProfile: null },
      create: { escrowId: 'escrow-1', role: 'buyer', participantId: 'buyer-1', pubkey: BUYER_PUBKEY, capabilityProfile: null },
    })
    expect(mockGetDepositAddress).not.toHaveBeenCalled()
    expect(mockEscrowUpdate).not.toHaveBeenCalled()
    expect(result.buyerKeySubmitted).toBe(true)
    expect(result.sellerKeySubmitted).toBe(false)
  })

  it('derives and persists the real address once both buyer and seller keys have arrived', async () => {
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', tradeId: 'trade-1', type: 'MULTISIG', multisigAddr: null })
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' })
    // Missão 11 Fase 9.1.1 — fail-closed: both keys must carry a
    // compatible capabilityProfile or the commit gate below rejects
    // before ever reaching getDepositAddress().
    mockParticipantKeyFindMany.mockResolvedValue([
      { escrowId: 'escrow-1', role: 'buyer', participantId: 'buyer-1', pubkey: BUYER_PUBKEY, capabilityProfile: MULTISIG_CAPABILITY_PROFILE_V1 },
      { escrowId: 'escrow-1', role: 'seller', participantId: 'seller-1', pubkey: SELLER_PUBKEY, capabilityProfile: MULTISIG_CAPABILITY_PROFILE_V1 },
    ])
    // Missão 11 Fase 5.2 — getDepositAddress() now returns
    // { address, arbiterPubkeyHex, arbiterId }, not a bare string.
    mockGetDepositAddress.mockResolvedValue({
      address: 'tb1qexampleaddressxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      arbiterPubkeyHex: 'ARBITER_PUBKEY_HEX_FIXTURE',
      arbiterId: 'arb-1',
    })
    mockEscrowUpdate.mockResolvedValue({ id: 'escrow-1', multisigAddr: 'tb1qexampleaddressxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' })

    const result = await escrowService.submitParticipantKey('escrow-1', 'seller-1', SELLER_PUBKEY)

    expect(mockGetDepositAddress).toHaveBeenCalledWith('trade-1', BUYER_PUBKEY, SELLER_PUBKEY)
    expect(mockEscrowUpdate).toHaveBeenCalledWith({
      where: { id: 'escrow-1' },
      data: { multisigAddr: 'tb1qexampleaddressxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
    })
    expect(result.escrow.multisigAddr).toBe('tb1qexampleaddressxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')

    // Fase 5.2 §2/§3 — the escrow-specific arbiter commitment is persisted
    // via create() (write-once), using EXACTLY what the provider returned.
    expect(mockParticipantKeyCreate).toHaveBeenCalledWith({
      data: { escrowId: 'escrow-1', role: 'arbiter', participantId: 'arb-1', pubkey: 'ARBITER_PUBKEY_HEX_FIXTURE' },
    })
  })

  it('does NOT attempt to persist an arbiter commitment when the provider does not return one (LIGHTNING_HODL/SAFE_GUARD_EVM today)', async () => {
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', tradeId: 'trade-1', type: 'MULTISIG', multisigAddr: null })
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' })
    mockParticipantKeyFindMany.mockResolvedValue([
      { escrowId: 'escrow-1', role: 'buyer', participantId: 'buyer-1', pubkey: BUYER_PUBKEY, capabilityProfile: MULTISIG_CAPABILITY_PROFILE_V1 },
      { escrowId: 'escrow-1', role: 'seller', participantId: 'seller-1', pubkey: SELLER_PUBKEY, capabilityProfile: MULTISIG_CAPABILITY_PROFILE_V1 },
    ])
    mockGetDepositAddress.mockResolvedValue({ address: 'tb1qexampleaddressxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' })
    mockEscrowUpdate.mockResolvedValue({ id: 'escrow-1', multisigAddr: 'tb1qexampleaddressxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' })

    await escrowService.submitParticipantKey('escrow-1', 'seller-1', SELLER_PUBKEY)

    expect(mockParticipantKeyCreate).not.toHaveBeenCalled()
  })

  it('does not re-derive an address that already exists (idempotent re-submission)', async () => {
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', tradeId: 'trade-1', type: 'MULTISIG', multisigAddr: 'tb1qalreadyset' })
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' })
    mockParticipantKeyFindMany.mockResolvedValue([
      { escrowId: 'escrow-1', role: 'buyer', participantId: 'buyer-1', pubkey: BUYER_PUBKEY },
      { escrowId: 'escrow-1', role: 'seller', participantId: 'seller-1', pubkey: SELLER_PUBKEY },
    ])

    await escrowService.submitParticipantKey('escrow-1', 'buyer-1', BUYER_PUBKEY)

    expect(mockGetDepositAddress).not.toHaveBeenCalled()
    expect(mockEscrowUpdate).not.toHaveBeenCalled()
  })

  it('rejects a submission from someone who is not the trade\'s buyer or seller', async () => {
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', tradeId: 'trade-1', type: 'MULTISIG', multisigAddr: null })
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' })

    await expect(escrowService.submitParticipantKey('escrow-1', 'not-a-party', BUYER_PUBKEY)).rejects.toThrow(
      'is not a counterparty (buyer or seller)'
    )
    expect(mockParticipantKeyUpsert).not.toHaveBeenCalled()
  })

  it('rejects a malformed pubkey before ever touching the database', async () => {
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', tradeId: 'trade-1', type: 'MULTISIG', multisigAddr: null })
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' })

    await expect(escrowService.submitParticipantKey('escrow-1', 'buyer-1', 'not-a-real-pubkey')).rejects.toThrow(
      'must be a 33-byte compressed secp256k1 public key'
    )
    expect(mockParticipantKeyUpsert).not.toHaveBeenCalled()
  })

  it('rejects submission for an escrow type that does not use client-submitted keys', async () => {
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', tradeId: 'trade-1', type: 'WDK_USDT_EVM', multisigAddr: null })

    await expect(escrowService.submitParticipantKey('escrow-1', 'buyer-1', BUYER_PUBKEY)).rejects.toThrow(
      'does not use client-submitted keys'
    )
    expect(mockTradeFindUnique).not.toHaveBeenCalled()
  })

  // Missão 11 Fase 9.1 §4/§5 — capability-profile declaration.
  it('persists a declared, recognized capability profile', async () => {
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', tradeId: 'trade-1', type: 'MULTISIG', multisigAddr: null })
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' })
    mockParticipantKeyFindMany.mockResolvedValue([{ escrowId: 'escrow-1', role: 'buyer', participantId: 'buyer-1', pubkey: BUYER_PUBKEY, capabilityProfile: MULTISIG_CAPABILITY_PROFILE_V1 }])

    await escrowService.submitParticipantKey('escrow-1', 'buyer-1', BUYER_PUBKEY, MULTISIG_CAPABILITY_PROFILE_V1)

    expect(mockParticipantKeyUpsert).toHaveBeenCalledWith({
      where: { escrowId_role: { escrowId: 'escrow-1', role: 'buyer' } },
      update: { participantId: 'buyer-1', pubkey: BUYER_PUBKEY, capabilityProfile: MULTISIG_CAPABILITY_PROFILE_V1 },
      create: { escrowId: 'escrow-1', role: 'buyer', participantId: 'buyer-1', pubkey: BUYER_PUBKEY, capabilityProfile: MULTISIG_CAPABILITY_PROFILE_V1 },
    })
  })

  it('rejects an unrecognized capability profile before ever touching the database', async () => {
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', tradeId: 'trade-1', type: 'MULTISIG', multisigAddr: null })
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' })

    await expect(escrowService.submitParticipantKey('escrow-1', 'buyer-1', BUYER_PUBKEY, 'not-a-real-profile')).rejects.toThrow(
      "Unrecognized capability profile 'not-a-real-profile'"
    )
    expect(mockParticipantKeyUpsert).not.toHaveBeenCalled()
  })

  it('two participants both declaring the correct, matching profile still derives the address normally', async () => {
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', tradeId: 'trade-1', type: 'MULTISIG', multisigAddr: null })
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' })
    mockParticipantKeyFindMany.mockResolvedValue([
      { escrowId: 'escrow-1', role: 'buyer', participantId: 'buyer-1', pubkey: BUYER_PUBKEY, capabilityProfile: MULTISIG_CAPABILITY_PROFILE_V1 },
      { escrowId: 'escrow-1', role: 'seller', participantId: 'seller-1', pubkey: SELLER_PUBKEY, capabilityProfile: MULTISIG_CAPABILITY_PROFILE_V1 },
    ])
    mockGetDepositAddress.mockResolvedValue({ address: 'tb1qexampleaddressxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' })
    mockEscrowUpdate.mockResolvedValue({ id: 'escrow-1', multisigAddr: 'tb1qexampleaddressxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' })

    const result = await escrowService.submitParticipantKey('escrow-1', 'seller-1', SELLER_PUBKEY, MULTISIG_CAPABILITY_PROFILE_V1)

    expect(mockGetDepositAddress).toHaveBeenCalled()
    expect(result.escrow.multisigAddr).toBe('tb1qexampleaddressxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')
  })

  // Missão 11 Fase 9.1.1 — CTO decision: fail-closed, no grandfathering.
  // The four adversarial cases the CTO's own closure mandate names
  // explicitly (omitted buyer, omitted seller, unknown, both valid — the
  // "unknown" and "both valid" cases are covered by the two tests above)
  // plus the required brand-neutrality proof.
  describe('fail-closed commit gate (Missão 11 Fase 9.1.1 — no grandfathering)', () => {
    it('blocks the commit when the buyer omitted their capability profile, even though the seller declared one', async () => {
      mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', tradeId: 'trade-1', type: 'MULTISIG', multisigAddr: null })
      mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' })
      mockParticipantKeyFindMany.mockResolvedValue([
        { escrowId: 'escrow-1', role: 'buyer', participantId: 'buyer-1', pubkey: BUYER_PUBKEY, capabilityProfile: null },
        { escrowId: 'escrow-1', role: 'seller', participantId: 'seller-1', pubkey: SELLER_PUBKEY, capabilityProfile: MULTISIG_CAPABILITY_PROFILE_V1 },
      ])

      await expect(escrowService.submitParticipantKey('escrow-1', 'seller-1', SELLER_PUBKEY, MULTISIG_CAPABILITY_PROFILE_V1)).rejects.toThrow(
        'the buyer declared no capability profile at all'
      )
      expect(mockGetDepositAddress).not.toHaveBeenCalled()
      expect(mockEscrowUpdate).not.toHaveBeenCalled()
    })

    it('blocks the commit when the seller omitted their capability profile, even though the buyer declared one', async () => {
      mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', tradeId: 'trade-1', type: 'MULTISIG', multisigAddr: null })
      mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' })
      mockParticipantKeyFindMany.mockResolvedValue([
        { escrowId: 'escrow-1', role: 'buyer', participantId: 'buyer-1', pubkey: BUYER_PUBKEY, capabilityProfile: MULTISIG_CAPABILITY_PROFILE_V1 },
        { escrowId: 'escrow-1', role: 'seller', participantId: 'seller-1', pubkey: SELLER_PUBKEY, capabilityProfile: null },
      ])

      await expect(escrowService.submitParticipantKey('escrow-1', 'buyer-1', BUYER_PUBKEY, MULTISIG_CAPABILITY_PROFILE_V1)).rejects.toThrow(
        'the seller declared no capability profile at all'
      )
      expect(mockGetDepositAddress).not.toHaveBeenCalled()
      expect(mockEscrowUpdate).not.toHaveBeenCalled()
    })

    it('blocks the commit when BOTH omitted a capability profile — the pre-Fase-9.1.1 grandfathered case is no longer accepted', async () => {
      mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', tradeId: 'trade-1', type: 'MULTISIG', multisigAddr: null })
      mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' })
      mockParticipantKeyFindMany.mockResolvedValue([
        { escrowId: 'escrow-1', role: 'buyer', participantId: 'buyer-1', pubkey: BUYER_PUBKEY, capabilityProfile: null },
        { escrowId: 'escrow-1', role: 'seller', participantId: 'seller-1', pubkey: SELLER_PUBKEY, capabilityProfile: null },
      ])

      await expect(escrowService.submitParticipantKey('escrow-1', 'seller-1', SELLER_PUBKEY)).rejects.toThrow(
        'the buyer declared no capability profile at all'
      )
      expect(mockGetDepositAddress).not.toHaveBeenCalled()
    })

    // Required brand-neutrality proof: a participantId that looks like an
    // official Sails/Satsails identity gets exactly the same rejection as
    // any other — the commit-gate function itself takes no identity
    // input (capabilityProfile.test.ts's own unit proof), and this test
    // proves that holds true all the way through the real service call,
    // not just in isolation.
    it('a Satsails-branded participantId receives NO bypass — identical rejection as any other caller', async () => {
      mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', tradeId: 'trade-1', type: 'MULTISIG', multisigAddr: null })
      mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'satsails-official-wallet', sellerId: 'seller-1' })
      mockParticipantKeyFindMany.mockResolvedValue([
        { escrowId: 'escrow-1', role: 'buyer', participantId: 'satsails-official-wallet', pubkey: BUYER_PUBKEY, capabilityProfile: null },
        { escrowId: 'escrow-1', role: 'seller', participantId: 'seller-1', pubkey: SELLER_PUBKEY, capabilityProfile: MULTISIG_CAPABILITY_PROFILE_V1 },
      ])

      await expect(
        escrowService.submitParticipantKey('escrow-1', 'seller-1', SELLER_PUBKEY, MULTISIG_CAPABILITY_PROFILE_V1)
      ).rejects.toThrow('the buyer declared no capability profile at all')
      expect(mockGetDepositAddress).not.toHaveBeenCalled()
    })
  })

  it('skips address derivation when MOCK_ESCROW is on, even once both keys arrive', async () => {
    mockEscrowFeatureFlag = true
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', tradeId: 'trade-1', type: 'MULTISIG', multisigAddr: null })
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' })
    mockParticipantKeyFindMany.mockResolvedValue([
      { escrowId: 'escrow-1', role: 'buyer', participantId: 'buyer-1', pubkey: BUYER_PUBKEY },
      { escrowId: 'escrow-1', role: 'seller', participantId: 'seller-1', pubkey: SELLER_PUBKEY },
    ])

    await escrowService.submitParticipantKey('escrow-1', 'seller-1', SELLER_PUBKEY)

    expect(mockGetDepositAddress).not.toHaveBeenCalled()
  })
})

describe('getProvider() — no more silent MOCK fallback for an unregistered real type', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockEscrowFeatureFlag = false
  })

  it('throws a clear error for LIQUID_COVENANT instead of silently mock-processing it', async () => {
    mockEscrowFindUnique.mockResolvedValue({
      id: 'escrow-4', tradeId: 'trade-4', type: 'LIQUID_COVENANT', status: 'CREATED', timelockHours: 24,
    })
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-4', buyerId: 'buyer-1', sellerId: 'seller-1' })

    await expect(escrowService.lockFunds('escrow-4', 'seller-1')).rejects.toThrow(
      "No SettlementProvider registered for escrow type 'LIQUID_COVENANT'"
    )
  })

  it('LIGHTNING_HODL is registered (real since the Arkade build) and throws its own clear config error, not a fallback', async () => {
    mockEscrowFindUnique.mockResolvedValue({
      id: 'escrow-5', tradeId: 'trade-5', type: 'LIGHTNING_HODL', status: 'CREATED', timelockHours: 24,
    })
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-5', buyerId: 'buyer-1', sellerId: 'seller-1' })
    // Both pubkeys present, so the flow reaches this file's own config
    // mock (arkade.seed: '') rather than stopping earlier at the
    // missing-pubkey guard — this test is specifically about the
    // ARKADE_SEED gate, not the pubkey one.
    mockParticipantKeyFindMany.mockResolvedValue([
      { escrowId: 'escrow-5', role: 'buyer', participantId: 'buyer-1', pubkey: BUYER_PUBKEY },
      { escrowId: 'escrow-5', role: 'seller', participantId: 'seller-1', pubkey: SELLER_PUBKEY },
    ])

    await expect(escrowService.lockFunds('escrow-5', 'seller-1')).rejects.toThrow('ARKADE_SEED')
  })
})

// Phase 2 (2026-07-27) — the signature-collection orchestration:
// initiateRelease()/initiateRefund() build+persist an unsigned PSBT
// without transitioning the escrow; submitTransactionSignature() collects
// each required signer's own signed copy and only finalizes (real
// provider call + status transition) once every required signer has
// submitted. multisig.provider.ts's own real PSBT/combine logic is
// covered by tests/multisigProvider.test.ts — this file only exercises
// escrow.service.ts's orchestration around it.
describe('initiateRelease()/initiateRefund() — Phase 2 signature-collection round setup', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockEscrowFeatureFlag = false
    mockEscrowUpdateMany.mockResolvedValue({ count: 1 })
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' })
    mockParticipantKeyFindMany.mockResolvedValue([
      { escrowId: 'escrow-1', role: 'buyer', participantId: 'buyer-1', pubkey: BUYER_PUBKEY },
      { escrowId: 'escrow-1', role: 'seller', participantId: 'seller-1', pubkey: SELLER_PUBKEY },
    ])
    mockPendingTxFindUnique.mockResolvedValue(null)
    mockEscrowFundingEvidenceFindMany.mockResolvedValue([])
  })

  it('initiateRelease builds an unsigned PSBT via the provider and persists it, without transitioning the escrow', async () => {
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', tradeId: 'trade-1', type: 'MULTISIG', status: 'PAYMENT_PENDING' })
    mockBuildUnsignedRelease.mockResolvedValue({ psbtBase64: 'unsigned-psbt', requiredSigners: ['buyer-1', 'seller-1'] })
    mockPendingTxCreate.mockResolvedValue({ id: 'ptx-1', escrowId: 'escrow-1', kind: 'release', requiredSigners: ['buyer-1', 'seller-1'] })

    const result = await escrowService.initiateRelease('escrow-1', 'tb1qexample', 'seller-1')

    expect(mockBuildUnsignedRelease).toHaveBeenCalledWith(
      expect.objectContaining({ buyerId: 'buyer-1', sellerId: 'seller-1', buyerPubkey: BUYER_PUBKEY, sellerPubkey: SELLER_PUBKEY }),
      'tb1qexample'
    )
    expect(mockPendingTxCreate).toHaveBeenCalledWith({
      data: { escrowId: 'escrow-1', kind: 'release', toAddress: 'tb1qexample', unsignedPsbtBase64: 'unsigned-psbt', requiredSigners: ['buyer-1', 'seller-1'], triggeredBy: 'seller-1' },
    })
    expect(mockEscrowUpdateMany).not.toHaveBeenCalled()
    expect(result.id).toBe('ptx-1')
  })

  it('initiateRelease rejects a caller who is neither the seller nor the assigned arbiter', async () => {
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', tradeId: 'trade-1', type: 'MULTISIG', status: 'PAYMENT_PENDING' })

    await expect(escrowService.initiateRelease('escrow-1', 'tb1qexample', 'buyer-1')).rejects.toThrow(
      'is neither the seller'
    )
    expect(mockBuildUnsignedRelease).not.toHaveBeenCalled()
  })

  it('initiateRelease rejects when a signing round is already in flight for this escrow', async () => {
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', tradeId: 'trade-1', type: 'MULTISIG', status: 'PAYMENT_PENDING' })
    mockPendingTxFindUnique.mockResolvedValue({ id: 'ptx-existing', kind: 'release' })

    await expect(escrowService.initiateRelease('escrow-1', 'tb1qexample', 'seller-1')).rejects.toThrow(
      'already has a pending release transaction'
    )
    expect(mockBuildUnsignedRelease).not.toHaveBeenCalled()
  })

  it('initiateRelease rejects an escrow type with no registered SignatureCollectionProvider', async () => {
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-2', tradeId: 'trade-2', type: 'MOCK', status: 'PAYMENT_PENDING' })

    await expect(escrowService.initiateRelease('escrow-2', 'tb1qexample', 'seller-1')).rejects.toThrow(
      'does not use the client-signature-collection release flow'
    )
  })

  it('initiateRefund builds an unsigned refund PSBT and persists the provider-returned toAddress', async () => {
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', tradeId: 'trade-1', type: 'MULTISIG', status: 'FUNDS_LOCKED' })
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' })
    mockBuildUnsignedRefund.mockResolvedValue({ psbtBase64: 'unsigned-refund-psbt', requiredSigners: ['seller-1', 'buyer-1'], toAddress: 'tb1qsellerrefund' })
    mockPendingTxCreate.mockResolvedValue({ id: 'ptx-2', escrowId: 'escrow-1', kind: 'refund', requiredSigners: ['seller-1', 'buyer-1'] })

    // M8-RF (Destination Consistency) — an explicit toAddress bypasses
    // the registered-PayoutAddress lookup (resolvePayoutAddress()'s own
    // "explicit wins" rule, same as initiateRelease() already relies on
    // in the tests above) and is what the Provider is now called with —
    // proving the destination is TRANSLATED, not invented, by the
    // orchestration layer regardless of what any individual provider's
    // own (here mocked) implementation returns.
    const result = await escrowService.initiateRefund('escrow-1', 'seller-1', 'tb1qauthorizedseller')

    expect(mockBuildUnsignedRefund).toHaveBeenCalledWith(expect.anything(), 'tb1qauthorizedseller')
    expect(mockPendingTxCreate).toHaveBeenCalledWith({
      data: { escrowId: 'escrow-1', kind: 'refund', toAddress: 'tb1qsellerrefund', unsignedPsbtBase64: 'unsigned-refund-psbt', requiredSigners: ['seller-1', 'buyer-1'], triggeredBy: 'seller-1' },
    })
    expect(result.id).toBe('ptx-2')
  })

  it('M8-RF: initiateRefund fails closed when no explicit destination is supplied and the seller has no registered PayoutAddress — never falls back to a derived one', async () => {
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', tradeId: 'trade-1', type: 'MULTISIG', status: 'FUNDS_LOCKED' })
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' })
    mockPayoutAddressFindUnique.mockResolvedValue(null)

    await expect(escrowService.initiateRefund('escrow-1', 'seller-1')).rejects.toThrow(/No payout address/)
    expect(mockBuildUnsignedRefund).not.toHaveBeenCalled()
  })
})

// RFC-021 D9 (2026-08-02) — the client-signature-collection equivalent of
// escrowReleaseControls.test.ts's own splitFunds() coverage. SPLIT only
// ever reaches an escrow via a dispute ruling (VALID_TRANSITIONS), so
// status is 'DISPUTED' throughout, unlike initiateRelease/initiateRefund's
// own PAYMENT_PENDING fixtures above.
describe('initiateSplit() — Phase 2 signature-collection round setup for SPLIT', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockEscrowFeatureFlag = false
    mockDisputeFindFirst.mockResolvedValue({ id: 'dispute-1', tradeId: 'trade-1', arbiterId: 'arbiter-1' })
    mockEscrowUpdateMany.mockResolvedValue({ count: 1 })
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' })
    mockParticipantKeyFindMany.mockResolvedValue([
      { escrowId: 'escrow-1', role: 'buyer', participantId: 'buyer-1', pubkey: BUYER_PUBKEY },
      { escrowId: 'escrow-1', role: 'seller', participantId: 'seller-1', pubkey: SELLER_PUBKEY },
    ])
    mockPendingTxFindUnique.mockResolvedValue(null)
    mockEscrowFundingEvidenceFindMany.mockResolvedValue([])
  })

  it('builds an unsigned split PSBT via the provider and persists both payout addresses', async () => {
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', tradeId: 'trade-1', type: 'MULTISIG', status: 'DISPUTED' })
    // Real MultisigProvider.buildUnsignedSplit() only requires ONE more
    // signer alongside the arbiter's pre-embedded one (still a 2-of-3
    // script — see that method's own comment); mocked here as buyer-1,
    // matching its real default pairing.
    mockBuildUnsignedSplit.mockResolvedValue({ psbtBase64: 'unsigned-split-psbt', requiredSigners: ['buyer-1'] })
    mockPendingTxCreate.mockResolvedValue({ id: 'ptx-3', escrowId: 'escrow-1', kind: 'split', requiredSigners: ['buyer-1'] })

    const result = await escrowService.initiateSplit('escrow-1', 'tb1qbuyer', 'tb1qseller', 6000, 'arbiter-1')

    expect(mockBuildUnsignedSplit).toHaveBeenCalledWith(
      expect.objectContaining({ buyerId: 'buyer-1', sellerId: 'seller-1', buyerPubkey: BUYER_PUBKEY, sellerPubkey: SELLER_PUBKEY }),
      'tb1qbuyer',
      'tb1qseller',
      6000
    )
    expect(mockPendingTxCreate).toHaveBeenCalledWith({
      data: {
        escrowId: 'escrow-1', kind: 'split', toAddress: 'tb1qbuyer', toAddressSecondary: 'tb1qseller',
        unsignedPsbtBase64: 'unsigned-split-psbt', requiredSigners: ['buyer-1'], triggeredBy: 'arbiter-1',
        // Missão 11 Fase 3 — buyerBps is now persisted on the pending
        // transaction so submitTransactionSignature() can later compute
        // the seller's FeeObligation basisAmount for a SPLIT settled via
        // this path (it wasn't stored anywhere before this pass).
        buyerBps: 6000,
        // ADR-005 / #218 — ruling-generation provenance snapshotted
        // because this escrow is DISPUTED. mockDisputeFindFirst's own
        // fixture above only sets {id, tradeId, arbiterId} — the other
        // generation fields are genuinely undefined on that row, exactly
        // as a real Dispute predating this ADR would report them.
        disputeId: 'dispute-1',
        rulingAppealRound: undefined,
        rulingArbiterId: 'arbiter-1',
        rulingOutcome: undefined,
        rulingAuthoritySignature: undefined,
        rulingAuthorityIssuedAt: undefined,
      },
    })
    expect(result.id).toBe('ptx-3')
  })

  it('rejects buyerBps of 0 or 10000 — those are RELEASE/REFUND in disguise, not a real split', async () => {
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', tradeId: 'trade-1', type: 'MULTISIG', status: 'DISPUTED' })
    await expect(escrowService.initiateSplit('escrow-1', 'tb1qbuyer', 'tb1qseller', 0, 'seller-1')).rejects.toThrow(
      /buyerBps must be strictly between 0 and 10000/
    )
    await expect(escrowService.initiateSplit('escrow-1', 'tb1qbuyer', 'tb1qseller', 10000, 'seller-1')).rejects.toThrow(
      /buyerBps must be strictly between 0 and 10000/
    )
    expect(mockBuildUnsignedSplit).not.toHaveBeenCalled()
  })

  it('rejects an escrow type with no registered SignatureCollectionProvider', async () => {
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-2', tradeId: 'trade-2', type: 'MOCK', status: 'DISPUTED' })
    await expect(escrowService.initiateSplit('escrow-2', 'tb1qbuyer', 'tb1qseller', 6000, 'seller-1')).rejects.toThrow(
      'does not use the client-signature-collection split flow'
    )
  })
})

describe('submitTransactionSignature() — collects signatures, finalizes only once every required signer has submitted', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockEscrowFeatureFlag = false
    mockEscrowUpdateMany.mockResolvedValue({ count: 1 })
    mockPendingTxDelete.mockResolvedValue({})
    // ADR-005 / #218 — jest.clearAllMocks() does not reset a persistent
    // .mockResolvedValue() set by an earlier describe block (the disputed
    // SPLIT test above leaves mockDisputeFindFirst resolving a real Dispute
    // row). Every test in THIS block exercises a cooperative pending
    // operation with no recorded ruling generation, so it must observe a
    // never-disputed escrow (null) for the Economic Disposition gate's own
    // ambiguous-legacy-row check to correctly no-op, not fail closed.
    mockDisputeFindFirst.mockResolvedValue(null)
  })

  it('records a partial submission without finalizing when not every required signer has submitted yet', async () => {
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', tradeId: 'trade-1', type: 'MULTISIG', status: 'PAYMENT_PENDING' })
    mockPendingTxFindUnique.mockResolvedValue({
      id: 'ptx-1', escrowId: 'escrow-1', kind: 'release', requiredSigners: ['buyer-1', 'seller-1'],
      unsignedPsbtBase64: 'unsigned-psbt', triggeredBy: 'seller-1',
    })
    mockTxSignatureFindMany.mockResolvedValue([{ participantId: 'buyer-1', signedPsbtBase64: 'buyer-signed' }])

    const result = await escrowService.submitTransactionSignature('escrow-1', 'buyer-1', 'buyer-signed')

    expect(mockTxSignatureUpsert).toHaveBeenCalledWith({
      where: { pendingTxId_participantId: { pendingTxId: 'ptx-1', participantId: 'buyer-1' } },
      update: { signedPsbtBase64: 'buyer-signed' },
      create: { pendingTxId: 'ptx-1', participantId: 'buyer-1', signedPsbtBase64: 'buyer-signed' },
    })
    expect(result.complete).toBe(false)
    expect(mockFinalizeRelease).not.toHaveBeenCalled()
    expect(mockEscrowUpdateMany).not.toHaveBeenCalled()
  })

  it('finalizes for real once every required signer has submitted — release path', async () => {
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', tradeId: 'trade-1', type: 'MULTISIG', status: 'PAYMENT_PENDING' })
    mockPendingTxFindUnique.mockResolvedValue({
      id: 'ptx-1', escrowId: 'escrow-1', kind: 'release', requiredSigners: ['buyer-1', 'seller-1'],
      unsignedPsbtBase64: 'unsigned-psbt', triggeredBy: 'seller-1',
    })
    mockTxSignatureFindMany.mockResolvedValue([
      { participantId: 'buyer-1', signedPsbtBase64: 'buyer-signed' },
      { participantId: 'seller-1', signedPsbtBase64: 'seller-signed' },
    ])
    mockFinalizeRelease.mockResolvedValue({ txId: 'real-release-txid' })
    mockEscrowUpdate.mockResolvedValue({ id: 'escrow-1', status: 'COMPLETED', txReleaseId: 'real-release-txid' })

    const result = await escrowService.submitTransactionSignature('escrow-1', 'seller-1', 'seller-signed')

    expect(mockFinalizeRelease).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'escrow-1' }),
      'unsigned-psbt',
      ['buyer-signed', 'seller-signed']
    )
    expect(mockEscrowUpdateMany).toHaveBeenCalledWith({ where: { id: 'escrow-1', status: 'PAYMENT_PENDING' }, data: { status: 'COMPLETED' } })
    expect(mockEscrowUpdate).toHaveBeenCalledWith({ where: { id: 'escrow-1' }, data: { txReleaseId: 'real-release-txid', releasedAt: expect.any(Date) } })
    expect(mockPendingTxDelete).toHaveBeenCalledWith({ where: { id: 'ptx-1' } })
    expect(result.complete).toBe(true)
  })

  it('finalizes for real once every required signer has submitted — refund path', async () => {
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', tradeId: 'trade-1', type: 'MULTISIG', status: 'FUNDS_LOCKED' })
    mockPendingTxFindUnique.mockResolvedValue({
      id: 'ptx-2', escrowId: 'escrow-1', kind: 'refund', requiredSigners: ['seller-1'],
      unsignedPsbtBase64: 'unsigned-refund-psbt', triggeredBy: 'seller-1',
    })
    mockTxSignatureFindMany.mockResolvedValue([{ participantId: 'seller-1', signedPsbtBase64: 'seller-signed' }])
    mockFinalizeRefund.mockResolvedValue({ txId: 'real-refund-txid' })
    mockEscrowUpdate.mockResolvedValue({ id: 'escrow-1', status: 'REFUNDED', txReleaseId: 'real-refund-txid' })

    const result = await escrowService.submitTransactionSignature('escrow-1', 'seller-1', 'seller-signed')

    expect(mockFinalizeRefund).toHaveBeenCalledWith(expect.objectContaining({ id: 'escrow-1' }), 'unsigned-refund-psbt', ['seller-signed'])
    expect(mockEscrowUpdateMany).toHaveBeenCalledWith({ where: { id: 'escrow-1', status: 'FUNDS_LOCKED' }, data: { status: 'REFUNDED' } })
    expect(mockEscrowUpdate).toHaveBeenCalledWith({ where: { id: 'escrow-1' }, data: { txReleaseId: 'real-refund-txid' } })
    expect(result.complete).toBe(true)
  })

  it('finalizes for real once every required signer has submitted — split path (RFC-021 D9)', async () => {
    // Real MultisigProvider.buildUnsignedSplit() requires only ONE more
    // signer alongside the arbiter's pre-embedded one (see that method's
    // own comment) — mocked here as buyer-1, its real default pairing.
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', tradeId: 'trade-1', type: 'MULTISIG', status: 'DISPUTED' })
    mockPendingTxFindUnique.mockResolvedValue({
      id: 'ptx-3', escrowId: 'escrow-1', kind: 'split', requiredSigners: ['buyer-1'],
      unsignedPsbtBase64: 'unsigned-split-psbt', triggeredBy: 'arbiter-1',
    })
    mockTxSignatureFindMany.mockResolvedValue([
      { participantId: 'buyer-1', signedPsbtBase64: 'buyer-signed' },
    ])
    mockFinalizeSplit.mockResolvedValue({ txId: 'real-split-txid' })
    mockEscrowUpdate.mockResolvedValue({ id: 'escrow-1', status: 'SPLIT', txReleaseId: 'real-split-txid' })

    const result = await escrowService.submitTransactionSignature('escrow-1', 'buyer-1', 'buyer-signed')

    expect(mockFinalizeSplit).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'escrow-1' }),
      'unsigned-split-psbt',
      ['buyer-signed']
    )
    expect(mockEscrowUpdateMany).toHaveBeenCalledWith({ where: { id: 'escrow-1', status: 'DISPUTED' }, data: { status: 'SPLIT' } })
    expect(mockEscrowUpdate).toHaveBeenCalledWith({ where: { id: 'escrow-1' }, data: { txReleaseId: 'real-split-txid', releasedAt: expect.any(Date) } })
    expect(mockPendingTxDelete).toHaveBeenCalledWith({ where: { id: 'ptx-3' } })
    expect(result.complete).toBe(true)
  })

  it('rejects a signature from someone who is not a required signer for this pending transaction', async () => {
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', tradeId: 'trade-1', type: 'MULTISIG', status: 'PAYMENT_PENDING' })
    mockPendingTxFindUnique.mockResolvedValue({
      id: 'ptx-1', escrowId: 'escrow-1', kind: 'release', requiredSigners: ['buyer-1', 'seller-1'],
      unsignedPsbtBase64: 'unsigned-psbt', triggeredBy: 'seller-1',
    })

    await expect(escrowService.submitTransactionSignature('escrow-1', 'not-a-party', 'sig')).rejects.toThrow(
      'is not one of the required signers'
    )
    expect(mockTxSignatureUpsert).not.toHaveBeenCalled()
  })

  it('rejects when no signing round is in flight for this escrow', async () => {
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', tradeId: 'trade-1', type: 'MULTISIG', status: 'PAYMENT_PENDING' })
    mockPendingTxFindUnique.mockResolvedValue(null)

    await expect(escrowService.submitTransactionSignature('escrow-1', 'buyer-1', 'sig')).rejects.toThrow(
      'has no pending transaction awaiting signatures'
    )
  })
})

// Issue #242 — CTO corrective mission, follow-up to #229/#230. The #220
// audit found SIGNATURE_COLLECTION_PROVIDERS is a SECOND provider
// registry, consumed directly by initiateSignatureCollectionCore()
// (initiateRelease/Refund/Split, above) and submitTransactionSignature()
// (above), neither of which ever went through getSettlementProvider() /
// assertDeploymentEligible() — safe today only because MOCK happens to
// have no entry in that registry, not because of any actual check.
// getSignatureCollectionProvider() (escrow-providers.ts) is the new
// canonical accessor both call sites now use. These tests use MOCK —
// the one REAL, already-frozen PRODUCTION_INELIGIBLE_TYPES member — as
// the "would-be ineligible signature-collection provider" test subject,
// per the mission's own instruction not to permanently add a real
// signature-collection provider (MULTISIG/LIGHTNING_HODL/SAFE_GUARD_EVM)
// to that set just to write a test. MOCK is never registered in
// SIGNATURE_COLLECTION_PROVIDERS, so calling it against these functions
// is a deliberately synthetic scenario ("cannot happen in practice",
// per submitTransactionSignature()'s own comment) — but exercising it
// still proves the real thing: assertDeploymentEligible() runs, and
// throws its OWN distinct message, before the "not a signature-
// collection type" registration check ever gets a chance to run.
describe('getSignatureCollectionProvider() — production deployment-eligibility gate for the signature-collection registry (Issue #242)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockEscrowFeatureFlag = false
    mockEscrowUpdateMany.mockResolvedValue({ count: 1 })
    mockDisputeFindFirst.mockResolvedValue(null)
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1' })
  })

  describe('generic policy behavior — structurally driven by PRODUCTION_INELIGIBLE_TYPES, not hardcoded to any literal type', () => {
    it('getSignatureCollectionProvider() calls assertDeploymentEligible() unconditionally, before ever touching SIGNATURE_COLLECTION_PROVIDERS', () => {
      // Same regression-guard technique #229 R3 used for
      // getSettlementProvider(): black-box behavior alone cannot
      // distinguish "checked generically" from "checked only for the
      // literal string the one real ineligible type happens to be
      // today," since PRODUCTION_INELIGIBLE_TYPES has exactly one real
      // member. This inspects the compiled function's own source to
      // confirm the eligibility call is positioned before the registry
      // is ever indexed — not nested inside a type-specific branch.
      const source = getSignatureCollectionProvider.toString()
      const eligibilityCallIndex = source.indexOf('assertDeploymentEligible')
      const registryAccessIndex = source.indexOf('SIGNATURE_COLLECTION_PROVIDERS')
      expect(eligibilityCallIndex).toBeGreaterThan(-1)
      expect(registryAccessIndex).toBeGreaterThan(-1)
      expect(eligibilityCallIndex).toBeLessThan(registryAccessIndex)
    })

    it('assertDeploymentEligible() itself (reused unmodified from #229/#230) remains Set-membership-driven, not a hardcoded MOCK comparison — re-proven here for this registry\'s own accessor', () => {
      isProductionFlag = true
      expect(() => assertDeploymentEligible('MOCK')).toThrow(/not economically eligible in production/)
      expect(() => assertDeploymentEligible('HYPOTHETICAL_TYPE_NOT_IN_ANY_POLICY_SET')).not.toThrow()
    })
  })

  describe('normal production-eligible provider (MULTISIG) is unaffected', () => {
    it('getSignatureCollectionProvider("MULTISIG") resolves normally in production — isolated function-level proof, no real funds/network needed', () => {
      isProductionFlag = true
      const { multisigProvider } = jest.requireMock('../src/modules/open-settlement/multisig.provider') as any
      expect(getSignatureCollectionProvider('MULTISIG')).toBe(multisigProvider)
    })

    it('the full initiateRelease() flow for MULTISIG is unaffected in production — same behavior as outside production', async () => {
      isProductionFlag = true
      mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-ms-1', tradeId: 'trade-1', type: 'MULTISIG', status: 'PAYMENT_PENDING' })
      mockParticipantKeyFindMany.mockResolvedValue([
        { escrowId: 'escrow-ms-1', role: 'buyer', participantId: 'buyer-1', pubkey: BUYER_PUBKEY },
        { escrowId: 'escrow-ms-1', role: 'seller', participantId: 'seller-1', pubkey: SELLER_PUBKEY },
      ])
      mockPendingTxFindUnique.mockResolvedValue(null)
      mockEscrowFundingEvidenceFindMany.mockResolvedValue([])
      mockBuildUnsignedRelease.mockResolvedValueOnce({ psbtBase64: 'unsigned-psbt', requiredSigners: ['buyer-1', 'seller-1'] })
      mockPendingTxCreate.mockResolvedValueOnce({ id: 'ptx-ms-1', escrowId: 'escrow-ms-1', kind: 'release', requiredSigners: ['buyer-1', 'seller-1'] })

      const result = await escrowService.initiateRelease('escrow-ms-1', 'tb1qexample', 'seller-1')

      expect(mockBuildUnsignedRelease).toHaveBeenCalled()
      expect(result.id).toBe('ptx-ms-1')
    })
  })

  describe('initiation path (unsigned RELEASE/REFUND/SPLIT construction) rejects an ineligible type in production', () => {
    it('initiateRelease refuses before building/persisting any unsigned transaction — distinct eligibility message, not the ordinary "not a signature-collection type" one', async () => {
      isProductionFlag = true
      mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-ineligible-1', tradeId: 'trade-1', type: 'MOCK', status: 'PAYMENT_PENDING' })

      await expect(escrowService.initiateRelease('escrow-ineligible-1', 'tb1qexample', 'seller-1')).rejects.toThrow(
        /not economically eligible in production/
      )
      expect(mockBuildUnsignedRelease).not.toHaveBeenCalled()
      expect(mockPendingTxCreate).not.toHaveBeenCalled()
    })

    it('initiateRefund refuses before building/persisting any unsigned transaction', async () => {
      isProductionFlag = true
      mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-ineligible-2', tradeId: 'trade-1', type: 'MOCK', status: 'FUNDS_LOCKED' })

      await expect(escrowService.initiateRefund('escrow-ineligible-2', 'seller-1', 'tb1qexample')).rejects.toThrow(
        /not economically eligible in production/
      )
      expect(mockBuildUnsignedRefund).not.toHaveBeenCalled()
      expect(mockPendingTxCreate).not.toHaveBeenCalled()
    })

    it('initiateSplit refuses before building/persisting any unsigned transaction', async () => {
      isProductionFlag = true
      mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-ineligible-3', tradeId: 'trade-1', type: 'MOCK', status: 'DISPUTED' })
      mockDisputeFindFirst.mockResolvedValueOnce({ id: 'dispute-1', tradeId: 'trade-1', arbiterId: 'arbiter-1' })

      await expect(
        escrowService.initiateSplit('escrow-ineligible-3', 'tb1qbuyer', 'tb1qseller', 6000, 'arbiter-1')
      ).rejects.toThrow(/not economically eligible in production/)
      expect(mockBuildUnsignedSplit).not.toHaveBeenCalled()
      expect(mockPendingTxCreate).not.toHaveBeenCalled()
    })
  })

  describe('finalization path rejects a persisted pending transaction whose provider has since become deployment-ineligible', () => {
    it('submitTransactionSignature fails closed before combine/broadcast, even once every required signature has already arrived — no fallback to another provider, no silent completion', async () => {
      isProductionFlag = true
      mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-ineligible-4', tradeId: 'trade-1', type: 'MOCK', status: 'PAYMENT_PENDING' })
      mockPendingTxFindUnique.mockResolvedValue({
        id: 'ptx-ineligible', escrowId: 'escrow-ineligible-4', kind: 'release', requiredSigners: ['buyer-1', 'seller-1'],
        unsignedPsbtBase64: 'unsigned-psbt', triggeredBy: 'seller-1',
      })
      mockTxSignatureFindMany.mockResolvedValue([
        { participantId: 'buyer-1', signedPsbtBase64: 'buyer-signed' },
        { participantId: 'seller-1', signedPsbtBase64: 'seller-signed' },
      ])

      // The final signature's own bookkeeping upsert is not itself an
      // economic action — it is allowed to persist. Only what follows
      // (combine/broadcast/status-claim) must be refused.
      await expect(escrowService.submitTransactionSignature('escrow-ineligible-4', 'seller-1', 'seller-signed')).rejects.toThrow(
        /not economically eligible in production/
      )
      expect(mockTxSignatureUpsert).toHaveBeenCalled()

      // No economic side effect, and no fallback to any other provider's
      // finalize method or to a plain SettlementProvider.
      expect(mockFinalizeRelease).not.toHaveBeenCalled()
      expect(mockFinalizeRefund).not.toHaveBeenCalled()
      expect(mockFinalizeSplit).not.toHaveBeenCalled()
      expect(mockEscrowUpdateMany).not.toHaveBeenCalled()
      expect(mockEscrowUpdate).not.toHaveBeenCalled()
      expect(mockPendingTxDelete).not.toHaveBeenCalled()
    })
  })

  describe('recovery/resume cannot bypass the gate', () => {
    it('dispute-dispatch-recovery.ts (automated C4 recovery) has no direct access to SIGNATURE_COLLECTION_PROVIDERS — its only path to signature-collection dispatch is escrowService.initiateRelease/Refund/Split, already proven to refuse above', () => {
      // dispute-dispatch-recovery.ts has no dedicated test file of its
      // own (confirmed absent from tests/ before this mission) — building
      // a full mock harness for its dispute-query logic just to re-prove
      // a call chain already proven above would be scope creep for a
      // bounded mission. This structural check is the smallest legitimate
      // proof: the recovery file cannot reach SIGNATURE_COLLECTION_PROVIDERS
      // through any path except the exact functions already tested.
      const source = fs.readFileSync(
        path.join(__dirname, '../src/modules/open-settlement/dispute-dispatch-recovery.ts'),
        'utf8'
      )
      expect(source).not.toMatch(/SIGNATURE_COLLECTION_PROVIDERS/)
      expect(source).toMatch(/escrowService\.initiateRelease/)
      expect(source).toMatch(/escrowService\.initiateRefund/)
      expect(source).toMatch(/escrowService\.initiateSplit/)
    })
  })

  describe('non-production remains unaffected — existing dev/test harness semantics unchanged', () => {
    it('initiateRelease still rejects MOCK with its ORIGINAL "not a signature-collection type" message outside production — proves this mission changed production behavior only', async () => {
      isProductionFlag = false
      mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-dev-1', tradeId: 'trade-1', type: 'MOCK', status: 'PAYMENT_PENDING' })

      await expect(escrowService.initiateRelease('escrow-dev-1', 'tb1qexample', 'seller-1')).rejects.toThrow(
        'does not use the client-signature-collection release flow'
      )
    })
  })
})

describe('getPendingTransaction()', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('returns the pending transaction row (with signatures) when one exists', async () => {
    mockPendingTxFindUnique.mockResolvedValue({ id: 'ptx-1', escrowId: 'escrow-1', kind: 'release', requiredSigners: ['buyer-1', 'seller-1'], signatures: [] })
    const result = await escrowService.getPendingTransaction('escrow-1')
    expect(result.id).toBe('ptx-1')
  })

  it('throws NotFoundError when no signing round is in flight', async () => {
    mockPendingTxFindUnique.mockResolvedValue(null)
    await expect(escrowService.getPendingTransaction('escrow-1')).rejects.toThrow('Pending transaction for this escrow')
  })
})

// UI-audit follow-up gap (2026-08-03) — found while confirming buyer/
// seller/arbiter dispute visibility was actually complete: only whoever
// CALLED raiseDispute() ever learned the resulting disputeId (in that
// POST's own response). The other trade party had no REST or WS way to
// discover it at all. getEscrow()/getEscrowByTrade() now include the
// already-existing Escrow.disputes relation so the same public GET a
// trade party already polls for status answers this too.
describe('getEscrow() / getEscrowByTrade() — includes disputes (UI-audit gap, 2026-08-03)', () => {
  beforeEach(() => jest.clearAllMocks())

  it('getEscrow requests the disputes relation and returns it', async () => {
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', tradeId: 'trade-1', disputes: [{ id: 'dispute-1', tradeId: 'trade-1' }] })

    const result = await escrowService.getEscrow('escrow-1')

    expect(mockEscrowFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ include: expect.objectContaining({ disputes: true }) })
    )
    expect(result.disputes).toEqual([{ id: 'dispute-1', tradeId: 'trade-1' }])
  })

  it('getEscrow returns an empty disputes array for an escrow with no dispute', async () => {
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', tradeId: 'trade-1', disputes: [] })
    const result = await escrowService.getEscrow('escrow-1')
    expect(result.disputes).toEqual([])
  })

  it('getEscrowByTrade also requests the disputes relation', async () => {
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', tradeId: 'trade-1', disputes: [] })

    await escrowService.getEscrowByTrade('trade-1')

    expect(mockEscrowFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tradeId: 'trade-1' }, include: expect.objectContaining({ disputes: true }) })
    )
  })
})

// Missão 11 Fase 9.1 §10 — same GET responses now also carry this
// escrow's own disclosed custody model.
describe('getEscrow() / getEscrowByTrade() — includes custodyModel (Missão 11 Fase 9.1 §10)', () => {
  beforeEach(() => jest.clearAllMocks())

  it('getEscrow includes the real, distinct custodyModel for a MULTISIG escrow', async () => {
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', tradeId: 'trade-1', type: 'MULTISIG', disputes: [] })
    const result = await escrowService.getEscrow('escrow-1')
    expect(result.custodyModel).toBe('client-held-buyer-seller-keys-server-held-arbiter')
  })

  it('getEscrow includes the distinct custodyModel for a SAFE_GUARD_EVM escrow, not conflated with MULTISIG\'s', async () => {
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', tradeId: 'trade-1', type: 'SAFE_GUARD_EVM', disputes: [] })
    const result = await escrowService.getEscrow('escrow-1')
    expect(result.custodyModel).toBe('client-held-buyer-seller-keys-server-held-kms-arbiter')
  })

  it('returns null (never a fabricated label) for MOCK, which makes no real custody claim', async () => {
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', tradeId: 'trade-1', type: 'MOCK', disputes: [] })
    const result = await escrowService.getEscrow('escrow-1')
    expect(result.custodyModel).toBeNull()
  })

  it('getEscrowByTrade also includes custodyModel', async () => {
    mockEscrowFindUnique.mockResolvedValue({ id: 'escrow-1', tradeId: 'trade-1', type: 'WDK_USDT_EVM', disputes: [] })
    const result = await escrowService.getEscrowByTrade('trade-1')
    expect(result.custodyModel).toBe('server-custodial-reference-implementation')
  })
})
