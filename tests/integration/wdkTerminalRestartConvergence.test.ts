// tests/integration/wdkTerminalRestartConvergence.test.ts
//
// Issue #251 - real PostgreSQL proof that a WDK_USDT_EVM RELEASE/REFUND whose provider transfer is
// already externally proven complete (CONFIRMED, or SUBMITTED-becomes-CONFIRMED) converges
// automatically after a crash/restart: the durable WdkTransferAttempt evidence is consumed through
// the SAME frozen write-once settlement-result path (Issue #291) and the SAME idempotent projection
// machinery (Issue #294/#298) every other rail already uses - no parallel authority system, and the
// WDK execution boundary (transfer()) is instrumented to PROVE zero additional submissions during
// recovery, not merely infer it from final DB state.
//
// @tetherto/wdk-wallet-evm ships pure ESM with no CJS build (same reasoning tests/wdkSettlementProvider.test.ts
// and tests/escrowReleaseControls.test.ts already document) - mocked here with a real, controllable fake
// so the reconciler's actual chain-facing calls (getTransactionReceipt) and non-calls (transfer) can be
// asserted directly, while everything else (Escrow, WdkTransferAttempt, PayoutAddress, Trade, projections)
// runs against real PostgreSQL.

process.env.WDK_SEED_PHRASE = process.env.WDK_SEED_PHRASE || 'test only seed phrase for wdk restart convergence integration tests - never a real wallet'
process.env.WDK_USDT_CONTRACT = process.env.WDK_USDT_CONTRACT || '0x0000000000000000000000000000000000000001'

const mockTransfer = jest.fn()
const mockGetTransactionReceipt = jest.fn()
const TREASURY_ADDRESS = 'treasury-fake-evm-address'
const ESCROW_ACCOUNT_ADDRESS = 'escrow-fake-evm-address'

const fakeTreasuryAccount = {
  getAddress: async () => TREASURY_ADDRESS,
  transfer: (...args: unknown[]) => mockTransfer(...args),
  getTransactionReceipt: (...args: unknown[]) => mockGetTransactionReceipt(...args),
}
const fakeEscrowAccount = {
  getAddress: async () => ESCROW_ACCOUNT_ADDRESS,
  transfer: (...args: unknown[]) => mockTransfer(...args),
  getTransactionReceipt: (...args: unknown[]) => mockGetTransactionReceipt(...args),
}

