// tests/integration/reconcilerProcess.worker.ts
//
// One independent OS process of the Sails reconciler, spawned by reconcilerOsProcess.test.ts. It shares nothing with
// its siblings but PostgreSQL: no cross-instance fanout is enabled, so Redis plays no part in the outcome.
//
// KILL_AT="<projectionKey>:<nth>:<phase>" terminates this process abruptly at the nth claim of that key:
//   before - before the claim transaction opens
//   inside - the effect ran, its transaction is still open (a notification published in it is already durable)
//   after  - the transaction committed, the effect's ACK is the only thing lost

import { randomUUID } from 'crypto'
import { writeSync } from 'fs'

// Windows reports a self-SIGKILL as a plain exit code, so the kill is proven by this marker, written synchronously.
const die = () => { writeSync(2, 'SIGKILL_MARKER\n'); process.kill(process.pid, 'SIGKILL') }

async function main(): Promise<void> {
  // The client is a PrismaPg adapter over pg.Pool, whose size neither connection_limit nor a URL parameter reaches.
  if (process.env.POOL_MAX) {
    const pg = require('pg')
    const RealPool = pg.Pool
    pg.Pool = class extends RealPool {
      constructor(options: object) {
        super({ ...options, max: Number(process.env.POOL_MAX) })
        writeSync(2, `POOL_MAX_APPLIED ${(this as unknown as { options: { max: number } }).options.max}\n`)
      }
    }
  }
  const eventProjection = require('../../src/common/events/event-projection')
  const [killKey, killNth, killPhase] = (process.env.KILL_AT ?? '::').split(':')
  let seen = 0
  const realApply = eventProjection.applyEventProjectionOnce
  eventProjection.applyEventProjectionOnce = async (id: string, key: string, subject: string, apply: (tx: unknown) => Promise<void>, client?: unknown) => {
    if (key !== killKey) return realApply(id, key, subject, apply, client)
    if (killPhase === 'before' && ++seen === Number(killNth)) die()
    // Counted only for an effect THIS process applies: a sibling that won the claim must not consume the kill.
    let armed = false
    const applied = await realApply(id, key, subject, async (tx: unknown) => {
      await apply(tx)
      armed = killPhase !== 'before' && ++seen === Number(killNth)
      if (armed && killPhase === 'inside') die()
    }, client)
    if (armed && killPhase === 'after') die()
    return applied
  }

  const { prisma } = require('../../src/common/database')
  const { eventBus } = require('../../src/common/events/event-bus')
  const { intentEngine } = require('../../src/core/intent-engine')
  const { OpenP2PTradeIntentHandler } = require('../../src/modules/open-p2p/intent-handler')
  intentEngine.registerHandler(OpenP2PTradeIntentHandler)
  require('../../src/common/events/handlers').registerEventHandlers()
  const { reconcilePendingSettlements } = require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service')

  process.stdout.write(`READY ${randomUUID()}\n`)
  const transitionIds: string[] = JSON.parse(process.env.TRANSITION_IDS ?? '[]')
  const deadline = Date.now() + Number(process.env.WORKER_DEADLINE_MS ?? 90_000)
  while (Date.now() < deadline) {
    await reconcilePendingSettlements({ projectionGraceMs: 0 })
    // PASS 3 redelivers the first durable event only; a duplicate reaches a consumer through at-least-once delivery.
    const durable = await prisma.$queryRaw`SELECT id FROM durable_events WHERE payload->>'transitionId' = ANY(${transitionIds})`
    for (const { id } of durable as Array<{ id: string }>) await eventBus.redeliver(id)
    const done = await prisma.eventProjectionClaim.count({ where: { projectionKey: 'transition.projected', subjectId: { in: transitionIds } } })
    if (done === transitionIds.length) { process.stdout.write('CONVERGED\n'); process.exit(0) }
    await new Promise((r) => setTimeout(r, 300))
  }
  process.stderr.write('deadline reached before convergence\n')
  process.exit(3)
}

main().catch((err) => { process.stderr.write(String(err?.stack ?? err) + '\n'); process.exit(1) })
