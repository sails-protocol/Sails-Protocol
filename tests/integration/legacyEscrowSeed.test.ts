/**
 * The legacy-escrow seed helper (CTO Despacho 031, D) against real PostgreSQL. It must (1) keep the REAL type, (2) write the two marks
 * exactly as the cut migration does, (3) leave every trigger ON afterwards, (4) NOT weaken the deny-by-default for NEW escrows: a new
 * WDK/LIGHTNING escrow is still refused, "a new legacy" (marks written by anyone but the cut) is still refused, and its own revalidation
 * rejects every wrong shape of seed.
 */
import { randomUUID } from 'crypto'
import { Client } from 'pg'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { legacyEscrowSeed, revalidateLegacySeed, withReplica } from './helpers/legacyEscrowSeed'

describe('legacyEscrowSeed (corpus helper for pre-cut WDK / LIGHTNING / ... escrows)', () => {
  jest.setTimeout(120_000)
  const pg = createPostgresIntegrationHarness()
  let db: Client
  let userId = '', offerId = ''

  beforeAll(async () => {
    await pg.probe()
    if (!pg.isAvailable()) return
    db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect()
    userId = (await db.query(`INSERT INTO users (id,"publicKey","updatedAt") VALUES ($1,$2,now()) RETURNING id`, [randomUUID(), randomUUID()])).rows[0].id
    offerId = (await db.query(`INSERT INTO offers (id,"userId",asset,side,"priceUsd","minAmount","maxAmount","paymentMethod","updatedAt") VALUES ($1,$2,'USDT_ERC20','SELL',1,1,100,'PIX',now()) RETURNING id`, [randomUUID(), userId])).rows[0].id
  })
  afterAll(async () => { if (db) await db.end() })

  async function newTrade(): Promise<string> {
    const anchor = randomUUID(), id = randomUUID()
    await db.query(`INSERT INTO intents (id,type,"participantId","moduleId",payload,status,"updatedAt") VALUES ($1,'TRADE',$2,'openp2p','{}'::jsonb,'PENDING',now())`, [anchor, userId])
    await db.query(`INSERT INTO trades (id,"offerId","buyerId","sellerId",asset,amount,"priceUsd","totalUsd","tradeIntentId","updatedAt") VALUES ($1,$2,$3,$3,'USDT_ERC20',5,1,5,$4,now())`, [id, offerId, userId, anchor])
    return id
  }
  const refused = async (sql: string, params: unknown[], needle: RegExp) => {
    await db.query('BEGIN')
    try { await db.query(sql, params); throw new Error('expected the statement to be refused') }
    catch (e: any) { expect(String(e.message)).toMatch(needle) }
    finally { await db.query('ROLLBACK') }
  }

  it('a legacy WDK escrow keeps its real type and carries both marks from ONE instant; with an address it can be funded and run the whole group-B cycle; triggers stay ON', async () => {
    const tradeId = await newTrade()
    const id = await legacyEscrowSeed({ tradeId, type: 'WDK_USDT_EVM', lockedAmount: '5', asset: 'USDT_ERC20', multisigAddr: '0xlegacy' })
    const row = (await db.query(`SELECT type::text AS type, "legacyPreCommitmentAt" AS l, "addressPresentAtCutAt" AS a, "commitmentPairId" AS p FROM escrows WHERE id = $1`, [id])).rows[0]
    expect(row.type).toBe('WDK_USDT_EVM')
    expect(row.p).toBeNull()
    expect(row.a.getTime()).toBe(row.l.getTime())
    expect((await db.query(`UPDATE escrows SET status='FUNDS_LOCKED' WHERE id=$1`, [id])).rowCount).toBe(1) // legacy WITH an address at the cut
    expect((await db.query(`UPDATE escrows SET status='DISPUTED' WHERE id=$1`, [id])).rowCount).toBe(1)
    expect((await db.query(`UPDATE escrows SET status='COMPLETED', "txReleaseId"='tx' WHERE id=$1`, [id])).rowCount).toBe(1)
  })

  it('a legacy LIGHTNING escrow WITHOUT an address at the cut only finishes by the old rules: it cannot be funded or addressed', async () => {
    const tradeId = await newTrade()
    const id = await legacyEscrowSeed({ tradeId, type: 'LIGHTNING_HODL', lockedAmount: '5', asset: 'USDT_ERC20' })
    const row = (await db.query(`SELECT "legacyPreCommitmentAt" AS l, "addressPresentAtCutAt" AS a FROM escrows WHERE id = $1`, [id])).rows[0]
    expect(row.l).not.toBeNull()
    expect(row.a).toBeNull()
    await refused(`UPDATE escrows SET status='FUNDS_LOCKED' WHERE id=$1`, [id], /funding is registered only under a COMMITTED/)
    await refused(`UPDATE escrows SET "multisigAddr"='ln1new' WHERE id=$1`, [id], /stored only under a COMMITTED/)
  })

  it('the helper does NOT weaken deny-by-default for NEW escrows: a new WDK/LIGHTNING escrow is still refused, and so is "a new legacy" (marks by anyone but the cut)', async () => {
    const tradeId = await newTrade()
    for (const type of ['WDK_USDT_EVM', 'LIGHTNING_HODL', 'LIQUID_COVENANT', 'SAFE_GUARD_EVM']) {
      await refused(`INSERT INTO escrows (id,"tradeId","lockedAmount",asset,type,"updatedAt") VALUES ($1,$2,5,'USDT_ERC20',$3::"EscrowType",now())`, [randomUUID(), tradeId, type], /needs a COMMITTED commitment pair/)
    }
    await refused(`INSERT INTO escrows (id,"tradeId","lockedAmount",asset,type,"legacyPreCommitmentAt","updatedAt") VALUES ($1,$2,5,'USDT_ERC20','WDK_USDT_EVM',now(),now())`, [randomUUID(), tradeId], /legacy marks are written only by the cut migration/)
    const seeded = await legacyEscrowSeed({ tradeId, type: 'WDK_USDT_EVM', lockedAmount: '5', asset: 'USDT_ERC20', multisigAddr: '0xother' })
    await refused(`UPDATE escrows SET "legacyPreCommitmentAt" = now() WHERE id=$1`, [seeded], /legacy marks are immutable/)
    // an ordinary escrow cannot be turned into a "legacy" one afterwards either
    const mock = (await db.query(`INSERT INTO escrows (id,"tradeId","lockedAmount",asset,type,"updatedAt") VALUES ($1,$2,5,'USDT_ERC20','MOCK',now()) RETURNING id`, [randomUUID(), await newTrade()])).rows[0].id
    await refused(`UPDATE escrows SET "legacyPreCommitmentAt" = now() WHERE id=$1`, [mock], /legacy marks are immutable/)
  })

  it('the helper refuses what it must: MOCK as a stand-in, overriding its own columns, bad column names, a non-superuser', async () => {
    const tradeId = await newTrade()
    await expect(legacyEscrowSeed({ tradeId, type: 'MOCK', lockedAmount: '5', asset: 'BTC' })).rejects.toThrow(/MOCK is refused/)
    await expect(legacyEscrowSeed({ tradeId, type: 'WDK_USDT_EVM', lockedAmount: '5', asset: 'USDT_ERC20', columns: { legacyPreCommitmentAt: new Date() } })).rejects.toThrow(/set by the helper itself/)
    await expect(legacyEscrowSeed({ tradeId, type: 'WDK_USDT_EVM', lockedAmount: '5', asset: 'USDT_ERC20', columns: { commitmentPairId: 'x' } })).rejects.toThrow(/set by the helper itself/)
    await expect(legacyEscrowSeed({ tradeId, type: 'WDK_USDT_EVM', lockedAmount: '5', asset: 'USDT_ERC20', columns: { 'status"; DROP TABLE escrows; --': 'x' } })).rejects.toThrow(/bad column name/)
    const prev = process.env.ADMIN_DATABASE_URL, prevDb = process.env.DATABASE_URL
    try {
      const u = new URL(process.env.DATABASE_URL as string); u.username = 'sails_runtime'; u.password = 'nope'
      process.env.ADMIN_DATABASE_URL = u.toString()
      await expect(legacyEscrowSeed({ tradeId, type: 'WDK_USDT_EVM', lockedAmount: '5', asset: 'USDT_ERC20' })).rejects.toBeTruthy() // cannot even connect as the runtime: never a legacy escrow from there
    } finally { if (prev === undefined) delete process.env.ADMIN_DATABASE_URL; else process.env.ADMIN_DATABASE_URL = prev; process.env.DATABASE_URL = prevDb }
  })

  it('the revalidation rejects every wrong seed: no marks (a NEW escrow written around the binding), an isolated mark, an address mark without an address, a pair, different instants, a missing trade, MOCK', async () => {
    const tradeId = await newTrade()
    const insert = (cols: Record<string, unknown>) => withReplica(db, async () => {
      const id = randomUUID(), c = { id, tradeId, "lockedAmount": 5, asset: 'USDT_ERC20', type: 'WDK_USDT_EVM', updatedAt: new Date(), ...cols }
      const names = Object.keys(c)
      await db.query(`INSERT INTO escrows (${names.map((n) => `"${n}"`).join(',')}) VALUES (${names.map((n, i) => (n === 'type' ? `$${i + 1}::"EscrowType"` : `$${i + 1}`)).join(',')})`, names.map((n) => (c as any)[n]))
      return id
    })
    const t0 = new Date(), t1 = new Date(t0.getTime() + 5)
    await expect(revalidateLegacySeed(db, await insert({}))).rejects.toThrow(/legacy mark is missing/)
    await expect(revalidateLegacySeed(db, await insert({ addressPresentAtCutAt: t0 }))).rejects.toThrow(/legacy mark is missing/)
    await expect(revalidateLegacySeed(db, await insert({ legacyPreCommitmentAt: t0, multisigAddr: '0xa' }))).rejects.toThrow(/address mark must exist exactly when/)
    await expect(revalidateLegacySeed(db, await insert({ legacyPreCommitmentAt: t0, addressPresentAtCutAt: t0 }))).rejects.toThrow(/address mark must exist exactly when/)
    await expect(revalidateLegacySeed(db, await insert({ legacyPreCommitmentAt: t0, addressPresentAtCutAt: t1, multisigAddr: '0xa' }))).rejects.toThrow(/same instant/)
    await expect(revalidateLegacySeed(db, await insert({ legacyPreCommitmentAt: t0, type: 'MOCK' }))).rejects.toThrow(/MOCK is never a legacy stand-in/)
    await expect(revalidateLegacySeed(db, await insert({ legacyPreCommitmentAt: t0, commitmentPairId: 'dangling-pair' }))).rejects.toThrow(/no commitment pair/)
    await expect(revalidateLegacySeed(db, randomUUID())).rejects.toThrow(/does not exist/)
    const ghost = await insert({ legacyPreCommitmentAt: t0, tradeId: randomUUID() }) // FK off under the replica role: a dangling trade
    await expect(revalidateLegacySeed(db, ghost)).rejects.toThrow(/its trade does not exist/)
    await db.query(`DELETE FROM escrows WHERE id = $1 OR "commitmentPairId" = 'dangling-pair'`, [ghost]) // leave no dangling rows behind
  })
})
