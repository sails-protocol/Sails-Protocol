// tests/integration/reconcilerProcessHarness.ts
//
// Issue #253 - shared harness of the OS-process reconciler suites (reconcilerOsProcess*.test.ts).
//
// WHAT THESE FIXTURES ARE, AND ARE NOT (read before relying on this evidence):
//   - Every escrow is a MOCK escrow (type 'MOCK', MOCK_ESCROW=true). No Bitcoin, Lightning, EVM or WDK call is made and
//     no funds move: the "released/refunded/split" fact is a row seeded straight into escrows + escrow_events, the
//     exact state the settlement code leaves behind after a fund movement. What is real is everything DOWNSTREAM of
//     that fact: the projection claims, the event handlers, PASS 3 of the reconciler, the durable event store, the
//     reputation/counter/fee effects, real PostgreSQL 16 transactions and locks, and real OS processes.
//   - So these suites prove delivery idempotency and crash recovery of the PROJECTION layer. They say nothing about
//     fund movement, provider behaviour, on-chain finality, or the fee amounts being right: FEE is a fixture value.
//   - The mutants quoted in the PR (tests/integration/mutants/) are the only evidence that an assertion can fail.
//
// Coordination between the test and its workers is by files, never by sleeping (see reconcilerProcess.worker.ts).

import { spawn } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { randomBytes } from 'crypto'
import { Prisma, PrismaClient } from '@prisma/client'

export const ROOT = path.resolve(__dirname, '..', '..')
export const WORKER = path.join(__dirname, 'reconcilerProcess.worker.ts')
export const CLOSED_REDIS_URL = 'redis://127.0.0.1:1'
export const AMOUNT = '0.001'
export const FEE = '0.00001'
const SATS = (btc: string) => BigInt(new Prisma.Decimal(btc).mul(1e8).toFixed(0))
export const AMOUNT_SATS = SATS(AMOUNT)
export const FEE_SATS = SATS(FEE)
export const CROSS_INSTANCE_CHANNEL = 'sails:cross-instance-events'

export type Kind = 'RELEASE_RULED' | 'REFUND_CLEAN' | 'SPLIT'
export const CYCLE: Kind[] = ['RELEASE_RULED', 'REFUND_CLEAN', 'SPLIT']
export const SPEC = {
  RELEASE_RULED: { from: 'DISPUTED', to: 'COMPLETED', eventName: 'settlement.escrow.released' },
  REFUND_CLEAN: { from: 'FUNDS_LOCKED', to: 'REFUNDED', eventName: 'settlement.escrow.refunded' },
  SPLIT: { from: 'DISPUTED', to: 'SPLIT', eventName: 'settlement.escrow.split' },
} as const

/** The projections a transition of each kind must have produced once converged: the specification the claims are checked against. */
export const EXPECTED_CLAIMS: Record<Kind, string[]> = {
  RELEASE_RULED: ['fee-floor', 'reputation.outcome', 'reputation.outcome', 'reputation.vouch-burn', 'reputation.vouch-burned-notification', 'trade.completed-notification', 'trade.completion-counters', 'trade.status', 'transition.claimed', 'transition.projected'],
  REFUND_CLEAN: ['reputation.outcome', 'reputation.outcome', 'trade.status', 'transition.claimed', 'transition.projected'],
  SPLIT: ['reputation.outcome', 'reputation.outcome', 'trade.completed-notification', 'trade.completion-counters', 'trade.status', 'transition.claimed', 'transition.projected'],
}

export interface Seeded {
  kind: Kind
  tradeId: string
  escrowId: string
  sellerId: string
  voucherId: string | null
  /** '' while the transition is still unclaimed (mode 'unclaimed': a live-path worker claims it). */
  transitionId: string
  mode: SeedMode
  live: { escrowId: string; tradeId: string; from: string; to: string; triggeredBy: string; eventName: string }
}
export type SeedMode = 'claimed' | 'published-twice' | 'unclaimed'

export interface WorkerStats {
  applied: Record<string, number>
  effectFailures: number
  fanoutReceived: number
  fanoutPublished: number
  fanoutPublishFailed: number
  publishes: number
  pool: { max: number; peakTotal: number; peakWaiting: number; saturatedSamples: number; samples: number }
}
export interface WorkerResult {
  label: string
  code: number | null
  signal: NodeJS.Signals | null
  stderr: string
  stats: WorkerStats | null
  txTimeouts: number
  killed: boolean
}
export interface WorkerHandle { label: string; pid: number; done: Promise<WorkerResult> }

