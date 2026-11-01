/**
 * Sails Core Implementation Program — Bridge Phase M3.5 (Durable
 * Semantic Transition Record). Proves semantic-transition-record.ts in
 * isolation, per mission §37 ("Testability before authority") — this
 * mechanism is NOT wired into any live path (Core remains
 * non-authoritative; M3 shadow observation is still the only live
 * Core-adjacent behavior in sweepExpiredEscrows() — see
 * tests/expiryShadow.test.ts and tests/sweepers.test.ts, both untouched
 * by this file).
 *
 * What this suite CAN prove at the unit level (mocked Prisma): the
 * mapping from a Core TransitionRecord to the persisted row is faithful
 * and never substitutes/invents a value; the atomic-commit function
 * routes BOTH the State claim and the Record insert through the SAME
 * transaction client, and never creates a Record when the claim lost
 * the race. What it CANNOT prove: that Postgres itself actually rolls
 * back atomically on a real failure, or that the real UNIQUE constraint
 * rejects a real duplicate — those require a real database connection,
 * covered separately (and honestly, gate-respecting) by
 * tests/integration/semanticTransitionRecordAtomicity.test.ts.
 */
import {
  createTransitionRecord,
  createInteractionId,
  createTransitionTypeId,
  createCandidateTransition,
  createRulesetRef,
  createSemanticHistoryPosition,
  LEGACY_UNVERIFIED,
  SAILS_TIMELOCK_EVALUATOR_IDENTITY,
  SAILS_SEMANTIC_PROFILE_IDENTITY,
  createCanonicalEvaluatorIdentity,
  createCanonicalSemanticProfileIdentity,
  TransitionRecord,
  RulesetRef,
} from '@sails/core'
import * as fs from 'fs'
import * as path from 'path'
import { checkDirectory } from '../scripts/check-core-boundary'
import { checkEvaluatorConformance } from '../scripts/run-conformance-harness'
import { referenceTimelockEvaluator, TimelockInput } from '../packages/sails-core/src/evaluators/timelock-evaluator'

const REPO_ROOT = path.resolve(__dirname, '..')

const mockSemanticTransitionRecordCreate = jest.fn(async ({ data }: any) => ({ id: 'record-1', createdAt: new Date(), ...data }))
const mockSemanticTransitionRecordFindUnique = jest.fn(async () => null)
const mockEscrowUpdateMany = jest.fn(async () => ({ count: 1 }))
const mockTxEscrowEventCreate = jest.fn(async ({ data }: any) => ({ id: 'transition-1', ...data }))
const mockTxClaimMarkerCreate = jest.fn(async () => ({}))

jest.mock('../src/common/database', () => ({
  prisma: {
    semanticTransitionRecord: {
      create: (...args: unknown[]) => (mockSemanticTransitionRecordCreate as any)(...args),
      findUnique: (...args: unknown[]) => (mockSemanticTransitionRecordFindUnique as any)(...args),
    },
    escrow: {
      updateMany: (...args: unknown[]) => (mockEscrowUpdateMany as any)(...args),
    },
    $transaction: jest.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        $executeRaw: jest.fn(async () => 0),
        semanticTransitionRecord: { create: (...args: unknown[]) => (mockSemanticTransitionRecordCreate as any)(...args) },
        escrow: { updateMany: (...args: unknown[]) => (mockEscrowUpdateMany as any)(...args) },
        escrowEvent: { findFirst: jest.fn(async () => null), create: (...args: unknown[]) => (mockTxEscrowEventCreate as any)(...args) },
        eventProjectionClaim: { create: (...args: unknown[]) => (mockTxClaimMarkerCreate as any)(...args) },
      }),
    ),
  },
}))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  toSemanticTransitionRecordRow,
  semanticTransitionRecordRepository,
  commitAuthoritativeEscrowTimelockExpiry,
} = require('../src/modules/open-settlement/semantic-transition-record')

function ruleset(overrides: Partial<Parameters<typeof createRulesetRef>[0]> = {}): RulesetRef {
  return createRulesetRef({
    name: 'Sails Escrow Timelock Expiry Ruleset',
    identity: 'sails-escrow-timelock-expiry-ruleset',
    version: '1.0',
    commitment: 'sails-escrow-timelock-expiry-ruleset@1.0:evaluationTime>=deadline' as any,
    expectedEvaluatorIdentity: SAILS_TIMELOCK_EVALUATOR_IDENTITY,
    expectedProfileIdentity: SAILS_SEMANTIC_PROFILE_IDENTITY,
    ...overrides,
  })
}

