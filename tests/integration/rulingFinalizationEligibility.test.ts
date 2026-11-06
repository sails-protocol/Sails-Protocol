// tests/integration/rulingFinalizationEligibility.test.ts
//
// D10 (#341, #585, Gatekeeper 6692048434) - RED reproductions for the ruling finalization contract. Not wired into
// any CI lane (excluded from test:unit, absent from test:integration:postgres) until a GREEN is authorized: each
// case below asserts the D10 contract and fails on a0349036. Run by hand against a disposable database:
//   npx jest tests/integration/rulingFinalizationEligibility.test.ts --runInBand
//
// The contract under test: a RESOLVED ruling is an arbitral decision, not proof of economic execution. Its
// finalization (finalizeResolveDispute(): rulingsTotal, cumulativeFeesObserved, the appeal fee, the slash and
// arbiter.slashed) must never run while that ruling can still be rolled back.
//
// Real PostgreSQL and the production paths. The recoverer is DisputeService(marketArbitrationProvider) with no
// resolver - the same instance shape as #253 B2 (durableProjectionCompletion.test.ts) - so recordRuling()/slash()
// really run. Only the wallet is a fake; where a provider call must be held or fail, it is replaced at runtime.
// The Decimal -> string adaptation of wdkUnresolvedAttemptGuard.test.ts's header applies to the one settling case.

process.env.WDK_SEED_PHRASE = process.env.WDK_SEED_PHRASE || 'test only seed phrase for ruling finalization eligibility integration tests - never a real wallet'
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
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'

const ARBITER = 'k6-test-arbiter'