export interface WorkerOptions {
  label: string
  escrowIds: string[]
  sync: Sync
  gates?: Array<{ name: string; at: string }>
  killAt?: string
  /** The process dies only once the test releases the `kill` gate, so the state at the moment of death can be read first. */
  killGate?: boolean
  waitFor?: string[]
  livePublish?: Seeded['live'][]
  role?: 'publisher'
  redisUrl?: string
  fanout?: boolean
  poolMax?: number
  deadlineMs?: number
}

/**
 * A TCP relay between the workers and the real Redis, so the test can cut Redis away from them at a chosen instant
 * (every open connection is destroyed, nothing is accepted) and bring it back - without touching the Redis server,
 * which other suites share. Counts the PUBLISH/SUBSCRIBE commands that really crossed it.
 */
export class RedisProxy {
  private server: import('net').Server | null = null
  private sockets = new Set<import('net').Socket>()
  port = 0
  stats = { connections: 0, publish: 0, subscribe: 0 }
  get url(): string { return `redis://127.0.0.1:${this.port}` }

  async start(): Promise<void> {
    const net = require('net') as typeof import('net')
    const upstream = new URL(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379')
    this.server = net.createServer((client) => {
      this.stats.connections++
      const up = net.connect(Number(upstream.port || 6379), upstream.hostname)
      this.sockets.add(client).add(up)
      client.on('data', (d) => { const s = d.toString('latin1'); this.stats.publish += s.match(/PUBLISH/gi)?.length ?? 0; this.stats.subscribe += s.match(/SUBSCRIBE/gi)?.length ?? 0 })
      client.pipe(up).pipe(client)
      const drop = () => { client.destroy(); up.destroy(); this.sockets.delete(client); this.sockets.delete(up) }
      client.on('error', drop).on('close', drop)
      up.on('error', drop).on('close', drop)
    })
    await new Promise<void>((resolve) => this.server!.listen(this.port, '127.0.0.1', resolve))
    this.port = (this.server.address() as import('net').AddressInfo).port
  }

  /** Redis becomes unreachable: established connections drop and new ones are refused. */
  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy()
    this.sockets.clear()
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()))
    this.server = null
  }
}

