// tests/integration/reconcilerOsProcess.test.ts
//
// Issue #253 - the residual limitation the independent audit named: recovery proven only inside ONE OS process.
// Here every reconciler is a separate OS process with no Redis fanout, killed abruptly (SIGKILL) at effect boundaries,
// against real PostgreSQL. The authoritative economic state is compared, for EVERY participant (buyer, each seller,
// each voucher), with what the seeds say it must be: trades, volume, fees, reputation, no extra transition, exactly
// the projections each kind of transition owes.
//
// Concurrency is PROVEN before any failure, not assumed: workers hold at file gates until the test has seen all of
// them at the same point, and "contention" is read from pg_stat_activity (a backend of one process waiting on a lock
// held by a backend of another) before the victim is allowed to die. Nothing here waits on a sleep to mean "by now".
//
// Notifications are at-least-once by design: a kill inside the claim transaction may repeat one, and must never
// repeat the effect it reports. Their count and values are therefore asserted separately (see Fixtures.verify()).
//
// LIMITS - see reconcilerProcessHarness.ts: MOCK escrows, no fund movement; this is the projection layer only.
// The pool sizes used in O5 are test parameters chosen to starve this code path, not a production recommendation.

import { PrismaClient } from '@prisma/client'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'
import { Fixtures, Sync, WorkerResult, blockedBy, expectCrossProcessAccounting, sleep, startWorker, waitUntil, AMOUNT_SATS } from './reconcilerProcessHarness'

