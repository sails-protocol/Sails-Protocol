// tests/integration/codex585P1Findings.test.ts
//
// #585 - the two Codex P1 findings on 8efc63b0 (review of 2026-11-07), written first as RED reproductions against
// 8efc63b0's production code, GREEN with the two fixes in dispute.service.ts:
//   P1-A: a SPLIT ruling retained, and later finalized, on a reopened escrow's historical SPLIT legs whose amounts or
//         destinations are not the allocation that ruling authorizes.
//   P1-B: after the escrow helper's atomic rollback, applyRuling()'s catch reverted the ruling a second time, and that
//         second revert cleared a concurrent execution of the same signed decision mid-transfer.
// Real PostgreSQL and the production path resolveDispute() (a real Ed25519 authority signature) -> applyRuling() ->
// escrowService.*Funds -> provider. Only the WDK wallet is a fake; the Decimal -> string adaptation at the WDK
// provider boundary is the one wdkUnresolvedAttemptGuard.test.ts documents in its header. Serial PostgreSQL lane.

process.env.WDK_SEED_PHRASE = process.env.WDK_SEED_PHRASE || 'test only seed phrase for codex 585 p1 integration tests - never a real wallet'
process.env.WDK_USDT_CONTRACT = process.env.WDK_USDT_CONTRACT || '0x0000000000000000000000000000000000000001'
const mockTransfer = jest.fn()
const mockGetTransactionReceipt = jest.fn()
const fakeAccount = (address: string) => ({
  getAddress: async () => address,
  transfer: (...args: unknown[]) => mockTransfer(...args),
  getTransactionReceipt: (...args: unknown[]) => mockGetTransactionReceipt(...args),
})
jest.mock('@tetherto/wdk-wallet-evm', () => ({
  __esModule: true,
  default: class FakeWalletManagerEvm {
    async getAccount(index: number) { return fakeAccount(index === 0 ? 'treasury-fake-evm-address' : 'escrow-fake-evm-address') }
    async getAccountByPath(_path: string) { return fakeAccount('escrow-fake-evm-address') }
  },
}))

import { PrismaClient } from '@prisma/client'
import { randomBytes } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nacl = require('tweetnacl')