function buildValidRecord(overrides: Partial<TransitionRecord<any>> = {}): TransitionRecord<any> {
  const interaction = createInteractionId('escrow-1')
  return createTransitionRecord({
    interaction,
    priorPosition: LEGACY_UNVERIFIED,
    transition: createCandidateTransition({
      interaction,
      type: createTransitionTypeId('escrow.timelock.expire'),
      payload: { fromState: 'FUNDS_LOCKED', toState: 'EXPIRED', deadlineMs: 1_700_000_000_000, evaluationTimeMs: 1_700_000_001_000 },
    }),
    rulesetRef: ruleset(),
    evaluatorIdentity: SAILS_TIMELOCK_EVALUATOR_IDENTITY,
    profileIdentity: SAILS_SEMANTIC_PROFILE_IDENTITY,
    conditionResult: 'SATISFIED',
    ...overrides,
  })
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('K. Minimum Record fields — pure mapping fidelity', () => {
  it('maps every field from the Core TransitionRecord verbatim, never inventing or substituting a value', () => {
    const row = toSemanticTransitionRecordRow(buildValidRecord())
    expect(row).toEqual({
      interactionId: 'escrow-1',
      transitionType: 'escrow.timelock.expire',
      fromState: 'FUNDS_LOCKED',
      toState: 'EXPIRED',
      priorPositionKind: 'LEGACY_UNVERIFIED',
      priorPositionReference: null,
      rulesetName: 'Sails Escrow Timelock Expiry Ruleset',
      rulesetIdentity: 'sails-escrow-timelock-expiry-ruleset',
      rulesetVersion: '1.0',
      rulesetCommitment: 'sails-escrow-timelock-expiry-ruleset@1.0:evaluationTime>=deadline',
      rulesetExpectedEvaluatorName: 'sails-timelock-evaluator',
      rulesetExpectedEvaluatorVersion: '1.0',
      rulesetExpectedProfileName: 'sails-semantic-profile',
      rulesetExpectedProfileVersion: '1.0',
      evaluatorIdentityName: 'sails-timelock-evaluator',
      evaluatorIdentityVersion: '1.0',
      profileIdentityName: 'sails-semantic-profile',
      profileIdentityVersion: '1.0',
      deadlineMs: BigInt(1_700_000_000_000),
      evaluationTimeMs: BigInt(1_700_000_001_000),
      conditionResult: 'SATISFIED',
    })
  })
})

describe('U. Legacy history strategy — Migration Genesis', () => {
  it('the first Record for a migrating Interaction binds LEGACY_UNVERIFIED, never a fabricated prior position', () => {
    const row = toSemanticTransitionRecordRow(buildValidRecord())
    expect(row.priorPositionKind).toBe('LEGACY_UNVERIFIED')
    expect(row.priorPositionReference).toBeNull()
  })

  it('a RESOLVED priorPosition (a future, non-genesis transition) is representable — both frozen union arms supported, not just genesis', () => {
    const interaction = createInteractionId('escrow-2')
    const resolved = createSemanticHistoryPosition({
      interaction,
      rulesetRef: ruleset(),
      evaluatorIdentity: SAILS_TIMELOCK_EVALUATOR_IDENTITY,
      profileIdentity: SAILS_SEMANTIC_PROFILE_IDENTITY,
      reference: { escrowEventEntryHash: 'abc123' },
    })
    const row = toSemanticTransitionRecordRow(buildValidRecord({ interaction, priorPosition: resolved }))
    expect(row.priorPositionKind).toBe('RESOLVED')
    expect(row.priorPositionReference).toBe(JSON.stringify({ escrowEventEntryHash: 'abc123' }))
  })
})

describe('T. Attribution status / K3 Outcome — refused, never silently dropped', () => {
  it('throws if a Record somehow carries discretionary attribution — this slice never has one', () => {
    const record = buildValidRecord({
      attribution: { actor: 'actor-1' as any, rawProof: {}, resolvedIdentityReference: {} },
    })
    expect(() => toSemanticTransitionRecordRow(record)).toThrow(/discretionary attribution/)
  })

  it('throws if a Record somehow carries an economic Outcome — this slice never has one', () => {
    const record = buildValidRecord({ outcome: { content: {}, destination: undefined } as any })
    expect(() => toSemanticTransitionRecordRow(record)).toThrow(/economic Outcome/)
  })
})

describe('L/M. Actual evaluator/profile identity is durable and distinguishable from expected', () => {
  it('a Record produced under a mismatched actual evaluator identity preserves the ACTUAL identity, not the Ruleset\'s expected one', () => {
    const wrongEvaluator = createCanonicalEvaluatorIdentity('some-other-evaluator', '9.9')
    const row = toSemanticTransitionRecordRow(buildValidRecord({ evaluatorIdentity: wrongEvaluator }))
    expect(row.evaluatorIdentityName).toBe('some-other-evaluator')
    expect(row.evaluatorIdentityVersion).toBe('9.9')
    // The Ruleset's own expected identity is preserved SEPARATELY and
    // unchanged — the mismatch itself is visible on the persisted row,
    // never silently reconciled.
    expect(row.rulesetExpectedEvaluatorName).toBe('sails-timelock-evaluator')
  })

  it('a Record produced under a mismatched actual profile identity preserves the ACTUAL identity, not the Ruleset\'s expected one', () => {
    const wrongProfile = createCanonicalSemanticProfileIdentity('some-other-profile', '2.0')
    const row = toSemanticTransitionRecordRow(buildValidRecord({ profileIdentity: wrongProfile }))
    expect(row.profileIdentityName).toBe('some-other-profile')
    expect(row.rulesetExpectedProfileName).toBe('sails-semantic-profile')
  })
})

describe('N. Ruleset binding is durable and distinguishable across versions', () => {
  it('two Records under different Ruleset versions each retain their own version, never the other\'s', () => {
    const rowV1 = toSemanticTransitionRecordRow(buildValidRecord())
    const rowV2 = toSemanticTransitionRecordRow(buildValidRecord({ rulesetRef: ruleset({ version: '2.0' }) }))
    expect(rowV1.rulesetVersion).toBe('1.0')
    expect(rowV2.rulesetVersion).toBe('2.0')
  })
})

describe('Q/R. Transition and Interaction binding are exact — no cross-scope reuse', () => {
  it('two Records for different Interactions never share an interactionId', () => {
    const rowA = toSemanticTransitionRecordRow(buildValidRecord())
    const interactionB = createInteractionId('escrow-2')
    const rowB = toSemanticTransitionRecordRow(
      buildValidRecord({
        interaction: interactionB,
        transition: createCandidateTransition({
          interaction: interactionB,
          type: createTransitionTypeId('escrow.timelock.expire'),
          payload: { fromState: 'FUNDS_LOCKED', toState: 'EXPIRED', deadlineMs: 1, evaluationTimeMs: 2 },
        }),
      }),
    )
    expect(rowA.interactionId).toBe('escrow-1')
    expect(rowB.interactionId).toBe('escrow-2')
    expect(rowA.interactionId).not.toBe(rowB.interactionId)
  })

  it('a timelock SATISFIED decision for FUNDS_LOCKED->EXPIRED cannot be reused as authorization for FUNDS_LOCKED->REFUNDED — the transitionType/toState are bound, not merely the ConditionResult', () => {
    const expiredRow = toSemanticTransitionRecordRow(buildValidRecord())
    const interaction = createInteractionId('escrow-3')
    const refundRow = toSemanticTransitionRecordRow(
      buildValidRecord({
        interaction,
        transition: createCandidateTransition({
          interaction,
          type: createTransitionTypeId('escrow.timelock.expire'), // same underlying decision
          payload: { fromState: 'FUNDS_LOCKED', toState: 'REFUNDED', deadlineMs: 1, evaluationTimeMs: 2 }, // different target State
        }),
      }),
    )
    expect(expiredRow.toState).toBe('EXPIRED')
    expect(refundRow.toState).toBe('REFUNDED')
    // Both rows exist as DISTINCT records with their own toState — a
    // consumer checking `toState` can never confuse one for the other,
    // and the replay-resistance unique index below is keyed on
    // (interactionId, transitionType), so this specific pairing would
    // additionally require a schema-level decision if `type` were ever
    // reused for genuinely different toStates on the SAME interaction —
    // flagged as the documented, deliberate narrowness of the current
    // unique key (see the Prisma model's own comment).
  })
})

describe('P/O. Input durability — no precision loss across the JS number -> BigInt boundary', () => {
  it('realistic millisecond-since-epoch values round-trip exactly', () => {
    const deadlineMs = Date.now()
    const evaluationTimeMs = deadlineMs + 3600_000
    const row = toSemanticTransitionRecordRow(
      buildValidRecord({
        transition: createCandidateTransition({
          interaction: createInteractionId('escrow-1'),
          type: createTransitionTypeId('escrow.timelock.expire'),
          payload: { fromState: 'FUNDS_LOCKED', toState: 'EXPIRED', deadlineMs, evaluationTimeMs },
        }),
      }),
    )
    expect(row.deadlineMs).toBe(BigInt(deadlineMs))
    expect(row.evaluationTimeMs).toBe(BigInt(evaluationTimeMs))
    expect(Number(row.deadlineMs)).toBe(deadlineMs)
  })
})

const EXPIRY_TRANSITION = { triggeredBy: 'system:expiry-sweeper', eventName: 'settlement.escrow.expired' }

describe('Y/Z. Atomicity — the State claim, the Record insert and the transition claim share ONE transaction client', () => {
  it('the happy path routes ALL of them through the SAME tx object, never the raw top-level prisma client', async () => {
    const result = await commitAuthoritativeEscrowTimelockExpiry('escrow-1', 'FUNDS_LOCKED', 'EXPIRED', buildValidRecord(), EXPIRY_TRANSITION)
    expect(result).toMatchObject({ committed: true, transitionId: 'transition-1' })
    expect(mockEscrowUpdateMany).toHaveBeenCalledTimes(1)
    expect(mockSemanticTransitionRecordCreate).toHaveBeenCalledTimes(1)
    // the claimed transition (hash-chained EscrowEvent + its PASS 3 marker) commits with the state
    expect(mockTxEscrowEventCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ escrowId: 'escrow-1', fromStatus: 'FUNDS_LOCKED', toStatus: 'EXPIRED', triggeredBy: 'system:expiry-sweeper' }) }))
    expect(mockTxClaimMarkerCreate).toHaveBeenCalledWith({ data: { eventId: 'transition-1', projectionKey: 'transition.claimed', subjectId: 'escrow-1' } })
  })

  it('P2/AA — a lost race (claimedCount === 0) means neither the Record nor a transition is EVER created: a Record must never claim a transition that did not happen', async () => {
    mockEscrowUpdateMany.mockResolvedValueOnce({ count: 0 })
    const result = await commitAuthoritativeEscrowTimelockExpiry('escrow-1', 'FUNDS_LOCKED', 'EXPIRED', buildValidRecord(), EXPIRY_TRANSITION)
    expect(result).toEqual({ committed: false, reason: 'STATE_TRANSITION_LOST_RACE' })
    expect(mockSemanticTransitionRecordCreate).not.toHaveBeenCalled()
    expect(mockTxEscrowEventCreate).not.toHaveBeenCalled()
  })
})

