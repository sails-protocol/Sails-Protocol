/**
 * F4 / invariant 3b, S1 - the RUNTIME track. As the restricted application role (sails_runtime), real SQL: the two legacy marks and
 * commitmentPairId cannot be written (column-level grants), the group-B lifecycle still works, and the runtime cannot switch the
 * triggers off. Scratch database built from every migration, roles from scripts/db/bootstrap-roles.js, grants from
 * scripts/db/runtime-grants.sql (the file that ships), then every assertion runs AS sails_runtime. Not superuser-only proofs.
 */
import { randomUUID } from 'crypto'
import { readdirSync, readFileSync } from 'fs'
import path from 'path'
import { Client } from 'pg'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { assertRuntimeCannotUseReplica, legacyEscrowSeed, withReplica } from './helpers/legacyEscrowSeed'

const ROOT = path.join(__dirname, '..', '..')
const MIG_DIR = path.join(ROOT, 'prisma', 'migrations')
const hex64 = () => randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
const hex128 = () => hex64() + hex64()

describe('F4 S1 - runtime track (sails_runtime, column-level grants)', () => {
  jest.setTimeout(240_000)
  const pg = createPostgresIntegrationHarness()
  const NAME = `sails_f4_rt_${randomUUID().slice(0, 8)}`
  const MIGRATOR_PW = 'migr-' + randomUUID(), RUNTIME_PW = 'rt-' + randomUUID()
  let admin: Client, su: Client, rt: Client
  let baseUrl: URL
  const conns: Client[] = []
  let feePolicyId = '', userId = '', offerId = ''
  const urlFor = (user: string, pw: string) => { const u = new URL(baseUrl.toString()); u.username = user; u.password = pw; u.pathname = '/' + NAME; return u.toString() }

  beforeAll(async () => {
    await pg.probe()
    if (!pg.isAvailable()) return
    baseUrl = new URL(process.env.DATABASE_URL as string)
    const adminUrl = new URL(baseUrl.toString()); adminUrl.pathname = '/postgres'
    admin = new Client({ connectionString: adminUrl.toString() }); await admin.connect()
    await admin.query(`CREATE DATABASE ${NAME}`)
    su = new Client({ connectionString: urlFor(baseUrl.username, baseUrl.password) }); await su.connect(); conns.push(su)
    // migration 133000 REQUIRES the cluster-wide reviewer role (it never creates it); bootstrap-roles.js runs only after the migrations here
    await su.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sails_capacity_reviewer') THEN CREATE ROLE sails_capacity_reviewer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$`)
    const dirs = readdirSync(MIG_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
    for (const d of dirs) await su.query(readFileSync(path.join(MIG_DIR, d, 'migration.sql'), 'utf8'))
    // fixtures first (superuser), THEN the roles and grants, exactly as the deploy order does after migrations
    userId = (await su.query(`INSERT INTO users (id,"publicKey","updatedAt") VALUES ($1,$2,now()) RETURNING id`, [randomUUID(), randomUUID()])).rows[0].id
    offerId = (await su.query(`INSERT INTO offers (id,"userId",asset,side,"priceUsd","minAmount","maxAmount","paymentMethod","updatedAt") VALUES ($1,$2,'BTC','SELL',1,0.001,0.01,'PIX',now()) RETURNING id`, [randomUUID(), userId])).rows[0].id
    const en = await su.query(`SELECT (enum_range(NULL::"FeePayerModel"))[1] AS p, (enum_range(NULL::"FeeEconomicBasis"))[1] AS b`)
    feePolicyId = (await su.query(`INSERT INTO fee_policy_versions (id,label,"railScope","protocolFeeRate","payerModel","economicBasis","createdBy") VALUES ($1,$2,$3,0.004,$4,$5,'f4-rt') RETURNING id`, [randomUUID(), 'rt-' + NAME, 'RT-' + NAME, en.rows[0].p, en.rows[0].b])).rows[0].id

    process.env.ADMIN_DATABASE_URL = urlFor(baseUrl.username, baseUrl.password)
    process.env.SAILS_MIGRATOR_PASSWORD = MIGRATOR_PW
    process.env.SAILS_RUNTIME_PASSWORD = RUNTIME_PW
    await require(path.join(ROOT, 'scripts', 'db', 'bootstrap-roles.js')).bootstrap()
    const mig = new Client({ connectionString: urlFor('sails_migrator', MIGRATOR_PW) }); await mig.connect(); conns.push(mig)
    await mig.query(readFileSync(path.join(ROOT, 'scripts', 'db', 'runtime-grants.sql'), 'utf8'))
    rt = new Client({ connectionString: urlFor('sails_runtime', RUNTIME_PW) }); await rt.connect(); conns.push(rt)
  }, 240_000)

  afterAll(async () => {
    for (const c of conns) await c.end().catch(() => undefined)
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`).catch(() => undefined); await admin.end() }
  })

  const replica = <T,>(fn: () => Promise<T>): Promise<T> => withReplica(su, fn)
  async function tradeWithCommittedPair(): Promise<{ tradeId: string; pairId: string }> {
    const anchor = randomUUID(), tradeId = randomUUID(), pairId = randomUUID(), d = hex64()
    await su.query(`INSERT INTO intents (id,type,"participantId","moduleId",payload,status,"updatedAt") VALUES ($1,'TRADE',$2,'openp2p','{}'::jsonb,'CREATED',now())`, [anchor, userId])
    await su.query(`INSERT INTO trades (id,"offerId","buyerId","sellerId",asset,amount,"priceUsd","totalUsd","tradeIntentId","updatedAt") VALUES ($1,$2,$3,$3,'BTC',0.005,1,1,$4,now())`, [tradeId, offerId, userId, anchor])
    const t = new Date().toISOString(), e = new Date(Date.now() + 3_600_000).toISOString()
    const trade = { rail: 'MULTISIG', anchorRef: anchor, feePolicyVersionId: feePolicyId, makerPublicKey: 'm', takerPublicKey: 't', proposedAt: t, expiresAt: e }
    const arb = { arbitrationCapability: 'FIXED_ARBITER_COMMITMENT', commitmentDigest: d, commitmentDomainTag: 'sails-trade-commitment-v1', anchorRef: anchor, makerPublicKey: 'm', takerPublicKey: 't', rail: 'MULTISIG', proposedAt: t, expiresAt: e }
    await replica(() => su.query(
      `INSERT INTO commitment_pairs (id,"anchorRef","committedAnchorRef","commitmentDigest","arbitrationCommitmentDigest",trade,arbitration,policy,"feePolicyVersionId",rail,capability,state,"makerTradeSig","makerArbitrationSig","makerReceivedAt","takerTradeSig","takerArbitrationSig","takerReceivedAt")
       VALUES ($1,$2,$2,$3,$4,$5::jsonb,$6::jsonb,'{}'::jsonb,$7,'MULTISIG','FIXED_ARBITER_COMMITMENT','COMMITTED',$8,$9,now(),$10,$11,now())`,
      [pairId, anchor, d, hex64(), JSON.stringify(trade), JSON.stringify(arb), feePolicyId, hex128(), hex128(), hex128(), hex128()]))
    return { tradeId, pairId }
  }
  const code = async (p: Promise<unknown>) => { try { await p; return 'OK' } catch (e: any) { return e.code as string } }

  const FORBIDDEN_INSERT = ['legacyPreCommitmentAt', 'addressPresentAtCutAt']
  const FORBIDDEN_UPDATE = ['legacyPreCommitmentAt', 'addressPresentAtCutAt', 'commitmentPairId']

  it('1. privilege matrix: the runtime has column-level INSERT/UPDATE on every escrows column EXCEPT the forbidden ones; no table-level INSERT/UPDATE', async () => {
    const cols = (await su.query(`SELECT attname FROM pg_attribute WHERE attrelid='public.escrows'::regclass AND attnum>0 AND NOT attisdropped`)).rows.map((r) => r.attname as string)
    expect(cols).toEqual(expect.arrayContaining([...FORBIDDEN_UPDATE, 'status', 'multisigAddr', 'expiresAt', 'txReleaseId']))
    const priv = async (c: string, p: 'INSERT' | 'UPDATE') => (await su.query(`SELECT has_column_privilege('sails_runtime','public.escrows',$1,$2) AS ok`, [c, p])).rows[0].ok
    for (const c of cols) {
      expect([c, 'INSERT', await priv(c, 'INSERT')]).toEqual([c, 'INSERT', !FORBIDDEN_INSERT.includes(c)])
      expect([c, 'UPDATE', await priv(c, 'UPDATE')]).toEqual([c, 'UPDATE', !FORBIDDEN_UPDATE.includes(c)])
    }
    const tbl = async (p: string) => (await su.query(`SELECT has_table_privilege('sails_runtime','public.escrows',$1) AS ok`, [p])).rows[0].ok
    expect(await tbl('SELECT')).toBe(true)
    expect(await tbl('INSERT')).toBe(false)
    expect(await tbl('UPDATE')).toBe(false)
    expect(await tbl('DELETE')).toBe(false)
  })

  it('2. SQL as the restricted runtime: writing a legacy mark or commitmentPairId is permission denied (42501), not just refused by a trigger', async () => {
    const { tradeId, pairId } = await tradeWithCommittedPair()
    const id = (await rt.query(`INSERT INTO escrows (id,"tradeId","lockedAmount",asset,type,"commitmentPairId","updatedAt") VALUES ($1,$2,0.005,'BTC','MULTISIG',$3,now()) RETURNING id`, [randomUUID(), tradeId, pairId])).rows[0].id // the legitimate insert works
    expect(await code(rt.query(`UPDATE escrows SET "legacyPreCommitmentAt" = now() WHERE id = $1`, [id]))).toBe('42501')
    expect(await code(rt.query(`UPDATE escrows SET "addressPresentAtCutAt" = now() WHERE id = $1`, [id]))).toBe('42501')
    expect(await code(rt.query(`UPDATE escrows SET "commitmentPairId" = NULL WHERE id = $1`, [id]))).toBe('42501')
    const other = await tradeWithCommittedPair()
    expect(await code(rt.query(`INSERT INTO escrows (id,"tradeId","lockedAmount",asset,type,"commitmentPairId","legacyPreCommitmentAt","updatedAt") VALUES ($1,$2,0.005,'BTC','MULTISIG',$3,now(),now())`, [randomUUID(), other.tradeId, other.pairId]))).toBe('42501')
    expect(await code(rt.query(`INSERT INTO escrows (id,"tradeId","lockedAmount",asset,type,"addressPresentAtCutAt","updatedAt") VALUES ($1,$2,0.005,'BTC','MOCK',now(),now())`, [randomUUID(), other.tradeId]))).toBe('42501')
  })

  it('3. GROUP B continuity AS RUNTIME: the lifecycle (lock, dispute, release with txReleaseId/releasedAt, refund, split) still writes every column it uses', async () => {
    const { tradeId, pairId } = await tradeWithCommittedPair()
    const id = (await rt.query(`INSERT INTO escrows (id,"tradeId","lockedAmount",asset,type,"commitmentPairId","updatedAt") VALUES ($1,$2,0.005,'BTC','MULTISIG',$3,now()) RETURNING id`, [randomUUID(), tradeId, pairId])).rows[0].id
    expect((await rt.query(`UPDATE escrows SET "multisigAddr"='bc1qrt' WHERE id=$1`, [id])).rowCount).toBe(1)
    expect((await rt.query(`UPDATE escrows SET status='FUNDS_LOCKED', "lockedAt"=now(), "expiresAt"=$2, "updatedAt"=now() WHERE id=$1`, [id, new Date(Date.now() + 3_600_000)])).rowCount).toBe(1)
    expect((await rt.query(`UPDATE escrows SET status='DISPUTED', "updatedAt"=now() WHERE id=$1`, [id])).rowCount).toBe(1)
    expect((await rt.query(`UPDATE escrows SET status='COMPLETED', "txReleaseId"='tx', "releasedAt"=now(), "updatedAt"=now() WHERE id=$1`, [id])).rowCount).toBe(1)
    for (const st of ['REFUNDED', 'SPLIT']) { // each from its own FUNDS_LOCKED escrow
      const t = await tradeWithCommittedPair()
      const e = (await rt.query(`INSERT INTO escrows (id,"tradeId","lockedAmount",asset,type,"commitmentPairId","updatedAt") VALUES ($1,$2,0.005,'BTC','MULTISIG',$3,now()) RETURNING id`, [randomUUID(), t.tradeId, t.pairId])).rows[0].id
      await rt.query(`UPDATE escrows SET "multisigAddr"='bc1q${st}' WHERE id=$1`, [e])
      await rt.query(`UPDATE escrows SET status='FUNDS_LOCKED' WHERE id=$1`, [e])
      expect((await rt.query(`UPDATE escrows SET status=$2::"EscrowStatus", "updatedAt"=now() WHERE id=$1`, [e, st])).rowCount).toBe(1)
    }
  })

  it('4. the triggers bind the runtime too (insert without a pair: check_violation), and the runtime cannot switch them off', async () => {
    const t = await tradeWithCommittedPair() // any trade; the pair is deliberately omitted below
    expect(await code(rt.query(`INSERT INTO escrows (id,"tradeId","lockedAmount",asset,type,"updatedAt") VALUES ($1,$2,0.005,'BTC','MULTISIG',now())`, [randomUUID(), t.tradeId]))).toBe('23514')
    expect(await code(rt.query(`ALTER TABLE escrows DISABLE TRIGGER ALL`))).toBe('42501') // not the owner
    expect(await code(rt.query(`ALTER TABLE escrows DISABLE TRIGGER escrows_f4_guard_insert`))).toBe('42501')
    expect(await code(rt.query(`DROP TRIGGER escrows_f4_guard_insert ON escrows`))).toBe('42501')
    await assertRuntimeCannotUseReplica(rt) // superuser-only: the trick the fixtures use is denied to the runtime (42501)
    expect(await code(rt.query(`ALTER TABLE escrows ADD COLUMN x int`))).toBe('42501')
  })

  it('5. deployment_mode (gate 3): the runtime can only READ it; with no row MOCK needs a pair (as runtime); the ADMIN inserts the row and MOCK is then exempt (as runtime)', async () => {
    const priv = async (p: string) => (await su.query(`SELECT has_table_privilege('sails_runtime','public.deployment_mode',$1) AS ok`, [p])).rows[0].ok
    expect(await priv('SELECT')).toBe(true)
    for (const p of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) expect([p, await priv(p)]).toEqual([p, false])
    expect(await code(rt.query(`INSERT INTO deployment_mode (mode) VALUES ('test')`))).toBe('42501')
    expect(await code(rt.query(`UPDATE deployment_mode SET mode = 'test'`))).toBe('42501')
    expect(await code(rt.query(`DELETE FROM deployment_mode`))).toBe('42501')
    expect((await rt.query('SELECT count(*)::int AS n FROM deployment_mode')).rows[0].n).toBe(0) // the migration inserted nothing
    const mockEscrow = async () => {
      const t = await tradeWithCommittedPair()
      return rt.query(`INSERT INTO escrows (id,"tradeId","lockedAmount",asset,type,"updatedAt") VALUES ($1,$2,0.005,'BTC','MOCK',now())`, [randomUUID(), t.tradeId])
    }
    expect(await code(mockEscrow())).toBe('23514') // production (no row): MOCK needs a COMMITTED pair
    await require(path.join(ROOT, 'scripts', 'db', 'set-deployment-mode.js')).setDeploymentMode(su, 'test') // the ADMIN step
    expect(await code(mockEscrow())).toBe('OK') // the trigger reads the table AS the runtime role and MOCK is exempt
    expect(await code(rt.query(`INSERT INTO deployment_mode (mode) VALUES ('development')`))).toBe('42501')
  })

  it('6. a seeded LEGACY WDK escrow finishes its cycle AS RUNTIME (triggers on), while a NEW WDK escrow created by the runtime is still refused (the seed does not weaken deny-by-default)', async () => {
    const t = await tradeWithCommittedPair()
    const prev = process.env.ADMIN_DATABASE_URL
    process.env.ADMIN_DATABASE_URL = urlFor(baseUrl.username, baseUrl.password) // the helper takes its OWN superuser connection to the scratch database
    let id: string
    try { id = await legacyEscrowSeed({ tradeId: t.tradeId, type: 'WDK_USDT_EVM', lockedAmount: '5', asset: 'USDT_ERC20', multisigAddr: '0xlegacy' }) } finally { if (prev === undefined) delete process.env.ADMIN_DATABASE_URL; else process.env.ADMIN_DATABASE_URL = prev }
    expect((await rt.query("SELECT type::text AS type FROM escrows WHERE id = $1", [id])).rows[0].type).toBe('WDK_USDT_EVM')
    expect((await rt.query("UPDATE escrows SET status='FUNDS_LOCKED', \"lockedAt\"=now() WHERE id=$1", [id])).rowCount).toBe(1)
    expect((await rt.query("UPDATE escrows SET status='DISPUTED' WHERE id=$1", [id])).rowCount).toBe(1)
    expect((await rt.query("UPDATE escrows SET status='COMPLETED', \"txReleaseId\"='tx', \"releasedAt\"=now() WHERE id=$1", [id])).rowCount).toBe(1)
    const other = await tradeWithCommittedPair()
    expect(await code(rt.query("INSERT INTO escrows (id,\"tradeId\",\"lockedAmount\",asset,type,\"updatedAt\") VALUES ($1,$2,5,'USDT_ERC20','WDK_USDT_EVM',now())", [randomUUID(), other.tradeId]))).toBe('23514')
    expect(await code(rt.query("UPDATE escrows SET \"legacyPreCommitmentAt\" = now() WHERE id = $1", [id]))).toBe('42501')
  })
  it('7. M-1b (GK B2/B4a): the runtime only READS reservations (no INSERT, UPDATE or DELETE, even a direct INSERT is permission denied) and cannot write the unblock proof; it keeps the declaration columns the service updates', async () => {
    const colUpdate = async (t: string, c: string) => (await su.query(`SELECT has_column_privilege('sails_runtime', $1, $2, 'UPDATE') AS ok`, [`public.${t}`, c])).rows[0].ok as boolean
    for (const c of ['state', 'releasedAt', 'releaseKind', 'releaseProof', 'amount', 'commitmentPairId']) expect([c, await colUpdate('offer_capacity_reservations', c)]).toEqual([c, false])
    const tbl = async (p: string) => (await su.query(`SELECT has_table_privilege('sails_runtime', 'public.offer_capacity_reservations', $1) AS ok`, [p])).rows[0].ok as boolean
    expect(await tbl('SELECT')).toBe(true)
    for (const p of ['INSERT', 'UPDATE', 'DELETE']) expect([p, await tbl(p)]).toEqual([p, false])
    expect(await colUpdate('offer_capacity', 'unblockProof')).toBe(false)
    for (const c of ['capacityTotal', 'capacityRevision', 'declaration', 'declarationSignature']) expect([c, await colUpdate('offer_capacity', c)]).toEqual([c, true])
    // GK B8: the runtime may call only try_release and request_unblock (grants really applied here); the internals are for no application role
    const can = async (fn: string) => (await su.query(`SELECT has_function_privilege('sails_runtime', $1, 'EXECUTE') AS ok`, [fn])).rows[0].ok as boolean
    expect(await can('offer_capacity_try_release(text)')).toBe(true)
    expect(await can('offer_capacity_request_unblock(text, jsonb, text)')).toBe(true)
    for (const fn of ['offer_capacity_settlement_proof(text)', 'offer_capacity_execute_unblock(text, text, text)', 'offer_capacity_block_on_evidence()',
      'offer_capacity_unblock_digest(text, text, text, text, timestamptz, jsonb, text)', 'commitment_pairs_reserve_capacity()']) expect([fn, await can(fn)]).toEqual([fn, false])
    // the privilege check precedes any constraint: a direct INSERT as the runtime is refused outright
    expect(await code(rt.query(`INSERT INTO offer_capacity_reservations ("id","ownerPublicKey","logicalOfferId","tradeIntentId","commitmentPairId","amount","capacityRevisionObserved","capacityTotalAtReservation","offerRevision","offerEnvelopeDigest")
      VALUES (gen_random_uuid()::text,'o','l','a','p',0.00000001,1,1000000,1,'x')`))).toBe('42501')
  })
})
