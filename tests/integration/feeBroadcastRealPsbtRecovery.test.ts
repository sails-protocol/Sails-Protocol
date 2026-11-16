// tests/integration/feeBroadcastRealPsbtRecovery.test.ts
//
// Tests recovered from the #336-#362 lineage (Gatekeeper CTO 336 record: the guarantees exist on main, these two
// proofs were missing). Real PostgreSQL. Unlike postBroadcastFeeRecovery.test.ts, identifyFeeOutput() is NOT stubbed:
// the live recordFeeBroadcast() decodes a REAL unsigned PSBT. Only the chain-side reconstruction
// (multisigProvider.reconcilePendingSettlement) is stubbed, as there.
//
//  A. A fee output whose value diverges from the recorded feeCollectionSats, end to end: the reconciler records nothing,
//     keeps the pending row and its signature (the only durable source of the PSBT), does not throw, and recovers by
//     itself once the evidence is consistent.
//  B. recordBroadcastAndAdvance() called directly for an obligation that does not exist: rejects, writes nothing.

jest.mock('../../src/modules/open-settlement/multisig.provider', () => ({
  ...jest.requireActual('../../src/modules/open-settlement/multisig.provider'),
  multisigProvider: { reconcilePendingSettlement: jest.fn() },
}))
jest.mock('../../src/common/events/event-bus', () => ({
  eventBus: { emit: jest.fn().mockResolvedValue(undefined), on: jest.fn(), onDurable: jest.fn() },
}))

import * as bitcoin from 'bitcoinjs-lib'
import * as ecc from 'tiny-secp256k1'
import { ECPairFactory } from 'ecpair'
import { createHash } from 'crypto'
import { PrismaClient } from '@prisma/client'
import { createPostgresIntegrationHarness } from './postgresTestHarness'

bitcoin.initEccLib(ecc)
const ECPair = ECPairFactory(ecc)

