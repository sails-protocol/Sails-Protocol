// tests/integration/atomicCollectionRecognition.test.ts
//
// Missão 11 Fase 7.2.1 — real-Postgres adversarial proof of
// recognizeConfirmation()'s transaction-integrity hardening.
//
// Direct reproduction (this phase's own §A/§B audit, performed by hand
// before this file existed) confirmed the PRE-fix shape — two separate
// top-level writes (CONFIRMED-evidence insert, then the IN_PROGRESS ->
// COLLECTED transition) — could produce two CONFIRMED rows for the SAME
// on-chain confirmation event, independently frozen to DIFFERENT
// DistributionPolicyVersions, if a crash (or a losing concurrent caller)
// landed between the two writes and a policy rotation happened before the
// real periodic sweep job's automatic retry (multisig-fee-confirmation-
// job.ts re-selects any still-IN_PROGRESS obligation every tick — this is
// that job's own normal recovery behavior, not a hypothetical). This file
// proves the fix: both writes now commit inside one prisma.$transaction
// (fee-collection-recognition.service.ts's own header comment has the
// full design rationale), so a crash/rollback anywhere in that window
// leaves NO trace, and a subsequent retry is genuinely fresh.
//
// tests/integration/collectedTimeDistributionFreeze.test.ts already
// covers normal-path convergence, reorg/reconfirmation, and permanent
// zero-policy semantics under the atomic version — not duplicated here.

import { PrismaClient, Prisma } from '@prisma/client'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { boundOfferRow, boundTradeRow, sellerPixAccount } from './economicFixtures'

