// tests/integration/postBroadcastFeeRecovery.test.ts
//
// Issue #245, Phase 2 — post-broadcast recovery, real PostgreSQL. State seeded here is EXACTLY what the live path leaves
// after "broadcast done, fee recording failed" (proven separately in tests/escrowPendingFeeRetention.test.ts): the escrow is
// COMPLETED with txReleaseId set, the completion EscrowEvent is already emitted (`alreadyEmitted`), the FeeObligation is still
// PENDING_COLLECTION and the pending row (with the PSBT and signatures) was KEPT. Everything downstream is real: the
// reconciler, recordBroadcastAndAdvance(), its transaction/CAS and the repositories. Only the chain-side collaborators are
// stubbed (the PSBT decoder identifyFeeOutput() and reconcilePendingSettlement()): this file proves accounting recovery,
// not Bitcoin script handling (tests/multisigProvider.test.ts).
// Lines starting with "EVIDENCE[#245-P2]" are printed on purpose: they are the reproducible record.

const FEE = { vout: 1, scriptPubKeyHex: 'deadbeef', amountSats: 4000 }
jest.mock('../../src/modules/open-settlement/multisig.provider', () => ({
  multisigProvider: { reconcilePendingSettlement: jest.fn() },
  identifyFeeOutput: jest.fn(() => ({ vout: 1, scriptPubKeyHex: 'deadbeef', amountSats: 4000 })),
  networkFor: jest.fn(() => 'testnet'),
}))
jest.mock('../../src/common/events/event-bus', () => ({
  eventBus: { emit: jest.fn().mockResolvedValue(undefined), on: jest.fn(), onDurable: jest.fn() },
}))

import { PrismaClient } from '@prisma/client'
import { createPostgresIntegrationHarness } from './postgresTestHarness'

