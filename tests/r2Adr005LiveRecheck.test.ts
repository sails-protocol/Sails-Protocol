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
 *         RESOLVED are exactly the three known ones. Raw SQL writers of disputes (any spelling) are inventoried too:
 *         exactly the known ones, each guarded by status, none leaving RESOLVED (GK C7b, CTO 341).
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
    expect(writers.length).toBeGreaterThanOrEqual(7) // the scan must see the real writers, not pass vacuously
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

  // --- detector (pure, so the mutants below can be fed to it directly) ---------------------------------------------
  const RAW_DISPUTE_WRITE = /\b(update(?:\s+only)?|insert\s+into|delete\s+from)\s+(?:"?public"?\s*\.\s*)?"?disputes"?(?![\w"])/gi
  const rawDisputeWrites = (text: string) => [...text.matchAll(RAW_DISPUTE_WRITE)].map((m) => {
    const rest = text.slice(m.index)
    const end = rest.indexOf('`') // a template literal ends at its backtick; a plain string is bounded by length
    const statement = end === -1 ? rest.slice(0, 600) : rest.slice(0, end)
    const set = /\bset\b([\s\S]*?)(?:\bfrom\b|\bwhere\b|$)/i.exec(statement)?.[1] ?? ''
    return { verb: m[1].toLowerCase().replace(/\s+/g, ' '), where: statement.split(/\bwhere\b/i).slice(1).join(' WHERE '), set }
  })
  const statusGuarded = (where: string) => /\bstatus"?\s*(=|<>|!=|\bin\b)/i.test(where)
  // A writer that is conditional on RESOLVED may only set the C4 queue stamp. Any other column (status, ruling, arbiterId,
  // authoritySignature, appealRound...) is a dispute fact the ADR-005 gate re-reads, so it is flagged.
  const STAMP_ONLY = ['dispatchRecoveryAttemptedAt']
  const leavesResolved = (w: { where: string; set: string }) =>
    /\bstatus"?\s*(=|\bin\b)[^)]*'RESOLVED'/i.test(w.where) &&
    [...w.set.matchAll(/"?(\w+)"?\s*=/g)].some((c) => !STAMP_ONLY.includes(c[1]))

  // The raw writers that exist in src today (dispute.service.ts: auto-resolution contest/expire and persistEvidence). Each is
  // conditional on status and none leaves RESOLVED. A new raw writer must be added here deliberately, with its guard (e.g. the C4
  // dispatch-recovery stamp, which sets only dispatchRecoveryAttemptedAt and must keep `AND d.status = 'RESOLVED'`).
  const KNOWN_RAW_DISPUTE_WRITERS = [
    'modules/open-settlement/dispute.service.ts update',
    'modules/open-settlement/dispute.service.ts update',
    'modules/open-settlement/dispute.service.ts update', // persistEvidence (#674): atomic append, status IN (OPENED, EVIDENCE_SUBMITTED) AND ruling IS NULL
    'modules/open-settlement/dispute-dispatch-recovery.ts update', // claimCandidates (#675): C4 queue stamp; SET only dispatchRecoveryAttemptedAt, guarded by d.status = 'RESOLVED'
  ]

  describe('R2-c (raw SQL) - every raw writer of disputes is inventoried and status-guarded', () => {
    it('the raw writers in src are exactly the known ones', () => {
      const found = sources.flatMap(({ path, text }) => rawDisputeWrites(text).map((w) => `${path} ${w.verb}`)).sort()
      expect(found).toEqual([...KNOWN_RAW_DISPUTE_WRITERS].sort())
    })

    it('every raw UPDATE is conditional on status, and none takes a dispute out of RESOLVED', () => {
      const writes = sources.flatMap(({ path, text }) => rawDisputeWrites(text).map((w) => ({ path, ...w })))
      expect(writes.length).toBeGreaterThanOrEqual(4) // the scan must see the real writers, not pass vacuously
      expect(writes.filter((w) => !statusGuarded(w.where)).map((w) => `${w.path}: ${w.verb} where {${w.where.trim()}}`)).toEqual([])
      expect(writes.filter((w) => leavesResolved(w)).map((w) => w.path)).toEqual([])
    })

    // The detector itself: each spelling a raw writer can take must be seen, and an unguarded one must fail the guard.
    const MUTANTS: Array<[string, string]> = [
      ['GK C7b: unquoted, id only', 'export async function zz(id: string) { return prisma.$executeRaw`UPDATE disputes SET status = \'APPEALED\' WHERE id = ${id}` }'],
      ['inside a transaction (tx client)', 'await tx.$executeRaw`UPDATE "disputes" SET "ruling" = NULL WHERE "id" = ${id}`'],
      ['$executeRawUnsafe plain string', "await prisma.$executeRawUnsafe('UPDATE disputes SET status = $1 WHERE id = $2', s, id)"],
      ['lower case, multi-line', 'await tx.$executeRaw`update\n  disputes\n  set status = \'OPENED\'\n where id = ${id}`'],
      ['public.disputes', 'await tx.$executeRaw`UPDATE public.disputes SET "ruling" = NULL WHERE "id" = ${id}`'],
      ['"public"."disputes"', 'await tx.$executeRaw`UPDATE "public"."disputes" SET "ruling" = NULL WHERE "id" = ${id}`'],
      ['Prisma.sql fragment passed on', 'const frag = Prisma.sql`UPDATE disputes SET "ruling" = NULL WHERE "id" = ${id}`; await tx.$executeRaw(frag)'],
      ['alias', 'await tx.$executeRaw`UPDATE disputes d SET "ruling" = NULL FROM picked WHERE d."id" = picked.id`'],
      ['DELETE', 'await tx.$executeRaw`DELETE FROM disputes WHERE id = ${id}`'],
    ]
    it.each(MUTANTS)('detector sees the raw writer: %s', (_name, snippet) => {
      expect(rawDisputeWrites(snippet)).toHaveLength(1)
    })
    it.each(MUTANTS)('...and the guards reject it unless it is status-guarded: %s', (_name, snippet) => {
      const [w] = rawDisputeWrites(snippet)
      expect(statusGuarded(w.where) && !leavesResolved(w)).toBe(false)
    })
    it('the status-leaving variant is caught even when guarded', () => {
      const [w] = rawDisputeWrites('await tx.$executeRaw`UPDATE disputes SET status = \'OPENED\' WHERE id = ${id} AND status = \'RESOLVED\'`')
      expect(statusGuarded(w.where)).toBe(true)
      expect(leavesResolved(w)).toBe(true)
    })
    it('positive control: the two real writers are seen, status-guarded and not leaving RESOLVED', () => {
      const real = 'await tx.$executeRaw`UPDATE "disputes" SET "status" = \'EVIDENCE_SUBMITTED\' WHERE "id" = ${id} AND "status" = \'AUTO_PROPOSED\' AND "ruling" IS NULL`'
      const [w] = rawDisputeWrites(real)
      expect(statusGuarded(w.where) && !leavesResolved(w)).toBe(true)
    })
    // The C4 dispatch-recovery claim (a queue stamp) is RESOLVED-conditional by design: it sets only the stamp.
    it('a RESOLVED-guarded writer that sets only the C4 queue stamp is allowed', () => {
      const [w] = rawDisputeWrites('tx.$queryRaw`WITH picked AS (SELECT d.id FROM disputes d FOR UPDATE OF d SKIP LOCKED) UPDATE disputes d SET "dispatchRecoveryAttemptedAt" = clock_timestamp() FROM picked WHERE d.id = picked.id AND d.status = \'RESOLVED\' RETURNING d.id`')
      expect(statusGuarded(w.where) && !leavesResolved(w)).toBe(true)
    })
    it('...but a RESOLVED-guarded writer that also sets any other column is flagged', () => {
      for (const extra of ['"ruling" = NULL', '"arbiterId" = NULL', '"appealRound" = 1', 'status = \'OPENED\'']) {
        const [w] = rawDisputeWrites(`tx.$executeRaw\`UPDATE disputes d SET "dispatchRecoveryAttemptedAt" = now(), ${extra} FROM picked WHERE d.id = picked.id AND d.status = 'RESOLVED'\``)
        expect(leavesResolved(w)).toBe(true)
      }
    })
  })
})
