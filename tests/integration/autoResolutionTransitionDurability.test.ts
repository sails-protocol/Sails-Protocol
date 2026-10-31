// tests/integration/autoResolutionTransitionDurability.test.ts
//
// #308 / D-308 — real-PostgreSQL proof of the properties that a green mock cannot show:
//   * the AUTO_PROPOSED -> EVIDENCE_SUBMITTED claim is decided by the DATABASE clock, with contest valid at the exact
//     deadline instant and the sweep only after it;
//   * a stale observation of proposal A can never apply its transition to a later proposal B (generation / ABA);
//   * a human decision that commits first always prevails;
//   * the transition event is recoverable: a REAL process kill after the claim and before publishing, and a REAL kill
//     after publishing and before the outbox ACK, both end with exactly one event in the durable log and an intact
//     hash chain; two real OS processes racing produce one winner and one event; re-execution is idempotent.
//
// Lines starting with "EVIDENCE[#308]" are printed on purpose: they are the reproducible record.
// Fixture rows are created directly; no settlement provider is exercised (QVAC stays advisory-only).

import { PrismaClient } from '@prisma/client'
import { createPostgresIntegrationHarness } from './postgresTestHarness'

describe('#308 transition durability and ABA safety (real Postgres, real processes)', () => {
  jest.setTimeout(180_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let DisputeService: typeof import('../../src/modules/open-settlement/dispute.service').DisputeService
  let publishPendingDisputeTransitions: typeof import('../../src/modules/open-settlement/dispute-transition-outbox').publishPendingDisputeTransitions
  let getTimeline: typeof import('../../src/core/timeline').getTimeline

  beforeAll(async () => {
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ DisputeService } = require('../../src/modules/open-settlement/dispute.service'))
    ;({ publishPendingDisputeTransitions } = require('../../src/modules/open-settlement/dispute-transition-outbox'))
    ;({ getTimeline } = require('../../src/core/timeline'))
  })
  afterAll(async () => { if (dbAvailable) await prisma.$disconnect() })

  const evidence = (label: string, data: unknown) => process.stdout.write(`EVIDENCE[#308] ${label}: ${JSON.stringify(data)}\n`)
  const noProvider = {
    name: 'test-none', arbitrators: [] as string[],
    async assign(): Promise<string> { throw new Error('not used by this fixture') },
    async assignAppealPanel(): Promise<string> { throw new Error('not used by this fixture') },
  }

  let seq = 0
  /** An AUTO_PROPOSED dispute whose deadline is `offsetMs` from the DATABASE clock (negative = already expired). */
  async function makeAutoProposed(label: string, offsetMs: number, generation = 1) {
    seq += 1
    const uniq = `${label}-${Date.now()}-${seq}`
    const seller = await prisma.user.create({ data: { id: `seller-${uniq}`, publicKey: `pk-seller-${uniq}` } })
    const buyer = await prisma.user.create({ data: { id: `buyer-${uniq}`, publicKey: `pk-buyer-${uniq}` } })
    const arbiter = await prisma.user.create({ data: { id: `arbiter-${uniq}`, publicKey: `pk-arbiter-${uniq}` } })
    const offer = await prisma.offer.create({ data: { id: `offer-${uniq}`, userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER', status: 'ACTIVE' } })
    const trade = await prisma.trade.create({ data: { id: `trade-${uniq}`, offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, amount: '0.001', asset: 'BTC', priceUsd: '60000', totalUsd: '60', status: 'DISPUTED' } })
    const escrow = await prisma.escrow.create({ data: { id: `escrow-${uniq}`, tradeId: trade.id, type: 'MOCK', status: 'DISPUTED', lockedAmount: '0.001', asset: 'BTC', feeCharged: '0' } })
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id } })
    const dispute = await prisma.dispute.create({
      data: {
        id: `dispute-${uniq}`, tradeId: trade.id, escrowId: escrow.id, openedBy: buyer.id, reason: '#308 durability', arbiterId: arbiter.id,
        status: 'AUTO_PROPOSED', appealRound: 0, autoResolutionRecommendation: 'RELEASE', autoResolutionConfidence: 0.9,
        autoResolutionReasoning: 'fixture', autoResolutionDeadline: new Date(), autoProposalGeneration: generation,
      },
    })
    // deadline = database clock + offset, so the fixture does not depend on the test process clock
    await prisma.$executeRaw`UPDATE "disputes" SET "autoResolutionDeadline" = ((now() AT TIME ZONE 'UTC') + (${offsetMs} * interval '1 millisecond')) WHERE "id" = ${dispute.id}`
    return { dispute, trade, buyer, seller, service: new DisputeService(noProvider) }
  }

  const keyOf = (disputeId: string, generation: number, kind: string) => `${disputeId}:${generation}:${kind}`
  async function eventsFor(tradeId: string, key?: string) {
    const events = await prisma.durableEventRecord.findMany({ where: { correlationId: tradeId, eventName: 'dispute.auto_resolution_contested' } })
    return key ? events.filter((e) => (e.payload as { transitionKey?: string }).transitionKey === key) : events
  }
  async function outboxFor(disputeId: string) {
    return prisma.disputeTransitionOutbox.findMany({ where: { disputeId }, orderBy: { createdAt: 'asc' } })
  }

  // The deadline column is `timestamp(3)` (millisecond precision) while now() has microseconds, so an EXACT-equality
  // case is only expressible at an instant where now() is millisecond-aligned. Retry throwaway transactions until the
  // database hands us such an instant (about 1 in 1000), so the boundary test is deterministic instead of lucky.
  class NotAligned extends Error {}
  async function atMillisecondAlignedNow<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 20_000; attempt++) {
      try {
        return await prisma.$transaction(async (tx) => {
          const [{ ok }] = await tx.$queryRaw<Array<{ ok: boolean }>>`SELECT (extract(microseconds from now())::bigint % 1000 = 0) AS "ok"`
          if (!ok) throw new NotAligned()
          return fn(tx)
        })
      } catch (err) { if (!(err instanceof NotAligned)) throw err }
    }
    throw new Error('no millisecond-aligned now() obtained')
  }

  // ─── A. the claim: database clock, exact boundary, time zone ────────────────────────────────────
  it('A1 exact deadline instant: with now() pinned equal to the deadline inside one transaction, the CONTEST wins and the SWEEP does not', async () => {
    pg.requirePostgres('A1')
    const a = await makeAutoProposed('boundary-contest', 3_600_000)
    const b = await makeAutoProposed('boundary-sweep', 3_600_000)
    const results = await atMillisecondAlignedNow(async (tx) => {
      // inside one transaction now() is constant: set both deadlines to that very instant, then claim
      await tx.$executeRaw`UPDATE "disputes" SET "autoResolutionDeadline" = (now() AT TIME ZONE 'UTC') WHERE "id" IN (${a.dispute.id}, ${b.dispute.id})`
      const contest = await (a.service as any).claimAutoProposedTransition(a.dispute, 'CONTESTED', a.buyer.id, tx)
      const sweep = await (b.service as any).claimAutoProposedTransition(b.dispute, 'EXPIRED', 'window-expired-advisory-only', tx)
      return { contest, sweep }
    })
    evidence('A1 equality at the deadline', { contestWon: !!results.contest, sweepWon: !!results.sweep })
    expect(results.contest).toEqual(expect.any(String))
    expect(results.sweep).toBeNull()
    expect((await prisma.dispute.findUnique({ where: { id: a.dispute.id } }))!.status).toBe('EVIDENCE_SUBMITTED')
    expect((await prisma.dispute.findUnique({ where: { id: b.dispute.id } }))!.status).toBe('AUTO_PROPOSED')
  })

  it('A2 two milliseconds past the deadline the SWEEP wins and the CONTEST is refused (same clock, opposite sides of the boundary)', async () => {
    pg.requirePostgres('A2')
    const a = await makeAutoProposed('past-contest', 3_600_000)
    const b = await makeAutoProposed('past-sweep', 3_600_000)
    const results = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE "disputes" SET "autoResolutionDeadline" = ((now() AT TIME ZONE 'UTC') - interval '2 milliseconds') WHERE "id" IN (${a.dispute.id}, ${b.dispute.id})`
      return {
        contest: await (a.service as any).claimAutoProposedTransition(a.dispute, 'CONTESTED', a.buyer.id, tx),
        sweep: await (b.service as any).claimAutoProposedTransition(b.dispute, 'EXPIRED', 'window-expired-advisory-only', tx),
      }
    })
    evidence('A2 two milliseconds past the deadline', { contestWon: !!results.contest, sweepWon: !!results.sweep })
    expect(results.contest).toBeNull()
    expect(results.sweep).toEqual(expect.any(String))
  })

  it('A3 the decision does not depend on the session time zone (the column is a timestamp without time zone)', async () => {
    pg.requirePostgres('A3')
    for (const tz of ['UTC', 'America/Sao_Paulo', 'Pacific/Kiritimati']) {
      const open = await makeAutoProposed(`tz-open-${tz.length}`, 3_600_000) // one hour in the future
      const closed = await makeAutoProposed(`tz-closed-${tz.length}`, -3_600_000) // one hour in the past
      const r = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${tz}'`)
        return {
          openContest: await (open.service as any).claimAutoProposedTransition(open.dispute, 'CONTESTED', open.buyer.id, tx),
          closedContest: await (closed.service as any).claimAutoProposedTransition(closed.dispute, 'CONTESTED', closed.buyer.id, tx),
          closedSweep: await (closed.service as any).claimAutoProposedTransition(closed.dispute, 'EXPIRED', 'window-expired-advisory-only', tx),
        }
      })
      evidence(`A3 session time zone ${tz}`, { openContestWon: !!r.openContest, closedContestWon: !!r.closedContest, closedSweepWon: !!r.closedSweep })
      expect(r.openContest).toEqual(expect.any(String))
      expect(r.closedContest).toBeNull()
      expect(r.closedSweep).toEqual(expect.any(String))
    }
  })

  // ─── B. ABA between proposal generations ────────────────────────────────────────────────────────
  it('B1 ABA: a sweeper that observed proposal A cannot apply its transition to the later proposal B, even with an identical recommendation and an already-passed deadline', async () => {
    pg.requirePostgres('B1')
    const { dispute, service, buyer } = await makeAutoProposed('aba', -60_000, 1)
    const observedA = await prisma.dispute.findUnique({ where: { id: dispute.id } }) // the stale sweeper's snapshot of A
    // A is contested by a human, then QVAC proposes again: B has the SAME recommendation and a deadline that is also past.
    await service.contestAutoResolution(dispute.id, buyer.id).catch(() => undefined) // window already closed: refused
    await prisma.dispute.update({ where: { id: dispute.id }, data: { status: 'EVIDENCE_SUBMITTED' } })
    const proposed = await service.proposeAutoResolution(dispute.id, 'RELEASE', 0.9, 'fixture')
    expect(proposed!.autoProposalGeneration).toBe(2)
    await prisma.$executeRaw`UPDATE "disputes" SET "autoResolutionDeadline" = ((now() AT TIME ZONE 'UTC') - interval '1 minute') WHERE "id" = ${dispute.id}`
    const stale = await (service as any).claimAutoProposedTransition(observedA, 'EXPIRED', 'window-expired-advisory-only')
    const row = await prisma.dispute.findUnique({ where: { id: dispute.id } })
    evidence('B1 stale claim for generation 1 against generation 2', { staleWon: !!stale, status: row!.status, generation: row!.autoProposalGeneration, outbox: (await outboxFor(dispute.id)).length })
    expect(stale).toBeNull()
    expect(row).toMatchObject({ status: 'AUTO_PROPOSED', autoProposalGeneration: 2 })
    expect(await outboxFor(dispute.id)).toHaveLength(0)
    // the current generation is still claimable by a sweeper that observed it
    const current = await (service as any).claimAutoProposedTransition(row, 'EXPIRED', 'window-expired-advisory-only')
    expect(current).toEqual(expect.any(String))
  })

  it('B2 the proposal generation only ever grows: three proposals on one dispute give 1, 2, 3 and the unique outbox key allows one transition per generation', async () => {
    pg.requirePostgres('B2')
    const { dispute, service } = await makeAutoProposed('gen-grow', 3_600_000, 0)
    await prisma.dispute.update({ where: { id: dispute.id }, data: { status: 'EVIDENCE_SUBMITTED' } })
    const seen: number[] = []
    for (let i = 0; i < 3; i++) {
      const p = await service.proposeAutoResolution(dispute.id, 'REFUND', 0.9, `r${i}`)
      seen.push(p!.autoProposalGeneration)
      await prisma.$executeRaw`UPDATE "disputes" SET "autoResolutionDeadline" = ((now() AT TIME ZONE 'UTC') - interval '1 minute') WHERE "id" = ${dispute.id}`
      await (service as any).claimAutoProposedTransition(p, 'EXPIRED', 'window-expired-advisory-only')
    }
    evidence('B2 generations', { seen, outbox: (await outboxFor(dispute.id)).map((o) => `${o.generation}:${o.kind}`) })
    expect(seen).toEqual([1, 2, 3])
    expect((await outboxFor(dispute.id)).map((o) => o.generation)).toEqual([1, 2, 3])
    await expect(prisma.disputeTransitionOutbox.create({ data: { disputeId: dispute.id, generation: 3, kind: 'EXPIRED', tradeId: 'x', payload: {} } })).rejects.toThrow() // unique (disputeId, generation, kind)
  })

  // ─── C. a human decision that commits first prevails ────────────────────────────────────────────
  it('C1 a human ruling committed first (the same conditional claim resolveDispute() uses) leaves contest and sweep as no-ops: no rewrite, no outbox row, no event', async () => {
    pg.requirePostgres('C1')
    const { dispute, buyer, service, trade } = await makeAutoProposed('human', -60_000)
    const human = await prisma.dispute.updateMany({ where: { id: dispute.id, status: { not: 'RESOLVED' }, arbiterId: dispute.arbiterId! }, data: { status: 'RESOLVED', ruling: 'REFUND', resolvedAt: new Date() } })
    expect(human.count).toBe(1)
    const stale = await prisma.dispute.findUnique({ where: { id: dispute.id } })
    await expect(service.contestAutoResolution(dispute.id, buyer.id)).rejects.toThrow(/no pending automated resolution/)
    const sweepClaim = await (service as any).claimAutoProposedTransition({ ...stale, status: 'AUTO_PROPOSED' }, 'EXPIRED', 'window-expired-advisory-only') // a sweeper holding a stale AUTO_PROPOSED observation
    await service.sweepExpiredAutoResolutions()
    const row = await prisma.dispute.findUnique({ where: { id: dispute.id } })
    evidence('C1 human decision first', { sweepClaim, status: row!.status, ruling: row!.ruling, outbox: (await outboxFor(dispute.id)).length, events: (await eventsFor(trade.id)).length })
    expect(sweepClaim).toBeNull()
    expect(row).toMatchObject({ status: 'RESOLVED', ruling: 'REFUND' })
    expect(await outboxFor(dispute.id)).toHaveLength(0)
    expect(await eventsFor(trade.id)).toHaveLength(0)
  })

  // ─── D. publication and recovery: REAL process kills ────────────────────────────────────────────
  /** Runs `body` in a child Node process (ts-node) with a real DB connection; resolves with its exit signal/code and stdout. */
  async function runChild(body: string, opts: { killOn?: string } = {}) {
    const { spawn } = require('child_process')
    const root = require('path').resolve(__dirname, '..', '..')
    const code = `
      const { DisputeService } = require(${JSON.stringify(root + '/src/modules/open-settlement/dispute.service')})
      const { eventBus } = require(${JSON.stringify(root + '/src/common/events/event-bus')})
      const service = new DisputeService({ name: 'none', arbitrators: [], assign: async () => { throw new Error('x') }, assignAppealPanel: async () => { throw new Error('x') } })
      const killSelf = () => process.kill(process.pid, 'SIGKILL')
      ;(async () => { ${body} })().then(() => { console.log('SURVIVED'); process.exit(0) }, (e) => { console.error(String(e && e.stack || e)); process.exit(1) })
    `
    const child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', code], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    const exit: { code: number | null; signal: string | null } = await new Promise((resolve) => child.on('exit', (code: number | null, signal: string | null) => resolve({ code, signal })))
    return { ...exit, stdout, stderr, killOn: opts.killOn }
  }

  it('D1 REAL kill after the claim committed and BEFORE the event was published: the transition stands, the outbox row is pending, and recovery publishes exactly one event with an intact hash chain', async () => {
    pg.requirePostgres('D1')
    const { dispute, buyer, trade } = await makeAutoProposed('crash-before-publish', 3_600_000)
    const child = await runChild(`
      const real = eventBus.emit.bind(eventBus)
      eventBus.emit = async () => { killSelf() } // the process dies at the moment it would publish
      await service.contestAutoResolution(${JSON.stringify(dispute.id)}, ${JSON.stringify(buyer.id)})
    `)
    const key = keyOf(dispute.id, 1, 'CONTESTED')
    const afterCrash = { signal: child.signal, status: (await prisma.dispute.findUnique({ where: { id: dispute.id } }))!.status, outbox: (await outboxFor(dispute.id)).map((o) => ({ kind: o.kind, published: !!o.publishedAt })), events: (await eventsFor(trade.id, key)).length }
    evidence('D1 after the kill', afterCrash)
    expect(child.stdout).not.toContain('SURVIVED') // the process died inside the action; it did not finish or fail with a JS error
    expect(child.stderr).toBe('')
    expect(afterCrash).toMatchObject({ status: 'EVIDENCE_SUBMITTED', events: 0 })
    expect(afterCrash.outbox).toEqual([{ kind: 'CONTESTED', published: false }])

    const recovered = await publishPendingDisputeTransitions()
    const rerun = await publishPendingDisputeTransitions()
    const events = await eventsFor(trade.id, key)
    const chain = await getTimeline(trade.id).verifyChain()
    evidence('D1 recovery', { recovered, rerun, events: events.length, chainValid: chain.valid })
    expect(recovered.published).toBeGreaterThanOrEqual(1)
    expect(rerun.published).toBe(0)
    expect(events).toHaveLength(1)
    expect(chain.valid).toBe(true)
    expect((await outboxFor(dispute.id))[0].publishedAt).not.toBeNull()
    expect((await prisma.dispute.findUnique({ where: { id: dispute.id } }))!.status).toBe('EVIDENCE_SUBMITTED') // recovery never touches the economic state
  })

  it('D2 REAL kill after the event was published and BEFORE the outbox ACK: the row is still pending, recovery finds the event in the log and only marks it published — no second event', async () => {
    pg.requirePostgres('D2')
    const { dispute, buyer, trade } = await makeAutoProposed('crash-after-publish', 3_600_000)
    const child = await runChild(`
      const real = eventBus.emit.bind(eventBus)
      eventBus.emit = async (...a) => { await real(...a); killSelf() } // durable record committed, then the process dies before the ACK
      await service.contestAutoResolution(${JSON.stringify(dispute.id)}, ${JSON.stringify(buyer.id)})
    `)
    const key = keyOf(dispute.id, 1, 'CONTESTED')
    const pending = (await outboxFor(dispute.id)).map((o) => !!o.publishedAt)
    const eventsBefore = (await eventsFor(trade.id, key)).length
    evidence('D2 after the kill', { signal: child.signal, outboxPublished: pending, eventsInLog: eventsBefore })
    expect(child.stdout).not.toContain('SURVIVED')
    expect(child.stderr).toBe('')
    expect(pending).toEqual([false])
    expect(eventsBefore).toBe(1)

    const recovered = await publishPendingDisputeTransitions()
    const events = await eventsFor(trade.id, key)
    const chain = await getTimeline(trade.id).verifyChain()
    evidence('D2 recovery', { recovered, events: events.length, chainValid: chain.valid })
    expect(recovered.alreadyInLog).toBeGreaterThanOrEqual(1)
    expect(events).toHaveLength(1)
    expect(chain.valid).toBe(true)
    expect((await outboxFor(dispute.id))[0].publishedAt).not.toBeNull()
  })

  it('D4 a publication failure keeps the outbox row pending and writes no event; the next run publishes it once', async () => {
    pg.requirePostgres('D4')
    const { dispute, buyer, trade, service } = await makeAutoProposed('publish-fails', 3_600_000)
    await (service as any).claimAutoProposedTransition(dispute, 'CONTESTED', buyer.id)
    const { eventBus } = require('../../src/common/events/event-bus')
    const spy = jest.spyOn(eventBus, 'emit').mockRejectedValueOnce(new Error('INJECTED publish failure'))
    const failed = await publishPendingDisputeTransitions()
    spy.mockRestore()
    const mid = { outboxPublished: (await outboxFor(dispute.id)).map((o) => !!o.publishedAt), events: (await eventsFor(trade.id)).length }
    evidence('D4 after the failed publication', { failed, ...mid })
    expect(failed.failed).toBe(1)
    expect(mid).toEqual({ outboxPublished: [false], events: 0 })
    const retried = await publishPendingDisputeTransitions()
    expect(retried.published).toBeGreaterThanOrEqual(1)
    expect(await eventsFor(trade.id, keyOf(dispute.id, 1, 'CONTESTED'))).toHaveLength(1)
  })

  it('D3 three publishers racing on one pending row publish it once (row lock + causal-key check), and re-execution is a no-op', async () => {
    pg.requirePostgres('D3')
    const { dispute, buyer, trade, service } = await makeAutoProposed('publishers', 3_600_000)
    const outboxId = await (service as any).claimAutoProposedTransition(dispute, 'CONTESTED', buyer.id) // claimed, nothing published yet
    expect(outboxId).toEqual(expect.any(String))
    const runs = await Promise.all([publishPendingDisputeTransitions(), publishPendingDisputeTransitions(), publishPendingDisputeTransitions()])
    await publishPendingDisputeTransitions()
    const events = await eventsFor(trade.id, keyOf(dispute.id, 1, 'CONTESTED'))
    evidence('D3 concurrent publishers', { runs, events: events.length })
    expect(events).toHaveLength(1)
    expect((await getTimeline(trade.id).verifyChain()).valid).toBe(true)
  })

  // ─── E. real OS processes ───────────────────────────────────────────────────────────────────────
  // Children need seconds to boot ts-node, so each fires at an agreed wall-clock instant `startAt`; the dispute deadline
  // is placed relative to that instant (same machine, test clock ~ database clock), so the race is REAL, not a late arrival.
  const gateAt = (startAt: number) => `await new Promise((r) => setTimeout(r, Math.max(0, ${startAt} - Date.now())))`
  const sweepBody = (gate: string) => `${gate}; const r = await service.sweepExpiredAutoResolutions(); console.log('SWEEPRESULT ' + JSON.stringify(r))`
  const contestBody = (gate: string, d: string, b: string) => `${gate}; try { await service.contestAutoResolution(${JSON.stringify(d)}, ${JSON.stringify(b)}); console.log('CONTESTWON') } catch (e) { console.log('CONTESTLOST ' + e.message) }`

  it('E1 two sweeper processes and a contesting process fire at the deadline instant: one transition, one outbox row, one event, a coherent final state (the winner may be either side)', async () => {
    pg.requirePostgres('E1')
    const startAt = Date.now() + 10_000
    const { dispute, buyer, trade } = await makeAutoProposed('two-processes-boundary', startAt - Date.now())
    const gate = gateAt(startAt)
    const [s1, s2, c] = await Promise.all([
      runChild(sweepBody(gate)), runChild(sweepBody(gate)), runChild(contestBody(gate, dispute.id, buyer.id)),
    ])
    // At the exact boundary a sweep that selected the row a few ms early may not yet be allowed to claim it (deadline < now is strict) and a contest a few ms late may be refused:
    // it is legitimate for NO process to win this round. The next sweeper tick then converges the state; either way there is at most one claim.
    const afterRace = (await outboxFor(dispute.id)).length
    await new DisputeService(noProvider).sweepExpiredAutoResolutions()
    await publishPendingDisputeTransitions() // any winner whose own publication was interrupted
    const outbox = await outboxFor(dispute.id)
    const events = await eventsFor(trade.id)
    const row = await prisma.dispute.findUnique({ where: { id: dispute.id } })
    const sweepWon = [s1, s2].filter((s) => /"revertedToHuman":\["/.test(s.stdout)).length
    const contestWon = c.stdout.includes('CONTESTWON') ? 1 : 0
    evidence('E1 two sweepers + one contest at the deadline', { exits: [s1.code, s2.code, c.code], sweepWinners: sweepWon, contestWinners: contestWon, claimsAfterTheRace: afterRace, outbox: outbox.map((o) => o.kind), events: events.length, status: row!.status })
    expect([s1.code, s2.code, c.code]).toEqual([0, 0, 0])
    expect(sweepWon + contestWon).toBeLessThanOrEqual(1) // never two processes with the same claim
    expect(afterRace).toBeLessThanOrEqual(1)
    expect(outbox).toHaveLength(1)
    expect(events).toHaveLength(1)
    expect(row!.status).toBe('EVIDENCE_SUBMITTED')
    expect((await getTimeline(trade.id).verifyChain()).valid).toBe(true)
  })

  it('E2 two sweeper processes find the same already-expired dispute at the same instant: exactly one claims it and one event is published', async () => {
    pg.requirePostgres('E2')
    const startAt = Date.now() + 10_000
    const { dispute, trade } = await makeAutoProposed('two-sweepers', -2_000)
    const gate = gateAt(startAt)
    const [s1, s2] = await Promise.all([runChild(sweepBody(gate)), runChild(sweepBody(gate))])
    await publishPendingDisputeTransitions()
    const won = [s1, s2].filter((s) => new RegExp(`"revertedToHuman":\\[[^\\]]*"${dispute.id}"`).test(s.stdout)).length
    const outbox = await outboxFor(dispute.id)
    const events = await eventsFor(trade.id)
    evidence('E2 two sweeper processes', { exits: [s1.code, s2.code], processesThatClaimed: won, outbox: outbox.length, events: events.length })
    expect([s1.code, s2.code]).toEqual([0, 0])
    expect(won).toBe(1)
    expect(outbox).toHaveLength(1)
    expect(events).toHaveLength(1)
  })
})