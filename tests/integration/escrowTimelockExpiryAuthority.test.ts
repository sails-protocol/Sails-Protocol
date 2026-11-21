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

import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { createBoundTrade } from './helpers/committedPairFixture'

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
    const bound = await createBoundTrade(prisma) // F4: real keys + an E21-admitted trade; bound.commit() = its COMMITTED pair
    const { buyer, seller, trade } = bound
    const offer = await prisma.offer.findUniqueOrThrow({ where: { id: trade.offerId } })
    const boundPairId = await bound.commit()
    const escrow = await prisma.escrow.create({
      data: { tradeId: trade.id, commitmentPairId: type === 'MOCK' ? undefined : boundPairId, type: type as any, status: 'FUNDS_LOCKED', asset: 'BTC', lockedAmount: '0.001', timelockHours: 1, expiresAt },
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
    const bound = await createBoundTrade(prisma) // F4: real keys + an E21-admitted trade; bound.commit() = its COMMITTED pair
    const { buyer, seller, trade } = bound
    const offer = await prisma.offer.findUniqueOrThrow({ where: { id: trade.offerId } })
    const boundPairId = await bound.commit()
    const historicalEscrow = await prisma.escrow.create({
      data: { tradeId: trade.id, commitmentPairId: boundPairId, type: 'MULTISIG', status: 'COMPLETED', asset: 'BTC', lockedAmount: '0.001' },
    })

    await escrowService.sweepExpiredEscrows()

    const reread = await prisma.escrow.findUniqueOrThrow({ where: { id: historicalEscrow.id } })
    expect(reread.status).toBe('COMPLETED')
    const record = await semanticTransitionRecordRepository.findByInteractionAndTransitionType(historicalEscrow.id, 'escrow.timelock.expire')
    expect(record).toBeNull()
  })
})
