/**
 * Sails Core Implementation Program M8-R2 (Destination Authority
 * Conformance, remaining disputed rails, 2026-09-11, extended with the
 * full per-rail evidence matrix 2026-09-12,
 * docs/DESTINATION_AUTHORITY_ARCHITECTURE.md) — end-to-end proof, through
 * the REAL dispute.service.ts -> escrow.service.ts -> escrow-pending-tx.ts
 * -> escrow-lifecycle.ts chain (only Prisma and each settlement
 * provider's own crypto internals are mocked — irrelevant to
 * destination-authority resolution, already covered by each provider's
 * own dedicated test file), that an arbiter's ruling for a NON-MULTISIG
 * disputed escrow can no longer choose or substitute the beneficiary's
 * payout destination.
 *
 * MULTISIG's own disputed path (applyRulingCoreAuthoritative()) is
 * UNTOUCHED by the mission this file covers — see
 * tests/dispatchTranslationGuard.test.ts/tests/disputeCorrespondence.test.ts/
 * tests/multisigProvider.test.ts's own M8-RF cases for its own unchanged
 * coverage; not re-proven here. This file exercises exactly the branch
 * dispute.service.ts's resolveDispute() routes every OTHER escrow type
 * through: applyRuling(), which (as of the first M8-R2 pass) no longer
 * accepts a destination parameter at all — see that method's own header
 * comment in src/modules/open-settlement/dispute.service.ts.
 *
 * Per-rail structure below, one describe block per rail, each proving
 * only the properties that actually apply to that rail's own real
 * mechanism (see docs/BACKLOG.md item 20.1's own per-rail matrix summary
 * for the full table):
 *   - LIGHTNING_HODL (Arkade): RELEASE via signature-collection binding;
 *     REFUND's own "no caller-facing destination at all" property is
 *     proven at the narrower provider boundary instead
 *     (tests/lightningHodlProvider.test.ts) — cited, not duplicated.
 *   - SAFE_GUARD_EVM: same shape as LIGHTNING_HODL (RELEASE here, REFUND
 *     in tests/safeGuardEvmProvider.test.ts).
 *   - WDK_USDT_EVM: direct-call rail — RELEASE/REFUND/SPLIT all resolve
 *     and execute in the SAME call, no separate binding step exists to
 *     prove.
 *   - MOCK: direct-call rail, same shape as WDK_USDT_EVM; SPLIT's
 *     independent buyer/seller resolution is proven end-to-end in
 *     tests/fullTradeLifecycle.test.ts instead (real MockSettlementProvider,
 *     not this file's mocked one) — cited, not duplicated.
 */
export {} // see disputeFlow.test.ts's identical forced-module-scope reasoning

import nacl from 'tweetnacl'
import { signAuthorityDecision, type AuthorityDecisionPayload } from '../src/modules/open-settlement/arbitration-authority'

jest.mock('../src/config', () => ({
  get config() {
    return {
      features: { mockEscrow: true, enforceCapabilities: false, requireDualApprovalForRelease: false },
      trade: { defaultTimelockHours: 24 },
      settlement: { trustedArbitrators: ['arbiter-1'], protocolFeeRate: 0 },
      arkade: { seed: '' },
      escrowCircuitBreaker: { failureThreshold: 1000, windowMs: 60_000, cooldownMs: 60_000 },
    }
  },
}))

jest.mock('@tetherto/wdk-wallet-evm', () => ({ __esModule: true, default: class FakeWalletManagerEvm {} }))
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

