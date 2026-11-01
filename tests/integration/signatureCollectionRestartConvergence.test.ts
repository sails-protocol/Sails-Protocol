// tests/integration/signatureCollectionRestartConvergence.test.ts
//
// Issue #240 - real PostgreSQL proof that LIGHTNING_HODL/SAFE_GUARD_EVM's finalize boundary
// (signature-collection-finalization-truth.ts) preserves SUBMISSION_UNKNOWN != FAILED, never
// authorizes a blind resubmission, and that the reconciler (escrow-settlement-reconciliation.service.ts's
// reconcileSignatureCollectionTerminalTransfer()) converges ONLY a durably CONFIRMED attempt, through
// the same frozen write-once/idempotent-completion machinery #291/#294/#298/#251/#250 already use.
//
// Two proof layers:
//   1. The durable primitive itself (ensureFinalizationAttempt/recordFinalizationOutcome) and the
//      reconciler dispatch - both exercised directly against real Postgres rows, no live
//      Ark/bundler infrastructure needed.
//   2. The REAL provider entrypoint (lightningHodlProvider.finalizeRelease/safeGuardEvmProvider.finalizeRelease):
//      a garbage bundle makes bundle-parsing fail deterministically AFTER ensureFinalizationAttempt has
//      already run, so a distinctly different thrown-error message proves whether the external
//      boundary was ever reached versus blocked before it — instrumenting the real entrypoint without
//      needing valid cryptographic material or a live ASP/bundler (neither of which this codebase can
//      safely exercise in CI - see each provider's own finalizeRelease() header comment).

