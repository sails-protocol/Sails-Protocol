// tests/integration/transitionPublishAuthority.test.ts
//
// One semantic escrow transition must be published as at most ONE durable event, whichever path
// publishes it: the live path (emitEscrowTransition(), after it wins the transition claim) or settlement
// reconciliation PASS 3 (a claimed transition whose projections never completed). Projection idempotency is
// keyed on the durable event id, so a second durable event for the same transition would apply every
// downstream effect (completion counters, reputation, fee floor, vouch burns) a second time.
//
// Guarantee under test: ONE canonical durable event per transition + at-least-once (re)delivery +
// projections idempotent per event. Not "exactly once" end to end: handlers may receive the same event
// more than once, and the projection claims make the repeat a no-op.
//
// Real PostgreSQL. Interleavings are forced with barriers, never with timing: a publisher is held
// between its committed transition claim (or its existence check) and its publish.
//
// A "node" is an independent module graph (jest.isolateModules): its own event bus, handlers and
// module-level state. The PrismaClient is shared across module graphs (src/common/database caches it on
// global.__prisma outside production; Prisma 7 cannot run two clients in one jest worker), so nodes share
// one pool, each statement on its own pooled connection. The authority itself lives in PostgreSQL (the
// publishing correlationId's advisory lock + the transitionId unique index), not in any process, so what
// separate pools would add is connection isolation, which the pool already gives per statement.

import { PrismaClient } from '@prisma/client'
import { randomBytes, randomUUID } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { boundOfferInput, sellerPixAccount } from './economicFixtures'
import { closeTestRedis } from './identityTestHelpers'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
// PASS 3 claims from a round-robin queue shared with other suites' rows; a marker claimed at QUEUE_HEAD
// is ahead of all of them (PASS 3's order and fairness are proven in projectionRecoveryQueue.test.ts).
const QUEUE_HEAD = new Date('2000-01-01T00:00:00.000Z')

interface Deferred { promise: Promise<void>; resolve: () => void }
function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

type Report = { requiresManualReview: any[]; failed: any[]; projectionsRecovered: Array<{ escrowId: string; transitionId: string; action: string }> }
const newReport = (): any => ({ requiresManualReview: [], failed: [], projectionsRecovered: [] })