// The one collaborator genuinely mocked away — LightningHodlProvider's
// own Ark/VTXO construction is irrelevant to what this file proves
// (already covered by tests/lightningHodlProvider.test.ts) and would
// otherwise need a full funding/pubkey fixture for no benefit here.
// `buildUnsignedRelease`'s SECOND argument is exactly
// `resolvePayoutAddress()`'s own return value — the fact under test.
const mockBuildUnsignedRelease = jest.fn()
const mockFinalizeRelease = jest.fn()
jest.mock('../src/modules/open-settlement/lightning-hodl.provider', () => ({
  lightningHodlProvider: {
    custodyModel: 'client-held-buyer-seller-keys-server-held-arbiter',
    buildUnsignedRelease: (...args: unknown[]) => mockBuildUnsignedRelease(...args),
    finalizeRelease: (...args: unknown[]) => mockFinalizeRelease(...args),
  },
}))
// Bare, import-safe stand-in — escrow-providers.ts imports this at module
// scope regardless of which rail this file actually exercises; MULTISIG's
// own conformance is proven elsewhere (tests/dispatchTranslationGuard.test.ts,
// tests/disputeCorrespondence.test.ts, tests/multisigProvider.test.ts),
// untouched by this mission.
jest.mock('../src/modules/open-settlement/multisig.provider', () => ({
  multisigProvider: {}, identifyFeeOutput: jest.fn(), networkFor: jest.fn(),
}))
// Same "mock the provider, exercise the real resolution/binding chain
// around it" treatment as lightningHodlProvider above — SAFE_GUARD_EVM's
// own signature-collection RELEASE path needs the same binding/retry/
// rotation proof, at the same narrow boundary.
const mockSafeGuardBuildUnsignedRelease = jest.fn()
const mockSafeGuardFinalizeRelease = jest.fn()
jest.mock('../src/modules/open-settlement/safe-guard-evm.provider', () => ({
  safeGuardEvmProvider: {
    custodyModel: 'client-held-buyer-seller-keys-kms-arbiter',
    buildUnsignedRelease: (...args: unknown[]) => mockSafeGuardBuildUnsignedRelease(...args),
    finalizeRelease: (...args: unknown[]) => mockSafeGuardFinalizeRelease(...args),
  },
}))
// WDK_USDT_EVM is a DIRECT-CALL rail (releaseFunds()/refundFunds()/
// splitFunds() move funds synchronously in one call, never through the
// signature-collection flow) — the property to prove here is different:
// resolution and execution happen in the SAME call, not a separate
// initiate/finalize pair, so there is no persisted-binding step to test,
// only that the resolved beneficiary address is what the provider
// actually receives.
const mockWdkReleaseFunds = jest.fn()
const mockWdkRefundFunds = jest.fn()
const mockWdkSplitFunds = jest.fn()
jest.mock('../src/modules/open-settlement/wdk-settlement.provider', () => ({
  wdkSettlementProvider: {
    releaseFunds: (...args: unknown[]) => mockWdkReleaseFunds(...args),
    refundFunds: (...args: unknown[]) => mockWdkRefundFunds(...args),
    splitFunds: (...args: unknown[]) => mockWdkSplitFunds(...args),
  },
}))

const testKeypair = nacl.sign.keyPair()
const testPublicKeyHex = Buffer.from(testKeypair.publicKey).toString('hex')

const mockEscrowFindUnique = jest.fn()
const mockEscrowUpdateMany = jest.fn().mockResolvedValue({ count: 1 })
const mockEscrowUpdate = jest.fn()
const mockTradeFindUnique = jest.fn()
const mockDisputeFindUnique = jest.fn()
const mockDisputeUpdate = jest.fn()
const mockEscrowParticipantKeyFindUnique = jest.fn().mockResolvedValue(null) // no committed arbiter — non-MULTISIG
const mockEscrowEventCreate = jest.fn().mockResolvedValue({ id: 'transition-1' })
const mockEscrowEventFindFirst = jest.fn().mockResolvedValue(null)
const mockParticipantKeyFindMany = jest.fn().mockResolvedValue([])
const mockEscrowFundingEvidenceFindMany = jest.fn().mockResolvedValue([])
const mockUserFindUnique = jest.fn().mockImplementation(async ({ where }: { where: { id: string } }) => ({ id: where.id, publicKey: testPublicKeyHex }))
// The exact fact under adversarial test.
const mockPayoutAddressFindUnique = jest.fn()
let pendingTxStore: Record<string, unknown> | null = null
const mockPendingTxCreate = jest.fn((args: { data: Record<string, unknown> }) => {
  pendingTxStore = { id: 'pending-1', ...args.data }
  return Promise.resolve(pendingTxStore)
})
const mockPendingTxFindUnique = jest.fn((_arg?: unknown) => Promise.resolve(pendingTxStore))
let signatureStore: Array<{ pendingTxId: string; participantId: string; signedPsbtBase64: string }> = []
const mockSignatureUpsert = jest.fn((args: { create: { pendingTxId: string; participantId: string; signedPsbtBase64: string } }) => {
  signatureStore = signatureStore.filter((s) => s.participantId !== args.create.participantId)
  signatureStore.push(args.create)
  return Promise.resolve(args.create)
})
const mockSignatureFindMany = jest.fn((_arg?: unknown) => Promise.resolve(signatureStore))

