// tests/integration/autoResolutionLockedDecision.test.ts
//
// #308 / D-308 (Gatekeeper NO-GO corrections) — two properties that only a real PostgreSQL with REAL lock waits can
// show, both deterministic (every ordering is built by holding a row lock and confirming, in pg_stat_activity, that
// each operation is really blocked before the next one starts; nothing here depends on sleeping and hoping):
//
//   F. DEADLINE UNDER LOCK. A contest that is queued on the dispute row BEFORE the deadline and is granted the row
//      AFTER the deadline must be judged at the instant it is actually granted, not at the instant it started waiting.
//      `now()` is the transaction start and a statement snapshot is taken before the wait, so a decision made with
//      either lets a contest win a window that closed while it waited. F1/F2 cross the deadline during the wait (the
//      lock holder commits an unrelated change / rolls back), F3 is the control that must still contest in time,
//      F4 is the ABA case through a lock wait.
//
//   G. HUMAN RESOLUTION RACING THE TRANSITION. `resolveDispute()` (a real Ed25519-signed human decision, real
//      `applyRuling()`, MOCK escrow refund) is queued together with a contest and/or the advisory sweep in every
//      relevant arrival order, including the order where the deadline passes while the contest is still waiting.
//      Order-independent invariants: the dispute ends RESOLVED with the human's ruling and signature, the escrow is
//      settled exactly once, there is at most one transition (outbox row) and exactly one event for it, and a transition
//      that loses to the human leaves nothing behind.
//
// Lines starting with "EVIDENCE[#308]" are printed on purpose: they are the reproducible record.

import { PrismaClient } from '@prisma/client'
import nacl from 'tweetnacl'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import type { AuthorityDecisionPayload } from '../../src/modules/open-settlement/arbitration-authority'

type Op = 'resolve' | 'contest' | 'sweep'
type Step = Op | 'deadline-passes'
type Outcome = { ok: true; value: unknown } | { ok: false; error: Error }

class Rollback extends Error {}

