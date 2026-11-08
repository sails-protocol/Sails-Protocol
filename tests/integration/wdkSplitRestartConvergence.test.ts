// tests/integration/wdkSplitRestartConvergence.test.ts
//
// Issue #250 - real PostgreSQL proof that a WDK_USDT_EVM SPLIT (two independent external transfers,
// SPLIT_BUYER + SPLIT_SELLER - see wdk-transfer-attempt-repository.ts's own schema comment) converges
// automatically after a crash/restart WITHOUT resubmitting a leg that is already externally proven
// complete, and WITHOUT declaring the split done from a partial (single-leg) effect. Builds directly
// on Issue #251's read-only WdkTransferAttempt classification pattern (reconcileTerminalTransfer,
// called once per leg) and the frozen #291/#294/#298 write-once/idempotent-projection machinery - no
// new authority, no new locking primitive.
//
// Same @tetherto/wdk-wallet-evm mocking approach as wdkTerminalRestartConvergence.test.ts (pure ESM,
// no CJS build) - a real, controllable fake so transfer()/getTransactionReceipt() calls can be proven
// directly, while Escrow/WdkTransferAttempt/PayoutAddress/Trade/projections run against real PostgreSQL.

process.env.WDK_SEED_PHRASE = process.env.WDK_SEED_PHRASE || 'test only seed phrase for wdk split restart convergence integration tests - never a real wallet'
process.env.WDK_USDT_CONTRACT = process.env.WDK_USDT_CONTRACT || '0x0000000000000000000000000000000000000001'

const mockTransfer = jest.fn()
const receiptByHash: Record<string, { status: number } | undefined> = {}
const mockGetTransactionReceipt = jest.fn(async (hash: string) => receiptByHash[hash] ?? null)

const fakeEscrowAccount = {
  getAddress: async () => 'escrow-fake-evm-address',
  transfer: (...args: unknown[]) => mockTransfer(...args),
  getTransactionReceipt: (hash: string) => mockGetTransactionReceipt(hash),
}

jest.mock('@tetherto/wdk-wallet-evm', () => ({
  __esModule: true,
  default: class FakeWalletManagerEvm {
    async getAccount(_index: number) {
      return fakeEscrowAccount
    }
    async getAccountByPath(_path: string) {
      return fakeEscrowAccount
    }
  },
}))

