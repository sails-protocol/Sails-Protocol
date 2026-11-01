// tests/integration/reconcilerProcess.worker.ts
//
// One independent OS process of the Sails reconciler, spawned by the reconcilerOsProcess*.test.ts suites. It shares
// nothing with its siblings but PostgreSQL (and, only when FANOUT=1, a Redis the test controls).
//
// Everything below is test harness: no production module is patched on disk. The worker wraps three production
// functions at runtime, in this process only, to observe and pause them (applyEventProjectionOnce, eventBus.emit,
// pg.Pool's constructor); the production code they call is unchanged.
//
// Coordination is by files in SYNC_DIR, never by sleeping:
//   <label>.<gate>.arrived   written by the worker when it reaches a gate (JSON: pid, what it is about to do)
//   <gate>.go | <label>.<gate>.go   written by the test; the worker proceeds only once one of them exists
// so a test can prove that N processes were really at the same point at the same time before it lets them go.
//
// GATES (JSON array of {name, at}); `at` is one of:
//   start                    after the worker has loaded everything, before it does any work
//   <key>:<nth>:before[:<id>] before the nth claim attempt of that projection key opens its transaction
//   <key>:<nth>:inside       the nth effect THIS process applies, its claim transaction still open
//   <key>:<nth>:after        the same effect, after its transaction committed
//   publish:<nth>[:<id>]     before the nth settlement.escrow.* durable event this process publishes (of that transition, if given)
// KILL_AT="<key>:<nth>:<phase>" terminates this process with SIGKILL there (KILL_GATE=1: only once the test releases
// the `kill` gate, so the state at the moment of death can be inspected first).
// WAIT_FOR=<file>[,<file>] holds the whole worker back until those files exist in SYNC_DIR.
//
// FANOUT=1 enables the production cross-instance fanout on the worker's Redis (REDIS_URL), exactly as app.ts does.
// POOL_MAX=<n> caps every pg.Pool the process opens. PGAPPNAME names its sessions so the test can see them in
// pg_stat_activity.

import { randomUUID } from 'crypto'
import { existsSync, renameSync, writeFileSync, writeSync } from 'fs'
import path from 'path'

const label = process.env.WORKER_LABEL ?? 'w'
const syncDir = process.env.SYNC_DIR ?? ''
const gateTimeoutMs = Number(process.env.GATE_TIMEOUT_MS ?? 120_000)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const stderr = (line: string) => writeSync(2, line + '\n')

// Windows reports a self-SIGKILL as a plain exit code, so the kill is proven by this marker, written synchronously.
const die = () => { stderr('SIGKILL_MARKER'); process.kill(process.pid, 'SIGKILL') }

// `only`, when given, restricts the point to the claims of that one effect identity (a transition id): the other
// handlers of the process keep running while it waits, so "the nth claim of the key" alone would not name one row.
interface Point { name: string; key: string; nth: number; phase: 'before' | 'inside' | 'after'; kill: boolean; seen: number; only?: string }
const gateAt: Array<{ name: string; at: string }> = JSON.parse(process.env.GATES ?? '[]')
const points: Point[] = []
for (const g of gateAt) {
  const [key, nth, phase, only] = g.at.split(':')
  if (phase) points.push({ name: g.name, key, nth: Number(nth), phase: phase as Point['phase'], kill: false, seen: 0, only })
}
if (process.env.KILL_AT) {
  const [key, nth, phase] = process.env.KILL_AT.split(':')
  points.push({ name: 'kill', key, nth: Number(nth), phase: phase as Point['phase'], kill: true, seen: 0 })
}
const publishGates = gateAt.filter((g) => g.at.startsWith('publish:'))
const publishSeenBy: Record<string, number> = {}

async function gate(name: string, info: Record<string, unknown> = {}): Promise<void> {
  const mine = path.join(syncDir, `${label}.${name}.arrived`)
  writeFileSync(mine + '.tmp', JSON.stringify({ label, pid: process.pid, at: Date.now(), ...info }))
  renameSync(mine + '.tmp', mine)
  const goFiles = [path.join(syncDir, `${name}.go`), path.join(syncDir, `${label}.${name}.go`)]
  const deadline = Date.now() + gateTimeoutMs
  while (!goFiles.some(existsSync)) {
    if (Date.now() > deadline) { stderr(`GATE_TIMEOUT ${name}`); process.exit(4) }
    await sleep(20)
  }
}

