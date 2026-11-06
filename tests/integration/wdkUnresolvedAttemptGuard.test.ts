// tests/integration/wdkUnresolvedAttemptGuard.test.ts
//
// D7 (#341, Gatekeeper 6675288389, C3.2): a WDK_USDT_EVM outbound transfer whose outcome is not proven
// (SUBMISSION_UNKNOWN, SUBMITTED) or is proven sent (CONFIRMED) is economic execution. Nothing that authorized it
// may be rolled back (the escrow claim, the dispute ruling), and no other operation of the same escrow (RELEASE,
// REFUND, the SPLIT legs) may start while it is unreconciled. Real PostgreSQL and the production paths
// (DisputeService.applyRuling -> escrowService.*Funds -> wdkSettlementProvider -> ensureAttempt); only the wallet
// is a fake, so every transfer() call is counted and no funds exist.
//
// Harness adaptation, not a weakened assertion: escrowService hands the provider the Prisma row, whose
// lockedAmount is a Prisma.Decimal, while wdkSettlementProvider's toBaseUnits() calls .split('.') on it. With a
// real row the provider throws a TypeError before any attempt exists, so the paths under test are unreachable. The
// harness converts lockedAmount to its decimal string at the provider boundary (what reconciliation already does,
// escrow-settlement-reconciliation.service.ts: lockedAmount.toString()). The production call sites are a separate
// finding reported to the CTO; they are not changed here.

process.env.WDK_SEED_PHRASE = process.env.WDK_SEED_PHRASE || 'test only seed phrase for wdk unresolved attempt guard integration tests - never a real wallet'
process.env.WDK_USDT_CONTRACT = process.env.WDK_USDT_CONTRACT || '0x0000000000000000000000000000000000000001'
const mockTransfer = jest.fn()
const mockGetTransactionReceipt = jest.fn()
const fakeAccount = (address: string) => ({
  getAddress: async () => address,
  transfer: (...args: unknown[]) => mockTransfer(...args),
  getTransactionReceipt: (...args: unknown[]) => mockGetTransactionReceipt(...args),
})
const treasuryAccount = fakeAccount('treasury-fake-evm-address')
const escrowAccount = fakeAccount('escrow-fake-evm-address')

jest.mock('@tetherto/wdk-wallet-evm', () => ({
  __esModule: true,
  default: class FakeWalletManagerEvm {
    async getAccount(index: number) { return index === 0 ? treasuryAccount : escrowAccount }
    async getAccountByPath(_path: string) { return escrowAccount }
  },
}))

import { PrismaClient } from '@prisma/client'
import { spawn } from 'child_process'
import { randomBytes } from 'crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'

const ARBITER = 'k6-test-arbiter'
type Ruling = 'RELEASE' | 'REFUND' | 'SPLIT'

