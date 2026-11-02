// tests/escrowPendingFeeRetention.test.ts
//
// Issue #245, Phase 2 — the LIVE settlement path (escrow-pending-tx.ts submitTransactionSignature()). After the real broadcast,
// a failed fee recording must NOT delete the pending row: it is the only durable source of the PSBT identifyFeeOutput()
// decodes, and the settlement reconciler needs it to retry. A successful recording deletes it as before. The recording
// failure must never fail or roll back the settlement whose funds already moved, and the broadcast happens exactly once.

export {}

jest.mock('../src/config', () => ({
  get config() {
    return {
      features: { mockEscrow: true, enforceCapabilities: false, requireDualApprovalForRelease: false },
      trade: { defaultTimelockHours: 24 },
      settlement: { trustedArbitrators: [], protocolFeeRate: 0 },
      arkade: { seed: '' },
      multisig: { network: 'testnet' },
      escrowCircuitBreaker: { failureThreshold: 1000, windowMs: 60_000, cooldownMs: 60_000 },
    }
  },
}))
jest.mock('@tetherto/wdk-wallet-evm', () => ({ __esModule: true, default: class FakeWalletManagerEvm {} }))
jest.mock('@arkade-os/sdk', () => ({
  SeedIdentity: { fromSeed: jest.fn() }, MultisigTapscript: { encode: jest.fn() }, CSVMultisigTapscript: { encode: jest.fn() },
  VtxoScript: class FakeVtxoScript {}, RestArkProvider: class FakeRestArkProvider {}, RestIndexerProvider: class FakeRestIndexerProvider {},
  buildOffchainTx: jest.fn(), combineTapscriptSigs: jest.fn(), verifyTapscriptSignatures: jest.fn(),
}))
jest.mock('@scure/btc-signer', () => ({ Transaction: { fromPSBT: jest.fn() } }))

const mockFinalizeRelease = jest.fn()
jest.mock('../src/modules/open-settlement/multisig.provider', () => ({
  multisigProvider: { custodyModel: 'client-held-buyer-seller-keys-server-held-arbiter', finalizeRelease: (...a: unknown[]) => mockFinalizeRelease(...a) },
  identifyFeeOutput: jest.fn(() => ({ vout: 1, scriptPubKeyHex: 'deadbeef', amountSats: 4000 })),
  networkFor: jest.fn(() => 'testnet'),
}))

const mockRecordObligation = jest.fn()
const mockFindObligation = jest.fn()
jest.mock('../src/modules/open-settlement/fee-obligation.service', () => ({
  feeObligationService: {
    recordObligationForEscrowSettlement: (...a: unknown[]) => mockRecordObligation(...a),
    findByEscrowId: (...a: unknown[]) => mockFindObligation(...a),
  },
}))
const mockRecordBroadcastAndAdvance = jest.fn()
jest.mock('../src/modules/open-settlement/fee-collection-recognition.service', () => ({
  feeCollectionRecognitionService: { recordBroadcastAndAdvance: (...a: unknown[]) => mockRecordBroadcastAndAdvance(...a) },
}))
jest.mock('../src/modules/open-settlement/dispute-correspondence', () => ({ recordLiveCorrespondenceIfApplicable: jest.fn().mockResolvedValue(undefined) }))

const mockEscrowFindUnique = jest.fn()
const mockEscrowUpdateMany = jest.fn().mockResolvedValue({ count: 1 })
const mockEscrowUpdate = jest.fn()
const mockTradeFindUnique = jest.fn()
const mockEscrowEventCreate = jest.fn().mockResolvedValue({ id: 'transition-1' })
const mockEscrowEventFindFirst = jest.fn().mockResolvedValue(null)
const mockPendingTxDelete = jest.fn().mockResolvedValue({})
let pendingTxStore: Record<string, unknown> | null = null
let signatureStore: Array<{ pendingTxId: string; participantId: string; signedPsbtBase64: string }> = []

jest.mock('../src/common/database', () => ({
  prisma: {
    escrow: {
      findUnique: (...a: unknown[]) => mockEscrowFindUnique(...a),
      update: (...a: unknown[]) => mockEscrowUpdate(...a),
      updateMany: (...a: unknown[]) => mockEscrowUpdateMany(...a),
    },
    trade: { findUnique: (...a: unknown[]) => mockTradeFindUnique(...a) },
    dispute: { findFirst: jest.fn().mockResolvedValue(null), findUnique: jest.fn().mockResolvedValue(null) },
    economicDispositionAuthorization: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
    escrowEvent: {
      create: (...a: unknown[]) => mockEscrowEventCreate(...a),
      findFirst: (...a: unknown[]) => mockEscrowEventFindFirst(...a),
    },
    escrowParticipantKey: { findMany: jest.fn().mockResolvedValue([]) },
    escrowFundingEvidence: { findMany: jest.fn().mockResolvedValue([]) },
    escrowPendingTransaction: {
      findUnique: () => Promise.resolve(pendingTxStore),
      delete: (...a: unknown[]) => mockPendingTxDelete(...a),
    },
    escrowTransactionSignature: {
      upsert: (arg: { create: { pendingTxId: string; participantId: string; signedPsbtBase64: string } }) => {
        signatureStore = signatureStore.filter((s) => s.participantId !== arg.create.participantId)
        signatureStore.push(arg.create)
        return Promise.resolve(arg.create)
      },
      findMany: () => Promise.resolve(signatureStore),
    },
    $transaction: (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        $executeRaw: jest.fn().mockResolvedValue(0),
        // Issue #291 - persistSettlementResult() reads and writes the escrow, and checks the live pending operation, inside its transaction.
        escrow: {
          findUnique: (...a: unknown[]) => mockEscrowFindUnique(...a),
          update: (...a: unknown[]) => mockEscrowUpdate(...a),
        },
        escrowPendingTransaction: { findFirst: () => Promise.resolve(pendingTxStore) },
        // Issue #298 - emitEscrowTransition() records the 'transition.claimed' marker in the same transaction as the claim.
        eventProjectionClaim: { create: jest.fn().mockResolvedValue({}) },
        escrowEvent: {
          findFirst: (...a: unknown[]) => mockEscrowEventFindFirst(...a),
          create: (...a: unknown[]) => mockEscrowEventCreate(...a),
        },
        escrowFundingEvidence: { findMany: jest.fn().mockResolvedValue([]) },
        dispute: { findUnique: jest.fn().mockResolvedValue(null) },
        economicDispositionAuthorization: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
      }),
  },
}))
jest.mock('../src/common/events/event-bus', () => ({
  eventBus: { emit: jest.fn().mockResolvedValue(undefined), on: jest.fn(), onDurable: jest.fn() },
}))