describe('Issue #253 - independent OS-process reconcilers, Redis off, SIGKILL (real PostgreSQL)', () => {
  jest.setTimeout(420_000)

  const pg = createPostgresIntegrationHarness()
  const fx = new Fixtures()
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
  })

  beforeEach(() => { sync = new Sync() })
  afterEach(() => sync.cleanup())

  afterAll(async () => {
    if (dbAvailable) {
      // A killed worker can leave an Intent publication owed; pay it so no other suite inherits it.
      const { recoverUnpublishedIntentEvents } = require('../../src/core/intent-publication-recovery')
      expect((await recoverUnpublishedIntentEvents({ graceMs: 0 })).failed).toEqual([])
      await prisma.$disconnect()
      await closeTestRedis()
    }
  })

  const ids = (seeded: Array<{ escrowId: string }>) => seeded.map((s) => s.escrowId)
  const exited = (r: WorkerResult) => expect({ label: r.label, code: r.code, signal: r.signal }).toEqual({ label: r.label, code: 0, signal: null })
  const died = (r: WorkerResult) => expect({ label: r.label, killed: r.killed }).toEqual({ label: r.label, killed: true })
  const claimCount = (eventId: string, key: string) => prisma.eventProjectionClaim.count({ where: { eventId, projectionKey: key } })

  it('O1 two processes claim the SAME row at the same instant: the loser is provably blocked on the winner, and one exact economic state results', async () => {
    pg.requirePostgres('O1')
    const buyer = await fx.user()
    const seeded = await fx.seed(buyer.id, 12)
    // The first transition: PASS 3 serves them oldest first, so both processes reach it first.
    const row = seeded[0].transitionId
    const gates = [{ name: 'start', at: 'start' }, { name: 'rv', at: `trade.status:1:before:${row}` }, { name: 'hold', at: `trade.status:1:inside:${row}` }]
    const a = startWorker({ label: 'a', escrowIds: ids(seeded), sync, gates })
    const b = startWorker({ label: 'b', escrowIds: ids(seeded), sync, gates })

    // Both processes are loaded and alive at the starting line; only then does either begin.
    const [sa, sb] = await sync.allArrived('start', ['a', 'b'])
    expect(sa.pid).not.toBe(sb.pid)
    sync.release('start')

    // Both stand immediately before the same claim - the same projection of the same transition.
    const [ra, rb] = await sync.allArrived('rv', ['a', 'b'])
    expect({ key: ra.key, eventId: ra.eventId }).toEqual({ key: rb.key, eventId: rb.eventId })
    expect(ra.eventId).toBe(row)
    sync.release('rv')

    // The winner applies the effect and holds its claim transaction open; the loser must be waiting on it, in PostgreSQL.
    const holder = await waitUntil(async () => (await Promise.all(['a', 'b'].map(async (l) => (sync.arrival('hold', l) ? l : null)))).find(Boolean), 'one process holding the claim')
    const loser = holder === 'a' ? 'b' : 'a'
    expect(sync.arrival('hold', holder)!.eventId).toBe(ra.eventId)
    const via = await waitUntil(() => blockedBy(prisma, loser, holder), `process ${loser} blocked by ${holder} in pg_stat_activity`)
    process.stdout.write(`[evidence] ${JSON.stringify({ label: 'O1 contention', holder, loser, loserWaitsOn: via, sameRow: ra.eventId, key: ra.key })}\n`)
    expect(await claimCount(ra.eventId as string, ra.key as string)).toBe(0) // the winner has not committed: the loser really waits for an UNCOMMITTED claim
    sync.release('hold')

    const results = await Promise.all([a.done, b.done])
    for (const r of results) exited(r)
    await fx.verify(buyer.id, seeded, { label: 'O1' })
    // Every effect was applied by exactly one of the two processes (their own counters add up to the claims in the database).
    const applied = await expectCrossProcessAccounting(prisma, results, await fx.transitionIds(seeded))
    process.stdout.write(`[evidence] ${JSON.stringify({ label: 'O1 applied by the two processes together', applied })}\n`)
  })

  for (const victimAt of ['trade.completion-counters:1:inside', 'reputation.outcome:1:inside']) {
    it(`O2 a process dies holding an open effect transaction (${victimAt}) while another is blocked on it; the survivor and a restart converge exactly`, async () => {
      pg.requirePostgres(`O2 ${victimAt}`)
      const buyer = await fx.user()
      const seeded = await fx.seed(buyer.id, 12)
      const victim = startWorker({ label: 'v', escrowIds: ids(seeded), sync, killAt: victimAt, killGate: true })
      const survivor = startWorker({ label: 's', escrowIds: ids(seeded), sync, waitFor: ['v.kill.arrived'] })

      // The victim is inside the effect, transaction open. The survivor starts only now and must run into it.
      const [held] = await sync.allArrived('kill', ['v'])
      expect(await claimCount(held.eventId as string, held.key as string)).toBe(0)
      const via = await waitUntil(() => blockedBy(prisma, 's', 'v'), 'survivor blocked by the victim in pg_stat_activity')
      process.stdout.write(`[evidence] ${JSON.stringify({ label: `O2 contention before the kill (${victimAt})`, survivorWaitsOn: via, heldKey: held.key })}\n`)

      sync.release('kill', 'v')
      const [v, s] = await Promise.all([victim.done, survivor.done])
      died(v)
      exited(s)
      await fx.verify(buyer.id, seeded, { label: `O2 ${victimAt} after survivor`, maxRepeatedNotifications: 1 })

      const restart = await startWorker({ label: 'r', escrowIds: ids(seeded), sync }).done
      exited(restart)
      await fx.verify(buyer.id, seeded, { label: `O2 ${victimAt} after restart`, maxRepeatedNotifications: 1 })
    })
  }

  // What is durable at the instant of death decides what recovery has to do: an effect killed `inside` leaves no
  // claim and no effect; one killed `after` leaves both and only loses its acknowledgement. Read before releasing the kill.
  for (const [key, phase] of [['reputation.outcome', 'inside'], ['reputation.vouch-burn', 'inside'], ['trade.completion-counters', 'after'], ['fee-floor', 'after'], ['transition.projected', 'before']] as const) {
    it(`O3 sole process SIGKILLed at ${key}/${phase}: the state at death is the expected one, and a fresh process recovers the exact economic state`, async () => {
      pg.requirePostgres(`O3 ${key}`)
      const buyer = await fx.user()
      const seeded = await fx.seed(buyer.id, 3)
      const victim = startWorker({ label: 'v', escrowIds: ids(seeded), sync, killAt: `${key}:1:${phase}`, killGate: true })
      const [held] = await sync.allArrived('kill', ['v'])
      expect(held.key).toBe(key)
      const atDeath = await claimCount(held.eventId as string, key)
      process.stdout.write(`[evidence] ${JSON.stringify({ label: `O3 ${key}/${phase} state at death`, committedClaims: atDeath })}\n`)
      expect(atDeath).toBe(phase === 'after' ? 1 : 0)
      sync.release('kill', 'v')
      died(await victim.done)

      const fresh = await startWorker({ label: 'r', escrowIds: ids(seeded), sync }).done
      exited(fresh)
      await fx.verify(buyer.id, seeded, { label: `O3 ${key}/${phase}`, maxRepeatedNotifications: phase === 'inside' ? 1 : 0 })
    })
  }

  // O4: one disputed release has three participants (buyer, seller, a voucher of the seller). A kill after a
  // notification was published but before its claim committed must repeat THAT notification and no other, and every
  // notification must carry the score the database holds.
  it('O4 baseline: with no crash every participant is notified exactly once, with the persisted score', async () => {
    pg.requirePostgres('O4 baseline')
    const buyer = await fx.user()
    const seeded = await fx.seed(buyer.id, 1)
    exited(await startWorker({ label: 'r', escrowIds: ids(seeded), sync }).done)
    await fx.verify(buyer.id, seeded, { label: 'O4 baseline', maxRepeatedNotifications: 0 })
  })

  for (const [point, who] of [['reputation.outcome:1:inside', 'buyer'], ['reputation.outcome:2:inside', 'seller'], ['reputation.vouch-burn:1:inside', 'voucher'], ['trade.completed-notification:1:inside', 'completion']] as const) {
    it(`O4 a kill inside the ${who}'s notification window repeats that notification only, with an unchanged score`, async () => {
      pg.requirePostgres(`O4 ${who}`)
      const buyer = await fx.user()
      const seeded = await fx.seed(buyer.id, 1)
      const s = seeded[0]
      const victim = startWorker({ label: 'v', escrowIds: ids(seeded), sync, killAt: point, killGate: true })
      await sync.allArrived('kill', ['v'])

      // The window itself: the notification is already durable while the claim and the effect it reports are not.
      const participant = { buyer: buyer.id, seller: s.sellerId, voucher: s.voucherId!, completion: buyer.id }[who]
      const before = (await fx.scoreNotifications(participant)).length
      const inWindow = who === 'completion'
        ? Number((await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM durable_events WHERE "eventName" = 'openp2p.trade.completed' AND "correlationId" = ${s.tradeId}`)[0].n)
        : before
      expect(inWindow).toBe(1)
      const persistedAtDeath = (await prisma.user.findUnique({ where: { id: participant } }))!.reputationScore
      sync.release('kill', 'v')
      died(await victim.done)
      exited(await startWorker({ label: 'r', escrowIds: ids(seeded), sync }).done)

      await fx.verify(buyer.id, seeded, { label: `O4 ${who}`, maxRepeatedNotifications: 1 })
      // Every participant, with their persisted score; only the one killed in its window has a repeat, and the repeat reports the same score.
      const expectedCounts = { buyer: 1, seller: 1, voucher: 1 }
      for (const [role, userId] of [['buyer', buyer.id], ['seller', s.sellerId], ['voucher', s.voucherId!]] as const) {
        const list = await fx.scoreNotifications(userId)
        const persisted = (await prisma.user.findUnique({ where: { id: userId } }))!.reputationScore
        expect({ role, count: list.length }).toEqual({ role, count: expectedCounts[role] + (role === who ? 1 : 0) })
        expect(new Set(list.map((n) => n.newScore))).toEqual(new Set([persisted]))
      }
      if (who === 'buyer') expect(persistedAtDeath).toBe(0) // the +2 of the killed transaction was not visible at death
    })
  }

  // O5 - starvation of the connection pool. Objective conditions, none of them a time limit and none a production limit:
  //   SATURATED  a worker's own pool had every connection it may open open, none idle, and a caller queued
  //              (sampled by the worker from pg.Pool's totalCount/idleCount/waitingCount);
  //   TIMED OUT  Prisma abandoned a transaction because it could not get a connection (P2028 'Unable to start a transaction' / 'Transaction API error');
  //   SAFE       at no sampled instant did an economic counter exceed what the seeds allow (watched from the test, in parallel);
  //   RECOVERED  a healthy process then converges to the exact state.
  // A pool of 1 is the smallest pool on which this path MUST starve: an effect transaction holds the only connection
  // and publishes its notification through a second one. It is a test parameter, not a statement about production sizing.
  async function monitorBounds(buyerId: string, seeded: Array<{ kind: string }>, until: Promise<unknown>) {
    const maxTrades = seeded.filter((s) => s.kind !== 'REFUND_CLEAN').length
    let samples = 0
    let exceeded: string | null = null
    let stop = false
    until.then(() => { stop = true })
    while (!stop) {
      const u = (await prisma.user.findUnique({ where: { id: buyerId } }))!
      samples++
      if (u.totalTrades > maxTrades) exceeded = `totalTrades ${u.totalTrades} > ${maxTrades}`
      if (BigInt(u.totalVolumeBtc.mul(1e8).toFixed(0)) > AMOUNT_SATS * BigInt(maxTrades)) exceeded = `volume ${u.totalVolumeBtc}`
      if (u.reputationScore > seeded.filter((s) => s.kind === 'RELEASE_RULED').length * 2) exceeded = `reputation ${u.reputationScore}`
      await sleep(100)
    }
    return { samples, exceeded }
  }

  for (const [poolMax, n, deadlineMs, mustStall] of [[1, 6, 15_000, true], [2, 15, 20_000, false]] as const) {
    it(`O5 a pool of ${poolMax} connection(s) is saturated and times out, never doubles an effect, and a healthy process then converges exactly`, async () => {
      pg.requirePostgres(`O5 pool ${poolMax}`)
      const buyer = await fx.user()
      const seeded = await fx.seed(buyer.id, n)
      const starved = [0, 1].map((i) => startWorker({ label: `p${i}`, escrowIds: ids(seeded), sync, poolMax, deadlineMs, gates: [{ name: 'start', at: 'start' }] }))
      await sync.allArrived('start', ['p0', 'p1'])
      sync.release('start')
      const watching = monitorBounds(buyer.id, seeded, Promise.all(starved.map((w) => w.done)))
      const results = await Promise.all(starved.map((w) => w.done))
      const watched = await watching

      const report = results.map((r) => ({ label: r.label, outcome: r.code === 0 ? 'CONVERGED' : r.code === 3 ? 'STALLED_AT_DEADLINE' : `OTHER(${r.code})`, pool: r.stats?.pool, txTimeouts: r.txTimeouts, effectFailures: r.stats?.effectFailures }))
      process.stdout.write(`[evidence] ${JSON.stringify({ label: `O5 pool ${poolMax}`, report, watchedSamples: watched.samples, exceeded: watched.exceeded })}\n`)

      // The constraint was real: no pool ever grew past its cap, and at least one was observed saturated.
      for (const r of results) {
        expect(r.stderr).toContain(`POOL_MAX_APPLIED ${poolMax}`)
        expect(r.stats!.pool.peakTotal).toBeLessThanOrEqual(poolMax)
        expect([0, 3]).toContain(r.code) // converged, or stopped by its own deadline - never a crash
      }
      expect(results.reduce((n2, r) => n2 + r.stats!.pool.saturatedSamples, 0)).toBeGreaterThan(0)
      expect(watched.exceeded).toBeNull()
      if (mustStall) {
        // On a pool of 1 the path cannot complete: every starved worker stalls, with a timed-out transaction on record.
        for (const r of results) expect(r.code).toBe(3)
        expect(results.reduce((n2, r) => n2 + r.txTimeouts + (r.stats!.effectFailures), 0)).toBeGreaterThan(0)
      }

      const startedAt = Date.now()
      const healthy = await startWorker({ label: 'h', escrowIds: ids(seeded), sync }).done
      exited(healthy)
      process.stdout.write(`[evidence] ${JSON.stringify({ label: `O5 pool ${poolMax} recovery`, healthyProcessToConvergeMs: Date.now() - startedAt })}\n`)
      await fx.verify(buyer.id, seeded, { label: `O5 pool ${poolMax} recovered`, maxRepeatedNotifications: results.reduce((n2, r) => n2 + (r.stats?.effectFailures ?? 0), 0) })
    })
  }
})
