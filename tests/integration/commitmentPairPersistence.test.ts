/**
 * E25/E26 F3 (CTO 28 Despacho 021, P63) - commitment-pair persistence against REAL PostgreSQL.
 * Service: src/modules/open-p2p/commitment-pair.service.ts. Database guards: migration 20261120120000.
 * Fixtures are built fresh at run time (windows relative to now), signed with deterministic Ed25519 seeds; no Redis.
 */
import nacl from 'tweetnacl'
import { randomUUID } from 'crypto'
import { spawn } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { createPostgresIntegrationHarness } from './postgresTestHarness'

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const kp = (byte: number) => nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(byte))
const maker = kp(0x41), taker = kp(0x42), stranger = kp(0x43), arbiter = kp(0x44)
const sign = (digestHex: string, k: nacl.SignKeyPair) => hex(nacl.sign.detached(new Uint8Array(Buffer.from(digestHex, 'hex')), k.secretKey))
const iso = (ms: number) => new Date(ms).toISOString()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('E25/E26 F3 - commitment pair persistence (real PostgreSQL)', () => {
  jest.setTimeout(120_000)
  const pg = createPostgresIntegrationHarness()
  let prisma: any, svcMod: any, envMod: any, offerRepo: any, tc: any, ac: any
  let makerId: string, takerId: string, strangerId: string, feePolicyVersionId: string, feePolicyDigest: string
  const RUN = randomUUID().slice(0, 8)
  let revision = 1
  const logicalOfferId = `f3-offer-${RUN}`

  beforeAll(async () => {
    await pg.probe()
    if (!pg.isAvailable()) return
    ;({ prisma } = require('../../src/common/database'))
    svcMod = require('../../src/modules/open-p2p/commitment-pair.service')
    envMod = require('../../src/modules/open-liquidity/offer-envelope')
    ;({ offerEnvelopeRepository: offerRepo } = require('../../src/modules/open-liquidity/offer-envelope-repository'))
    tc = require('../../src/modules/open-p2p/trade-commitment')
    ac = require('../../src/modules/open-p2p/arbitration-commitment')
    const mk = async (k: nacl.SignKeyPair) => (await prisma.user.upsert({ where: { publicKey: hex(k.publicKey) }, update: {}, create: { publicKey: hex(k.publicKey), displayName: 'f3' } })).id
    makerId = await mk(maker); takerId = await mk(taker); strangerId = await mk(stranger)
    const fp = await prisma.feePolicyVersion.create({
      data: { label: `f3-fee-${RUN}`, railScope: `F3_FIXTURE-${RUN}`, status: 'PUBLISHED', publishedAt: new Date(), protocolFeeRate: '0.004', payerModel: 'SELLER_PAYS', economicBasis: 'SELLER_DELIVERED_VALUE', requiredConfirmations: 2, createdBy: 'f3-test' },
    })
    feePolicyVersionId = fp.id
    feePolicyDigest = tc.feePolicyDigestV1({ protocolFeeRate: '0.004', payerModel: 'SELLER_PAYS', economicBasis: 'SELLER_DELIVERED_VALUE', requiredConfirmations: 2, smallTradeRule: {} })
    await publishOffer('ACTIVE')
  })
  afterAll(async () => { if (prisma) await prisma.$disconnect() })

  let envelopeDigest = ''
  async function publishOffer(status: 'ACTIVE' | 'CANCELLED', bump = false) {
    if (bump) revision++
    const now = Date.now()
    const content = {
      logicalOfferId, ownerPublicKey: hex(maker.publicKey), asset: 'BTC', side: 'SELL', priceUsd: '65000.00000000',
      minAmount: '0.00100000', maxAmount: '0.01000000', paymentMethod: 'PIX', revision,
      createdAt: iso(now - 120_000), revisedAt: iso(now - 60_000 + revision), expiresAt: iso(now + 86_400_000), status,
    }
    const signature = envMod.signOfferEnvelope(content, hex(maker.secretKey))
    const r = await offerRepo.ingest({ ...content, signature })
    expect(r.accepted).toBe(true)
    envelopeDigest = envMod.hashOfferEnvelope(content).toString('hex')
  }

  const POLICY: Record<string, any> = {
    FIXED_ARBITER_COMMITMENT: { mode: 'trusted-list', arbiterSelection: 'fixed', appeal: 'NONE_SCRIPT_FIXED', liveness: 'NONE_UNDER_CURRENT_SCRIPT' },
    UNKNOWN: { mode: 'none', arbiterSelection: 'unproven', appeal: 'NONE_UNPROVEN', liveness: 'NONE_UNPROVEN' },
  }
  /** A fresh pair: TradeCommitmentV1 + ArbitrationCommitmentV1 + policy, with the taker's two signatures. */
  function fresh(opts: { rail?: string; capability?: string; anchorRef?: string; ttlMs?: number } = {}) {
    const rail = opts.rail ?? 'MULTISIG', capability = opts.capability ?? 'FIXED_ARBITER_COMMITMENT'
    const now = Date.now()
    const commitment = {
      anchorRef: opts.anchorRef ?? randomUUID(), offerEnvelopeDigest: envelopeDigest, offerLogicalId: logicalOfferId, offerRevision: revision,
      makerPublicKey: hex(maker.publicKey), takerPublicKey: hex(taker.publicKey), side: 'SELL', asset: 'BTC', rail, network: 'bitcoin-testnet',
      amount: '0.00500000', priceUsd: '65000.00000000', paymentMethod: 'PIX', feePolicyVersionId, feePolicyDigest,
      proposedAt: iso(now - 5_000), expiresAt: iso(now + (opts.ttlMs ?? 1_800_000)),
    }
    const policy = { policyVersion: '1', capability, rail, hosting: 'PARTIES_HOLD_COPIES_HOST_CONVENIENCE_FAILOVER_OPEN', ...POLICY[capability] }
    const cd = tc.hashTradeCommitment(commitment)
    const arbitration = {
      commitmentDigest: cd, commitmentDomainTag: 'sails-trade-commitment-v1', anchorRef: commitment.anchorRef,
      makerPublicKey: commitment.makerPublicKey, takerPublicKey: commitment.takerPublicKey, rail, arbitrationCapability: capability,
      arbitrationPolicyDigest: ac.hashArbitrationPolicy(policy), arbiterRef: capability === 'UNKNOWN' ? 'UNPROVEN' : hex(arbiter.publicKey),
      proposedAt: commitment.proposedAt, expiresAt: commitment.expiresAt,
    }
    const ad = ac.hashArbitrationCommitment(arbitration)
    const proposeInput = (key = randomUUID()) => ({
      participantId: takerId, idempotencyKey: key,
      trade: { commitment, declaredDigest: cd, takerSignature: sign(cd, taker) },
      arbitration: { commitment: arbitration, declaredDigest: ad, policy, takerSignature: sign(ad, taker) },
    })
    const makerSign = (pairId: string, key = randomUUID()) => ({ participantId: makerId, idempotencyKey: key, pairId, role: 'maker', tradeSignature: sign(cd, maker), arbitrationSignature: sign(ad, maker) })
    return { commitment, arbitration, policy, cd, ad, proposeInput, makerSign }
  }
  const service = () => new svcMod.CommitmentPairService({ enabledRails: () => new Set(['MULTISIG', 'WDK_USDT_EVM']) })
  const refusedWith = async (p: Promise<unknown>, code: string) => { await expect(p).rejects.toMatchObject({ code }) }

  it('propose (taker) -> PARTIALLY_SIGNED; maker signs -> COMMITTED, executable, one stamp per party from the database clock', async () => {
    pg.requirePostgres('F3 happy path')
    const s = service(); const f = fresh()
    const p = await s.proposePair(f.proposeInput())
    expect(p).toMatchObject({ state: 'PARTIALLY_SIGNED', executable: false, reason: null, commitmentDigest: f.cd, arbitrationCommitmentDigest: f.ad })
    const c = await s.signPair(f.makerSign(p.pairId))
    expect(c).toMatchObject({ pairId: p.pairId, state: 'COMMITTED', executable: true })
    const row = await prisma.commitmentPair.findUnique({ where: { id: p.pairId } })
    expect(row).toMatchObject({ committedAnchorRef: f.commitment.anchorRef, capability: 'FIXED_ARBITER_COMMITMENT', rail: 'MULTISIG' })
    expect(row.makerReceivedAt.getTime()).toBeGreaterThanOrEqual(row.takerReceivedAt.getTime())
    // Both from the database clock: the stamp is read once, before admission; createdAt is clock_timestamp() at the INSERT.
    expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(row.takerReceivedAt.getTime())
    expect(row.createdAt.getTime() - row.takerReceivedAt.getTime()).toBeLessThan(10_000)
  })

  it('idempotency: the same key + body re-reads the pair as it is NOW; the same key with another body is refused; another participant\'s key is independent', async () => {
    pg.requirePostgres('F3 idempotency')
    const s = service(); const f = fresh(); const key = randomUUID()
    const p = await s.proposePair(f.proposeInput(key))
    await s.signPair(f.makerSign(p.pairId))
    expect(await s.proposePair(f.proposeInput(key))).toMatchObject({ pairId: p.pairId, state: 'COMMITTED' }) // re-read, not a cached PARTIALLY_SIGNED
    const other = fresh()
    await expect(s.proposePair({ ...other.proposeInput(key) })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    const claims = await prisma.idempotencyKey.findMany({ where: { key } })
    expect(claims).toHaveLength(1)
    expect(claims[0]).toMatchObject({ status: 'COMPLETED', resultRef: p.pairId, scope: 'commitment_pair.propose', participantId: takerId })
  })

  it('authorship: only the participant whose registered key is the role key may propose or sign (E25_NOT_A_PARTY)', async () => {
    pg.requirePostgres('F3 authorship')
    const s = service(); const f = fresh()
    await refusedWith(s.proposePair({ ...f.proposeInput(), participantId: strangerId }), 'E25_NOT_A_PARTY')
    const p = await s.proposePair(f.proposeInput())
    await refusedWith(s.signPair({ ...f.makerSign(p.pairId), participantId: takerId }), 'E25_NOT_A_PARTY')
  })

  it('P22: an UNKNOWN-rail pair is stored PROPOSED with its reason and stays a non-executable proposal after both parties sign', async () => {
    pg.requirePostgres('F3 UNKNOWN')
    const s = service(); const f = fresh({ rail: 'WDK_USDT_EVM', capability: 'UNKNOWN' })
    const p = await s.proposePair(f.proposeInput())
    expect(p).toMatchObject({ state: 'PROPOSED', executable: false, reason: 'E26_CAPABILITY_UNPROVEN' })
    expect(await s.signPair(f.makerSign(p.pairId))).toMatchObject({ state: 'PROPOSED', executable: false, reason: 'E26_CAPABILITY_UNPROVEN' })
    const { readiness } = await prisma.$transaction((tx: any) => svcMod.lockPairForEffect(tx, { pairId: p.pairId }))
    expect(readiness).toEqual({ ok: false, code: 'E26_CAPABILITY_UNPROVEN' })
  })

  it('lockPairForEffect: only a COMMITTED pair is ready; PARTIALLY_SIGNED is E25_NOT_COMMITTED', async () => {
    pg.requirePostgres('F3 readiness')
    const s = service(); const f = fresh()
    const p = await s.proposePair(f.proposeInput())
    expect((await prisma.$transaction((tx: any) => svcMod.lockPairForEffect(tx, { pairId: p.pairId }))).readiness).toEqual({ ok: false, code: 'E25_NOT_COMMITTED' })
    await s.signPair(f.makerSign(p.pairId))
    expect((await prisma.$transaction((tx: any) => svcMod.lockPairForEffect(tx, { pairId: p.pairId }))).readiness).toMatchObject({ ok: true, gate: 'COMMITMENT_PAIR_COMMITTED' })
    const byAnchor = await prisma.$transaction((tx: any) => svcMod.lockPairForEffect(tx, { anchorRef: f.commitment.anchorRef }))
    expect(byAnchor.row.id).toBe(p.pairId)
    expect(byAnchor.t).toBeInstanceOf(Date)
    expect((await prisma.$transaction((tx: any) => svcMod.lockPairForEffect(tx, { anchorRef: randomUUID() }))).readiness).toEqual({ ok: false, code: 'E25_COMMITMENT_MISSING' })
  })

  it('T3: an offer revised after the proposal refuses the maker\'s signature (the CURRENT signed state is read at every operation)', async () => {
    pg.requirePostgres('F3 T3')
    const s = service(); const f = fresh()
    const p = await s.proposePair(f.proposeInput())
    await publishOffer('ACTIVE', true)
    await refusedWith(s.signPair(f.makerSign(p.pairId)), 'E25_OFFER_ENVELOPE_INVALID')
  })

  it('C5: a signature received at or after expiresAt is refused (database clock, exclusive limit)', async () => {
    pg.requirePostgres('F3 C5')
    const s = service(); const f = fresh({ ttlMs: 2_500 })
    const p = await s.proposePair(f.proposeInput())
    await sleep(3_000)
    await refusedWith(s.signPair(f.makerSign(p.pairId)), 'E25_EXPIRED')
    expect((await prisma.commitmentPair.findUnique({ where: { id: p.pairId } })).state).toBe('PARTIALLY_SIGNED')
  })

  it('C3: withdraw x final signature on the same pair - one wins, never both (row lock)', async () => {
    pg.requirePostgres('F3 C3')
    const s = service(); const f = fresh()
    const p = await s.proposePair(f.proposeInput())
    const proof = sign(svcMod.withdrawProofDigest(f.cd, f.ad), taker)
    const results = await Promise.allSettled([
      s.signPair(f.makerSign(p.pairId)),
      s.withdrawPair({ participantId: takerId, idempotencyKey: randomUUID(), pairId: p.pairId, role: 'taker', proof }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const final = (await prisma.commitmentPair.findUnique({ where: { id: p.pairId } })).state
    expect(['COMMITTED', 'WITHDRAWN']).toContain(final)
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(lost.reason.code).toBe(final === 'COMMITTED' ? 'E25_ANCHOR_ALREADY_COMMITTED' : 'E25_COMMITMENT_SUPERSEDED')
  })

  it('B8: withdraw needs the party\'s proof; after WITHDRAWN no signature is accepted; after COMMITTED no withdrawal', async () => {
    pg.requirePostgres('F3 B8')
    const s = service(); const f = fresh()
    const p = await s.proposePair(f.proposeInput())
    await refusedWith(s.withdrawPair({ participantId: takerId, idempotencyKey: randomUUID(), pairId: p.pairId, role: 'taker', proof: sign(svcMod.withdrawProofDigest(f.cd, f.ad), stranger) }), 'E25_SIGNATURE_INVALID')
    expect(await s.withdrawPair({ participantId: takerId, idempotencyKey: randomUUID(), pairId: p.pairId, role: 'taker', proof: sign(svcMod.withdrawProofDigest(f.cd, f.ad), taker) })).toMatchObject({ state: 'WITHDRAWN' })
    await refusedWith(s.signPair(f.makerSign(p.pairId)), 'E25_COMMITMENT_SUPERSEDED')
    const g = fresh(); const q = await s.proposePair(g.proposeInput()); await s.signPair(g.makerSign(q.pairId))
    await refusedWith(s.withdrawPair({ participantId: makerId, idempotencyKey: randomUUID(), pairId: q.pairId, role: 'maker', proof: sign(svcMod.withdrawProofDigest(g.cd, g.ad), maker) }), 'E25_ANCHOR_ALREADY_COMMITTED')
  })

  // ── The database guards themselves, by direct SQL (the service is bypassed on purpose) ───────────────────────
  async function partiallySigned() {
    const f = fresh(); const p = await service().proposePair(f.proposeInput())
    return { f, id: p.pairId }
  }
  const rawRefused = async (sql: Promise<unknown>) => { await expect(sql).rejects.toThrow() }

  it('K1: COMMITTED without both parties (or for a non-executable capability) is refused by a CHECK', async () => {
    pg.requirePostgres('F3 K1')
    const { f, id } = await partiallySigned()
    await rawRefused(prisma.$executeRaw`UPDATE "commitment_pairs" SET "state" = 'COMMITTED', "committedAnchorRef" = ${f.commitment.anchorRef} WHERE "id" = ${id}`)
  })

  it('K4: a copy or a binding field diverging from the canonical object is refused (and the objects are immutable)', async () => {
    pg.requirePostgres('F3 K4')
    const { id } = await partiallySigned()
    await rawRefused(prisma.$executeRaw`UPDATE "commitment_pairs" SET "rail" = 'MOCK' WHERE "id" = ${id}`)
    await rawRefused(prisma.$executeRaw`UPDATE "commitment_pairs" SET "trade" = jsonb_set("trade", '{amount}', '"0.00600000"') WHERE "id" = ${id}`)
    await rawRefused(prisma.$executeRaw`UPDATE "commitment_pairs" SET "reason" = 'E26_CAPABILITY_UNPROVEN' WHERE "id" = ${id}`)
  })

  it('write-once: a stored signature or stamp cannot be changed or cleared; a pair is never deleted nor truncated', async () => {
    pg.requirePostgres('F3 write-once')
    const { id } = await partiallySigned()
    await rawRefused(prisma.$executeRaw`UPDATE "commitment_pairs" SET "takerTradeSig" = ${'0'.repeat(128)} WHERE "id" = ${id}`)
    await rawRefused(prisma.$executeRaw`UPDATE "commitment_pairs" SET "takerTradeSig" = NULL, "takerArbitrationSig" = NULL, "takerReceivedAt" = NULL WHERE "id" = ${id}`)
    await rawRefused(prisma.$executeRaw`DELETE FROM "commitment_pairs" WHERE "id" = ${id}`)
    await rawRefused(prisma.$executeRaw`TRUNCATE "commitment_pairs"`)
    expect(await prisma.commitmentPair.count({ where: { id } })).toBe(1)
  })

  it('write-once alone: on a non-executable PROPOSED pair (PROPOSED -> PROPOSED is a legal transition) a stored signature still cannot be replaced', async () => {
    pg.requirePostgres('F3 write-once PROPOSED')
    const f = fresh({ rail: 'WDK_USDT_EVM', capability: 'UNKNOWN' })
    const p = await service().proposePair(f.proposeInput())
    await rawRefused(prisma.$executeRaw`UPDATE "commitment_pairs" SET "takerTradeSig" = ${sign(f.cd, stranger)} WHERE "id" = ${p.pairId}`)
    expect((await prisma.commitmentPair.findUnique({ where: { id: p.pairId } })).takerTradeSig).toBe(f.proposeInput().trade.takerSignature)
  })

  it('(A) the stored stamp IS the instant the admission used (read once, truncated to the column precision): over 12 operations', async () => {
    pg.requirePostgres('F3 stamp identity')
    const s = service()
    for (let n = 0; n < 6; n++) {
      const f = fresh(); const pk = randomUUID(); const mk = randomUUID()
      const p = await s.proposePair(f.proposeInput(pk)); await s.signPair(f.makerSign(p.pairId, mk))
      const row = await prisma.commitmentPair.findUnique({ where: { id: p.pairId } })
      const claim = async (key: string) => (await prisma.idempotencyKey.findFirst({ where: { key } })).completedAt.getTime()
      expect([n, row.takerReceivedAt.getTime()]).toEqual([n, await claim(pk)])
      expect([n, row.makerReceivedAt.getTime()]).toEqual([n, await claim(mk)])
    }
  })

  it('(A) stamp window: a maker stamp that is not this transaction\'s database clock (an application-supplied past instant) is refused', async () => {
    pg.requirePostgres('F3 stamp window')
    const { f, id } = await partiallySigned()
    const past = new Date(Date.now() - 60_000)
    await rawRefused(prisma.$executeRaw`UPDATE "commitment_pairs" SET "makerTradeSig" = ${sign(f.cd, maker)}, "makerArbitrationSig" = ${sign(f.ad, maker)},
      "makerReceivedAt" = ${past}, "state" = 'COMMITTED', "committedAnchorRef" = ${f.commitment.anchorRef} WHERE "id" = ${id}`)
  })

  it('(A) stamp window: even a stamp taken from THIS transaction database clock is refused by the trigger once it is >= expiresAt', async () => {
    pg.requirePostgres('F3 stamp expiry')
    const f = fresh({ ttlMs: 2_500 }); const p = await service().proposePair(f.proposeInput())
    await sleep(3_000)
    await rawRefused(prisma.$executeRaw`UPDATE "commitment_pairs" SET "makerTradeSig" = ${sign(f.cd, maker)}, "makerArbitrationSig" = ${sign(f.ad, maker)},
      "makerReceivedAt" = date_trunc('milliseconds', clock_timestamp()), "state" = 'COMMITTED', "committedAnchorRef" = ${f.commitment.anchorRef} WHERE "id" = ${p.pairId}`)
    expect((await prisma.commitmentPair.findUnique({ where: { id: p.pairId } })).state).toBe('PARTIALLY_SIGNED')
  })

  it('B-1: the runtime role may only INSERT/SELECT and UPDATE the signing/state columns; never the canonical pair, never DELETE/TRUNCATE', async () => {
    pg.requirePostgres('F3 B-1 privileges')
    // Only where scripts/db/runtime-grants.sql was applied to THIS database (it records sails_meta.runtime_table_class):
    // roles are cluster-wide, grants are per database. The "restricted runtime role" lane applies it and runs this.
    const [{ applied }] = await prisma.$queryRaw`SELECT (to_regclass('sails_meta.runtime_table_class') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sails_runtime')) AS applied`
    if (!applied) return
    const col = async (c: string) => (await prisma.$queryRaw`SELECT has_column_privilege('sails_runtime', 'public.commitment_pairs', ${c}, 'UPDATE') AS ok`)[0].ok
    const tbl = async (priv: string) => (await prisma.$queryRaw`SELECT has_table_privilege('sails_runtime', 'public.commitment_pairs', ${priv}) AS ok`)[0].ok
    for (const c of ['state', 'committedAnchorRef', 'makerTradeSig', 'makerArbitrationSig', 'makerReceivedAt', 'takerTradeSig', 'takerArbitrationSig', 'takerReceivedAt', 'withdrawnBy', 'withdrawProof']) expect([c, await col(c)]).toEqual([c, true])
    for (const c of ['trade', 'arbitration', 'policy', 'commitmentDigest', 'arbitrationCommitmentDigest', 'anchorRef', 'rail', 'capability', 'reason', 'feePolicyVersionId', 'createdAt']) expect([c, await col(c)]).toEqual([c, false])
    expect([await tbl('SELECT'), await tbl('INSERT'), await tbl('DELETE'), await tbl('TRUNCATE')]).toEqual([true, true, false, false])
  })

  it('terminal: a COMMITTED pair accepts no further UPDATE; a pair is born taker-only (T1)', async () => {
    pg.requirePostgres('F3 terminal')
    const s = service(); const f = fresh()
    const p = await s.proposePair(f.proposeInput()); await s.signPair(f.makerSign(p.pairId))
    await rawRefused(prisma.$executeRaw`UPDATE "commitment_pairs" SET "state" = 'EXPIRED', "committedAnchorRef" = NULL WHERE "id" = ${p.pairId}`)
    const g = fresh()
    await rawRefused(prisma.$executeRaw`INSERT INTO "commitment_pairs" ("id","anchorRef","commitmentDigest","arbitrationCommitmentDigest","trade","arbitration","policy","feePolicyVersionId","rail","capability","state","makerTradeSig","makerArbitrationSig","makerReceivedAt")
      VALUES (${randomUUID()}, ${g.commitment.anchorRef}, ${g.cd}, ${g.ad}, ${JSON.stringify(g.commitment)}::jsonb, ${JSON.stringify(g.arbitration)}::jsonb, ${JSON.stringify(g.policy)}::jsonb,
              ${feePolicyVersionId}, 'MULTISIG', 'FIXED_ARBITER_COMMITMENT', 'PARTIALLY_SIGNED', ${sign(g.cd, maker)}, ${sign(g.ad, maker)}, clock_timestamp())`)
  })

  // ── D-1 and "the pair is never partial": a real OS process SIGKILLed at three points of signPair() ───────────
  const WORKER = path.join(__dirname, 'commitmentPairKill.worker.ts')
  async function killAt(point: string, input: unknown): Promise<string> {
    const dir = mkdtempSync(path.join(tmpdir(), 'f3kill-'))
    const child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', WORKER], {
      cwd: path.join(__dirname, '..', '..'),
      env: { ...process.env, SYNC_DIR: dir, KILL_AT: point, SIGN_INPUT: JSON.stringify(input), ENABLED_RAILS: JSON.stringify(['MULTISIG', 'WDK_USDT_EVM']) },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr!.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-5_000) })
    const exited = new Promise<void>((r) => child.on('exit', () => r()))
    for (let i = 0; i < 600 && !existsSync(path.join(dir, 'arrived')); i++) {
      if (child.exitCode !== null) throw new Error(`worker exited before ${point}: ${stderr}`)
      await sleep(100)
    }
    const arrived = JSON.parse(readFileSync(path.join(dir, 'arrived'), 'utf8')).point
    child.kill('SIGKILL')
    await exited
    rmSync(dir, { recursive: true, force: true })
    return arrived
  }

  for (const point of ['after-pair-update', 'after-claim'] as const) {
    it(`SIGKILL inside the transaction (${point}): nothing persists - the pair is unchanged and no claim exists; the retry with the same key commits once`, async () => {
      pg.requirePostgres(`F3 SIGKILL ${point}`)
      const s = service(); const f = fresh()
      const p = await s.proposePair(f.proposeInput())
      const input = f.makerSign(p.pairId)
      expect(await killAt(point, input)).toBe(point)
      const row = await prisma.commitmentPair.findUnique({ where: { id: p.pairId } })
      expect(row).toMatchObject({ state: 'PARTIALLY_SIGNED', makerTradeSig: null, makerReceivedAt: null, committedAnchorRef: null })
      expect(await prisma.idempotencyKey.count({ where: { key: input.idempotencyKey } })).toBe(0)
      expect(await s.signPair(input)).toMatchObject({ pairId: p.pairId, state: 'COMMITTED' })
      expect(await prisma.idempotencyKey.count({ where: { key: input.idempotencyKey } })).toBe(1)
    })
  }

  it('SIGKILL after COMMIT, before the answer: the effect and its claim both persisted; the retry re-reads the pair (no second effect)', async () => {
    pg.requirePostgres('F3 SIGKILL after-commit')
    const s = service(); const f = fresh()
    const p = await s.proposePair(f.proposeInput())
    const input = f.makerSign(p.pairId)
    expect(await killAt('after-commit', input)).toBe('after-commit')
    const row = await prisma.commitmentPair.findUnique({ where: { id: p.pairId } })
    expect(row.state).toBe('COMMITTED')
    const stamp = row.makerReceivedAt.getTime()
    expect(await s.signPair(input)).toMatchObject({ pairId: p.pairId, state: 'COMMITTED' })
    expect((await prisma.commitmentPair.findUnique({ where: { id: p.pairId } })).makerReceivedAt.getTime()).toBe(stamp)
    expect(await prisma.idempotencyKey.count({ where: { key: input.idempotencyKey } })).toBe(1)
  })

  /** A worker process running one signPair(); with hold, it waits at `point` until released (a real 2-session barrier). */
  function startWorker(label: string, point: string, input: unknown, hold: boolean) {
    const dir = mkdtempSync(path.join(tmpdir(), `f3-${label}-`))
    const child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', WORKER], {
      cwd: path.join(__dirname, '..', '..'),
      env: { ...process.env, SYNC_DIR: dir, KILL_AT: point, HOLD: hold ? '1' : '0', PGAPPNAME: `f3-${label}-${RUN}`, SIGN_INPUT: JSON.stringify(input), ENABLED_RAILS: JSON.stringify(['MULTISIG', 'WDK_USDT_EVM']) },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr!.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-5_000) })
    const exited = new Promise<void>((r) => child.on('exit', () => r()))
    const waitFile = async (name: string) => {
      for (let i = 0; i < 600 && !existsSync(path.join(dir, name)); i++) {
        if (child.exitCode !== null && !existsSync(path.join(dir, name))) throw new Error(`worker ${label} exited without ${name}: ${stderr}`)
        await sleep(100)
      }
      return readFileSync(path.join(dir, name), 'utf8')
    }
    return {
      arrived: () => waitFile('arrived'),
      release: () => writeFileSync(path.join(dir, 'go'), 'go'),
      result: async () => { await exited; const r = JSON.parse(await waitFile('result')); rmSync(dir, { recursive: true, force: true }); return r },
    }
  }

  it('C2 with a real barrier: session A holds its uncommitted COMMITTED UPDATE; session B, same anchor, is seen WAITING on it; A commits and B loses with E25_ANCHOR_ALREADY_COMMITTED', async () => {
    pg.requirePostgres('F3 C2 barrier')
    const s = service(); const anchorRef = randomUUID()
    const a = fresh({ anchorRef }), b = fresh({ anchorRef, ttlMs: 1_700_000 }) // two pairs, different digests, one anchor
    const pa = await s.proposePair(a.proposeInput()); const pb = await s.proposePair(b.proposeInput())
    const A = startWorker('A', 'after-pair-update', a.makerSign(pa.pairId), true)
    expect(JSON.parse(await A.arrived()).point).toBe('after-pair-update')
    const B = startWorker('B', 'none', b.makerSign(pb.pairId), false)
    let waiting = false
    for (let i = 0; i < 300 && !waiting; i++) {
      const [{ n }] = await prisma.$queryRaw`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = ${`f3-B-${RUN}`} AND wait_event_type = 'Lock'`
      waiting = n > 0; if (!waiting) await sleep(50)
    }
    A.release()
    const [ra, rb] = await Promise.all([A.result(), B.result()])
    process.stdout.write(`[evidence] ${JSON.stringify({ label: 'F3 C2 barrier', bWaitedOnA: waiting, a: ra, b: rb })}
`)
    expect(waiting).toBe(true)
    expect(ra).toMatchObject({ ok: true, view: { state: 'COMMITTED' } })
    expect(rb).toEqual({ ok: false, code: 'E25_ANCHOR_ALREADY_COMMITTED' })
    expect(await prisma.commitmentPair.count({ where: { anchorRef, state: 'COMMITTED' } })).toBe(1)
  })
})