import { escrowService } from '../src/modules/open-settlement/escrow.service'

const ESCROW_ID = 'escrow-1'
const BUYER_ID = 'buyer-1'

function escrowRow() {
  return {
    id: ESCROW_ID, tradeId: 'trade-1', type: 'MULTISIG', status: 'PAYMENT_PENDING', lockedAmount: '0.01', asset: 'BTC',
    multisigAddr: 'deposit-addr', snapshotFeeCollectionAddress: 'tb1qfeeaddress',
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  signatureStore = []
  pendingTxStore = {
    id: 'pending-1', escrowId: ESCROW_ID, kind: 'release', unsignedPsbtBase64: 'unsigned-psbt', requiredSigners: [BUYER_ID],
    triggeredBy: 'seller-1', feeCollectionSats: 4000, feeCollectionWaived: false, buyerBps: null,
  }
  mockTradeFindUnique.mockResolvedValue({ id: 'trade-1', buyerId: BUYER_ID, sellerId: 'seller-1' })
  mockEscrowFindUnique.mockResolvedValue(escrowRow())
  mockEscrowUpdateMany.mockResolvedValue({ count: 1 })
  mockEscrowUpdate.mockResolvedValue({ ...escrowRow(), status: 'COMPLETED' })
  mockFinalizeRelease.mockResolvedValue({ txId: 'tx-live-245', rawTxHex: 'raw' })
  mockRecordObligation.mockResolvedValue(undefined)
  mockFindObligation.mockResolvedValue({ id: 'obl-1' })
})

describe('submitTransactionSignature() — fee recording and the pending row (Issue #245, Phase 2)', () => {
  it('RETAINS the pending row (and still completes the settlement, broadcasting exactly once) when the fee recording fails', async () => {
    mockRecordBroadcastAndAdvance.mockRejectedValue(new Error('INJECTED accounting failure'))

    const result = await escrowService.submitTransactionSignature(ESCROW_ID, BUYER_ID, 'signed-psbt-buyer')

    expect(result.complete).toBe(true)
    expect(mockFinalizeRelease).toHaveBeenCalledTimes(1)
    expect(mockRecordBroadcastAndAdvance).toHaveBeenCalledTimes(1)
    expect(mockPendingTxDelete).not.toHaveBeenCalled()
    expect(mockEscrowEventCreate).toHaveBeenCalledTimes(1) // the completion event is still emitted once
  })

  it('RETAINS the pending row when the recording is refused as a conflict, too (any rejection means "not durable yet")', async () => {
    mockRecordBroadcastAndAdvance.mockRejectedValue(Object.assign(new Error('FEE_BROADCAST_EVIDENCE_CONFLICT'), { name: 'FeeBroadcastEvidenceConflictError' }))
    await escrowService.submitTransactionSignature(ESCROW_ID, BUYER_ID, 'signed-psbt-buyer')
    expect(mockPendingTxDelete).not.toHaveBeenCalled()
  })

  it('DELETES the pending row after a durable recording (RECORDED), unchanged from before', async () => {
    mockRecordBroadcastAndAdvance.mockResolvedValue('RECORDED')
    await escrowService.submitTransactionSignature(ESCROW_ID, BUYER_ID, 'signed-psbt-buyer')
    expect(mockRecordBroadcastAndAdvance).toHaveBeenCalledWith('obl-1', { txid: 'tx-live-245', vout: 1, scriptPubKey: 'deadbeef', amountSats: 4000 })
    expect(mockPendingTxDelete).toHaveBeenCalledTimes(1)
  })

  it('DELETES the pending row when no fee was due (waived) — nothing to recover', async () => {
    pendingTxStore = { ...pendingTxStore!, feeCollectionSats: 0, feeCollectionWaived: true }
    await escrowService.submitTransactionSignature(ESCROW_ID, BUYER_ID, 'signed-psbt-buyer')
    expect(mockRecordBroadcastAndAdvance).not.toHaveBeenCalled()
    expect(mockPendingTxDelete).toHaveBeenCalledTimes(1)
  })
})
