// tests/integration/timelockExpiryCrashConsistency.test.ts
//
// A durable timelock expiry (escrow FUNDS_LOCKED -> EXPIRED) must eventually have exactly ONE canonical
// durable event, 'settlement.escrow.expired', whatever crashes in between: the trade's Timeline and every
// other reader of the durable event log learn of the expiry only from it.
//
// Guarantee under test (the #373 model): one canonical durable event per transition + at-least-once
// (re)delivery + idempotent projection. The expiry moves no funds; nothing here is "exactly once" delivery.
//
// Real PostgreSQL. Crashes are failpoints (a step throws 'process died' instead of running), never timing.
// A "node" is an independent module graph (jest.isolateModules): its own event bus, handlers, sweeper and
// reconciler; the PrismaClient (and so the database) is shared, as in transitionPublishAuthority.test.ts.

import { PrismaClient } from '@prisma/client'
import { randomBytes } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'
import { boundOfferRow, boundTradeRow, sellerPixAccount } from './economicFixtures'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
// PASS 3's queue is shared with other suites' rows; a marker claimed at QUEUE_HEAD is ahead of all of them.
const QUEUE_HEAD = new Date('2000-01-01T00:00:00.000Z')
const EXPIRED_EVENT = 'settlement.escrow.expired'

interface Deferred { promise: Promise<void>; resolve: () => void }
function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

