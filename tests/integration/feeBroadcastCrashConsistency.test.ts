// tests/integration/feeBroadcastCrashConsistency.test.ts
//
// Issue #245 - real PostgreSQL proof that durable BROADCAST FeeCollectionEvidence never coexists
// with a FeeObligation restart/recovery reads as "never broadcast," and that recovering it never
// creates a duplicate fee collection.
//
// recordBroadcastAndAdvance() itself never calls an external provider - the fee output is embedded
// in the SAME settlement transaction the escrow's own write-once txReleaseId already protects
// (Issue #291); this method only records what that already-broadcast transaction proves and advances
// FeeObligation.collectionStatus. The canonical #245 crash window is therefore a pure database
// atomicity property (two writes that used to be non-transactional), proven here by real concurrent
// PostgreSQL transactions rather than a literal process kill - the same standard
// recognizeConfirmation()'s own sibling fix (tests/integration/atomicCollectionRecognition.test.ts)
// already established for the identical class of problem.

import { PrismaClient, Prisma } from '@prisma/client'
import * as bitcoin from 'bitcoinjs-lib'
import * as ecc from 'tiny-secp256k1'
import { ECPairFactory } from 'ecpair'
import { createHash, randomUUID } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'
import { boundOfferRow, boundTradeRow, sellerPixAccount, deleteFixtureAccounts } from './economicFixtures'

bitcoin.initEccLib(ecc)
const ECPair = ECPairFactory(ecc)
const btcNetwork = bitcoin.networks.testnet

function p2wpkhAddressFor(seed: string): string {
  const key = ECPair.fromPrivateKey(createHash('sha256').update(seed).digest(), { network: btcNetwork })
  return bitcoin.payments.p2wpkh({ pubkey: Buffer.from(key.publicKey), network: btcNetwork }).address!
}
const COLLECTION_ADDRESS = p2wpkhAddressFor('issue-245-collection')
const BUYER_ADDRESS = p2wpkhAddressFor('issue-245-buyer')

// Real, deterministically-decodable PSBT (no signing needed - identifyFeeOutput() only inspects
// outputs) - same shape tests/multisigFeeOutputIdentification.test.ts's own buildPsbt() uses.
function buildPsbtWithFeeOutput(feeSats: number, buyerSats: number): string {
  const psbt = new bitcoin.Psbt({ network: btcNetwork })
  const dummyScript = bitcoin.address.toOutputScript(BUYER_ADDRESS, btcNetwork)
  psbt.addInput({ hash: 'ff'.repeat(32), index: 0, witnessUtxo: { script: dummyScript, value: BigInt(feeSats + buyerSats + 500) } })
  psbt.addOutput({ address: BUYER_ADDRESS, value: BigInt(buyerSats) })
  psbt.addOutput({ address: COLLECTION_ADDRESS, value: BigInt(feeSats) })
  return psbt.toBase64()
}

