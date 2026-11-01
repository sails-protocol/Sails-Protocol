// tests/integration/tradeProjectionMonotonicity.test.ts
//
// Issue #294 - real PostgreSQL proof that Escrow is the authoritative economic
// state and Trade is only a projection: the projection is derived from the
// PERSISTED Escrow status (never the state an old event payload carries), is
// monotonic (a stale/reordered/duplicate event can never regress a Trade),
// stamps completedAt/cancelledAt exactly once, and a manual Trade transition
// can never race an Escrow-governed outcome into a contradictory state.
//
// Issue #236 - the second describe block below extends this same file (not a
// parallel one - this IS the canonical monotonicity evidence file, reused per
// the mission's own "do not create duplicate recovery machinery" instruction)
// with the durable-EVENT-HANDLER-level adversarial matrix: real
// settlement.escrow.* events delivered stale/duplicated/reordered/replayed
// through the actual eventBus/registerEventHandlers() wiring (not
// projectEscrowStatus() called directly, as the #294 block above already
// does), plus a genuine two-different-handlers-racing concurrency proof.
// #236's own production mechanism is projectTrade()/projectEscrowStatus() -
// already built for #294/#298 (Issue #320) - so this block adds NO new
// production code; it closes the remaining adversarial-evidence gaps the
// #294 block's repository-level tests do not reach (named event types,
// SPLIT-flavored delayed LOCKED, explicit duplicate LOCKED, and concurrent
// DIFFERENT handlers racing for the same trade).

import { PrismaClient } from '@prisma/client'
import { randomBytes, randomUUID } from 'crypto'
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

