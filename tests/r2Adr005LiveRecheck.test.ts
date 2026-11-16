/**
 * R2 (ADR-005 §4, CTO 306/316 alternative A) - the MULTISIG broadcast gate re-reads the live dispute, which is stricter
 * than §4's reuse of a committed economic disposition authorization. The two coincide only while no reachable writer
 * takes a MULTISIG dispute out of RESOLVED after its authorization is committed. These tests pin that premise, so a
 * change that breaks it (appeal enabled for a script-committed arbiter, a new non-CAS dispute writer, a new writer that
 * leaves RESOLVED) fails here and forces the R2 decision to be revisited before it ships.
 *
 *   R2-a  appeal() refuses a MULTISIG (script-committed arbiter) dispute and writes nothing.
 *   R2-b  with a committed, matching authorization, the gate refuses when the live dispute left the authorized
 *         generation (control: it passes while the dispute is still RESOLVED in it).
 *   R2-c  static inventory of src: no unconditional dispute writer, and the writers that can take a dispute out of
 *         RESOLVED are exactly the three known ones.
 */
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

const mockDisputeFindUnique = jest.fn()
const mockDisputeUpdateMany = jest.fn()
const mockTradeFindUnique = jest.fn()
const mockEscrowParticipantKeyFindUnique = jest.fn()
const mockEdaFindUnique = jest.fn()
const mockEscrowFindUnique = jest.fn()
const mockLoadRulingRecord = jest.fn()
const mockAssertTranslation = jest.fn()

jest.mock('../src/common/database', () => ({
  prisma: {
    dispute: {
      findUnique: (...args: unknown[]) => mockDisputeFindUnique(...args),
      updateMany: (...args: unknown[]) => mockDisputeUpdateMany(...args),
    },
    trade: { findUnique: (...args: unknown[]) => mockTradeFindUnique(...args) },
    escrowParticipantKey: { findUnique: (...args: unknown[]) => mockEscrowParticipantKeyFindUnique(...args) },
    economicDispositionAuthorization: { findUnique: (...args: unknown[]) => mockEdaFindUnique(...args) },
    escrow: { findUnique: (...args: unknown[]) => mockEscrowFindUnique(...args) },
  },
}))
jest.mock('../src/common/events/event-bus', () => ({ eventBus: { emit: jest.fn().mockResolvedValue(undefined) } }))
jest.mock('../src/modules/open-settlement/dispute-outcome', () => ({
  ...jest.requireActual('../src/modules/open-settlement/dispute-outcome'),
  loadDisputeRulingRecord: (...args: unknown[]) => mockLoadRulingRecord(...args),
  fromDisputeRulingRow: () => ({ outcome: { kind: 'stub', content: { ruling: 'RELEASE' } } }),
}))
jest.mock('../src/modules/open-settlement/dispatch-translation-guard', () => ({
  ...jest.requireActual('../src/modules/open-settlement/dispatch-translation-guard'),
  assertTranslationMatchesOutcome: (...args: unknown[]) => mockAssertTranslation(...args),
}))
jest.mock('../src/modules/open-settlement/multisig.provider', () => ({ networkFor: () => 'regtest-network' }))
jest.mock('../src/config', () => ({ config: { multisig: { network: 'regtest' } } }))

import { DisputeService } from '../src/modules/open-settlement/dispute.service'
import type { ArbitrationProvider } from '../src/modules/open-settlement/arbitration-provider'
import {
  assertDurableEconomicDispositionAuthorization,
  economicDispositionOperationDigest,
} from '../src/modules/open-settlement/economic-disposition-authority'

const pending = {
  id: 'pending-r2',
  escrowId: 'escrow-r2',
  kind: 'release',
  toAddress: 'bc1qbuyer',
  toAddressSecondary: null,
  buyerBps: null,
  feeCollectionSats: 100,
  feeCollectionWaived: false,
  minerFeeSats: 250,
  unsignedPsbtBase64: 'cHNidP8BAA==',
  requiredSigners: ['buyer-1', 'arbiter-1'],
  triggeredBy: 'arbiter-1',
  disputeId: 'dispute-r2',
  rulingAppealRound: 0,
  rulingArbiterId: 'arbiter-1',
  rulingOutcome: 'RELEASE',
  rulingAuthoritySignature: 'sig-generation-0',
  rulingAuthorityIssuedAt: new Date('2026-11-16T00:00:00.000Z'),
}

const authorization = {
  pendingOperationId: pending.id,
  escrowId: pending.escrowId,
  disputeId: pending.disputeId,
  operationDigest: economicDispositionOperationDigest(pending as any),
  appealRound: 0,
  arbiterId: 'arbiter-1',
  ruling: 'RELEASE',
}

const resolvedDispute = {
  id: 'dispute-r2', status: 'RESOLVED', appealRound: 0, arbiterId: 'arbiter-1', ruling: 'RELEASE', authoritySignature: 'sig-generation-0',
}

beforeEach(() => {
  jest.clearAllMocks()
  mockEdaFindUnique.mockResolvedValue(authorization)
  mockEscrowFindUnique.mockResolvedValue({ type: 'MULTISIG' })
  mockLoadRulingRecord.mockResolvedValue({ outcomeContent: { ruling: 'RELEASE' } })
  mockAssertTranslation.mockReturnValue(undefined)
})