describe('D7 - an unreconciled WDK attempt blocks rollback and every other operation of its escrow (real PostgreSQL)', () => {
  jest.setTimeout(120_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let liquidityRouter: typeof import('../../src/modules/open-liquidity/liquidity.service').liquidityRouter
  let tradeService: typeof import('../../src/modules/open-p2p/trade.service').tradeService
  let escrowService: typeof import('../../src/modules/open-settlement/escrow.service').escrowService
  let reconcilePendingSettlements: typeof import('../../src/modules/open-settlement/escrow-settlement-reconciliation.service').reconcilePendingSettlements
  let DisputeService: typeof import('../../src/modules/open-settlement/dispute.service').DisputeService
  let marketArbitrationProvider: typeof import('../../src/modules/open-settlement/market-arbitration.provider').marketArbitrationProvider

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'true' // creation-time default only - escrows below are explicitly WDK_USDT_EVM
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service'))
    ;({ tradeService } = require('../../src/modules/open-p2p/trade.service'))
    ;({ escrowService } = require('../../src/modules/open-settlement/escrow.service'))
    ;({ reconcilePendingSettlements } = require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service'))
    ;({ DisputeService } = require('../../src/modules/open-settlement/dispute.service'))
    ;({ marketArbitrationProvider } = require('../../src/modules/open-settlement/market-arbitration.provider'))
    const { intentEngine } = require('../../src/core/intent-engine')
    const { OpenP2PTradeIntentHandler } = require('../../src/modules/open-p2p/intent-handler')
    intentEngine.registerHandler(OpenP2PTradeIntentHandler)
    require('../../src/common/events/handlers').registerEventHandlers()
    // D9: the arbiter's own track record (rulingsTotal) is one of the effects asserted below.
    await prisma.user.upsert({ where: { id: ARBITER }, update: {}, create: { id: ARBITER, publicKey: `d9-${randomBytes(16).toString('hex')}` } })
    await prisma.arbiterProfile.upsert({ where: { participantId: ARBITER }, update: {}, create: { participantId: ARBITER } })

    // The Decimal -> string harness adaptation described in the header.
    const { wdkSettlementProvider } = require('../../src/modules/open-settlement/wdk-settlement.provider')
    // failBeforeAttempt: the provider fails after the claim and before any attempt exists (D8 case 6).
    for (const method of ['releaseFunds', 'refundFunds', 'splitFunds'] as const) {
      const real = wdkSettlementProvider[method].bind(wdkSettlementProvider)
      wdkSettlementProvider[method] = async (escrow: { lockedAmount: unknown }, ...rest: unknown[]) => {
        if (failBeforeAttempt) throw new Error('wallet unavailable before any attempt was recorded')
        return real({ ...escrow, lockedAmount: String(escrow.lockedAmount) }, ...rest)
      }
    }
  })

  let failBeforeAttempt = false
  beforeEach(() => {
    mockTransfer.mockReset()
    mockGetTransactionReceipt.mockReset()
    failBeforeAttempt = false
    jest.restoreAllMocks()
  })

  afterAll(async () => {
    if (dbAvailable) {
      await prisma.$disconnect()
      await closeTestRedis()
    }
  })

  const user = () => prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
  const service = () => new DisputeService(marketArbitrationProvider) as any
  const transfersTo = () => mockTransfer.mock.calls.map((c) => (c[0] as { recipient: string }).recipient)
  const sentTransfer = (hash: string) => async () => ({ hash })
  const lostTransfer = async () => { throw new Error('socket hang up: the response was lost, the broadcast may have happened') }

  async function makeDisputedWdkEscrow() {
    const seller = await user()
    const buyer = await user()
    await prisma.payoutAddress.create({ data: { participantId: buyer.id, asset: 'USDT_ERC20', address: `buyer-payout-${buyer.id}` } })
    await prisma.payoutAddress.create({ data: { participantId: seller.id, asset: 'USDT_ERC20', address: `seller-payout-${seller.id}` } })
    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'USDT_ERC20', side: 'SELL', priceUsd: '1', minAmount: '5', maxAmount: '5', paymentMethod: 'OTHER' })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '5' })
    const escrow = await prisma.escrow.create({ data: { tradeId: trade.id, type: 'WDK_USDT_EVM', status: 'DISPUTED', lockedAmount: '5', asset: 'USDT_ERC20' } })
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id, status: 'DISPUTED' } })
    const dispute = await prisma.dispute.create({ data: { tradeId: trade.id, escrowId: escrow.id, openedBy: buyer.id, reason: 'd7', status: 'OPENED', arbiterId: ARBITER } })
    return { escrowId: escrow.id, tradeId: trade.id, buyerId: buyer.id, sellerId: seller.id, dispute, buyerPayout: `buyer-payout-${buyer.id}`, sellerPayout: `seller-payout-${seller.id}` }
  }
  type Ctx = Awaited<ReturnType<typeof makeDisputedWdkEscrow>>

  const rule = (ctx: Ctx, ruling: Ruling) => service().applyRuling(ctx.dispute, ruling, ARBITER, ruling === 'SPLIT' ? 4000 : undefined)
  const stateOf = async (ctx: Ctx) => {
    const [escrow, dispute, attempts] = await Promise.all([
      prisma.escrow.findUnique({ where: { id: ctx.escrowId } }),
      prisma.dispute.findUnique({ where: { id: ctx.dispute.id } }),
      prisma.wdkTransferAttempt.findMany({ where: { escrowId: ctx.escrowId }, orderBy: { createdAt: 'asc' } }),
    ])
    return { escrow: escrow!.status, dispute: dispute!.status, ruling: dispute!.ruling, attempts: attempts.map((a) => `${a.operationType}:${a.status}`) }
  }
  // The settlement facts a disposition leaves behind, read apart from stateOf(): the recorded tx and the durable
  // settlement/ruling events (the control test at the end proves this probe sees a real one).
  const effectsOf = async (ctx: Ctx) => {
    const escrow = await prisma.escrow.findUnique({ where: { id: ctx.escrowId } })
    const events = await prisma.durableEventRecord.findMany({ where: { correlationId: ctx.tradeId }, orderBy: { publishedAt: 'asc' } })
    return { txReleaseId: escrow!.txReleaseId, events: events.map((e) => e.eventName).filter((n) => n.startsWith('settlement.escrow.') || n === 'dispute.resolved') }
  }
  const NONE = { txReleaseId: null, events: [] }
  // The reputational effects, read apart from everything else: the arbiter's ruling count, whether this dispute's
  // ruling was finalized, and both parties' reputation fields. `finalized` is the fact that gates rulingsTotal: its
  // claim transaction is where recordRuling() increments it. WDK escrows run trusted-list arbitration (market is
  // refused for WDK at boot), whose provider has no recordRuling(), so rulingsTotal itself stays 0 in this file.
  const reputationOf = async (ctx: Ctx) => {
    const [arbiter, finalized, parties] = await Promise.all([
      prisma.arbiterProfile.findUnique({ where: { participantId: ARBITER } }),
      prisma.eventProjectionClaim.count({ where: { eventId: ctx.dispute.id, projectionKey: 'dispute.ruling-finalized' } }),
      prisma.user.findMany({ where: { id: { in: [ctx.buyerId, ctx.sellerId] } }, orderBy: { id: 'asc' }, select: { id: true, reputationScore: true, totalTrades: true, disputeCount: true } }),
    ])
    return { rulingsTotal: arbiter!.rulingsTotal, finalized, parties }
  }
  const direct = (ctx: Ctx, op: 'RELEASE' | 'REFUND') =>
    op === 'RELEASE' ? escrowService.releaseFunds(ctx.escrowId, undefined, ARBITER, ctx.dispute.id) : escrowService.refundFunds(ctx.escrowId, ARBITER, ctx.dispute.id)
  // A potentially-sent attempt left by the old rollback defect (the escrow was reopened to DISPUTED around it).
  const seedAttempt = (ctx: Ctx, op: 'RELEASE' | 'REFUND', status: 'SUBMISSION_UNKNOWN' | 'SUBMITTED' | 'FAILED_BEFORE_SUBMISSION', extra: { activeKey?: string | null; txHash?: string } = {}) =>
    prisma.wdkTransferAttempt.create({ data: { escrowId: ctx.escrowId, operationType: op, destination: op === 'RELEASE' ? ctx.buyerPayout : 'treasury-fake-evm-address', amount: '5', status, activeKey: `${ctx.escrowId}:${op}`, ...extra } })

  // ─── Rollback after a possibly-sent transfer ─────────────────────────────────────────────────────────

  it.each(['RELEASE', 'REFUND'] as const)('%s whose transfer response is lost keeps the claim and the ruling: no rollback', async (ruling) => {
    pg.requirePostgres(`d7 ${ruling} unknown`)
    const ctx = await makeDisputedWdkEscrow()
    mockTransfer.mockImplementationOnce(lostTransfer)

    await expect(rule(ctx, ruling)).rejects.toThrow()

    expect(await stateOf(ctx)).toEqual({
      escrow: ruling === 'RELEASE' ? 'COMPLETED' : 'REFUNDED',
      dispute: 'RESOLVED', ruling,
      attempts: [`${ruling}:SUBMISSION_UNKNOWN`],
    })
    expect(mockTransfer).toHaveBeenCalledTimes(1)
  })

  it('the error raised is the existing "executed externally" class, so applyRuling() keeps the ruling', async () => {
    pg.requirePostgres('d7 error class')
    const ctx = await makeDisputedWdkEscrow()
    mockTransfer.mockImplementationOnce(lostTransfer)
    const { SettlementExecutedError } = require('../../src/common/errors')

    const err = await rule(ctx, 'RELEASE').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SettlementExecutedError)
  })

  // ─── An incompatible operation after an unreconciled attempt ─────────────────────────────────────────

  it.each([['RELEASE', 'REFUND'], ['REFUND', 'RELEASE']] as const)('%s UNKNOWN, then %s: refused, exactly one transfer ever made', async (first, second) => {
    pg.requirePostgres(`d7 ${first} then ${second}`)
    const ctx = await makeDisputedWdkEscrow()
    mockTransfer.mockImplementationOnce(lostTransfer).mockImplementation(sentTransfer('0xsecond'))
    mockGetTransactionReceipt.mockResolvedValue({ status: 1 })

    await expect(rule(ctx, first)).rejects.toThrow()
    // Whatever the dispute became, the second disposition must not move funds: by the ruling path, then directly.
    await rule(ctx, second).catch(() => undefined)
    await expect(direct(ctx, second)).rejects.toThrow()

    expect(mockTransfer).toHaveBeenCalledTimes(1)
    // State: the pending first disposition is still the one the escrow, the ruling and the ledger describe.
    expect(await stateOf(ctx)).toEqual({ escrow: first === 'RELEASE' ? 'COMPLETED' : 'REFUNDED', dispute: 'RESOLVED', ruling: first, attempts: [`${first}:SUBMISSION_UNKNOWN`] })
    expect(await effectsOf(ctx)).toEqual(NONE)
  })

  // D8 (Gatekeeper 6685390103): the escrow was reopened around a potentially-sent attempt by the old rollback.
  // A new incompatible decision must be refused without being recorded as its own settlement.
  it.each([['RELEASE', 'REFUND'], ['REFUND', 'RELEASE']] as const)('residue: %s pending on a reopened escrow, a %s ruling is refused and nothing it touched changes', async (pending, ruling) => {
    pg.requirePostgres(`d8 residue ${pending} ${ruling}`)
    const ctx = await makeDisputedWdkEscrow()
    await seedAttempt(ctx, pending, 'SUBMISSION_UNKNOWN')
    mockTransfer.mockImplementation(sentTransfer('0xother'))
    mockGetTransactionReceipt.mockResolvedValue({ status: 1 })
    await drain()
    const reputation = await reputationOf(ctx)
    const before = await stateOf(ctx)
    expect(before).toEqual({ escrow: 'DISPUTED', dispute: 'OPENED', ruling: null, attempts: [`${pending}:SUBMISSION_UNKNOWN`] })

    await expect(rule(ctx, ruling)).rejects.toThrow(/may already have moved/)
    await expect(direct(ctx, ruling)).rejects.toThrow(/may already have moved/)
    await drain()

    expect(mockTransfer).not.toHaveBeenCalled()
    expect(await stateOf(ctx)).toEqual(before)
    expect(await effectsOf(ctx)).toEqual(NONE)
    expect(await reputationOf(ctx)).toEqual(reputation)
  })

  it('residue after an appeal: a new-generation ruling cannot replace a historical attempt whose activeKey was released', async () => {
    pg.requirePostgres('d8 generation')
    const ctx = await makeDisputedWdkEscrow()
    await seedAttempt(ctx, 'RELEASE', 'FAILED_BEFORE_SUBMISSION', { activeKey: null })
    await seedAttempt(ctx, 'RELEASE', 'SUBMITTED', { activeKey: null, txHash: `0x${'ab'.repeat(32)}` })
    ctx.dispute = await prisma.dispute.update({ where: { id: ctx.dispute.id }, data: { status: 'APPEALED', appealRound: 1, previousRuling: 'RELEASE', previousArbiterId: ARBITER } })
    mockTransfer.mockImplementation(sentTransfer('0xrefund'))
    mockGetTransactionReceipt.mockResolvedValue({ status: 1 })
    const before = await stateOf(ctx)

    await expect(rule(ctx, 'REFUND')).rejects.toThrow(/may already have moved/)
    await expect(rule(ctx, 'SPLIT')).rejects.toThrow(/may already have moved/)

    expect(mockTransfer).not.toHaveBeenCalled()
    expect(await stateOf(ctx)).toEqual(before)
    expect((await prisma.dispute.findUnique({ where: { id: ctx.dispute.id } }))!.appealRound).toBe(1)
    expect(await effectsOf(ctx)).toEqual(NONE)
  })

  it('residue race: concurrent incompatible rulings, direct calls and the reconciler change nothing and send nothing', async () => {
    pg.requirePostgres('d8 residue race')
    const ctx = await makeDisputedWdkEscrow()
    await seedAttempt(ctx, 'RELEASE', 'SUBMISSION_UNKNOWN')
    mockTransfer.mockImplementation(sentTransfer('0xrefund'))
    mockGetTransactionReceipt.mockResolvedValue({ status: 1 })
    const before = await stateOf(ctx)

    await Promise.all([
      ...Array.from({ length: 4 }, () => rule(ctx, 'REFUND').catch(() => undefined)),
      ...Array.from({ length: 4 }, () => direct(ctx, 'REFUND').catch(() => undefined)),
      rule(ctx, 'SPLIT').catch(() => undefined),
      reconcilePendingSettlements({ projectionGraceMs: 0 }).catch(() => undefined),
      reconcilePendingSettlements({ projectionGraceMs: 0 }).catch(() => undefined),
    ])

    expect(mockTransfer).not.toHaveBeenCalled()
    expect(await stateOf(ctx)).toEqual(before)
    expect(await effectsOf(ctx)).toEqual(NONE)
  })

  // ─── Failures inside the catch itself ────────────────────────────────────────────────────────────────

  it('the provider fails after the claim and before any attempt: the claim and the ruling roll back', async () => {
    pg.requirePostgres('d8 catch no attempt')
    const ctx = await makeDisputedWdkEscrow()
    failBeforeAttempt = true

    await expect(rule(ctx, 'RELEASE')).rejects.toThrow(/wallet unavailable/)

    expect(await stateOf(ctx)).toEqual({ escrow: 'DISPUTED', dispute: 'OPENED', ruling: null, attempts: [] })
    expect(await effectsOf(ctx)).toEqual(NONE)
    expect(mockTransfer).not.toHaveBeenCalled()
  })

  it.each([
    ['a lost transfer', 'RELEASE:SUBMISSION_UNKNOWN'],
    ['no attempt at all', null],
  ] as const)('the attempt ledger cannot be read in the catch (%s): fail closed, the claim and the ruling are kept', async (_label, attempt) => {
    pg.requirePostgres(`d8 ledger read failure ${_label}`)
    const ctx = await makeDisputedWdkEscrow()
    const { wdkTransferAttemptRepository } = require('../../src/modules/open-settlement/wdk-transfer-attempt-repository')
    const real = wdkTransferAttemptRepository.findPotentiallySent.bind(wdkTransferAttemptRepository)
    // Only the catch's read fails: the one made in a transaction for this disposition's own operations (the
    // resolve-write's D9 read, also in a transaction, asks about the other dispositions).
    const catchRead = (args: unknown[]) => !!args[2] && JSON.stringify(args[1]) === JSON.stringify(['RELEASE'])
    jest.spyOn(wdkTransferAttemptRepository, 'findPotentiallySent').mockImplementation((...args: unknown[]) => (catchRead(args) ? Promise.reject(new Error('ledger unreachable')) : real(...args)))
    if (attempt) mockTransfer.mockImplementationOnce(lostTransfer)
    else failBeforeAttempt = true
    const { SettlementExecutedError } = require('../../src/common/errors')

    const err = await rule(ctx, 'RELEASE').catch((e: unknown) => e)

    expect(err).toBeInstanceOf(SettlementExecutedError)
    expect(String((err as Error).message)).toMatch(/non-submission could not be established/)
    expect(await stateOf(ctx)).toEqual({ escrow: 'COMPLETED', dispute: 'RESOLVED', ruling: 'RELEASE', attempts: attempt ? [attempt] : [] })
    expect(await effectsOf(ctx)).toEqual(NONE)
    expect(mockTransfer).toHaveBeenCalledTimes(attempt ? 1 : 0)
  })

  it('the attempt ledger cannot be read by the resolve-write itself (D9): the ruling is never committed', async () => {
    pg.requirePostgres('d9 resolve-write read failure')
    const ctx = await makeDisputedWdkEscrow()
    const { wdkTransferAttemptRepository } = require('../../src/modules/open-settlement/wdk-transfer-attempt-repository')
    jest.spyOn(wdkTransferAttemptRepository, 'findPotentiallySent').mockRejectedValue(new Error('ledger unreachable'))

    await expect(rule(ctx, 'RELEASE')).rejects.toThrow(/ledger unreachable/)

    expect(await stateOf(ctx)).toEqual({ escrow: 'DISPUTED', dispute: 'OPENED', ruling: null, attempts: [] })
    expect(await effectsOf(ctx)).toEqual(NONE)
    expect(mockTransfer).not.toHaveBeenCalled()
  })

  // ─── Redelivery ──────────────────────────────────────────────────────────────────────────────────────

  it('redelivering the same RELEASE (ruling, direct call, reconciler) after a lost transfer moves nothing again', async () => {
    pg.requirePostgres('d8 redelivery')
    const ctx = await makeDisputedWdkEscrow()
    await drain()
    const reputation = await reputationOf(ctx)
    mockTransfer.mockImplementationOnce(lostTransfer).mockImplementation(sentTransfer('0xresent'))
    mockGetTransactionReceipt.mockResolvedValue({ status: 1 })

    await expect(rule(ctx, 'RELEASE')).rejects.toThrow()
    await expect(rule(ctx, 'RELEASE')).rejects.toThrow()
    await expect(direct(ctx, 'RELEASE')).rejects.toThrow()
    const reports = [await reconcilePendingSettlements({ projectionGraceMs: 0 }), await reconcilePendingSettlements({ projectionGraceMs: 0 })]

    expect(mockTransfer).toHaveBeenCalledTimes(1)
    expect(reports.every((r) => r.requiresManualReview.some((m) => m.escrowId === ctx.escrowId))).toBe(true)
    expect(await stateOf(ctx)).toEqual({ escrow: 'COMPLETED', dispute: 'RESOLVED', ruling: 'RELEASE', attempts: ['RELEASE:SUBMISSION_UNKNOWN'] })
    expect(await effectsOf(ctx)).toEqual(NONE)
    // The kept ruling (funds may have moved) is finalized by recovery exactly once across the repeated passes;
    // the parties' reputation is untouched (no settlement was recorded, so no outcome was projected).
    expect(await reputationOf(ctx)).toEqual({ ...reputation, finalized: 1 })
  })

  // ─── SPLIT: each leg keeps its own state ─────────────────────────────────────────────────────────────

  it('SPLIT with the buyer leg confirmed and the seller leg UNKNOWN: no rollback, no other disposition, no leg re-sent', async () => {
    pg.requirePostgres('d7 split partial')
    const ctx = await makeDisputedWdkEscrow()
    await drain()
    const reputation = await reputationOf(ctx)
    mockTransfer.mockImplementationOnce(sentTransfer('0xbuyerleg')).mockImplementationOnce(lostTransfer).mockImplementation(sentTransfer('0xother'))
    mockGetTransactionReceipt.mockResolvedValue({ status: 1 })

    await expect(rule(ctx, 'SPLIT')).rejects.toThrow()
    expect(await stateOf(ctx)).toEqual({ escrow: 'SPLIT', dispute: 'RESOLVED', ruling: 'SPLIT', attempts: ['SPLIT_BUYER:CONFIRMED', 'SPLIT_SELLER:SUBMISSION_UNKNOWN'] })

    await rule(ctx, 'REFUND').catch(() => undefined)
    await escrowService.refundFunds(ctx.escrowId, ARBITER, ctx.dispute.id).catch(() => undefined)
    const report = await reconcilePendingSettlements({ projectionGraceMs: 0 })

    expect(transfersTo()).toEqual([ctx.buyerPayout, ctx.sellerPayout])
    expect(report.requiresManualReview.some((r) => r.escrowId === ctx.escrowId)).toBe(true)
    expect(await stateOf(ctx)).toEqual({ escrow: 'SPLIT', dispute: 'RESOLVED', ruling: 'SPLIT', attempts: ['SPLIT_BUYER:CONFIRMED', 'SPLIT_SELLER:SUBMISSION_UNKNOWN'] })
    expect(await effectsOf(ctx)).toEqual(NONE)
    expect(await reputationOf(ctx)).toEqual({ ...reputation, finalized: 1 }) // the kept ruling, finalized once
  })

  it('SPLIT whose buyer leg is lost before the seller leg starts: the claim is kept on that leg alone', async () => {
    pg.requirePostgres('d8 split first leg')
    const ctx = await makeDisputedWdkEscrow()
    mockTransfer.mockImplementationOnce(lostTransfer).mockImplementation(sentTransfer('0xother'))

    await expect(rule(ctx, 'SPLIT')).rejects.toThrow()

    expect(transfersTo()).toEqual([ctx.buyerPayout])
    expect(await stateOf(ctx)).toEqual({ escrow: 'SPLIT', dispute: 'RESOLVED', ruling: 'SPLIT', attempts: ['SPLIT_BUYER:SUBMISSION_UNKNOWN'] })
    expect(await effectsOf(ctx)).toEqual(NONE)
  })

  // ─── Concurrency: rollback, a new disposition and the reconciler ─────────────────────────────────────

  it('a held lost transfer, a concurrent REFUND retried in a loop, and the reconciler: one transfer, nothing reopened', async () => {
    pg.requirePostgres('d7 concurrency')
    const ctx = await makeDisputedWdkEscrow()
    let releaseLost!: () => void
    let inFlight!: () => void
    const held = new Promise<void>((r) => { releaseLost = r })
    const transferStarted = new Promise<void>((r) => { inFlight = r })
    mockTransfer.mockImplementationOnce(async () => { inFlight(); await held; throw new Error('socket hang up') }).mockImplementation(sentTransfer('0xrefund'))
    mockGetTransactionReceipt.mockResolvedValue({ status: 1 })

    const ruling = rule(ctx, 'RELEASE').catch(() => undefined)
    await transferStarted // the RELEASE ruling and claim are committed and its transfer is on the wire
    let stop = false
    const competitor = (async () => {
      while (!stop) {
        await rule(ctx, 'REFUND').catch(() => undefined)
        await escrowService.refundFunds(ctx.escrowId, ARBITER, ctx.dispute.id).catch(() => undefined)
        await reconcilePendingSettlements({ projectionGraceMs: 0 }).catch(() => undefined)
      }
    })()
    await new Promise((r) => setTimeout(r, 300))
    releaseLost()
    await ruling
    await new Promise((r) => setTimeout(r, 1500))
    stop = true
    await competitor

    expect(mockTransfer).toHaveBeenCalledTimes(1)
    expect(await stateOf(ctx)).toEqual({ escrow: 'COMPLETED', dispute: 'RESOLVED', ruling: 'RELEASE', attempts: ['RELEASE:SUBMISSION_UNKNOWN'] })
    expect(await effectsOf(ctx)).toEqual(NONE)
  })

  // ─── SIGKILL at each critical boundary, then a fresh process ─────────────────────────────────────────

  const WORKER = path.join(__dirname, 'wdkUnresolvedAttempt.worker.ts')
  function runWorker(env: Record<string, string>): Promise<{ code: number | null; stderr: string; stdout: string }> {
    const child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', WORKER], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    let stdout = ''
    child.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-20_000) })
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    return new Promise((resolve) => child.on('exit', (code) => resolve({ code, stderr, stdout })))
  }

  it.each([
    ['in-transfer', 'SUBMISSION_UNKNOWN', 'none'],
    ['after-hash', 'SUBMITTED', 'confirmed'],
    ['in-revert', 'SUBMISSION_UNKNOWN', 'none'],
  ] as const)('SIGKILL %s: nothing is rolled back, and a fresh process neither re-sends nor starts the other disposition', async (killAt, attemptStatus, receipt) => {
    pg.requirePostgres(`d7 sigkill ${killAt}`)
    const ctx = await makeDisputedWdkEscrow()
    const sync = mkdtempSync(path.join(tmpdir(), 'd7-'))
    const effects = () => existsSync(path.join(sync, 'effects.log')) ? readFileSync(path.join(sync, 'effects.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []
    const common = { SYNC_DIR: sync, ESCROW_ID: ctx.escrowId, DISPUTE_ID: ctx.dispute.id, ARBITER, FAKE_TX_HASH: `0x${randomBytes(32).toString('hex')}`, MOCK_ESCROW: 'true' }
    try {
      const settle = await runWorker({ ...common, ROLE: 'settle', KILL_AT: killAt })
      expect(settle.stderr).toContain('SIGKILL_MARKER')
      expect(JSON.parse(readFileSync(path.join(sync, 'settle.killed.json'), 'utf8')).point).toBe(killAt)
      expect(effects()).toEqual([expect.objectContaining({ role: 'settle', recipient: ctx.buyerPayout })])
      expect(await stateOf(ctx)).toEqual({ escrow: 'COMPLETED', dispute: 'RESOLVED', ruling: 'RELEASE', attempts: [`RELEASE:${attemptStatus}`] })

      const recover = await runWorker({ ...common, ROLE: 'recover', RECEIPT: receipt })
      expect(recover.code).toBe(0)
      const result = JSON.parse(recover.stdout.split('\n').find((l) => l.startsWith('D7_RESULT '))!.slice('D7_RESULT '.length))
      expect(result.refundByRuling).toMatch(/^REFUSED/)
      expect(result.refundDirect).toMatch(/^REFUSED/)
      expect(effects()).toHaveLength(1) // no re-send, no REFUND transfer, across processes
      const state = await stateOf(ctx)
      expect(state).toMatchObject({ escrow: 'COMPLETED', dispute: 'RESOLVED', ruling: 'RELEASE' })
      expect(state.attempts.every((a) => a.startsWith('RELEASE:'))).toBe(true)
      const escrow = (await prisma.escrow.findUnique({ where: { id: ctx.escrowId } }))!
      if (receipt === 'confirmed') expect(escrow.txReleaseId).toBe(common.FAKE_TX_HASH) // converged from the recorded hash
      else {
        expect(escrow.txReleaseId).toBeNull()
        expect(result.manualReview).toBe(true) // UNKNOWN with no hash: left for an operator, never guessed
      }
    } finally {
      rmSync(sync, { recursive: true, force: true })
    }
  })

  // ─── D9: crash and race around the rollback, then restart and repeated recovery ──────────────────────
  // Other files' settled rulings may be finalized by any reconciler pass: drain them before taking a baseline.
  const drain = () => reconcilePendingSettlements({ projectionGraceMs: 0 })

  it.each([
    ['the provider fails before any attempt', 'RELEASE', null, 'after-escrow-revert'],
    ['RELEASE UNKNOWN pending, a REFUND ruling', 'REFUND', 'RELEASE', 'in-revert'],
    ['REFUND UNKNOWN pending, a RELEASE ruling', 'RELEASE', 'REFUND', 'in-revert'],
  ] as const)('SIGKILL at the rollback boundary (%s): after restarts and repeated recovery nothing is RESOLVED, counted or sent', async (_label, ruling, pending, killAt) => {
    pg.requirePostgres(`d9 sigkill ${_label}`)
    const ctx = await makeDisputedWdkEscrow()
    if (pending) await seedAttempt(ctx, pending, 'SUBMISSION_UNKNOWN')
    await drain()
    const before = { state: await stateOf(ctx), reputation: await reputationOf(ctx) }
    const sync = mkdtempSync(path.join(tmpdir(), 'd9-'))
    const effects = () => existsSync(path.join(sync, 'effects.log')) ? readFileSync(path.join(sync, 'effects.log'), 'utf8').trim().split('\n') : []
    const common = { SYNC_DIR: sync, ESCROW_ID: ctx.escrowId, DISPUTE_ID: ctx.dispute.id, ARBITER, FAKE_TX_HASH: `0x${randomBytes(32).toString('hex')}`, MOCK_ESCROW: 'true' }
    try {
      const settle = await runWorker({ ...common, ROLE: 'settle', KILL_AT: killAt, RULING: ruling, ...(pending ? {} : { FAIL_BEFORE_ATTEMPT: '1' }) })
      // The rollback boundary exists only when a claim was made. A ruling refused before any write (the residue
      // cases on the fixed code) never reaches it; the final state is what is asserted either way.
      if (!pending) expect(settle.stderr).toContain('SIGKILL_MARKER')
      for (let i = 0; i < 2; i++) expect((await runWorker({ ...common, ROLE: 'recover', RECOVER_ONLY: '1' })).code).toBe(0)
      await drain()

      expect(await stateOf(ctx)).toEqual(before.state)
      expect(await effectsOf(ctx)).toEqual(NONE)
      expect(effects()).toEqual([])
      expect(await reputationOf(ctx)).toEqual(before.reputation)
    } finally {
      rmSync(sync, { recursive: true, force: true })
    }
  })

  it('race: a failing ruling held in its provider call against a reconciler loop - it rolls back whole, nothing is sent', async () => {
    pg.requirePostgres('d9 race')
    const ctx = await makeDisputedWdkEscrow()
    await drain()
    const before = { state: await stateOf(ctx), reputation: await reputationOf(ctx) }
    let releaseFailure!: () => void
    let inProvider!: () => void
    const held = new Promise<void>((r) => { releaseFailure = r })
    const reached = new Promise<void>((r) => { inProvider = r })
    const { wdkSettlementProvider } = require('../../src/modules/open-settlement/wdk-settlement.provider')
    jest.spyOn(wdkSettlementProvider, 'releaseFunds').mockImplementation(async () => { inProvider(); await held; throw new Error('wallet unavailable before any attempt was recorded') })

    const ruling = rule(ctx, 'RELEASE').catch((e: Error) => e)
    await reached // the RELEASE ruling and the COMPLETED claim are committed
    let stop = false
    const reconciler = (async () => { while (!stop) await drain().catch(() => undefined) })()
    await new Promise((r) => setTimeout(r, 1500))
    releaseFailure()
    expect(await ruling).toBeInstanceOf(Error)
    await new Promise((r) => setTimeout(r, 1000))
    stop = true
    await reconciler

    expect(await stateOf(ctx)).toEqual(before.state)
    expect(await effectsOf(ctx)).toEqual(NONE)
    expect((await reputationOf(ctx)).parties).toEqual(before.reputation.parties)
    // Not asserted here: a reconciler pass DURING the provider call may finalize the still-RESOLVED ruling before it
    // rolls back (finalization does not check the escrow). Pre-existing #253 behaviour, reported to the CTO (D9).
    expect(mockTransfer).not.toHaveBeenCalled()
  })

  // ─── Positive controls: a proven non-submission still rolls back ─────────────────────────────────────

  it('a provider failure before any attempt exists still rolls the claim and the ruling back', async () => {
    pg.requirePostgres('d7 control no attempt')
    const ctx = await makeDisputedWdkEscrow()
    await prisma.payoutAddress.deleteMany({ where: { participantId: ctx.buyerId } }) // RELEASE fails resolving the destination

    await expect(rule(ctx, 'RELEASE')).rejects.toThrow()

    expect(await stateOf(ctx)).toEqual({ escrow: 'DISPUTED', dispute: 'OPENED', ruling: null, attempts: [] })
    expect(mockTransfer).not.toHaveBeenCalled()
  })

  it('a transfer proven reverted on-chain rolls back, and the other disposition may then proceed once', async () => {
    pg.requirePostgres('d7 control reverted')
    const ctx = await makeDisputedWdkEscrow()
    mockTransfer.mockImplementationOnce(sentTransfer('0xreverted')).mockImplementation(sentTransfer('0xrefund'))
    mockGetTransactionReceipt.mockResolvedValueOnce({ status: 0 }).mockResolvedValue({ status: 1 })

    await expect(rule(ctx, 'RELEASE')).rejects.toThrow(/reverted on-chain/)
    expect(await stateOf(ctx)).toEqual({ escrow: 'DISPUTED', dispute: 'OPENED', ruling: null, attempts: ['RELEASE:REVERTED'] })

    await drain()
    const reputation = await reputationOf(ctx)
    await rule(ctx, 'REFUND')
    expect((await stateOf(ctx)).escrow).toBe('REFUNDED')
    expect(mockTransfer).toHaveBeenCalledTimes(2)
    // Positive control for effectsOf(): a real settlement is visible to it.
    expect(await effectsOf(ctx)).toEqual({ txReleaseId: '0xrefund', events: ['settlement.escrow.refunded', 'dispute.resolved'] })
    // The refund's event handlers run fire-and-forget; let them finish before the file tears down. On 7bd64f0a one
    // still ran after teardown in CI, logged, and jest-runner set process.exitCode = 1 with every test passing.
    const transition = (await prisma.escrowEvent.findFirst({ where: { escrowId: ctx.escrowId, toStatus: 'REFUNDED' } }))!
    const end = Date.now() + 15_000
    while ((await prisma.eventProjectionClaim.count({ where: { projectionKey: 'transition.projected', subjectId: transition.id } })) === 0) {
      if (Date.now() > end) throw new Error('the REFUNDED transition was never projected')
      await new Promise((r) => setTimeout(r, 50))
    }
    // Positive control for reputationOf() (D9): a ruling whose settlement is recorded IS finalized and counted, once.
    const reports = [await drain(), await drain()]
    expect(reports.flatMap((r) => r.failed).filter((f) => f.escrowId === `dispute:${ctx.dispute.id}`)).toEqual([])
    expect(await reputationOf(ctx)).toMatchObject({ rulingsTotal: reputation.rulingsTotal, finalized: 1 })
  })
})