jest.mock('../src/common/database', () => ({
  prisma: {
    escrow: {
      findUnique: (...args: unknown[]) => mockEscrowFindUnique(...args),
      update: (...args: unknown[]) => mockEscrowUpdate(...args),
      updateMany: (...args: unknown[]) => mockEscrowUpdateMany(...args),
    },
    trade: { findUnique: (...args: unknown[]) => mockTradeFindUnique(...args) },
    dispute: {
      findUnique: (...args: unknown[]) => mockDisputeFindUnique(...args),
      update: (...args: unknown[]) => mockDisputeUpdate(...args),
      // escrow-lifecycle.ts's isSellerOrAssignedArbiter() falls back to
      // this (escrowRepository.findDisputeByTradeAndArbiter()) whenever
      // triggeredBy isn't the trade's own seller — true for every
      // resolveDispute() call in this file, since the arbiter (never the
      // seller) is who triggers a ruling. Must resolve to a real
      // dispute row for {tradeId, arbiterId} or every ruling in this file
      // would be wrongly rejected as unauthorized before ever reaching
      // the destination-resolution code this file actually tests.
      // Literal ids used directly (not the module's own TRADE_ID/ARBITER_ID
      // constants) — this factory runs when DisputeService is first
      // required, which ES-module import hoisting can trigger before
      // those later `const` declarations in this same file initialize.
      findFirst: jest.fn().mockImplementation(({ where }: { where: { tradeId: string; arbiterId: string } }) =>
        Promise.resolve(where.tradeId === 'trade-1' && where.arbiterId === 'arbiter-1' ? { id: 'dispute-1', tradeId: 'trade-1', arbiterId: 'arbiter-1' } : null)
      ),
    },
    user: { findUnique: (...args: unknown[]) => mockUserFindUnique(...args) },
    escrowParticipantKey: {
      findUnique: (...args: unknown[]) => mockEscrowParticipantKeyFindUnique(...args),
      findMany: (...args: unknown[]) => mockParticipantKeyFindMany(...args),
    },
    escrowEvent: {
      create: (...args: unknown[]) => mockEscrowEventCreate(...args),
      findFirst: (...args: unknown[]) => mockEscrowEventFindFirst(...args),
    },
    payoutAddress: { findUnique: (...args: unknown[]) => mockPayoutAddressFindUnique(...args) },
    escrowFundingEvidence: { findMany: (...args: unknown[]) => mockEscrowFundingEvidenceFindMany(...args) },
    escrowPendingTransaction: {
      findUnique: (arg: unknown) => mockPendingTxFindUnique(arg),
      create: (arg: { data: Record<string, unknown> }) => mockPendingTxCreate(arg),
      delete: jest.fn().mockResolvedValue({}),
    },
    escrowTransactionSignature: {
      upsert: (arg: { create: { pendingTxId: string; participantId: string; signedPsbtBase64: string } }) => mockSignatureUpsert(arg),
      findMany: (arg: unknown) => mockSignatureFindMany(arg),
    },
    // ADR-005 / #218 — applyRuling()'s resolve-write now runs inside
    // prisma.$transaction() (economic-disposition:<disputeId> advisory
    // lock + a conditional claim, then a re-fetch for the return value —
    // real Postgres's updateMany doesn't return the row, so applyRuling()
    // re-reads it). This file's existing tests configure mockDisputeUpdate
    // with the POST-write row shape (mockDisputeUpdate.mockResolvedValue({
    // status: 'RESOLVED', ... })) and assert against resolveDispute()'s
    // return value — so the fake tx.dispute.findUnique() below returns
    // whatever mockDisputeUpdate resolved to for the write that just ran,
    // not the pre-write mockDisputeFindUnique() snapshot.
    $transaction: (callback: (tx: unknown) => Promise<unknown>) => {
      let writtenRow: unknown
      return callback({
        // Issue #298 - emitEscrowTransition() records the 'transition.claimed' marker in the same transaction as the claim.
        eventProjectionClaim: { create: jest.fn().mockResolvedValue({}), createMany: jest.fn().mockResolvedValue({ count: 1 }), findMany: jest.fn().mockResolvedValue([]) },
        $executeRaw: jest.fn().mockResolvedValue(0),
        // Issue #291 - persistSettlementResult() reads then writes the escrow inside its own locked transaction.
        escrow: { findUnique: (...args: unknown[]) => mockEscrowFindUnique(...args), update: (...args: unknown[]) => mockEscrowUpdate(...args) },
        dispute: {
          findUnique: async () => writtenRow,
          updateMany: async (...args: unknown[]) => {
            writtenRow = await mockDisputeUpdate(...args)
            return { count: 1 }
          },
        },
        escrowEvent: {
          findFirst: (...args: unknown[]) => mockEscrowEventFindFirst(...args),
          create: (...args: unknown[]) => mockEscrowEventCreate(...args),
        },
        escrowFundingEvidence: { findMany: (...args: unknown[]) => mockEscrowFundingEvidenceFindMany(...args) },
        escrowPendingTransaction: { create: (arg: { data: Record<string, unknown> }) => mockPendingTxCreate(arg), findFirst: (arg: unknown) => mockPendingTxFindUnique(arg) /* Issue #291 - operation-bound result write */ },
      })
    },
  },
}))