describe('R2-a - appeal() keeps a MULTISIG dispute RESOLVED', () => {
  it('refuses to appeal a dispute whose escrow has a script-committed arbiter and writes nothing', async () => {
    mockDisputeFindUnique.mockResolvedValue({ ...resolvedDispute, tradeId: 'trade-r2', escrowId: 'escrow-r2' })
    mockTradeFindUnique.mockResolvedValue({ id: 'trade-r2', buyerId: 'buyer-1', sellerId: 'seller-1' })
    mockEscrowParticipantKeyFindUnique.mockResolvedValue({ participantId: 'arbiter-1', role: 'arbiter', escrowId: 'escrow-r2' })
    const provider: ArbitrationProvider = { name: 'market-arbitration', arbitrators: [], assign: jest.fn(), assignAppealPanel: jest.fn().mockResolvedValue('arb-new') }

    await expect(new DisputeService(provider).appeal('dispute-r2', 'buyer-1')).rejects.toThrow('cannot reassign arbitration authority')
    expect(provider.assignAppealPanel).not.toHaveBeenCalled()
    expect(mockDisputeUpdateMany).not.toHaveBeenCalled()
  })
})

describe('R2-b - the broadcast gate re-reads the live dispute (stricter than ADR-005 §4 reuse)', () => {
  it('control: committed authorization and a dispute still RESOLVED in that generation pass', async () => {
    mockDisputeFindUnique.mockResolvedValue(resolvedDispute)
    await expect(assertDurableEconomicDispositionAuthorization(pending as any)).resolves.toBeUndefined()
  })

  it.each([
    ['left RESOLVED (APPEALED)', { status: 'APPEALED' }],
    ['left RESOLVED (EVIDENCE_SUBMITTED)', { status: 'EVIDENCE_SUBMITTED' }],
    ['moved to a later appeal round', { appealRound: 1 }],
    ['ruling replaced', { ruling: 'REFUND' }],
    ['arbiter replaced', { arbiterId: 'arbiter-2' }],
    ['authority signature replaced', { authoritySignature: 'sig-generation-1' }],
  ])('refuses although the authorization is committed and matches, when the live dispute %s', async (_label, change) => {
    mockDisputeFindUnique.mockResolvedValue({ ...resolvedDispute, ...change })
    await expect(assertDurableEconomicDispositionAuthorization(pending as any)).rejects.toThrow(/is not RESOLVED in the authorized generation/)
  })
})

describe('R2-c - static inventory of dispute writers in src', () => {
  const SRC = join(__dirname, '..', 'src')
  const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : []
  })
  // Comments mention the old unconditional writers by name; only code counts.
  const code = (path: string) => readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const sources = files(SRC).map((path) => ({ path: path.slice(SRC.length + 1).replace(/\\/g, '/'), text: code(path) }))

  it('has no unconditional dispute writer (update/upsert/delete by id alone)', () => {
    const offenders = sources.flatMap(({ path, text }) =>
      [...text.matchAll(/\.dispute\.(update|upsert|delete|deleteMany)\(/g)].map((m) => `${path}: .dispute.${m[1]}(`))
    expect(offenders).toEqual([])
  })

  it('every dispute updateMany is conditional on the dispute status or on the unassigned arbiter', () => {
    const writers = sources.flatMap(({ path, text }) =>
      [...text.matchAll(/\.dispute\.updateMany\(\{\s*where:\s*\{([\s\S]*?)\},?\s*data:/g)].map((m) => ({ path, where: m[1] })))
    expect(writers.length).toBeGreaterThanOrEqual(8) // the scan must see the real writers, not pass vacuously
    const unguarded = writers.filter(({ where }) => !/\bstatus\s*:/.test(where) && !/arbiterId:\s*null/.test(where))
    expect(unguarded.map(({ path, where }) => `${path}: where {${where.trim()}}`)).toEqual([])
  })

  it('the writers that can take a dispute out of RESOLVED are exactly the three known ones', () => {
    // revertRuling (failed dispatch before any claim), the R-1 live-ruling revert (only when no round and no economic
    // disposition authorization exists for the generation) and appeal() (refused for script-committed arbiters, R2-a).
    const leaving = sources.flatMap(({ path, text }) =>
      [...text.matchAll(/\.dispute\.updateMany\(\{\s*where:\s*\{([\s\S]*?)\},?\s*data:\s*\{([\s\S]*?)\}\s*,?\s*\}\)/g)]
        .filter((m) => /status:\s*'RESOLVED'/.test(m[1]))
        .map(() => path))
    expect(leaving).toEqual([
      'modules/open-settlement/dispute.service.ts',
      'modules/open-settlement/dispute.service.ts',
      'modules/open-settlement/dispute.service.ts',
    ])
    const raw = sources.flatMap(({ path, text }) =>
      [...text.matchAll(/UPDATE\s+"disputes"[\s\S]*?WHERE([\s\S]*?)`/g)].filter((m) => /"status"\s*=\s*'RESOLVED'/.test(m[1])).map(() => path))
    expect(raw).toEqual([])
  })
})
