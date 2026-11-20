/**
 * F4 / invariant 3b, S1 (CTO Despacho 021, P63): the STRUCTURAL layer. Migration 20261120130000 binds every new escrow to a COMMITTED
 * commitment pair in the database itself. Real PostgreSQL, raw SQL only (no service): the point is that NO path avoids the triggers.
 * Fixtures are inserted with session_replication_role=replica (superuser, fixtures only); every assertion runs with triggers ON.
 */
import { randomUUID } from 'crypto'
import { Client } from 'pg'
import { createPostgresIntegrationHarness } from './postgresTestHarness'

const hex64 = () => randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
const hex128 = () => hex64() + hex64()

describe('F4 S1 - escrow commitment binding triggers (real PostgreSQL, raw SQL)', () => {
  jest.setTimeout(120_000)
  const pg = createPostgresIntegrationHarness()
  let db: Client
  let feePolicyId = ''
  let makerId = '', takerId = '', offerId = ''
  const RUN = randomUUID().slice(0, 8)

  async function replica<T>(fn: () => Promise<T>): Promise<T> {
    await db.query("SET session_replication_role = 'replica'")
    try { return await fn() } finally { await db.query("SET session_replication_role = 'origin'") }
  }
  const fails = async (sql: string, params: any[], needle: RegExp) => {
    await db.query('BEGIN')
    try { await db.query(sql, params); throw new Error('expected the statement to be refused') }
    catch (e: any) { expect(String(e.message)).toMatch(needle) }
    finally { await db.query('ROLLBACK') }
  }

  beforeAll(async () => {
    await pg.probe()
    if (!pg.isAvailable()) return
    db = new Client({ connectionString: process.env.DATABASE_URL })
    await db.connect()
    const mk = async (k: string) => (await db.query(`INSERT INTO users (id, "publicKey", "updatedAt") VALUES ($1, $2, now()) RETURNING id`, [randomUUID(), `f4-${RUN}-${k}-${randomUUID()}`])).rows[0].id
    makerId = await mk('maker'); takerId = await mk('taker')
    offerId = (await db.query(`INSERT INTO offers (id, "userId", asset, side, "priceUsd", "minAmount", "maxAmount", "paymentMethod", "updatedAt") VALUES ($1,$2,'BTC','SELL',65000,0.001,0.01,'PIX',now()) RETURNING id`, [randomUUID(), makerId])).rows[0].id
    const en = await db.query(`SELECT (enum_range(NULL::"FeePayerModel"))[1] AS p, (enum_range(NULL::"FeeEconomicBasis"))[1] AS b`)
    feePolicyId = (await db.query(`INSERT INTO fee_policy_versions (id, label, "railScope", "protocolFeeRate", "payerModel", "economicBasis", "createdBy") VALUES ($1,$2,$3,0.004,$4,$5,'f4-test') RETURNING id`,
      [randomUUID(), `f4-${RUN}`, `F4-${RUN}`, en.rows[0].p, en.rows[0].b])).rows[0].id
  })
  afterAll(async () => { if (db) await db.end() })

  /** A trade whose own Intent id is the anchor (#651: trades.tradeIntentId -> intents.id). */
  async function newTrade(): Promise<{ tradeId: string; anchor: string }> {
    const anchor = randomUUID(), tradeId = randomUUID()
    await db.query(`INSERT INTO intents (id, type, "participantId", "moduleId", payload, status, "updatedAt") VALUES ($1,'TRADE',$2,'openp2p','{}'::jsonb,'CREATED',now())`, [anchor, takerId])
    await db.query(`INSERT INTO trades (id, "offerId", "buyerId", "sellerId", asset, amount, "priceUsd", "totalUsd", "tradeIntentId", "updatedAt") VALUES ($1,$2,$3,$4,'BTC',0.005,65000,325,$5,now())`, [tradeId, offerId, takerId, makerId, anchor])
    return { tradeId, anchor }
  }
  /** A pair row in the given state for the anchor. Fixture only (triggers off); the CHECKs of the table still apply. */
  async function newPair(anchor: string, state: 'COMMITTED' | 'PROPOSED' | 'WITHDRAWN'): Promise<string> {
    const id = randomUUID(), t = new Date().toISOString(), e = new Date(Date.now() + 3_600_000).toISOString(), d = hex64()
    const trade = { rail: 'MULTISIG', anchorRef: anchor, feePolicyVersionId: feePolicyId, makerPublicKey: 'm', takerPublicKey: 't', proposedAt: t, expiresAt: e, amount: '0.00500000' }
    const arb = { arbitrationCapability: 'FIXED_ARBITER_COMMITMENT', commitmentDigest: d, commitmentDomainTag: 'sails-trade-commitment-v1', anchorRef: anchor, makerPublicKey: 'm', takerPublicKey: 't', rail: 'MULTISIG', proposedAt: t, expiresAt: e }
    const signed = state === 'COMMITTED'
    await replica(() => db.query(
      `INSERT INTO commitment_pairs (id, "anchorRef", "committedAnchorRef", "commitmentDigest", "arbitrationCommitmentDigest", trade, arbitration, policy, "feePolicyVersionId", rail, capability, state,
         "makerTradeSig","makerArbitrationSig","makerReceivedAt","takerTradeSig","takerArbitrationSig","takerReceivedAt","withdrawnBy","withdrawProof")
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,'{}'::jsonb,$8,'MULTISIG','FIXED_ARBITER_COMMITMENT',$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [id, anchor, signed ? anchor : null, d, hex64(), JSON.stringify(trade), JSON.stringify(arb), feePolicyId, state,
        signed ? hex128() : null, signed ? hex128() : null, signed ? new Date() : null, signed ? hex128() : null, signed ? hex128() : null, signed ? new Date() : null,
        state === 'WITHDRAWN' ? 'maker' : null, state === 'WITHDRAWN' ? hex128() : null]))
    return id
  }
  const insertEscrow = (tradeId: string, pairId: string | null, type = 'MULTISIG', extra = '') =>
    db.query(`INSERT INTO escrows (id, "tradeId", "lockedAmount", asset, type, "commitmentPairId", "updatedAt"${extra ? ', ' + extra.split('=')[0] : ''}) VALUES ($1,$2,0.005,'BTC',$3::"EscrowType",$4,now()${extra ? ', ' + extra.split('=')[1] : ''}) RETURNING id`, [randomUUID(), tradeId, type, pairId])

  it('INSERT: a MULTISIG escrow without a pair is refused', async () => {
    const { tradeId } = await newTrade()
    await fails(`INSERT INTO escrows (id, "tradeId", "lockedAmount", asset, type, "updatedAt") VALUES ($1,$2,0.005,'BTC','MULTISIG',now())`, [randomUUID(), tradeId], /needs a COMMITTED commitment pair/)
  })

  it('INSERT: PROPOSED / WITHDRAWN pair refused; COMMITTED pair of ANOTHER trade refused; the trade\'s own COMMITTED pair accepted', async () => {
    const { tradeId, anchor } = await newTrade()
    const other = await newTrade()
    for (const st of ['PROPOSED', 'WITHDRAWN'] as const) {
      const p = await newPair(randomUUID(), st)
      await fails(`INSERT INTO escrows (id, "tradeId", "lockedAmount", asset, type, "commitmentPairId", "updatedAt") VALUES ($1,$2,0.005,'BTC','MULTISIG',$3,now())`, [randomUUID(), tradeId, p], /is not COMMITTED/)
    }
    const foreign = await newPair(other.anchor, 'COMMITTED')
    await fails(`INSERT INTO escrows (id, "tradeId", "lockedAmount", asset, type, "commitmentPairId", "updatedAt") VALUES ($1,$2,0.005,'BTC','MULTISIG',$3,now())`, [randomUUID(), tradeId, foreign], /anchor mismatch/)
    const own = await newPair(anchor, 'COMMITTED')
    expect((await insertEscrow(tradeId, own)).rowCount).toBe(1)
  })

  it('INSERT: the legacy marks cannot be written by a new row, even with a COMMITTED pair', async () => {
    const { tradeId, anchor } = await newTrade()
    const pair = await newPair(anchor, 'COMMITTED')
    await fails(`INSERT INTO escrows (id, "tradeId", "lockedAmount", asset, type, "commitmentPairId", "legacyPreCommitmentAt", "updatedAt") VALUES ($1,$2,0.005,'BTC','MULTISIG',$3,now(),now())`, [randomUUID(), tradeId, pair], /legacy marks are written only by the cut migration/)
  })

  it('INSERT: every escrow type is classified (the polarity is documented by the test, not assumed)', async () => {
    const r = await db.query(`SELECT t::text AS t, escrows_f4_pair_required(t) AS req FROM unnest(enum_range(NULL::"EscrowType")) AS t`)
    const required = r.rows.filter((x) => x.req).map((x) => x.t).sort()
    const exempt = r.rows.filter((x) => !x.req).map((x) => x.t).sort()
    // DECIDED (CTO Despacho 029, B): deny by default; the ONLY exemption is MOCK. MULTISIG and WDK_USDT_EVM are required.
    expect(exempt).toEqual(['MOCK'])
    expect(required).toEqual(expect.arrayContaining(['MULTISIG', 'WDK_USDT_EVM', 'LIGHTNING_HODL', 'LIQUID_COVENANT', 'SAFE_GUARD_EVM']))
    expect(required.length + exempt.length).toBe(r.rows.length) // every enum value is classified: a future type is required by default
  })

  it('INSERT: EVERY non-MOCK type without a pair is refused (WDK_USDT_EVM and every enum value, not a hand-written list)', async () => {
    const types = (await db.query(`SELECT t::text AS t FROM unnest(enum_range(NULL::"EscrowType")) AS t WHERE t::text <> 'MOCK'`)).rows.map((x) => x.t)
    expect(types).toContain('WDK_USDT_EVM')
    for (const type of types) {
      const { tradeId } = await newTrade()
      await fails(`INSERT INTO escrows (id, "tradeId", "lockedAmount", asset, type, "updatedAt") VALUES ($1,$2,0.005,'BTC',$3::"EscrowType",now())`, [randomUUID(), tradeId, type], /needs a COMMITTED commitment pair/)
    }
    const { tradeId } = await newTrade() // MOCK is the single explicit exemption
    expect((await db.query(`INSERT INTO escrows (id, "tradeId", "lockedAmount", asset, type, "updatedAt") VALUES ($1,$2,0.005,'BTC','MOCK',now())`, [randomUUID(), tradeId])).rowCount).toBe(1)
  })

  it('the type and the trade link cannot be changed afterwards to get around the binding (MOCK -> MULTISIG, or moving the escrow to another trade)', async () => {
    const { tradeId } = await newTrade()
    const id = (await db.query(`INSERT INTO escrows (id, "tradeId", "lockedAmount", asset, type, "updatedAt") VALUES ($1,$2,0.005,'BTC','MOCK',now()) RETURNING id`, [randomUUID(), tradeId])).rows[0].id
    await fails(`UPDATE escrows SET type = 'MULTISIG' WHERE id = $1`, [id], /type and tradeId are immutable/)
    const other = await newTrade()
    await fails(`UPDATE escrows SET "tradeId" = $2 WHERE id = $1`, [id, other.tradeId], /type and tradeId are immutable/)
  })

  it('commitmentPairId and both legacy marks are immutable', async () => {
    const { tradeId, anchor } = await newTrade()
    const pair = await newPair(anchor, 'COMMITTED')
    const id = (await insertEscrow(tradeId, pair)).rows[0].id
    const second = await newPair(randomUUID(), 'COMMITTED')
    await fails(`UPDATE escrows SET "commitmentPairId" = $2 WHERE id = $1`, [id, second], /commitmentPairId is immutable/)
    await fails(`UPDATE escrows SET "commitmentPairId" = NULL WHERE id = $1`, [id], /commitmentPairId is immutable/)
    await fails(`UPDATE escrows SET "legacyPreCommitmentAt" = now() WHERE id = $1`, [id], /legacy marks are immutable/)
    await fails(`UPDATE escrows SET "addressPresentAtCutAt" = now() WHERE id = $1`, [id], /legacy marks are immutable/)
  })

  it('deposit address: stored under a COMMITTED pair; changing it is refused; clearing it is refused', async () => {
    const { tradeId, anchor } = await newTrade()
    const id = (await insertEscrow(tradeId, await newPair(anchor, 'COMMITTED'))).rows[0].id
    expect((await db.query(`UPDATE escrows SET "multisigAddr" = 'bc1qfirst' WHERE id = $1`, [id])).rowCount).toBe(1)
    await fails(`UPDATE escrows SET "multisigAddr" = 'bc1qsecond' WHERE id = $1`, [id], /deposit address is immutable once written/)
    await fails(`UPDATE escrows SET "multisigAddr" = NULL WHERE id = $1`, [id], /deposit address is immutable once written/)
  })

  it('deposit address: a legacy escrow without an address cannot get one (a legacy mark does not authorize a new address)', async () => {
    const { tradeId } = await newTrade()
    // A pre-cut row can only exist with triggers off (fixture), with the legacy mark and NO pair.
    const id = randomUUID()
    await replica(() => db.query(`INSERT INTO escrows (id, "tradeId", "lockedAmount", asset, type, "legacyPreCommitmentAt", "updatedAt") VALUES ($1,$2,0.005,'BTC','MULTISIG',now(),now())`, [id, tradeId]))
    await fails(`UPDATE escrows SET "multisigAddr" = 'bc1qnew' WHERE id = $1`, [id], /stored only under a COMMITTED commitment pair/)
  })

  it('CREATED -> FUNDS_LOCKED: COMMITTED pair accepted; nothing accepted; legacy needs BOTH marks', async () => {
    const t1 = await newTrade()
    const ok = (await insertEscrow(t1.tradeId, await newPair(t1.anchor, 'COMMITTED'))).rows[0].id
    expect((await db.query(`UPDATE escrows SET status = 'FUNDS_LOCKED' WHERE id = $1`, [ok])).rowCount).toBe(1)

    const mkLegacy = async (marks: { legacy: boolean; address: boolean }) => {
      const t = await newTrade(), id = randomUUID()
      await replica(() => db.query(
        `INSERT INTO escrows (id, "tradeId", "lockedAmount", asset, type, "multisigAddr", "legacyPreCommitmentAt", "addressPresentAtCutAt", "updatedAt") VALUES ($1,$2,0.005,'BTC','MULTISIG','bc1qlegacy',$3,$4,now())`,
        [id, t.tradeId, marks.legacy ? new Date() : null, marks.address ? new Date() : null]))
      return id
    }
    expect((await db.query(`UPDATE escrows SET status = 'FUNDS_LOCKED' WHERE id = $1`, [await mkLegacy({ legacy: true, address: true })])).rowCount).toBe(1)
    await fails(`UPDATE escrows SET status = 'FUNDS_LOCKED' WHERE id = $1`, [await mkLegacy({ legacy: true, address: false })], /funding is registered only under a COMMITTED commitment pair/)
    await fails(`UPDATE escrows SET status = 'FUNDS_LOCKED' WHERE id = $1`, [await mkLegacy({ legacy: false, address: false })], /funding is registered only under a COMMITTED commitment pair/)
  })

  it('expiresAt: NULL -> value (the clock starts) accepted; moving it earlier accepted; later or cleared refused, for EVERY escrow', async () => {
    const { tradeId, anchor } = await newTrade()
    const id = (await insertEscrow(tradeId, await newPair(anchor, 'COMMITTED'))).rows[0].id
    const t0 = new Date(Date.now() + 3_600_000)
    expect((await db.query(`UPDATE escrows SET "expiresAt" = $2 WHERE id = $1`, [id, t0])).rowCount).toBe(1)
    expect((await db.query(`UPDATE escrows SET "expiresAt" = $2 WHERE id = $1`, [id, new Date(t0.getTime() - 60_000)])).rowCount).toBe(1)
    await fails(`UPDATE escrows SET "expiresAt" = $2 WHERE id = $1`, [id, new Date(t0.getTime() + 60_000)], /cannot be cleared or extended/)
    await fails(`UPDATE escrows SET "expiresAt" = NULL WHERE id = $1`, [id], /cannot be cleared or extended/)
  })

  it('GROUP B: release / refund / split / dispute status changes and non-bound columns run NO function of this migration', async () => {
    const { tradeId, anchor } = await newTrade()
    const id = (await insertEscrow(tradeId, await newPair(anchor, 'COMMITTED'))).rows[0].id
    await db.query(`UPDATE escrows SET status = 'FUNDS_LOCKED' WHERE id = $1`, [id])
    await db.query('BEGIN')
    try {
      await db.query(`SET LOCAL track_functions = 'all'`)
      await db.query(`UPDATE escrows SET status = 'DISPUTED' WHERE id = $1`, [id])
      await db.query(`UPDATE escrows SET status = 'COMPLETED', "txReleaseId" = 'rel', "updatedAt" = now() WHERE id = $1`, [id])
      const calls = await db.query(`SELECT funcname, calls FROM pg_stat_xact_user_functions WHERE funcname LIKE 'escrows\\_f4\\_%'`)
      expect(calls.rows).toEqual([])
    } finally { await db.query('ROLLBACK') }
  })

  it('the fired-function probe is not vacuous: an UPDATE of a bound column DOES register the function', async () => {
    const { tradeId, anchor } = await newTrade()
    const id = (await insertEscrow(tradeId, await newPair(anchor, 'COMMITTED'))).rows[0].id
    await db.query('BEGIN')
    try {
      await db.query(`SET LOCAL track_functions = 'all'`)
      await db.query(`UPDATE escrows SET "multisigAddr" = 'bc1qprobe' WHERE id = $1`, [id])
      const calls = await db.query(`SELECT funcname FROM pg_stat_xact_user_functions WHERE funcname = 'escrows_f4_guard_update'`)
      expect(calls.rows.length).toBe(1)
    } finally { await db.query('ROLLBACK') }
  })

  it('the pair cannot be deleted while an escrow is bound to it: the F3 guard refuses DELETE, and the FK is RESTRICT as the second layer', async () => {
    const { tradeId, anchor } = await newTrade()
    const pair = await newPair(anchor, 'COMMITTED')
    await insertEscrow(tradeId, pair)
    await fails(`DELETE FROM commitment_pairs WHERE id = $1`, [pair], /pairs are never removed/)
    const fk = await db.query(`SELECT confdeltype FROM pg_constraint WHERE conname = 'escrows_commitmentPairId_fkey'`)
    expect(fk.rows[0].confdeltype).toBe('r') // r = RESTRICT
  })
})