import { PrismaClient } from '@prisma/client'
import { randomBytes, randomUUID } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('Issue #250 - WDK_USDT_EVM SPLIT restart convergence (real PostgreSQL)', () => {
  jest.setTimeout(120_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let liquidityRouter: typeof import('../../src/modules/open-liquidity/liquidity.service').liquidityRouter
  let tradeService: typeof import('../../src/modules/open-p2p/trade.service').tradeService
  let reconcilePendingSettlements: typeof import('../../src/modules/open-settlement/escrow-settlement-reconciliation.service').reconcilePendingSettlements
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

  // Same reasoning as wdkTerminalRestartConvergence.test.ts's own comment: reconcilePendingSettlements()
  // scans the WHOLE database, so every test tracks and tears down its own fixtures to keep the shared
  // transfer()/getTransactionReceipt() spy counts meaningful.
  let createdEscrowIds: string[] = []
  let createdTradeIds: string[] = []
  let createdUserIds: string[] = []

  beforeEach(() => {
    mockTransfer.mockClear()
    mockGetTransactionReceipt.mockClear()
    for (const k of Object.keys(receiptByHash)) delete receiptByHash[k]
    createdEscrowIds = []
    createdTradeIds = []
    createdUserIds = []
  })

  afterEach(async () => {
    if (!dbAvailable) return
    if (createdEscrowIds.length) {
      await prisma.wdkTransferAttempt.deleteMany({ where: { escrowId: { in: createdEscrowIds } } })
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
      await prisma.payoutAddress.deleteMany({ where: { participantId: { in: createdUserIds } } })
      await prisma.offer.deleteMany({ where: { userId: { in: createdUserIds } } })
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
    }
  })

  async function makeSplitEscrow() {
    const seller = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
    const buyer = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
    createdUserIds.push(seller.id, buyer.id)
    const buyerPayoutAddress = `buyer-payout-${buyer.id}`
    const sellerPayoutAddress = `seller-payout-${seller.id}`
    await prisma.payoutAddress.create({ data: { participantId: buyer.id, asset: 'USDT_ERC20', address: buyerPayoutAddress } })
    await prisma.payoutAddress.create({ data: { participantId: seller.id, asset: 'USDT_ERC20', address: sellerPayoutAddress } })
    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'USDT_ERC20', side: 'SELL', priceUsd: '1', minAmount: '10', maxAmount: '10', paymentMethod: 'OTHER' })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '10' })
    createdTradeIds.push(trade.id)
    const escrow = await prisma.escrow.create({ data: { tradeId: trade.id, type: 'WDK_USDT_EVM', status: 'SPLIT', lockedAmount: '10', asset: 'USDT_ERC20' } })
    createdEscrowIds.push(escrow.id)
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id, status: 'ACTIVE' } })
    return { tradeId: trade.id, escrowId: escrow.id, sellerId: seller.id, buyerId: buyer.id, buyerPayoutAddress, sellerPayoutAddress }
  }
  type Ctx = Awaited<ReturnType<typeof makeSplitEscrow>>

  async function makeAttempt(escrowId: string, operationType: 'SPLIT_BUYER' | 'SPLIT_SELLER', destination: string, amount: string, status: 'PREPARED' | 'SUBMISSION_UNKNOWN' | 'SUBMITTED' | 'CONFIRMED' | 'REVERTED' | 'FAILED_BEFORE_SUBMISSION', txHash?: string) {
    return prisma.wdkTransferAttempt.create({
      data: { escrowId, operationType, destination, amount, status, txHash, activeKey: status === 'CONFIRMED' || status === 'REVERTED' ? null : `${escrowId}:${operationType}` },
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
  const projectedFor = (escrowId: string) => async () => {
    const t = await prisma.escrowEvent.findFirst({ where: { escrowId, toStatus: 'SPLIT' } })
    return !!t && (await prisma.eventProjectionClaim.count({ where: { projectionKey: 'transition.projected', subjectId: t.id } })) === 1
  }

  async function expectConvergedOnce(c: Ctx, joinedTxHash: string) {
    const [trade, events] = await Promise.all([
      tradeOf(c.tradeId),
      prisma.escrowEvent.findMany({ where: { escrowId: c.escrowId, toStatus: 'SPLIT' } }),
    ])
    expect(events).toHaveLength(1)
    expect((await escrowOf(c.escrowId))!.txReleaseId).toBe(joinedTxHash)
    expect(trade!.status).toBe('COMPLETED') // SPLIT projects to COMPLETED, same as RELEASE
  }

  // ── neither leg submitted / not started ────────────────────────────────────────────────────────

  it('neither leg submitted (no attempts at all): fails closed, zero transfer() calls', async () => {
    pg.requirePostgres('neither leg submitted')
    const c = await makeSplitEscrow()

    const report = await reconcilePendingSettlements({ projectionGraceMs: 0 })
    expect(report.recovered).toEqual([])
    expect(report.requiresManualReview.some((m) => m.escrowId === c.escrowId && /NO_ATTEMPT/.test(m.reason))).toBe(true)
    expect(mockTransfer).not.toHaveBeenCalled()
    expect((await escrowOf(c.escrowId))!.txReleaseId).toBeNull()
  })

  // ── 1) first leg CONFIRMED, second not started ─────────────────────────────────────────────────

  it('buyer leg CONFIRMED, seller leg not started: neither leg resubmitted, no result written, both legs surfaced', async () => {
    pg.requirePostgres('buyer confirmed seller not started')
    const c = await makeSplitEscrow()
    const buyerTx = `0xbuyer${randomUUID().replace(/-/g, '')}`
    await makeAttempt(c.escrowId, 'SPLIT_BUYER', c.buyerPayoutAddress, '4', 'CONFIRMED', buyerTx)

    const report = await reconcilePendingSettlements({ projectionGraceMs: 0 })
    expect(report.recovered).toEqual([])
    expect(mockTransfer).not.toHaveBeenCalled()
    const review = report.requiresManualReview.find((m) => m.escrowId === c.escrowId)
    expect(review).toBeDefined()
    expect(review!.reason).toContain(`buyer leg CONFIRMED (${buyerTx})`)
    expect(review!.reason).toContain('seller leg NO_ATTEMPT')
    expect((await escrowOf(c.escrowId))!.txReleaseId).toBeNull()
  })

  // ── 2) first CONFIRMED, second SUBMISSION_UNKNOWN ──────────────────────────────────────────────

  it('buyer CONFIRMED, seller SUBMISSION_UNKNOWN: never inferred as FAILED, never blindly retried, no result written', async () => {
    pg.requirePostgres('buyer confirmed seller unknown')
    const c = await makeSplitEscrow()
    const buyerTx = `0xbuyer${randomUUID().replace(/-/g, '')}`
    await makeAttempt(c.escrowId, 'SPLIT_BUYER', c.buyerPayoutAddress, '4', 'CONFIRMED', buyerTx)
    await makeAttempt(c.escrowId, 'SPLIT_SELLER', c.sellerPayoutAddress, '6', 'SUBMISSION_UNKNOWN')

    const report = await reconcilePendingSettlements({ projectionGraceMs: 0 })
    expect(report.recovered).toEqual([])
    expect(mockTransfer).not.toHaveBeenCalled()
    const review = report.requiresManualReview.find((m) => m.escrowId === c.escrowId)
    expect(review!.reason).toContain(`buyer leg CONFIRMED (${buyerTx})`)
    expect(review!.reason).toContain('seller leg SUBMISSION_UNKNOWN')
    expect((await escrowOf(c.escrowId))!.txReleaseId).toBeNull()

    // repeated ticks: still no resubmission, still unresolved
    await reconcilePendingSettlements({ projectionGraceMs: 0 })
    expect(mockTransfer).not.toHaveBeenCalled()
    expect((await escrowOf(c.escrowId))!.txReleaseId).toBeNull()
  })

  // ── 3) first CONFIRMED, second SUBMITTED/pending ───────────────────────────────────────────────

  it('buyer CONFIRMED, seller SUBMITTED with no receipt yet: stays pending, no fabricated completion, no resubmission', async () => {
    pg.requirePostgres('buyer confirmed seller pending')
    const c = await makeSplitEscrow()
    const buyerTx = `0xbuyer${randomUUID().replace(/-/g, '')}`
    const sellerTx = `0xseller${randomUUID().replace(/-/g, '')}`
    await makeAttempt(c.escrowId, 'SPLIT_BUYER', c.buyerPayoutAddress, '4', 'CONFIRMED', buyerTx)
    await makeAttempt(c.escrowId, 'SPLIT_SELLER', c.sellerPayoutAddress, '6', 'SUBMITTED', sellerTx)
    // receiptByHash[sellerTx] left undefined -> not yet confirmed

    const report = await reconcilePendingSettlements({ projectionGraceMs: 0 })
    expect(report.recovered).toEqual([])
    expect(mockTransfer).not.toHaveBeenCalled()
    const review = report.requiresManualReview.find((m) => m.escrowId === c.escrowId)
    expect(review!.reason).toContain('seller leg PENDING')
    expect((await escrowOf(c.escrowId))!.txReleaseId).toBeNull()
  })

  // ── 4) first CONFIRMED, second SUBMITTED -> CONFIRMED via receipt ─────────────────────────────

  it('buyer CONFIRMED, seller SUBMITTED becomes CONFIRMED via receipt query: converges exactly once, zero additional transfer() calls', async () => {
    pg.requirePostgres('buyer confirmed seller submitted->confirmed')
    const c = await makeSplitEscrow()
    const buyerTx = `0xbuyer${randomUUID().replace(/-/g, '')}`
    const sellerTx = `0xseller${randomUUID().replace(/-/g, '')}`
    await makeAttempt(c.escrowId, 'SPLIT_BUYER', c.buyerPayoutAddress, '4', 'CONFIRMED', buyerTx)
    await makeAttempt(c.escrowId, 'SPLIT_SELLER', c.sellerPayoutAddress, '6', 'SUBMITTED', sellerTx)
    receiptByHash[sellerTx] = { status: 1 }

    const report = await reconcilePendingSettlements({ projectionGraceMs: 0 })
    const joined = `${buyerTx},${sellerTx}`
    expect(report.recovered).toEqual([{ escrowId: c.escrowId, txId: joined, outcome: 'ALREADY_CONFIRMED' }])
    expect(mockGetTransactionReceipt).toHaveBeenCalledWith(sellerTx)
    expect(mockTransfer).not.toHaveBeenCalled()

    await waitFor(projectedFor(c.escrowId))
    await sleep(300)
    await expectConvergedOnce(c, joined)
  })

  // ── 5) both CONFIRMED but local settlement result missing (the base crash case) ───────────────

  it('both legs CONFIRMED, local settlement result missing: persists the joined txHash, zero additional transfer() calls for either leg', async () => {
    pg.requirePostgres('both confirmed, result missing')
    const c = await makeSplitEscrow()
    const buyerTx = `0xbuyer${randomUUID().replace(/-/g, '')}`
    const sellerTx = `0xseller${randomUUID().replace(/-/g, '')}`
    await makeAttempt(c.escrowId, 'SPLIT_BUYER', c.buyerPayoutAddress, '4', 'CONFIRMED', buyerTx)
    await makeAttempt(c.escrowId, 'SPLIT_SELLER', c.sellerPayoutAddress, '6', 'CONFIRMED', sellerTx)

    const report = await reconcilePendingSettlements({ projectionGraceMs: 0 })
    const joined = `${buyerTx},${sellerTx}`
    expect(report.recovered).toEqual([{ escrowId: c.escrowId, txId: joined, outcome: 'ALREADY_CONFIRMED' }])
    expect(mockTransfer).not.toHaveBeenCalled() // proves zero additional transfer() calls for BOTH legs

    await waitFor(projectedFor(c.escrowId))
    await sleep(300)
    await expectConvergedOnce(c, joined)
  })

  // ── 6) either leg REVERTED ──────────────────────────────────────────────────────────────────────

  it('buyer CONFIRMED, seller REVERTED on-chain: definitively no funds delivered by that leg — surfaced, never converged, never resubmitted', async () => {
    pg.requirePostgres('seller reverted')
    const c = await makeSplitEscrow()
    const buyerTx = `0xbuyer${randomUUID().replace(/-/g, '')}`
    const sellerTx = `0xseller${randomUUID().replace(/-/g, '')}`
    await makeAttempt(c.escrowId, 'SPLIT_BUYER', c.buyerPayoutAddress, '4', 'CONFIRMED', buyerTx)
    await makeAttempt(c.escrowId, 'SPLIT_SELLER', c.sellerPayoutAddress, '6', 'REVERTED', sellerTx)

    const report = await reconcilePendingSettlements({ projectionGraceMs: 0 })
    expect(report.recovered).toEqual([])
    expect(mockTransfer).not.toHaveBeenCalled()
    const review = report.requiresManualReview.find((m) => m.escrowId === c.escrowId)
    expect(review!.reason).toContain('seller leg NOT_STARTED')
    expect((await escrowOf(c.escrowId))!.txReleaseId).toBeNull()
  })

  // ── 7) malformed/missing txHash ─────────────────────────────────────────────────────────────────

  it('buyer CONFIRMED with no txHash (data integrity violation): fails closed, never converges', async () => {
    pg.requirePostgres('buyer confirmed no txhash')
    const c = await makeSplitEscrow()
    const sellerTx = `0xseller${randomUUID().replace(/-/g, '')}`
    await makeAttempt(c.escrowId, 'SPLIT_BUYER', c.buyerPayoutAddress, '4', 'CONFIRMED', undefined)
    await makeAttempt(c.escrowId, 'SPLIT_SELLER', c.sellerPayoutAddress, '6', 'CONFIRMED', sellerTx)

    const report = await reconcilePendingSettlements({ projectionGraceMs: 0 })
    expect(report.recovered).toEqual([])
    expect(mockTransfer).not.toHaveBeenCalled()
    const review = report.requiresManualReview.find((m) => m.escrowId === c.escrowId)
    expect(review!.reason).toContain('data integrity violation')
  })

  // ── 8) amount/destination mismatch ──────────────────────────────────────────────────────────────

  it('destination mismatch on the seller leg: fails closed, never converges, never resubmits', async () => {
    pg.requirePostgres('seller destination mismatch')
    const c = await makeSplitEscrow()
    const buyerTx = `0xbuyer${randomUUID().replace(/-/g, '')}`
    const sellerTx = `0xseller${randomUUID().replace(/-/g, '')}`
    await makeAttempt(c.escrowId, 'SPLIT_BUYER', c.buyerPayoutAddress, '4', 'CONFIRMED', buyerTx)
    await makeAttempt(c.escrowId, 'SPLIT_SELLER', 'some-other-address-entirely', '6', 'CONFIRMED', sellerTx)

    const report = await reconcilePendingSettlements({ projectionGraceMs: 0 })
    expect(report.recovered).toEqual([])
    expect(mockTransfer).not.toHaveBeenCalled()
    const review = report.requiresManualReview.find((m) => m.escrowId === c.escrowId)
    expect(review!.reason).toContain('does not match the independently-derived expected')
    expect((await escrowOf(c.escrowId))!.txReleaseId).toBeNull()
  })

  it('both legs CONFIRMED with correct destinations but amounts do NOT sum to lockedAmount: fails closed, never converges', async () => {
    pg.requirePostgres('amount sum mismatch')
    const c = await makeSplitEscrow()
    const buyerTx = `0xbuyer${randomUUID().replace(/-/g, '')}`
    const sellerTx = `0xseller${randomUUID().replace(/-/g, '')}`
    await makeAttempt(c.escrowId, 'SPLIT_BUYER', c.buyerPayoutAddress, '4', 'CONFIRMED', buyerTx)
    await makeAttempt(c.escrowId, 'SPLIT_SELLER', c.sellerPayoutAddress, '5', 'CONFIRMED', sellerTx) // 4+5=9, not 10

    const report = await reconcilePendingSettlements({ projectionGraceMs: 0 })
    expect(report.recovered).toEqual([])
    expect(mockTransfer).not.toHaveBeenCalled()
    const review = report.requiresManualReview.find((m) => m.escrowId === c.escrowId)
    expect(review!.reason).toMatch(/does not equal escrow.lockedAmount/)
    expect((await escrowOf(c.escrowId))!.txReleaseId).toBeNull()
  })

  // ── 10) repeated reconciliation ─────────────────────────────────────────────────────────────────

  it('repeated reconciliation: N runs after completion -> one economic completion, no further transfer() calls, write-once releasedAt', async () => {
    pg.requirePostgres('repeated reconciliation')
    const c = await makeSplitEscrow()
    const buyerTx = `0xbuyer${randomUUID().replace(/-/g, '')}`
    const sellerTx = `0xseller${randomUUID().replace(/-/g, '')}`
    await makeAttempt(c.escrowId, 'SPLIT_BUYER', c.buyerPayoutAddress, '4', 'CONFIRMED', buyerTx)
    await makeAttempt(c.escrowId, 'SPLIT_SELLER', c.sellerPayoutAddress, '6', 'CONFIRMED', sellerTx)
    const joined = `${buyerTx},${sellerTx}`

    await reconcilePendingSettlements({ projectionGraceMs: 0 })
    await waitFor(projectedFor(c.escrowId))
    await sleep(300)
    const releasedAtAfterFirst = (await escrowOf(c.escrowId))!.releasedAt!.getTime()

    for (let i = 0; i < 4; i++) await reconcilePendingSettlements({ projectionGraceMs: 0 })
    expect(mockTransfer).not.toHaveBeenCalled()
    await expectConvergedOnce(c, joined)
    expect((await escrowOf(c.escrowId))!.releasedAt!.getTime()).toBe(releasedAtAfterFirst)
  })

  // ── 11) two reconciler instances racing (stand-in for live-vs-reconciler and reconciler-vs-reconciler) ─

  it('two independent reconciler instances race the same both-confirmed split: converge on one result, zero duplicate transfer() calls, downstream effects exactly once', async () => {
    pg.requirePostgres('concurrent reconciler instances')
    const c = await makeSplitEscrow()
    const buyerTx = `0xbuyer${randomUUID().replace(/-/g, '')}`
    const sellerTx = `0xseller${randomUUID().replace(/-/g, '')}`
    await makeAttempt(c.escrowId, 'SPLIT_BUYER', c.buyerPayoutAddress, '4', 'CONFIRMED', buyerTx)
    await makeAttempt(c.escrowId, 'SPLIT_SELLER', c.sellerPayoutAddress, '6', 'CONFIRMED', sellerTx)
    const joined = `${buyerTx},${sellerTx}`

    const [ra, rb] = await Promise.all([
      reconcilePendingSettlements({ projectionGraceMs: 0 }),
      instanceB!.reconcile({ projectionGraceMs: 0 }),
    ])
    expect(ra.failed.filter((f) => f.escrowId === c.escrowId)).toEqual([])
    expect(rb.failed.filter((f) => f.escrowId === c.escrowId)).toEqual([])
    expect(mockTransfer).not.toHaveBeenCalled()

    await waitFor(projectedFor(c.escrowId))
    await sleep(400)
    await expectConvergedOnce(c, joined)

    const [buyer, seller, claims] = await Promise.all([
      userOf(c.buyerId), userOf(c.sellerId),
      prisma.eventProjectionClaim.count({ where: { projectionKey: 'trade.status', subjectId: c.tradeId } }),
    ])
    expect(buyer!.totalTrades).toBe(1)
    expect(seller!.totalTrades).toBe(1)
    expect(claims).toBe(1)

    // a second concurrent round is a no-op
    await Promise.all([reconcilePendingSettlements({ projectionGraceMs: 0 }), instanceB!.reconcile({ projectionGraceMs: 0 })])
    await sleep(300)
    expect(mockTransfer).not.toHaveBeenCalled()
    await expectConvergedOnce(c, joined)
  })

  // ── 12) genuine restart boundary ────────────────────────────────────────────────────────────────

  it('genuine restart: an independent module graph converges durable PostgreSQL state it never created', async () => {
    pg.requirePostgres('genuine restart boundary')
    const c = await makeSplitEscrow()
    const buyerTx = `0xbuyer${randomUUID().replace(/-/g, '')}`
    const sellerTx = `0xseller${randomUUID().replace(/-/g, '')}`
    await makeAttempt(c.escrowId, 'SPLIT_BUYER', c.buyerPayoutAddress, '4', 'CONFIRMED', buyerTx)
    await makeAttempt(c.escrowId, 'SPLIT_SELLER', c.sellerPayoutAddress, '6', 'CONFIRMED', sellerTx)
    const joined = `${buyerTx},${sellerTx}`

    const report = await instanceB!.reconcile({ projectionGraceMs: 0 })
    expect(report.recovered).toEqual([{ escrowId: c.escrowId, txId: joined, outcome: 'ALREADY_CONFIRMED' }])
    expect(mockTransfer).not.toHaveBeenCalled()

    await waitFor(projectedFor(c.escrowId))
    await sleep(300)
    await expectConvergedOnce(c, joined)
  })
})