jest.mock('../src/common/events/event-bus', () => ({
  eventBus: { emit: jest.fn().mockResolvedValue(undefined), on: jest.fn(), onDurable: jest.fn() },
}))

import { DisputeService } from '../src/modules/open-settlement/dispute.service'
import { TrustedArbitratorProvider } from '../src/modules/open-settlement/arbitration-provider'

const TRADE_ID = 'trade-1'
const ESCROW_ID = 'escrow-1'
const BUYER_ID = 'buyer-1'
const SELLER_ID = 'seller-1'
const ARBITER_ID = 'arbiter-1'
const DISPUTE_ID = 'dispute-1'
const TRADE_ROW = { id: TRADE_ID, buyerId: BUYER_ID, sellerId: SELLER_ID }

function escrowRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ESCROW_ID, tradeId: TRADE_ID, type: 'LIGHTNING_HODL', status: 'PAYMENT_PENDING',
    lockedAmount: '0.01', asset: 'BTC',
    ...overrides,
  }
}

function signResolution(outcome: 'RELEASE' | 'REFUND' | 'SPLIT', buyerBps: number | null = null, issuedAt = '2026-09-11T00:00:00.000Z'): [string, string] {
  const payload: AuthorityDecisionPayload = {
    disputeId: DISPUTE_ID, escrowId: ESCROW_ID, appealRound: 0, authorityId: ARBITER_ID, outcome, buyerBps, issuedAt,
  }
  return [signAuthorityDecision(payload, testKeypair.secretKey), issuedAt]
}

