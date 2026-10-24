// tests/integration/tradeProjectionMonotonicity.test.ts
//
// Issue #294 - real PostgreSQL proof that Escrow is the authoritative economic
// state and Trade is only a projection: the projection is derived from the
// PERSISTED Escrow status (never the state an old event payload carries), is
// monotonic (a stale/reordered/duplicate event can never regress a Trade),
// stamps completedAt/cancelledAt exactly once, and a manual Trade transition
// can never race an Escrow-governed outcome into a contradictory state.

import { PrismaClient } from '@prisma/client'
import { randomBytes } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'

describe('Issue #294 - authoritative Escrow -> Trade projection (real PostgreSQL)', () => {
  jest.setTimeout(60_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let tradeRepository: typeof import('../../src/modules/open-p2p/trade-repository').tradeRepository
  let tradeService: typeof import('../../src/modules/open-p2p/trade.service').tradeService
  let liquidityRouter: typeof import('../../src/modules/open-liquidity/liquidity.service').liquidityRouter

  beforeAll(async () => {
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ tradeRepository } = require('../../src/modules/open-p2p/trade-repository'))
    ;({ tradeService } = require('../../src/modules/open-p2p/trade.service'))
    ;({ liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service'))
    const { intentEngine } = require('../../src/core/intent-engine')
    const { OpenP2PTradeIntentHandler } = require('../../src/modules/open-p2p/intent-handler')
    intentEngine.registerHandler(OpenP2PTradeIntentHandler)
  })

  afterAll(async () => {
    if (dbAvailable) {
      await prisma.$disconnect()
      await closeTestRedis()
    }
  })

  function requirePostgres(name: string): void {
    pg.requirePostgres(name)
  }

  async function makeTradeWithEscrow(escrowStatus: string) {
    const seller = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
    const buyer = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER' })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    const escrow = await prisma.escrow.create({ data: { tradeId: trade.id, type: 'MOCK', status: escrowStatus as any, lockedAmount: '0.001', asset: 'BTC' } })
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id } })
    return { tradeId: trade.id, escrowId: escrow.id, sellerId: seller.id, buyerId: buyer.id }
  }

  const setEscrow = (escrowId: string, status: string) => prisma.escrow.update({ where: { id: escrowId }, data: { status: status as any } })
  const tradeOf = (tradeId: string) => prisma.trade.findUnique({ where: { id: tradeId } })

  it('projects each persisted Escrow state onto the Trade: FUNDS_LOCKED->ACTIVE, DISPUTED->DISPUTED, COMPLETED/SPLIT->COMPLETED, REFUNDED->CANCELLED', async () => {
    requirePostgres('state mapping')
    for (const [escrowStatus, expected] of [
      ['FUNDS_LOCKED', 'ACTIVE'], ['DISPUTED', 'DISPUTED'], ['COMPLETED', 'COMPLETED'], ['SPLIT', 'COMPLETED'], ['REFUNDED', 'CANCELLED'],
    ] as const) {
      const { tradeId, escrowId } = await makeTradeWithEscrow(escrowStatus)
      const r = await tradeRepository.projectEscrowStatus(tradeId, escrowId)
      expect(r.applied).toBe(true)
      expect((await tradeOf(tradeId))!.status).toBe(expected)
    }
  })

  it('terminal Escrow, then a STALE locked event: no regression (Trade stays terminal)', async () => {
    requirePostgres('stale locked after terminal')
    const { tradeId, escrowId } = await makeTradeWithEscrow('COMPLETED')
    await tradeRepository.projectEscrowStatus(tradeId, escrowId)
    // the stale event's projection consults the PERSISTED escrow (still COMPLETED), not its own payload
    const stale = await tradeRepository.projectEscrowStatus(tradeId, escrowId)
    expect(stale.applied).toBe(false)
    expect((await tradeOf(tradeId))!.status).toBe('COMPLETED')
  })

  it('a stale disputed/active projection after the Escrow REFUNDED cannot move the Trade off CANCELLED', async () => {
    requirePostgres('stale disputed after refund')
    const { tradeId, escrowId } = await makeTradeWithEscrow('DISPUTED')
    await tradeRepository.projectEscrowStatus(tradeId, escrowId) // DISPUTED
    await setEscrow(escrowId, 'REFUNDED')
    await tradeRepository.projectEscrowStatus(tradeId, escrowId) // CANCELLED
    // delayed events for the earlier states re-run the projection: it reads REFUNDED again
    for (let i = 0; i < 3; i++) await tradeRepository.projectEscrowStatus(tradeId, escrowId)
    expect((await tradeOf(tradeId))!.status).toBe('CANCELLED')
  })

  it('RELEASE vs REFUND ordering: whichever the Escrow persisted wins; the reordered projection of the OTHER event cannot flip the Trade', async () => {
    requirePostgres('release vs refund')
    const a = await makeTradeWithEscrow('COMPLETED')
    await tradeRepository.projectEscrowStatus(a.tradeId, a.escrowId)
    await tradeRepository.projectEscrowStatus(a.tradeId, a.escrowId) // a refund event arriving late still projects the persisted COMPLETED
    expect((await tradeOf(a.tradeId))!.status).toBe('COMPLETED')

    const b = await makeTradeWithEscrow('REFUNDED')
    await tradeRepository.projectEscrowStatus(b.tradeId, b.escrowId)
    await tradeRepository.projectEscrowStatus(b.tradeId, b.escrowId)
    expect((await tradeOf(b.tradeId))!.status).toBe('CANCELLED')
  })

  it('a terminal Escrow outranks a conflicting Trade terminal (Trade converges to the authoritative Escrow)', async () => {
    requirePostgres('escrow outranks trade terminal')
    const { tradeId, escrowId } = await makeTradeWithEscrow('COMPLETED')
    await prisma.trade.update({ where: { id: tradeId }, data: { status: 'CANCELLED', cancelledAt: new Date() } })
    const r = await tradeRepository.projectEscrowStatus(tradeId, escrowId)
    expect(r.applied).toBe(true)
    expect((await tradeOf(tradeId))!.status).toBe('COMPLETED')
  })

  it('completedAt / cancelledAt are WRITE-ONCE: replays never re-stamp them', async () => {
    requirePostgres('timestamps write-once')
    const c = await makeTradeWithEscrow('COMPLETED')
    await tradeRepository.projectEscrowStatus(c.tradeId, c.escrowId)
    const completedAt = (await tradeOf(c.tradeId))!.completedAt!.getTime()
    await new Promise((r) => setTimeout(r, 25))
    for (let i = 0; i < 3; i++) await tradeRepository.projectEscrowStatus(c.tradeId, c.escrowId)
    expect((await tradeOf(c.tradeId))!.completedAt!.getTime()).toBe(completedAt)

    const x = await makeTradeWithEscrow('REFUNDED')
    await tradeRepository.projectEscrowStatus(x.tradeId, x.escrowId)
    const cancelledAt = (await tradeOf(x.tradeId))!.cancelledAt!.getTime()
    await new Promise((r) => setTimeout(r, 25))
    for (let i = 0; i < 3; i++) await tradeRepository.projectEscrowStatus(x.tradeId, x.escrowId)
    expect((await tradeOf(x.tradeId))!.cancelledAt!.getTime()).toBe(cancelledAt)
  })

  it('10 CONCURRENT projectors of the same Escrow state: exactly one applies, the Trade ends in the right state with one timestamp', async () => {
    requirePostgres('concurrent projectors')
    const { tradeId, escrowId } = await makeTradeWithEscrow('COMPLETED')
    const results = await Promise.all(Array.from({ length: 10 }, () => tradeRepository.projectEscrowStatus(tradeId, escrowId)))
    expect(results.filter((r) => r.applied)).toHaveLength(1)
    const trade = (await tradeOf(tradeId))!
    expect(trade.status).toBe('COMPLETED')
    expect(trade.completedAt).not.toBeNull()
  })

  it('a projection for a mismatched (trade, escrow) pair or an unknown escrow changes nothing', async () => {
    requirePostgres('mismatch')
    const a = await makeTradeWithEscrow('COMPLETED')
    const b = await makeTradeWithEscrow('FUNDS_LOCKED')
    expect((await tradeRepository.projectEscrowStatus(b.tradeId, a.escrowId)).applied).toBe(false)
    expect((await tradeRepository.projectEscrowStatus(a.tradeId, '00000000-0000-0000-0000-000000000000')).applied).toBe(false)
    expect((await tradeOf(b.tradeId))!.status).not.toBe('COMPLETED')
  })

  it('MANUAL cancellation vs authoritative terminal projection: once the Escrow governs the outcome a manual cancel is refused; the Trade keeps converging to the Escrow', async () => {
    requirePostgres('manual vs escrow')
    const { tradeId, escrowId, sellerId } = await makeTradeWithEscrow('COMPLETED')
    await tradeRepository.projectEscrowStatus(tradeId, escrowId) // COMPLETED
    await expect(tradeService.updateStatus(tradeId, 'CANCELLED', sellerId)).rejects.toThrow(/can no longer be changed manually|cannot transition/)
    expect((await tradeOf(tradeId))!.status).toBe('COMPLETED')

    const d = await makeTradeWithEscrow('DISPUTED')
    await expect(tradeService.updateStatus(d.tradeId, 'CANCELLED', d.sellerId)).rejects.toThrow(/Escrow|escrow/)
  })

  it('MANUAL transition is CAS-guarded: a manual cancel racing another status change is not applied over a status it did not validate', async () => {
    requirePostgres('manual CAS')
    const { tradeId } = await makeTradeWithEscrow('CREATED')
    // trade is PENDING; another actor moved it to ACTIVE after the caller validated PENDING
    await prisma.trade.update({ where: { id: tradeId }, data: { status: 'ACTIVE' } })
    const r = await tradeRepository.transitionManually(tradeId, 'PENDING', 'CANCELLED', new Date())
    expect(r.ok).toBe(false)
    expect((await tradeOf(tradeId))!.status).toBe('ACTIVE')
  })
})
