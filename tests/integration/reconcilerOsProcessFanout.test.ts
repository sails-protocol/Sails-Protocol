// tests/integration/reconcilerOsProcessFanout.test.ts
//
// Issue #253 - what reconcilerOsProcess.test.ts leaves out on purpose: (1) the production cross-instance fanout
// ENABLED (Redis pub/sub between instances, as app.ts wires it) and then failing, and (2) the race between the
// live publication of a transition and the reconciler republishing it.
//
// Every process here is a separate OS process. Redis is the real server, reached through a relay (RedisProxy) that
// lets the test cut it away from the workers at a chosen instant. Redis is never trusted for the outcome: a signal
// lost to Redis must cost nothing, because the durable event and the claims are in PostgreSQL.
//
// LIMITS - see reconcilerProcessHarness.ts: MOCK escrows, no fund movement; the projection layer only. "Redis fails"
// here means: every connection the workers hold to it is dropped and new ones are refused, then (O6b) it comes back.
// It does not cover a half-open TCP connection, a Redis that answers slowly, or a Redis restart that loses its state.

import { PrismaClient } from '@prisma/client'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'
import { Fixtures, RedisProxy, Sync, WorkerResult, blockedBy, channelSubscribers, expectCrossProcessAccounting, startWorker, waitUntil } from './reconcilerProcessHarness'

