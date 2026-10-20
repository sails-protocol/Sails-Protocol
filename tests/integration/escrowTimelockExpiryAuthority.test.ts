// tests/integration/escrowTimelockExpiryAuthority.test.ts
//
// Sails Core Implementation Program M4 (Retry) — First Core-Authoritative
// Semantic Slice (FUNDS_LOCKED -> EXPIRED). Real-Postgres proof of the
// REAL live authoritative caller: escrowService.sweepExpiredEscrows()
// itself, not just the underlying commitAuthoritativeEscrowTimelockExpiry()
// primitive (already thoroughly proven in isolation by
// tests/integration/semanticTransitionRecordAtomicity.test.ts, M3.5-V).
// What's new here: does the REAL sweep, calling the REAL
// expiry-authority.ts/semantic-transition-record.ts wiring, actually
// commit State + Record atomically for a real fixture, leave the
// disjoint refund branch untouched, and resolve two concurrent real
// sweeps to exactly one authoritative outcome per escrow?
//
// The boundary-equality proof (deadline-1/deadline/deadline+1) is
// already exhaustively covered, deterministically, with fake timers,
// in tests/sweepers.test.ts's own M4 (Retry) suite — not repeated here,
// since real wall-clock timing cannot deterministically hit an exact
// millisecond boundary against a real, unmocked Date.now().

import { randomBytes } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { boundOfferRow, boundTradeRow, sellerPixAccount } from './economicFixtures'