describe('Transition publish authority: one semantic transition, one durable event (real PostgreSQL)', () => {
  jest.setTimeout(120_000)

  const pg = createPostgresIntegrationHarness()
  let prisma: PrismaClient
  let eventBus: typeof import('../../src/common/events/event-bus').eventBus
  let emitEscrowTransition: typeof import('../../src/modules/open-settlement/escrow-lifecycle').emitEscrowTransition
  let reconcileIncompleteProjections: typeof import('../../src/modules/open-settlement/escrow-settlement-reconciliation.service').reconcileIncompleteProjections
  let PostgresEventStore: typeof import('../../src/common/events/event-store').PostgresEventStore
  let getTimeline: typeof import('../../src/core/timeline').getTimeline
  let liquidityRouter: typeof import('../../src/modules/open-liquidity/liquidity.service').liquidityRouter
  let tradeService: typeof import('../../src/modules/open-p2p/trade.service').tradeService
  const nodes: Node[] = []

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'true'
    await pg.probe()
    if (!pg.isAvailable()) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ eventBus } = require('../../src/common/events/event-bus'))
    ;({ emitEscrowTransition } = require('../../src/modules/open-settlement/escrow-lifecycle'))
    ;({ reconcileIncompleteProjections } = require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service'))
    ;({ PostgresEventStore } = require('../../src/common/events/event-store'))
    ;({ getTimeline } = require('../../src/core/timeline'))
    ;({ liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service'))
    ;({ tradeService } = require('../../src/modules/open-p2p/trade.service'))
    const { intentEngine } = require('../../src/core/intent-engine')
    const { OpenP2PTradeIntentHandler } = require('../../src/modules/open-p2p/intent-handler')
    intentEngine.registerHandler(OpenP2PTradeIntentHandler)
    require('../../src/common/events/handlers').registerEventHandlers()
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
    eventBus: typeof eventBus
    projection: any
    emitEscrowTransition: typeof emitEscrowTransition
    recover: (opts?: { limit?: number }) => Promise<Report>
    shutdown: () => Promise<void>
  }

  /** Another application instance (or this one after a restart). `handlers: false` = it dies before its handlers run. */
  function startNode({ handlers = true } = {}): Node {
    let node!: Node
    jest.isolateModules(() => {
      const redisModule = require('../../src/common/redis')
      if (handlers) {
        const { intentEngine } = require('../../src/core/intent-engine')
        intentEngine.registerHandler(require('../../src/modules/open-p2p/intent-handler').OpenP2PTradeIntentHandler)
        require('../../src/common/events/handlers').registerEventHandlers()
      }
      const recon = require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service')
      node = {
        eventBus: require('../../src/common/events/event-bus').eventBus,
        projection: require('../../src/common/events/event-projection'),
        emitEscrowTransition: require('../../src/modules/open-settlement/escrow-lifecycle').emitEscrowTransition,
        recover: async (opts = {}) => { const r = newReport(); await recon.reconcileIncompleteProjections(r, 0, opts); return r },
        shutdown: async () => { await redisModule.redis?.quit?.().catch(() => undefined) },
      }
    })
    nodes.push(node)
    return node
  }

  // ─── fixtures ─────────────────────────────────────────────────────────────────────────────────────────

  async function makeCompletedEscrow() {
    const seller = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
    const buyer = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', ...boundOfferInput(await sellerPixAccount(prisma, seller.id)) })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    const escrow = await prisma.escrow.create({ data: { tradeId: trade.id, type: 'MOCK', status: 'COMPLETED', lockedAmount: '0.001', asset: 'BTC' } })
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id, status: 'ACTIVE' } })
    return { tradeId: trade.id, escrowId: escrow.id, sellerId: seller.id, buyerId: buyer.id }
  }
  type Ctx = Awaited<ReturnType<typeof makeCompletedEscrow>>

  /** The real live path for a release: emitEscrowTransition() claims the transition, then publishes. */
  const liveRelease = (ctx: Ctx, emit = emitEscrowTransition) =>
    emit(ctx.escrowId, ctx.tradeId, 'PAYMENT_PENDING', 'COMPLETED', ctx.sellerId, 'settlement.escrow.released', { txId: `tx-${ctx.escrowId}` })

  /**
   * Holds the next publish of `ctx`'s release on `bus`, via `method` ('emit' = the live path, the first
   * thing emitEscrowTransition() does after its claim commits; 'publish' = PASS 3, right after its
   * existence check). `fail` makes the held publish die instead of resuming (a crash).
   */
  function holdPublish(bus: typeof eventBus, method: 'emit' | 'publish', ctx: Ctx) {
    const reached = deferred(); const release = deferred()
    let fail = false
    const real = (bus as any)[method].bind(bus)
    let held = false
    jest.spyOn(bus as any, method).mockImplementation(async (name: any, payload: any, correlationId: any) => {
      if (!held && name === 'settlement.escrow.released' && payload?.escrowId === ctx.escrowId) {
        held = true
        reached.resolve()
        await release.promise
        if (fail) throw new Error('process died before publishing')
      }
      return real(name, payload, correlationId)
    })
    return { reached: reached.promise, release: release.resolve, crash: () => { fail = true; release.resolve() } }
  }

  const transitionOf = async (ctx: Ctx) => (await prisma.escrowEvent.findFirst({ where: { escrowId: ctx.escrowId, toStatus: 'COMPLETED' } }))!
  const durableEventsFor = (transitionId: string) =>
    prisma.$queryRaw<Array<{ id: string }>>`SELECT id FROM durable_events WHERE payload->>'transitionId' = ${transitionId} ORDER BY "publishedAt"`
  /** Makes the claimed transition eligible for PASS 3 now (the test-safe equivalent of its grace period passing), at the queue head. */
  const makeRecoverableNow = (transitionId: string) =>
    prisma.eventProjectionClaim.updateMany({ where: { eventId: transitionId, projectionKey: 'transition.claimed' }, data: { appliedAt: QUEUE_HEAD } })
  const projectedCount = (transitionId: string) => prisma.eventProjectionClaim.count({ where: { projectionKey: 'transition.projected', subjectId: transitionId } })
  const actionsFor = (reports: Report[], transitionId: string) => reports.flatMap((r) => r.projectionsRecovered).filter((p) => p.transitionId === transitionId).map((p) => p.action)

  async function waitFor(cond: () => Promise<boolean>, ms = 15_000): Promise<void> {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await cond()) return
      await sleep(50)
    }
    throw new Error('timed out waiting for condition')
  }

  /** ONE canonical durable event, and every downstream effect of the release applied exactly once. */
  async function expectOneEventEffectsOnce(ctx: Ctx, transitionId: string): Promise<string> {
    await waitFor(async () => (await projectedCount(transitionId)) > 0)
    await sleep(800) // let any handler a second delivery would trigger finish
    const events = await durableEventsFor(transitionId)
    expect(events).toHaveLength(1)
    const [eventId] = events.map((e) => e.id)
    expect(await projectedCount(transitionId)).toBe(1)
    for (const key of ['trade.status', 'trade.completion-counters', 'fee-floor', 'trade.completed-notification']) {
      expect([key, await prisma.eventProjectionClaim.count({ where: { eventId, projectionKey: key } })]).toEqual([key, 1])
    }
    expect(await prisma.eventProjectionClaim.count({ where: { eventId, projectionKey: 'reputation.outcome' } })).toBe(2) // one per party
    const [buyer, seller] = await Promise.all([prisma.user.findUnique({ where: { id: ctx.buyerId } }), prisma.user.findUnique({ where: { id: ctx.sellerId } })])
    expect([buyer!.totalTrades, seller!.totalTrades, buyer!.reputationScore, seller!.reputationScore]).toEqual([1, 1, 2, 2])
    expect((await getTimeline(ctx.tradeId).verifyChain()).valid).toBe(true)
    return eventId
  }

  // ═══ structure ═══════════════════════════════════════════════════════════════════════════════════════

  it('the transition identity is unique in PostgreSQL itself: a partial unique index on payload.transitionId, events without one unaffected', async () => {
    pg.requirePostgres('index catalog')
    const [index] = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'durable_events' AND indexname = 'durable_events_transition_id_key'`
    expect(index.indexdef).toMatch(/CREATE UNIQUE INDEX/)
    expect(index.indexdef).toMatch(/\(payload ->> 'transitionId'::text\)/)
    expect(index.indexdef).toMatch(/WHERE \(\(payload ->> 'transitionId'::text\) IS NOT NULL\)/)
  })

  it('BACKSTOP: a publisher whose existence check misses (it does not share the correlation lock) is stopped by the unique index - no second event, nothing dispatched, the existing event returned', async () => {
    pg.requirePostgres('unique index backstop')
    const ctx = await makeCompletedEscrow()
    await liveRelease(ctx)
    const transition = await transitionOf(ctx)
    const eventId = await expectOneEventEffectsOnce(ctx, transition.id)

    // a store whose publish transaction's existence check sees nothing: the only thing left to stop it is
    // the index (its later lookup of the existing event, in a transaction of its own, sees normally)
    let transactions = 0
    const blindClient = {
      durableEventRecord: prisma.durableEventRecord,
      $transaction: (fn: any, opts?: any) => {
        if (typeof fn !== 'function' || ++transactions > 1) return (prisma as any).$transaction(fn, opts)
        return prisma.$transaction((tx: any) => fn(new Proxy(tx, {
          get: (t, k) => (k === '$queryRaw' ? async (strings: TemplateStringsArray, ...v: unknown[]) => (strings.join('').includes("payload->>'transitionId'") ? [] : t.$queryRaw(strings, ...v)) : t[k]),
        })), opts)
      },
    }
    const blindStore = new PostgresEventStore(blindClient as any)
    const dispatched = jest.fn()
    blindStore.subscribe('settlement.escrow.released', dispatched)
    const outcome = await blindStore.publish('settlement.escrow.released', {
      escrowId: ctx.escrowId, tradeId: ctx.tradeId, from: 'PAYMENT_PENDING', to: 'COMPLETED', triggeredBy: ctx.sellerId, transitionId: transition.id,
    }, `another-correlation-${randomUUID()}`)
    expect(outcome).toEqual({ eventId, minted: false })
    expect(dispatched).not.toHaveBeenCalled()
    expect(await durableEventsFor(transition.id)).toEqual([{ id: eventId }])
  })

  it('events that carry no transitionId are NOT deduplicated: two identical non-transition publishes are two events', async () => {
    pg.requirePostgres('no suppression of distinct events')
    const correlationId = `publish-authority-${randomUUID()}`
    const payload = { escrowId: 'e', tradeId: correlationId, type: 'MOCK', lockedAmount: '1', asset: 'BTC' }
    const a = await eventBus.publish('settlement.escrow.created', payload, correlationId)
    const b = await eventBus.publish('settlement.escrow.created', payload, correlationId)
    expect([a && a.minted, b && b.minted]).toEqual([true, true])
    expect(a && b && a.eventId !== b.eventId).toBe(true)
    expect(await prisma.durableEventRecord.count({ where: { correlationId } })).toBe(2)
    expect((await getTimeline(correlationId).verifyChain()).valid).toBe(true)
  })

  // ═══ A–B: one publisher ══════════════════════════════════════════════════════════════════════════════

  it('A. live publish only: one event, effects once; PASS 3 then has nothing to publish', async () => {
    pg.requirePostgres('A')
    const ctx = await makeCompletedEscrow()
    expect(await liveRelease(ctx)).toBe(true)
    const transition = await transitionOf(ctx)
    await expectOneEventEffectsOnce(ctx, transition.id)
    const r = newReport()
    await reconcileIncompleteProjections(r, 0)
    expect(actionsFor([r], transition.id)).toEqual([]) // projected: out of the queue
  })

  it('B/J/L. crash after the claim, before publishing; a restarted node\'s PASS 3 publishes it: one event, effects once', async () => {
    pg.requirePostgres('B/J/L')
    const ctx = await makeCompletedEscrow()
    const hold = holdPublish(eventBus, 'emit', ctx)
    const live = liveRelease(ctx)
    await hold.reached
    hold.crash()
    await expect(live).rejects.toThrow('process died before publishing')
    const transition = await transitionOf(ctx)
    expect(await durableEventsFor(transition.id)).toHaveLength(0) // claimed, never published: no lock or claim left owning it

    await makeRecoverableNow(transition.id)
    const restarted = startNode()
    const r = await restarted.recover()
    expect(actionsFor([r], transition.id)).toEqual(['REPUBLISHED'])
    await expectOneEventEffectsOnce(ctx, transition.id)
  })

  // ═══ C–E: live × PASS 3 ══════════════════════════════════════════════════════════════════════════════

  it('C/D. live publisher held after its claim; PASS 3 publishes meanwhile; the live publisher resumes: one event, effects once', async () => {
    pg.requirePostgres('C/D')
    const ctx = await makeCompletedEscrow()
    const hold = holdPublish(eventBus, 'emit', ctx)
    const live = liveRelease(ctx)
    await hold.reached // the transition is durably claimed; nothing is published yet
    const transition = await transitionOf(ctx)
    expect(await prisma.eventProjectionClaim.count({ where: { eventId: transition.id, projectionKey: 'transition.claimed' } })).toBe(1)
    expect(await durableEventsFor(transition.id)).toHaveLength(0)

    await makeRecoverableNow(transition.id)
    const r = newReport()
    await reconcileIncompleteProjections(r, 0)
    expect(actionsFor([r], transition.id)).toEqual(['REPUBLISHED']) // PASS 3 sees it as recoverable and wins
    const [pass3Event] = await durableEventsFor(transition.id)
    await waitFor(async () => (await projectedCount(transition.id)) > 0)

    hold.release()
    expect(await live).toBe(true) // the resumed live publisher completes normally, minting nothing
    expect(await expectOneEventEffectsOnce(ctx, transition.id)).toBe(pass3Event.id)
  })

  it('E. live publishes first, PASS 3 already past its own existence check: the store hands PASS 3 the live event, PASS 3 redelivers it: one event, effects once', async () => {
    pg.requirePostgres('E')
    const ctx = await makeCompletedEscrow()
    // PASS 3 must see the transition unpublished: hold the live publisher until PASS 3 has checked
    const liveHold = holdPublish(eventBus, 'emit', ctx)
    const live = liveRelease(ctx)
    await liveHold.reached
    const transition = await transitionOf(ctx)
    await makeRecoverableNow(transition.id)

    const worker = startNode()
    const pass3Hold = holdPublish(worker.eventBus, 'publish', ctx) // PASS 3: after its check, before its publish
    const recovering = worker.recover()
    await pass3Hold.reached
    liveHold.release()
    expect(await live).toBe(true) // the live event is published first
    const [liveEvent] = await durableEventsFor(transition.id)
    pass3Hold.release()
    const r = await recovering
    expect(actionsFor([r], transition.id)).toEqual(['REDELIVERED'])
    expect(await expectOneEventEffectsOnce(ctx, transition.id)).toBe(liveEvent.id)
  })

  // ═══ F–I: more publishers ════════════════════════════════════════════════════════════════════════════

  it('F. two live publishers for the same transition: the transition claim admits one, the other returns without publishing (even while the first is held)', async () => {
    pg.requirePostgres('F')
    const ctx = await makeCompletedEscrow()
    const hold = holdPublish(eventBus, 'emit', ctx)
    const first = liveRelease(ctx)
    await hold.reached
    const other = startNode()
    expect(await liveRelease(ctx, other.emitEscrowTransition)).toBe(false) // on another node, while the first is held
    hold.release()
    expect(await first).toBe(true)
    const transition = await transitionOf(ctx)
    await expectOneEventEffectsOnce(ctx, transition.id)
  })

  it('G. two PASS 3 workers on two nodes re-driving the same unpublished transition at the same moment: one publishes, the other redelivers', async () => {
    pg.requirePostgres('G')
    const ctx = await makeCompletedEscrow()
    const hold = holdPublish(eventBus, 'emit', ctx)
    const live = liveRelease(ctx)
    await hold.reached
    hold.crash()
    await expect(live).rejects.toThrow()
    const transition = await transitionOf(ctx)
    const row = (await prisma.eventProjectionClaim.findFirst({ where: { eventId: transition.id, projectionKey: 'transition.claimed' } }))!
    const batch = [{ id: row.id, eventId: transition.id, subjectId: ctx.escrowId }]
    const [a, b] = [startNode(), startNode()]
    for (const n of [a, b]) jest.spyOn(n.projection, 'claimTransitionRecoveryBatch').mockResolvedValueOnce(batch) // both hold it

    const reports = await Promise.all([a.recover(), b.recover()])
    expect(actionsFor(reports, transition.id).sort()).toEqual(['REDELIVERED', 'REPUBLISHED'])
    await expectOneEventEffectsOnce(ctx, transition.id)
  })

  it('H. live publisher held + two PASS 3 workers on two nodes; then the live publisher resumes: one event, effects once', async () => {
    pg.requirePostgres('H')
    const ctx = await makeCompletedEscrow()
    const hold = holdPublish(eventBus, 'emit', ctx)
    const live = liveRelease(ctx)
    await hold.reached
    const transition = await transitionOf(ctx)
    const row = (await prisma.eventProjectionClaim.findFirst({ where: { eventId: transition.id, projectionKey: 'transition.claimed' } }))!
    const batch = [{ id: row.id, eventId: transition.id, subjectId: ctx.escrowId }]
    const [a, b] = [startNode(), startNode()]
    for (const n of [a, b]) jest.spyOn(n.projection, 'claimTransitionRecoveryBatch').mockResolvedValueOnce(batch)

    const reports = await Promise.all([a.recover(), b.recover()])
    expect(actionsFor(reports, transition.id).sort()).toEqual(['REDELIVERED', 'REPUBLISHED'])
    hold.release()
    expect(await live).toBe(true)
    await expectOneEventEffectsOnce(ctx, transition.id)
  })

  it('I. stale live worker: held across a full recovery on another node (published AND projected there), then resumes: mints nothing, applies nothing', async () => {
    pg.requirePostgres('I')
    const ctx = await makeCompletedEscrow()
    const hold = holdPublish(eventBus, 'emit', ctx)
    const live = liveRelease(ctx)
    await hold.reached
    const transition = await transitionOf(ctx)
    await makeRecoverableNow(transition.id)
    const other = startNode()
    expect(actionsFor([await other.recover()], transition.id)).toEqual(['REPUBLISHED'])
    const eventId = await expectOneEventEffectsOnce(ctx, transition.id) // fully converged before the stale worker resumes

    hold.release()
    expect(await live).toBe(true)
    expect(await expectOneEventEffectsOnce(ctx, transition.id)).toBe(eventId)
  })

  // ═══ K, M, N: published but not projected, redelivery, repeats ═══════════════════════════════════════

  it('K/M. crash after publishing, before any projection (a node with no handlers): the next PASS 3 visit REDELIVERS that same event', async () => {
    pg.requirePostgres('K/M')
    const ctx = await makeCompletedEscrow()
    const dead = startNode({ handlers: false })
    expect(await liveRelease(ctx, dead.emitEscrowTransition)).toBe(true)
    const transition = await transitionOf(ctx)
    const [event] = await durableEventsFor(transition.id)
    await sleep(300)
    expect(await projectedCount(transition.id)).toBe(0)

    await makeRecoverableNow(transition.id)
    const r = newReport()
    await reconcileIncompleteProjections(r, 0)
    expect(actionsFor([r], transition.id)).toEqual(['REDELIVERED'])
    expect(await expectOneEventEffectsOnce(ctx, transition.id)).toBe(event.id)
  })

  it('N. repeats after convergence - the live path again, PASS 3 again, a direct publish of the same transition - mint nothing and apply nothing', async () => {
    pg.requirePostgres('N')
    const ctx = await makeCompletedEscrow()
    await liveRelease(ctx)
    const transition = await transitionOf(ctx)
    const eventId = await expectOneEventEffectsOnce(ctx, transition.id)

    expect(await liveRelease(ctx)).toBe(false)
    const r = newReport()
    await reconcileIncompleteProjections(r, 0)
    expect(actionsFor([r], transition.id)).toEqual([])
    const outcome = await eventBus.publish('settlement.escrow.released', {
      escrowId: ctx.escrowId, tradeId: ctx.tradeId, from: 'PAYMENT_PENDING', to: 'COMPLETED', triggeredBy: ctx.sellerId, transitionId: transition.id,
    }, ctx.tradeId)
    expect(outcome).toEqual({ eventId, minted: false })
    expect(await expectOneEventEffectsOnce(ctx, transition.id)).toBe(eventId)
  })
})