describe('recognizeConfirmation() atomicity (Missão 11 Fase 7.2.1, real Postgres)', () => {
  jest.setTimeout(60_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let distributionPolicyService: typeof import('../../src/modules/open-settlement/distribution-policy.service').distributionPolicyService
  let distributionRecipientRepository: typeof import('../../src/modules/open-settlement/distribution-recipient-repository').distributionRecipientRepository
  let feeCollectionRecognitionService: typeof import('../../src/modules/open-settlement/fee-collection-recognition.service').feeCollectionRecognitionService
  let feeCollectionEvidenceRepository: typeof import('../../src/modules/open-settlement/fee-collection-evidence-repository').feeCollectionEvidenceRepository

  beforeAll(async () => {
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ distributionPolicyService } = require('../../src/modules/open-settlement/distribution-policy.service'))
    ;({ distributionRecipientRepository } = require('../../src/modules/open-settlement/distribution-recipient-repository'))
    ;({ feeCollectionRecognitionService } = require('../../src/modules/open-settlement/fee-collection-recognition.service'))
    ;({ feeCollectionEvidenceRepository } = require('../../src/modules/open-settlement/fee-collection-evidence-repository'))
  })

  afterAll(async () => {
    if (dbAvailable) await prisma.$disconnect()
  })

  function requirePostgres(name: string): void {
    pg.requirePostgres(name)
  }

  function suffix() { return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }

  async function retireLivePolicyIfAny() {
    const live = await distributionPolicyService.findLivePolicy()
    if (live) await distributionPolicyService.retire(live.id)
  }

  async function publish100PctPolicy(): Promise<string> {
    await retireLivePolicyIfAny()
    const r = await distributionRecipientRepository.create({ class: `ATOMIC_${suffix().toUpperCase().replace(/[^A-Z0-9]/g, '')}`, label: 'atomic-fixture-recipient' })
    const draft = await distributionPolicyService.createDraft({ label: `atomic-policy-${suffix()}`, createdBy: 'fase7-2-1-atomicity-test' })
    await distributionPolicyService.addRecipient(draft.id, r.id, '100')
    const published = await distributionPolicyService.publish(draft.id)
    return published.id
  }

  async function fixtureObligation(escrowType: 'MOCK' | 'MULTISIG' = 'MOCK'): Promise<{ obligationId: string; txid: string }> {
    const s = suffix()
    const buyer = await prisma.user.create({ data: { publicKey: `pk-buyer-atomic-${s}` } })
    const seller = await prisma.user.create({ data: { publicKey: `pk-seller-atomic-${s}` } })
    const acct = await sellerPixAccount(prisma, seller.id)
    const offer = await prisma.offer.create({ data: { userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '65000', minAmount: '0.001', maxAmount: '1', ...boundOfferRow(acct) } })
    const trade = await prisma.trade.create({ data: { ...boundTradeRow(acct), offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, asset: 'BTC', amount: '0.001', priceUsd: '65000', totalUsd: '65' } })
    const railScope = `FIXTURE_RAIL_ATOMICITY-${s}`
    const feePolicy = await prisma.feePolicyVersion.create({
      data: { label: `atomic-feepolicy-${s}`, railScope, status: 'PUBLISHED', publishedAt: new Date(), protocolFeeRate: '0.004', payerModel: 'SELLER_PAYS', economicBasis: 'SELLER_DELIVERED_VALUE', requiredConfirmations: 1, createdBy: 'fase7-2-1-atomicity-test' },
    })
    const escrow = await prisma.escrow.create({ data: { tradeId: trade.id, type: escrowType, asset: 'BTC', lockedAmount: '0.001' } })
    const obligation = await prisma.feeObligation.create({
      data: { escrowId: escrow.id, feePolicyVersionId: feePolicy.id, economicDetermination: 'OWED', collectionStatus: 'PENDING_COLLECTION', basisAmount: '0.001', computedFee: '0.00000500', asset: 'BTC' },
    })
    const txid = require('crypto').createHash('sha256').update(obligation.id + s).digest('hex')
    await feeCollectionRecognitionService.recordBroadcastAndAdvance(obligation.id, { txid, vout: 1, scriptPubKey: 'deadbeef', amountSats: 1 })
    return { obligationId: obligation.id, txid }
  }

  // ─── Items 2/3/6: simulated crash inside the transaction rolls back  ────
  // ─── BOTH writes; a subsequent retry is genuinely fresh and reflects ────
  // ─── whatever policy is live AT RETRY TIME — never a resurrected P1. ────
  it('a simulated crash between the CONFIRMED-insert and the COLLECTED-transition rolls back both writes; retry never duplicates and never resurrects the rolled-back policy', async () => {
    requirePostgres('simulated crash + retry')
    const p1 = await publish100PctPolicy()
    const { obligationId, txid } = await fixtureObligation()

    // Simulate "process died mid-transaction": perform the exact same two
    // writes recognizeConfirmation() would, inside a real transaction,
    // then force a throw before it can commit — Postgres rolls back
    // everything in that transaction, which is indistinguishable from a
    // real crash from the database's point of view (an uncommitted
    // transaction never partially persists).
    await expect(
      prisma.$transaction(async (tx) => {
        await feeCollectionEvidenceRepository.record({
          feeObligationId: obligationId, kind: 'CONFIRMED', txid, vout: 1, scriptPubKey: 'deadbeef', amount: '0.00000001',
          confirmedAtHeight: 800000, distributionPolicyVersionId: p1,
        }, tx)
        await tx.feeObligation.updateMany({ where: { id: obligationId, collectionStatus: 'IN_PROGRESS' }, data: { collectionStatus: 'COLLECTED' } })
        throw new Error('SIMULATED CRASH — must never commit')
      })
    ).rejects.toThrow('SIMULATED CRASH')

    // Nothing persisted — the rollback was total, not partial.
    const confirmedRowsAfterCrash = await prisma.feeCollectionEvidence.findMany({ where: { feeObligationId: obligationId, kind: 'CONFIRMED' } })
    expect(confirmedRowsAfterCrash).toHaveLength(0)
    const obligationAfterCrash = await prisma.feeObligation.findUnique({ where: { id: obligationId } })
    expect(obligationAfterCrash!.collectionStatus).toBe('IN_PROGRESS')

    // Policy rotation during the "crash window."
    await distributionPolicyService.retire(p1)
    const p2 = await publish100PctPolicy()

    // Retry through the REAL entrypoint — exactly what the periodic sweep
    // job would do on its next tick, since the obligation is still
    // IN_PROGRESS.
    await feeCollectionRecognitionService.recognizeConfirmation(obligationId, txid, 800000)

    // Exactly ONE CONFIRMED row — no orphan from the crashed attempt —
    // frozen to whatever was live AT RETRY TIME (P2), never P1.
    const confirmedRowsAfterRetry = await prisma.feeCollectionEvidence.findMany({ where: { feeObligationId: obligationId, kind: 'CONFIRMED' } })
    expect(confirmedRowsAfterRetry).toHaveLength(1)
    expect(confirmedRowsAfterRetry[0].distributionPolicyVersionId).toBe(p2)
    const obligationAfterRetry = await prisma.feeObligation.findUnique({ where: { id: obligationId } })
    expect(obligationAfterRetry!.collectionStatus).toBe('COLLECTED')
  })

  // ─── Items 4/5/9: concurrent recognition attempts for the SAME ──────────
  // ─── confirmation cannot produce competing CONFIRMED generations or ─────
  // ─── duplicate entitlement. ──────────────────────────────────────────────
  it('two concurrent recognizeConfirmation() calls for the same obligation+txid: exactly one wins, exactly one CONFIRMED row exists, no duplicate entitlement possible', async () => {
    requirePostgres('concurrent recognition race')
    await publish100PctPolicy()
    const { obligationId, txid } = await fixtureObligation()

    const results = await Promise.allSettled([
      feeCollectionRecognitionService.recognizeConfirmation(obligationId, txid, 800000),
      feeCollectionRecognitionService.recognizeConfirmation(obligationId, txid, 800000),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)

    // Exactly one CONFIRMED row — the loser's own evidence insert rolled
    // back along with its failed transition claim, inside its own
    // transaction. Before the Fase 7.2.1 fix this would have been 2.
    const confirmedRows = await prisma.feeCollectionEvidence.findMany({ where: { feeObligationId: obligationId, kind: 'CONFIRMED' } })
    expect(confirmedRows).toHaveLength(1)

    const obligation = await prisma.feeObligation.findUnique({ where: { id: obligationId } })
    expect(obligation!.collectionStatus).toBe('COLLECTED')

    // Allocation can only ever find the one real generation — structurally
    // safe from duplicate entitlement, not merely by allocate()'s own
    // tie-break convention.
    const { entitlementAllocationService } = require('../../src/modules/open-settlement/entitlement-allocation.service')
    const entries = await entitlementAllocationService.allocate(obligationId)
    expect(entries).toHaveLength(1)
  })
  // ─── Production sweeper hardening: sweepMultisigFeeConfirmations() as startServer() schedules it ───────────
  it('two independent nodes ticking the real fee-confirmation sweep through startGuardedInterval() for many intervals recognize the confirmation exactly once: one CONFIRMED row, one COLLECTED transition', async () => {
    requirePostgres('scheduled fee confirmation sweep - two instances')
    await publish100PctPolicy()
    const { obligationId, txid } = await fixtureObligation('MULTISIG')
    // The explorer says: confirmed at the tip (1 of 1 required), and the broadcast output (vout 1, script
    // deadbeef, 1 sat - what fixtureObligation() recorded) is exactly what the chain carries.
    const realFetch = global.fetch
    global.fetch = jest.fn(async (url: string) => {
      if (url.includes('/blocks/tip/height')) return { ok: true, text: async () => '100' } as any
      if (url.endsWith('/status')) return { ok: true, json: async () => ({ confirmed: true, block_height: 100 }) } as any
      if (url.endsWith(`/tx/${txid}`)) return { ok: true, json: async () => ({ vout: [{ scriptpubkey: '00', value: 0 }, { scriptpubkey: 'deadbeef', value: 1 }] }) } as any
      return { ok: true, json: async () => ({ vout: [] }) } as any
    }) as any

    const TICK = 150
    const nodes = [0, 1].map(() => {
      let node!: { stop: () => Promise<void>; errors: unknown[] }
      jest.isolateModules(() => {
        const { startGuardedInterval } = require('../../src/common/guarded-interval')
        const { sweepMultisigFeeConfirmations } = require('../../src/modules/open-settlement/multisig-fee-confirmation-job')
        const db = require('../../src/common/database')
        const redisModule = require('../../src/common/redis')
        const errors: unknown[] = []
        const guarded = startGuardedInterval(() => sweepMultisigFeeConfirmations().then(() => undefined).catch((err: unknown) => { errors.push(err) }), TICK)
        node = {
          errors,
          stop: async () => {
            await guarded.stop()
            await db.prisma.$disconnect()
            await redisModule.redis?.quit?.().catch(() => undefined)
          },
        }
      })
      return node
    })
    try {
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline && (await prisma.feeObligation.findUniqueOrThrow({ where: { id: obligationId } })).collectionStatus !== 'COLLECTED') {
        await new Promise((r) => setTimeout(r, 50))
      }
      await new Promise((r) => setTimeout(r, TICK * 8)) // both nodes keep ticking: every later tick must be a no-op
    } finally {
      await Promise.all(nodes.map((n) => n.stop()))
      global.fetch = realFetch
    }

    expect((await prisma.feeObligation.findUniqueOrThrow({ where: { id: obligationId } })).collectionStatus).toBe('COLLECTED')
    expect(await prisma.feeCollectionEvidence.count({ where: { feeObligationId: obligationId, kind: 'CONFIRMED' } })).toBe(1)
    expect(nodes.flatMap((n) => n.errors)).toEqual([])
  })
})
