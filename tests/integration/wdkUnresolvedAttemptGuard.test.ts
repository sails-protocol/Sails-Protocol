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

    // The Decimal -> string harness adaptation described in the header.
    const { wdkSettlementProvider } = require('../../src/modules/open-settlement/wdk-settlement.provider')
    for (const method of ['releaseFunds', 'refundFunds', 'splitFunds'] as const) {
      const real = wdkSettlementProvider[method].bind(wdkSettlementProvider)
      wdkSettlementProvider[method] = (escrow: { lockedAmount: unknown }, ...rest: unknown[]) => real({ ...escrow, lockedAmount: String(escrow.lockedAmount) }, ...rest)
    }
  })

  beforeEach(() => {
    mockTransfer.mockReset()
    mockGetTransactionReceipt.mockReset()
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
    await (second === 'RELEASE' ? escrowService.releaseFunds(ctx.escrowId, undefined, ARBITER, ctx.dispute.id) : escrowService.refundFunds(ctx.escrowId, ARBITER, ctx.dispute.id)).catch(() => undefined)

    expect(mockTransfer).toHaveBeenCalledTimes(1)
    const state = await stateOf(ctx)
    expect(state.attempts).toEqual([`${first}:SUBMISSION_UNKNOWN`])
    expect(state.dispute).toBe('RESOLVED')
  })

  it('an escrow already reopened by the old rollback (residue of the defect) still refuses a second disposition', async () => {
    pg.requirePostgres('d7 residue')
    const ctx = await makeDisputedWdkEscrow()
    await prisma.wdkTransferAttempt.create({ data: { escrowId: ctx.escrowId, operationType: 'RELEASE', destination: ctx.buyerPayout, amount: '5', status: 'SUBMISSION_UNKNOWN', activeKey: `${ctx.escrowId}:RELEASE` } })
    mockTransfer.mockImplementation(sentTransfer('0xrefund'))
    mockGetTransactionReceipt.mockResolvedValue({ status: 1 })

    await expect(rule(ctx, 'REFUND')).rejects.toThrow()

    expect(mockTransfer).not.toHaveBeenCalled()
    expect((await stateOf(ctx)).attempts).toEqual(['RELEASE:SUBMISSION_UNKNOWN'])
  })

  // ─── SPLIT: each leg keeps its own state ─────────────────────────────────────────────────────────────

  it('SPLIT with the buyer leg confirmed and the seller leg UNKNOWN: no rollback, no other disposition, no leg re-sent', async () => {
    pg.requirePostgres('d7 split partial')
    const ctx = await makeDisputedWdkEscrow()
    mockTransfer.mockImplementationOnce(sentTransfer('0xbuyerleg')).mockImplementationOnce(lostTransfer).mockImplementation(sentTransfer('0xother'))
    mockGetTransactionReceipt.mockResolvedValue({ status: 1 })

    await expect(rule(ctx, 'SPLIT')).rejects.toThrow()
    expect(await stateOf(ctx)).toEqual({ escrow: 'SPLIT', dispute: 'RESOLVED', ruling: 'SPLIT', attempts: ['SPLIT_BUYER:CONFIRMED', 'SPLIT_SELLER:SUBMISSION_UNKNOWN'] })

    await rule(ctx, 'REFUND').catch(() => undefined)
    await escrowService.refundFunds(ctx.escrowId, ARBITER, ctx.dispute.id).catch(() => undefined)
    const report = await reconcilePendingSettlements({ projectionGraceMs: 0 })

    expect(transfersTo()).toEqual([ctx.buyerPayout, ctx.sellerPayout])
    expect(report.requiresManualReview.some((r) => r.escrowId === ctx.escrowId)).toBe(true)
    expect((await stateOf(ctx)).attempts).toEqual(['SPLIT_BUYER:CONFIRMED', 'SPLIT_SELLER:SUBMISSION_UNKNOWN'])
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

    await rule(ctx, 'REFUND')
    expect((await stateOf(ctx)).escrow).toBe('REFUNDED')
    expect(mockTransfer).toHaveBeenCalledTimes(2)
  })
})