jest.mock('@tetherto/wdk-wallet-evm', () => ({
  __esModule: true,
  default: class FakeWalletManagerEvm {
    async getAccount(index: number) {
      return index === 0 ? fakeTreasuryAccount : fakeEscrowAccount
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

describe('Issue #251 - WDK_USDT_EVM RELEASE/REFUND restart convergence (real PostgreSQL)', () => {
  jest.setTimeout(120_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let liquidityRouter: typeof import('../../src/modules/open-liquidity/liquidity.service').liquidityRouter
  let tradeService: typeof import('../../src/modules/open-p2p/trade.service').tradeService
  let reconcilePendingSettlements: typeof import('../../src/modules/open-settlement/escrow-settlement-reconciliation.service').reconcilePendingSettlements
  let instanceB: { reconcile: typeof reconcilePendingSettlements; prisma: PrismaClient; redis: { quit(): Promise<unknown> } } | undefined

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'true' // creation-time default only - escrows below always specify type: 'WDK_USDT_EVM' explicitly
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
    // A genuine restart boundary (T10): an independent module graph, not the same service instance
    // invoked twice - its own Prisma pool, event bus, handlers, reconciler closure.
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

  // reconcilePendingSettlements() scans the WHOLE database (findTerminalWithoutTxReleaseId() is
  // unfiltered by design - see escrow-repository.ts's own comment). A test that leaves its escrow
  // deliberately unconverged (T4/T5/T9/...) would otherwise be re-processed by every LATER test's own
  // reconciliation call, polluting the shared transfer()/getTransactionReceipt() spy call counts this
  // file relies on for its strongest guarantee ("zero additional transfer() calls"). Each test tracks
  // and fully tears down its own fixtures afterward so every reconciliation run only ever sees the
  // current test's own data.
  let createdEscrowIds: string[] = []
  let createdTradeIds: string[] = []
  let createdUserIds: string[] = []

  beforeEach(() => {
    mockTransfer.mockReset()
    mockGetTransactionReceipt.mockReset()
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

  async function makeWdkEscrow(status: 'COMPLETED' | 'REFUNDED' | 'SPLIT') {
    const seller = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
    const buyer = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
    createdUserIds.push(seller.id, buyer.id)
    const buyerPayoutAddress = `buyer-payout-${buyer.id}`
    await prisma.payoutAddress.create({ data: { participantId: buyer.id, asset: 'USDT_ERC20', address: buyerPayoutAddress } })
    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'USDT_ERC20', side: 'SELL', priceUsd: '1', minAmount: '5', maxAmount: '5', paymentMethod: 'OTHER' })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '5' })
    createdTradeIds.push(trade.id)
    const escrow = await prisma.escrow.create({ data: { tradeId: trade.id, type: 'WDK_USDT_EVM', status, lockedAmount: '5', asset: 'USDT_ERC20' } })
    createdEscrowIds.push(escrow.id)
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id, status: 'ACTIVE' } })
    return { tradeId: trade.id, escrowId: escrow.id, sellerId: seller.id, buyerId: buyer.id, buyerPayoutAddress }
  }
  type Ctx = Awaited<ReturnType<typeof makeWdkEscrow>>

  async function makeAttempt(escrowId: string, operationType: 'RELEASE' | 'REFUND', destination: string, amount: string, status: 'PREPARED' | 'SUBMISSION_UNKNOWN' | 'SUBMITTED' | 'CONFIRMED' | 'REVERTED' | 'FAILED_BEFORE_SUBMISSION', txHash?: string) {
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
  const projectedFor = (escrowId: string, toStatus: 'COMPLETED' | 'REFUNDED') => async () => {
    const t = await prisma.escrowEvent.findFirst({ where: { escrowId, toStatus } })
    return !!t && (await prisma.eventProjectionClaim.count({ where: { projectionKey: 'transition.projected', subjectId: t.id } })) === 1
  }

  async function expectConvergedOnce(c: Ctx, toStatus: 'COMPLETED' | 'REFUNDED', txHash: string) {
    const [trade, events, buyer, seller] = await Promise.all([
      tradeOf(c.tradeId),
      prisma.escrowEvent.findMany({ where: { escrowId: c.escrowId, toStatus } }),
      userOf(c.buyerId),
      userOf(c.sellerId),
    ])
    expect(events).toHaveLength(1) // one canonical transition identity, never a duplicate economic disposition
    expect((await escrowOf(c.escrowId))!.txReleaseId).toBe(txHash)
    if (toStatus === 'COMPLETED') {
      expect(trade!.status).toBe('COMPLETED')
      expect(buyer!.totalTrades).toBe(1)
      expect(seller!.totalTrades).toBe(1)
    } else {
      expect(trade!.status).toBe('CANCELLED')
    }
  }

  // ── T1/T2 - CONFIRMED converges exactly once, no second transfer ──────────────────────────────────

  it('T1 RELEASE: provider CONFIRMED, crash before settlement-result persistence, restart, reconciliation -> existing txHash persisted, zero additional transfer() calls', async () => {
    pg.requirePostgres('T1 release confirmed')
    const c = await makeWdkEscrow('COMPLETED')
    const txHash = `0xrelease${randomUUID().replace(/-/g, '')}`
    await makeAttempt(c.escrowId, 'RELEASE', c.buyerPayoutAddress, '5', 'CONFIRMED', txHash)

    const report = await reconcilePendingSettlements({ projectionGraceMs: 0 })
    expect(report.recovered).toEqual([{ escrowId: c.escrowId, txId: txHash, outcome: 'ALREADY_CONFIRMED' }])
    expect(mockTransfer).not.toHaveBeenCalled() // Case A #2 - never submits another transfer

    await waitFor(projectedFor(c.escrowId, 'COMPLETED'))
    await sleep(300)
    await expectConvergedOnce(c, 'COMPLETED', txHash)
  })

  it('T2 REFUND: same invariant for REFUND — treasury destination, existing txHash persisted, zero additional transfer() calls', async () => {
    pg.requirePostgres('T2 refund confirmed')
    const c = await makeWdkEscrow('REFUNDED')
    const txHash = `0xrefund${randomUUID().replace(/-/g, '')}`
    await makeAttempt(c.escrowId, 'REFUND', TREASURY_ADDRESS, '5', 'CONFIRMED', txHash)

    const report = await reconcilePendingSettlements({ projectionGraceMs: 0 })
    expect(report.recovered).toEqual([{ escrowId: c.escrowId, txId: txHash, outcome: 'ALREADY_CONFIRMED' }])
    expect(mockTransfer).not.toHaveBeenCalled()

    await waitFor(projectedFor(c.escrowId, 'REFUNDED'))
    await sleep(300)
    await expectConvergedOnce(c, 'REFUNDED', txHash)
  })

  // ── T3/T4 - SUBMITTED: query, converge only on proven CONFIRMED ───────────────────────────────────

  it('T3 SUBMITTED becomes CONFIRMED: provider receipt now shows confirmed -> converges exactly once, zero additional transfer() calls', async () => {
    pg.requirePostgres('T3 submitted -> confirmed')
    const c = await makeWdkEscrow('COMPLETED')
    const txHash = `0xsub${randomUUID().replace(/-/g, '')}`
    await makeAttempt(c.escrowId, 'RELEASE', c.buyerPayoutAddress, '5', 'SUBMITTED', txHash)
    mockGetTransactionReceipt.mockResolvedValue({ status: 1 })

    const report = await reconcilePendingSettlements({ projectionGraceMs: 0 })
    expect(report.recovered).toEqual([{ escrowId: c.escrowId, txId: txHash, outcome: 'ALREADY_CONFIRMED' }])
    expect(mockGetTransactionReceipt).toHaveBeenCalledWith(txHash)
    expect(mockTransfer).not.toHaveBeenCalled()

    await waitFor(projectedFor(c.escrowId, 'COMPLETED'))
    await sleep(300)
    await expectConvergedOnce(c, 'COMPLETED', txHash)
  })

  it('T4 SUBMITTED remains pending: no receipt yet -> stays unconverged, no fabricated completion, no resubmission', async () => {
    pg.requirePostgres('T4 submitted stays pending')
    const c = await makeWdkEscrow('COMPLETED')
    const txHash = `0xpending${randomUUID().replace(/-/g, '')}`
    await makeAttempt(c.escrowId, 'RELEASE', c.buyerPayoutAddress, '5', 'SUBMITTED', txHash)
    mockGetTransactionReceipt.mockResolvedValue(null)

    const report = await reconcilePendingSettlements({ projectionGraceMs: 0 })
    expect(report.recovered).toEqual([])
    expect(report.requiresManualReview.some((m) => m.escrowId === c.escrowId && /not yet confirmed/.test(m.reason))).toBe(true)
    expect(mockTransfer).not.toHaveBeenCalled()
    expect((await escrowOf(c.escrowId))!.txReleaseId).toBeNull()
  })

  it('T4b SUBMITTED, receipt query genuinely fails (transport error): surfaced as a technical failure, never classified as REVERTED/CONFIRMED', async () => {
    pg.requirePostgres('T4b transport failure not misclassified')
    const c = await makeWdkEscrow('COMPLETED')
    const txHash = `0xtransport${randomUUID().replace(/-/g, '')}`
    await makeAttempt(c.escrowId, 'RELEASE', c.buyerPayoutAddress, '5', 'SUBMITTED', txHash)
    mockGetTransactionReceipt.mockRejectedValue(new Error('RPC timeout'))

    const report = await reconcilePendingSettlements({ projectionGraceMs: 0 })
    expect(report.recovered).toEqual([])
    expect(report.failed.some((f) => f.escrowId === c.escrowId && /RPC timeout/.test(f.error))).toBe(true)
    expect(report.requiresManualReview.some((m) => m.escrowId === c.escrowId)).toBe(false) // not a classification, a technical failure
    expect(mockTransfer).not.toHaveBeenCalled()
    expect((await escrowOf(c.escrowId))!.txReleaseId).toBeNull()
  })

  it('SUBMITTED reverted on-chain: definitively no funds delivered by this attempt — surfaced, never converged, never resubmitted', async () => {
    pg.requirePostgres('submitted reverted')
    const c = await makeWdkEscrow('COMPLETED')
    const txHash = `0xreverted${randomUUID().replace(/-/g, '')}`
    await makeAttempt(c.escrowId, 'RELEASE', c.buyerPayoutAddress, '5', 'SUBMITTED', txHash)
    mockGetTransactionReceipt.mockResolvedValue({ status: 0 })

    const report = await reconcilePendingSettlements({ projectionGraceMs: 0 })
    expect(report.recovered).toEqual([])
    expect(report.requiresManualReview.some((m) => m.escrowId === c.escrowId && /reverted on-chain/.test(m.reason))).toBe(true)
    expect(mockTransfer).not.toHaveBeenCalled()
    expect((await escrowOf(c.escrowId))!.txReleaseId).toBeNull()
  })

  // ── T5 - SUBMISSION_UNKNOWN ─────────────────────────────────────────────────────────────────────

  it('T5 SUBMISSION_UNKNOWN: never retried blindly, never classified as FAILED, no txReleaseId fabricated, stays an explicit inspectable state', async () => {
    pg.requirePostgres('T5 submission unknown')
    const c = await makeWdkEscrow('COMPLETED')
    await makeAttempt(c.escrowId, 'RELEASE', c.buyerPayoutAddress, '5', 'SUBMISSION_UNKNOWN')

    const report = await reconcilePendingSettlements({ projectionGraceMs: 0 })
    expect(report.recovered).toEqual([])
    expect(report.requiresManualReview.some((m) => m.escrowId === c.escrowId && /outcome is UNKNOWN/.test(m.reason))).toBe(true)
    expect(mockTransfer).not.toHaveBeenCalled()
    expect(mockGetTransactionReceipt).not.toHaveBeenCalled() // nothing to query - no txHash exists
    expect((await escrowOf(c.escrowId))!.txReleaseId).toBeNull()
    // repeated ticks: still no resubmission, still no fabricated result
    await reconcilePendingSettlements({ projectionGraceMs: 0 })
    expect(mockTransfer).not.toHaveBeenCalled()
    expect((await escrowOf(c.escrowId))!.txReleaseId).toBeNull()
  })

  // ── T6 - concurrent live completion vs reconciler ──────────────────────────────────────────────

  it('T6 concurrent live completion vs reconciler: both converge on the same provider evidence and one economic outcome', async () => {
    pg.requirePostgres('T6 concurrent live vs reconciler')
    const c = await makeWdkEscrow('COMPLETED')
    const txHash = `0xconcurrent${randomUUID().replace(/-/g, '')}`
    await makeAttempt(c.escrowId, 'RELEASE', c.buyerPayoutAddress, '5', 'CONFIRMED', txHash)

    // Two independent module graphs (instance A's own top-level reconcilePendingSettlements and
    // instance B's, from an entirely separate require() graph) racing the SAME terminal-without-result
    // escrow — the closest deterministic stand-in this harness has for "the original live caller
    // returns while the reconciler is processing the same operation": both sides ultimately go
    // through the identical frozen write-once persistSettlementResult() + emitEscrowTransition()
        // idempotency claim, so which one "wins" is immaterial to the outcome.
    const [ra, rb] = await Promise.all([
      reconcilePendingSettlements({ projectionGraceMs: 0 }),
      instanceB!.reconcile({ projectionGraceMs: 0 }),
    ])
    expect(ra.failed.filter((f) => f.escrowId === c.escrowId)).toEqual([])
    expect(rb.failed.filter((f) => f.escrowId === c.escrowId)).toEqual([])
    expect(mockTransfer).not.toHaveBeenCalled()

    await waitFor(projectedFor(c.escrowId, 'COMPLETED'))
    await sleep(300)
    await expectConvergedOnce(c, 'COMPLETED', txHash)
  })

  // ── T7 - repeated reconciliation ───────────────────────────────────────────────────────────────

  it('T7 repeated reconciliation: N runs after completion -> one economic completion, no further transfer() calls, no re-stamped result', async () => {
    pg.requirePostgres('T7 repeated reconciliation')
    const c = await makeWdkEscrow('COMPLETED')
    const txHash = `0xrepeat${randomUUID().replace(/-/g, '')}`
    await makeAttempt(c.escrowId, 'RELEASE', c.buyerPayoutAddress, '5', 'CONFIRMED', txHash)

    await reconcilePendingSettlements({ projectionGraceMs: 0 })
    await waitFor(projectedFor(c.escrowId, 'COMPLETED'))
    await sleep(300)
    const releasedAtAfterFirst = (await escrowOf(c.escrowId))!.releasedAt!.getTime()

    for (let i = 0; i < 4; i++) await reconcilePendingSettlements({ projectionGraceMs: 0 })
    expect(mockTransfer).not.toHaveBeenCalled()
    await expectConvergedOnce(c, 'COMPLETED', txHash)
    expect((await escrowOf(c.escrowId))!.releasedAt!.getTime()).toBe(releasedAtAfterFirst) // write-once, never re-stamped
  })

  // ── T8 - downstream effects exactly once ───────────────────────────────────────────────────────

  it('T8 downstream effects: EscrowEvent, Trade projection, counters and reputation apply effectively-once', async () => {
    pg.requirePostgres('T8 downstream effects once')
    const c = await makeWdkEscrow('COMPLETED')
    const txHash = `0xdownstream${randomUUID().replace(/-/g, '')}`
    await makeAttempt(c.escrowId, 'RELEASE', c.buyerPayoutAddress, '5', 'CONFIRMED', txHash)

    await Promise.all([reconcilePendingSettlements({ projectionGraceMs: 0 }), instanceB!.reconcile({ projectionGraceMs: 0 })])
    await waitFor(projectedFor(c.escrowId, 'COMPLETED'))
    await sleep(400)

    const [events, buyer, seller, trade, claims] = await Promise.all([
      prisma.escrowEvent.findMany({ where: { escrowId: c.escrowId, toStatus: 'COMPLETED' } }),
      userOf(c.buyerId), userOf(c.sellerId), tradeOf(c.tradeId),
      prisma.eventProjectionClaim.count({ where: { projectionKey: 'trade.status', subjectId: c.tradeId } }),
    ])
    expect(events).toHaveLength(1)
    expect(trade!.status).toBe('COMPLETED')
    expect(trade!.completedAt).not.toBeNull()
    expect(buyer!.totalTrades).toBe(1)
    expect(seller!.totalTrades).toBe(1)
    expect(buyer!.reputationScore).toBe(2)
    expect(seller!.reputationScore).toBe(2)
    expect(claims).toBe(1)
  })

  // ── T9 - contradictory provider evidence fails closed ──────────────────────────────────────────

  it('T9a contradictory evidence: attempt amount differs from escrow.lockedAmount — fails closed, surfaced, never converged', async () => {
    pg.requirePostgres('T9a amount mismatch')
    const c = await makeWdkEscrow('COMPLETED')
    const txHash = `0xamount${randomUUID().replace(/-/g, '')}`
    await makeAttempt(c.escrowId, 'RELEASE', c.buyerPayoutAddress, '999', 'CONFIRMED', txHash) // wrong amount

    const report = await reconcilePendingSettlements({ projectionGraceMs: 0 })
    expect(report.recovered).toEqual([])
    expect(report.requiresManualReview.some((m) => m.escrowId === c.escrowId && /does not match the expected RELEASE amount/.test(m.reason))).toBe(true)
    expect(mockTransfer).not.toHaveBeenCalled()
    expect((await escrowOf(c.escrowId))!.txReleaseId).toBeNull()
  })

  it('T9b contradictory evidence: attempt destination differs from the independently-derived expected destination — fails closed, surfaced, never converged', async () => {
    pg.requirePostgres('T9b destination mismatch')
    const c = await makeWdkEscrow('REFUNDED')
    const txHash = `0xdest${randomUUID().replace(/-/g, '')}`
    await makeAttempt(c.escrowId, 'REFUND', 'some-other-address-entirely', '5', 'CONFIRMED', txHash) // not the treasury

    const report = await reconcilePendingSettlements({ projectionGraceMs: 0 })
    expect(report.recovered).toEqual([])
    expect(report.requiresManualReview.some((m) => m.escrowId === c.escrowId && /does not match the independently-derived expected/.test(m.reason))).toBe(true)
    expect(mockTransfer).not.toHaveBeenCalled()
    expect((await escrowOf(c.escrowId))!.txReleaseId).toBeNull()
  })

  it('T9c malformed evidence: CONFIRMED attempt with no txHash — fails closed as a data integrity violation', async () => {
    pg.requirePostgres('T9c confirmed without txhash')
    const c = await makeWdkEscrow('COMPLETED')
    await makeAttempt(c.escrowId, 'RELEASE', c.buyerPayoutAddress, '5', 'CONFIRMED', undefined)

    const report = await reconcilePendingSettlements({ projectionGraceMs: 0 })
    expect(report.recovered).toEqual([])
    expect(report.requiresManualReview.some((m) => m.escrowId === c.escrowId && /data integrity violation/.test(m.reason))).toBe(true)
    expect(mockTransfer).not.toHaveBeenCalled()
  })

  it('T9d no attempt at all — fails closed, cannot invent evidence that does not exist', async () => {
    pg.requirePostgres('T9d no attempt')
    const c = await makeWdkEscrow('COMPLETED')

    const report = await reconcilePendingSettlements({ projectionGraceMs: 0 })
    expect(report.recovered).toEqual([])
    expect(report.requiresManualReview.some((m) => m.escrowId === c.escrowId && /No WdkTransferAttempt exists/.test(m.reason))).toBe(true)
    expect(mockTransfer).not.toHaveBeenCalled()
  })

  // ── T10 - restart reality (independent module graph, not the same instance invoked twice) ────────

  it('T10 restart reality: an independent module graph (fresh Prisma pool, event bus, handlers) converges the SAME persisted PostgreSQL state a prior "process" left behind', async () => {
    pg.requirePostgres('T10 genuine restart boundary')
    const c = await makeWdkEscrow('COMPLETED')
    const txHash = `0xrestart${randomUUID().replace(/-/g, '')}`
    await makeAttempt(c.escrowId, 'RELEASE', c.buyerPayoutAddress, '5', 'CONFIRMED', txHash)

    // instanceB never participated in creating this escrow/attempt - it only ever sees them through
    // its OWN, independently-constructed Prisma client reading the same real database, exactly what a
    // genuinely restarted process would do.
    const report = await instanceB!.reconcile({ projectionGraceMs: 0 })
    expect(report.recovered).toEqual([{ escrowId: c.escrowId, txId: txHash, outcome: 'ALREADY_CONFIRMED' }])
    expect(mockTransfer).not.toHaveBeenCalled()

    await waitFor(projectedFor(c.escrowId, 'COMPLETED'))
    await sleep(300)
    await expectConvergedOnce(c, 'COMPLETED', txHash)
  })

  // ── SPLIT (Issue #250) ──────────────────────────────────────────────────────────────────────────
  // SPLIT restart convergence itself (two independent legs) is implemented and proven in
  // tests/integration/wdkSplitRestartConvergence.test.ts, not this file. This file only keeps a
  // minimal cross-check that reconcileWdkTerminalTransfer() still dispatches a SPLIT escrow somewhere
  // sane (fails closed with no attempts at all) rather than silently doing nothing, so a future change
  // to the RELEASE/REFUND branch above can't accidentally swallow SPLIT without any test noticing.

  it('SPLIT with no attempts at all: fails closed, zero transfer() calls (full SPLIT coverage lives in wdkSplitRestartConvergence.test.ts)', async () => {
    pg.requirePostgres('split no attempts')
    const c = await makeWdkEscrow('SPLIT')

    const report = await reconcilePendingSettlements({ projectionGraceMs: 0 })
    expect(report.recovered).toEqual([])
    expect(report.requiresManualReview.some((m) => m.escrowId === c.escrowId)).toBe(true)
    expect(mockTransfer).not.toHaveBeenCalled()
    expect(mockGetTransactionReceipt).not.toHaveBeenCalled()
  })
})