describe('Issue #253 - cross-instance fanout enabled and failing; live publication racing the reconciler (real PostgreSQL, real Redis)', () => {
  jest.setTimeout(300_000)

  const pg = createPostgresIntegrationHarness()
  const fx = new Fixtures()
  const proxy = new RedisProxy()
  let dbAvailable = false
  let prisma: PrismaClient
  let sync: Sync

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'true'
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    fx.init()
    prisma = fx.prisma
    await proxy.start()
  })

  beforeEach(() => { sync = new Sync() })
  afterEach(() => sync.cleanup())

  afterAll(async () => {
    if (dbAvailable) {
      await proxy.stop()
      const { recoverUnpublishedIntentEvents } = require('../../src/core/intent-publication-recovery')
      expect((await recoverUnpublishedIntentEvents({ graceMs: 0 })).failed).toEqual([])
      await prisma.$disconnect()
      await closeTestRedis()
    }
  })

  const ids = (seeded: Array<{ escrowId: string }>) => seeded.map((s) => s.escrowId)
  const exited = (r: WorkerResult) => expect({ label: r.label, code: r.code, signal: r.signal }).toEqual({ label: r.label, code: 0, signal: null })
  const sum = (rs: WorkerResult[], pick: (r: WorkerResult) => number) => rs.reduce((n, r) => n + pick(r), 0)

  it('O6a fanout enabled on two processes and healthy: every transition reaches both through three channels (own publish, Redis, reconciler) and is applied exactly once', async () => {
    pg.requirePostgres('O6a')
    const buyer = await fx.user()
    const seeded = await fx.seed(buyer.id, 12)
    const row = seeded[0].transitionId
    const gates = [{ name: 'start', at: 'start' }, { name: 'rv', at: `trade.status:1:before:${row}` }]
    const opts = { escrowIds: ids(seeded), sync, gates, fanout: true, redisUrl: proxy.url }
    const publishedBefore = proxy.stats.publish
    const baseline = await channelSubscribers()
    const a = startWorker({ label: 'a', ...opts })
    const b = startWorker({ label: 'b', ...opts })

    await sync.allArrived('start', ['a', 'b'])
    // The fanout is genuinely on: both processes are subscribed to the production channel, as Redis itself reports.
    await waitUntil(async () => ((await channelSubscribers()) >= baseline + 2 ? true : false), 'two more subscribers on the cross-instance channel')
    const subscribers = (await channelSubscribers()) - baseline
    expect(subscribers).toBe(2)
    sync.release('start')
    const [ra, rb] = await sync.allArrived('rv', ['a', 'b'])
    expect(ra.eventId).toBe(rb.eventId)
    sync.release('rv')

    const results = await Promise.all([a.done, b.done])
    for (const r of results) exited(r)
    await fx.verify(buyer.id, seeded, { label: 'O6a' })
    await expectCrossProcessAccounting(prisma, results, await fx.transitionIds(seeded))

    const evidence = { subscribers, publishedToRedis: sum(results, (r) => r.stats!.fanoutPublished), receivedFromRedis: sum(results, (r) => r.stats!.fanoutReceived), publishCommandsThroughRelay: proxy.stats.publish - publishedBefore, subscribeCommandsThroughRelay: proxy.stats.subscribe }
    process.stdout.write(`[evidence] ${JSON.stringify({ label: 'O6a fanout traffic', ...evidence })}\n`)
    expect(evidence.publishedToRedis).toBeGreaterThan(0)
    expect(evidence.receivedFromRedis).toBeGreaterThan(0) // the other instance's handlers really ran from Redis, not only from their own publish
    expect(evidence.publishCommandsThroughRelay).toBeGreaterThan(0)
  })

  it('O6b Redis is cut away while a process holds an open effect transaction and fanout is on: the signal is lost, the state is not, and a restart with Redis back converges exactly', async () => {
    pg.requirePostgres('O6b')
    const buyer = await fx.user()
    const seeded = await fx.seed(buyer.id, 12)
    const common = { escrowIds: ids(seeded), sync, fanout: true, redisUrl: proxy.url }
    const victim = startWorker({ label: 'v', ...common, gates: [{ name: 'start', at: 'start' }], killAt: 'reputation.outcome:1:inside', killGate: true })
    const survivor = startWorker({ label: 's', ...common, waitFor: ['v.kill.arrived'] })

    const baseline = await channelSubscribers()
    await sync.allArrived('start', ['v'])
    await waitUntil(async () => ((await channelSubscribers()) >= baseline + 2 ? true : false), 'victim and survivor both subscribed')
    sync.release('start')

    // The victim is inside an effect with its transaction open (its notification already published) and the survivor is contending for it.
    await sync.allArrived('kill', ['v'])
    const via = await waitUntil(() => blockedBy(prisma, 's', 'v'), 'survivor blocked by the victim')

    // Redis goes away NOW: Redis itself must report no subscriber left before the victim is allowed to die.
    await proxy.stop()
    await waitUntil(async () => ((await channelSubscribers()) === baseline ? true : false), 'no worker subscriber left on the channel after the cut')
    process.stdout.write(`[evidence] ${JSON.stringify({ label: 'O6b state at the cut', survivorWaitsOn: via, workerSubscribersAfterCut: 0 })}\n`)
    sync.release('kill', 'v')

    const [v, s] = await Promise.all([victim.done, survivor.done])
    expect({ killed: v.killed }).toEqual({ killed: true })
    exited(s) // an unreachable Redis must not take a process down
    const failed = s.stats!.fanoutPublishFailed
    process.stdout.write(`[evidence] ${JSON.stringify({ label: 'O6b survivor with Redis down', converged: true, fanoutPublished: s.stats!.fanoutPublished, fanoutPublishFailed: failed, fanoutReceived: s.stats!.fanoutReceived })}\n`)
    expect(failed).toBeGreaterThan(0) // the failure path was actually exercised, not merely possible
    await fx.verify(buyer.id, seeded, { label: 'O6b with Redis down', maxRepeatedNotifications: 1 })

    // Redis returns; a fresh process with fanout on converges and changes nothing.
    await proxy.start()
    const restart = startWorker({ label: 'r', ...common })
    const r = await restart.done
    exited(r)
    await fx.verify(buyer.id, seeded, { label: 'O6b after Redis came back', maxRepeatedNotifications: 1 })
  })

  it('O7 the live publication and the reconciler publish the same freshly claimed transition at the same instant: two durable events, one economic effect', async () => {
    pg.requirePostgres('O7')
    const buyer = await fx.user()
    const seeded = await fx.seed(buyer.id, 6, () => 'unclaimed')
    // p runs the real emitEscrowTransition() for every escrow and stops just before it publishes the first one;
    // r (the reconciler) is started only once that first claim is committed, and also stops just before publishing it.
    const live = startWorker({ label: 'p', escrowIds: ids(seeded), sync, livePublish: seeded.map((s) => s.live), gates: [{ name: 'pub', at: 'publish:1' }] })
    const [held] = await sync.allArrived('pub', ['p'])
    const transitionId = held.transitionId as string
    expect(transitionId).toBeTruthy()
    // PASS 3 is database-wide: r is told which transition to wait on, so rows left by any other test cannot stand in for it.
    const recon = startWorker({ label: 'r', escrowIds: ids(seeded), sync, gates: [{ name: 'pub', at: `publish:1:${transitionId}` }] })
    const [, other] = await sync.allArrived('pub', ['p', 'r'])
    expect(other.transitionId).toBe(transitionId)
    // Claimed in PostgreSQL, published nowhere: this is the window, and both are in it.
    const publishedBefore = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM durable_events WHERE payload->>'transitionId' = ${transitionId}`
    expect(Number(publishedBefore[0].n)).toBe(0)
    expect(await prisma.eventProjectionClaim.count({ where: { eventId: transitionId, projectionKey: 'transition.claimed' } })).toBe(1)
    sync.release('pub')

    const results = await Promise.all([live.done, recon.done])
    for (const r of results) exited(r)
    const events = await prisma.$queryRaw<Array<{ tid: string; n: bigint }>>`SELECT payload->>'transitionId' AS tid, count(*) AS n FROM durable_events WHERE payload->>'transitionId' = ANY(${await fx.transitionIds(seeded)}) GROUP BY 1`
    const perTransition = Object.fromEntries(events.map((e) => [e.tid, Number(e.n)]))
    process.stdout.write(`[evidence] ${JSON.stringify({ label: 'O7 durable events per transition', raced: transitionId, perTransition })}\n`)
    expect(perTransition[transitionId]).toBe(2) // both publications were minted - the design keeps both for traceability
    for (const n of Object.values(perTransition)) expect(n).toBeGreaterThanOrEqual(1)
    expect(Object.keys(perTransition)).toHaveLength(seeded.length)
    await fx.verify(buyer.id, seeded, { label: 'O7' })
  })
})