describe('#308 deadline decided under lock + human resolution racing the transition (real Postgres, real lock waits)', () => {
  jest.setTimeout(180_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let DisputeService: typeof import('../../src/modules/open-settlement/dispute.service').DisputeService
  let publishPendingDisputeTransitions: typeof import('../../src/modules/open-settlement/dispute-transition-outbox').publishPendingDisputeTransitions
  let signAuthorityDecision: typeof import('../../src/modules/open-settlement/arbitration-authority').signAuthorityDecision
  let getTimeline: typeof import('../../src/core/timeline').getTimeline

  beforeAll(async () => {
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ DisputeService } = require('../../src/modules/open-settlement/dispute.service'))
    ;({ publishPendingDisputeTransitions } = require('../../src/modules/open-settlement/dispute-transition-outbox'))
    ;({ signAuthorityDecision } = require('../../src/modules/open-settlement/arbitration-authority'))
    ;({ getTimeline } = require('../../src/core/timeline'))
  })
  afterAll(async () => { if (dbAvailable) await prisma.$disconnect() })

  const evidence = (label: string, data: unknown) => process.stdout.write(`EVIDENCE[#308] ${label}: ${JSON.stringify(data)}\n`)
  const noProvider = {
    name: 'test-none', arbitrators: [] as string[],
    async assign(): Promise<string> { throw new Error('not used by this fixture') },
    async assignAppealPanel(): Promise<string> { throw new Error('not used by this fixture') },
  }
  const settle = <T>(p: Promise<T>): Promise<Outcome> => p.then((value) => ({ ok: true as const, value }), (error: Error) => ({ ok: false as const, error }))
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  // ─── fixture: an AUTO_PROPOSED dispute on a MOCK escrow whose arbiter holds a REAL Ed25519 key ───
  let seq = 0
  async function makeDispute(label: string, deadlineOffsetMs: number) {
    seq += 1
    const uniq = `${label}-${Date.now()}-${seq}`
    const arbiterKeys = nacl.sign.keyPair()
    const seller = await prisma.user.create({ data: { id: `seller-${uniq}`, publicKey: `pk-seller-${uniq}` } })
    const buyer = await prisma.user.create({ data: { id: `buyer-${uniq}`, publicKey: `pk-buyer-${uniq}` } })
    const arbiter = await prisma.user.create({ data: { id: `arbiter-${uniq}`, publicKey: Buffer.from(arbiterKeys.publicKey).toString('hex') } })
    const offer = await prisma.offer.create({ data: { id: `offer-${uniq}`, userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER', status: 'ACTIVE' } })
    const trade = await prisma.trade.create({ data: { id: `trade-${uniq}`, offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, amount: '0.001', asset: 'BTC', priceUsd: '60000', totalUsd: '60', status: 'DISPUTED' } })
    const escrow = await prisma.escrow.create({ data: { id: `escrow-${uniq}`, tradeId: trade.id, type: 'MOCK', status: 'DISPUTED', lockedAmount: '0.001', asset: 'BTC', feeCharged: '0' } })
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id } })
    const dispute = await prisma.dispute.create({
      data: {
        id: `dispute-${uniq}`, tradeId: trade.id, escrowId: escrow.id, openedBy: buyer.id, reason: '#308 locked decision', arbiterId: arbiter.id,
        status: 'AUTO_PROPOSED', appealRound: 0, autoResolutionRecommendation: 'RELEASE', autoResolutionConfidence: 0.9,
        autoResolutionReasoning: 'fixture', autoResolutionDeadline: new Date(), autoProposalGeneration: 1,
      },
    })
    const issuedAt = new Date().toISOString()
    const payload: AuthorityDecisionPayload = { disputeId: dispute.id, escrowId: escrow.id, appealRound: 0, authorityId: arbiter.id, outcome: 'REFUND', buyerBps: null, issuedAt }
    const signature = signAuthorityDecision(payload, arbiterKeys.secretKey)
    const service = new DisputeService(noProvider)
    await setDeadlineFromDbClock(dispute.id, deadlineOffsetMs) // last, so the offset is measured from "now", not from fixture building
    return { id: dispute.id, tradeId: trade.id, escrowId: escrow.id, buyerId: buyer.id, arbiterId: arbiter.id, signature, issuedAt, service }
  }
  type Fixture = Awaited<ReturnType<typeof makeDispute>>

  const setDeadlineFromDbClock = (id: string, offsetMs: number) =>
    prisma.$executeRaw`UPDATE "disputes" SET "autoResolutionDeadline" = (date_trunc('milliseconds', clock_timestamp()) AT TIME ZONE 'UTC') + (${offsetMs} * interval '1 millisecond') WHERE "id" = ${id}`
  const msUntilDeadline = async (id: string): Promise<number> => {
    const [{ ms }] = await prisma.$queryRaw<Array<{ ms: number }>>`SELECT (extract(epoch from ("autoResolutionDeadline" - (clock_timestamp() AT TIME ZONE 'UTC'))) * 1000)::float8 AS "ms" FROM "disputes" WHERE "id" = ${id}`
    return ms
  }
  async function waitUntilDeadlinePassed(id: string) {
    for (let i = 0; i < 400; i++) {
      if ((await msUntilDeadline(id)) < -50) return
      await sleep(25)
    }
    throw new Error('the deadline never passed')
  }

  // ─── deterministic lock choreography ───
  /** Holds `SELECT ... FOR UPDATE` on the dispute row in a real transaction until `release()`; `finish` decides how it ends. */
  async function holdRowLock(id: string, finish: (tx: any) => Promise<void> = async () => undefined) {
    let release!: () => void
    const released = new Promise<void>((r) => { release = r })
    let locked!: (pid: number) => void
    const lockedPromise = new Promise<number>((r) => { locked = r })
    const done = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "disputes" WHERE "id" = ${id} FOR UPDATE`
      const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS "pid"`
      locked(pid)
      await released
      await finish(tx)
    }, { timeout: 120_000, maxWait: 30_000 }).catch((e: Error) => { if (!(e instanceof Rollback)) throw e })
    const pid = await lockedPromise
    return { release, done, pid }
  }
  const rollbackOnRelease = async () => { throw new Rollback() }

  /** Number of backends in this database that are really waiting on another backend's lock right now. */
  async function blockedBackends(): Promise<number> {
    const [{ n }] = await prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS "n" FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND cardinality(pg_blocking_pids(pid)) > 0`
    return n
  }
  async function waitBlocked(n: number, what: string) {
    for (let i = 0; i < 600; i++) {
      if ((await blockedBackends()) >= n) return
      await sleep(25)
    }
    throw new Error(`precondition failed: ${what} never became blocked on the row lock (blocked=${await blockedBackends()}, wanted ${n})`)
  }

  const start = (f: Fixture, op: Op): Promise<Outcome> => {
    if (op === 'resolve') return settle(f.service.resolveDispute(f.id, f.arbiterId, 'REFUND', undefined, undefined, undefined, f.signature, f.issuedAt))
    if (op === 'contest') return settle(f.service.contestAutoResolution(f.id, f.buyerId))
    return settle(f.service.sweepExpiredAutoResolutions())
  }

  /** Queues the operations on the locked row one at a time, in `steps` order, then releases the lock. */
  async function raceBehindLock(f: Fixture, steps: Step[], finish?: (tx: any) => Promise<void>) {
    const holder = await holdRowLock(f.id, finish)
    const running: Partial<Record<Op, Promise<Outcome>>> = {}
    let queued = 0
    for (const step of steps) {
      if (step === 'deadline-passes') { await waitUntilDeadlinePassed(f.id); continue }
      running[step] = start(f, step)
      queued += 1
      await waitBlocked(queued, `${step} (arrival #${queued})`)
    }
    holder.release()
    await holder.done
    const out: Partial<Record<Op, Outcome>> = {}
    for (const op of Object.keys(running) as Op[]) out[op] = await running[op]
    return out
  }

  async function finalState(f: Fixture) {
    await publishPendingDisputeTransitions() // events of every winner, including any whose own publication was skipped
    const row = (await prisma.dispute.findUnique({ where: { id: f.id } }))!
    const escrow = (await prisma.escrow.findUnique({ where: { id: f.escrowId } }))!
    const outbox = await prisma.disputeTransitionOutbox.findMany({ where: { disputeId: f.id }, orderBy: { createdAt: 'asc' } })
    const events = await prisma.durableEventRecord.findMany({ where: { correlationId: f.tradeId, eventName: 'dispute.auto_resolution_contested' } })
    const chain = await getTimeline(f.tradeId).verifyChain()
    return { row, escrow, outbox: outbox.map((o) => `${o.generation}:${o.kind}`), published: outbox.every((o) => o.publishedAt), events: events.length, chainValid: chain.valid }
  }
  const message = (o: Outcome | undefined) => (o && !o.ok ? o.error.message : '')

  // ─── F. the deadline is decided at the instant the row is granted, not when the claim started waiting ───
  it('F1 a contest queued BEFORE the deadline and granted the row AFTER it is refused, when the lock holder COMMITS an unrelated change; the sweep then claims it once', async () => {
    pg.requirePostgres('F1')
    const f = await makeDispute('lock-commit', 4_000)
    const holder = await holdRowLock(f.id, async (tx) => { await tx.$executeRaw`UPDATE "disputes" SET "reason" = "reason" || ' (annotated)' WHERE "id" = ${f.id}` })
    const contest = start(f, 'contest')
    await waitBlocked(1, 'the contest')
    const marginBefore = await msUntilDeadline(f.id)
    expect(marginBefore).toBeGreaterThan(0) // precondition: the contest really started waiting inside its window
    await waitUntilDeadlinePassed(f.id)
    holder.release(); await holder.done
    const c = await contest
    const mid = await finalState(f)
    evidence('F1 contest queued before the deadline, granted after it (holder committed)', { marginBeforeMs: Math.round(marginBefore), contestOk: c.ok, contestError: message(c), status: mid.row.status, outbox: mid.outbox, events: mid.events })
    expect(c.ok).toBe(false)
    expect(message(c)).toMatch(/contest window has already closed/)
    expect(mid.row.status).toBe('AUTO_PROPOSED') // nothing was rewritten
    expect(mid.outbox).toEqual([])
    expect(mid.events).toBe(0)

    const swept = await f.service.sweepExpiredAutoResolutions()
    const end = await finalState(f)
    evidence('F1 the sweep takes it', { swept: swept.revertedToHuman.includes(f.id), status: end.row.status, outbox: end.outbox, events: end.events })
    expect(swept.revertedToHuman).toContain(f.id)
    expect(end.row.status).toBe('EVIDENCE_SUBMITTED')
    expect(end.outbox).toEqual(['1:EXPIRED'])
    expect(end.events).toBe(1)
    expect(end.chainValid).toBe(true)
  })

  it('F2 same crossing, but the lock holder ROLLS BACK (no row change: the database never re-evaluates the old statement), the contest is still refused', async () => {
    pg.requirePostgres('F2')
    const f = await makeDispute('lock-rollback', 4_000)
    const holder = await holdRowLock(f.id, rollbackOnRelease)
    const contest = start(f, 'contest')
    await waitBlocked(1, 'the contest')
    const marginBefore = await msUntilDeadline(f.id)
    expect(marginBefore).toBeGreaterThan(0)
    await waitUntilDeadlinePassed(f.id)
    holder.release(); await holder.done
    const c = await contest
    const mid = await finalState(f)
    evidence('F2 contest queued before the deadline, granted after it (holder rolled back)', { marginBeforeMs: Math.round(marginBefore), contestOk: c.ok, contestError: message(c), status: mid.row.status, outbox: mid.outbox, events: mid.events })
    expect(c.ok).toBe(false)
    expect(message(c)).toMatch(/contest window has already closed/)
    expect(mid.row.status).toBe('AUTO_PROPOSED')
    expect(mid.outbox).toEqual([])
    expect(mid.events).toBe(0)
  })

  it('F3 control: a contest that waits on the lock but is granted the row BEFORE the deadline still wins (the fix does not shorten the window)', async () => {
    pg.requirePostgres('F3')
    const f = await makeDispute('lock-in-time', 60_000)
    const holder = await holdRowLock(f.id, rollbackOnRelease)
    const contest = start(f, 'contest')
    await waitBlocked(1, 'the contest')
    holder.release(); await holder.done
    const c = await contest
    const end = await finalState(f)
    evidence('F3 contest granted inside the window after a lock wait', { contestOk: c.ok, status: end.row.status, outbox: end.outbox, events: end.events })
    expect(c.ok).toBe(true)
    expect(end.row.status).toBe('EVIDENCE_SUBMITTED')
    expect(end.outbox).toEqual(['1:CONTESTED'])
    expect(end.events).toBe(1)
    expect(end.chainValid).toBe(true)
  })

  it('F4 ABA through a lock wait: a sweep queued on proposal 1 is granted the row after proposal 2 was committed; it cannot apply its transition to proposal 2', async () => {
    pg.requirePostgres('F4')
    const f = await makeDispute('lock-aba', -60_000) // proposal 1 is already expired, the sweep selects it
    const holder = await holdRowLock(f.id, async (tx) => {
      // while the sweep waits, a new proposal replaces it: generation 2, deadline an hour away
      await tx.$executeRaw`UPDATE "disputes" SET "autoProposalGeneration" = 2, "autoResolutionDeadline" = ((now() AT TIME ZONE 'UTC') + interval '1 hour') WHERE "id" = ${f.id}`
    })
    const sweep = start(f, 'sweep')
    await waitBlocked(1, 'the sweep')
    holder.release(); await holder.done
    const s = await sweep
    const end = await finalState(f)
    const swept = s.ok ? (s.value as { revertedToHuman: string[] }).revertedToHuman.includes(f.id) : null
    evidence('F4 stale sweep granted the row after the next proposal committed', { sweptThisDispute: swept, status: end.row.status, generation: end.row.autoProposalGeneration, outbox: end.outbox })
    expect(swept).toBe(false)
    expect(end.row).toMatchObject({ status: 'AUTO_PROPOSED', autoProposalGeneration: 2 })
    expect(end.outbox).toEqual([])
  })

  // ─── G. a real signed human resolution racing the transition ───
  function expectHumanAuthority(f: Fixture, end: Awaited<ReturnType<typeof finalState>>, outcomes: Partial<Record<Op, Outcome>>) {
    expect(outcomes.resolve?.ok).toBe(true) // the human decision is never the loser
    expect(end.row).toMatchObject({ status: 'RESOLVED', ruling: 'REFUND', arbiterId: f.arbiterId, authoritySignature: f.signature })
    expect(end.escrow.status).toBe('REFUNDED') // settled exactly once (a second settlement would have thrown from the status guard)
    expect(end.outbox.length).toBeLessThanOrEqual(1) // contest xor sweep, never both
    expect(end.events).toBe(end.outbox.length) // one event per transition, none for a transition that did not happen
    expect(end.published).toBe(true)
    expect(end.chainValid).toBe(true)
  }

  it('G1 contest queued first, human decision second (deadline far away): the transition happens, then the human resolves from EVIDENCE_SUBMITTED', async () => {
    pg.requirePostgres('G1')
    const f = await makeDispute('g1', 3_600_000)
    const out = await raceBehindLock(f, ['contest', 'resolve'], rollbackOnRelease)
    const end = await finalState(f)
    evidence('G1 [contest, resolve]', { contest: out.contest?.ok, resolve: out.resolve?.ok, status: end.row.status, ruling: end.row.ruling, outbox: end.outbox, events: end.events, escrow: end.escrow.status })
    expectHumanAuthority(f, end, out)
    expect(out.contest?.ok).toBe(true)
    expect(end.outbox).toEqual(['1:CONTESTED'])
  })

  it('G2 human decision queued first, contest second: the human prevails, the contest is refused, nothing is written for it (no outbox row, no event)', async () => {
    pg.requirePostgres('G2')
    const f = await makeDispute('g2', 3_600_000)
    const out = await raceBehindLock(f, ['resolve', 'contest'], rollbackOnRelease)
    const end = await finalState(f)
    evidence('G2 [resolve, contest]', { contest: out.contest?.ok, contestError: message(out.contest), resolve: out.resolve?.ok, status: end.row.status, ruling: end.row.ruling, outbox: end.outbox, events: end.events, escrow: end.escrow.status })
    expectHumanAuthority(f, end, out)
    expect(out.contest?.ok).toBe(false)
    expect(message(out.contest)).toMatch(/no pending automated resolution to contest \(status: RESOLVED\)/)
    expect(end.outbox).toEqual([])
    expect(end.events).toBe(0)
  })

  it('G3 expired proposal, human decision queued first, advisory sweep second: the human prevails, the sweep is a no-op', async () => {
    pg.requirePostgres('G3')
    const f = await makeDispute('g3', -60_000)
    const out = await raceBehindLock(f, ['resolve', 'sweep'], rollbackOnRelease)
    const end = await finalState(f)
    const swept = out.sweep?.ok ? (out.sweep.value as { revertedToHuman: string[] }).revertedToHuman.includes(f.id) : null
    evidence('G3 [resolve, sweep]', { sweptThisDispute: swept, resolve: out.resolve?.ok, status: end.row.status, outbox: end.outbox, events: end.events, escrow: end.escrow.status })
    expectHumanAuthority(f, end, out)
    expect(swept).toBe(false)
    expect(end.outbox).toEqual([])
    expect(end.events).toBe(0)
  })

  it('G4 expired proposal, advisory sweep queued first, human decision second: the sweep transitions, then the human resolves', async () => {
    pg.requirePostgres('G4')
    const f = await makeDispute('g4', -60_000)
    const out = await raceBehindLock(f, ['sweep', 'resolve'], rollbackOnRelease)
    const end = await finalState(f)
    const swept = out.sweep?.ok ? (out.sweep.value as { revertedToHuman: string[] }).revertedToHuman.includes(f.id) : null
    evidence('G4 [sweep, resolve]', { sweptThisDispute: swept, resolve: out.resolve?.ok, status: end.row.status, outbox: end.outbox, events: end.events, escrow: end.escrow.status })
    expectHumanAuthority(f, end, out)
    expect(swept).toBe(true)
    expect(end.outbox).toEqual(['1:EXPIRED'])
  })

  it('G5 all three, the deadline passing while the contest waits, human decision queued before the sweep: the human prevails, contest refused, sweep a no-op', async () => {
    pg.requirePostgres('G5')
    const f = await makeDispute('g5', 4_000)
    const out = await raceBehindLock(f, ['contest', 'resolve', 'deadline-passes', 'sweep'], rollbackOnRelease)
    const end = await finalState(f)
    const swept = out.sweep?.ok ? (out.sweep.value as { revertedToHuman: string[] }).revertedToHuman.includes(f.id) : null
    evidence('G5 [contest, resolve, deadline passes, sweep]', { contest: out.contest?.ok, contestError: message(out.contest), sweptThisDispute: swept, resolve: out.resolve?.ok, status: end.row.status, outbox: end.outbox, events: end.events, escrow: end.escrow.status })
    expectHumanAuthority(f, end, out)
    // The contest was first in the queue: it is granted the row first, and by then the deadline has passed.
    expect(out.contest?.ok).toBe(false)
    expect(message(out.contest)).toMatch(/contest window has already closed/)
    // The human decision is next in the queue, then the sweep finds RESOLVED.
    expect(swept).toBe(false)
    expect(end.outbox).toEqual([])
    expect(end.events).toBe(0)
  })

  it('G6 all three, the deadline passing while the contest waits, sweep queued before the human decision: contest refused, the sweep transitions once, then the human resolves', async () => {
    pg.requirePostgres('G6')
    const f = await makeDispute('g6', 4_000)
    const out = await raceBehindLock(f, ['contest', 'deadline-passes', 'sweep', 'resolve'], rollbackOnRelease)
    const end = await finalState(f)
    const swept = out.sweep?.ok ? (out.sweep.value as { revertedToHuman: string[] }).revertedToHuman.includes(f.id) : null
    evidence('G6 [contest, deadline passes, sweep, resolve]', { contest: out.contest?.ok, contestError: message(out.contest), sweptThisDispute: swept, resolve: out.resolve?.ok, status: end.row.status, outbox: end.outbox, events: end.events, escrow: end.escrow.status })
    expectHumanAuthority(f, end, out)
    expect(out.contest?.ok).toBe(false)
    expect(message(out.contest)).toMatch(/contest window has already closed/)
    expect(swept).toBe(true)
    expect(end.outbox).toEqual(['1:EXPIRED'])
    expect(end.events).toBe(1)
  })
})