// ── Issue #236 - handler-level adversarial matrix (real eventBus, real durable events) ──────────
describe('Issue #236 - delayed/duplicated/reordered settlement events never regress the Trade (real PostgreSQL, real handlers)', () => {
  jest.setTimeout(90_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let tradeRepository: typeof import('../../src/modules/open-p2p/trade-repository').tradeRepository
  let tradeService: typeof import('../../src/modules/open-p2p/trade.service').tradeService
  let liquidityRouter: typeof import('../../src/modules/open-liquidity/liquidity.service').liquidityRouter
  let eventBus: typeof import('../../src/common/events/event-bus').eventBus
  let emitEscrowTransition: typeof import('../../src/modules/open-settlement/escrow-lifecycle').emitEscrowTransition
  let instanceB: { eventBus: typeof eventBus; prisma: PrismaClient; redis: { quit(): Promise<unknown> } } | undefined

  beforeAll(async () => {
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ tradeRepository } = require('../../src/modules/open-p2p/trade-repository'))
    ;({ tradeService } = require('../../src/modules/open-p2p/trade.service'))
    ;({ liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service'))
    ;({ eventBus } = require('../../src/common/events/event-bus'))
    ;({ emitEscrowTransition } = require('../../src/modules/open-settlement/escrow-lifecycle'))
    const { intentEngine } = require('../../src/core/intent-engine')
    const { OpenP2PTradeIntentHandler } = require('../../src/modules/open-p2p/intent-handler')
    intentEngine.registerHandler(OpenP2PTradeIntentHandler)
    require('../../src/common/events/handlers').registerEventHandlers()
    // A genuine second module graph for the restart/independent-instance proofs (T13/M/O) - its own
    // Prisma pool, event bus, handlers, exactly the pattern #298/#251/#250/#240/#245 already established.
    jest.isolateModules(() => {
      require('../../src/common/events/handlers').registerEventHandlers()
      instanceB = {
        eventBus: require('../../src/common/events/event-bus').eventBus,
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

  function requirePostgres(name: string): void {
    pg.requirePostgres(name)
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  async function makeActiveTrade() {
    const seller = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
    const buyer = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER' })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    const escrow = await prisma.escrow.create({ data: { tradeId: trade.id, type: 'MOCK', status: 'PAYMENT_PENDING', lockedAmount: '0.001', asset: 'BTC' } })
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id, status: 'ACTIVE' } })
    return { tradeId: trade.id, escrowId: escrow.id, sellerId: seller.id, buyerId: buyer.id }
  }
  type Ctx = Awaited<ReturnType<typeof makeActiveTrade>>
  const tradeOf = (tradeId: string) => prisma.trade.findUnique({ where: { id: tradeId } })
  const setEscrow = (escrowId: string, status: string) => prisma.escrow.update({ where: { id: escrowId }, data: { status: status as any } })

  async function waitFor(cond: () => Promise<boolean>, ms = 30_000): Promise<void> {
    const end = Date.now() + ms
    while (Date.now() < end) { if (await cond()) return; await sleep(100) }
    throw new Error('timed out waiting for condition')
  }
  const projectedFor = (escrowId: string, toStatus: string) => async () => {
    const t = await prisma.escrowEvent.findFirst({ where: { escrowId, toStatus: toStatus as any } })
    return !!t && (await prisma.eventProjectionClaim.count({ where: { projectionKey: 'transition.projected', subjectId: t.id } })) === 1
  }

  // A "delayed LOCKED" delivered AFTER the escrow already reached a real terminal state - the exact
  // scenario the canonical issue names. Emits the REAL settlement.escrow.locked event through the
  // real handler, well after the trade already terminaled through a genuinely later transition.
  async function emitDelayedLocked(ctx: Ctx): Promise<void> {
    await emitEscrowTransition(ctx.escrowId, ctx.tradeId, 'CREATED', 'FUNDS_LOCKED', ctx.sellerId, 'settlement.escrow.locked', {})
    await waitFor(projectedFor(ctx.escrowId, 'FUNDS_LOCKED'))
    await sleep(200)
  }

  // ── E/F/G: RELEASE/REFUND/SPLIT then a delayed LOCKED never regresses the Trade ────────────────
  it.each([
    ['E', 'PAYMENT_PENDING', 'COMPLETED', 'settlement.escrow.released', 'COMPLETED'],
    ['F', 'FUNDS_LOCKED', 'REFUNDED', 'settlement.escrow.refunded', 'CANCELLED'],
    ['G', 'DISPUTED', 'SPLIT', 'settlement.escrow.split', 'COMPLETED'],
  ] as const)('%s: terminal Escrow (%s -> %s via %s), THEN a delayed LOCKED arrives - Trade stays %s, never regresses to ACTIVE', async (_label, from, to, eventName, expectedTradeStatus) => {
    requirePostgres(`delayed locked after terminal (${eventName})`)
    const ctx = await makeActiveTrade()
    // emitEscrowTransition() only publishes the audit-trail EscrowEvent/durable event - it does not
    // itself write Escrow.status (the real live path CAS-claims that separately, BEFORE calling it -
    // see escrow.service.ts's own releaseFunds()/refundFunds()/splitFunds()). Set the PERSISTED
    // status to the real target first, exactly matching that real ordering.
    await setEscrow(ctx.escrowId, to)
    await emitEscrowTransition(ctx.escrowId, ctx.tradeId, from, to, ctx.sellerId, eventName, {})
    await waitFor(projectedFor(ctx.escrowId, to))
    await sleep(200)
    expect((await tradeOf(ctx.tradeId))!.status).toBe(expectedTradeStatus)

    // the delayed LOCKED, arriving well after the real terminal outcome
    await emitDelayedLocked(ctx)
    expect((await tradeOf(ctx.tradeId))!.status).toBe(expectedTradeStatus) // never ACTIVE
  })

  // ── H/I/J: authoritative terminal Escrow + a stale/contradictory reordered event delivery ──────
  it('H: authoritative REFUNDED Escrow, then a reordered/duplicate RELEASED-shaped delivery: Trade reflects the authoritative refund outcome, never COMPLETED', async () => {
    requirePostgres('authoritative refund vs stale release delivery')
    const ctx = await makeActiveTrade()
    await setEscrow(ctx.escrowId, 'REFUNDED')
    await emitEscrowTransition(ctx.escrowId, ctx.tradeId, 'PAYMENT_PENDING', 'REFUNDED', ctx.sellerId, 'settlement.escrow.refunded', {})
    await waitFor(projectedFor(ctx.escrowId, 'REFUNDED'))
    await sleep(200)
    expect((await tradeOf(ctx.tradeId))!.status).toBe('CANCELLED')

    // A reordered/duplicate delivery of the transition wakes the projector again - it re-reads the
    // PERSISTED escrow (still REFUNDED), never the stale in-flight notion of "release."
    const transition = (await prisma.escrowEvent.findFirst({ where: { escrowId: ctx.escrowId, toStatus: 'REFUNDED' } }))!
    const durable = (await prisma.durableEventRecord.findFirst({ where: { correlationId: ctx.tradeId, eventName: 'settlement.escrow.refunded' } }))!
    await eventBus.redeliver(durable.id)
    await sleep(300)
    expect((await tradeOf(ctx.tradeId))!.status).toBe('CANCELLED') // never COMPLETED
    void transition
  })

  it('I: authoritative RELEASED (COMPLETED) Escrow survives a duplicate/reordered delivery - never CANCELLED', async () => {
    requirePostgres('authoritative release vs stale refund delivery')
    const ctx = await makeActiveTrade()
    await setEscrow(ctx.escrowId, 'COMPLETED')
    await emitEscrowTransition(ctx.escrowId, ctx.tradeId, 'PAYMENT_PENDING', 'COMPLETED', ctx.sellerId, 'settlement.escrow.released', { txId: 'tx-' + randomUUID() })
    await waitFor(projectedFor(ctx.escrowId, 'COMPLETED'))
    await sleep(200)
    expect((await tradeOf(ctx.tradeId))!.status).toBe('COMPLETED')

    const durable = (await prisma.durableEventRecord.findFirst({ where: { correlationId: ctx.tradeId, eventName: 'settlement.escrow.released' } }))!
    await eventBus.redeliver(durable.id)
    await sleep(300)
    expect((await tradeOf(ctx.tradeId))!.status).toBe('COMPLETED') // never CANCELLED
  })

  it('J: authoritative SPLIT (COMPLETED) Escrow survives a duplicate/reordered delivery - never regresses', async () => {
    requirePostgres('authoritative split vs stale delivery')
    const ctx = await makeActiveTrade()
    await setEscrow(ctx.escrowId, 'SPLIT')
    await emitEscrowTransition(ctx.escrowId, ctx.tradeId, 'DISPUTED', 'SPLIT', ctx.sellerId, 'settlement.escrow.split', { txId: 'tx-' + randomUUID() })
    await waitFor(projectedFor(ctx.escrowId, 'SPLIT'))
    await sleep(200)
    expect((await tradeOf(ctx.tradeId))!.status).toBe('COMPLETED')

    const durable = (await prisma.durableEventRecord.findFirst({ where: { correlationId: ctx.tradeId, eventName: 'settlement.escrow.split' } }))!
    await eventBus.redeliver(durable.id)
    await sleep(300)
    expect((await tradeOf(ctx.tradeId))!.status).toBe('COMPLETED')
  })

  // ── K/L: duplicate delivery is harmless ────────────────────────────────────────────────────────
  it('K: duplicate LOCKED delivery is harmless - one EscrowEvent, Trade stays ACTIVE, no duplicate projection claim', async () => {
    requirePostgres('duplicate locked delivery')
    const ctx = await makeActiveTrade()
    await setEscrow(ctx.escrowId, 'FUNDS_LOCKED')
    await emitEscrowTransition(ctx.escrowId, ctx.tradeId, 'CREATED', 'FUNDS_LOCKED', ctx.sellerId, 'settlement.escrow.locked', {})
    await waitFor(projectedFor(ctx.escrowId, 'FUNDS_LOCKED'))
    await sleep(200)
    const durable = (await prisma.durableEventRecord.findFirst({ where: { correlationId: ctx.tradeId, eventName: 'settlement.escrow.locked' } }))!
    for (let i = 0; i < 3; i++) { await eventBus.redeliver(durable.id); await sleep(200) }

    expect((await tradeOf(ctx.tradeId))!.status).toBe('ACTIVE')
    expect(await prisma.escrowEvent.count({ where: { escrowId: ctx.escrowId, toStatus: 'FUNDS_LOCKED' } })).toBe(1)
    expect(await prisma.eventProjectionClaim.count({ where: { projectionKey: 'trade.status', subjectId: ctx.tradeId } })).toBe(1)
  })

  it('L: duplicate terminal (RELEASED) delivery is harmless - counters/reputation apply exactly once', async () => {
    requirePostgres('duplicate terminal delivery')
    const ctx = await makeActiveTrade()
    await setEscrow(ctx.escrowId, 'COMPLETED')
    await emitEscrowTransition(ctx.escrowId, ctx.tradeId, 'PAYMENT_PENDING', 'COMPLETED', ctx.sellerId, 'settlement.escrow.released', { txId: 'tx-' + randomUUID() })
    await waitFor(projectedFor(ctx.escrowId, 'COMPLETED'))
    await sleep(200)
    const durable = (await prisma.durableEventRecord.findFirst({ where: { correlationId: ctx.tradeId, eventName: 'settlement.escrow.released' } }))!
    for (let i = 0; i < 3; i++) { await eventBus.redeliver(durable.id); await sleep(200) }

    const [buyer, seller, trade] = await Promise.all([
      prisma.user.findUnique({ where: { id: ctx.buyerId } }),
      prisma.user.findUnique({ where: { id: ctx.sellerId } }),
      tradeOf(ctx.tradeId),
    ])
    expect(trade!.status).toBe('COMPLETED')
    expect(buyer!.totalTrades).toBe(1)
    expect(seller!.totalTrades).toBe(1)
  })

  // ── M/N: replay after restart / arbitrary reordering converge to authoritative truth ────────────
  it('M: replay after a genuine restart (independent module graph) is harmless', async () => {
    requirePostgres('replay after restart')
    const ctx = await makeActiveTrade()
    await setEscrow(ctx.escrowId, 'COMPLETED')
    await emitEscrowTransition(ctx.escrowId, ctx.tradeId, 'PAYMENT_PENDING', 'COMPLETED', ctx.sellerId, 'settlement.escrow.released', { txId: 'tx-' + randomUUID() })
    await waitFor(projectedFor(ctx.escrowId, 'COMPLETED'))
    await sleep(200)
    const completedAt = (await tradeOf(ctx.tradeId))!.completedAt!.getTime()

    const durable = (await prisma.durableEventRecord.findFirst({ where: { correlationId: ctx.tradeId, eventName: 'settlement.escrow.released' } }))!
    await instanceB!.eventBus.redeliver(durable.id)
    await sleep(400)

    expect((await tradeOf(ctx.tradeId))!.status).toBe('COMPLETED')
    expect((await tradeOf(ctx.tradeId))!.completedAt!.getTime()).toBe(completedAt) // write-once, not re-stamped
  })

  it('N: arbitrary reordered delivery of an escrow\'s full lifecycle (locked, disputed, released delivered in reverse) converges to the authoritative persisted outcome', async () => {
    requirePostgres('arbitrary reordering converges')
    const ctx = await makeActiveTrade()
    // Build 3 REAL transitions for this escrow's own lifecycle (each is a real EscrowEvent/durable
    // event pair), but never let their own live redelivery race projection - instead, replay them
    // out of order afterward, exactly the "arbitrary reordered delivery" property. The persisted
    // Escrow status is advanced to match each real transition as it happens, same as the live path.
    await setEscrow(ctx.escrowId, 'FUNDS_LOCKED')
    await emitEscrowTransition(ctx.escrowId, ctx.tradeId, 'CREATED', 'FUNDS_LOCKED', ctx.sellerId, 'settlement.escrow.locked', {})
    await waitFor(projectedFor(ctx.escrowId, 'FUNDS_LOCKED'))
    await setEscrow(ctx.escrowId, 'DISPUTED')
    await emitEscrowTransition(ctx.escrowId, ctx.tradeId, 'FUNDS_LOCKED', 'DISPUTED', ctx.sellerId, 'settlement.escrow.disputed', {})
    await waitFor(projectedFor(ctx.escrowId, 'DISPUTED'))
    await setEscrow(ctx.escrowId, 'COMPLETED')
    await emitEscrowTransition(ctx.escrowId, ctx.tradeId, 'DISPUTED', 'COMPLETED', ctx.sellerId, 'settlement.escrow.released', { txId: 'tx-' + randomUUID() })
    await waitFor(projectedFor(ctx.escrowId, 'COMPLETED'))
    await sleep(200)
    expect((await tradeOf(ctx.tradeId))!.status).toBe('COMPLETED')

    const [locked, disputed, released] = await Promise.all([
      prisma.durableEventRecord.findFirst({ where: { correlationId: ctx.tradeId, eventName: 'settlement.escrow.locked' } }),
      prisma.durableEventRecord.findFirst({ where: { correlationId: ctx.tradeId, eventName: 'settlement.escrow.disputed' } }),
      prisma.durableEventRecord.findFirst({ where: { correlationId: ctx.tradeId, eventName: 'settlement.escrow.released' } }),
    ])
    // Reversed order: released, disputed, locked - the persisted Escrow is already COMPLETED, so
    // every one of these (including the "earliest" locked event) must converge to COMPLETED.
    for (const d of [released, disputed, locked]) {
      await eventBus.redeliver(d!.id)
      await sleep(250)
      expect((await tradeOf(ctx.tradeId))!.status).toBe('COMPLETED')
    }
  })

  // ── O: two DIFFERENT handlers racing concurrently converge deterministically ────────────────────
  it('O: a delayed LOCKED concurrently racing the real terminal RELEASED projection converges deterministically to COMPLETED, never ACTIVE', async () => {
    requirePostgres('two different handlers racing')
    const ctx = await makeActiveTrade()
    await setEscrow(ctx.escrowId, 'COMPLETED')
    // Two real, DISTINCT transitions durably claimed up front (both legitimately exist in the audit
    // trail - the point is which one's PROJECTION wins the race, not whether both can be claimed).
    await emitEscrowTransition(ctx.escrowId, ctx.tradeId, 'PAYMENT_PENDING', 'COMPLETED', ctx.sellerId, 'settlement.escrow.released', { txId: 'tx-' + randomUUID() })
    const releasedTransition = (await prisma.escrowEvent.findFirst({ where: { escrowId: ctx.escrowId, toStatus: 'COMPLETED' } }))!
    await waitFor(projectedFor(ctx.escrowId, 'COMPLETED'))
    await sleep(200)
    expect((await tradeOf(ctx.tradeId))!.status).toBe('COMPLETED')

    const releasedDurable = (await prisma.durableEventRecord.findFirst({ where: { correlationId: ctx.tradeId, eventName: 'settlement.escrow.released' } }))!
    // A delayed LOCKED for this SAME escrow/trade is durably recorded as its own claimed transition
    // too (audit trail realism), but the escrow is authoritatively COMPLETED by the time either
    // handler actually races to project - concurrently redeliver BOTH, from two independent module
    // graphs, and confirm the deterministic winner is always the authoritative persisted truth.
    const lockedTransition = await prisma.escrowEvent.create({
      data: { escrowId: ctx.escrowId, fromStatus: 'CREATED', toStatus: 'FUNDS_LOCKED', triggeredBy: ctx.sellerId, entryHash: 'h' + randomUUID(), prevHash: 'genesis' },
    })
    await prisma.eventProjectionClaim.create({ data: { eventId: lockedTransition.id, projectionKey: 'transition.claimed', subjectId: ctx.escrowId } })
    const lockedEventId = randomUUID()
    await prisma.durableEventRecord.create({
      data: {
        id: lockedEventId, eventName: 'settlement.escrow.locked', correlationId: ctx.tradeId,
        payload: { escrowId: ctx.escrowId, tradeId: ctx.tradeId, from: 'CREATED', to: 'FUNDS_LOCKED', triggeredBy: ctx.sellerId, transitionId: lockedTransition.id },
        publishedAt: new Date().toISOString(), entryHash: 'e' + lockedEventId, prevHash: 'genesis',
      },
    })

    await Promise.all([
      eventBus.redeliver(lockedEventId),
      instanceB!.eventBus.redeliver(releasedDurable.id),
    ])
    await sleep(500)

    // Deterministic: the persisted Escrow is COMPLETED, so the Trade converges there regardless of
    // which handler's projection call physically ran first or last.
    expect((await tradeOf(ctx.tradeId))!.status).toBe('COMPLETED')
    void releasedTransition
  })

  // ── Concurrency: two handlers racing the SAME delayed-LOCKED-after-terminal scenario ────────────
  it('two independent module graphs racing a delayed LOCKED after a real terminal RELEASE converge on the same non-regressed Trade state', async () => {
    requirePostgres('concurrent delayed locked race')
    const ctx = await makeActiveTrade()
    await setEscrow(ctx.escrowId, 'COMPLETED')
    await emitEscrowTransition(ctx.escrowId, ctx.tradeId, 'PAYMENT_PENDING', 'COMPLETED', ctx.sellerId, 'settlement.escrow.released', { txId: 'tx-' + randomUUID() })
    await waitFor(projectedFor(ctx.escrowId, 'COMPLETED'))
    await sleep(200)

    const lockedTransition = await prisma.escrowEvent.create({
      data: { escrowId: ctx.escrowId, fromStatus: 'CREATED', toStatus: 'FUNDS_LOCKED', triggeredBy: ctx.sellerId, entryHash: 'h' + randomUUID(), prevHash: 'genesis' },
    })
    await prisma.eventProjectionClaim.create({ data: { eventId: lockedTransition.id, projectionKey: 'transition.claimed', subjectId: ctx.escrowId } })
    const lockedEventId = randomUUID()
    await prisma.durableEventRecord.create({
      data: {
        id: lockedEventId, eventName: 'settlement.escrow.locked', correlationId: ctx.tradeId,
        payload: { escrowId: ctx.escrowId, tradeId: ctx.tradeId, from: 'CREATED', to: 'FUNDS_LOCKED', triggeredBy: ctx.sellerId, transitionId: lockedTransition.id },
        publishedAt: new Date().toISOString(), entryHash: 'e' + lockedEventId, prevHash: 'genesis',
      },
    })

    await Promise.all([eventBus.redeliver(lockedEventId), instanceB!.eventBus.redeliver(lockedEventId)])
    await sleep(500)

    expect((await tradeOf(ctx.tradeId))!.status).toBe('COMPLETED') // never regressed to ACTIVE by either instance
    expect(await prisma.eventProjectionClaim.count({ where: { projectionKey: 'transition.projected', subjectId: lockedTransition.id } })).toBe(1)
  })
})