/** Subscribers currently listening to the production cross-instance channel, asked of the real Redis directly. */
export async function channelSubscribers(): Promise<number> {
  const Redis = require('ioredis')
  const r = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 })
  try {
    const reply = (await r.call('PUBSUB', 'NUMSUB', CROSS_INSTANCE_CHANNEL)) as [string, number]
    return Number(reply[1])
  } finally { r.disconnect() }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function waitUntil<T>(probe: () => Promise<T | false | null | undefined> | T | false | null | undefined, what: string, timeoutMs = 60_000, intervalMs = 40): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await probe()
    if (v) return v as T
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for: ${what}`)
    await sleep(intervalMs)
  }
}

export interface Arrival { label: string; pid: number; at: number; [k: string]: unknown }

/** A directory of marker files shared by the test and its workers: the test's only way to hold or release a worker. */
export class Sync {
  readonly dir = mkdtempSync(path.join(os.tmpdir(), 'osp-sync-'))
  arrival(name: string, label: string): Arrival | null {
    try { return JSON.parse(readFileSync(path.join(this.dir, `${label}.${name}.arrived`), 'utf8')) } catch { return null }
  }
  /** Resolves only when EVERY label is waiting at the gate - the proof that they are all in flight at the same moment. */
  async allArrived(name: string, labels: string[], timeoutMs = 90_000): Promise<Arrival[]> {
    return waitUntil(() => { const a = labels.map((l) => this.arrival(name, l)); return a.every(Boolean) ? (a as Arrival[]) : false }, `${labels.join(' + ')} at gate "${name}"`, timeoutMs)
  }
  release(name: string, label?: string): void { writeFileSync(path.join(this.dir, label ? `${label}.${name}.go` : `${name}.go`), '') }
  cleanup(): void { rmSync(this.dir, { recursive: true, force: true }) }
}

export function startWorker(o: WorkerOptions): WorkerHandle {
  const child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', WORKER], {
    cwd: ROOT,
    env: {
      ...process.env,
      REDIS_URL: o.redisUrl ?? CLOSED_REDIS_URL,
      ESCROW_IDS: JSON.stringify(o.escrowIds),
      SYNC_DIR: o.sync.dir,
      WORKER_LABEL: o.label,
      PGAPPNAME: `osp-${o.label}`,
      ...(o.gates ? { GATES: JSON.stringify(o.gates) } : {}),
      ...(o.killAt ? { KILL_AT: o.killAt } : {}),
      ...(o.killGate ? { KILL_GATE: '1' } : {}),
      ...(o.waitFor ? { WAIT_FOR: o.waitFor.join(',') } : {}),
      ...(o.livePublish ? { LIVE_PUBLISH: JSON.stringify(o.livePublish) } : {}),
      ...(o.role ? { ROLE: o.role } : {}),
      ...(o.fanout ? { FANOUT: '1' } : {}),
      ...(o.poolMax ? { POOL_MAX: String(o.poolMax) } : {}),
      ...(o.deadlineMs ? { WORKER_DEADLINE_MS: String(o.deadlineMs) } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  let txTimeouts = 0
  const timeouts = (d: Buffer) => { txTimeouts += d.toString().match(/Transaction API error|P2028|Transaction not found|Unable to start a transaction/g)?.length ?? 0 }
  child.stderr.on('data', (d: Buffer) => { timeouts(d); stderr = (stderr + d.toString()).slice(-20_000) })
  child.stdout.on('data', timeouts)
  const done = new Promise<WorkerResult>((resolve) => child.on('exit', (code, signal) => {
    const raw = /WORKER_STATS (\{.*\})/.exec(stderr)?.[1]
    resolve({ label: o.label, code, signal, stderr, stats: raw ? JSON.parse(raw) : null, txTimeouts, killed: stderr.includes('SIGKILL_MARKER') && code !== 0 })
  }))
  return { label: o.label, pid: child.pid!, done }
}

/**
 * If a backend of worker `blocked` is, right now, waiting for a lock held by a backend of worker `blocker`, the kind of
 * lock it waits on ('transactionid' = the other transaction's uncommitted claim row; 'advisory' = a pg_advisory_xact_lock).
 */
export async function blockedBy(prisma: PrismaClient, blocked: string, blocker: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<Array<{ app: string; blockers: string[] | null; locktype: string | null }>>`
    SELECT a.application_name AS app,
           (SELECT array_agg(b.application_name) FROM pg_stat_activity b WHERE b.pid = ANY(pg_blocking_pids(a.pid))) AS blockers,
           (SELECT l.locktype FROM pg_locks l WHERE l.pid = a.pid AND NOT l.granted LIMIT 1) AS locktype
    FROM pg_stat_activity a WHERE a.application_name LIKE 'osp-%'`
  return rows.find((r) => r.app === `osp-${blocked}` && (r.blockers ?? []).includes(`osp-${blocker}`))?.locktype ?? null
}

/** Sum, over the workers that exited normally, of the effects each applied: every effect must have been applied by exactly one process. */
export async function expectCrossProcessAccounting(prisma: PrismaClient, results: WorkerResult[], transitionIds: string[]): Promise<Record<string, number>> {
  const claims = await prisma.eventProjectionClaim.groupBy({ by: ['projectionKey'], where: { eventId: { in: transitionIds } }, _count: { _all: true } })
  const inDb = Object.fromEntries(claims.map((c) => [c.projectionKey, c._count._all]))
  const applied: Record<string, number> = {}
  for (const r of results) for (const [k, v] of Object.entries(r.stats?.applied ?? {})) applied[k] = (applied[k] ?? 0) + v
  for (const key of Object.keys(inDb)) if (key !== 'transition.claimed') expect({ key, applied: applied[key] ?? 0 }).toEqual({ key, applied: inDb[key] })
  return applied
}

/** Open sessions per worker, from pg_stat_activity (proof the worker really holds database connections). */
export async function sessionCount(prisma: PrismaClient, label: string): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM pg_stat_activity WHERE application_name = ${'osp-' + label}`
  return Number(rows[0].n)
}

export class Fixtures {
  prisma!: PrismaClient
  private eventBus: any
  private liquidityRouter: any
  private tradeService: any

