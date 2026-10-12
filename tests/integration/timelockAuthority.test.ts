// tests/integration/timelockAuthority.test.ts
//
// Master Backlog R5: who decides an escrow's timelock. Escrow.timelockHours is protocol policy
// (DEFAULT_TIMELOCK_HOURS), never caller input: a trade party sending `timelockHours` on
// POST /v1/settlement/escrow must not be able to make an escrow expire at lock time (0 or negative)
// or never (a huge value). The value is frozen on the escrow when it is created, and expiresAt is
// derived from that frozen value when funds lock, so a later config change, a restart or another
// node with different config never rewrites an existing escrow's deadline. An invalid policy value
// fails before any escrow row exists.
//
// Real PostgreSQL, through the real escrowService. A "node" is an independent module graph
// (jest.isolateModules) booted with its own DEFAULT_TIMELOCK_HOURS, as in timelockExpiryBoundedness.test.ts.
// Rows this suite creates are removed in afterAll (only those).

import { PrismaClient } from '@prisma/client'
import { randomBytes } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'

const HOUR_MS = 3_600_000

describe('R5 timelock authority: caller timelockHours is inert, policy is frozen at creation (real PostgreSQL)', () => {
  jest.setTimeout(120_000)

  const pg = createPostgresIntegrationHarness()
  let prisma: PrismaClient
  const nodes: Node[] = []
  const ownedTradeIds: string[] = []
  const ownedUserIds: string[] = []
  const ORIGINAL_TIMELOCK_ENV = process.env.DEFAULT_TIMELOCK_HOURS

  beforeAll(async () => {
    await pg.probe()
    if (!pg.isAvailable()) return
    ;({ prisma } = require('../../src/common/database'))
  })

  afterEach(async () => {
    jest.useRealTimers()
    jest.restoreAllMocks()
    while (nodes.length) await nodes.pop()!.shutdown()
  })

  afterAll(async () => {
    if (ORIGINAL_TIMELOCK_ENV === undefined) delete process.env.DEFAULT_TIMELOCK_HOURS
    else process.env.DEFAULT_TIMELOCK_HOURS = ORIGINAL_TIMELOCK_ENV
    if (!pg.isAvailable()) return
    const escrows = await prisma.escrow.findMany({ where: { tradeId: { in: ownedTradeIds } }, select: { id: true } })
    const escrowIds = escrows.map((e) => e.id)
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`DELETE FROM semantic_transition_records WHERE "interactionId" = ANY(${escrowIds})`
      await tx.$executeRaw`DELETE FROM escrow_events WHERE "escrowId" = ANY(${escrowIds})`
      await tx.$executeRaw`UPDATE trades SET "escrowId" = NULL WHERE id = ANY(${ownedTradeIds})`
      await tx.$executeRaw`DELETE FROM escrows WHERE id = ANY(${escrowIds})`
      await tx.$executeRaw`DELETE FROM trades WHERE id = ANY(${ownedTradeIds})`
      await tx.$executeRaw`DELETE FROM offers WHERE "userId" = ANY(${ownedUserIds})`
      await tx.$executeRaw`DELETE FROM users WHERE id = ANY(${ownedUserIds})`
    })
    await prisma.$disconnect()
    await closeTestRedis()
  })

  // ─── nodes ────────────────────────────────────────────────────────────────────────────────────────────

  interface Node {
    escrowService: any
    config: any
    shutdown: () => Promise<void>
  }

  /** An application instance booted with DEFAULT_TIMELOCK_HOURS=`timelockEnv` (unset when undefined). */
  function startNode(timelockEnv: string | undefined): Node {
    if (timelockEnv === undefined) delete process.env.DEFAULT_TIMELOCK_HOURS
    else process.env.DEFAULT_TIMELOCK_HOURS = timelockEnv
    let node!: Node
    jest.isolateModules(() => {
      const redisModule = require('../../src/common/redis')
      require('../../src/common/events/handlers').registerEventHandlers()
      node = {
        escrowService: require('../../src/modules/open-settlement/escrow.service').escrowService,
        config: require('../../src/config').config,
        shutdown: async () => { await redisModule.redis?.quit?.().catch(() => undefined) },
      }
    })
    nodes.push(node)
    return node
  }

  // ─── fixtures ─────────────────────────────────────────────────────────────────────────────────────────

  async function fixtureTrade() {
    const tag = randomBytes(6).toString('hex')
    const buyer = await prisma.user.create({ data: { publicKey: `pk-r5-buyer-${tag}` } })
    const seller = await prisma.user.create({ data: { publicKey: `pk-r5-seller-${tag}` } })
    ownedUserIds.push(buyer.id, seller.id)
    const offer = await prisma.offer.create({
      data: { userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '65000', minAmount: '0.001', maxAmount: '1', paymentMethod: 'PIX' },
    })
    const trade = await prisma.trade.create({
      data: { offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, asset: 'BTC', amount: '0.001', priceUsd: '65000', totalUsd: '65' },
    })
    ownedTradeIds.push(trade.id)
    return { trade, buyer, seller }
  }

  function createOn(node: Node, tradeId: string, actorId: string, extra: Record<string, unknown> = {}) {
    return node.escrowService.createEscrow({ tradeId, type: 'MOCK', lockedAmount: '0.001', asset: 'BTC', ...extra }, actorId)
  }

  // Sweep only this suite's escrows: the real sweep, with the shared-queue claim narrowed to `ids`
  // so other suites' backlog never takes a slot and is never touched.
  function narrowSweepTo(node: Node, ids: string[]) {
    jest.spyOn(node.escrowService.repo, 'claimExpiryCandidates').mockImplementation((async (now: Date) =>
      prisma.escrow.findMany({ where: { id: { in: ids }, status: 'FUNDS_LOCKED', expiresAt: { lte: now } } })) as any)
  }

  // ─── tests ────────────────────────────────────────────────────────────────────────────────────────────

  it.each([
    ['zero', 0],
    ['negative', -5],
    ['huge', 1_000_000_000],
    ['fractional', 1.5],
  ])('T1-T4: a caller-supplied %s timelockHours is ignored; the escrow is created with the policy value', async (_label, callerValue) => {
    pg.requirePostgres('T1-T4')
    const node = startNode('24')
    const { trade, seller } = await fixtureTrade()

    const escrow = await createOn(node, trade.id, seller.id, { timelockHours: callerValue })

    expect(escrow.timelockHours).toBe(24)
    const row = await prisma.escrow.findUniqueOrThrow({ where: { id: escrow.id } })
    expect(row.timelockHours).toBe(24)
  })

  it('T5: with no caller value and no DEFAULT_TIMELOCK_HOURS outside production, the 24h dev default applies', async () => {
    pg.requirePostgres('T5')
    const node = startNode(undefined)
    const { trade, seller } = await fixtureTrade()

    const escrow = await createOn(node, trade.id, seller.id)

    expect(node.config.trade.defaultTimelockHours).toBe(24)
    expect(escrow.timelockHours).toBe(24)
  })

  it('T6: the seller cannot shorten their own deadline either; lockFunds derives expiresAt from the frozen policy value', async () => {
    pg.requirePostgres('T6')
    const node = startNode('36')
    const { trade, seller } = await fixtureTrade()

    const escrow = await createOn(node, trade.id, seller.id, { timelockHours: 0 })
    await node.escrowService.lockFunds(escrow.id, seller.id)

    const row = await prisma.escrow.findUniqueOrThrow({ where: { id: escrow.id } })
    expect(row.status).toBe('FUNDS_LOCKED')
    expect(row.timelockHours).toBe(36)
    expect(row.expiresAt!.getTime() - row.lockedAt!.getTime()).toBe(36 * HOUR_MS)
  })

  it('T7: P1 creates under 24h, the operator changes policy to 48h and restarts, P2 locks the old escrow: its deadline stays 24h', async () => {
    pg.requirePostgres('T7')
    const p1 = startNode('24')
    const old = await fixtureTrade()
    const oldEscrow = await createOn(p1, old.trade.id, old.seller.id)
    await p1.shutdown()

    const p2 = startNode('48')
    await p2.escrowService.lockFunds(oldEscrow.id, old.seller.id)
    const fresh = await fixtureTrade()
    const freshEscrow = await createOn(p2, fresh.trade.id, fresh.seller.id)
    await p2.escrowService.lockFunds(freshEscrow.id, fresh.seller.id)

    const oldRow = await prisma.escrow.findUniqueOrThrow({ where: { id: oldEscrow.id } })
    const freshRow = await prisma.escrow.findUniqueOrThrow({ where: { id: freshEscrow.id } })
    expect(oldRow.timelockHours).toBe(24)
    expect(oldRow.expiresAt!.getTime() - oldRow.lockedAt!.getTime()).toBe(24 * HOUR_MS)
    expect(freshRow.timelockHours).toBe(48)
    expect(freshRow.expiresAt!.getTime() - freshRow.lockedAt!.getTime()).toBe(48 * HOUR_MS)
  })

  it('T8: two live nodes with different policy (a rolling config change): each escrow keeps the value of the node that created it, wherever it is locked', async () => {
    pg.requirePostgres('T8')
    const a = startNode('24')
    const b = startNode('72')
    const ta = await fixtureTrade()
    const tb = await fixtureTrade()

    const [ea, eb] = await Promise.all([createOn(a, ta.trade.id, ta.seller.id, { timelockHours: 1 }), createOn(b, tb.trade.id, tb.seller.id, { timelockHours: 1 })])
    // Cross-lock: each escrow is locked on the OTHER node.
    await Promise.all([b.escrowService.lockFunds(ea.id, ta.seller.id), a.escrowService.lockFunds(eb.id, tb.seller.id)])

    const ra = await prisma.escrow.findUniqueOrThrow({ where: { id: ea.id } })
    const rb = await prisma.escrow.findUniqueOrThrow({ where: { id: eb.id } })
    expect([ra.timelockHours, ra.expiresAt!.getTime() - ra.lockedAt!.getTime()]).toEqual([24, 24 * HOUR_MS])
    expect([rb.timelockHours, rb.expiresAt!.getTime() - rb.lockedAt!.getTime()]).toEqual([72, 72 * HOUR_MS])
  })

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['unrepresentable', 3_000_000_000],
  ])('T9-T13: a %s policy value that bypassed the boot gate still fails before any escrow row exists', async (_label, policyValue) => {
    pg.requirePostgres('T9-T13')
    const node = startNode('24')
    node.config.trade.defaultTimelockHours = policyValue
    const { trade, seller } = await fixtureTrade()

    await expect(createOn(node, trade.id, seller.id, { timelockHours: 24 })).rejects.toThrow(/DEFAULT_TIMELOCK_HOURS/)

    expect(await prisma.escrow.count({ where: { tradeId: trade.id } })).toBe(0)
    expect((await prisma.trade.findUniqueOrThrow({ where: { id: trade.id } })).escrowId).toBeNull()
  })

  it('T14: an invalid DEFAULT_TIMELOCK_HOURS refuses to boot the node at all, outside production too', () => {
    for (const bad of ['0', '-3', '1.5', 'abc', '', '3000000000']) {
      expect(() => startNode(bad)).toThrow(/DEFAULT_TIMELOCK_HOURS/)
    }
  })

  it('T15-T17: an escrow a caller asked to expire at once is not swept at lock time; it expires only after its policy deadline (exclusive)', async () => {
    pg.requirePostgres('T15-T17')
    const node = startNode('24')
    const { trade, seller } = await fixtureTrade()
    const escrow = await createOn(node, trade.id, seller.id, { timelockHours: 0 })
    await node.escrowService.lockFunds(escrow.id, seller.id)
    const locked = await prisma.escrow.findUniqueOrThrow({ where: { id: escrow.id } })
    narrowSweepTo(node, [escrow.id])

    // T15: right after locking (the pre-R5 attack window), nothing to sweep.
    expect((await node.escrowService.sweepExpiredEscrows()).refunded).toEqual([])

    const doNotFake = ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'] as const
    // T16: exactly at the deadline, still not expired (the direct-call branch requires expiresAt < now).
    jest.useFakeTimers({ now: locked.expiresAt!.getTime(), doNotFake: [...doNotFake] })
    expect((await node.escrowService.sweepExpiredEscrows()).refunded).toEqual([])
    expect((await prisma.escrow.findUniqueOrThrow({ where: { id: escrow.id } })).status).toBe('FUNDS_LOCKED')

    // T17: one millisecond later, the ordinary expiry refund applies.
    jest.setSystemTime(locked.expiresAt!.getTime() + 1)
    expect((await node.escrowService.sweepExpiredEscrows()).refunded).toEqual([escrow.id])
    expect((await prisma.escrow.findUniqueOrThrow({ where: { id: escrow.id } })).status).toBe('REFUNDED')
  })

  it('T18: an escrow created before R5 keeps its persisted caller-chosen value (historical truth is never recomputed)', async () => {
    pg.requirePostgres('T18')
    const node = startNode('24')
    const { trade, seller } = await fixtureTrade()
    const escrow = await createOn(node, trade.id, seller.id)
    // A legacy row as pre-R5 code could have written it: caller-chosen 5h.
    await prisma.escrow.update({ where: { id: escrow.id }, data: { timelockHours: 5 } })

    await node.escrowService.lockFunds(escrow.id, seller.id)

    const row = await prisma.escrow.findUniqueOrThrow({ where: { id: escrow.id } })
    expect(row.timelockHours).toBe(5)
    expect(row.expiresAt!.getTime() - row.lockedAt!.getTime()).toBe(5 * HOUR_MS)
  })
})
