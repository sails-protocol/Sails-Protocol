// tests/integration/semanticTransitionRecordAtomicity.test.ts
//
// Sails Core Implementation Program — Bridge Phase M3.5. Real-Postgres
// proof of what a mocked unit test structurally cannot prove: that the
// new semantic_transition_records table and
// commitAuthoritativeEscrowTimelockExpiry()'s atomic claim+insert
// actually behave correctly against a real transactional database —
// a real lost-race leaves no orphaned Record, the real UNIQUE
// constraint on (interactionId, transitionType) rejects a real
// duplicate, real BigInt columns round-trip realistic millisecond
// timestamps exactly, and existing historical Escrow/EscrowEvent rows
// remain fully valid and untouched by the new, empty table.
//
// This mechanism is NOT wired into any live path — see
// semantic-transition-record.ts's own header. This file proves it in
// isolation, per mission §37 ("Testability before authority").

import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { boundOfferRow, boundTradeRow, sellerPixAccount } from './economicFixtures'
import {
  createTransitionRecord,
  createInteractionId,
  createTransitionTypeId,
  createCandidateTransition,
  createRulesetRef,
  LEGACY_UNVERIFIED,
  SAILS_TIMELOCK_EVALUATOR_IDENTITY,
  SAILS_SEMANTIC_PROFILE_IDENTITY,
} from '@sails/core'

const EXPIRY_TRANSITION = { triggeredBy: 'system:expiry-sweeper', eventName: 'settlement.escrow.expired' }