  /** Call from beforeAll, after the database was probed: the modules must load only once MOCK_ESCROW is set. */
  init(): void {
    ;({ prisma: this.prisma } = require('../../src/common/database'))
    ;({ eventBus: this.eventBus } = require('../../src/common/events/event-bus'))
    ;({ liquidityRouter: this.liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service'))
    ;({ tradeService: this.tradeService } = require('../../src/modules/open-p2p/trade.service'))
    const { intentEngine } = require('../../src/core/intent-engine')
    const { OpenP2PTradeIntentHandler } = require('../../src/modules/open-p2p/intent-handler')
    intentEngine.registerHandler(OpenP2PTradeIntentHandler)
    // Deliberately no registerEventHandlers(): the only consumers of these transitions live in the workers.
  }

  user = (data: Record<string, unknown> = {}) => this.prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex'), ...data } })

  /**
   * One trade + MOCK escrow per transition. 'claimed': the transition and its "projection owed" marker exist, nothing
   * was published (crash after the claim). 'published-twice': the same plus two durable events for the one transition
   * (a live publish overlapping PASS 3). 'unclaimed': the escrow is in its final status but no transition exists yet,
   * so a worker running the real emitEscrowTransition() claims and publishes it.
   */
  async seed(buyerId: string, n: number, modeOf: (i: number) => SeedMode = (i) => (i % 2 === 1 ? 'published-twice' : 'claimed')): Promise<Seeded[]> {
    const seeded: Seeded[] = []
    for (let i = 0; i < n; i++) {
      const kind = CYCLE[i % CYCLE.length]
      const spec = SPEC[kind]
      const mode = modeOf(i)
      const seller = await this.user()
      const offer = await this.liquidityRouter.createOffer({ userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: AMOUNT, maxAmount: AMOUNT, paymentMethod: 'OTHER' })
      const trade = await this.tradeService.createTrade({ offerId: offer.id, counterpartyId: buyerId, amount: AMOUNT })
      const escrow = await this.prisma.escrow.create({
        data: { tradeId: trade.id, type: 'MOCK', status: spec.to as never, lockedAmount: AMOUNT, asset: 'BTC', txReleaseId: randomBytes(32).toString('hex'), ...(kind === 'RELEASE_RULED' ? { feeCharged: FEE } : {}) },
      })
      await this.prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id, status: 'ACTIVE' } })
      let voucherId: string | null = null
      if (kind === 'RELEASE_RULED') {
        const voucher = await this.user({ reputationScore: 10, totalTrades: 5 })
        voucherId = voucher.id
        await this.prisma.dispute.create({ data: { tradeId: trade.id, escrowId: escrow.id, openedBy: buyerId, reason: 'os-process', status: 'RESOLVED', ruling: 'RELEASE', arbiterId: 'k6-test-arbiter', resolvedAt: new Date() } })
        await this.prisma.vouch.create({ data: { voucherId: voucher.id, voucheeId: seller.id } })
      }
      let transitionId = ''
      if (mode !== 'unclaimed') {
        const transition = await this.prisma.escrowEvent.create({
          data: { escrowId: escrow.id, fromStatus: spec.from as never, toStatus: spec.to as never, triggeredBy: seller.id, entryHash: randomBytes(16).toString('hex'), prevHash: 'genesis' },
        })
        transitionId = transition.id
        await this.prisma.eventProjectionClaim.create({ data: { eventId: transition.id, projectionKey: 'transition.claimed', subjectId: escrow.id, appliedAt: new Date(Date.now() - 600_000) } })
        if (mode === 'published-twice') {
          // Twice: a live publish overlapping PASS 3 leaves two durable eventIds for one source transition.
          for (let copy = 0; copy < 2; copy++) await this.eventBus.emit(spec.eventName, { escrowId: escrow.id, tradeId: trade.id, from: spec.from, to: spec.to, triggeredBy: seller.id, transitionId: transition.id }, trade.id)
        }
      }
      seeded.push({ kind, tradeId: trade.id, escrowId: escrow.id, sellerId: seller.id, voucherId, transitionId, mode, live: { escrowId: escrow.id, tradeId: trade.id, from: spec.from, to: spec.to, triggeredBy: seller.id, eventName: spec.eventName } })
    }
    return seeded
  }

  /** The transition ids as they are in the database now (an unclaimed seed has one only after a worker claimed it). */
  async transitionIds(seeded: Seeded[]): Promise<string[]> {
    const rows = await this.prisma.escrowEvent.findMany({ where: { escrowId: { in: seeded.map((s) => s.escrowId) } }, select: { id: true } })
    return rows.map((r) => r.id)
  }

  /** What each user must hold once every seeded transition was projected exactly once - derived from the seeds, not from the code. */
  expectedLedger(buyerId: string, seeded: Seeded[]): Map<string, { trades: number; volume: bigint; fees: bigint; rep: number }> {
    const m = new Map<string, { trades: number; volume: bigint; fees: bigint; rep: number }>()
    const get = (id: string, rep = 0, trades = 0) => { if (!m.has(id)) m.set(id, { trades, volume: 0n, fees: 0n, rep }); return m.get(id)! }
    get(buyerId)
    for (const s of seeded) {
      const seller = get(s.sellerId)
      if (s.voucherId) get(s.voucherId, 10, 5)
      if (s.kind === 'REFUND_CLEAN') continue
      for (const u of [get(buyerId), seller]) { u.trades += 1; u.volume += AMOUNT_SATS }
      if (s.kind === 'RELEASE_RULED') {
        for (const u of [get(buyerId), seller]) u.fees += FEE_SATS
        get(buyerId).rep += 2
        seller.rep -= 5
        get(s.voucherId!).rep -= 5
      }
    }
    return m
  }

  /** Score notifications each user is owed, with no crash: one per outcome effect they took part in (neutral ones too). */
  expectedScoreNotifications(buyerId: string, seeded: Seeded[]): Map<string, number> {
    const m = new Map<string, number>()
    const add = (id: string) => m.set(id, (m.get(id) ?? 0) + 1)
    for (const s of seeded) { add(buyerId); add(s.sellerId); if (s.voucherId) add(s.voucherId) }
    return m
  }

  async scoreNotifications(userId: string) {
    return this.prisma.$queryRaw<Array<{ newScore: number; totalTrades: number; tradeId: string | null; publishedAt: string }>>`
      SELECT (payload->>'newScore')::float AS "newScore", (payload->>'totalTrades')::int AS "totalTrades", payload->>'tradeId' AS "tradeId", "publishedAt"
      FROM durable_events WHERE "eventName" = 'reputation.score.updated' AND payload->>'userId' = ${userId}
      ORDER BY "publishedAt" ASC`
  }

  private async countEvents(eventName: string, correlationIds: string[]): Promise<Map<string, number>> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; n: bigint }>>`
      SELECT "correlationId" AS id, count(*) AS n FROM durable_events WHERE "eventName" = ${eventName} AND "correlationId" = ANY(${correlationIds}) GROUP BY 1`
    return new Map(rows.map((r) => [r.id, Number(r.n)]))
  }

  /**
   * The full economic and notification state, against what the seeds say it must be. Economic effects are exact (no
   * tolerance); notifications are at-least-once, so each may exceed what is owed by at most `maxRepeatedNotifications`
   * IN TOTAL - the number of transactions the test knows were rolled back after publishing (a kill inside the claim
   * transaction, or an effect failure a worker reported) - and may never fall short.
   */
  async verify(buyerId: string, seeded: Seeded[], o: { label: string; maxRepeatedNotifications?: number }): Promise<{ repeatedNotifications: number; durableByName: Record<string, number> }> {
    const sats = (d: Prisma.Decimal | null | undefined) => (d == null ? null : BigInt(new Prisma.Decimal(d).mul(1e8).toFixed(0)))
    const ledger = this.expectedLedger(buyerId, seeded)
    const baseline = (id: string) => (seeded.some((s) => s.voucherId === id) ? 10 : 0)

    // 1. Every participant's counters, volume and fees: buyer, every seller, every voucher.
    for (const [id, exp] of ledger) {
      const u = (await this.prisma.user.findUnique({ where: { id } }))!
      expect({ who: id === buyerId ? 'buyer' : seeded.find((s) => s.sellerId === id) ? 'seller' : 'voucher', trades: u.totalTrades, volume: sats(u.totalVolumeBtc), fees: sats(u.cumulativeFeesObserved), rep: u.reputationScore, disputes: u.disputeCount })
        .toEqual({ who: id === buyerId ? 'buyer' : seeded.find((s) => s.sellerId === id) ? 'seller' : 'voucher', trades: exp.trades, volume: exp.volume, fees: exp.fees, rep: exp.rep, disputes: 0 })
    }

    // 2. Every transition: projected, the escrow itself untouched, exactly the projections its kind owes.
    for (const s of seeded) {
      const spec = SPEC[s.kind]
      const trade = (await this.prisma.trade.findUnique({ where: { id: s.tradeId } }))!
      expect(trade.status).toBe(s.kind === 'REFUND_CLEAN' ? 'CANCELLED' : 'COMPLETED')
      const escrow = (await this.prisma.escrow.findUnique({ where: { id: s.escrowId } }))!
      expect({ type: escrow.type, status: escrow.status, locked: sats(escrow.lockedAmount), fee: sats(escrow.feeCharged) })
        .toEqual({ type: 'MOCK', status: spec.to, locked: AMOUNT_SATS, fee: s.kind === 'RELEASE_RULED' ? FEE_SATS : null })
      const transitions = await this.prisma.escrowEvent.findMany({ where: { escrowId: s.escrowId } })
      expect(transitions).toHaveLength(1)
      const claims = await this.prisma.eventProjectionClaim.findMany({ where: { eventId: transitions[0].id } })
      expect(claims.map((c) => c.projectionKey).sort()).toEqual([...EXPECTED_CLAIMS[s.kind]].sort())
      if (s.voucherId) {
        const vouches = await this.prisma.vouch.findMany({ where: { voucherId: s.voucherId } })
        expect(vouches.length > 0 && vouches.every((v) => v.burnedAt !== null)).toBe(true)
      }
    }

    // 3. Notifications: never fewer than owed, repeats only as many as known rolled-back publications allow.
    let repeated = 0
    const surplus = (what: string, actual: number, owed: number) => {
      expect({ what, atLeastOwed: actual >= owed }).toEqual({ what, atLeastOwed: true })
      repeated += actual - owed
    }
    for (const [userId, owed] of this.expectedScoreNotifications(buyerId, seeded)) {
      const list = await this.scoreNotifications(userId)
      surplus(`score notifications of ${userId}`, list.length, owed)
      const persisted = (await this.prisma.user.findUnique({ where: { id: userId } }))!.reputationScore
      // The newest one reports the score the database holds; every one lies between the starting score and it.
      expect(list[list.length - 1].newScore).toBe(persisted)
      for (const n of list) expect(n.newScore >= Math.min(baseline(userId), persisted) && n.newScore <= Math.max(baseline(userId), persisted)).toBe(true)
    }
    const completed = await this.countEvents('openp2p.trade.completed', seeded.map((s) => s.tradeId))
    for (const s of seeded) surplus(`completed notification of ${s.tradeId}`, completed.get(s.tradeId) ?? 0, s.kind === 'REFUND_CLEAN' ? 0 : 1)
    const burned = await this.countEvents('reputation.vouch.burned', seeded.map((s) => s.sellerId))
    for (const s of seeded) surplus(`vouch.burned notification of ${s.sellerId}`, burned.get(s.sellerId) ?? 0, s.kind === 'RELEASE_RULED' ? 1 : 0)
    expect(repeated).toBeLessThanOrEqual(o.maxRepeatedNotifications ?? 0)

    const durable = await this.prisma.durableEventRecord.groupBy({ by: ['eventName'], where: { correlationId: { in: [...seeded.map((s) => s.tradeId), ...seeded.map((s) => s.sellerId), ...seeded.flatMap((s) => (s.voucherId ? [s.voucherId] : []))] } }, _count: { _all: true } })
    const durableByName = Object.fromEntries(durable.map((d) => [d.eventName, d._count._all]))
    const buyer = (await this.prisma.user.findUnique({ where: { id: buyerId } }))!
    process.stdout.write(`[evidence] ${JSON.stringify({ label: o.label, transitions: seeded.length, buyer: { trades: buyer.totalTrades, volumeSats: String(sats(buyer.totalVolumeBtc)), feesSats: String(sats(buyer.cumulativeFeesObserved)), rep: buyer.reputationScore }, repeatedNotifications: repeated, allowedRepeats: o.maxRepeatedNotifications ?? 0, durable: durableByName })}\n`)
    return { repeatedNotifications: repeated, durableByName }
  }
}