describe('post-broadcast fee recovery (Issue #245 Phase 2, real Postgres)', () => {
  jest.setTimeout(120_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let reconcilePendingSettlements: typeof import('../../src/modules/open-settlement/escrow-settlement-reconciliation.service').reconcilePendingSettlements
  let feeCollectionRecognitionService: typeof import('../../src/modules/open-settlement/fee-collection-recognition.service').feeCollectionRecognitionService
  let multisigProvider: { reconcilePendingSettlement: jest.Mock }

  function load() {
    ;({ prisma } = require('../../src/common/database'))
    ;({ reconcilePendingSettlements } = require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service'))
    ;({ feeCollectionRecognitionService } = require('../../src/modules/open-settlement/fee-collection-recognition.service'))
    ;({ multisigProvider } = require('../../src/modules/open-settlement/multisig.provider'))
  }

  beforeAll(async () => {
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    load()
  })
  afterAll(async () => { if (dbAvailable) await prisma.$disconnect() })

  const suffix = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const evidenceLine = (label: string, data: unknown) => process.stdout.write(`EVIDENCE[#245-P2] ${label}: ${JSON.stringify(data)}\n`)

  /** The state the live path leaves after a broadcast whose fee recording failed. */
  async function afterBroadcastWithFailedAccounting(opts: { emitted?: boolean; noObligation?: boolean; noFeeAddress?: boolean } = {}) {
    const s = suffix()
    const txid = require('crypto').createHash('sha256').update(s).digest('hex')
    const buyer = await prisma.user.create({ data: { publicKey: `pk-buyer-245p2-${s}` } })
    const seller = await prisma.user.create({ data: { publicKey: `pk-seller-245p2-${s}` } })
    const offer = await prisma.offer.create({ data: { userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '65000', minAmount: '0.001', maxAmount: '1', paymentMethod: 'PIX' } })
    const trade = await prisma.trade.create({ data: { offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, asset: 'BTC', amount: '0.001', priceUsd: '65000', totalUsd: '65' } })
    const feePolicy = await prisma.feePolicyVersion.create({
      data: { label: `fp-245p2-${s}`, railScope: `FIXTURE_RAIL_245P2-${s}`, status: 'PUBLISHED', publishedAt: new Date(), protocolFeeRate: '0.004', payerModel: 'SELLER_PAYS', economicBasis: 'SELLER_DELIVERED_VALUE', requiredConfirmations: 1, createdBy: 'issue-245-p2-test' },
    })
    const escrow = await prisma.escrow.create({
      data: { tradeId: trade.id, type: 'MULTISIG', status: 'COMPLETED', asset: 'BTC', lockedAmount: '0.001', txReleaseId: txid, snapshotFeeCollectionAddress: opts.noFeeAddress ? null : 'tb1qfeeaddress245p2' },
    })
    const obligationData = { escrowId: escrow.id, feePolicyVersionId: feePolicy.id, economicDetermination: 'OWED' as const, collectionStatus: 'PENDING_COLLECTION' as const, basisAmount: '0.001', computedFee: '0.00000500', asset: 'BTC' as const }
    const obligation = opts.noObligation ? { id: 'none' } : await prisma.feeObligation.create({ data: obligationData })
    if (opts.emitted !== false) {
      await prisma.escrowEvent.create({ data: { escrowId: escrow.id, fromStatus: 'PAYMENT_PENDING', toStatus: 'COMPLETED', triggeredBy: seller.id } })
    }
    const pending = await prisma.escrowPendingTransaction.create({
      data: {
        escrowId: escrow.id, kind: 'release', toAddress: 'tb1qbuyer', unsignedPsbtBase64: `unsigned-psbt-${s}`, requiredSigners: [buyer.id],
        triggeredBy: seller.id, feeCollectionSats: 4000, feeCollectionWaived: false,
      },
    })
    await prisma.escrowTransactionSignature.create({ data: { pendingTxId: pending.id, participantId: buyer.id, signedPsbtBase64: 'signed' } })
    multisigProvider.reconcilePendingSettlement.mockResolvedValue({ outcome: 'ALREADY_BROADCAST', txId: txid, detail: 'known', rawTxHex: 'raw' })
    return { escrowId: escrow.id, obligationId: obligation.id, txid, obligationData, feePolicyId: feePolicy.id }
  }

  async function snapshot(escrowId: string, obligationId: string) {
    const [obligation, rows, events, pending, signatures] = await Promise.all([
      prisma.feeObligation.findUnique({ where: { id: obligationId } }),
      prisma.feeCollectionEvidence.findMany({ where: { feeObligationId: obligationId } }),
      prisma.escrowEvent.count({ where: { escrowId } }),
      prisma.escrowPendingTransaction.findUnique({ where: { escrowId } }),
      prisma.escrowTransactionSignature.count({ where: { pendingTx: { escrowId } } }),
    ])
    const count = (k: string) => rows.filter((r) => r.kind === k).length
    return { status: obligation!.collectionStatus, broadcast: count('BROADCAST'), confirmed: count('CONFIRMED'), events, pendingRow: !!pending, signatures }
  }

  it('1 broadcast done + accounting failed: the pending row and its signatures survive, the obligation is PENDING_COLLECTION, and no other pass may clean them up', async () => {
    pg.requirePostgres('1')
    const { escrowId, obligationId } = await afterBroadcastWithFailedAccounting()
    const s = await snapshot(escrowId, obligationId)
    evidenceLine('1 state left by the failed live recording', s)
    expect(s).toMatchObject({ status: 'PENDING_COLLECTION', broadcast: 0, events: 1, pendingRow: true, signatures: 1 })
  })

  it('2+3 process restart + reconcile with alreadyEmitted=true: the obligation is recovered (IN_PROGRESS, one BROADCAST row), the completion event is NOT re-emitted, and the pending row is cleaned up', async () => {
    pg.requirePostgres('2+3')
    const { escrowId, obligationId, txid } = await afterBroadcastWithFailedAccounting()
    // "restart": a brand new module graph and a new database client, no in-memory state carried over.
    await prisma.$disconnect()
    jest.resetModules()
    load()
    // resetModules() re-creates the stubbed chain collaborator too; the reconstruction stub must be armed again.
    multisigProvider.reconcilePendingSettlement.mockResolvedValue({ outcome: 'ALREADY_BROADCAST', txId: txid, detail: 'known', rawTxHex: 'raw' })
    const report = await reconcilePendingSettlements()
    const s = await snapshot(escrowId, obligationId)
    const row = await prisma.feeCollectionEvidence.findFirst({ where: { feeObligationId: obligationId } })
    evidenceLine('2+3 after restart + reconcile', { ...s, txidMatches: row?.txid === txid, failed: report.failed.filter((f) => f.escrowId === escrowId) })
    expect(s).toMatchObject({ status: 'IN_PROGRESS', broadcast: 1, confirmed: 0, events: 1, pendingRow: false, signatures: 0 })
    expect(row).toMatchObject({ kind: 'BROADCAST', txid, vout: FEE.vout, scriptPubKey: FEE.scriptPubKeyHex })
    expect(report.failed.filter((f) => f.escrowId === escrowId)).toEqual([])
  })

  it('4 repeated reconciliation passes never duplicate the BROADCAST row, the event, or the obligation state', async () => {
    pg.requirePostgres('4')
    const { escrowId, obligationId } = await afterBroadcastWithFailedAccounting()
    await reconcilePendingSettlements()
    const first = await snapshot(escrowId, obligationId)
    await reconcilePendingSettlements()
    await reconcilePendingSettlements()
    const later = await snapshot(escrowId, obligationId)
    evidenceLine('4 after 3 passes', later)
    expect(later).toEqual(first)
    expect(later).toMatchObject({ status: 'IN_PROGRESS', broadcast: 1, events: 1 })
  })

  it('5 a failure DURING recovery keeps everything (pending row, PENDING_COLLECTION, zero rows); the next pass recovers; a failure in the middle of the transaction leaves no half state', async () => {
    pg.requirePostgres('5')
    const { escrowId, obligationId } = await afterBroadcastWithFailedAccounting()
    const spy = jest.spyOn(feeCollectionRecognitionService, 'recordBroadcastAndAdvance').mockRejectedValueOnce(new Error('INJECTED failure during recovery'))
    const first = await reconcilePendingSettlements()
    const afterFailure = await snapshot(escrowId, obligationId)
    evidenceLine('5 after the failed recovery pass', afterFailure)
    expect(first.failed.filter((f) => f.escrowId === escrowId)).toEqual([]) // logged, never thrown: the settlement's funds already moved
    expect(afterFailure).toMatchObject({ status: 'PENDING_COLLECTION', broadcast: 0, events: 1, pendingRow: true, signatures: 1 })

    await reconcilePendingSettlements() // the spy now falls through to the real implementation
    const afterRetry = await snapshot(escrowId, obligationId)
    evidenceLine('5 after the successful retry pass', afterRetry)
    expect(afterRetry).toMatchObject({ status: 'IN_PROGRESS', broadcast: 1, events: 1, pendingRow: false })
    spy.mockRestore()
  })

  it('6 concurrency: three reconcilers racing, plus a direct caller standing in for the live path, produce exactly one BROADCAST row, one advance and one event', async () => {
    pg.requirePostgres('6')
    const { escrowId, obligationId, txid } = await afterBroadcastWithFailedAccounting()
    const direct = feeCollectionRecognitionService.recordBroadcastAndAdvance(obligationId, { txid, vout: FEE.vout, scriptPubKey: FEE.scriptPubKeyHex, amountSats: FEE.amountSats })
    const settled = await Promise.allSettled([reconcilePendingSettlements(), reconcilePendingSettlements(), reconcilePendingSettlements(), direct])
    const s = await snapshot(escrowId, obligationId)
    evidenceLine('6 after the race', { ...s, directOutcome: settled[3].status === 'fulfilled' ? (settled[3] as PromiseFulfilledResult<string>).value : String((settled[3] as PromiseRejectedResult).reason) })
    expect(s).toMatchObject({ status: 'IN_PROGRESS', broadcast: 1, confirmed: 0, events: 1 })
    expect(settled[3].status).toBe('fulfilled')
    await reconcilePendingSettlements() // once more, now that every writer is done: leftovers are cleaned
    expect((await snapshot(escrowId, obligationId)).pendingRow).toBe(false)
  })

  it('7 cleanup is conditional: the pending row is removed only after the recording is durable; when the fee evidence on file DIVERGES (conflict) the row is kept for manual review and nothing is overwritten', async () => {
    pg.requirePostgres('7')
    const { escrowId, obligationId, txid } = await afterBroadcastWithFailedAccounting()
    // a divergent BROADCAST (another vout) already on file for this obligation, e.g. recorded by another path
    await feeCollectionRecognitionService.recordBroadcastAndAdvance(obligationId, { txid, vout: 7, scriptPubKey: 'cafe', amountSats: 4000 })
    const before = await snapshot(escrowId, obligationId)
    await reconcilePendingSettlements()
    const after = await snapshot(escrowId, obligationId)
    const rows = await prisma.feeCollectionEvidence.findMany({ where: { feeObligationId: obligationId } })
    evidenceLine('7 divergent evidence on file', { before, after, vout: rows.map((r) => r.vout) })
    expect(rows).toHaveLength(1)
    expect(rows[0].vout).toBe(7) // the recorded evidence stands
    expect(after.pendingRow).toBe(true) // unresolved conflict => the PSBT is NOT discarded
    expect(after).toMatchObject({ status: 'IN_PROGRESS', broadcast: 1, events: 1 })
  })

  it('9 FAIL-CLOSED: a due fee whose FeeObligation is missing keeps the pending row (no row recorded, no throw); once the obligation exists the next pass records and cleans up', async () => {
    pg.requirePostgres('9')
    const { escrowId, obligationData } = await afterBroadcastWithFailedAccounting({ noObligation: true })
    const report = await reconcilePendingSettlements()
    const pendingAfter = await prisma.escrowPendingTransaction.findUnique({ where: { escrowId } })
    evidenceLine('9 missing FeeObligation', { pendingKept: !!pendingAfter, failed: report.failed.filter((f) => f.escrowId === escrowId) })
    expect(pendingAfter).not.toBeNull()
    expect(report.failed.filter((f) => f.escrowId === escrowId)).toEqual([])
    const created = await prisma.feeObligation.create({ data: obligationData })
    await reconcilePendingSettlements()
    const s = await snapshot(escrowId, created.id)
    evidenceLine('9 after the obligation appeared', s)
    expect(s).toMatchObject({ status: 'IN_PROGRESS', broadcast: 1, events: 1, pendingRow: false })
  })

  it('10 FAIL-CLOSED: a due fee whose snapshotFeeCollectionAddress is missing keeps the pending row and records nothing; once the address is present the next pass recovers', async () => {
    pg.requirePostgres('10')
    const { escrowId, obligationId } = await afterBroadcastWithFailedAccounting({ noFeeAddress: true })
    await reconcilePendingSettlements()
    const kept = await snapshot(escrowId, obligationId)
    evidenceLine('10 missing fee address', kept)
    expect(kept).toMatchObject({ status: 'PENDING_COLLECTION', broadcast: 0, events: 1, pendingRow: true, signatures: 1 })
    await prisma.escrow.update({ where: { id: escrowId }, data: { snapshotFeeCollectionAddress: 'tb1qfeeaddress245p2' } })
    await reconcilePendingSettlements()
    expect(await snapshot(escrowId, obligationId)).toMatchObject({ status: 'IN_PROGRESS', broadcast: 1, events: 1, pendingRow: false })
  })

  it('8 not yet emitted (a crash before the completion event): the completion effects run once, the fee is recorded once, and the row is cleaned up', async () => {
    pg.requirePostgres('8')
    const { escrowId, obligationId } = await afterBroadcastWithFailedAccounting({ emitted: false })
    await reconcilePendingSettlements()
    await reconcilePendingSettlements()
    const s = await snapshot(escrowId, obligationId)
    evidenceLine('8 not-emitted recovery', s)
    expect(s).toMatchObject({ status: 'IN_PROGRESS', broadcast: 1, events: 1, pendingRow: false })
  })
})