describe('D10 - a ruling that can still be rolled back is never finalized (real PostgreSQL, RED on a0349036)', () => {
  jest.setTimeout(120_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let liquidityRouter: typeof import('../../src/modules/open-liquidity/liquidity.service').liquidityRouter
  let tradeService: typeof import('../../src/modules/open-p2p/trade.service').tradeService
  let DisputeService: typeof import('../../src/modules/open-settlement/dispute.service').DisputeService
  let marketArbitrationProvider: typeof import('../../src/modules/open-settlement/market-arbitration.provider').marketArbitrationProvider
  let wdkSettlementProvider: any

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'true' // creation-time default only - escrows below are explicitly WDK_USDT_EVM
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service'))
    ;({ tradeService } = require('../../src/modules/open-p2p/trade.service'))
    ;({ DisputeService } = require('../../src/modules/open-settlement/dispute.service'))
    ;({ marketArbitrationProvider } = require('../../src/modules/open-settlement/market-arbitration.provider'))
    ;({ wdkSettlementProvider } = require('../../src/modules/open-settlement/wdk-settlement.provider'))
    const { intentEngine } = require('../../src/core/intent-engine')
    const { OpenP2PTradeIntentHandler } = require('../../src/modules/open-p2p/intent-handler')
    intentEngine.registerHandler(OpenP2PTradeIntentHandler)
    require('../../src/common/events/handlers').registerEventHandlers()
    await prisma.user.upsert({ where: { id: ARBITER }, update: {}, create: { id: ARBITER, publicKey: `d10-${randomBytes(16).toString('hex')}` } })
    await prisma.arbiterProfile.upsert({ where: { participantId: ARBITER }, update: {}, create: { participantId: ARBITER } })
  })

  beforeEach(() => {
    mockTransfer.mockReset()
    mockGetTransactionReceipt.mockReset()
    jest.restoreAllMocks()
  })

  afterAll(async () => {
    if (dbAvailable) {
      await prisma.$disconnect()
      await closeTestRedis()
    }
  })

  const user = () => prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
  const ruler = () => new DisputeService(marketArbitrationProvider) as any
  // Bounded far above any backlog of other suites' RESOLVED rows in a shared database (as #253 B2 does).
  const recover = () => ruler().recoverMissingRulingFinalization(5000)

  async function makeDisputedWdkEscrow(dispute: Record<string, unknown> = {}) {
    const seller = await user()
    const buyer = await user()
    await prisma.payoutAddress.create({ data: { participantId: buyer.id, asset: 'USDT_ERC20', address: `buyer-payout-${buyer.id}` } })
    await prisma.payoutAddress.create({ data: { participantId: seller.id, asset: 'USDT_ERC20', address: `seller-payout-${seller.id}` } })
    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'USDT_ERC20', side: 'SELL', priceUsd: '1', minAmount: '5', maxAmount: '5', paymentMethod: 'OTHER' })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '5' })
    const escrow = await prisma.escrow.create({ data: { tradeId: trade.id, type: 'WDK_USDT_EVM', status: 'DISPUTED', lockedAmount: '5', asset: 'USDT_ERC20' } })
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id, status: 'DISPUTED' } })
    const row = await prisma.dispute.create({ data: { tradeId: trade.id, escrowId: escrow.id, openedBy: buyer.id, reason: 'd10', status: 'OPENED', arbiterId: ARBITER, ...dispute } })
    return { escrowId: escrow.id, tradeId: trade.id, buyerId: buyer.id, sellerId: seller.id, dispute: row }
  }
  type Ctx = Awaited<ReturnType<typeof makeDisputedWdkEscrow>>

  const rule = (ctx: Ctx, ruling: 'RELEASE' | 'REFUND') => ruler().applyRuling(ctx.dispute, ruling, ARBITER)
  const stateOf = async (ctx: Ctx) => {
    const [escrow, dispute] = await Promise.all([prisma.escrow.findUnique({ where: { id: ctx.escrowId } }), prisma.dispute.findUnique({ where: { id: ctx.dispute.id } })])
    return { escrow: escrow!.status, dispute: dispute!.status, ruling: dispute!.ruling, round: dispute!.appealRound }
  }
  // Every effect finalizeResolveDispute() can produce, read apart from the dispute's own state.
  const effectsOf = async (ctx: Ctx, round: number, previousArbiterId?: string) => {
    const [claims, arbiter, previous, fees, slashed, parties] = await Promise.all([
      prisma.eventProjectionClaim.count({ where: { eventId: ctx.dispute.id, projectionKey: 'dispute.ruling-finalized', subjectId: String(round) } }),
      prisma.arbiterProfile.findUnique({ where: { participantId: ARBITER } }),
      previousArbiterId ? prisma.arbiterProfile.findUnique({ where: { participantId: previousArbiterId } }) : null,
      prisma.disputeAppealFee.findMany({ where: { disputeId: ctx.dispute.id }, select: { appealRound: true, outcome: true } }),
      previousArbiterId ? prisma.durableEventRecord.count({ where: { eventName: 'arbiter.slashed', correlationId: previousArbiterId } }) : 0,
      prisma.user.findMany({ where: { id: { in: [ctx.buyerId, ctx.sellerId] } }, orderBy: { id: 'asc' }, select: { reputationScore: true, totalTrades: true, disputeCount: true } }),
    ])
    return {
      finalizationClaims: claims,
      rulingsTotal: arbiter!.rulingsTotal,
      cumulativeFeesObserved: String(arbiter!.cumulativeFeesObserved),
      previousArbiter: previous ? { collateral: String(previous.monetaryCollateral), reputation: previous.arbiterReputation, rulingsOverturned: previous.rulingsOverturned } : null,
      appealFees: fees,
      slashedEvents: slashed,
      parties,
    }
  }

  // The provider call of the ruling under test is held open, then fails with nothing sent (no attempt recorded):
  // exactly the case D9's rollback undoes.
  function holdThenFail(method: 'releaseFunds' | 'refundFunds') {
    let fail!: () => void
    let entered!: () => void
    const released = new Promise<void>((r) => { fail = r })
    const inProvider = new Promise<void>((r) => { entered = r })
    jest.spyOn(wdkSettlementProvider, method).mockImplementation(async () => { entered(); await released; throw new Error('wallet unavailable before any attempt was recorded') })
    return { inProvider, fail }
  }

  // ─── 1. A recoverer runs while the ruling's provider call is still in flight ─────────────────────────

  it('R1 reproduces: a recoverer pass during the provider call finalizes a ruling that is then rolled back', async () => {
    pg.requirePostgres('d10 r1')
    const ctx = await makeDisputedWdkEscrow()
    await recover()
    const before = await effectsOf(ctx, 0)
    const provider = holdThenFail('releaseFunds')

    const ruling = rule(ctx, 'RELEASE').catch((e: Error) => e)
    await provider.inProvider // RESOLVED and the COMPLETED claim are committed; nothing has been sent
    await recover()
    provider.fail()
    expect(await ruling).toBeInstanceOf(Error)

    expect(await stateOf(ctx)).toEqual({ escrow: 'DISPUTED', dispute: 'OPENED', ruling: null, round: 0 }) // D9 rollback: whole
    expect(mockTransfer).not.toHaveBeenCalled()
    expect(await effectsOf(ctx, 0)).toEqual(before) // RED on a0349036: finalizationClaims 1, rulingsTotal +1
  })

  // ─── 2. The provider fails after the recoverer selected the RESOLVED row, before its claim ───────────

  it('R2 reproduces: a candidate selected while RESOLVED is finalized from its snapshot after the rollback', async () => {
    pg.requirePostgres('d10 r2')
    const ctx = await makeDisputedWdkEscrow()
    await recover()
    const before = await effectsOf(ctx, 0)
    const provider = holdThenFail('releaseFunds')
    let openGate!: () => void
    const gate = new Promise<void>((r) => { openGate = r })
    let selected!: () => void
    const wasSelected = new Promise<void>((r) => { selected = r })
    const finalize = DisputeService.prototype as any
    const realFinalize = finalize.finalizeResolveDispute
    jest.spyOn(finalize, 'finalizeResolveDispute').mockImplementation(async function (this: unknown, ...args: any[]) {
      if (args[0]?.id === ctx.dispute.id) { selected(); await gate }
      return realFinalize.apply(this, args)
    })

    const ruling = rule(ctx, 'RELEASE').catch((e: Error) => e)
    await provider.inProvider
    const pass = recover()
    await wasSelected // the recoverer selected the RESOLVED row and holds its snapshot
    provider.fail()
    expect(await ruling).toBeInstanceOf(Error) // D9 rollback committed: OPENED again
    expect(await stateOf(ctx)).toEqual({ escrow: 'DISPUTED', dispute: 'OPENED', ruling: null, round: 0 })
    openGate()
    await pass

    expect(await effectsOf(ctx, 0)).toEqual(before) // RED on a0349036: the snapshot is finalized without revalidation
  })

  // ─── 3. Appeal round: fee, collateral, reputation, slash and its event ───────────────────────────────

  it('R3 reproduces: on an appeal round, a concurrent recoverer slashes the previous arbiter and settles the fee for a ruling that is rolled back', async () => {
    pg.requirePostgres('d10 r3')
    const previous = await user()
    await prisma.arbiterProfile.create({ data: { participantId: previous.id, monetaryCollateral: '10', collateralAsset: 'USDT_ERC20', arbiterReputation: 50 } })
    const ctx = await makeDisputedWdkEscrow({ status: 'APPEALED', appealRound: 1, previousRuling: 'RELEASE', previousArbiterId: previous.id })
    await prisma.disputeAppealFee.create({ data: { disputeId: ctx.dispute.id, appealRound: 1, requestedBy: ctx.sellerId, amount: '1', asset: 'USDT_ERC20' } })
    await recover()
    const before = await effectsOf(ctx, 1, previous.id)
    const provider = holdThenFail('refundFunds')

    const ruling = rule(ctx, 'REFUND').catch((e: Error) => e) // overturns RELEASE: would slash and refund the fee
    await provider.inProvider
    await recover()
    provider.fail()
    expect(await ruling).toBeInstanceOf(Error)

    expect(await stateOf(ctx)).toEqual({ escrow: 'DISPUTED', dispute: 'APPEALED', ruling: null, round: 1 })
    // RED on a0349036: claim, rulingsTotal, the previous arbiter's collateral/reputation/rulingsOverturned, the fee's
    // outcome and one arbiter.slashed event, all for a ruling that never executed.
    expect(await effectsOf(ctx, 1, previous.id)).toEqual(before)
  })

  // ─── 4. SIGKILL before the rollback, nothing sent ────────────────────────────────────────────────────

  const WORKER = path.join(__dirname, 'wdkUnresolvedAttempt.worker.ts')
  function runWorker(env: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
    const child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', WORKER], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-20_000) })
    return new Promise((resolve) => child.on('exit', (code) => resolve({ code, stderr })))
  }

  it('R4 reproduces: after a SIGKILL inside the rollback with no attempt, recovery finalizes a ruling that never executed', async () => {
    pg.requirePostgres('d10 r4')
    const ctx = await makeDisputedWdkEscrow()
    await recover()
    const before = await effectsOf(ctx, 0)
    const sync = mkdtempSync(path.join(tmpdir(), 'd10-'))
    try {
      const settle = await runWorker({ SYNC_DIR: sync, ESCROW_ID: ctx.escrowId, DISPUTE_ID: ctx.dispute.id, ARBITER, FAKE_TX_HASH: '0x00', MOCK_ESCROW: 'true', ROLE: 'settle', RULING: 'RELEASE', KILL_AT: 'in-revert', FAIL_BEFORE_ATTEMPT: '1' })
      expect(settle.stderr).toContain('SIGKILL_MARKER')
      // The process died before its rollback committed: claim and ruling stand, coherent, nothing was sent.
      expect(await stateOf(ctx)).toEqual({ escrow: 'COMPLETED', dispute: 'RESOLVED', ruling: 'RELEASE', round: 0 })
      expect(await prisma.wdkTransferAttempt.count({ where: { escrowId: ctx.escrowId } })).toBe(0)

      for (let i = 0; i < 3; i++) await recover()

      expect(await effectsOf(ctx, 0)).toEqual(before) // RED on a0349036: finalized and counted
    } finally {
      rmSync(sync, { recursive: true, force: true })
    }
  })

  // ─── 6. A ruling that can never execute: an appeal round on an escrow already settled by round 0 ─────
  // (dispute.service.ts recoverMissingRulingFinalization()'s header: "every later resolution attempt against the
  // now-terminal escrow structurally fails and reverts back to APPEALED".)

  it('R6 reproduces: an appeal ruling on an already-settled escrow is committed, then reverted - a recoverer in between slashes and settles the fee', async () => {
    pg.requirePostgres('d10 r6')
    const previous = await user()
    await prisma.arbiterProfile.create({ data: { participantId: previous.id, monetaryCollateral: '10', collateralAsset: 'USDT_ERC20', arbiterReputation: 50 } })
    const ctx = await makeDisputedWdkEscrow({ status: 'APPEALED', appealRound: 1, previousRuling: 'RELEASE', previousArbiterId: previous.id })
    await prisma.escrow.update({ where: { id: ctx.escrowId }, data: { status: 'COMPLETED', txReleaseId: `0x${randomBytes(32).toString('hex')}` } }) // round 0 settled
    await prisma.disputeAppealFee.create({ data: { disputeId: ctx.dispute.id, appealRound: 1, requestedBy: ctx.sellerId, amount: '1', asset: 'USDT_ERC20' } })
    await recover()
    const before = await effectsOf(ctx, 1, previous.id)
    // Hold the refund call between the resolve-write and its own structural failure (COMPLETED -> REFUNDED).
    const { escrowService } = require('../../src/modules/open-settlement/escrow.service')
    const realRefund = escrowService.refundFunds.bind(escrowService)
    let go!: () => void
    let entered!: () => void
    const gate = new Promise<void>((r) => { go = r })
    const inCall = new Promise<void>((r) => { entered = r })
    jest.spyOn(escrowService, 'refundFunds').mockImplementation(async (...args: unknown[]) => { entered(); await gate; return realRefund(...args) })

    const ruling = rule(ctx, 'REFUND').catch((e: Error) => e)
    await inCall // RESOLVED/REFUND for round 1 is committed; it cannot execute
    await recover()
    go()
    expect(String(await ruling)).toMatch(/Invalid escrow transition/)

    expect(await stateOf(ctx)).toEqual({ escrow: 'COMPLETED', dispute: 'APPEALED', ruling: null, round: 1 })
    expect(mockTransfer).not.toHaveBeenCalled()
    expect(await effectsOf(ctx, 1, previous.id)).toEqual(before) // RED on a0349036: slashed, fee REFUNDED, counted
  })

  // ─── 5. Invariant that must survive any fix: a settled ruling is finalized exactly once ──────────────

  it('R5 guard (green today, must stay green): a settled ruling is finalized exactly once across repeated recovery', async () => {
    pg.requirePostgres('d10 r5')
    const ctx = await makeDisputedWdkEscrow()
    for (const method of ['releaseFunds'] as const) {
      const real = wdkSettlementProvider[method].bind(wdkSettlementProvider)
      jest.spyOn(wdkSettlementProvider, method).mockImplementation((escrow: any, ...rest: unknown[]) => real({ ...escrow, lockedAmount: String(escrow.lockedAmount) }, ...rest))
    }
    mockTransfer.mockResolvedValue({ hash: `0x${randomBytes(32).toString('hex')}` })
    mockGetTransactionReceipt.mockResolvedValue({ status: 1 })
    await recover()
    const before = await effectsOf(ctx, 0)

    await rule(ctx, 'RELEASE') // applyRuling() alone: finalization is left to recovery, as after a crash

    // The release's event handlers run fire-and-forget: wait for them (they project the disputed outcome onto both
    // parties) before asserting, and so nothing logs after teardown (see wdkUnresolvedAttemptGuard.test.ts).
    const transition = (await prisma.escrowEvent.findFirst({ where: { escrowId: ctx.escrowId, toStatus: 'COMPLETED' } }))!
    const end = Date.now() + 15_000
    while ((await prisma.eventProjectionClaim.count({ where: { projectionKey: 'transition.projected', subjectId: transition.id } })) === 0) {
      if (Date.now() > end) throw new Error('the COMPLETED transition was never projected')
      await new Promise((r) => setTimeout(r, 50))
    }

    await recover()
    const once = await effectsOf(ctx, 0)
    expect(once).toMatchObject({ finalizationClaims: 1, rulingsTotal: before.rulingsTotal + 1, slashedEvents: 0 })
    await recover()
    await recover()

    expect(await stateOf(ctx)).toEqual({ escrow: 'COMPLETED', dispute: 'RESOLVED', ruling: 'RELEASE', round: 0 })
    expect(await effectsOf(ctx, 0)).toEqual(once) // repeated recovery changes nothing further
    expect(mockTransfer).toHaveBeenCalledTimes(1)
  })
})