describe('Issue #245 - fee BROADCAST evidence / FeeObligation crash consistency (real PostgreSQL)', () => {
  jest.setTimeout(120_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let feeCollectionRecognitionService: typeof import('../../src/modules/open-settlement/fee-collection-recognition.service').feeCollectionRecognitionService
  let reconcilePendingSettlements: typeof import('../../src/modules/open-settlement/escrow-settlement-reconciliation.service').reconcilePendingSettlements
  let instanceB: { reconcile: typeof reconcilePendingSettlements; prisma: PrismaClient; redis: { quit(): Promise<unknown> } } | undefined

  beforeAll(async () => {
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ feeCollectionRecognitionService } = require('../../src/modules/open-settlement/fee-collection-recognition.service'))
    ;({ reconcilePendingSettlements } = require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service'))
    const { intentEngine } = require('../../src/core/intent-engine')
    const { OpenP2PTradeIntentHandler } = require('../../src/modules/open-p2p/intent-handler')
    intentEngine.registerHandler(OpenP2PTradeIntentHandler)
    require('../../src/common/events/handlers').registerEventHandlers()
    jest.isolateModules(() => {
      require('../../src/common/events/handlers').registerEventHandlers()
      instanceB = {
        reconcile: require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service').reconcilePendingSettlements,
        prisma: require('../../src/common/database').prisma,
        redis: require('../../src/common/redis').redis,
      }
    })
  })

  afterAll(async () => {
    if (dbAvailable) {
      await prisma.$disconnect()
      if (instanceB) {
        await instanceB.prisma.$disconnect()
        await instanceB.redis.quit().catch(() => {})
      }
      await closeTestRedis()
    }
  })

  let createdEscrowIds: string[] = []
  let createdTradeIds: string[] = []
  let createdUserIds: string[] = []
  let createdObligationIds: string[] = []
  let createdPolicyIds: string[] = []

  beforeEach(() => {
    createdEscrowIds = []
    createdTradeIds = []
    createdUserIds = []
    createdObligationIds = []
    createdPolicyIds = []
  })

  afterEach(async () => {
    if (!dbAvailable) return
    if (createdObligationIds.length) {
      await prisma.feeCollectionEvidence.deleteMany({ where: { feeObligationId: { in: createdObligationIds } } })
      await prisma.feeObligation.deleteMany({ where: { id: { in: createdObligationIds } } })
    }
    if (createdEscrowIds.length) {
      await prisma.escrowPendingTransaction.deleteMany({ where: { escrowId: { in: createdEscrowIds } } })
      const transitions = await prisma.escrowEvent.findMany({ where: { escrowId: { in: createdEscrowIds } }, select: { id: true } })
      // 'transition.projected' is keyed subjectId = transition; 'transition.claimed' eventId = transition (subjectId = escrow)
      const transitionIds = transitions.map((t) => t.id)
      if (transitions.length) await prisma.eventProjectionClaim.deleteMany({ where: { OR: [{ subjectId: { in: transitionIds } }, { eventId: { in: transitionIds } }] } })
      await prisma.escrowEvent.deleteMany({ where: { escrowId: { in: createdEscrowIds } } })
    }
    if (createdTradeIds.length) {
      await prisma.eventProjectionClaim.deleteMany({ where: { subjectId: { in: createdTradeIds } } })
      await prisma.durableEventRecord.deleteMany({ where: { correlationId: { in: createdTradeIds } } })
      await prisma.trade.updateMany({ where: { id: { in: createdTradeIds } }, data: { escrowId: null } })
    }
    if (createdEscrowIds.length) await prisma.escrow.deleteMany({ where: { id: { in: createdEscrowIds } } })
    if (createdTradeIds.length) await prisma.trade.deleteMany({ where: { id: { in: createdTradeIds } } })
    if (createdUserIds.length) {
      await prisma.offer.deleteMany({ where: { userId: { in: createdUserIds } } })
      await deleteFixtureAccounts(prisma, createdUserIds)
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
    }
    if (createdPolicyIds.length) await prisma.feePolicyVersion.deleteMany({ where: { id: { in: createdPolicyIds } } })
  })

  // ── Layer 1: recordBroadcastAndAdvance() itself - the canonical atomicity fix ──────────────────

  async function makeObligationOnly(suffix: string) {
    const seller = await prisma.user.create({ data: { publicKey: randomUUID() } })
    const buyer = await prisma.user.create({ data: { publicKey: randomUUID() } })
    createdUserIds.push(seller.id, buyer.id)
    const acct = await sellerPixAccount(prisma, seller.id)
    const offer = await prisma.offer.create({ data: { userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '65000', minAmount: '0.001', maxAmount: '1', ...boundOfferRow(acct) } })
    const trade = await prisma.trade.create({ data: { ...boundTradeRow(acct), offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, asset: 'BTC', amount: '0.001', priceUsd: '65000', totalUsd: '65' } })
    createdTradeIds.push(trade.id)
    const policy = await prisma.feePolicyVersion.create({
      data: {
        label: `issue245-${suffix}`, railScope: `MULTISIG-245-${suffix}`, status: 'PUBLISHED', publishedAt: new Date(),
        protocolFeeRate: '0.004', payerModel: 'SELLER_PAYS', economicBasis: 'SELLER_DELIVERED_VALUE',
        nodeOperatorPct: '30', treasuryPct: '25', walletRebatePct: '35', arbitratorReservePct: '10',
        requiredConfirmations: 2, createdBy: 'issue-245-test',
      },
    })
    createdPolicyIds.push(policy.id)
    const escrow = await prisma.escrow.create({
      data: {
        tradeId: trade.id, type: 'MULTISIG', asset: 'BTC', lockedAmount: '0.001', status: 'PAYMENT_PENDING',
        txLockId: createHash('sha256').update(randomUUID()).digest('hex'), txLockVout: 0, // #235 R7G F8A: past FUNDS_LOCKED it carries its funding outpoint
        feePolicyVersionId: policy.id, snapshotProtocolFeeRate: '0.004', snapshotPayerModel: 'SELLER_PAYS', snapshotEconomicBasis: 'SELLER_DELIVERED_VALUE',
        snapshotFeeCollectionAddress: COLLECTION_ADDRESS, snapshotFeeCollectionWaivedPreFunding: false,
      },
    })
    createdEscrowIds.push(escrow.id)
    const obligation = await prisma.feeObligation.create({
      data: { escrowId: escrow.id, feePolicyVersionId: policy.id, economicDetermination: 'OWED', collectionStatus: 'PENDING_COLLECTION', basisAmount: '0.001', computedFee: '0.000004', asset: 'BTC' },
    })
    createdObligationIds.push(obligation.id)
    return { escrow, trade, policy, obligation }
  }

  it('T-E (canonical #245 window): concurrent conflicting broadcasts for the same obligation - exactly one wins atomically, the loser leaves ZERO orphaned evidence (proves rollback, not a half-committed crash state)', async () => {
    pg.requirePostgres('canonical window - concurrent conflicting broadcasts')
    const { obligation } = await makeObligationOnly('e')
    const A = { txid: 'a'.repeat(64), vout: 1, scriptPubKey: 'deadbeef', amountSats: 4000 }
    const B = { txid: 'b'.repeat(64), vout: 1, scriptPubKey: 'cafebabe', amountSats: 4000 }

    const results = await Promise.allSettled([
      feeCollectionRecognitionService.recordBroadcastAndAdvance(obligation.id, A),
      feeCollectionRecognitionService.recordBroadcastAndAdvance(obligation.id, B),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    expect(fulfilled).toHaveLength(1) // exactly one winner

    const updated = await prisma.feeObligation.findUniqueOrThrow({ where: { id: obligation.id } })
    expect(updated.collectionStatus).toBe('IN_PROGRESS')
    const evidence = await prisma.feeCollectionEvidence.findMany({ where: { feeObligationId: obligation.id } })
    expect(evidence).toHaveLength(1) // the LOSER's evidence insert was rolled back with its own transaction, not left orphaned
    expect([A.txid, B.txid]).toContain(evidence[0].txid)
  })

  it('T-L (repeated reconciliation): retrying the EXACT same broadcast after it already converged is an idempotent no-op - no duplicate evidence, no re-transition', async () => {
    pg.requirePostgres('idempotent retry same broadcast')
    const { obligation } = await makeObligationOnly('l')
    const evidence = { txid: 'c'.repeat(64), vout: 0, scriptPubKey: 'aa', amountSats: 4000 }

    await feeCollectionRecognitionService.recordBroadcastAndAdvance(obligation.id, evidence)
    for (let i = 0; i < 4; i++) await feeCollectionRecognitionService.recordBroadcastAndAdvance(obligation.id, evidence)

    const rows = await prisma.feeCollectionEvidence.findMany({ where: { feeObligationId: obligation.id } })
    expect(rows).toHaveLength(1)
    expect((await prisma.feeObligation.findUniqueOrThrow({ where: { id: obligation.id } })).collectionStatus).toBe('IN_PROGRESS')
  })

  it('T-J (contradictory evidence): a retry with a DIFFERENT txid than what is already durably recorded fails closed, never silently accepted', async () => {
    pg.requirePostgres('contradictory evidence fails closed')
    const { obligation } = await makeObligationOnly('j')
    await feeCollectionRecognitionService.recordBroadcastAndAdvance(obligation.id, { txid: 'd'.repeat(64), vout: 0, scriptPubKey: 'aa', amountSats: 4000 })

    await expect(feeCollectionRecognitionService.recordBroadcastAndAdvance(obligation.id, { txid: 'e'.repeat(64), vout: 0, scriptPubKey: 'aa', amountSats: 4000 }))
      .rejects.toThrow(/refusing to record contradictory evidence/)

    const rows = await prisma.feeCollectionEvidence.findMany({ where: { feeObligationId: obligation.id } })
    expect(rows).toHaveLength(1)
    expect(rows[0].txid).toBe('d'.repeat(64))
  })

  it('T-I (malformed/missing obligation): fails closed without writing anything', async () => {
    pg.requirePostgres('missing obligation fails closed')
    await expect(feeCollectionRecognitionService.recordBroadcastAndAdvance(randomUUID(), { txid: 'f'.repeat(64), vout: 0, scriptPubKey: 'aa', amountSats: 4000 }))
      .rejects.toThrow(/not found/)
  })

  it('T-N (two independent reconciler-shaped callers racing the SAME obligation converge on one result)', async () => {
    pg.requirePostgres('two independent callers race')
    const { obligation } = await makeObligationOnly('n')
    const evidence = { txid: 'g'.repeat(64), vout: 0, scriptPubKey: 'aa', amountSats: 4000 }

    // instanceB is a genuinely independent module graph (its own fee-collection-recognition.service
    // singleton instance), not the same object called twice.
    let instanceBService: typeof feeCollectionRecognitionService | undefined
    jest.isolateModules(() => {
      instanceBService = require('../../src/modules/open-settlement/fee-collection-recognition.service').feeCollectionRecognitionService
    })

    const [ra, rb] = await Promise.allSettled([
      feeCollectionRecognitionService.recordBroadcastAndAdvance(obligation.id, evidence),
      instanceBService!.recordBroadcastAndAdvance(obligation.id, evidence),
    ])
    // Both may succeed (idempotent convergence) or one may see the other's commit mid-flight and
    // legitimately race the CAS - either way there is exactly one evidence row and one IN_PROGRESS state.
    expect([ra.status, rb.status]).not.toEqual(['rejected', 'rejected'])
    const rows = await prisma.feeCollectionEvidence.findMany({ where: { feeObligationId: obligation.id } })
    expect(rows).toHaveLength(1)
    expect((await prisma.feeObligation.findUniqueOrThrow({ where: { id: obligation.id } })).collectionStatus).toBe('IN_PROGRESS')
  })

  // ── Layer 2: the retry-TRIGGER fix - reconcileMissingCompletionEffects()'s independent recovery ──

  async function makeStuckMultisigEscrow(suffix: string, opts: { feeSats?: number } = {}) {
    const feeSats = opts.feeSats ?? 4000
    const { escrow, trade, obligation } = await makeObligationOnly(suffix)
    const psbt = buildPsbtWithFeeOutput(feeSats, 96_000)
    const txReleaseId = `${suffix}${'0'.repeat(64)}`.slice(0, 64)
    // The settlement itself already fully converged (write-once txReleaseId set, EscrowEvent exists,
    // status terminal) - exactly the state a crash strictly inside the fee-recording sub-step leaves,
    // now that its own pending row is deliberately kept alive (Issue #245) instead of being deleted
    // out from under a later retry.
    await prisma.escrow.update({ where: { id: escrow.id }, data: { status: 'COMPLETED', txReleaseId, releasedAt: new Date() } })
    await prisma.escrowEvent.create({
      data: { escrowId: escrow.id, fromStatus: 'PAYMENT_PENDING', toStatus: 'COMPLETED', triggeredBy: trade.sellerId, entryHash: 'h' + randomUUID(), prevHash: 'genesis' },
    })
    const pending = await prisma.escrowPendingTransaction.create({
      data: {
        escrowId: escrow.id, kind: 'release', toAddress: BUYER_ADDRESS, requiredSigners: [trade.buyerId, trade.sellerId],
        triggeredBy: trade.sellerId, unsignedPsbtBase64: psbt, feeCollectionSats: feeSats, feeCollectionWaived: false,
      },
    })
    return { escrow, trade, obligation, pending, txReleaseId }
  }

  it('T-E full stack: the fee-recording retry trigger fires even though the settlement itself already fully completed (EscrowEvent exists) - converges exactly once, then cleans up the pending row', async () => {
    pg.requirePostgres('full stack retry trigger')
    const f = await makeStuckMultisigEscrow('fullstack')

    const report = await reconcilePendingSettlements({ projectionGraceMs: 0 })
    expect(report.completionEffectsRecovered.some((r) => r.escrowId === f.escrow.id)).toBe(true)

    const obligation = await prisma.feeObligation.findUniqueOrThrow({ where: { id: f.obligation.id } })
    expect(obligation.collectionStatus).toBe('IN_PROGRESS')
    const evidence = await prisma.feeCollectionEvidence.findMany({ where: { feeObligationId: f.obligation.id } })
    expect(evidence).toHaveLength(1)
    expect(evidence[0].kind).toBe('BROADCAST')
    expect(evidence[0].txid).toBe(f.txReleaseId)
    // pending row's only remaining purpose (surviving as the PSBT source for this exact retry) is
    // now fulfilled - cleaned up.
    expect(await prisma.escrowPendingTransaction.findUnique({ where: { escrowId: f.escrow.id } })).toBeNull()
  })

  it('repeated reconciliation after convergence is idempotent - no duplicate evidence, no re-transition, pending row stays deleted', async () => {
    pg.requirePostgres('repeated reconciliation idempotent')
    const f = await makeStuckMultisigEscrow('repeat')
    await reconcilePendingSettlements({ projectionGraceMs: 0 })

    for (let i = 0; i < 4; i++) await reconcilePendingSettlements({ projectionGraceMs: 0 })

    const evidence = await prisma.feeCollectionEvidence.findMany({ where: { feeObligationId: f.obligation.id } })
    expect(evidence).toHaveLength(1)
    expect((await prisma.feeObligation.findUniqueOrThrow({ where: { id: f.obligation.id } })).collectionStatus).toBe('IN_PROGRESS')
  })

  it('two independent reconciler instances race the same stuck fee obligation: converge on one result, no duplicate evidence', async () => {
    pg.requirePostgres('two reconcilers race stuck fee obligation')
    const f = await makeStuckMultisigEscrow('race')

    const [ra, rb] = await Promise.all([
      reconcilePendingSettlements({ projectionGraceMs: 0 }),
      instanceB!.reconcile({ projectionGraceMs: 0 }),
    ])
    expect(ra.failed.filter((x) => x.escrowId === f.escrow.id)).toEqual([])
    expect(rb.failed.filter((x) => x.escrowId === f.escrow.id)).toEqual([])

    const evidence = await prisma.feeCollectionEvidence.findMany({ where: { feeObligationId: f.obligation.id } })
    expect(evidence).toHaveLength(1)
    expect((await prisma.feeObligation.findUniqueOrThrow({ where: { id: f.obligation.id } })).collectionStatus).toBe('IN_PROGRESS')
  })

  it('genuine restart: an independent module graph converges durable PostgreSQL state it never created', async () => {
    pg.requirePostgres('genuine restart reads durable state')
    const f = await makeStuckMultisigEscrow('restart')

    const report = await instanceB!.reconcile({ projectionGraceMs: 0 })
    expect(report.completionEffectsRecovered.some((r) => r.escrowId === f.escrow.id)).toBe(true)
    expect((await prisma.feeObligation.findUniqueOrThrow({ where: { id: f.obligation.id } })).collectionStatus).toBe('IN_PROGRESS')
  })

  it('malformed evidence (fee output amount does not match what the PSBT actually built): fails closed, FeeObligation stays PENDING_COLLECTION, pending row is preserved for a corrected retry', async () => {
    pg.requirePostgres('malformed fee output fails closed')
    // feeCollectionSats on the pending row (5000) does not match what the PSBT's own fee output
    // actually carries (4000, from buildPsbtWithFeeOutput's own default) - identifyFeeOutput() must
    // fail closed (ambiguous/wrong amount) rather than guess.
    const { escrow, trade, obligation } = await makeObligationOnly('malformed')
    const psbt = buildPsbtWithFeeOutput(4000, 96_000)
    await prisma.escrow.update({ where: { id: escrow.id }, data: { status: 'COMPLETED', txReleaseId: 'm'.repeat(64), releasedAt: new Date() } })
    await prisma.escrowEvent.create({ data: { escrowId: escrow.id, fromStatus: 'PAYMENT_PENDING', toStatus: 'COMPLETED', triggeredBy: trade.sellerId, entryHash: 'h' + randomUUID(), prevHash: 'genesis' } })
    await prisma.escrowPendingTransaction.create({
      data: { escrowId: escrow.id, kind: 'release', toAddress: BUYER_ADDRESS, requiredSigners: [trade.buyerId, trade.sellerId], triggeredBy: trade.sellerId, unsignedPsbtBase64: psbt, feeCollectionSats: 5000, feeCollectionWaived: false },
    })

    await reconcilePendingSettlements({ projectionGraceMs: 0 })

    expect((await prisma.feeObligation.findUniqueOrThrow({ where: { id: obligation.id } })).collectionStatus).toBe('PENDING_COLLECTION')
    expect(await prisma.feeCollectionEvidence.count({ where: { feeObligationId: obligation.id } })).toBe(0)
    // pending row preserved - a corrected retry (e.g. after fixing the recorded feeCollectionSats) remains possible.
    expect(await prisma.escrowPendingTransaction.findUnique({ where: { escrowId: escrow.id } })).not.toBeNull()
  })
})