describe('LIGHTNING_HODL — disputed RELEASE (signature-collection binding)', () => {
  const service = new DisputeService(new TrustedArbitratorProvider([ARBITER_ID]))

  beforeEach(() => {
    jest.clearAllMocks()
    pendingTxStore = null
    signatureStore = []
    mockTradeFindUnique.mockResolvedValue(TRADE_ROW)
    mockEscrowFindUnique.mockResolvedValue(escrowRow())
    mockDisputeFindUnique.mockResolvedValue({ id: DISPUTE_ID, tradeId: TRADE_ID, escrowId: ESCROW_ID, arbiterId: ARBITER_ID, status: 'OPENED', appealRound: 0 })
    mockDisputeUpdate.mockResolvedValue({ id: DISPUTE_ID, status: 'RESOLVED', ruling: 'RELEASE' })
    mockEscrowUpdateMany.mockResolvedValue({ count: 1 })
    mockUserFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({ id: where.id, publicKey: testPublicKeyHex }))
    mockBuildUnsignedRelease.mockResolvedValue({ psbtBase64: 'psbt-stub', requiredSigners: [SELLER_ID, BUYER_ID] })
  })

  it('1/3/9. an arbiter-supplied wrong RELEASE destination cannot override the buyer\'s registered PayoutAddress — resolved and bound at ruling time', async () => {
    mockPayoutAddressFindUnique.mockResolvedValue({ address: 'buyer-address-A', participantId: BUYER_ID, asset: 'BTC' })
    const [sig, issuedAt] = signResolution('RELEASE')

    await service.resolveDispute(DISPUTE_ID, ARBITER_ID, 'RELEASE', 'attacker-controlled-address', undefined, undefined, sig, issuedAt)

    expect(mockPayoutAddressFindUnique).toHaveBeenCalledWith({ where: { participantId_asset: { participantId: BUYER_ID, asset: 'BTC' } } })
    expect(mockBuildUnsignedRelease.mock.calls[0][1]).toBe('buyer-address-A')
    expect((pendingTxStore as any).toAddress).toBe('buyer-address-A')
  })

  it('7. missing beneficiary destination fails closed — no pending transaction is created, the provider is never invoked, the ruling itself is reverted', async () => {
    mockPayoutAddressFindUnique.mockResolvedValue(null)
    const [sig, issuedAt] = signResolution('RELEASE')

    await expect(
      service.resolveDispute(DISPUTE_ID, ARBITER_ID, 'RELEASE', undefined, undefined, undefined, sig, issuedAt)
    ).rejects.toThrow(/No payout address provided.*none is registered/)

    expect(mockBuildUnsignedRelease).not.toHaveBeenCalled()
    expect(pendingTxStore).toBeNull()
    // The dispute's RESOLVED write is reverted back to its prior state —
    // applyRuling()'s own catch block. CTO Gate R2 (#222) finding R2-1 —
    // the revert is now a lock-protected conditional claim
    // (tx.dispute.updateMany), proving the row still matches EXACTLY the
    // generation this call committed before reverting it — never a bare
    // update() by id alone.
    expect(mockDisputeUpdate).toHaveBeenLastCalledWith({
      where: { id: DISPUTE_ID, status: 'RESOLVED', ruling: 'RELEASE', arbiterId: ARBITER_ID, appealRound: undefined, authoritySignature: sig },
      data: { status: 'OPENED', ruling: null, resolvedAt: null, authoritySignature: null, authorityIssuedAt: null, authorityBuyerBps: null },
    })
  })

  describe('4/5/6. rotation and retry — binding survives across the signature-collection round', () => {
    beforeEach(async () => {
      mockPayoutAddressFindUnique.mockResolvedValue({ address: 'buyer-address-A', participantId: BUYER_ID, asset: 'BTC' })
      const [sig, issuedAt] = signResolution('RELEASE')
      await service.resolveDispute(DISPUTE_ID, ARBITER_ID, 'RELEASE', undefined, undefined, undefined, sig, issuedAt)
      expect((pendingTxStore as any).toAddress).toBe('buyer-address-A')
      mockEscrowFindUnique.mockResolvedValue(escrowRow({ status: 'DISPUTED' }))
      // Rotation AFTER the ruling's own destination-binding moment.
      mockPayoutAddressFindUnique.mockResolvedValue({ address: 'buyer-address-B', participantId: BUYER_ID, asset: 'BTC' })
      mockPayoutAddressFindUnique.mockClear()
      mockBuildUnsignedRelease.mockClear()
    })

    it('finalize (both required signers submitting) uses the address bound at ruling time, never re-resolving PayoutAddress', async () => {
      mockFinalizeRelease.mockResolvedValue({ txId: 'tx-1' })
      const { submitTransactionSignature } = require('../src/modules/open-settlement/escrow-pending-tx')
      await submitTransactionSignature(ESCROW_ID, SELLER_ID, 'signed-seller')
      const result = await submitTransactionSignature(ESCROW_ID, BUYER_ID, 'signed-buyer')

      expect(result.complete).toBe(true)
      expect(mockFinalizeRelease.mock.calls[0][1]).toBe('psbt-stub')
      expect(mockPayoutAddressFindUnique).not.toHaveBeenCalled()
      expect(mockBuildUnsignedRelease).not.toHaveBeenCalled()
    })

    it('a retried signature submission (resubmit before the round completes) does not re-resolve PayoutAddress either', async () => {
      const { submitTransactionSignature } = require('../src/modules/open-settlement/escrow-pending-tx')
      const first = await submitTransactionSignature(ESCROW_ID, SELLER_ID, 'signed-seller-v1')
      expect(first.complete).toBe(false)
      const retry = await submitTransactionSignature(ESCROW_ID, SELLER_ID, 'signed-seller-v2')
      expect(retry.complete).toBe(false)
      expect(mockPayoutAddressFindUnique).not.toHaveBeenCalled()
    })
  })

  // REFUND: LightningHodlProvider's own buildUnsignedRefund(escrow) never
  // accepts a destination parameter at all — proven at the narrower,
  // more direct provider boundary instead of duplicated here:
  // tests/lightningHodlProvider.test.ts's "buildUnsignedRefund derives a
  // real Ark refund address from the seller pubkey" (correct beneficiary)
  // and its M8-R2 "a caller-supplied second argument ... has NO effect"
  // case (caller/arbiter cannot override). Binding/retry for REFUND go
  // through the exact same escrow-pending-tx.ts persisted-toAddress
  // mechanism RELEASE already proves above (shared code, not
  // rail-specific — see that file's own header). SPLIT is N/A for this
  // rail — tests/lightningHodlProvider.test.ts's own "buildUnsignedSplit()
  // is not supported (fixed 2-of-2 leaf structure)" proves the real
  // provider rejects it outright, not a silent no-op.
})