import { PrismaClient } from '@prisma/client'
import { randomBytes, randomUUID } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('Issue #240 - signature-collection provider (LIGHTNING_HODL/SAFE_GUARD_EVM) restart convergence (real PostgreSQL)', () => {
  jest.setTimeout(120_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let liquidityRouter: typeof import('../../src/modules/open-liquidity/liquidity.service').liquidityRouter
  let tradeService: typeof import('../../src/modules/open-p2p/trade.service').tradeService
  let reconcilePendingSettlements: typeof import('../../src/modules/open-settlement/escrow-settlement-reconciliation.service').reconcilePendingSettlements
  let ensureFinalizationAttempt: typeof import('../../src/modules/open-settlement/signature-collection-finalization-truth').ensureFinalizationAttempt
  let recordFinalizationOutcome: typeof import('../../src/modules/open-settlement/signature-collection-finalization-truth').recordFinalizationOutcome
  let lightningHodlProvider: typeof import('../../src/modules/open-settlement/lightning-hodl.provider').lightningHodlProvider
  let safeGuardEvmProvider: typeof import('../../src/modules/open-settlement/safe-guard-evm.provider').safeGuardEvmProvider
  let instanceB: { reconcile: typeof reconcilePendingSettlements; prisma: PrismaClient; redis: { quit(): Promise<unknown> } } | undefined

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'true'
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service'))
    ;({ tradeService } = require('../../src/modules/open-p2p/trade.service'))
    ;({ reconcilePendingSettlements } = require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service'))
    ;({ ensureFinalizationAttempt, recordFinalizationOutcome } = require('../../src/modules/open-settlement/signature-collection-finalization-truth'))
    ;({ lightningHodlProvider } = require('../../src/modules/open-settlement/lightning-hodl.provider'))
    ;({ safeGuardEvmProvider } = require('../../src/modules/open-settlement/safe-guard-evm.provider'))
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

  beforeEach(() => {
    createdEscrowIds = []
    createdTradeIds = []
    createdUserIds = []
  })

  afterEach(async () => {
    if (!dbAvailable) return
    if (createdEscrowIds.length) {
      await prisma.signatureCollectionFinalizationAttempt.deleteMany({ where: { escrowId: { in: createdEscrowIds } } })
      await prisma.escrowPendingTransaction.deleteMany({ where: { escrowId: { in: createdEscrowIds } } })
      const transitions = await prisma.escrowEvent.findMany({ where: { escrowId: { in: createdEscrowIds } }, select: { id: true } })
      if (transitions.length) await prisma.eventProjectionClaim.deleteMany({ where: { subjectId: { in: transitions.map((t) => t.id) } } })
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
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
    }
  })

  async function makeEscrow(type: 'LIGHTNING_HODL' | 'SAFE_GUARD_EVM', status: 'COMPLETED' | 'REFUNDED') {
    const seller = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
    const buyer = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
    createdUserIds.push(seller.id, buyer.id)
    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER' })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    createdTradeIds.push(trade.id)
    const escrow = await prisma.escrow.create({ data: { tradeId: trade.id, type, status, lockedAmount: '0.001', asset: 'BTC' } })
    createdEscrowIds.push(escrow.id)
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id, status: 'ACTIVE' } })
    return { tradeId: trade.id, escrowId: escrow.id, sellerId: seller.id, buyerId: buyer.id }
  }
  type Ctx = Awaited<ReturnType<typeof makeEscrow>>

  async function makePending(escrowId: string, kind: 'release' | 'refund', triggeredBy: string) {
    return prisma.escrowPendingTransaction.create({
      data: { escrowId, kind, toAddress: 'dest-address', requiredSigners: ['buyer-1', 'seller-1'], triggeredBy, unsignedPsbtBase64: 'unsigned-bundle-b64' },
    })
  }

  const escrowOf = (id: string) => prisma.escrow.findUnique({ where: { id } })
  const userOf = (id: string) => prisma.user.findUnique({ where: { id } })
  const tradeOf = (id: string) => prisma.trade.findUnique({ where: { id } })
  async function waitFor(cond: () => Promise<boolean>, ms = 30_000): Promise<void> {
    const end = Date.now() + ms
    while (Date.now() < end) { if (await cond()) return; await sleep(100) }
    throw new Error('timed out waiting for condition')
  }
  const projectedFor = (escrowId: string, toStatus: 'COMPLETED' | 'REFUNDED') => async () => {
    const t = await prisma.escrowEvent.findFirst({ where: { escrowId, toStatus } })
    return !!t && (await prisma.eventProjectionClaim.count({ where: { projectionKey: 'transition.projected', subjectId: t.id } })) === 1
  }

  // ── Layer 1: the durable primitive itself ──────────────────────────────────────────────────────

  describe('ensureFinalizationAttempt / recordFinalizationOutcome (the durable primitive)', () => {
    it('first call PROCEEDs and durably records SUBMISSION_UNKNOWN before any external effect', async () => {
      pg.requirePostgres('first call proceeds')
      const c = await makeEscrow('LIGHTNING_HODL', 'COMPLETED')
      const result = await ensureFinalizationAttempt(c.escrowId, 'pending-1', 'release')
      expect(result).toEqual({ action: 'PROCEED' })
      const row = await prisma.signatureCollectionFinalizationAttempt.findUnique({ where: { escrowId: c.escrowId } })
      expect(row!.status).toBe('SUBMISSION_UNKNOWN')
      expect(row!.pendingTxId).toBe('pending-1')
    })

    it('a second call while still SUBMISSION_UNKNOWN is BLOCKED (never authorizes blind resubmission)', async () => {
      pg.requirePostgres('second call blocked while unknown')
      const c = await makeEscrow('LIGHTNING_HODL', 'COMPLETED')
      await ensureFinalizationAttempt(c.escrowId, 'pending-1', 'release')
      await expect(ensureFinalizationAttempt(c.escrowId, 'pending-1', 'release')).rejects.toThrow(/unresolved outcome \(SUBMISSION_UNKNOWN\)/)
      // repeated calls: still blocked, still no state change
      await expect(ensureFinalizationAttempt(c.escrowId, 'pending-1', 'release')).rejects.toThrow(/unresolved outcome/)
      const row = await prisma.signatureCollectionFinalizationAttempt.findUnique({ where: { escrowId: c.escrowId } })
      expect(row!.status).toBe('SUBMISSION_UNKNOWN')
    })

    it('a SUBMITTED attempt is ALSO blocked (bundler-accepted != chain-confirmed, never treated as safe to resubmit)', async () => {
      pg.requirePostgres('submitted also blocked')
      const c = await makeEscrow('SAFE_GUARD_EVM', 'COMPLETED')
      await ensureFinalizationAttempt(c.escrowId, 'pending-1', 'release')
      await recordFinalizationOutcome(c.escrowId, 'SUBMITTED', '0xuserophash')
      await expect(ensureFinalizationAttempt(c.escrowId, 'pending-1', 'release')).rejects.toThrow(/unresolved outcome \(SUBMITTED\)/)
    })

    it('a CONFIRMED attempt RESUMEs with the known txHash - never re-proceeds, never re-submits', async () => {
      pg.requirePostgres('confirmed resumes')
      const c = await makeEscrow('LIGHTNING_HODL', 'COMPLETED')
      await ensureFinalizationAttempt(c.escrowId, 'pending-1', 'release')
      await recordFinalizationOutcome(c.escrowId, 'CONFIRMED', '0xconfirmedtx')
      const result = await ensureFinalizationAttempt(c.escrowId, 'pending-1', 'release')
      expect(result).toEqual({ action: 'RESUME_CONFIRMED', txHash: '0xconfirmedtx' })
      // idempotent under repetition
      const again = await ensureFinalizationAttempt(c.escrowId, 'pending-1', 'release')
      expect(again).toEqual({ action: 'RESUME_CONFIRMED', txHash: '0xconfirmedtx' })
    })

    it('a pendingTxId mismatch (stale row bound to a different operation) fails closed', async () => {
      pg.requirePostgres('pendingTxId mismatch')
      const c = await makeEscrow('LIGHTNING_HODL', 'COMPLETED')
      await ensureFinalizationAttempt(c.escrowId, 'pending-old', 'release')
      await expect(ensureFinalizationAttempt(c.escrowId, 'pending-new', 'release')).rejects.toThrow(/is bound to pending operation pending-old/)
    })

    it('CONFIRMED with no persisted txHash is a data integrity violation, fails closed', async () => {
      pg.requirePostgres('confirmed no txhash')
      const c = await makeEscrow('LIGHTNING_HODL', 'COMPLETED')
      await ensureFinalizationAttempt(c.escrowId, 'pending-1', 'release')
      await prisma.signatureCollectionFinalizationAttempt.update({ where: { escrowId: c.escrowId }, data: { status: 'CONFIRMED' } }) // no txHash
      await expect(ensureFinalizationAttempt(c.escrowId, 'pending-1', 'release')).rejects.toThrow(/data integrity violation/)
    })

    it('10 concurrent FIRST calls for the same escrow: exactly one PROCEEDs, the rest see it (unique constraint enforces atomicity)', async () => {
      pg.requirePostgres('concurrent first calls')
      const c = await makeEscrow('LIGHTNING_HODL', 'COMPLETED')
      const results = await Promise.allSettled(Array.from({ length: 10 }, () => ensureFinalizationAttempt(c.escrowId, 'pending-1', 'release')))
      const proceeded = results.filter((r) => r.status === 'fulfilled' && (r.value as any).action === 'PROCEED')
      expect(proceeded).toHaveLength(1) // exactly one winner creates the row; every other racer's create() hits the unique constraint
      const rejected = results.filter((r) => r.status === 'rejected')
      expect(rejected.length).toBe(9)
      const row = await prisma.signatureCollectionFinalizationAttempt.findUnique({ where: { escrowId: c.escrowId } })
      expect(row!.status).toBe('SUBMISSION_UNKNOWN')
    })
  })

  // ── Layer 1b: the REAL provider entrypoint - proves the external boundary is never reached twice ──

  describe('real provider entrypoint: the external submission boundary is never reached for an ambiguous attempt', () => {
    it('LIGHTNING_HODL.finalizeRelease(): first call reaches bundle parsing (fails there, harmlessly); second call is BLOCKED before ever reaching it', async () => {
      pg.requirePostgres('LN entrypoint blocks second call')
      const c = await makeEscrow('LIGHTNING_HODL', 'COMPLETED')
      const escrowInput = { id: c.escrowId, tradeId: c.tradeId, lockedAmount: '0.001' }

      // First call: ensureFinalizationAttempt PROCEEDs (creates the row), THEN deserializeBundle('not-a-real-bundle')
      // throws - a DIFFERENT, distinguishable error than the blocking one below.
      await expect(lightningHodlProvider.finalizeRelease(escrowInput, 'not-a-real-bundle', [], 'pending-1'))
        .rejects.toThrow(/failed to combine\/finalize signatures/)
      const afterFirst = await prisma.signatureCollectionFinalizationAttempt.findUnique({ where: { escrowId: c.escrowId } })
      expect(afterFirst!.status).toBe('SUBMISSION_UNKNOWN') // left ambiguous, exactly the corrected WDK lesson

      // Second call: blocked by ensureFinalizationAttempt itself - proves bundle parsing (and everything
      // beyond it, including the real Ark submitTx()/finalizeTx() network calls) is NEVER reached.
      await expect(lightningHodlProvider.finalizeRelease(escrowInput, 'not-a-real-bundle', [], 'pending-1'))
        .rejects.toThrow(/unresolved outcome \(SUBMISSION_UNKNOWN\)/)
    })

    it('SAFE_GUARD_EVM.finalizeRelease(): first call reaches bundle parsing (fails there, harmlessly); second call is BLOCKED before ever reaching it', async () => {
      pg.requirePostgres('SAFE entrypoint blocks second call')
      const c = await makeEscrow('SAFE_GUARD_EVM', 'COMPLETED')
      const escrowInput = { id: c.escrowId, tradeId: c.tradeId, lockedAmount: '0.001' }

      await expect(safeGuardEvmProvider.finalizeRelease(escrowInput, 'not-valid-json', [], 'pending-1'))
        .rejects.toThrow(/failed to parse the stored bundle/)
      const afterFirst = await prisma.signatureCollectionFinalizationAttempt.findUnique({ where: { escrowId: c.escrowId } })
      expect(afterFirst!.status).toBe('SUBMISSION_UNKNOWN')

      await expect(safeGuardEvmProvider.finalizeRelease(escrowInput, 'not-valid-json', [], 'pending-1'))
        .rejects.toThrow(/unresolved outcome \(SUBMISSION_UNKNOWN\)/)
    })

    it('a resumed CONFIRMED attempt returns the known txHash WITHOUT reaching bundle parsing at all', async () => {
      pg.requirePostgres('resume confirmed skips parsing entirely')
      const c = await makeEscrow('LIGHTNING_HODL', 'COMPLETED')
      await ensureFinalizationAttempt(c.escrowId, 'pending-1', 'release')
      await recordFinalizationOutcome(c.escrowId, 'CONFIRMED', '0xalreadyconfirmed')
      const escrowInput = { id: c.escrowId, tradeId: c.tradeId, lockedAmount: '0.001' }
      // 'garbage-that-would-throw-if-parsed' would fail deserializeBundle() if ever reached — it isn't.
      const result = await lightningHodlProvider.finalizeRelease(escrowInput, 'garbage-that-would-throw-if-parsed', [], 'pending-1')
      expect(result).toEqual({ txId: '0xalreadyconfirmed' })
    })
  })

  // ── Layer 2: reconciler dispatch (real Postgres, both providers, full crash matrix) ────────────

  for (const type of ['LIGHTNING_HODL', 'SAFE_GUARD_EVM'] as const) {
    describe(`reconcileSignatureCollectionTerminalTransfer() - ${type}`, () => {
      it('no durable attempt at all: fails closed (finalize never reached)', async () => {
        pg.requirePostgres(`${type} no attempt`)
        const c = await makeEscrow(type, 'COMPLETED')
        await makePending(c.escrowId, 'release', c.sellerId)

        const report = await reconcilePendingSettlements({ projectionGraceMs: 0 })
        expect(report.recovered).toEqual([])
        expect(report.requiresManualReview.some((m) => m.escrowId === c.escrowId && /no durable finalization attempt exists/.test(m.reason))).toBe(true)
      })

      it('SUBMISSION_UNKNOWN: never inferred as FAILED, never converges, repeated reconciliation stays inert', async () => {
        pg.requirePostgres(`${type} submission unknown`)
        const c = await makeEscrow(type, 'COMPLETED')
        const pending = await makePending(c.escrowId, 'release', c.sellerId)
        await ensureFinalizationAttempt(c.escrowId, pending.id, 'release')

        const report = await reconcilePendingSettlements({ projectionGraceMs: 0 })
        expect(report.recovered).toEqual([])
        expect(report.requiresManualReview.some((m) => m.escrowId === c.escrowId && /is SUBMISSION_UNKNOWN/.test(m.reason))).toBe(true)
        expect((await escrowOf(c.escrowId))!.txReleaseId).toBeNull()

        await reconcilePendingSettlements({ projectionGraceMs: 0 })
        expect((await escrowOf(c.escrowId))!.txReleaseId).toBeNull()
      })

      it('mismatched pendingTxId (stale attempt row): fails closed', async () => {
        pg.requirePostgres(`${type} pendingTxId mismatch`)
        const c = await makeEscrow(type, 'COMPLETED')
        const pending = await makePending(c.escrowId, 'release', c.sellerId)
        await ensureFinalizationAttempt(c.escrowId, 'a-different-pending-id', 'release')

        const report = await reconcilePendingSettlements({ projectionGraceMs: 0 })
        expect(report.recovered).toEqual([])
        expect(report.requiresManualReview.some((m) => m.escrowId === c.escrowId && /is bound to pending operation/.test(m.reason))).toBe(true)
        void pending
      })

      it('CONFIRMED with no txHash: data integrity violation, fails closed', async () => {
        pg.requirePostgres(`${type} confirmed no txhash`)
        const c = await makeEscrow(type, 'COMPLETED')
        const pending = await makePending(c.escrowId, 'release', c.sellerId)
        await ensureFinalizationAttempt(c.escrowId, pending.id, 'release')
        await prisma.signatureCollectionFinalizationAttempt.update({ where: { escrowId: c.escrowId }, data: { status: 'CONFIRMED' } })

        const report = await reconcilePendingSettlements({ projectionGraceMs: 0 })
        expect(report.recovered).toEqual([])
        expect(report.requiresManualReview.some((m) => m.escrowId === c.escrowId && /data integrity violation/.test(m.reason))).toBe(true)
      })

      it('CONFIRMED RELEASE converges exactly once through the write-once path; repeated reconciliation is idempotent', async () => {
        pg.requirePostgres(`${type} confirmed release converges`)
        const c = await makeEscrow(type, 'COMPLETED')
        const pending = await makePending(c.escrowId, 'release', c.sellerId)
        const txHash = `0xrelease${randomUUID().replace(/-/g, '')}`
        await ensureFinalizationAttempt(c.escrowId, pending.id, 'release')
        await recordFinalizationOutcome(c.escrowId, 'CONFIRMED', txHash)

        const report = await reconcilePendingSettlements({ projectionGraceMs: 0 })
        expect(report.recovered).toEqual([{ escrowId: c.escrowId, txId: txHash, outcome: 'ALREADY_CONFIRMED' }])

        await waitFor(projectedFor(c.escrowId, 'COMPLETED'))
        await sleep(300)
        const [trade, events, buyer, seller, releasedAtFirst] = await Promise.all([
          tradeOf(c.tradeId),
          prisma.escrowEvent.findMany({ where: { escrowId: c.escrowId, toStatus: 'COMPLETED' } }),
          userOf(c.buyerId), userOf(c.sellerId),
          escrowOf(c.escrowId).then((e) => e!.releasedAt!.getTime()),
        ])
        expect(events).toHaveLength(1)
        expect(trade!.status).toBe('COMPLETED')
        expect(buyer!.totalTrades).toBe(1)
        expect(seller!.totalTrades).toBe(1)
        expect((await escrowOf(c.escrowId))!.txReleaseId).toBe(txHash)
        // the pending row was consumed by convergence, same as every other rail
        expect(await prisma.escrowPendingTransaction.findUnique({ where: { escrowId: c.escrowId } })).toBeNull()

        for (let i = 0; i < 4; i++) await reconcilePendingSettlements({ projectionGraceMs: 0 })
        expect((await escrowOf(c.escrowId))!.txReleaseId).toBe(txHash)
        expect((await escrowOf(c.escrowId))!.releasedAt!.getTime()).toBe(releasedAtFirst) // write-once
        expect(await prisma.escrowEvent.count({ where: { escrowId: c.escrowId, toStatus: 'COMPLETED' } })).toBe(1)
      })

      it('CONFIRMED REFUND converges (no releasedAt set, matching every other rail\'s refund contract)', async () => {
        pg.requirePostgres(`${type} confirmed refund converges`)
        const c = await makeEscrow(type, 'REFUNDED')
        const pending = await makePending(c.escrowId, 'refund', c.sellerId)
        const txHash = `0xrefund${randomUUID().replace(/-/g, '')}`
        await ensureFinalizationAttempt(c.escrowId, pending.id, 'refund')
        await recordFinalizationOutcome(c.escrowId, 'CONFIRMED', txHash)

        const report = await reconcilePendingSettlements({ projectionGraceMs: 0 })
        expect(report.recovered).toEqual([{ escrowId: c.escrowId, txId: txHash, outcome: 'ALREADY_CONFIRMED' }])
        await waitFor(projectedFor(c.escrowId, 'REFUNDED'))
        await sleep(300)
        expect((await escrowOf(c.escrowId))!.txReleaseId).toBe(txHash)
        expect((await escrowOf(c.escrowId))!.releasedAt).toBeNull()
        expect((await tradeOf(c.tradeId))!.status).toBe('CANCELLED')
      })

      it('two independent reconciler instances race the same CONFIRMED attempt: converge on one result, downstream effects exactly once', async () => {
        pg.requirePostgres(`${type} concurrent reconciler instances`)
        const c = await makeEscrow(type, 'COMPLETED')
        const pending = await makePending(c.escrowId, 'release', c.sellerId)
        const txHash = `0xrace${randomUUID().replace(/-/g, '')}`
        await ensureFinalizationAttempt(c.escrowId, pending.id, 'release')
        await recordFinalizationOutcome(c.escrowId, 'CONFIRMED', txHash)

        const [ra, rb] = await Promise.all([
          reconcilePendingSettlements({ projectionGraceMs: 0 }),
          instanceB!.reconcile({ projectionGraceMs: 0 }),
        ])
        expect(ra.failed.filter((f) => f.escrowId === c.escrowId)).toEqual([])
        expect(rb.failed.filter((f) => f.escrowId === c.escrowId)).toEqual([])

        await waitFor(projectedFor(c.escrowId, 'COMPLETED'))
        await sleep(400)
        expect(await prisma.escrowEvent.count({ where: { escrowId: c.escrowId, toStatus: 'COMPLETED' } })).toBe(1)
        expect(await prisma.eventProjectionClaim.count({ where: { projectionKey: 'trade.status', subjectId: c.tradeId } })).toBe(1)
        const [buyer, seller] = await Promise.all([userOf(c.buyerId), userOf(c.sellerId)])
        expect(buyer!.totalTrades).toBe(1)
        expect(seller!.totalTrades).toBe(1)
      })

      it('genuine restart: an independent module graph converges durable PostgreSQL state it never created', async () => {
        pg.requirePostgres(`${type} genuine restart`)
        const c = await makeEscrow(type, 'COMPLETED')
        const pending = await makePending(c.escrowId, 'release', c.sellerId)
        const txHash = `0xrestart${randomUUID().replace(/-/g, '')}`
        await ensureFinalizationAttempt(c.escrowId, pending.id, 'release')
        await recordFinalizationOutcome(c.escrowId, 'CONFIRMED', txHash)

        const report = await instanceB!.reconcile({ projectionGraceMs: 0 })
        expect(report.recovered).toEqual([{ escrowId: c.escrowId, txId: txHash, outcome: 'ALREADY_CONFIRMED' }])
        await waitFor(projectedFor(c.escrowId, 'COMPLETED'))
        await sleep(300)
        expect((await escrowOf(c.escrowId))!.txReleaseId).toBe(txHash)
      })
    })
  }

  // SAFE_GUARD_EVM-specific: SUBMITTED (bundler-accepted, not chain-confirmed) never auto-converges.
  it('SAFE_GUARD_EVM SUBMITTED (bundler-accepted userOpHash, not chain-confirmed): never auto-converges, never resubmits', async () => {
    pg.requirePostgres('SAFE submitted stays manual review')
    const c = await makeEscrow('SAFE_GUARD_EVM', 'COMPLETED')
    const pending = await makePending(c.escrowId, 'release', c.sellerId)
    await ensureFinalizationAttempt(c.escrowId, pending.id, 'release')
    await recordFinalizationOutcome(c.escrowId, 'SUBMITTED', '0xuserophashonly')

    const report = await reconcilePendingSettlements({ projectionGraceMs: 0 })
    expect(report.recovered).toEqual([])
    const review = report.requiresManualReview.find((m) => m.escrowId === c.escrowId)
    expect(review!.reason).toContain('is SUBMITTED')
    expect(review!.reason).toContain('0xuserophashonly')
    expect((await escrowOf(c.escrowId))!.txReleaseId).toBeNull()

    // repeated ticks: still no fabricated completion
    await reconcilePendingSettlements({ projectionGraceMs: 0 })
    expect((await escrowOf(c.escrowId))!.txReleaseId).toBeNull()
  })
})