describe('Timelock expiry crash consistency: a durable EXPIRED always gets its one canonical event (real PostgreSQL)', () => {
  jest.setTimeout(120_000)

  const pg = createPostgresIntegrationHarness()
  let prisma: PrismaClient
  let getTimeline: typeof import('../../src/core/timeline').getTimeline
  const nodes: Node[] = []

  beforeAll(async () => {
    await pg.probe()
    if (!pg.isAvailable()) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ getTimeline } = require('../../src/core/timeline'))
  })

  afterAll(async () => {
    if (pg.isAvailable()) {
      await prisma.$disconnect()
      await closeTestRedis()
    }
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    while (nodes.length) await nodes.pop()!.shutdown()
  })

  // ─── nodes ────────────────────────────────────────────────────────────────────────────────────────────

  interface Node {
    eventBus: typeof import('../../src/common/events/event-bus').eventBus
    escrowService: typeof import('../../src/modules/open-settlement/escrow.service').escrowService
    str: typeof import('../../src/modules/open-settlement/semantic-transition-record')
    /** The production reconciler entry point (PASS 0-3) - PASS 3 with no grace, as if the grace had passed. */
    reconcile: () => Promise<any>
    /** PASS 3 alone, `limit` transitions, no grace. */
    pass3: (limit: number) => Promise<{ projectionsRecovered: unknown[] }>
    shutdown: () => Promise<void>
  }

  /** An application instance (or this one after a restart). `handlers: false` = it dies before its handlers run. */
  function startNode({ handlers = true } = {}): Node {
    let node!: Node
    jest.isolateModules(() => {
      const redisModule = require('../../src/common/redis')
      if (handlers) require('../../src/common/events/handlers').registerEventHandlers()
      const recon = require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service')
      node = {
        eventBus: require('../../src/common/events/event-bus').eventBus,
        escrowService: require('../../src/modules/open-settlement/escrow.service').escrowService,
        str: require('../../src/modules/open-settlement/semantic-transition-record'),
        reconcile: () => recon.reconcilePendingSettlements({ projectionGraceMs: 0 }),
        pass3: async (limit) => { const r = { requiresManualReview: [], failed: [], projectionsRecovered: [] }; await recon.reconcileIncompleteProjections(r, 0, { limit }); return r },
        shutdown: async () => { await redisModule.redis?.quit?.().catch(() => undefined) },
      }
    })
    nodes.push(node)
    return node
  }

  // ─── fixtures and reads ───────────────────────────────────────────────────────────────────────────────

  async function expiredEscrow() {
    const seller = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
    const buyer = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
    const acct = await sellerPixAccount(prisma, seller.id)
    const offer = await prisma.offer.create({ data: { userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '65000', minAmount: '0.001', maxAmount: '1', ...boundOfferRow(acct) } })
    const trade = await prisma.trade.create({ data: { ...boundTradeRow(acct), offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, asset: 'BTC', amount: '0.001', priceUsd: '65000', totalUsd: '65' } })
    const escrow = await prisma.escrow.create({
      // #235 R7G F8A: expiresAt only ever lands together with the funding outpoint (lockFunds())
      data: { tradeId: trade.id, type: 'MULTISIG', status: 'FUNDS_LOCKED', asset: 'BTC', lockedAmount: '0.001', timelockHours: 1, expiresAt: new Date(Date.now() - 60_000), txLockId: randomBytes(32).toString('hex'), txLockVout: 0 },
    })
    return { escrowId: escrow.id, tradeId: trade.id, sellerId: seller.id }
  }
  type Ctx = Awaited<ReturnType<typeof expiredEscrow>>

  const expiryTransitions = (ctx: Ctx) => prisma.escrowEvent.findMany({ where: { escrowId: ctx.escrowId, toStatus: 'EXPIRED' } })
  const expiryRecords = (ctx: Ctx) => prisma.semanticTransitionRecord.findMany({ where: { interactionId: ctx.escrowId, transitionType: 'escrow.timelock.expire' } })
  const expiryEvents = (ctx: Ctx) => prisma.$queryRaw<Array<{ id: string; payload: any }>>`
    SELECT id, payload FROM durable_events WHERE "correlationId" = ${ctx.tradeId} AND "eventName" = ${EXPIRED_EVENT} ORDER BY "publishedAt"`
  const projectedCount = (transitionId: string) => prisma.eventProjectionClaim.count({ where: { projectionKey: 'transition.projected', subjectId: transitionId } })
  /** The crashed expiry's PASS 3 marker, if it has one, moved to the queue head (its grace period passed). */
  const makeRecoverableNow = (ctx: Ctx, at = QUEUE_HEAD) =>
    prisma.eventProjectionClaim.updateMany({ where: { subjectId: ctx.escrowId, projectionKey: 'transition.claimed' }, data: { appliedAt: at } })

  async function waitFor(cond: () => Promise<boolean>, ms = 15_000): Promise<void> {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await cond()) return
      await sleep(50)
    }
    throw new Error('timed out waiting for condition')
  }

  /** The convergence every scenario must end in: EXPIRED once, one record, one transition, ONE canonical durable event (payload from durable state), projected, on the Timeline. */
  async function expectConverged(ctx: Ctx): Promise<void> {
    const escrow = await prisma.escrow.findUniqueOrThrow({ where: { id: ctx.escrowId } })
    expect(escrow.status).toBe('EXPIRED')
    expect(await expiryRecords(ctx)).toHaveLength(1)
    const transitions = await expiryTransitions(ctx)
    expect(transitions).toHaveLength(1)
    const transitionId = transitions[0].id
    await waitFor(async () => (await projectedCount(transitionId)) > 0)
    await sleep(500) // let any handler a second delivery would trigger finish
    const events = await expiryEvents(ctx)
    expect(events).toHaveLength(1)
    expect(events[0].payload).toEqual({
      escrowId: ctx.escrowId, tradeId: ctx.tradeId, from: 'FUNDS_LOCKED', to: 'EXPIRED', triggeredBy: 'system:expiry-sweeper',
      type: 'MULTISIG', sellerId: ctx.sellerId, transitionId,
    })
    expect(await projectedCount(transitionId)).toBe(1)
    // out of PASS 3's queue: nothing left owed for this transition
    expect(await prisma.eventProjectionClaim.count({ where: { eventId: transitionId, projectionKey: 'transition.claimed', transitionProjectedAt: null } })).toBe(0)
    const timeline = getTimeline(ctx.tradeId)
    expect((await timeline.getEvents()).filter((e) => e.eventType === EXPIRED_EVENT)).toHaveLength(1)
    expect((await timeline.verifyChain()).valid).toBe(true)
  }

  /** Makes `node`'s next call of `fn` on `target` die ('process died') after (`after: true`) or instead of running the real one. */
  function crashAt(target: any, fn: string, { after = false, when = (..._a: any[]): boolean => true }: { after?: boolean; when?: (...a: any[]) => boolean } = {}) {
    const real = target[fn].bind(target)
    let fired = false
    jest.spyOn(target, fn).mockImplementation(async (...args: any[]) => {
      if (fired || !when(...args)) return real(...args)
      fired = true
      if (after) await real(...args)
      throw new Error('process died')
    })
  }
  const isExpiryOf = (ctx: Ctx) => (name: any, payload: any) => name === EXPIRED_EVENT && payload?.escrowId === ctx.escrowId

  // ═══ live path ═══════════════════════════════════════════════════════════════════════════════════════

  it('1. normal expiry: EXPIRED, one record, one transition, one canonical event carrying its transitionId, projected and on the Timeline', async () => {
    pg.requirePostgres('normal expiry')
    const ctx = await expiredEscrow()
    const result = await startNode().escrowService.sweepExpiredEscrows()
    expect(result.requiresManualRecovery).toContain(ctx.escrowId)
    await expectConverged(ctx)
  })

  it('2. repeated ticks: a second and third sweep change nothing (no second transition, record or event)', async () => {
    pg.requirePostgres('repeated ticks')
    const ctx = await expiredEscrow()
    const node = startNode()
    await node.escrowService.sweepExpiredEscrows()
    const again = [await node.escrowService.sweepExpiredEscrows(), await node.escrowService.sweepExpiredEscrows()]
    for (const r of again) expect(r.requiresManualRecovery).not.toContain(ctx.escrowId)
    await expectConverged(ctx)
  })

  it('3. two nodes sweep the same expiry at once: one semantic expiry, one transition, one canonical event', async () => {
    pg.requirePostgres('two-node race')
    const ctx = await expiredEscrow()
    const [a, b] = [startNode(), startNode()]
    const results = await Promise.all([a.escrowService.sweepExpiredEscrows(), b.escrowService.sweepExpiredEscrows()])
    expect(results.filter((r) => r.requiresManualRecovery.includes(ctx.escrowId))).toHaveLength(1)
    await expectConverged(ctx)
  })

  // ═══ crashes, then a restart ═════════════════════════════════════════════════════════════════════════

  it('4. crash before the state mutation: nothing is durable; the next tick (another process) expires it normally', async () => {
    pg.requirePostgres('crash before mutation')
    const ctx = await expiredEscrow()
    const a = startNode()
    crashAt(a.str, 'commitAuthoritativeEscrowTimelockExpiry', { when: (id: string) => id === ctx.escrowId })
    expect((await a.escrowService.sweepExpiredEscrows()).failed.map((f) => f.escrowId)).toContain(ctx.escrowId)
    expect((await prisma.escrow.findUniqueOrThrow({ where: { id: ctx.escrowId } })).status).toBe('FUNDS_LOCKED')
    expect(await expiryRecords(ctx)).toHaveLength(0)

    await startNode().escrowService.sweepExpiredEscrows()
    await expectConverged(ctx)
  })

  it('5/6. crash right after EXPIRED is committed, before anything else: a restarted process repairs the missing canonical event', async () => {
    pg.requirePostgres('crash after EXPIRED')
    const ctx = await expiredEscrow()
    const a = startNode()
    crashAt(a.str, 'commitAuthoritativeEscrowTimelockExpiry', { after: true, when: (id: string) => id === ctx.escrowId })
    await a.escrowService.sweepExpiredEscrows()
    expect((await prisma.escrow.findUniqueOrThrow({ where: { id: ctx.escrowId } })).status).toBe('EXPIRED')
    expect(await expiryEvents(ctx)).toHaveLength(0) // the crash window: durable EXPIRED, no canonical event

    const b = startNode() // restart: new process, nothing in memory
    await b.escrowService.sweepExpiredEscrows() // the sweep alone never revisits an EXPIRED escrow
    await makeRecoverableNow(ctx)
    await b.reconcile()
    await expectConverged(ctx)
  })

  it('D. crash at the publish (transition claimed, durable event not written): a restarted process re-publishes it once', async () => {
    pg.requirePostgres('crash at publish')
    const ctx = await expiredEscrow()
    const a = startNode()
    crashAt(a.eventBus, 'emit', { when: isExpiryOf(ctx) }) // the live publish (PASS 3 re-publishes through eventBus.publish)
    await a.escrowService.sweepExpiredEscrows()
    expect(await expiryTransitions(ctx)).toHaveLength(1)
    expect(await expiryEvents(ctx)).toHaveLength(0)

    const b = startNode()
    await b.escrowService.sweepExpiredEscrows()
    await makeRecoverableNow(ctx)
    await b.reconcile()
    await expectConverged(ctx)
  })

  it('7/8. crash after the durable event, before its projection ran: a restarted process redelivers it, never a second event', async () => {
    pg.requirePostgres('crash after event')
    const ctx = await expiredEscrow()
    await startNode({ handlers: false }).escrowService.sweepExpiredEscrows()
    const [transition] = await expiryTransitions(ctx)
    expect(await expiryEvents(ctx)).toHaveLength(1)
    expect(await projectedCount(transition.id)).toBe(0)

    await makeRecoverableNow(ctx)
    await startNode().reconcile()
    await expectConverged(ctx)
  })

  it('9. a stale worker that selected the escrow resumes after another node finished the expiry: it loses the claim and adds nothing', async () => {
    pg.requirePostgres('stale worker')
    const ctx = await expiredEscrow()
    const stale = startNode()
    const reached = deferred(); const resume = deferred()
    const real = stale.str.commitAuthoritativeEscrowTimelockExpiry
    jest.spyOn(stale.str, 'commitAuthoritativeEscrowTimelockExpiry').mockImplementation(async (...args: any[]) => {
      if (args[0] === ctx.escrowId) { reached.resolve(); await resume.promise }
      return (real as any)(...args)
    })
    const staleRun = stale.escrowService.sweepExpiredEscrows()
    await reached.promise // the stale worker selected the escrow and decided it is expired
    await startNode().escrowService.sweepExpiredEscrows() // another node expires it completely
    await expectConverged(ctx)
    resume.resolve()
    expect((await staleRun).requiresManualRecovery).not.toContain(ctx.escrowId)
    await expectConverged(ctx)
  })

  it('10. a transient publish failure on the live path: the expiry is not reverted, and the reconciler publishes it once', async () => {
    pg.requirePostgres('publish failure')
    const ctx = await expiredEscrow()
    const a = startNode()
    crashAt(a.eventBus, 'emit', { when: isExpiryOf(ctx) }) // the live publish (PASS 3 re-publishes through eventBus.publish)
    const result = await a.escrowService.sweepExpiredEscrows()
    expect(result.failed.map((f) => f.escrowId)).toContain(ctx.escrowId)
    expect((await prisma.escrow.findUniqueOrThrow({ where: { id: ctx.escrowId } })).status).toBe('EXPIRED')
    await makeRecoverableNow(ctx)
    await a.reconcile() // the same process, its event store reachable again
    await expectConverged(ctx)
  })

  it('12. a backlog of crashed expiries larger than one PASS 3 run drains within ceil(backlog / batch) runs', async () => {
    pg.requirePostgres('backlog')
    const ctxs = [await expiredEscrow(), await expiredEscrow(), await expiredEscrow()]
    const a = startNode()
    // one failpoint for all three: every commit of these escrows dies right after it committed
    const backlogIds = new Set(ctxs.map((c) => c.escrowId))
    const realCommit = a.str.commitAuthoritativeEscrowTimelockExpiry
    jest.spyOn(a.str, 'commitAuthoritativeEscrowTimelockExpiry').mockImplementation(async (...args: any[]) => {
      const result = await (realCommit as any)(...args)
      if (backlogIds.has(args[0])) throw new Error('process died')
      return result
    })
    await a.escrowService.sweepExpiredEscrows()
    for (const ctx of ctxs) expect(await expiryEvents(ctx)).toHaveLength(0)

    const b = startNode()
    // ahead of every other queued row, including other suites' QUEUE_HEAD rows: only this backlog is measured
    for (const ctx of ctxs) await makeRecoverableNow(ctx, new Date('1999-01-01T00:00:00.000Z'))
    for (let run = 0; run < ctxs.length; run++) {
      const r = await b.pass3(1)
      expect([run, r.projectionsRecovered.map((p: any) => backlogIds.has(p.escrowId))]).toEqual([run, [true]])
    }
    for (const ctx of ctxs) await expectConverged(ctx)
  })
})