describe('SAFE_GUARD_EVM — disputed RELEASE (signature-collection binding)', () => {
  const service = new DisputeService(new TrustedArbitratorProvider([ARBITER_ID]))

  beforeEach(() => {
    jest.clearAllMocks()
    pendingTxStore = null
    signatureStore = []
    mockTradeFindUnique.mockResolvedValue(TRADE_ROW)
    mockEscrowFindUnique.mockResolvedValue(escrowRow({ type: 'SAFE_GUARD_EVM', asset: 'USDT_ERC20' }))
    mockDisputeFindUnique.mockResolvedValue({ id: DISPUTE_ID, tradeId: TRADE_ID, escrowId: ESCROW_ID, arbiterId: ARBITER_ID, status: 'OPENED', appealRound: 0 })
    mockDisputeUpdate.mockResolvedValue({ id: DISPUTE_ID, status: 'RESOLVED', ruling: 'RELEASE' })
    mockEscrowUpdateMany.mockResolvedValue({ count: 1 })
    mockUserFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({ id: where.id, publicKey: testPublicKeyHex }))
    mockSafeGuardBuildUnsignedRelease.mockResolvedValue({ psbtBase64: 'safe-bundle-stub', requiredSigners: [SELLER_ID, BUYER_ID] })
  })

  it('an arbiter-supplied wrong RELEASE destination cannot override the buyer\'s registered PayoutAddress — resolved and bound at ruling time', async () => {
    mockPayoutAddressFindUnique.mockResolvedValue({ address: '0xBuyerRegistered', participantId: BUYER_ID, asset: 'USDT_ERC20' })
    const [sig, issuedAt] = signResolution('RELEASE')

    await service.resolveDispute(DISPUTE_ID, ARBITER_ID, 'RELEASE', '0xAttackerAddress', undefined, undefined, sig, issuedAt)

    expect(mockSafeGuardBuildUnsignedRelease.mock.calls[0][1]).toBe('0xBuyerRegistered')
    expect((pendingTxStore as any).toAddress).toBe('0xBuyerRegistered')
  })

  it('missing beneficiary destination fails closed — the provider is never invoked', async () => {
    mockPayoutAddressFindUnique.mockResolvedValue(null)
    const [sig, issuedAt] = signResolution('RELEASE')

    await expect(
      service.resolveDispute(DISPUTE_ID, ARBITER_ID, 'RELEASE', undefined, undefined, undefined, sig, issuedAt)
    ).rejects.toThrow(/No payout address provided.*none is registered/)
    expect(mockSafeGuardBuildUnsignedRelease).not.toHaveBeenCalled()
    expect(pendingTxStore).toBeNull()
  })

  it('rotation after binding and a retried signature submission never re-resolve PayoutAddress', async () => {
    mockPayoutAddressFindUnique.mockResolvedValue({ address: '0xBuyerRegistered', participantId: BUYER_ID, asset: 'USDT_ERC20' })
    const [sig, issuedAt] = signResolution('RELEASE')
    await service.resolveDispute(DISPUTE_ID, ARBITER_ID, 'RELEASE', undefined, undefined, undefined, sig, issuedAt)
    expect((pendingTxStore as any).toAddress).toBe('0xBuyerRegistered')

    mockEscrowFindUnique.mockResolvedValue(escrowRow({ type: 'SAFE_GUARD_EVM', asset: 'USDT_ERC20', status: 'DISPUTED' }))
    mockPayoutAddressFindUnique.mockResolvedValue({ address: '0xBuyerRotatedAfter', participantId: BUYER_ID, asset: 'USDT_ERC20' })
    mockPayoutAddressFindUnique.mockClear()
    mockSafeGuardBuildUnsignedRelease.mockClear()
    mockSafeGuardFinalizeRelease.mockResolvedValue({ txId: 'tx-safe-1' })

    const { submitTransactionSignature } = require('../src/modules/open-settlement/escrow-pending-tx')
    const retry = await submitTransactionSignature(ESCROW_ID, SELLER_ID, 'signed-seller-v1')
    expect(retry.complete).toBe(false)
    const again = await submitTransactionSignature(ESCROW_ID, SELLER_ID, 'signed-seller-v2') // resubmit
    expect(again.complete).toBe(false)
    const result = await submitTransactionSignature(ESCROW_ID, BUYER_ID, 'signed-buyer')
    expect(result.complete).toBe(true)
    expect(mockSafeGuardFinalizeRelease.mock.calls[0][1]).toBe('safe-bundle-stub')
    expect(mockPayoutAddressFindUnique).not.toHaveBeenCalled()
    expect(mockSafeGuardBuildUnsignedRelease).not.toHaveBeenCalled()
  })

  // REFUND: same reasoning as LIGHTNING_HODL above — proven at the
  // narrower provider boundary (tests/safeGuardEvmProvider.test.ts's
  // "buildUnsignedRefund derives the refund address from the seller
  // pubkey" and its own M8-R2 "caller-supplied second argument ... has
  // NO effect" case). SPLIT is N/A —
  // tests/safeGuardEvmProvider.test.ts's "buildUnsignedSplit() is not
  // supported (immutable Guard contract)" proves the real rejection.
})

