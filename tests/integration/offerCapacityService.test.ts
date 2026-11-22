/**
 * M-1b step 3 (CTO 28 Despacho 029 (1)): the owner-signed capacity declaration service and the failing-loud audit, real Postgres.
 * Proves: the signature (not the session) authorizes; the session must also be the owner; anti-replay by capacityRevision; reduction
 * is not retroactive; concurrent declarations serialize on the row lock; and the audit FAILS when an invalid signature was written
 * by direct SQL (the declared Ed25519-outside-the-database residual).
 */
import nacl from 'tweetnacl'
import { Client } from 'pg'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { createCommitmentFixture } from './helpers/committedPairFixture'

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')

describe('M-1b offer capacity: signed declaration service + audit (real PG)', () => {
  jest.setTimeout(240_000)
  const pg = createPostgresIntegrationHarness()
  let prisma: any, db: Client, cap: any, service: any, audit: any
  beforeAll(async () => {
    await pg.probe()
    if (!pg.isAvailable()) return
    ;({ prisma } = require('../../src/common/database'))
    cap = require('../../src/modules/open-liquidity/offer-capacity-declaration')
    service = require('../../src/modules/open-liquidity/offer-capacity.service')
    audit = require('../../scripts/audit-offer-capacity')
    db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect()
  })
  afterAll(async () => { if (db) await db.end().catch(() => undefined); if (prisma) await prisma.$disconnect() })
  const run = (name: string, fn: () => Promise<void>) => it(name, async () => { if (!pg.isAvailable()) return; await fn() })

  const kp = (byte: number) => nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(byte))
  async function setup(seed: number) {
    const fx = await createCommitmentFixture(prisma, { seed })
    const ownerKp = kp(seed), owner = hex(ownerKp.publicKey), secret = hex(ownerKp.secretKey)
    const declaration = (total: string, rev: number, over: Record<string, unknown> = {}) => {
      const c = { ownerPublicKey: owner, logicalOfferId: fx.logicalOfferId as string, asset: 'BTC', capacityTotal: total, capacityRevision: rev, networkId: 'testnet', issuedAt: new Date().toISOString(), ...over }
      return { ...c, signature: cap.signOfferCapacity(c, secret) }
    }
    const declare = (d: any, sessionKey = owner) => service.declareOfferCapacity({ sessionPublicKey: sessionKey, declaration: d, networkId: 'testnet' })
    const row = async () => (await db.query(`SELECT "capacityTotal"::text AS total, "capacityRevision" AS rev FROM offer_capacity WHERE "ownerPublicKey"=$1 AND "logicalOfferId"=$2`, [owner, fx.logicalOfferId])).rows[0]
    return { fx, owner, secret, declaration, declare, row }
  }
  const refused = async (p: Promise<unknown>) => { try { await p; return null } catch (e: any) { return String(e?.message ?? e) } }

  run('a valid signed declaration creates the capacity; the audit verifies it', async () => {
    const s = await setup(0x71)
    await s.declare(s.declaration('10.00000000', 1))
    expect(await s.row()).toEqual({ total: '10.00000000', rev: 1 })
    expect(await audit.auditOfferCapacity(db, 'testnet').then((f: any[]) => f.filter((x) => x.logicalOfferId === s.fx.logicalOfferId))).toEqual([])
  })

  run('anti-replay: the same or a lower revision is refused; a higher one (even a REDUCTION) applies', async () => {
    const s = await setup(0x72)
    await s.declare(s.declaration('10.00000000', 2))
    expect(await refused(s.declare(s.declaration('999.00000000', 2)))).toContain('capacityRevision')
    expect(await refused(s.declare(s.declaration('999.00000000', 1)))).toContain('capacityRevision')
    await s.declare(s.declaration('4.00000000', 3))
    expect(await s.row()).toEqual({ total: '4.00000000', rev: 3 })
  })

  run('MUTANTS: a session without the signature, a signature of another key, another network, a stranger session, another Offer: all refused, nothing written', async () => {
    const s = await setup(0x73)
    const other = kp(0x7f)
    const fromOther = { ...s.declaration('10.00000000', 1), signature: cap.signOfferCapacity({ ...s.declaration('10.00000000', 1) }, hex(other.secretKey)) }
    expect(await refused(s.declare(fromOther))).toContain('does not verify')
    expect(await refused(s.declare(s.declaration('10.00000000', 1, { networkId: 'mainnet' })))).toContain('network')
    expect(await refused(s.declare(s.declaration('10.00000000', 1), hex(other.publicKey)))).toContain('does not belong')
    expect(await refused(s.declare({ ...s.declaration('10.00000000', 1), signature: undefined }))).toContain('refused')
    expect(await refused(s.declare(s.declaration('10.00000000', 1, { logicalOfferId: 'no-such-offer' })))).toContain('not resolved')
    expect(await refused(s.declare(s.declaration('10.00000000', 1, { asset: 'USDT_ERC20' })))).toContain('asset')
    expect(await s.row()).toBeUndefined()
  })

  run('N=5 concurrent declarations (revisions 1..5): they serialize on the row lock, the highest wins, revision never goes back', async () => {
    const s = await setup(0x74)
    const results = await Promise.all([1, 2, 3, 4, 5].map((r) => refused(s.declare(s.declaration(`${r}.00000000`, r)))))
    const row = await s.row()
    expect(row.rev).toBe(5)
    expect(row.total).toBe('5.00000000')
    // every refusal is the anti-replay refusal of an older revision, never a lost update or a raw database error
    for (const m of results) if (m !== null) expect(m).toContain('capacityRevision')
  })

  run('the audit FAILS LOUD on a signature written by direct SQL that does not verify (the declared residual), and on a pasted declaration with other columns', async () => {
    const s = await setup(0x75)
    const c = { ownerPublicKey: s.owner, logicalOfferId: s.fx.logicalOfferId, asset: 'BTC', capacityTotal: '10.00000000', capacityRevision: 1, networkId: 'testnet', issuedAt: new Date().toISOString() }
    await db.query(`INSERT INTO offer_capacity ("ownerPublicKey","logicalOfferId","capacityTotal","capacityRevision","declaredAt","declaration","declarationSignature") VALUES ($1,$2,$3,1,now(),$4,$5)`,
      [s.owner, s.fx.logicalOfferId, '10.00000000', JSON.stringify(c), 'ab'.repeat(64)])
    const bad = (await audit.auditOfferCapacity(db, 'testnet')).filter((f: any) => f.logicalOfferId === s.fx.logicalOfferId)
    expect(bad).toHaveLength(1)
    expect(bad[0].problem).toContain('does not verify')
    // a VALID declaration with a different total in the column is caught as well
    const t = await setup(0x76)
    const good = t.declaration('10.00000000', 1)
    const { signature, ...content } = good
    await db.query(`INSERT INTO offer_capacity ("ownerPublicKey","logicalOfferId","capacityTotal","capacityRevision","declaredAt","declaration","declarationSignature") VALUES ($1,$2,$3,1,now(),$4,$5)`,
      [t.owner, t.fx.logicalOfferId, '9999.00000000', JSON.stringify(content), signature])
    const bad2 = (await audit.auditOfferCapacity(db, 'testnet')).filter((f: any) => f.logicalOfferId === t.fx.logicalOfferId)
    expect(bad2.map((f: any) => f.problem).join(' ')).toContain('differs from the signed')
  })

  run('reduction is NOT retroactive: a reduction below the reserved sum keeps the reservation and blocks new ones', async () => {
    const s = await setup(0x77)
    await s.declare(s.declaration('0.01000000', 1))
    const a = await s.fx.admitTrade('PENDING'), p1 = await s.fx.proposePartialPair(a.anchorRef)
    expect((await p1.signMaker()).state).toBe('COMMITTED')
    await s.declare(s.declaration('0.00100000', 2)) // below the 0.005 already reserved
    const reserved = (await db.query(`SELECT count(*)::int AS n FROM offer_capacity_reservations WHERE "logicalOfferId"=$1 AND state='RESERVED'`, [s.fx.logicalOfferId])).rows[0].n
    expect(reserved).toBe(1)
    const b = await s.fx.admitTrade('PENDING'), p2 = await s.fx.proposePartialPair(b.anchorRef)
    expect(await refused(p2.signMaker())).toMatch(/EXCEEDED|exceeds/i)
  })
})