describe('fee broadcast recovery with a real PSBT (recovered #336-#362 tests, real Postgres)', () => {
  jest.setTimeout(120_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let reconcilePendingSettlements: typeof import('../../src/modules/open-settlement/escrow-settlement-reconciliation.service').reconcilePendingSettlements
  let feeCollectionRecognitionService: typeof import('../../src/modules/open-settlement/fee-collection-recognition.service').feeCollectionRecognitionService
  let multisigProvider: { reconcilePendingSettlement: jest.Mock }
  let network: bitcoin.Network

  beforeAll(async () => {
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ reconcilePendingSettlements } = require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service'))
    ;({ feeCollectionRecognitionService } = require('../../src/modules/open-settlement/fee-collection-recognition.service'))
    const provider = require('../../src/modules/open-settlement/multisig.provider')
    multisigProvider = provider.multisigProvider
    network = provider.networkFor(require('../../src/config').config.multisig.network)
  })
  afterAll(async () => { if (dbAvailable) await prisma.$disconnect() })

  const suffix = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const addressFor = (seed: string) => {
    const key = ECPair.fromPrivateKey(createHash('sha256').update(seed).digest(), { network })
    return bitcoin.payments.p2wpkh({ pubkey: Buffer.from(key.publicKey), network }).address!
  }
  /** An unsigned PSBT paying the buyer and the frozen fee-collection address `feeSats` sats. */
  function realPsbt(buyerAddress: string, collectionAddress: string, feeSats: number): string {
    const psbt = new bitcoin.Psbt({ network })
    psbt.addInput({ hash: 'ff'.repeat(32), index: 0, witnessUtxo: { script: bitcoin.address.toOutputScript(buyerAddress, network), value: BigInt(200_000) } })
    psbt.addOutput({ address: buyerAddress, value: BigInt(90_000) })
    psbt.addOutput({ address: collectionAddress, value: BigInt(feeSats) })
    return psbt.toBase64()
  }

  const FEE_SATS = 4000

  async function brokenAccountingState(psbtFeeSats: number) {
    const s = suffix()
    const txid = createHash('sha256').update(s).digest('hex')
    const collection = addressFor(`collection-${s}`)
    const buyerAddress = addressFor(`buyer-${s}`)
    const buyer = await prisma.user.create({ data: { publicKey: `pk-buyer-rp-${s}` } })
    const seller = await prisma.user.create({ data: { publicKey: `pk-seller-rp-${s}` } })
    const offer = await prisma.offer.create({ data: { userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '65000', minAmount: '0.001', maxAmount: '1', paymentMethod: 'PIX' } })
    const trade = await prisma.trade.create({ data: { offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, asset: 'BTC', amount: '0.001', priceUsd: '65000', totalUsd: '65' } })
    const feePolicy = await prisma.feePolicyVersion.create({
      data: { label: `fp-rp-${s}`, railScope: `FIXTURE_RAIL_RP-${s}`, status: 'PUBLISHED', publishedAt: new Date(), protocolFeeRate: '0.004', payerModel: 'SELLER_PAYS', economicBasis: 'SELLER_DELIVERED_VALUE', requiredConfirmations: 1, createdBy: 'recovered-336-362-test' },
    })
    const escrow = await prisma.escrow.create({
      data: { tradeId: trade.id, type: 'MULTISIG', status: 'COMPLETED', asset: 'BTC', lockedAmount: '0.001', txReleaseId: txid, snapshotFeeCollectionAddress: collection },
    })
    const obligation = await prisma.feeObligation.create({
      data: { escrowId: escrow.id, feePolicyVersionId: feePolicy.id, economicDetermination: 'OWED', collectionStatus: 'PENDING_COLLECTION', basisAmount: '0.001', computedFee: '0.00000500', asset: 'BTC' },
    })
    await prisma.escrowEvent.create({ data: { escrowId: escrow.id, fromStatus: 'PAYMENT_PENDING', toStatus: 'COMPLETED', triggeredBy: seller.id } })
    const pending = await prisma.escrowPendingTransaction.create({
      data: {
        escrowId: escrow.id, kind: 'release', toAddress: buyerAddress, unsignedPsbtBase64: realPsbt(buyerAddress, collection, psbtFeeSats), requiredSigners: [buyer.id],
        triggeredBy: seller.id, feeCollectionSats: FEE_SATS, feeCollectionWaived: false,
      },
    })
    await prisma.escrowTransactionSignature.create({ data: { pendingTxId: pending.id, participantId: buyer.id, signedPsbtBase64: 'signed' } })
    multisigProvider.reconcilePendingSettlement.mockResolvedValue({ outcome: 'ALREADY_BROADCAST', txId: txid, detail: 'known', rawTxHex: 'raw' })
    return { escrowId: escrow.id, obligationId: obligation.id, pendingId: pending.id, txid, buyerAddress, collection }
  }

  async function state(escrowId: string, obligationId: string) {
    const [obligation, evidence, pending, signatures] = await Promise.all([
      prisma.feeObligation.findUnique({ where: { id: obligationId } }),
      prisma.feeCollectionEvidence.findMany({ where: { feeObligationId: obligationId } }),
      prisma.escrowPendingTransaction.findUnique({ where: { escrowId } }),
      prisma.escrowTransactionSignature.count({ where: { pendingTx: { escrowId } } }),
    ])
    return { status: obligation!.collectionStatus, evidence, pendingRow: !!pending, signatures }
  }

  it('A1 a fee output that diverges from the recorded feeCollectionSats records nothing, throws nothing, and keeps the pending row and its signature', async () => {
    pg.requirePostgres('A1')
    const { escrowId, obligationId } = await brokenAccountingState(FEE_SATS + 1) // the PSBT pays 4001, the recorded fee is 4000
    const report = await reconcilePendingSettlements()
    const s = await state(escrowId, obligationId)
    expect(s.status).toBe('PENDING_COLLECTION')
    expect(s.evidence).toHaveLength(0)
    expect(s.pendingRow).toBe(true)
    expect(s.signatures).toBe(1)
    expect(report.failed.filter((f) => f.escrowId === escrowId)).toEqual([]) // logged, never thrown: the funds already moved
    // Repeated passes change nothing: the divergence is not retried into a guess.
    await reconcilePendingSettlements()
    expect(await state(escrowId, obligationId)).toMatchObject({ status: 'PENDING_COLLECTION', pendingRow: true, signatures: 1 })
    expect((await state(escrowId, obligationId)).evidence).toHaveLength(0)
  })

  it('A2 once the PSBT and the recorded fee agree, the same pass records the REAL vout, scriptPubKey and amount and cleans up', async () => {
    pg.requirePostgres('A2')
    const { escrowId, obligationId, txid, collection } = await brokenAccountingState(FEE_SATS + 1)
    await reconcilePendingSettlements()
    expect((await state(escrowId, obligationId)).pendingRow).toBe(true)
    // The recorded fee is corrected to what the transaction really pays (stands in for the operator fixing the row).
    await prisma.escrowPendingTransaction.update({ where: { escrowId }, data: { feeCollectionSats: FEE_SATS + 1 } })
    await reconcilePendingSettlements()
    const s = await state(escrowId, obligationId)
    expect(s).toMatchObject({ status: 'IN_PROGRESS', pendingRow: false })
    expect(s.evidence).toHaveLength(1)
    expect(s.evidence[0]).toMatchObject({ kind: 'BROADCAST', txid, vout: 1 })
    expect(s.evidence[0].scriptPubKey).toBe(Buffer.from(bitcoin.address.toOutputScript(collection, network)).toString('hex'))
  })

  it('B recordBroadcastAndAdvance() for an obligation that does not exist rejects and writes nothing', async () => {
    pg.requirePostgres('B')
    const missing = `missing-obligation-${suffix()}`
    await expect(feeCollectionRecognitionService.recordBroadcastAndAdvance(missing, { txid: 'ab'.repeat(32), vout: 1, scriptPubKey: 'deadbeef', amountSats: FEE_SATS }))
      .rejects.toThrow(/FeeObligation .* not found/)
    expect(await prisma.feeCollectionEvidence.count({ where: { feeObligationId: missing } })).toBe(0)
  })
})