describe('WDK_USDT_EVM — direct-call rail (resolution and execution in the same call, no separate binding step)', () => {
  const service = new DisputeService(new TrustedArbitratorProvider([ARBITER_ID]))

  beforeEach(() => {
    jest.clearAllMocks()
    pendingTxStore = null
    signatureStore = []
    mockTradeFindUnique.mockResolvedValue(TRADE_ROW)
    mockEscrowFindUnique.mockResolvedValue(escrowRow({ type: 'WDK_USDT_EVM', asset: 'USDT_ERC20', status: 'PAYMENT_PENDING' }))
    mockDisputeFindUnique.mockResolvedValue({ id: DISPUTE_ID, tradeId: TRADE_ID, escrowId: ESCROW_ID, arbiterId: ARBITER_ID, status: 'OPENED', appealRound: 0 })
    mockEscrowUpdateMany.mockResolvedValue({ count: 1 })
    mockUserFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({ id: where.id, publicKey: testPublicKeyHex }))
  })

  it('RELEASE: an arbiter-supplied wrong destination cannot override the buyer\'s registered PayoutAddress — resolution and execution happen in the same call', async () => {
    mockDisputeUpdate.mockResolvedValue({ id: DISPUTE_ID, status: 'RESOLVED', ruling: 'RELEASE' })
    mockPayoutAddressFindUnique.mockResolvedValue({ address: '0xBuyerRegistered', participantId: BUYER_ID, asset: 'USDT_ERC20' })
    mockWdkReleaseFunds.mockResolvedValue({ txId: 'wdk-tx-1' })
    const [sig, issuedAt] = signResolution('RELEASE')

    await service.resolveDispute(DISPUTE_ID, ARBITER_ID, 'RELEASE', '0xAttackerAddress', undefined, undefined, sig, issuedAt)

    expect(mockWdkReleaseFunds.mock.calls[0][1]).toBe('0xBuyerRegistered')
  })

  it('RELEASE: missing beneficiary destination fails closed before the provider is ever invoked', async () => {
    mockPayoutAddressFindUnique.mockResolvedValue(null)
    const [sig, issuedAt] = signResolution('RELEASE')

    await expect(
      service.resolveDispute(DISPUTE_ID, ARBITER_ID, 'RELEASE', undefined, undefined, undefined, sig, issuedAt)
    ).rejects.toThrow(/No payout address provided.*none is registered/)
    expect(mockWdkReleaseFunds).not.toHaveBeenCalled()
  })

  it('REFUND: has no caller-facing destination concept at all — returns to the protocol\'s own treasury, PayoutAddress is never consulted', async () => {
    mockEscrowFindUnique.mockResolvedValue(escrowRow({ type: 'WDK_USDT_EVM', asset: 'USDT_ERC20', status: 'FUNDS_LOCKED' }))
    mockDisputeUpdate.mockResolvedValue({ id: DISPUTE_ID, status: 'RESOLVED', ruling: 'REFUND' })
    // wdk-settlement.provider.ts's own real refundFunds() takes no
    // destination parameter — it derives the treasury address internally
    // (this.treasuryAccount()). The mock here mirrors that exact
    // single-parameter shape; a second, caller-supplied argument (as an
    // old caller's refundToAddress would have been) has nowhere to go.
    mockWdkRefundFunds.mockResolvedValue({ txId: 'wdk-refund-1' })
    const [sig, issuedAt] = signResolution('REFUND')

    const updated = await service.resolveDispute(DISPUTE_ID, ARBITER_ID, 'REFUND', undefined, 'attacker-controlled-seller-address', undefined, sig, issuedAt)

    expect(updated!.status).toBe('RESOLVED')
    expect(mockWdkRefundFunds).toHaveBeenCalledWith(expect.objectContaining({ id: ESCROW_ID }))
    expect(mockWdkRefundFunds.mock.calls[0]).toHaveLength(1) // no destination argument at all
    expect(mockPayoutAddressFindUnique).not.toHaveBeenCalled()
  })

  it('SPLIT: buyer and seller destinations are resolved independently, each from their own registered PayoutAddress, never the caller-supplied values', async () => {
    mockEscrowFindUnique.mockResolvedValue(escrowRow({ type: 'WDK_USDT_EVM', asset: 'USDT_ERC20', status: 'DISPUTED' }))
    mockDisputeUpdate.mockResolvedValue({ id: DISPUTE_ID, status: 'RESOLVED', ruling: 'SPLIT' })
    mockPayoutAddressFindUnique.mockImplementation(({ where }: { where: { participantId_asset: { participantId: string; asset: string } } }) =>
      Promise.resolve(
        where.participantId_asset.participantId === BUYER_ID
          ? { address: '0xBuyerRegistered', participantId: BUYER_ID, asset: 'USDT_ERC20' }
          : { address: '0xSellerRegistered', participantId: SELLER_ID, asset: 'USDT_ERC20' }
      )
    )
    mockWdkSplitFunds.mockResolvedValue({ txIds: ['wdk-split-buyer', 'wdk-split-seller'] })
    const [sig, issuedAt] = signResolution('SPLIT', 6000)

    await service.resolveDispute(DISPUTE_ID, ARBITER_ID, 'SPLIT', '0xAttackerBuyer', '0xAttackerSeller', 6000, sig, issuedAt)

    expect(mockWdkSplitFunds.mock.calls[0][1]).toBe('0xBuyerRegistered')
    expect(mockWdkSplitFunds.mock.calls[0][2]).toBe('0xSellerRegistered')
  })
})

