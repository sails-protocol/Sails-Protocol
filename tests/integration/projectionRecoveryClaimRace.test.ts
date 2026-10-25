// tests/integration/projectionRecoveryClaimRace.test.ts
//
// PASS 3 queue claim (claimTransitionRecoveryBatch): two OVERLAPPING claims must receive DISJOINT batches.
//
// The claim is `WITH picked AS (SELECT ... ORDER BY ... LIMIT n FOR UPDATE SKIP LOCKED) UPDATE ... SET projectionRecoveryAttemptedAt`.
// In READ COMMITTED a statement takes its snapshot when it STARTS. SKIP LOCKED skips rows another transaction holds locked right now,
// but not rows another claim already updated AND committed after this statement's snapshot and before it reached them: those rows
// are locked successfully and re-checked only against the WHERE predicate (still queued, still claimed, still unprojected), which the
// first claim's stamp does not change - the stamp moves the row in the ORDER BY, and the ORDER BY is not re-evaluated. Both claims
// then return the same rows. Measured at SQL level on PostgreSQL 16, two connections, 16 queued rows, LIMIT 8 each: 33 of 400 trials
// overlapped (8.3%, 192 wasted slots); with a 150 ms sleep per scanned row in the second claim's WHERE, 5 of 5.
//
// Consequence: a duplicate claim re-drives a transition twice (harmless: the publish lock and the projection claims make that a
// no-op) but WASTES the batch's slots, so a transition the fairness bound promises within ceil(older/limit) runs can be delayed one run.
//
// This file runs the production function itself many times with two concurrent callers over fixtures at the head of the queue.
// Against the unfixed claim each trial overlaps with probability ~8%, so the failure is practically certain (0.917^TRIALS).

import { createPostgresIntegrationHarness } from './postgresTestHarness'

const QUEUE_HEAD = Date.parse('1999-01-01T00:00:00.000Z') // ahead of every row other suites leave in a shared database
const TRIALS = 150
const FIXTURES = 16
const LIMIT = 8

describe('PASS 3 queue claim: overlapping claims receive disjoint batches (real PostgreSQL)', () => {
  jest.setTimeout(300_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: any
  let claimTransitionRecoveryBatch: (limit: number, claimedBefore: Date) => Promise<Array<{ id: string; eventId: string; subjectId: string }>>
  const prefix = `p3race-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  beforeAll(async () => {
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ claimTransitionRecoveryBatch } = require('../../src/common/events/event-projection'))
  })

  afterAll(async () => {
    if (!dbAvailable) return
    await prisma.eventProjectionClaim.deleteMany({ where: { eventId: { startsWith: prefix } } })
    await prisma.$disconnect()
  })

  it(`${TRIALS} trials of two concurrent claims of ${LIMIT} over ${FIXTURES} queued rows: never the same row twice, always all ${FIXTURES} covered`, async () => {
    pg.requirePostgres('claim race')
    const overlaps: Array<{ trial: number; shared: string[] }> = []
    const incomplete: number[] = []
    for (let trial = 0; trial < TRIALS; trial++) {
      const eventIds = Array.from({ length: FIXTURES }, (_, i) => `${prefix}-${trial}-${i}`)
      await prisma.eventProjectionClaim.createMany({
        data: eventIds.map((eventId, i) => ({
          id: `claim-${eventId}`, eventId, projectionKey: 'transition.claimed', subjectId: `escrow-${eventId}`,
          appliedAt: new Date(QUEUE_HEAD + (trial * FIXTURES + i) * 1000),
        })),
      })
      const grace = new Date()
      const [a, b] = await Promise.all([claimTransitionRecoveryBatch(LIMIT, grace), claimTransitionRecoveryBatch(LIMIT, grace)])
      const mine = new Set(eventIds)
      const ea = a.map((c) => c.eventId).filter((e) => mine.has(e))
      const eb = b.map((c) => c.eventId).filter((e) => mine.has(e))
      const shared = ea.filter((e) => eb.includes(e))
      if (shared.length) overlaps.push({ trial, shared })
      if (new Set([...ea, ...eb]).size !== FIXTURES) incomplete.push(trial)
      // park the fixtures out of the queue so the next trial's claims see only its own rows at the head
      await prisma.eventProjectionClaim.updateMany({ where: { eventId: { in: eventIds } }, data: { transitionProjectedAt: new Date() } })
    }
    expect({ overlappingTrials: overlaps.length, firstOverlaps: overlaps.slice(0, 3), trialsNotCoveringAllRows: incomplete.length }).toEqual({ overlappingTrials: 0, firstOverlaps: [], trialsNotCoveringAllRows: 0 })
  })
})