const stats = { applied: {} as Record<string, number>, effectFailures: 0, fanoutReceived: 0, fanoutPublished: 0, fanoutPublishFailed: 0, publishes: 0, pool: { max: 0, peakTotal: 0, peakWaiting: 0, saturatedSamples: 0, samples: 0 } }
const pools: Array<{ options: { max: number }; totalCount: number; idleCount: number; waitingCount: number }> = []

// Cross-instance signals still in flight when the worker is done: each is allowed to settle (bounded) so that its
// outcome - delivered or failed - is part of the reported statistics rather than lost to the exit.
const pendingPublishes = new Set<Promise<unknown>>()

async function finish(code: number): Promise<never> {
  await Promise.race([Promise.allSettled([...pendingPublishes]), sleep(10_000)])
  stderr('WORKER_STATS ' + JSON.stringify(stats))
  process.exit(code)
}

async function main(): Promise<void> {
  // The client is a PrismaPg adapter over pg.Pool, whose size neither connection_limit nor a URL parameter reaches.
  const pg = require('pg')
  const RealPool = pg.Pool
  pg.Pool = class extends RealPool {
    constructor(options: object) {
      super(process.env.POOL_MAX ? { ...options, max: Number(process.env.POOL_MAX) } : options)
      pools.push(this as never)
      if (process.env.POOL_MAX) stderr(`POOL_MAX_APPLIED ${(this as unknown as { options: { max: number } }).options.max}`)
    }
  }
  setInterval(() => {
    for (const p of pools) {
      stats.pool.max = Math.max(stats.pool.max, p.options.max)
      stats.pool.peakTotal = Math.max(stats.pool.peakTotal, p.totalCount)
      stats.pool.peakWaiting = Math.max(stats.pool.peakWaiting, p.waitingCount)
      stats.pool.samples++
      // Saturated = every connection the pool may open is open and a caller is queued for one.
      if (p.waitingCount > 0 && p.totalCount >= p.options.max && p.idleCount === 0) stats.pool.saturatedSamples++
    }
  }, 50).unref()

  const eventProjection = require('../../src/common/events/event-projection')
  const realApply = eventProjection.applyEventProjectionOnce
  const act = async (p: Point, info: Record<string, unknown>) => {
    if (p.kill) {
      if (process.env.KILL_GATE) await gate('kill', info)
      die()
    }
    await gate(p.name, info)
  }
  eventProjection.applyEventProjectionOnce = async (id: string, key: string, subject: string, apply: (tx: unknown) => Promise<void>, client?: unknown) => {
    const info = { eventId: id, key, subject }
    const mine = points.filter((p) => p.key === key && (!p.only || p.only === id))
    for (const p of mine) if (p.phase === 'before' && ++p.seen === p.nth) await act(p, info)
    let applied = false
    try {
      const result = await realApply(id, key, subject, async (tx: unknown) => {
        await apply(tx)
        applied = true
        // Counted only for an effect THIS process applies: a sibling that won the claim must not consume the point.
        for (const p of mine) if (p.phase === 'inside' && ++p.seen === p.nth) await act(p, info)
      }, client)
      if (applied) {
        stats.applied[key] = (stats.applied[key] ?? 0) + 1
        for (const p of mine) if (p.phase === 'after' && ++p.seen === p.nth) await act(p, info)
      }
      return result
    } catch (err) {
      stats.effectFailures++
      stderr(`EFFECT_FAILED ${key} ${String((err as Error)?.message ?? err).split('\n').pop()}`)
      throw err
    }
  }

  const { prisma } = require('../../src/common/database')
  const { eventBus } = require('../../src/common/events/event-bus')
  const { intentEngine } = require('../../src/core/intent-engine')
  const { OpenP2PTradeIntentHandler } = require('../../src/modules/open-p2p/intent-handler')
  intentEngine.registerHandler(OpenP2PTradeIntentHandler)

  // A publication gate: pauses the nth settlement.escrow.* event this process is about to publish, whichever code
  // path publishes it (the live path after its claim, or PASS 3 republishing).
  if (publishGates.length) {
    const realEmit = eventBus.emit.bind(eventBus)
    eventBus.emit = async (name: string, payload: { transitionId?: string }, correlationId: string) => {
      if (name.startsWith('settlement.escrow.')) {
        stats.publishes++
        for (const g of publishGates) {
          const [, nth, only] = g.at.split(':')
          if (only && only !== payload.transitionId) continue
          const seen = (publishSeenBy[g.name] = (publishSeenBy[g.name] ?? 0) + 1)
          if (seen === Number(nth)) await gate(g.name, { eventName: name, transitionId: payload.transitionId ?? null })
        }
      }
      return realEmit(name, payload, correlationId)
    }
  }

  require('../../src/common/events/handlers').registerEventHandlers()
  if (process.env.FANOUT === '1') {
    const { redis } = require('../../src/common/redis')
    // Counted at the client the production store publishes through: the outcome of each cross-instance signal.
    const realPublish = redis.publish.bind(redis)
    redis.publish = (...args: unknown[]) => {
      const outcome = (realPublish as (...a: unknown[]) => Promise<number>)(...args).then(
        (n) => { stats.fanoutPublished++; return n },
        (err) => { stats.fanoutPublishFailed++; throw err })
      pendingPublishes.add(outcome.catch(() => undefined))
      return outcome
    }
    eventBus.enableCrossInstanceFanout(redis)
    const store = (eventBus as unknown as { store: { instanceId: string; crossInstanceSubscriber: { on: (e: string, f: (c: string, m: string) => void) => void } } }).store
    store.crossInstanceSubscriber.on('message', (_channel: string, message: string) => {
      try { if (JSON.parse(message).__originInstanceId !== store.instanceId) stats.fanoutReceived++ } catch { /* malformed: the production code drops it too */ }
    })
  }
  const { reconcilePendingSettlements } = require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service')
  const { emitEscrowTransition } = require('../../src/modules/open-settlement/escrow-lifecycle')

  process.stdout.write(`READY ${randomUUID()}\n`)
  if (process.env.WAIT_FOR) {
    const files = process.env.WAIT_FOR.split(',').map((f) => path.join(syncDir, f))
    const deadline = Date.now() + gateTimeoutMs
    while (!files.every(existsSync)) {
      if (Date.now() > deadline) { stderr('WAIT_FOR_TIMEOUT'); process.exit(4) }
      await sleep(20)
    }
  }
  if (gateAt.some((g) => g.at === 'start')) await gate(gateAt.find((g) => g.at === 'start')!.name)

  // The live path: claim a transition and publish it, exactly as the settlement code does after a fund movement.
  for (const t of JSON.parse(process.env.LIVE_PUBLISH ?? '[]') as Array<{ escrowId: string; tradeId: string; from: string; to: string; triggeredBy: string; eventName: string }>) {
    await emitEscrowTransition(t.escrowId, t.tradeId, t.from, t.to, t.triggeredBy, t.eventName)
  }
  if (process.env.ROLE === 'publisher') return finish(0)

  const escrowIds: string[] = JSON.parse(process.env.ESCROW_IDS ?? '[]')
  const deadline = Date.now() + Number(process.env.WORKER_DEADLINE_MS ?? 90_000)
  while (Date.now() < deadline) {
    await reconcilePendingSettlements({ projectionGraceMs: 0 })
    // PASS 3 redelivers the first durable event only; a duplicate reaches a consumer through at-least-once delivery.
    const durable = await prisma.$queryRaw`
      SELECT d.id FROM durable_events d JOIN escrow_events e ON d.payload->>'transitionId' = e.id
      WHERE e."escrowId" = ANY(${escrowIds})`
    for (const { id } of durable as Array<{ id: string }>) await eventBus.redeliver(id)
    const done = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM event_projection_claims p JOIN escrow_events e ON p."subjectId" = e.id
      WHERE p."projectionKey" = 'transition.projected' AND e."escrowId" = ANY(${escrowIds})`
    if (Number(done[0].n) === escrowIds.length) { process.stdout.write('CONVERGED\n'); return finish(0) }
    await sleep(300)
  }
  stderr('deadline reached before convergence')
  return finish(3)
}

main().catch((err) => { stderr(String(err?.stack ?? err)); process.exit(1) })