describe('Sails Core Implementation Program M4 (Retry) — real sweepExpiredEscrows() authoritative path (real Postgres)', () => {
  jest.setTimeout(60_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: import('@prisma/client').PrismaClient
  let escrowService: typeof import('../../src/modules/open-settlement/escrow.service').escrowService
  let semanticTransitionRecordRepository: typeof import('../../src/modules/open-settlement/semantic-transition-record').semanticTransitionRecordRepository

  beforeAll(async () => {
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ escrowService } = require('../../src/modules/open-settlement/escrow.service'))
    ;({ semanticTransitionRecordRepository } = require('../../src/modules/open-settlement/semantic-transition-record'))
  })

  afterAll(async () => {
    if (dbAvailable) await prisma.$disconnect()
  })

  function requirePostgres(name: string): void {
    pg.requirePostgres(name)
  }

  function suffix() { return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }

  async function fixtureEscrow(type: string, expiresAt: Date) {
    const s = suffix()
    const buyer = await prisma.user.create({ data: { publicKey: `pk-buyer-m4-${s}` } })
    const seller = await prisma.user.create({ data: { publicKey: `pk-seller-m4-${s}` } })
    const acct = await sellerPixAccount(prisma, seller.id)
    const offer = await prisma.offer.create({ data: { userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '65000', minAmount: '0.001', maxAmount: '1', ...boundOfferRow(acct) } })
    const trade = await prisma.trade.create({ data: { ...boundTradeRow(acct), offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, asset: 'BTC', amount: '0.001', priceUsd: '65000', totalUsd: '65' } })
    const escrow = await prisma.escrow.create({
      // #235 R7G F8A: expiresAt only ever lands together with the funding outpoint (lockFunds())
      data: { tradeId: trade.id, type: type as any, status: 'FUNDS_LOCKED', asset: 'BTC', lockedAmount: '0.001', timelockHours: 1, expiresAt, txLockId: randomBytes(32).toString('hex'), txLockVout: 0 },
    })
    return { escrow, trade }
  }

  it('P6/P13/P17-P19 — the real sweep authorizes a genuinely-expired MULTISIG escrow, committing State + a durable, faithful SemanticTransitionRecord atomically', async () => {
    requirePostgres('M4 real happy path')
    const { escrow } = await fixtureEscrow('MULTISIG', new Date(Date.now() - 60_000))

    const result = await escrowService.sweepExpiredEscrows()

    expect(result.requiresManualRecovery).toContain(escrow.id)
    const updated = await prisma.escrow.findUniqueOrThrow({ where: { id: escrow.id } })
    expect(updated.status).toBe('EXPIRED')

    const record = await semanticTransitionRecordRepository.findByInteractionAndTransitionType(escrow.id, 'escrow.timelock.expire')
    expect(record).not.toBeNull()
    expect(record!.fromState).toBe('FUNDS_LOCKED')
    expect(record!.toState).toBe('EXPIRED')
    expect(record!.priorPositionKind).toBe('LEGACY_UNVERIFIED')
    expect(record!.evaluatorIdentityName).toBe('sails-timelock-evaluator')
    expect(record!.evaluatorIdentityVersion).toBe('1.0')
    expect(record!.profileIdentityName).toBe('sails-semantic-profile')
    expect(record!.rulesetIdentity).toBe('sails-escrow-timelock-expiry-ruleset')
    expect(record!.conditionResult).toBe('SATISFIED')
    expect(typeof record!.deadlineMs).toBe('bigint')
    expect(typeof record!.evaluationTimeMs).toBe('bigint')
  })

  it('P21/T12 — the disjoint refund branch (non-target type) is completely unaffected: a MOCK escrow still refunds through the unchanged legacy path, no SemanticTransitionRecord created for it', async () => {
    requirePostgres('M4 non-target regression')
    const { escrow } = await fixtureEscrow('MOCK', new Date(Date.now() - 60_000))

    const result = await escrowService.sweepExpiredEscrows()

    expect(result.refunded).toContain(escrow.id)
    const updated = await prisma.escrow.findUniqueOrThrow({ where: { id: escrow.id } })
    expect(updated.status).toBe('REFUNDED')
    const record = await semanticTransitionRecordRepository.findByInteractionAndTransitionType(escrow.id, 'escrow.timelock.expire')
    expect(record).toBeNull()
  })

  it('P15/T18 — two concurrent real sweeps against overlapping candidates resolve to exactly one authoritative transition and one Record per escrow, never a duplicate', async () => {
    requirePostgres('M4 concurrent real sweeps')
    const { escrow } = await fixtureEscrow('MULTISIG', new Date(Date.now() - 60_000))

    // Two independent, genuinely concurrent invocations of the REAL
    // production sweep entrypoint — not the underlying atomic primitive
    // directly (already proven concurrent-safe in isolation by M3.5-V).
    const [resultA, resultB] = await Promise.all([
      escrowService.sweepExpiredEscrows(),
      escrowService.sweepExpiredEscrows(),
    ])

    const wins = [resultA, resultB].filter((r) => r.requiresManualRecovery.includes(escrow.id))
    expect(wins.length).toBe(1) // exactly one sweep call actually authorized it

    const finalEscrow = await prisma.escrow.findUniqueOrThrow({ where: { id: escrow.id } })
    expect(finalEscrow.status).toBe('EXPIRED')
    const allRecords = await prisma.semanticTransitionRecord.findMany({ where: { interactionId: escrow.id } })
    expect(allRecords).toHaveLength(1)
  })

  it('P9/§45 — existing historical Escrow rows remain fully valid and untouched by the new authoritative path', async () => {
    requirePostgres('M4 legacy compatibility')
    const s = suffix()
    const buyer = await prisma.user.create({ data: { publicKey: `pk-buyer-m4-legacy-${s}` } })
    const seller = await prisma.user.create({ data: { publicKey: `pk-seller-m4-legacy-${s}` } })
    const acct = await sellerPixAccount(prisma, seller.id)
    const offer = await prisma.offer.create({ data: { userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '65000', minAmount: '0.001', maxAmount: '1', ...boundOfferRow(acct) } })
    const trade = await prisma.trade.create({ data: { ...boundTradeRow(acct), offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, asset: 'BTC', amount: '0.001', priceUsd: '65000', totalUsd: '65' } })
    const historicalEscrow = await prisma.escrow.create({
      data: { tradeId: trade.id, type: 'MULTISIG', status: 'COMPLETED', asset: 'BTC', lockedAmount: '0.001', txLockId: randomBytes(32).toString('hex'), txLockVout: 0 },
    })

    await escrowService.sweepExpiredEscrows()

    const reread = await prisma.escrow.findUniqueOrThrow({ where: { id: historicalEscrow.id } })
    expect(reread.status).toBe('COMPLETED')
    const record = await semanticTransitionRecordRepository.findByInteractionAndTransitionType(historicalEscrow.id, 'escrow.timelock.expire')
    expect(record).toBeNull()
  })
  // ─── Production sweeper hardening: the sweep as startServer() schedules it ────────────────────────────────
  //
  // Each node is an independent module graph (own PrismaClient, own Redis client, own module singletons)
  // running the real sweepExpiredEscrows() through startGuardedInterval() on a real timer — the exact
  // shape app.ts's startServer() uses. What makes two nodes safe together is PostgreSQL, not the guard.

  interface SweeperNode { stop: () => Promise<void>; errors: unknown[] }
  const NODE_TICK_MS = 150

  function startSweeperNode(): SweeperNode {
    let node!: SweeperNode
    jest.isolateModules(() => {
      const { startGuardedInterval } = require('../../src/common/guarded-interval')
      const { escrowService: nodeEscrowService } = require('../../src/modules/open-settlement/escrow.service')
      const db = require('../../src/common/database')
      const redisModule = require('../../src/common/redis')
      const errors: unknown[] = []
      const guarded = startGuardedInterval(() => nodeEscrowService.sweepExpiredEscrows().then(() => undefined).catch((err: unknown) => { errors.push(err) }), NODE_TICK_MS)
      node = {
        errors,
        stop: async () => {
          await guarded.stop() // same order as startServer()'s SIGTERM: stop, drain the run in flight, then disconnect
          await db.prisma.$disconnect()
          await redisModule.redis?.quit?.().catch(() => undefined)
        },
      }
    })
    return node
  }

  async function waitUntil(cond: () => Promise<boolean>, deadlineMs: number): Promise<boolean> {
    const end = Date.now() + deadlineMs
    while (Date.now() < end) {
      if (await cond()) return true
      await new Promise((r) => setTimeout(r, 50))
    }
    return cond()
  }

  async function assertExpiredExactlyOnce(escrowId: string): Promise<void> {
    expect((await prisma.escrow.findUniqueOrThrow({ where: { id: escrowId } })).status).toBe('EXPIRED')
    expect(await prisma.semanticTransitionRecord.count({ where: { interactionId: escrowId } })).toBe(1)
    expect(await prisma.escrowEvent.count({ where: { escrowId, toStatus: 'EXPIRED' } })).toBe(1)
  }

  it('SCHEDULED, TWO INSTANCES: two nodes ticking the real sweep concurrently for many intervals leave exactly one EXPIRED transition, one Record and one EXPIRED escrow event per escrow', async () => {
    requirePostgres('scheduled timelock sweep - two instances')
    const fixtures = await Promise.all([0, 1, 2].map(() => fixtureEscrow('MULTISIG', new Date(Date.now() - 60_000))))
    const ids = fixtures.map((f) => f.escrow.id)

    const nodeA = startSweeperNode()
    const nodeB = startSweeperNode()
    try {
      const expired = async () => (await prisma.escrow.count({ where: { id: { in: ids }, status: 'EXPIRED' } })) === ids.length
      expect(await waitUntil(expired, 30_000)).toBe(true)
      // Keep both nodes ticking well past convergence: every later tick of either node must be a no-op.
      await new Promise((r) => setTimeout(r, NODE_TICK_MS * 8))
    } finally {
      await Promise.all([nodeA.stop(), nodeB.stop()])
    }
    for (const id of ids) await assertExpiredExactlyOnce(id)
    expect([...nodeA.errors, ...nodeB.errors]).toEqual([])
  })

  it('SCHEDULED RESTART: a node that is stopped (drained) and replaced by a fresh node keeps converging new durable state, and never re-applies what the first node already did', async () => {
    requirePostgres('scheduled timelock sweep - restart')
    const first = await fixtureEscrow('MULTISIG', new Date(Date.now() - 60_000))
    const nodeA = startSweeperNode()
    try {
      expect(await waitUntil(async () => (await prisma.escrow.findUniqueOrThrow({ where: { id: first.escrow.id } })).status === 'EXPIRED', 30_000)).toBe(true)
    } finally {
      await nodeA.stop()
    }

    // The process is gone. Durable state only: a second escrow expires while no node runs.
    const second = await fixtureEscrow('MULTISIG', new Date(Date.now() - 60_000))
    const nodeB = startSweeperNode()
    try {
      expect(await waitUntil(async () => (await prisma.escrow.findUniqueOrThrow({ where: { id: second.escrow.id } })).status === 'EXPIRED', 30_000)).toBe(true)
      await new Promise((r) => setTimeout(r, NODE_TICK_MS * 4))
    } finally {
      await nodeB.stop()
    }
    await assertExpiredExactlyOnce(first.escrow.id)
    await assertExpiredExactlyOnce(second.escrow.id)
    expect([...nodeA.errors, ...nodeB.errors]).toEqual([])
  })
})