describe('M4 (retry) — this mechanism now has exactly the one live caller the mission authorized', () => {
  it('escrow.service.ts wires commitAuthoritativeEscrowTimelockExpiry() into sweepExpiredEscrows() — Core is now authoritative for the target slice', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src', 'modules', 'open-settlement', 'escrow.service.ts'), 'utf8')
    expect(source).toContain('commitAuthoritativeEscrowTimelockExpiry')
  })
})

describe('AD. Pure Core boundary remains intact', () => {
  it('packages/sails-core/src is still clean — M3.5 added a Runtime-only module, never touched Core', () => {
    const violations = checkDirectory(path.join(REPO_ROOT, 'packages', 'sails-core', 'src'))
    expect(violations).toEqual([])
  })
})

describe('AE. M2 conformance remains intact', () => {
  it('the reference timelock evaluator still passes every canonical vector', () => {
    const report = checkEvaluatorConformance('sails-timelock-evaluator@1.0', referenceTimelockEvaluator, (raw) => raw as TimelockInput)
    expect(report.conformant).toBe(true)
  })
})

describe('Repository thin-wrapper behavior', () => {
  it('findByInteractionAndTransitionType queries the exact compound unique key', async () => {
    // Sails Core Implementation Program M8-R — the compound unique key
    // grew a third column (appealRound) so a second, appeal-repeatable
    // decision class (Mission13 dispute ruling) can coexist with this
    // slice's own single-shot expiry transition. M4's own records always
    // carry the sentinel -1 ("not applicable to this transition type").
    await semanticTransitionRecordRepository.findByInteractionAndTransitionType('escrow-1', 'escrow.timelock.expire')
    expect(mockSemanticTransitionRecordFindUnique).toHaveBeenCalledWith({
      where: { interactionId_transitionType_appealRound: { interactionId: 'escrow-1', transitionType: 'escrow.timelock.expire', appealRound: -1 } },
    })
  })
})