describe('Sails Core Implementation Program M3.5 — SemanticTransitionRecord atomicity (real Postgres)', () => {
  jest.setTimeout(60_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: import('@prisma/client').PrismaClient
  let commitAuthoritativeEscrowTimelockExpiry: typeof import('../../src/modules/open-settlement/semantic-transition-record').commitAuthoritativeEscrowTimelockExpiry
  let semanticTransitionRecordRepository: typeof import('../../src/modules/open-settlement/semantic-transition-record').semanticTransitionRecordRepository

  beforeAll(async () => {
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ commitAuthoritativeEscrowTimelockExpiry, semanticTransitionRecordRepository } = require('../../src/modules/open-settlement/semantic-transition-record'))
  })

  afterAll(async () => {
    if (dbAvailable) await prisma.$disconnect()
  })

  function requirePostgres(name: string): void {
    pg.requirePostgres(name)
  }

  function suffix() { return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }

  function ruleset() {
    return createRulesetRef({
      name: 'Sails Escrow Timelock Expiry Ruleset',
      identity: 'sails-escrow-timelock-expiry-ruleset',
      version: '1.0',
      commitment: 'sails-escrow-timelock-expiry-ruleset@1.0:evaluationTime>=deadline' as any,
      expectedEvaluatorIdentity: SAILS_TIMELOCK_EVALUATOR_IDENTITY,
      expectedProfileIdentity: SAILS_SEMANTIC_PROFILE_IDENTITY,
    })
  }

  function buildRecord(escrowId: string, deadlineMs: number, evaluationTimeMs: number) {
    const interaction = createInteractionId(escrowId)
    return createTransitionRecord({
      interaction,
      priorPosition: LEGACY_UNVERIFIED,
      transition: createCandidateTransition({
        interaction,
        type: createTransitionTypeId('escrow.timelock.expire'),
        payload: { fromState: 'FUNDS_LOCKED', toState: 'EXPIRED', deadlineMs, evaluationTimeMs },
      }),
      rulesetRef: ruleset(),
      evaluatorIdentity: SAILS_TIMELOCK_EVALUATOR_IDENTITY,
      profileIdentity: SAILS_SEMANTIC_PROFILE_IDENTITY,
      conditionResult: 'SATISFIED',
    })
  }

  async function fixtureFundsLockedMultisigEscrow() {
    const s = suffix()
    const buyer = await prisma.user.create({ data: { publicKey: `pk-buyer-str-${s}` } })
    const seller = await prisma.user.create({ data: { publicKey: `pk-seller-str-${s}` } })
    const acct = await sellerPixAccount(prisma, seller.id)
    const offer = await prisma.offer.create({ data: { userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '65000', minAmount: '0.001', maxAmount: '1', ...boundOfferRow(acct) } })
    const trade = await prisma.trade.create({ data: { ...boundTradeRow(acct), offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, asset: 'BTC', amount: '0.001', priceUsd: '65000', totalUsd: '65' } })
    const escrow = await prisma.escrow.create({
      // #235 R7G F8A: expiresAt only ever lands together with the funding outpoint (lockFunds())
      data: { tradeId: trade.id, type: 'MULTISIG', status: 'FUNDS_LOCKED', asset: 'BTC', lockedAmount: '0.001', timelockHours: 1, expiresAt: new Date(Date.now() - 60_000), txLockId: require('crypto').randomBytes(32).toString('hex'), txLockVout: 0 },
    })
    return { escrow }
  }

  it('P1/P2/Y — the happy path commits the State claim and the Record together; the Record is a faithful, exact copy of the committed inputs', async () => {
    requirePostgres('atomic happy path')
    const { escrow } = await fixtureFundsLockedMultisigEscrow()
    const deadlineMs = Date.now() - 60_000
    const evaluationTimeMs = Date.now()

    const result = await commitAuthoritativeEscrowTimelockExpiry(escrow.id, 'FUNDS_LOCKED', 'EXPIRED', buildRecord(escrow.id, deadlineMs, evaluationTimeMs), EXPIRY_TRANSITION)

    expect(result.committed).toBe(true)
    const updated = await prisma.escrow.findUniqueOrThrow({ where: { id: escrow.id } })
    expect(updated.status).toBe('EXPIRED')

    const record = await semanticTransitionRecordRepository.findByInteractionAndTransitionType(escrow.id, 'escrow.timelock.expire')
    expect(record).not.toBeNull()
    expect(record!.fromState).toBe('FUNDS_LOCKED')
    expect(record!.toState).toBe('EXPIRED')
    expect(record!.priorPositionKind).toBe('LEGACY_UNVERIFIED')
    expect(record!.evaluatorIdentityName).toBe('sails-timelock-evaluator')
    expect(record!.profileIdentityName).toBe('sails-semantic-profile')
    expect(record!.conditionResult).toBe('SATISFIED')
    // P6 — committed semantic inputs durable with NO precision loss
    // across the real Postgres BIGINT round trip.
    expect(record!.deadlineMs).toBe(BigInt(deadlineMs))
    expect(record!.evaluationTimeMs).toBe(BigInt(evaluationTimeMs))
  })

  it('P2/V6 — a Record-write failure AFTER a successful State claim rolls the WHOLE transaction back, including the State claim', async () => {
    requirePostgres('record-write failure rolls back the state claim')
    const { escrow } = await fixtureFundsLockedMultisigEscrow()

    // Deterministic, test-only failure injection using the real UNIQUE
    // constraint (§20 — no production authority/config touched): a
    // colliding row for this escrow's own (interactionId, transitionType)
    // pre-exists, so when commitAuthoritativeEscrowTimelockExpiry's OWN
    // claimTransition() succeeds (the escrow really is FUNDS_LOCKED) and
    // it then attempts its own Record insert inside the SAME transaction,
    // that insert is guaranteed to violate the constraint and throw.
    await prisma.semanticTransitionRecord.create({
      data: {
        interactionId: escrow.id, transitionType: 'escrow.timelock.expire',
        fromState: 'FUNDS_LOCKED', toState: 'EXPIRED',
        priorPositionKind: 'LEGACY_UNVERIFIED', priorPositionReference: null,
        rulesetName: 'preexisting', rulesetIdentity: 'preexisting', rulesetVersion: '1.0', rulesetCommitment: 'preexisting',
        rulesetExpectedEvaluatorName: 'x', rulesetExpectedEvaluatorVersion: '1.0',
        rulesetExpectedProfileName: 'x', rulesetExpectedProfileVersion: '1.0',
        evaluatorIdentityName: 'sails-timelock-evaluator', evaluatorIdentityVersion: '1.0',
        profileIdentityName: 'sails-semantic-profile', profileIdentityVersion: '1.0',
        deadlineMs: BigInt(1), evaluationTimeMs: BigInt(2),
        conditionResult: 'SATISFIED',
      },
    })

    await expect(
      commitAuthoritativeEscrowTimelockExpiry(escrow.id, 'FUNDS_LOCKED', 'EXPIRED', buildRecord(escrow.id, Date.now() - 1000, Date.now()), EXPIRY_TRANSITION),
    ).rejects.toThrow()

    // The State claim inside the SAME failed transaction must not have
    // survived — independently re-queried, not inferred from the thrown
    // exception alone.
    const stillLocked = await prisma.escrow.findUniqueOrThrow({ where: { id: escrow.id } })
    expect(stillLocked.status).toBe('FUNDS_LOCKED')
    // Exactly the one pre-existing row remains — our failed attempt's
    // own insert never durably existed.
    const allRecordsForThisEscrow = await prisma.semanticTransitionRecord.findMany({ where: { interactionId: escrow.id } })
    expect(allRecordsForThisEscrow).toHaveLength(1)
    expect(allRecordsForThisEscrow[0].rulesetName).toBe('preexisting')
    // nor did its claimed transition
    expect(await prisma.escrowEvent.count({ where: { escrowId: escrow.id } })).toBe(0)
  })

  it('the claimed transition commits with the State and the Record (one EscrowEvent, one PASS 3 marker), and a transition-claim failure rolls all three back', async () => {
    requirePostgres('transition claim is part of the atomic unit')
    const { escrow } = await fixtureFundsLockedMultisigEscrow()
    const result = await commitAuthoritativeEscrowTimelockExpiry(escrow.id, 'FUNDS_LOCKED', 'EXPIRED', buildRecord(escrow.id, Date.now() - 1000, Date.now()), EXPIRY_TRANSITION)
    expect(result.committed).toBe(true)
    const transitions = await prisma.escrowEvent.findMany({ where: { escrowId: escrow.id, toStatus: 'EXPIRED' } })
    expect(transitions.map((t) => t.id)).toEqual([(result as { transitionId: string }).transitionId])
    expect(await prisma.eventProjectionClaim.count({ where: { eventId: transitions[0].id, projectionKey: 'transition.claimed', subjectId: escrow.id } })).toBe(1)

    // an EXPIRED transition already recorded (by hand) for an escrow still FUNDS_LOCKED: fail closed, commit nothing
    const { escrow: other } = await fixtureFundsLockedMultisigEscrow()
    await prisma.escrowEvent.create({ data: { escrowId: other.id, fromStatus: 'FUNDS_LOCKED', toStatus: 'EXPIRED', triggeredBy: 'by-hand' } })
    await expect(
      commitAuthoritativeEscrowTimelockExpiry(other.id, 'FUNDS_LOCKED', 'EXPIRED', buildRecord(other.id, Date.now() - 1000, Date.now()), EXPIRY_TRANSITION),
    ).rejects.toThrow(/already has a EXPIRED transition/)
    expect((await prisma.escrow.findUniqueOrThrow({ where: { id: other.id } })).status).toBe('FUNDS_LOCKED')
    expect(await semanticTransitionRecordRepository.findByInteractionAndTransitionType(other.id, 'escrow.timelock.expire')).toBeNull()
  })

  it('P2/AA — a real lost race leaves no orphaned Record: the escrow is claimed by a concurrent transition first, and the second attempt commits nothing', async () => {
    requirePostgres('real lost race')
    const { escrow } = await fixtureFundsLockedMultisigEscrow()

    // Simulates a concurrent winner: the escrow has already moved on by
    // the time our attempt's own claimTransition() runs.
    await prisma.escrow.update({ where: { id: escrow.id }, data: { status: 'DISPUTED' } })

    const result = await commitAuthoritativeEscrowTimelockExpiry(escrow.id, 'FUNDS_LOCKED', 'EXPIRED', buildRecord(escrow.id, Date.now() - 1000, Date.now()), EXPIRY_TRANSITION)

    expect(result).toEqual({ committed: false, reason: 'STATE_TRANSITION_LOST_RACE' })
    const stillDisputed = await prisma.escrow.findUniqueOrThrow({ where: { id: escrow.id } })
    expect(stillDisputed.status).toBe('DISPUTED') // untouched by our lost attempt
    const record = await semanticTransitionRecordRepository.findByInteractionAndTransitionType(escrow.id, 'escrow.timelock.expire')
    expect(record).toBeNull() // no Record was ever created for a transition that did not happen
    expect(await prisma.escrowEvent.count({ where: { escrowId: escrow.id, toStatus: 'EXPIRED' } })).toBe(0) // nor a transition
  })

  it('AA/§39 — the real UNIQUE constraint on (interactionId, transitionType) rejects a real duplicate Record', async () => {
    requirePostgres('real duplicate rejection')
    const { escrow } = await fixtureFundsLockedMultisigEscrow()
    const first = await commitAuthoritativeEscrowTimelockExpiry(escrow.id, 'FUNDS_LOCKED', 'EXPIRED', buildRecord(escrow.id, Date.now() - 1000, Date.now()), EXPIRY_TRANSITION)
    expect(first.committed).toBe(true)

    // Attempting to record the SAME transition again (e.g. a naive
    // retry that skips the state check) must fail loudly, never create
    // ambiguous duplicate semantic history.
    await expect(
      semanticTransitionRecordRepository.create({
        interactionId: escrow.id,
        transitionType: 'escrow.timelock.expire',
        fromState: 'FUNDS_LOCKED',
        toState: 'EXPIRED',
        priorPositionKind: 'LEGACY_UNVERIFIED',
        priorPositionReference: null,
        rulesetName: 'x', rulesetIdentity: 'x', rulesetVersion: '1.0', rulesetCommitment: 'x',
        rulesetExpectedEvaluatorName: 'x', rulesetExpectedEvaluatorVersion: '1.0',
        rulesetExpectedProfileName: 'x', rulesetExpectedProfileVersion: '1.0',
        evaluatorIdentityName: 'sails-timelock-evaluator', evaluatorIdentityVersion: '1.0',
        profileIdentityName: 'sails-semantic-profile', profileIdentityVersion: '1.0',
        deadlineMs: BigInt(1), evaluationTimeMs: BigInt(2),
        conditionResult: 'SATISFIED',
      } as any),
    ).rejects.toThrow()
  })

  it('P5/V9 — two genuinely concurrent attempts against the SAME escrow cannot both win: exactly one commits, the other loses the race cleanly', async () => {
    requirePostgres('real concurrent claim')
    const { escrow } = await fixtureFundsLockedMultisigEscrow()

    // Two independent calls fired together — Prisma's connection pool
    // submits them as two separate Postgres transactions/connections,
    // so this is a real race on the same row, not a simulated one.
    // Postgres's own row-level locking on the UPDATE ... WHERE
    // status = 'FUNDS_LOCKED' serializes the two: whichever commits
    // first wins; the other's UPDATE re-evaluates the WHERE clause
    // against the now-changed row and affects 0 rows.
    const [resultA, resultB] = await Promise.all([
      commitAuthoritativeEscrowTimelockExpiry(escrow.id, 'FUNDS_LOCKED', 'EXPIRED', buildRecord(escrow.id, Date.now() - 2000, Date.now()), EXPIRY_TRANSITION),
      commitAuthoritativeEscrowTimelockExpiry(escrow.id, 'FUNDS_LOCKED', 'EXPIRED', buildRecord(escrow.id, Date.now() - 1000, Date.now()), EXPIRY_TRANSITION),
    ])

    const committedResults = [resultA, resultB].filter((r) => r.committed)
    const lostResults = [resultA, resultB].filter((r) => !r.committed)
    expect(committedResults).toHaveLength(1)
    expect(lostResults).toHaveLength(1)
    expect(lostResults[0]).toEqual({ committed: false, reason: 'STATE_TRANSITION_LOST_RACE' })

    // ONE unambiguous authoritative outcome, durably, independently verified.
    const finalEscrow = await prisma.escrow.findUniqueOrThrow({ where: { id: escrow.id } })
    expect(finalEscrow.status).toBe('EXPIRED')
    const allRecordsForThisEscrow = await prisma.semanticTransitionRecord.findMany({ where: { interactionId: escrow.id } })
    expect(allRecordsForThisEscrow).toHaveLength(1) // never two, never zero
  })

  it('P9/§45 — existing historical Escrow/EscrowEvent rows remain fully valid; the new, empty table requires nothing from them', async () => {
    requirePostgres('legacy compatibility')
    const s = suffix()
    const buyer = await prisma.user.create({ data: { publicKey: `pk-buyer-legacy-${s}` } })
    const seller = await prisma.user.create({ data: { publicKey: `pk-seller-legacy-${s}` } })
    const acct = await sellerPixAccount(prisma, seller.id)
    const offer = await prisma.offer.create({ data: { userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '65000', minAmount: '0.001', maxAmount: '1', ...boundOfferRow(acct) } })
    const trade = await prisma.trade.create({ data: { ...boundTradeRow(acct), offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, asset: 'BTC', amount: '0.001', priceUsd: '65000', totalUsd: '65' } })
    const historicalEscrow = await prisma.escrow.create({
      data: { tradeId: trade.id, type: 'MOCK', status: 'COMPLETED', asset: 'BTC', lockedAmount: '0.001' },
    })

    const reread = await prisma.escrow.findUniqueOrThrow({ where: { id: historicalEscrow.id } })
    expect(reread.status).toBe('COMPLETED')
    // No Core provenance exists for this pre-migration transition, and
    // none is fabricated — a simple absence, not a synthesized record.
    const record = await semanticTransitionRecordRepository.findByInteractionAndTransitionType(historicalEscrow.id, 'escrow.timelock.expire')
    expect(record).toBeNull()
  })
})
