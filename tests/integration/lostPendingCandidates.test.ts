// P4 / Gate 3 - what the test-hygiene helper removes and, as important, what it leaves alone.
//
// removeLostPendingCandidates() exists only so that a suite which fault-injects "the pending operation was lost" does not
// leave a PASS 0b recovery candidate for the NEXT suite in the shared lane. This suite pins its two promises on real
// PostgreSQL rows (inserted with replication triggers off, as other lane suites do for synthetic fixtures):
//   1. SCOPE - it deletes only live, txid-bearing authorizations of DISPUTED MULTISIG escrows without a result and without
//      a pending operation THAT WERE CREATED AFTER the suite started; every other row is byte-for-byte untouched.
//   2. NO MASKING - what it leaves behind is still found by the real PASS 0b candidate query, and what it removed no longer
//      is: it hides nothing the production sweep would otherwise recover from another suite or from real data.
import { PrismaClient } from '@prisma/client'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'
import { databaseClock, removeLostPendingCandidates } from './lostPendingCandidates'

describe('removeLostPendingCandidates - scope and non-masking (real Postgres)', () => {
  jest.setTimeout(120_000)
  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let reconcileLostPendingPublicTransactions: (report: any) => Promise<void>
  let realFetch: typeof fetch
  const ids: string[] = []

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'false'
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ reconcileLostPendingPublicTransactions } = require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service'))
  })
  beforeEach(() => { realFetch = global.fetch })
  afterEach(() => { global.fetch = realFetch })
  afterAll(async () => {
    if (dbAvailable) {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL session_replication_role = replica`
        await tx.$executeRawUnsafe(`DELETE FROM economic_disposition_authorizations WHERE "escrowId" = ANY($1::text[])`, ids)
        await tx.$executeRawUnsafe(`DELETE FROM escrow_pending_transactions WHERE "escrowId" = ANY($1::text[])`, ids)
        await tx.$executeRawUnsafe(`DELETE FROM escrows WHERE id = ANY($1::text[])`, ids)
      })
      await prisma.$disconnect()
      await closeTestRedis()
    }
  })

  interface Shape {
    label: string
    type?: string; status?: string; txReleaseId?: string | null
    createdBeforeSuite?: boolean; unsignedTxid?: string | null; superseded?: boolean; withPending?: boolean
  }
  const base = (n: number) => `lpc-${n}-${'0'.repeat(8)}`
  async function insert(shape: Shape, n: number, since: Date): Promise<{ escrowId: string; edaId: string; txid: string | null }> {
    const escrowId = base(n)
    const edaId = `lpc-eda-${n}`
    const txid = shape.unsignedTxid === undefined ? `${n.toString(16).padStart(2, '0')}`.repeat(32) : shape.unsignedTxid
    ids.push(escrowId)
    const createdAt = shape.createdBeforeSuite ? new Date(since.getTime() - 3_600_000) : new Date(since.getTime() + 1_000)
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`
      await tx.$executeRaw`INSERT INTO escrows (id, "tradeId", "lockedAmount", asset, type, status, "txReleaseId", "createdAt", "updatedAt")
        VALUES (${escrowId}, ${`lpc-trade-${n}`}, 1000, 'BTC', ${shape.type ?? 'MULTISIG'}::"EscrowType", ${shape.status ?? 'DISPUTED'}::"EscrowStatus",
                ${shape.txReleaseId ?? null}, ${createdAt}, ${createdAt})`
      await tx.$executeRaw`INSERT INTO economic_disposition_authorizations
        (id, "pendingOperationId", "escrowId", "disputeId", "appealRound", "arbiterId", ruling, "operationDigest", "unsignedTxid", "supersededAt")
        VALUES (${edaId}, ${`lpc-pend-${n}`}, ${escrowId}, ${`lpc-dispute-${n}`}, 0, 'lpc-arbiter', 'RELEASE'::"DisputeRuling", 'digest',
                ${txid}, ${shape.superseded ? new Date() : null})`
      if (shape.withPending) {
        await tx.$executeRaw`INSERT INTO escrow_pending_transactions (id, "escrowId", kind, "toAddress", "unsignedPsbtBase64", "requiredSigners", "triggeredBy")
          VALUES (${`lpc-pend-row-${n}`}, ${escrowId}, 'RELEASE', 'addr', 'psbt', ARRAY['a']::text[], 'lpc')`
      }
    })
    return { escrowId, edaId, txid }
  }
  const liveEdaIds = async () => (await prisma.economicDispositionAuthorization.findMany({ where: { escrowId: { in: ids } }, select: { id: true }, orderBy: { id: 'asc' } })).map((r) => r.id)
  /** The reconciler's own candidate query, run through the real PASS 0b function with an explorer that knows every txid. */
  async function selectedByPass0b(): Promise<string[]> {
    global.fetch = (async () => ({ ok: true, status: 200, text: async () => '', json: async () => ({ confirmed: true, block_height: 100 }) })) as any
    const report = { recovered: [] as any[], failed: [] as any[], requiresManualReview: [] as any[] }
    await reconcileLostPendingPublicTransactions(report)
    return [...report.recovered, ...report.failed].map((x) => x.escrowId).filter((id) => ids.includes(id)).sort()
  }

  it('SCOPE: deletes exactly the suite\'s own PASS 0b candidates and nothing else; what remains is still a candidate', async () => {
    if (!dbAvailable) pg.requirePostgres('removeLostPendingCandidates scope')
    const since = await databaseClock(prisma)
    const own1 = await insert({ label: 'own candidate' }, 1, since)
    const own2 = await insert({ label: 'own candidate #2' }, 2, since)
    const foreign = await insert({ label: 'candidate created BEFORE the suite (another suite / real data)', createdBeforeSuite: true }, 3, since)
    const superseded = await insert({ label: 'superseded authorization', superseded: true }, 4, since)
    const legacy = await insert({ label: 'legacy: no unsignedTxid', unsignedTxid: null }, 5, since)
    const withPending = await insert({ label: 'a pending operation exists', withPending: true }, 6, since)
    const terminal = await insert({ label: 'terminal status', status: 'COMPLETED' }, 7, since)
    const otherRail = await insert({ label: 'not MULTISIG', type: 'LIGHTNING_HODL' }, 8, since)
    const hasResult = await insert({ label: 'already has a settlement result', txReleaseId: 'ab'.repeat(32) }, 9, since)

    const before = await liveEdaIds()
    const removed = await removeLostPendingCandidates(prisma, since)
    const after = await liveEdaIds()

    expect({
      removed,
      deleted: before.filter((id) => !after.includes(id)),
      kept: after,
      rowsOfTheKeptOnesUnchanged: (await prisma.economicDispositionAuthorization.count({ where: { id: { in: [foreign, superseded, legacy, withPending, terminal, otherRail, hasResult].map((r) => r.edaId) } } })),
    }).toEqual({
      removed: 2,
      deleted: [own1.edaId, own2.edaId].sort(),
      kept: [foreign, superseded, legacy, withPending, terminal, otherRail, hasResult].map((r) => r.edaId).sort(),
      rowsOfTheKeptOnesUnchanged: 7,
    })
    // escrows themselves are never touched
    expect(await prisma.escrow.count({ where: { id: { in: ids } } })).toBe(9)
  })

  it('NO MASKING: the real PASS 0b selects the foreign candidate that was left, and none of the rows that were removed or never qualified', async () => {
    if (!dbAvailable) pg.requirePostgres('removeLostPendingCandidates non-masking')
    // state left by the previous test: only `foreign` (n=3) is a live candidate
    expect(await selectedByPass0b()).toEqual([base(3)])
    // and a fresh candidate created later by this same suite WOULD be selected - until the helper removes it
    const since = await databaseClock(prisma)
    const own = await insert({ label: 'own candidate, second round' }, 10, since)
    expect(await selectedByPass0b()).toContain(own.escrowId)
  })
})