describe('MOCK — direct-call rail, real (unmocked) MockSettlementProvider', () => {
  const service = new DisputeService(new TrustedArbitratorProvider([ARBITER_ID]))

  beforeEach(() => {
    jest.clearAllMocks()
    pendingTxStore = null
    signatureStore = []
    mockTradeFindUnique.mockResolvedValue(TRADE_ROW)
    mockEscrowFindUnique.mockResolvedValue(escrowRow({ type: 'MOCK', status: 'PAYMENT_PENDING' }))
    mockEscrowUpdateMany.mockResolvedValue({ count: 1 })
    mockUserFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({ id: where.id, publicKey: testPublicKeyHex }))
  })

  it('RELEASE: the real MockSettlementProvider actually pays out to the buyer\'s registered PayoutAddress, never the arbiter-supplied one — resolution and execution in the same call', async () => {
    mockDisputeUpdate.mockResolvedValue({ id: DISPUTE_ID, status: 'RESOLVED', ruling: 'RELEASE' })
    mockPayoutAddressFindUnique.mockResolvedValue({ address: 'buyer-registered-address', participantId: BUYER_ID, asset: 'BTC' })
    mockEscrowUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: ESCROW_ID, ...data }))
    const [sig, issuedAt] = signResolution('RELEASE')

    await service.resolveDispute(DISPUTE_ID, ARBITER_ID, 'RELEASE', 'attacker-controlled-address', undefined, undefined, sig, issuedAt)

    // MockSettlementProvider.releaseFunds()'s own real txId shape:
    // `mock-release-<uuid>-to-<toAddress.slice(0,8)}` — the ACTUAL
    // destination used is directly observable in the persisted result.
    const txReleaseId = mockEscrowUpdate.mock.calls[0][0].data.txReleaseId as string
    expect(txReleaseId).toContain('buyer-re') // 'buyer-registered-address'.slice(0, 8)
    expect(txReleaseId).not.toContain('attacker')
  })

  it('REFUND: the real MockSettlementProvider has no destination concept at all — PayoutAddress is never consulted, the txId carries no address', async () => {
    mockEscrowFindUnique.mockResolvedValue(escrowRow({ type: 'MOCK', status: 'FUNDS_LOCKED' }))
    mockDisputeUpdate.mockResolvedValue({ id: DISPUTE_ID, status: 'RESOLVED', ruling: 'REFUND' })
    mockEscrowUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: ESCROW_ID, ...data }))
    const [sig, issuedAt] = signResolution('REFUND')

    await service.resolveDispute(DISPUTE_ID, ARBITER_ID, 'REFUND', undefined, 'attacker-controlled-seller-address', undefined, sig, issuedAt)

    const txReleaseId = mockEscrowUpdate.mock.calls[0][0].data.txReleaseId as string
    expect(txReleaseId).toMatch(/^mock-refund-/) // no `-to-<address>` suffix at all — see MockSettlementProvider.refundFunds()
    expect(mockPayoutAddressFindUnique).not.toHaveBeenCalled()
  })

  // SPLIT: MOCK's independent buyer/seller resolution is proven
  // end-to-end (real Prisma-shaped fake tables, real MockSettlementProvider,
  // real DisputeService) in tests/fullTradeLifecycle.test.ts's own "a
  // SPLIT dispute ruling resolves through the real chain" test — not
  // duplicated here.
})