describe('#585 Codex P1 findings (real PostgreSQL)', () => {
  jest.setTimeout(120_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let liquidityRouter: any
  let tradeService: any
  let DisputeService: any
  let marketArbitrationProvider: any
  let reconcilePendingSettlements: any
  let PROVIDERS: any
  let signAuthorityDecision: any
  let SettlementExecutedError: any

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'true' // creation-time default only - escrows below are explicitly typed
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service'))
    ;({ tradeService } = require('../../src/modules/open-p2p/trade.service'))
    ;({ DisputeService } = require('../../src/modules/open-settlement/dispute.service'))
    ;({ marketArbitrationProvider } = require('../../src/modules/open-settlement/market-arbitration.provider'))
    ;({ reconcilePendingSettlements } = require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service'))
    ;({ PROVIDERS } = require('../../src/modules/open-settlement/escrow-providers'))
    ;({ signAuthorityDecision } = require('../../src/modules/open-settlement/arbitration-authority'))
    ;({ SettlementExecutedError } = require('../../src/common/errors'))
    const { intentEngine } = require('../../src/core/intent-engine')
    const { OpenP2PTradeIntentHandler } = require('../../src/modules/open-p2p/intent-handler')
    intentEngine.registerHandler(OpenP2PTradeIntentHandler)
    require('../../src/common/events/handlers').registerEventHandlers()
    // The Decimal -> string harness adaptation described in the header.
    const { wdkSettlementProvider } = require('../../src/modules/open-settlement/wdk-settlement.provider')
    for (const method of ['releaseFunds', 'refundFunds', 'splitFunds'] as const) {
      const real = wdkSettlementProvider[method].bind(wdkSettlementProvider)
      wdkSettlementProvider[method] = async (escrow: { lockedAmount: unknown }, ...rest: unknown[]) => real({ ...escrow, lockedAmount: String(escrow.lockedAmount) }, ...rest)
    }
  })

  beforeEach(() => {
    mockTransfer.mockReset()
    mockGetTransactionReceipt.mockReset()
    jest.restoreAllMocks()
  })

  afterAll(async () => {
    if (dbAvailable) {
      await new Promise((r) => setTimeout(r, 3000)) // let the last test's asynchronous event handlers settle
      await prisma.$disconnect()
      await closeTestRedis()
    }
  })

  const user = () => prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
  const service = () => new DisputeService(marketArbitrationProvider)
  const drain = () => reconcilePendingSettlements({ projectionGraceMs: 0 })

  // A disputed escrow (lockedAmount 5) whose arbiter is a real Ed25519 authority, its public key on its User row.
  async function makeDisputed(type: 'WDK_USDT_EVM' | 'MOCK') {
    const keys = nacl.sign.keyPair()
    const arbiter = await prisma.user.create({ data: { publicKey: Buffer.from(keys.publicKey).toString('hex') } })
    await prisma.arbiterProfile.create({ data: { participantId: arbiter.id } })
    const seller = await user()
    const buyer = await user()
    await prisma.payoutAddress.create({ data: { participantId: buyer.id, asset: 'USDT_ERC20', address: `buyer-payout-${buyer.id}` } })
    await prisma.payoutAddress.create({ data: { participantId: seller.id, asset: 'USDT_ERC20', address: `seller-payout-${seller.id}` } })
    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'USDT_ERC20', side: 'SELL', priceUsd: '1', minAmount: '5', maxAmount: '5', paymentMethod: 'OTHER' })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '5' })
    const escrow = await prisma.escrow.create({ data: { tradeId: trade.id, type, status: 'DISPUTED', lockedAmount: '5', asset: 'USDT_ERC20' } })
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id, status: 'DISPUTED' } })
    const dispute = await prisma.dispute.create({ data: { tradeId: trade.id, escrowId: escrow.id, openedBy: buyer.id, reason: 'p1', status: 'OPENED', arbiterId: arbiter.id } })
    // One signed decision, as an arbiter client submits it: calling the result again resubmits the identical request.
    const decide = (ruling: 'RELEASE' | 'REFUND' | 'SPLIT', buyerBps: number | null = null) => {
      const issuedAt = new Date().toISOString()
      const sig = signAuthorityDecision({ disputeId: dispute.id, escrowId: escrow.id, appealRound: 0, authorityId: arbiter.id, outcome: ruling, buyerBps, issuedAt }, keys.secretKey)
      return () => service().resolveDispute(dispute.id, arbiter.id, ruling, undefined, undefined, buyerBps ?? undefined, sig, issuedAt)
    }
    return { escrowId: escrow.id, tradeId: trade.id, disputeId: dispute.id, arbiterId: arbiter.id, buyerPayout: `buyer-payout-${buyer.id}`, sellerPayout: `seller-payout-${seller.id}`, decide }
  }
  type Ctx = Awaited<ReturnType<typeof makeDisputed>>
  const stateOf = async (ctx: Ctx) => {
    const [escrow, dispute, attempts, finalized] = await Promise.all([
      prisma.escrow.findUnique({ where: { id: ctx.escrowId } }),
      prisma.dispute.findUnique({ where: { id: ctx.disputeId } }),
      prisma.wdkTransferAttempt.findMany({ where: { escrowId: ctx.escrowId }, orderBy: { createdAt: 'asc' } }),
      prisma.eventProjectionClaim.count({ where: { eventId: ctx.disputeId, projectionKey: 'dispute.ruling-finalized' } }),
    ])
    return {
      escrow: escrow!.status, txReleaseId: escrow!.txReleaseId,
      dispute: dispute!.status, ruling: dispute!.ruling, authorityBuyerBps: dispute!.authorityBuyerBps, signed: dispute!.authoritySignature !== null,
      attempts: attempts.map((a) => `${a.operationType}:${a.destination === ctx.buyerPayout ? 'buyer' : a.destination === ctx.sellerPayout ? 'seller' : a.destination}:${a.amount.toString()}:${a.status}`),
      finalized,
    }
  }

  // ─── P1-A: historical SPLIT legs are this ruling's execution only if they are its own allocation ───────────────

  describe('P1-A - a reopened escrow\'s historical SPLIT legs (sent, unconfirmed), then a new signed SPLIT', () => {
    const [h1, h2] = [`0x${'b1'.repeat(32)}`, `0x${'b2'.repeat(32)}`]
    // The residue the old rollback left: both legs of an earlier split submitted, the escrow reopened to DISPUTED.
    const seedLegs = async (ctx: Ctx, buyer: { to: string; amount: string }, seller: { to: string; amount: string }) => {
      await prisma.wdkTransferAttempt.create({ data: { escrowId: ctx.escrowId, operationType: 'SPLIT_BUYER', destination: buyer.to, amount: buyer.amount, status: 'SUBMITTED', txHash: h1, activeKey: `${ctx.escrowId}:SPLIT_BUYER` } })
      await prisma.wdkTransferAttempt.create({ data: { escrowId: ctx.escrowId, operationType: 'SPLIT_SELLER', destination: seller.to, amount: seller.amount, status: 'SUBMITTED', txHash: h2, activeKey: `${ctx.escrowId}:SPLIT_SELLER` } })
    }

    it.each([
      ['amounts: legs 60/40, ruling 40/60', 4000, (ctx: Ctx) => seedLegs(ctx, { to: ctx.buyerPayout, amount: '3' }, { to: ctx.sellerPayout, amount: '2' })],
      ['destination: legs 60/40 with the buyer leg to another address, ruling 60/40', 6000, (ctx: Ctx) => seedLegs(ctx, { to: 'old-buyer-address', amount: '3' }, { to: ctx.sellerPayout, amount: '2' })],
    ] as const)('incompatible %s: refused before it is written, nothing sent, and nothing finalized once the legs confirm', async (_label, bps, seed) => {
      pg.requirePostgres(`p1-a ${bps}`)
      const ctx = await makeDisputed('WDK_USDT_EVM')
      await seed(ctx)
      mockGetTransactionReceipt.mockResolvedValue(null) // still pending on-chain
      const before = await stateOf(ctx)
      expect(before).toMatchObject({ escrow: 'DISPUTED', dispute: 'OPENED', ruling: null, signed: false, finalized: 0 })

      await expect(ctx.decide('SPLIT', bps)()).rejects.toThrow(/refused: WDK SPLIT_BUYER attempt .* is not this ruling's own SPLIT_BUYER/)
      expect(mockTransfer).not.toHaveBeenCalled()
      expect(await stateOf(ctx)).toEqual(before)

      // The historical transfers confirm: no ruling authorized them, so the reconciler converges nothing to finalize.
      mockGetTransactionReceipt.mockResolvedValue({ status: 1 })
      await drain()
      await drain()
      expect(await stateOf(ctx)).toEqual(before)
      expect(mockTransfer).not.toHaveBeenCalled()
    })

    it('control - compatible legs (60/40 to the parties\' payout addresses), ruling 60/40: retained as its execution, converged and finalized once, nothing resent', async () => {
      pg.requirePostgres('p1-a control')
      const ctx = await makeDisputed('WDK_USDT_EVM')
      await seedLegs(ctx, { to: ctx.buyerPayout, amount: '3' }, { to: ctx.sellerPayout, amount: '2' })
      mockGetTransactionReceipt.mockResolvedValue(null)

      const err = await ctx.decide('SPLIT', 6000)().catch((e: unknown) => e)
      expect(err).toBeInstanceOf(SettlementExecutedError) // the D7 protection: sent legs keep the claim and the ruling
      expect(await stateOf(ctx)).toEqual({
        escrow: 'SPLIT', txReleaseId: null, dispute: 'RESOLVED', ruling: 'SPLIT', authorityBuyerBps: 6000, signed: true,
        attempts: ['SPLIT_BUYER:buyer:3:SUBMITTED', 'SPLIT_SELLER:seller:2:SUBMITTED'], finalized: 0,
      })

      mockGetTransactionReceipt.mockResolvedValue({ status: 1 })
      await drain()
      await drain()
      expect(await stateOf(ctx)).toEqual({
        escrow: 'SPLIT', txReleaseId: `${h1},${h2}`, dispute: 'RESOLVED', ruling: 'SPLIT', authorityBuyerBps: 6000, signed: true,
        attempts: ['SPLIT_BUYER:buyer:3:SUBMITTED', 'SPLIT_SELLER:seller:2:SUBMITTED'], finalized: 1,
      })
      expect(mockTransfer).not.toHaveBeenCalled()
    })
  })

  // ─── P1-B: the escrow helper's atomic rollback is the only rollback of that ruling ─────────────────────────────

  describe('P1-B - provider failure before submission, then a resubmission of the same signed decision', () => {
    // Request A's provider call fails before submitting; request B's is held until released.
    function provider() {
      const mock = PROVIDERS.MOCK
      const real = mock.releaseFunds.bind(mock)
      const s = { calls: 0, aFailed: false, release: () => {}, inProvider: Promise.resolve() }
      let entered!: () => void
      s.inProvider = new Promise<void>((r) => { entered = r })
      const gate = new Promise<void>((r) => { s.release = r })
      jest.spyOn(mock, 'releaseFunds').mockImplementation(async (...args: any[]) => {
        if (++s.calls === 1) { s.aFailed = true; throw new Error('provider unavailable before submission') }
        entered()
        await gate
        return real(...args)
      })
      return s
    }

    it('a resubmission that executes while the failed request unwinds keeps its authorization: RESOLVED, signed, settled and finalized once', async () => {
      pg.requirePostgres('p1-b concurrent')
      const ctx = await makeDisputed('MOCK')
      const submit = ctx.decide('RELEASE')
      const p = provider()

      // Request A is held right after the escrow helper's atomic rollback committed (escrow and dispute reopened),
      // before it returns into applyRuling()'s catch.
      let releaseA!: () => void
      const gateA = new Promise<void>((r) => { releaseA = r })
      let reopened!: () => void
      const aReopened = new Promise<void>((r) => { reopened = r })
      const realTx = prisma.$transaction.bind(prisma)
      jest.spyOn(prisma, '$transaction').mockImplementation(((...args: any[]) => {
        if (p.aFailed && (new Error().stack ?? '').includes('revertClaimUnlessPotentiallySent')) {
          return (realTx as any)(...args).then(async (r: unknown) => { reopened(); await gateA; return r })
        }
        return (realTx as any)(...args)
      }) as any)

      const a = submit().catch((e: unknown) => e)
      await aReopened
      expect(await stateOf(ctx)).toMatchObject({ escrow: 'DISPUTED', dispute: 'OPENED', ruling: null, signed: false })

      const b = submit() // the identical signed request, resubmitted
      await p.inProvider
      expect(await stateOf(ctx)).toMatchObject({ escrow: 'COMPLETED', txReleaseId: null, dispute: 'RESOLVED', ruling: 'RELEASE', signed: true })

      releaseA() // A unwinds while B's transfer is underway
      expect(((await a) as Error).message).toBe('provider unavailable before submission')
      expect(await stateOf(ctx)).toMatchObject({ escrow: 'COMPLETED', dispute: 'RESOLVED', ruling: 'RELEASE', signed: true })

      p.release()
      await b
      await drain()
      const final = await stateOf(ctx)
      expect(final).toMatchObject({ escrow: 'COMPLETED', dispute: 'RESOLVED', ruling: 'RELEASE', signed: true, finalized: 1 })
      expect(final.txReleaseId).toMatch(/^mock-release-/)
      expect(p.calls).toBe(2)
      expect((await prisma.arbiterProfile.findUnique({ where: { participantId: ctx.arbiterId } }))!.rulingsTotal).toBe(1)
    })

    it('control - failure before submission, no concurrency: escrow and dispute reopened exactly once, authorization cleared, a resubmission then executes', async () => {
      pg.requirePostgres('p1-b control')
      const ctx = await makeDisputed('MOCK')
      const submit = ctx.decide('RELEASE')
      const p = provider()
      p.release()

      await expect(submit()).rejects.toThrow('provider unavailable before submission')
      expect(await stateOf(ctx)).toMatchObject({ escrow: 'DISPUTED', txReleaseId: null, dispute: 'OPENED', ruling: null, signed: false, finalized: 0 })

      await submit()
      await drain()
      expect(await stateOf(ctx)).toMatchObject({ escrow: 'COMPLETED', dispute: 'RESOLVED', ruling: 'RELEASE', signed: true, finalized: 1 })
    })

    it('control - failure before any escrow claim: the ruling is still reverted by applyRuling() itself', async () => {
      pg.requirePostgres('p1-b pre-claim')
      const ctx = await makeDisputed('MOCK')
      // No payout address for the buyer: releaseFunds() fails resolving it, before it claims the escrow, so the escrow
      // helper never runs a rollback.
      await prisma.payoutAddress.deleteMany({ where: { address: ctx.buyerPayout } })
      const err = await ctx.decide('RELEASE')().catch((e: unknown) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err).not.toBeInstanceOf(SettlementExecutedError)
      expect(await stateOf(ctx)).toMatchObject({ escrow: 'DISPUTED', dispute: 'OPENED', ruling: null, signed: false, finalized: 0 })
    })
  })
})
