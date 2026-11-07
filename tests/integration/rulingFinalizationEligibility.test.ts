// tests/integration/rulingFinalizationEligibility.test.ts
//
// D10 (#341, #585, Gatekeeper 6692048434) - the ruling finalization contract. Written first as RED reproductions
// (bdab1b46: R1-R4 and R6 fail on a0349036, R5 passes), GREEN with D10 P1/P2 (dispute.service.ts). Runs in the serial
// PostgreSQL lane (test:integration:postgres), like the other files that spawn OS processes.
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

describe('D10 - a ruling that can still be rolled back is never finalized (real PostgreSQL)', () => {
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

  async function makeDisputedWdkEscrow(dispute: Record<string, unknown> = {}, type: 'WDK_USDT_EVM' | 'MOCK' = 'WDK_USDT_EVM') {
    const seller = await user()
    const buyer = await user()
    await prisma.payoutAddress.create({ data: { participantId: buyer.id, asset: 'USDT_ERC20', address: `buyer-payout-${buyer.id}` } })
    await prisma.payoutAddress.create({ data: { participantId: seller.id, asset: 'USDT_ERC20', address: `seller-payout-${seller.id}` } })
    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'USDT_ERC20', side: 'SELL', priceUsd: '1', minAmount: '5', maxAmount: '5', paymentMethod: 'OTHER' })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '5' })
    const escrow = await prisma.escrow.create({ data: { tradeId: trade.id, type, status: 'DISPUTED', lockedAmount: '5', asset: 'USDT_ERC20' } })
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
  function holdThenFail(method: 'releaseFunds' | 'refundFunds', provider: any = wdkSettlementProvider) {
    let fail!: () => void
    let entered!: () => void
    const released = new Promise<void>((r) => { fail = r })
    const inProvider = new Promise<void>((r) => { entered = r })
    jest.spyOn(provider, method).mockImplementation(async () => { entered(); await released; throw new Error('wallet unavailable before any attempt was recorded') })
    return { inProvider, fail }
  }
  const mockProvider = () => require('../../src/modules/open-settlement/escrow-providers').PROVIDERS.MOCK

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
    // a0349036: RESOLVED/REFUND for round 1 is committed and the call is held. D10 P1: refused before any write.
    await Promise.race([inCall, ruling])
    await recover()
    go()
    expect(String(await ruling)).toMatch(/Invalid escrow transition|so this ruling cannot execute/)

    expect(await stateOf(ctx)).toEqual({ escrow: 'COMPLETED', dispute: 'APPEALED', ruling: null, round: 1 })
    expect(mockTransfer).not.toHaveBeenCalled()
    expect(await effectsOf(ctx, 1, previous.id)).toEqual(before) // RED on a0349036: slashed, fee REFUNDED, counted
  })

  // ─── P2 parts that the WDK settlement check alone would mask (each kills one D10 mutant) ──────────────

  it('R7: a RESOLVED ruling left from before P1 on a WDK escrow settled as ANOTHER disposition is never finalized', async () => {
    pg.requirePostgres('d10 r7')
    const ctx = await makeDisputedWdkEscrow()
    await prisma.escrow.update({ where: { id: ctx.escrowId }, data: { status: 'COMPLETED', txReleaseId: `0x${randomBytes(32).toString('hex')}` } })
    await prisma.dispute.update({ where: { id: ctx.dispute.id }, data: { status: 'RESOLVED', ruling: 'REFUND', resolvedAt: new Date() } })
    const before = await effectsOf(ctx, 0)

    for (let i = 0; i < 2; i++) await recover()

    expect(await effectsOf(ctx, 0)).toEqual(before) // the settlement recorded is a RELEASE, not this REFUND
  })

  it('R8: on a rail without the WDK settlement check (MOCK), a candidate rolled back after selection is not finalized', async () => {
    pg.requirePostgres('d10 r8')
    const ctx = await makeDisputedWdkEscrow({}, 'MOCK')
    await recover()
    const before = await effectsOf(ctx, 0)
    const provider = holdThenFail('releaseFunds', mockProvider())
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
    await wasSelected
    provider.fail()
    expect(await ruling).toBeInstanceOf(Error)
    openGate()
    await pass

    expect(await stateOf(ctx)).toEqual({ escrow: 'DISPUTED', dispute: 'OPENED', ruling: null, round: 0 })
    expect(await effectsOf(ctx, 0)).toEqual(before) // only the generation revalidation stops this one
  })

  it('R9: a finalization racing a rollback transaction still open waits for it (economic-disposition lock), then defers', async () => {
    pg.requirePostgres('d10 r9')
    const ctx = await makeDisputedWdkEscrow({}, 'MOCK')
    await recover()
    const before = await effectsOf(ctx, 0)
    jest.spyOn(mockProvider(), 'releaseFunds').mockRejectedValue(new Error('wallet unavailable before any attempt was recorded'))
    // Hold the D9 rollback transaction open, after its locks are taken: its ledger read for this ruling's own operations.
    const { wdkTransferAttemptRepository } = require('../../src/modules/open-settlement/wdk-transfer-attempt-repository')
    const realRead = wdkTransferAttemptRepository.findPotentiallySent.bind(wdkTransferAttemptRepository)
    let entered!: () => void
    const inRollback = new Promise<void>((r) => { entered = r })
    let go!: () => void
    const gate = new Promise<void>((r) => { go = r })
    jest.spyOn(wdkTransferAttemptRepository, 'findPotentiallySent').mockImplementation(async (...args: unknown[]) => {
      if (args[2] && JSON.stringify(args[1]) === JSON.stringify(['RELEASE'])) { entered(); await gate }
      return realRead(...args)
    })

    const ruling = rule(ctx, 'RELEASE').catch((e: Error) => e)
    await inRollback // RESOLVED is committed; the rollback holds economic-disposition and has not committed yet
    const pass = recover()
    await new Promise((r) => setTimeout(r, 700)) // well inside Prisma's 5 s transaction timeout
    go()
    expect(await ruling).toBeInstanceOf(Error)
    await pass

    expect(await stateOf(ctx)).toEqual({ escrow: 'DISPUTED', dispute: 'OPENED', ruling: null, round: 0 })
    expect(await effectsOf(ctx, 0)).toEqual(before)
  })

  // ─── P1: a WDK ruling its escrow can no longer execute is refused before anything is written ─────────

  it.each([['COMPLETED', 'RELEASE'], ['COMPLETED', 'REFUND'], ['REFUNDED', 'RELEASE']] as const)('P1: escrow %s, a %s ruling is refused - nothing recorded, finalized or sent', async (escrowStatus, ruling) => {
    pg.requirePostgres(`d10 p1 ${escrowStatus} ${ruling}`)
    const ctx = await makeDisputedWdkEscrow()
    await prisma.escrow.update({ where: { id: ctx.escrowId }, data: { status: escrowStatus, txReleaseId: `0x${randomBytes(32).toString('hex')}` } })
    await recover()
    const before = { state: await stateOf(ctx), effects: await effectsOf(ctx, 0) }

    await expect(rule(ctx, ruling)).rejects.toThrow(/cannot execute/)
    await expect(rule(ctx, ruling)).rejects.toThrow(/cannot execute/) // redelivered: same refusal
    await recover()

    expect(await stateOf(ctx)).toEqual(before.state)
    expect(await effectsOf(ctx, 0)).toEqual(before.effects)
    expect(mockTransfer).not.toHaveBeenCalled()
  })

  // ─── D11-R: only a DISPUTED escrow takes a ruling; deferred rulings stay visible ─────────────────────

  it.each(['WDK_USDT_EVM', 'MOCK'] as const)('D11-R adversarial: an OPENED dispute on a %s escrow left PAYMENT_PENDING is refused - nothing recorded, settled, finalized or sent', async (type) => {
    pg.requirePostgres(`d11r payment-pending ${type}`)
    const ctx = await makeDisputedWdkEscrow({}, type)
    await prisma.escrow.update({ where: { id: ctx.escrowId }, data: { status: 'PAYMENT_PENDING' } }) // PAYMENT_PENDING -> COMPLETED is a valid transition
    const release = jest.spyOn(type === 'MOCK' ? mockProvider() : wdkSettlementProvider, 'releaseFunds')
    await recover()
    const before = { state: await stateOf(ctx), effects: await effectsOf(ctx, 0) }

    await expect(rule(ctx, 'RELEASE')).rejects.toThrow(/is PAYMENT_PENDING, not DISPUTED, so this ruling cannot execute/)
    await expect(rule(ctx, 'RELEASE')).rejects.toThrow(/not DISPUTED/) // redelivered: same refusal
    await recover()

    expect(await stateOf(ctx)).toEqual(before.state)
    expect(before.state).toEqual({ escrow: 'PAYMENT_PENDING', dispute: 'OPENED', ruling: null, round: 0 })
    expect(await effectsOf(ctx, 0)).toEqual(before.effects)
    expect(release).not.toHaveBeenCalled()
    expect(mockTransfer).not.toHaveBeenCalled()
    expect(await prisma.escrowEvent.count({ where: { escrowId: ctx.escrowId } })).toBe(0)
    expect(await prisma.wdkTransferAttempt.count({ where: { escrowId: ctx.escrowId } })).toBe(0)
  })

  it('D11-R: a deferred ruling is reported with its identity by recovery and by the reconciler, never as a failure, and stays deferred', async () => {
    pg.requirePostgres('d11r deferred report')
    // A WDK ruling recorded but not settled (as when its attempt is still unconfirmed): D10 P2 defers it.
    const ctx = await makeDisputedWdkEscrow({ status: 'RESOLVED', ruling: 'RELEASE', resolvedAt: new Date() })
    const identity = { disputeId: ctx.dispute.id, escrowId: ctx.escrowId, appealRound: 0, ruling: 'RELEASE', arbiterId: ARBITER, reason: { code: 'SETTLEMENT_NOT_CONFIRMED', escrowStatus: 'DISPUTED', settlementRecorded: false } }
    const before = await effectsOf(ctx, 0)

    const first = await recover()
    expect(first.deferred).toContainEqual(identity)
    expect(first.recovered).not.toContain(ctx.dispute.id)
    expect(first.failed.map((f: { disputeId: string }) => f.disputeId)).not.toContain(ctx.dispute.id)

    const { reconcilePendingSettlements } = require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service')
    for (let i = 0; i < 2; i++) { // repeated ticks: still reported, still not finalized
      const report = await reconcilePendingSettlements()
      expect(report.rulingFinalizationsDeferred).toContainEqual(identity)
      expect(report.rulingFinalizationsRecovered).not.toContain(ctx.dispute.id)
      expect(report.failed.map((f: { escrowId: string }) => f.escrowId)).not.toContain(`dispute:${ctx.dispute.id}`)
    }
    // Concurrent ticks (two reconciler instances): each reports it, neither finalizes it or reports a failure.
    const concurrent = await Promise.all([reconcilePendingSettlements(), reconcilePendingSettlements(), recover()])
    for (const report of concurrent.slice(0, 2)) {
      expect(report.rulingFinalizationsDeferred).toContainEqual(identity)
      expect(report.failed.map((f: { escrowId: string }) => f.escrowId)).not.toContain(`dispute:${ctx.dispute.id}`)
    }
    expect(concurrent[2].deferred).toContainEqual(identity)
    expect(await effectsOf(ctx, 0)).toEqual(before)
    expect(await stateOf(ctx)).toEqual({ escrow: 'DISPUTED', dispute: 'RESOLVED', ruling: 'RELEASE', round: 0 })
  })

  it('D12: the production reconciler tick (app.ts, as startServer() runs it) warns the operator with each deferred ruling - identity and state-derived reason - apart from failures and manual review, on repeated and concurrent ticks', async () => {
    pg.requirePostgres('d12 production consumer')
    const ctx = await makeDisputedWdkEscrow({ status: 'RESOLVED', ruling: 'RELEASE', resolvedAt: new Date() })
    // A superseded candidate: recovery selected round 0, then an appeal moved the dispute to round 1 (round 0's ruling
    // captured, escrow never settled as it). Its reason is GENERATION_SUPERSEDED.
    const appealed = await makeDisputedWdkEscrow({ status: 'RESOLVED', ruling: 'REFUND', resolvedAt: new Date() })
    const expected = { disputeId: ctx.dispute.id, escrowId: ctx.escrowId, appealRound: 0, ruling: 'RELEASE', arbiterId: ARBITER, reason: { code: 'SETTLEMENT_NOT_CONFIRMED', escrowStatus: 'DISPUTED', settlementRecorded: false } }
    const before = { a: await effectsOf(ctx, 0), b: await effectsOf(appealed, 0) }
    const { runSettlementReconcilerTick } = require('../../src/app')
    const tick = async () => {
      const log = { warn: jest.fn(), error: jest.fn() }
      await runSettlementReconcilerTick(log)
      const deferredWarn = log.warn.mock.calls.map((c: any[]) => c[0]).find((e: any) => e.rulingFinalizationsDeferred)
      const findings = log.warn.mock.calls.map((c: any[]) => c[0]).find((e: any) => e.msg === 'Settlement reconciliation completed with findings')
      return { log, deferredWarn, findings }
    }

    // The superseded case, raced the way recovery meets it: snapshot taken, then the appeal lands before the claim.
    const finalize = DisputeService.prototype as any
    const realFinalize = finalize.finalizeResolveDispute
    jest.spyOn(finalize, 'finalizeResolveDispute').mockImplementation(async function (this: unknown, ...args: any[]) {
      if (args[0]?.id === appealed.dispute.id && args[3] === true) {
        await prisma.dispute.update({ where: { id: appealed.dispute.id }, data: { status: 'APPEALED', appealRound: 1, previousRuling: 'REFUND', previousArbiterId: 'someone-else', ruling: null } })
      }
      return realFinalize.apply(this, args)
    })
    const first = await tick()
    jest.restoreAllMocks()
    expect(first.log.error).not.toHaveBeenCalled()
    expect(first.deferredWarn).toMatchObject({ module: 'settlement-reconciler', msg: expect.stringMatching(/deferred/) })
    expect(first.deferredWarn.rulingFinalizationsDeferred).toContainEqual(expected)
    expect(first.deferredWarn.rulingFinalizationsDeferred).toContainEqual(expect.objectContaining({ disputeId: appealed.dispute.id, appealRound: 0, ruling: 'REFUND', reason: { code: 'GENERATION_SUPERSEDED' } }))
    // A deferral is never reported as a failure or a manual-review entry (the findings warning carries counts only;
    // the report itself is checked by the D11-R test above).
    expect(JSON.stringify(first.findings ?? {})).not.toContain(ctx.dispute.id)

    for (const run of [await tick(), ...(await Promise.all([tick(), tick()]))]) { // repeated, then two concurrent ticks
      expect(run.log.error).not.toHaveBeenCalled()
      expect(run.deferredWarn.rulingFinalizationsDeferred).toContainEqual(expected)
    }
    expect(await effectsOf(ctx, 0)).toEqual(before.a)
    expect(await effectsOf(appealed, 0)).toEqual(before.b)
    expect(await stateOf(ctx)).toEqual({ escrow: 'DISPUTED', dispute: 'RESOLVED', ruling: 'RELEASE', round: 0 })
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

  // ─── 6. D13 (#585): a backlog of permanently deferred candidates must not starve the ones after it ─────────────

  describe('D13 - recovery sweeps past more than one page of permanently deferred candidates', () => {
    const LIMIT = 200 // the production default of recoverMissingRulingFinalization()
    type Queue = 'RESOLVED' | 'APPEALED'
    // Ids sort ahead of (deferred) or behind (eligible) every uuid of other suites in this shared database, and the
    // deferred rulings are the oldest, so the eligible ones come after them by resolvedAt and by id alike.
    const head = () => `0000000000d13${randomBytes(4).toString('hex')}`
    const tail = () => `zzzzzzzzzzd13${randomBytes(4).toString('hex')}`
    const finalizations = (id: string, round: number) => prisma.eventProjectionClaim.count({ where: { eventId: id, projectionKey: 'dispute.ruling-finalized', subjectId: String(round) } })
    // Both queues finalize round 0: the RESOLVED one its current round, the APPEALED one the round appeal() captured.
    const asCandidate = (queue: Queue) => (queue === 'RESOLVED'
      ? { status: 'RESOLVED' as const, ruling: 'RELEASE' as const, arbiterId: ARBITER, escrowStatus: 'DISPUTED' }
      // round 0's RELEASE, captured by appeal(): the escrow must already be COMPLETED to be in this queue at all
      : { status: 'APPEALED' as const, appealRound: 1, previousRuling: 'RELEASE' as const, previousArbiterId: ARBITER, arbiterId: 'd13-appeal-panel', escrowStatus: 'COMPLETED' })

    // `count` candidates no pass can finalize: each its own trade and WDK escrow whose settlement is never recorded,
    // so every pass defers them with SETTLEMENT_NOT_CONFIRMED. Bulk-inserted: the rows recovery reads, nothing more.
    async function makeDeferred(queue: Queue, count: number) {
      const host = await makeDisputedWdkEscrow()
      const { offerId } = (await prisma.trade.findUnique({ where: { id: host.tradeId } }))!
      const prefix = head()
      const ids = Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(4, '0')}`)
      const { escrowStatus, ...dispute } = asCandidate(queue)
      await prisma.trade.createMany({ data: ids.map((id) => ({ id: `t${id}`, offerId, buyerId: host.buyerId, sellerId: host.sellerId, asset: 'USDT_ERC20' as const, amount: '5', priceUsd: '1', totalUsd: '5', status: 'DISPUTED' as const })) })
      await prisma.escrow.createMany({ data: ids.map((id) => ({ id: `e${id}`, tradeId: `t${id}`, type: 'WDK_USDT_EVM' as const, status: escrowStatus as any, lockedAmount: '5', asset: 'USDT_ERC20' as const })) })
      await prisma.dispute.createMany({ data: ids.map((id) => ({ id, tradeId: `t${id}`, escrowId: `e${id}`, openedBy: host.buyerId, reason: 'd13', resolvedAt: new Date('2000-01-01T00:00:00Z'), ...dispute })) })
      return ids
    }
    // A candidate the next pass that reaches it finalizes: a MOCK escrow (outside D10 P2's WDK gate).
    async function makeEligible(queue: Queue) {
      const { escrowStatus, ...dispute } = asCandidate(queue)
      const ctx = await makeDisputedWdkEscrow({ id: tail(), resolvedAt: new Date(), ...dispute }, 'MOCK')
      if (escrowStatus !== 'DISPUTED') await prisma.escrow.update({ where: { id: ctx.escrowId }, data: { status: escrowStatus as any } })
      return ctx.dispute.id
    }
    // An upper bound on the queue: recovery's own candidates are a subset of these rows.
    const queueBound = (queue: Queue) => prisma.dispute.count({ where: queue === 'RESOLVED' ? { status: 'RESOLVED' } : { status: 'APPEALED', appealRound: 1 } })

    // Runs `passes` recovery calls, checks each stays within its work limit, and collects what they evaluated.
    async function sweep(services: any[], passes: number, between?: (pass: number) => Promise<void>) {
      const recovered: string[] = []
      const deferred = new Map<string, unknown>()
      for (let pass = 0; pass < passes; pass++) {
        const reports = await Promise.all(services.map((s) => s.recoverMissingRulingFinalization(LIMIT)))
        for (const r of reports) {
          expect(r.recovered.length + r.deferred.length + r.failed.length).toBeLessThanOrEqual(2 * LIMIT) // LIMIT per queue
          recovered.push(...r.recovered)
          for (const d of r.deferred) deferred.set(d.disputeId, d.reason)
        }
        await between?.(pass)
      }
      return { recovered, deferred }
    }

    it.each(['RESOLVED', 'APPEALED'] as const)('%s queue: candidates after more than 200 permanently deferred ones are finalized within ceil(queue / limit) + 1 passes, exactly once, and the deferred stay visible every sweep', async (queue) => {
      pg.requirePostgres(`d13 ${queue}`)
      const deferredIds = await makeDeferred(queue, LIMIT + 5)
      const eligible = [await makeEligible(queue), await makeEligible(queue)]
      const passes = Math.ceil((await queueBound(queue)) / LIMIT) + 1
      const service = ruler() // one instance, as the production singleton: its cursor carries over between passes

      const first = await sweep([service], passes)
      for (const id of eligible) {
        expect(first.recovered.filter((r) => r === id)).toHaveLength(1)
        expect(await finalizations(id, 0)).toBe(1)
      }
      for (const id of deferredIds) {
        expect(first.deferred.get(id)).toEqual({ code: 'SETTLEMENT_NOT_CONFIRMED', escrowStatus: queue === 'RESOLVED' ? 'DISPUTED' : 'COMPLETED', settlementRecorded: false })
      }

      // The sweep starts over: the deferred are evaluated again (no permanent omission), nothing is finalized twice.
      const second = await sweep([service], passes)
      expect(deferredIds.filter((id) => !second.deferred.has(id))).toEqual([])
      expect(second.recovered.filter((id) => eligible.includes(id))).toEqual([])
      for (const id of eligible) expect(await finalizations(id, 0)).toBe(1)
      expect(await prisma.eventProjectionClaim.count({ where: { eventId: { in: deferredIds } } })).toBe(0)
    }, 300_000)

    it('candidates that change state mid-sweep, under two concurrent reconcilers: finalized exactly once, none lost, no error', async () => {
      pg.requirePostgres('d13 concurrent')
      const deferredIds = await makeDeferred('RESOLVED', LIMIT + 5)
      const eligible = [await makeEligible('RESOLVED'), await makeEligible('RESOLVED')]
      const passes = Math.ceil((await queueBound('RESOLVED')) / LIMIT) + 1
      // Two instances (two processes, each with its own cursor) and the second one called twice at once.
      const a = ruler()
      const b = ruler()
      const [settledEarly, leaves, settledLate] = [deferredIds[10], deferredIds[202], deferredIds[203]]

      const run = await sweep([a, b, b], 2 * passes, async (pass) => {
        if (pass !== 0) return
        // After the first page: one candidate already passed and one still ahead settle, one leaves the queue.
        await prisma.escrow.updateMany({ where: { id: { in: [`e${settledEarly}`, `e${settledLate}`] } }, data: { status: 'COMPLETED', txReleaseId: `0x${randomBytes(32).toString('hex')}` } })
        await prisma.dispute.update({ where: { id: leaves }, data: { status: 'APPEALED', appealRound: 1 } })
      })

      // Reached, and applied once: a caller that loses the claim race applies nothing but still lists the dispute as
      // recovered (applyEventProjectionOnce()'s false is not surfaced, pre-existing #253 reporting), so the economic
      // proof is the single claim every effect is gated on.
      for (const id of [...eligible, settledEarly, settledLate]) {
        expect(run.recovered).toContain(id)
        expect(await finalizations(id, 0)).toBe(1)
      }
      const stillDeferred = deferredIds.filter((id) => ![settledEarly, settledLate, leaves].includes(id))
      expect(stillDeferred.filter((id) => !run.deferred.has(id))).toEqual([])
      expect(await prisma.eventProjectionClaim.count({ where: { eventId: { in: [...stillDeferred, leaves] } } })).toBe(0)
    }, 300_000)
  })
})
