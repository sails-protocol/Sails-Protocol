// P4 / Gate 3 - scope and non-masking of the signed-copy hygiene helper, and proof that the AUD1X I1 inventory stays STRICT.
//
//   1. STRICT: the real inventory SQL still fails on an undecodable signed copy of a keyed MULTISIG round. Nothing here makes the
//      decoder tolerant; the helper only removes the producer suite's own placeholder rows.
//   2. SCOPE: removeUndecodableSignedCopies() deletes only signed copies that are not base64 at all AND belong to an escrow created
//      by the calling suite. A real (decodable) copy of the suite's own escrow and an undecodable copy of another suite's escrow are
//      left untouched.
//   3. After the helper ran, the same inventory SQL runs to completion.
import { readFileSync } from 'fs'
import { join } from 'path'
import { PrismaClient } from '@prisma/client'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'
import { databaseClock } from './lostPendingCandidates'
import { removeUndecodableSignedCopies } from './undecodableSignedCopies'

describe('removeUndecodableSignedCopies - scope, and the AUD1X inventory stays strict (real Postgres)', () => {
  jest.setTimeout(120_000)
  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  const escrowIds: string[] = []
  const VALID_PSBT = 'cHNidP8BAAoCAAAAAAAAAAAA' // decodable base64 (placeholder bytes)
  const ARBITER_PUBKEY = '02' + 'ab'.repeat(32)

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'false'
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
  })
  afterAll(async () => {
    if (dbAvailable) {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL session_replication_role = replica`
        await tx.$executeRawUnsafe(`DELETE FROM escrow_transaction_signatures WHERE "pendingTxId" IN (SELECT id FROM escrow_pending_transactions WHERE "escrowId" = ANY($1::text[]))`, escrowIds)
        await tx.$executeRawUnsafe(`DELETE FROM escrow_pending_transactions WHERE "escrowId" = ANY($1::text[])`, escrowIds)
        await tx.$executeRawUnsafe(`DELETE FROM escrow_participant_keys WHERE "escrowId" = ANY($1::text[])`, escrowIds)
        await tx.$executeRawUnsafe(`DELETE FROM escrows WHERE id = ANY($1::text[])`, escrowIds)
      })
      await prisma.$disconnect()
      await closeTestRedis()
    }
  })

  async function round(n: number, since: Date, opts: { createdBeforeSuite?: boolean; copies: string[] }): Promise<{ escrowId: string; sigIds: string[] }> {
    const escrowId = `usc-${n}-${'0'.repeat(8)}`
    escrowIds.push(escrowId)
    const createdAt = opts.createdBeforeSuite ? new Date(since.getTime() - 3_600_000) : new Date(since.getTime() + 1_000)
    const sigIds = opts.copies.map((_, i) => `usc-sig-${n}-${i}`)
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`
      await tx.$executeRaw`INSERT INTO escrows (id, "tradeId", "lockedAmount", asset, type, status, "createdAt", "updatedAt")
        VALUES (${escrowId}, ${`usc-trade-${n}`}, 1000, 'BTC', 'MULTISIG'::"EscrowType", 'DISPUTED'::"EscrowStatus", ${createdAt}, ${createdAt})`
      await tx.$executeRaw`INSERT INTO escrow_participant_keys (id, "escrowId", role, "participantId", pubkey)
        VALUES (${`usc-key-${n}`}, ${escrowId}, 'arbiter', 'usc-arbiter', ${ARBITER_PUBKEY})`
      await tx.$executeRaw`INSERT INTO escrow_pending_transactions (id, "escrowId", kind, "toAddress", "unsignedPsbtBase64", "requiredSigners", "triggeredBy")
        VALUES (${`usc-pend-${n}`}, ${escrowId}, 'release', 'addr', ${VALID_PSBT}, ARRAY['a']::text[], 'usc')`
      for (let i = 0; i < opts.copies.length; i++) {
        await tx.$executeRaw`INSERT INTO escrow_transaction_signatures (id, "pendingTxId", "participantId", "signedPsbtBase64")
          VALUES (${sigIds[i]}, ${`usc-pend-${n}`}, ${`usc-p-${i}`}, ${opts.copies[i]})`
      }
    })
    return { escrowId, sigIds }
  }
  const remaining = async () => (await prisma.escrowTransactionSignature.findMany({ where: { id: { startsWith: 'usc-sig-' } }, select: { id: true }, orderBy: { id: 'asc' } })).map((r) => r.id)

  /** The real AUD1X-H1 inventory, statement by statement, in one READ ONLY transaction - as aud1xBearerCapability I1 runs it. */
  async function runInventory(): Promise<{ ok: boolean; error?: string }> {
    const sqlText = readFileSync(join(__dirname, '../../scripts/aud1x-h1-legacy-inventory.sql'), 'utf8')
    const statements = sqlText.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(';').map((s) => s.trim())
      .filter((s) => s && s !== 'BEGIN TRANSACTION READ ONLY' && s !== 'ROLLBACK')
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY')
        for (const statement of statements) await tx.$queryRawUnsafe(statement)
      })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String((err as Error).message) }
    }
  }

  it('STRICT + SCOPE + RECOVERED: the inventory fails on the undecodable copy, the helper removes only the suite\'s own undecodable copies, the inventory then runs', async () => {
    if (!dbAvailable) pg.requirePostgres('removeUndecodableSignedCopies')
    const since = await databaseClock(prisma)
    const own = await round(1, since, { copies: ['st1-e2-race-proof', VALID_PSBT, 'buyer-signed'] })
    const foreign = await round(2, since, { createdBeforeSuite: true, copies: ['another-suites-placeholder'] })

    // 1. the strict inventory sees the poison (and would, on production data, see a corrupt copy)
    const before = await runInventory()
    expect(before.ok).toBe(false)
    expect(before.error).toMatch(/invalid symbol .* found while decoding base64 sequence/)

    // 2. scope: exactly the two undecodable copies of the suite's own escrow go; its decodable copy and the foreign copy stay
    const removed = await removeUndecodableSignedCopies(prisma, since)
    expect({ removed, left: await remaining() }).toEqual({ removed: 2, left: [own.sigIds[1], foreign.sigIds[0]].sort() })

    // 3. the foreign poison still breaks the strict inventory - the helper hid nothing it does not own
    expect((await runInventory()).ok).toBe(false)

    // 4. once the foreign row is gone (its own suite's cleanup), the unchanged inventory runs to completion
    await prisma.$executeRaw`DELETE FROM escrow_transaction_signatures WHERE id = ${foreign.sigIds[0]}`
    expect(await runInventory()).toEqual({ ok: true })
  })
})
