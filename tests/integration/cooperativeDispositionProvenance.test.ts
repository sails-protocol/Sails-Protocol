// tests/integration/cooperativeDispositionProvenance.test.ts
//
// #235 R7G F8B — SIGNATURE_COLLECTION_DISPOSITION_AUTHORITY_V1 / COOPERATIVE_DISPOSITION_PROVENANCE_V1, on real
// PostgreSQL with real secp256k1 keys and PSBTs. For a signature-collection rail (MULTISIG here) the disposition
// authority is the persisted signing round; cooperativeDisposition / arbitratedDisposition are direct-execution
// fields. A direct release / refund / split on such a rail is refused BEFORE any claim, so it leaves zero durable
// state — no status flip, no frozen disposition, no event, no round — and the legitimate signature-collection path
// still settles, never writing either field.
//
// The explorer is the same small address-faithful chain as multisigResidualRecovery.test.ts.

import { PrismaClient } from '@prisma/client'
import * as bitcoin from 'bitcoinjs-lib'
import * as ecc from '@bitcoinerlab/secp256k1'
import { ECPairFactory } from 'ecpair'
import { createHash, randomBytes } from 'crypto'
import nacl from 'tweetnacl'
import { MULTISIG_CAPABILITY_PROFILE_V1 } from '@satsails/p2p-schemas'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { boundOfferRow, boundTradeRow, sellerPixAccount, deleteFixtureAccounts } from './economicFixtures'
import { closeTestRedis } from './identityTestHelpers'

bitcoin.initEccLib(ecc)
const ECPair = ECPairFactory(ecc)
const NET = bitcoin.networks.testnet
const keyOf = (label: string) => ECPair.fromPrivateKey(createHash('sha256').update(`r7gf8b-${label}`).digest(), { network: NET })
const hex = (k: { publicKey: Uint8Array }) => Buffer.from(k.publicKey).toString('hex')
const addressOf = (label: string) => bitcoin.payments.p2wpkh({ pubkey: Buffer.from(ecc.pointFromScalar(createHash('sha256').update(label).digest(), true)!), network: NET }).address!
const FUNDING = 100_000
const ARBITER = 'r7gf8b-arbiter'
const arbiterKeypair = nacl.sign.keyPair()

type ChainTx = { height: number | null; outputs: Array<{ address: string; value: number }>; spends: Array<{ txid: string; vout: number }> }
const txs = new Map<string, ChainTx>()
let tip = 300
const broadcasts: string[] = []
const spenderOf = (txid: string, vout: number) => [...txs.entries()].find(([, t]) => t.spends.some((s) => s.txid === txid && s.vout === vout))?.[0]
const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as any
const notFound = () => ({ ok: false, status: 404, text: async () => 'not found', json: async () => ({}) }) as any
function explorer() {
  global.fetch = jest.fn(async (url: any, init?: any) => {
    const u = String(url)
    if (u.endsWith('/blocks/tip/height')) return { ok: true, status: 200, text: async () => String(tip) } as any
    if (u.includes('/fees/recommended')) return json({ halfHourFee: 2, fastestFee: 3 })
    let m = u.match(/\/tx\/([0-9a-f]{64})\/status$/)
    if (m) { const t = txs.get(m[1]); return t ? json(t.height === null ? { confirmed: false } : { confirmed: true, block_height: t.height }) : notFound() }
    m = u.match(/\/tx\/([0-9a-f]{64})\/outspend\/(\d+)$/)
    if (m) { const s = spenderOf(m[1], Number(m[2])); return json(s ? { spent: true, txid: s } : { spent: false }) }
    m = u.match(/\/address\/([^/]+)\/utxo$/)
    if (m) {
      const out: unknown[] = []
      for (const [txid, t] of txs) t.outputs.forEach((o, vout) => { if (o.address === m![1] && !spenderOf(txid, vout)) out.push({ txid, vout, value: o.value, status: { confirmed: t.height !== null } }) })
      return json(out)
    }
    if (u.endsWith('/tx') && init?.method === 'POST') {
      const tx = bitcoin.Transaction.fromHex(String(init.body))
      txs.set(tx.getId(), {
        height: null,
        outputs: tx.outs.map((o) => ({ address: bitcoin.address.fromOutputScript(Buffer.from(o.script), NET), value: Number(o.value) })),
        spends: tx.ins.map((i) => ({ txid: Buffer.from(i.hash).reverse().toString('hex'), vout: i.index })),
      })
      broadcasts.push(String(init.body))
      return { ok: true, status: 200, text: async () => tx.getId() } as any
    }
    return notFound()
  }) as any
}
function deposit(address: string, value: number) {
  const txid = randomBytes(32).toString('hex')
  txs.set(txid, { height: tip, outputs: [{ address, value }], spends: [] })
  return txid
}
function mine() { tip++; for (const t of txs.values()) if (t.height === null) t.height = tip }

describe('#235 R7G F8B — signature-collection disposition provenance (real PostgreSQL, real cryptography)', () => {
  jest.setTimeout(180_000)
  const pg = createPostgresIntegrationHarness()
  let prisma: PrismaClient
  let escrowService: any
  const extra: Array<{ prisma: any; redis?: any }> = []
  let realFetch: typeof fetch

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'false'
    process.env.MULTISIG_SEED = 'r7gf8b-seed'
    process.env.TRUSTED_ARBITRATORS = ARBITER
    process.env.MULTISIG_NETWORK = 'testnet'
    process.env.MULTISIG_FUNDING_REQUIRED_CONFIRMATIONS = '1'
    await pg.probe()
    if (!pg.isAvailable()) return
    ;({ prisma } = require('../../src/common/database'))
    require('../../src/common/events/handlers').registerEventHandlers()
    ;({ escrowService } = require('../../src/modules/open-settlement/escrow.service'))
    await prisma.user.upsert({ where: { id: ARBITER }, update: { publicKey: Buffer.from(arbiterKeypair.publicKey).toString('hex') }, create: { id: ARBITER, publicKey: Buffer.from(arbiterKeypair.publicKey).toString('hex'), displayName: ARBITER } })
    realFetch = global.fetch
    explorer()
  })

  afterAll(async () => {
    if (!pg.isAvailable()) return
    global.fetch = realFetch
    try {
      const users = (await prisma.user.findMany({ where: { displayName: { startsWith: 'r7gf8b-' } }, select: { id: true } })).map((u) => u.id)
      const tradeIds = (await prisma.trade.findMany({ where: { OR: [{ buyerId: { in: users } }, { sellerId: { in: users } }] }, select: { id: true } })).map((t) => t.id)
      const escrowIds = (await prisma.escrow.findMany({ where: { tradeId: { in: tradeIds } }, select: { id: true } })).map((e) => e.id)
      const pendingIds = (await prisma.escrowPendingTransaction.findMany({ where: { escrowId: { in: escrowIds } }, select: { id: true } })).map((p) => p.id)
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('ALTER TABLE escrow_participant_keys DISABLE TRIGGER escrow_participant_keys_arbiter_immutability_guard')
        await tx.$executeRawUnsafe('ALTER TABLE escrow_participant_keys DISABLE TRIGGER escrow_participant_keys_script_authority_guard')
        await tx.$executeRaw`DELETE FROM escrow_participant_keys WHERE "escrowId" = ANY(${escrowIds})`
        await tx.$executeRawUnsafe('ALTER TABLE escrow_participant_keys ENABLE TRIGGER escrow_participant_keys_script_authority_guard')
        await tx.$executeRawUnsafe('ALTER TABLE escrow_participant_keys ENABLE TRIGGER escrow_participant_keys_arbiter_immutability_guard')
      })
      const refs = await prisma.$queryRaw<Array<{ table_name: string; column_name: string }>>`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name IN ('tradeId', 'escrowId', 'interactionId', 'pendingTxId', 'disputeId')
          AND table_name NOT IN ('trades', 'escrows', 'escrow_participant_keys')`
      const disputeIds = (await prisma.dispute.findMany({ where: { tradeId: { in: tradeIds } }, select: { id: true } })).map((d) => d.id)
      for (let pass = 0; pass < 5; pass++) {
        for (const { table_name, column_name } of refs) {
          const ids = column_name === 'tradeId' ? tradeIds : column_name === 'pendingTxId' ? pendingIds : column_name === 'disputeId' ? disputeIds : escrowIds
          await prisma.$executeRawUnsafe(`DELETE FROM "${table_name}" WHERE "${column_name}" = ANY($1)`, ids).catch(() => undefined)
        }
      }
      await prisma.$executeRaw`DELETE FROM event_projection_claims WHERE "subjectId" = ANY(${tradeIds}) OR "subjectId" = ANY(${escrowIds})`
      await prisma.durableEventRecord.deleteMany({ where: { correlationId: { in: tradeIds } } })
      await prisma.$executeRaw`UPDATE trades SET "escrowId" = NULL WHERE id = ANY(${tradeIds})`
      await prisma.$executeRaw`DELETE FROM escrows WHERE id = ANY(${escrowIds})`
      await prisma.$executeRaw`DELETE FROM trades WHERE id = ANY(${tradeIds})`
      await prisma.$executeRaw`DELETE FROM offers WHERE "userId" = ANY(${users})`
      await deleteFixtureAccounts(prisma, users)
      await prisma.$executeRaw`DELETE FROM payout_addresses WHERE "participantId" = ANY(${users})`
      await prisma.$executeRaw`DELETE FROM users WHERE id = ANY(${users})`
    } finally {
      for (const n of extra) { await n.prisma.$disconnect().catch(() => undefined); await n.redis?.quit().catch(() => undefined) }
      await prisma.$disconnect()
      await closeTestRedis()
    }
  })

  // ─── fixtures ─────────────────────────────────────────────────────────────────────────────────────────

  function node() {
    let n!: { escrowService: any; reconcile: (o: unknown) => Promise<unknown>; prisma: any; redis?: any }
    jest.isolateModules(() => {
      n = {
        escrowService: require('../../src/modules/open-settlement/escrow.service').escrowService,
        reconcile: require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service').reconcilePendingSettlements,
        prisma: require('../../src/common/database').prisma,
        redis: require('../../src/common/redis').redis,
      }
    })
    extra.push(n)
    return n
  }
  /** A funded MULTISIG escrow (FUNDS_LOCKED) with real participant keys. */
  async function locked(label: string) {
    const mk = async (r: string) => prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex'), displayName: `r7gf8b-${label}-${r}-${randomBytes(3).toString('hex')}` } })
    const seller = await mk('s'), buyer = await mk('b'), stranger = await mk('x')
    for (const p of [buyer, seller]) await prisma.payoutAddress.create({ data: { participantId: p.id, asset: 'BTC', address: addressOf(`payout-${p.id}`) } })
    const acct = await sellerPixAccount(prisma, seller.id)
    const offer = await prisma.offer.create({ data: { userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '1', minAmount: '0.00000001', maxAmount: '100', ...boundOfferRow(acct) } })
    const t = await prisma.trade.create({ data: { ...boundTradeRow(acct), offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, asset: 'BTC', amount: '0.001', priceUsd: '1', totalUsd: '0.001', status: 'ACTIVE' } })
    const e = await escrowService.createEscrow({ tradeId: t.id, asset: 'BTC', lockedAmount: '0.001', type: 'MULTISIG' }, seller.id)
    const keys: Record<string, any> = { [buyer.id]: keyOf(`${label}-buyer`), [seller.id]: keyOf(`${label}-seller`) }
    await escrowService.submitParticipantKey(e.id, buyer.id, hex(keys[buyer.id]), MULTISIG_CAPABILITY_PROFILE_V1)
    await escrowService.submitParticipantKey(e.id, seller.id, hex(keys[seller.id]), MULTISIG_CAPABILITY_PROFILE_V1)
    const addr = (await prisma.escrow.findUniqueOrThrow({ where: { id: e.id } })).multisigAddr!
    deposit(addr, FUNDING); mine()
    await escrowService.lockFunds(e.id, seller.id)
    return { t, e, buyer, seller, stranger, keys, addr }
  }
  type Fx = Awaited<ReturnType<typeof locked>>
  async function disputed(f: Fx) {
    await escrowService.markPaymentSent(f.e.id, f.buyer.id)
    await escrowService.openDispute(f.e.id, f.buyer.id, 'f8b provenance')
    await prisma.dispute.create({ data: { tradeId: f.t.id, escrowId: f.e.id, openedBy: f.buyer.id, reason: 'f8b provenance', arbiterId: ARBITER } })
    await settled(f)
  }
  /** Escrow projections onto the trade are asynchronous: wait for the expected trade status before taking any snapshot. */
  async function settled(f: Fx, status = 'DISPUTED') {
    for (let i = 0; i < 100 && (await prisma.trade.findUniqueOrThrow({ where: { id: f.t.id } })).status !== status; i++) await new Promise((r) => setTimeout(r, 20))
    expect((await prisma.trade.findUniqueOrThrow({ where: { id: f.t.id } })).status).toBe(status)
  }
  /** The assigned arbiter's signed ruling (dispute.service.resolveDispute): for MULTISIG it opens the arbitrated signing round. */
  async function rule(f: Fx, ruling: 'RELEASE' | 'REFUND') {
    const { signAuthorityDecision } = require('../../src/modules/open-settlement/arbitration-authority')
    const disputeId = (await prisma.dispute.findUniqueOrThrow({ where: { tradeId: f.t.id } })).id
    const issuedAt = new Date().toISOString()
    const signature = signAuthorityDecision({ disputeId, escrowId: f.e.id, appealRound: 0, authorityId: ARBITER, outcome: ruling, buyerBps: null, issuedAt }, arbiterKeypair.secretKey)
    await require('../../src/modules/open-settlement/dispute.service').getDisputeService().resolveDispute(disputeId, ARBITER, ruling, undefined, undefined, undefined, signature, issuedAt)
  }
  const outcome = async (p: Promise<unknown>) => { try { await p; return 'OK' } catch (e: any) { return String(e?.message ?? e) } }
  const signCopy = (b64: string, k: any) => { const p = bitcoin.Psbt.fromBase64(b64, { network: NET }); p.signInput(0, k); return p.toBase64() }
  /** Everything a disposition attempt could leave behind, compared strictly (updatedAt included). */
  async function durable(f: Fx) {
    const e = await prisma.escrow.findUniqueOrThrow({ where: { id: f.e.id } })
    return JSON.stringify({
      escrow: e, trade: await prisma.trade.findUniqueOrThrow({ where: { id: f.t.id } }),
      rounds: await prisma.escrowPendingTransaction.findMany({ where: { escrowId: f.e.id } }),
      signatures: await prisma.escrowTransactionSignature.count({ where: { pendingTx: { escrowId: f.e.id } } }),
      events: await prisma.escrowEvent.findMany({ where: { escrowId: f.e.id }, orderBy: { createdAt: 'asc' } }),
      durableEvents: await prisma.durableEventRecord.count({ where: { correlationId: f.t.id, eventName: { startsWith: 'settlement.' } } }),
      claims: await prisma.eventProjectionClaim.count({ where: { subjectId: f.e.id } }),
      fundingEvidence: await prisma.escrowFundingEvidence.count({ where: { escrowId: f.e.id } }),
      disputes: await prisma.dispute.findMany({ where: { escrowId: f.e.id } }),
      broadcasts: broadcasts.length,
    })
  }
  const dispositions = async (f: Fx) => {
    const e = await prisma.escrow.findUniqueOrThrow({ where: { id: f.e.id } })
    return { cooperativeDisposition: e.cooperativeDisposition, cooperativeTriggeredBy: e.cooperativeTriggeredBy, arbitratedDisposition: e.arbitratedDisposition, arbitratedTriggeredBy: e.arbitratedTriggeredBy }
  }
  const NONE = { cooperativeDisposition: null, cooperativeTriggeredBy: null, arbitratedDisposition: null, arbitratedTriggeredBy: null }
  /** Completes the escrow's current signing round with every required signer's own key. */
  async function completeRound(f: Fx, svc = escrowService) {
    const round = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: f.e.id } })
    for (const signer of round.requiredSigners) await svc.submitTransactionSignature(f.e.id, signer, signCopy(round.unsignedPsbtBase64, f.keys[signer]))
    return round
  }
  const SIGNATURE_COLLECTION = /settles only through signature collection.*Nothing was recorded/
  const ZERO = { claims: 0, providerCalls: 0 }
  /** Runs `fn`, counting claimDirectExecution() writes and direct provider release/refund/split calls on this node. */
  async function counted(fn: () => Promise<unknown>) {
    const { escrowRepository } = require('../../src/modules/open-settlement/escrow-repository')
    const { getSettlementProvider } = require('../../src/modules/open-settlement/escrow-providers')
    const claims = jest.spyOn(escrowRepository, 'claimDirectExecution')
    const provider: jest.SpyInstance[] = []
    for (const type of ['MULTISIG', 'LIGHTNING_HODL', 'SAFE_GUARD_EVM']) {
      let impl: any
      try { impl = getSettlementProvider(type) } catch { continue }
      for (const m of ['releaseFunds', 'refundFunds', 'splitFunds']) if (typeof impl[m] === 'function') provider.push(jest.spyOn(impl, m))
    }
    try { await fn() } finally { claims.mockRestore(); provider.forEach((sp) => sp.mockRestore()) }
    return { claims: claims.mock.calls.length, providerCalls: provider.reduce((n, sp) => n + sp.mock.calls.length, 0) }
  }
  const DB_GUARD = 'escrows_signature_collection_no_direct_disposition_guard'
  /** Plants what a pre-F8B refused direct call left behind — only possible with the F8B guard disabled. */
  async function legacyResidue(f: Fx, disposition: string) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`ALTER TABLE escrows DISABLE TRIGGER ${DB_GUARD}`)
      await tx.$executeRaw`UPDATE escrows SET "cooperativeDisposition" = ${disposition}, "cooperativeTriggeredBy" = ${f.seller.id} WHERE id = ${f.e.id}`
      await tx.$executeRawUnsafe(`ALTER TABLE escrows ENABLE TRIGGER ${DB_GUARD}`)
    })
  }

  // ─── A / B / F: refused direct calls leave nothing; the signature-collection path decides ──────────────

  it('A/F8B-1/8/11: a refused direct REFUND leaves zero durable state; the cooperative RELEASE then completes with no disposition field', async () => {
    pg.requirePostgres('A')
    const f = await locked('a')
    const before = await durable(f)
    expect(await counted(async () => expect(await outcome(escrowService.refundFunds(f.e.id, f.seller.id))).toMatch(SIGNATURE_COLLECTION))).toEqual(ZERO)
    expect(await durable(f)).toEqual(before)
    await escrowService.markPaymentSent(f.e.id, f.buyer.id)
    await escrowService.initiateRelease(f.e.id, undefined, f.seller.id)
    await completeRound(f)
    expect((await prisma.escrow.findUniqueOrThrow({ where: { id: f.e.id } })).status).toBe('COMPLETED')
    expect(await dispositions(f)).toEqual(NONE)
  })

  it('B/F8B-1/8/11: a refused direct RELEASE leaves zero durable state; a cooperative REFUND round then decides, with no disposition field', async () => {
    pg.requirePostgres('B')
    const f = await locked('b')
    await escrowService.markPaymentSent(f.e.id, f.buyer.id)
    const before = await durable(f)
    expect(await counted(async () => expect(await outcome(escrowService.releaseFunds(f.e.id, undefined, f.seller.id))).toMatch(SIGNATURE_COLLECTION))).toEqual(ZERO)
    expect(await durable(f)).toEqual(before)
    // PAYMENT_PENDING settles by RELEASE or by dispute; the refund decision goes through the arbiter's signature round
    await escrowService.openDispute(f.e.id, f.buyer.id, 'f8b b')
    await prisma.dispute.create({ data: { tradeId: f.t.id, escrowId: f.e.id, openedBy: f.buyer.id, reason: 'f8b b', arbiterId: ARBITER } })
    await rule(f, 'REFUND')
    await completeRound(f)
    expect((await prisma.escrow.findUniqueOrThrow({ where: { id: f.e.id } })).status).toBe('REFUNDED')
    expect(await dispositions(f)).toEqual(NONE)
  })

  it('C/E: a direct SPLIT on a signature-collection rail, and a malformed split, are refused before any claim — zero durable state', async () => {
    pg.requirePostgres('C')
    const f = await locked('c')
    await disputed(f)
    const before = await durable(f)
    expect(await counted(async () => {
      expect(await outcome(escrowService.splitFunds(f.e.id, undefined, undefined, 5000, ARBITER))).toMatch(/signature collection|does not support a SPLIT/)
      expect(await outcome(escrowService.splitFunds(f.e.id, undefined, undefined, 0, ARBITER))).toMatch(/buyerBps must be strictly between/)
      expect(await outcome(escrowService.splitFunds(f.e.id, undefined, undefined, 10_000, ARBITER))).toMatch(/buyerBps must be strictly between/)
    })).toEqual(ZERO)
    expect(await durable(f)).toEqual(before)
    expect(await dispositions(f)).toEqual(NONE)
  })

  it('arbitrated/F8B-1: the assigned arbiter\'s direct RELEASE and REFUND on a DISPUTED MULTISIG escrow leave no arbitratedDisposition; the arbiter\'s round decides', async () => {
    pg.requirePostgres('arbitrated')
    const f = await locked('arb')
    await disputed(f)
    const before = await durable(f)
    expect(await counted(async () => {
      expect(await outcome(escrowService.releaseFunds(f.e.id, undefined, ARBITER))).toMatch(SIGNATURE_COLLECTION)
      expect(await outcome(escrowService.refundFunds(f.e.id, ARBITER))).toMatch(SIGNATURE_COLLECTION)
    })).toEqual(ZERO)
    expect(await durable(f)).toEqual(before)
    await rule(f, 'RELEASE')
    await completeRound(f)
    expect((await prisma.escrow.findUniqueOrThrow({ where: { id: f.e.id } })).status).toBe('COMPLETED')
    expect(await dispositions(f)).toEqual(NONE)
  })

  it('D/F8B-9: an unauthorized caller\'s direct release / refund / split leaves zero durable state', async () => {
    pg.requirePostgres('D')
    const f = await locked('d')
    await escrowService.markPaymentSent(f.e.id, f.buyer.id)
    const before = await durable(f)
    expect(await counted(async () => {
      expect(await outcome(escrowService.releaseFunds(f.e.id, undefined, f.stranger.id))).toMatch(/neither the seller|not a party|Forbidden/i)
      expect(await outcome(escrowService.refundFunds(f.e.id, f.stranger.id))).toMatch(/neither the seller|not a party|Forbidden/i)
      expect(await outcome(escrowService.splitFunds(f.e.id, undefined, undefined, 5000, f.stranger.id))).toMatch(/neither the seller|not a party|Forbidden/i)
      // the buyer is a party but never the releaser: authorization refuses first, before the rail check
      expect(await outcome(escrowService.releaseFunds(f.e.id, undefined, f.buyer.id))).toMatch(/neither the seller/)
    })).toEqual(ZERO)
    expect(await durable(f)).toEqual(before)
  })

  it('F/F8B-2: LIGHTNING_HODL and SAFE_GUARD_EVM, the other signature-collection rails, refuse direct release / refund / split before any claim, with zero effect', async () => {
    pg.requirePostgres('F')
    for (const type of ['LIGHTNING_HODL', 'SAFE_GUARD_EVM']) {
      const f = await locked(`f-${type}`)
      // same parties, re-railed rows: the refusal precedes every provider step, so a raw row is enough
      const rows: Record<string, string> = {}
      for (const status of ['FUNDS_LOCKED', 'PAYMENT_PENDING', 'DISPUTED']) {
        const t = await prisma.trade.create({ data: { sellerPaymentAccountId: f.t.sellerPaymentAccountId, offerId: f.t.offerId, buyerId: f.buyer.id, sellerId: f.seller.id, asset: 'BTC', amount: '0.001', priceUsd: '1', totalUsd: '0.001', status: status === 'DISPUTED' ? 'DISPUTED' : 'ACTIVE' } })
        rows[status] = (await prisma.escrow.create({ data: { tradeId: t.id, type: type as any, asset: 'BTC', lockedAmount: '0.001', status: status as any } })).id
        await prisma.trade.update({ where: { id: t.id }, data: { escrowId: rows[status] } })
        if (status === 'DISPUTED') await prisma.dispute.create({ data: { tradeId: t.id, escrowId: rows[status], openedBy: f.buyer.id, reason: 'f8b F', arbiterId: ARBITER } })
      }
      const snap = async () => JSON.stringify(await Promise.all(Object.values(rows).map(async (id) => [await prisma.escrow.findUniqueOrThrow({ where: { id } }), await prisma.escrowEvent.count({ where: { escrowId: id } }), await prisma.escrowPendingTransaction.count({ where: { escrowId: id } })])))
      const before = await snap()
      expect(await counted(async () => {
        expect(await outcome(escrowService.refundFunds(rows.FUNDS_LOCKED, f.seller.id))).toMatch(SIGNATURE_COLLECTION)
        expect(await outcome(escrowService.releaseFunds(rows.PAYMENT_PENDING, undefined, f.seller.id))).toMatch(SIGNATURE_COLLECTION)
        expect(await outcome(escrowService.releaseFunds(rows.DISPUTED, undefined, ARBITER))).toMatch(SIGNATURE_COLLECTION)
        expect(await outcome(escrowService.refundFunds(rows.DISPUTED, ARBITER))).toMatch(SIGNATURE_COLLECTION)
        expect(await outcome(escrowService.splitFunds(rows.DISPUTED, undefined, undefined, 5000, ARBITER))).toMatch(SIGNATURE_COLLECTION)
      })).toEqual(ZERO)
      expect(await snap()).toEqual(before)
    }
  })

  // ─── concurrency / restart ────────────────────────────────────────────────────────────────────────────

  it('C1/C2/C8: refused direct calls racing the cooperative round on other nodes never touch it — one COMPLETED, no disposition, one broadcast', async () => {
    pg.requirePostgres('C1')
    const f = await locked('c1')
    await escrowService.markPaymentSent(f.e.id, f.buyer.id)
    await escrowService.initiateRelease(f.e.id, undefined, f.seller.id)
    const round = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: f.e.id } })
    const n1 = node(), n2 = node(), n3 = node()
    const before = broadcasts.length
    const results = await Promise.all([
      outcome(n1.escrowService.refundFunds(f.e.id, f.seller.id)),
      outcome(n2.escrowService.releaseFunds(f.e.id, undefined, f.seller.id)),
      ...round.requiredSigners.map((s: string) => outcome(n3.escrowService.submitTransactionSignature(f.e.id, s, signCopy(round.unsignedPsbtBase64, f.keys[s])))),
    ])
    expect(results.slice(0, 2).every((r) => SIGNATURE_COLLECTION.test(r) || /Invalid escrow transition/.test(r))).toBe(true)
    const e = await prisma.escrow.findUniqueOrThrow({ where: { id: f.e.id } })
    expect([e.status, broadcasts.length - before]).toEqual(['COMPLETED', 1])
    expect(await dispositions(f)).toEqual(NONE)
  })

  it('C7/C8/F8B-6/7: a crash after the round exists — a fresh node completes the same round; nothing reconstructs a disposition', async () => {
    pg.requirePostgres('C7')
    const f = await locked('c7')
    await escrowService.markPaymentSent(f.e.id, f.buyer.id)
    // crash BEFORE any authority: a node refuses a direct release and dies; a fresh node finds nothing to resume
    const before = await durable(f)
    expect(await outcome(node().escrowService.releaseFunds(f.e.id, undefined, f.seller.id))).toMatch(SIGNATURE_COLLECTION)
    expect(await durable(f)).toEqual(before)
    await node().escrowService.initiateRelease(f.e.id, undefined, f.seller.id)
    const first = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: f.e.id } })
    expect(await outcome(node().escrowService.refundFunds(f.e.id, f.seller.id))).toMatch(SIGNATURE_COLLECTION)
    const round = await completeRound(f, node().escrowService)
    expect([round.id, round.unsignedPsbtBase64]).toEqual([first.id, first.unsignedPsbtBase64])
    await require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service').reconcilePendingSettlements({ projectionGraceMs: 0 })
    expect([(await prisma.escrow.findUniqueOrThrow({ where: { id: f.e.id } })).status, await dispositions(f)]).toEqual(['COMPLETED', NONE])
  })

  it('C3/C4: two incompatible cooperative rounds and a refused direct call race on three nodes: at most one round, whose kind alone decides', async () => {
    pg.requirePostgres('C3')
    const f = await locked('c3')
    const n1 = node(), n2 = node(), n3 = node()
    const before = broadcasts.length
    const results = await Promise.all([
      outcome(n1.escrowService.initiateRefund(f.e.id, f.seller.id)),
      outcome((async () => { await n2.escrowService.markPaymentSent(f.e.id, f.buyer.id); await n2.escrowService.initiateRelease(f.e.id, undefined, f.seller.id) })()),
      outcome(n3.escrowService.refundFunds(f.e.id, f.seller.id)),
    ])
    expect(results[2]).toMatch(SIGNATURE_COLLECTION)
    const rounds = await prisma.escrowPendingTransaction.findMany({ where: { escrowId: f.e.id } })
    expect(rounds.length).toBeLessThanOrEqual(1)
    const status = (await prisma.escrow.findUniqueOrThrow({ where: { id: f.e.id } })).status
    if (rounds.length === 1 && rounds[0].kind === 'refund' && status === 'PAYMENT_PENDING') {
      // NF-F8B-1 (reported, not F8B, routed to the CTO): markPaymentSent() moved the escrow under a pending REFUND
      // round. The live finalize fails closed at the claim; nothing here writes a disposition. The reconciler's
      // behaviour on such a round is the finding itself and is deliberately not asserted as correct here.
      expect(await outcome(completeRound(f))).toMatch(/Invalid escrow transition: PAYMENT_PENDING → REFUNDED/)
      expect([(await prisma.escrow.findUniqueOrThrow({ where: { id: f.e.id } })).status, broadcasts.length - before]).toEqual(['PAYMENT_PENDING', 0])
    } else if (rounds.length === 1) {
      await completeRound(f)
      expect((await prisma.escrow.findUniqueOrThrow({ where: { id: f.e.id } })).status).toBe(rounds[0].kind === 'release' ? 'COMPLETED' : 'REFUNDED')
      expect(broadcasts.length - before).toBe(1)
    } else {
      expect(broadcasts.length - before).toBe(0)
    }
    expect(await dispositions(f)).toEqual(NONE)
  })

  it('C5/C6: the arbiter ruling races the arbiter own refused direct calls on other nodes: one arbitrated round, REFUNDED, no arbitratedDisposition', async () => {
    pg.requirePostgres('C5')
    const f = await locked('c5')
    await disputed(f)
    const n1 = node(), n2 = node()
    const results = await Promise.all([
      outcome(rule(f, 'REFUND')),
      outcome(n1.escrowService.releaseFunds(f.e.id, undefined, ARBITER)),
      outcome(n2.escrowService.refundFunds(f.e.id, ARBITER)),
    ])
    expect(results[0]).toBe('OK')
    expect(results.slice(1).every((x) => SIGNATURE_COLLECTION.test(x))).toBe(true)
    const round = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: f.e.id } })
    expect(round.kind).toBe('refund')
    await completeRound(f)
    expect([(await prisma.escrow.findUniqueOrThrow({ where: { id: f.e.id } })).status, await dispositions(f)]).toEqual(['REFUNDED', NONE])
  })

  it('C9/C10: the reconciler on another node races the live final signature and a refused direct call: one COMPLETED, one transaction, no disposition', async () => {
    pg.requirePostgres('C9')
    const f = await locked('c9')
    await escrowService.markPaymentSent(f.e.id, f.buyer.id)
    await escrowService.initiateRelease(f.e.id, undefined, f.seller.id)
    const round = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: f.e.id } })
    const [first, ...rest] = round.requiredSigners
    await escrowService.submitTransactionSignature(f.e.id, first, signCopy(round.unsignedPsbtBase64, f.keys[first]))
    const n1 = node(), n2 = node(), { reconcile } = node()
    const before = broadcasts.length
    const results = await Promise.all([
      ...rest.map((sg: string) => outcome(n1.escrowService.submitTransactionSignature(f.e.id, sg, signCopy(round.unsignedPsbtBase64, f.keys[sg])))),
      outcome(reconcile({ projectionGraceMs: 0 })),
      outcome(n2.escrowService.refundFunds(f.e.id, f.seller.id)),
    ])
    expect(results[results.length - 1]).toMatch(SIGNATURE_COLLECTION)
    await reconcile({ projectionGraceMs: 0 })
    // both the live finalize and the reconciler may (re)broadcast this escrow's spend: always the same bytes. The
    // reconciler is global, so only transactions spending this escrow's funding outpoint are counted.
    const e = await prisma.escrow.findUniqueOrThrow({ where: { id: f.e.id } })
    const txids = new Set(broadcasts.slice(before).map((h) => bitcoin.Transaction.fromHex(h))
      .filter((t) => t.ins.some((i) => Buffer.from(i.hash).reverse().toString('hex') === e.txLockId && i.index === e.txLockVout)).map((t) => t.getId()))
    expect([e.status, txids.size, [...txids][0], await dispositions(f)]).toEqual(['COMPLETED', 1, e.txReleaseId, NONE])
  })

  // ─── the database: no second disposition authority on a signature-collection row ───────────────────────

  it('DB/F8B-5: direct SQL cannot create or change a direct-execution disposition on a signature-collection escrow; direct-execution rails and legacy rows are unaffected', async () => {
    pg.requirePostgres('DB')
    const f = await locked('db')
    const refused = /settles only through its signing round/
    const sql = (q: string, ...v: unknown[]) => outcome(prisma.$executeRawUnsafe(q, ...v))
    const before = await durable(f)
    expect(await sql(`UPDATE escrows SET "cooperativeDisposition" = 'REFUNDED', "cooperativeTriggeredBy" = $2 WHERE id = $1`, f.e.id, f.seller.id)).toMatch(refused)
    expect(await sql(`UPDATE escrows SET "cooperativeDisposition" = 'COMPLETED', "cooperativeTriggeredBy" = $2 WHERE id = $1`, f.e.id, f.buyer.id)).toMatch(refused)
    expect(await sql(`UPDATE escrows SET "arbitratedDisposition" = 'COMPLETED', "arbitratedTriggeredBy" = $2 WHERE id = $1`, f.e.id, ARBITER)).toMatch(refused)
    expect(await sql(`UPDATE escrows SET "arbitratedDisposition" = 'SPLIT', "arbitratedTriggeredBy" = $2, "splitBuyerBps" = 5000 WHERE id = $1`, f.e.id, ARBITER)).toMatch(refused)
    expect(await durable(f)).toEqual(before)
    // INSERT, and a type change onto a signature-collection rail carrying a slot
    const t2 = await prisma.trade.create({ data: { offerId: f.t.offerId, buyerId: f.buyer.id, sellerId: f.seller.id, asset: 'BTC', amount: '0.001', priceUsd: '1', totalUsd: '0.001', status: 'ACTIVE' } })
    for (const type of ['MULTISIG', 'LIGHTNING_HODL', 'SAFE_GUARD_EVM']) {
      expect(await sql(`INSERT INTO escrows (id, "tradeId", type, asset, "lockedAmount", status, "cooperativeDisposition", "cooperativeTriggeredBy", "updatedAt") VALUES (gen_random_uuid(), $1, '${type}', 'BTC', 0.001, 'CREATED', 'REFUNDED', $2, now())`, t2.id, f.seller.id)).toMatch(refused)
    }
    // a direct-execution rail keeps its legitimate slots (MOCK: written, frozen, then moved to MULTISIG = refused)
    const mockId = (await prisma.$queryRaw<Array<{ id: string }>>`INSERT INTO escrows (id, "tradeId", type, asset, "lockedAmount", status, "cooperativeDisposition", "cooperativeTriggeredBy", "updatedAt") VALUES (gen_random_uuid(), ${t2.id}, 'MOCK', 'BTC', 0.001, 'CREATED', 'REFUNDED', ${f.seller.id}, now()) RETURNING id`)[0].id
    expect(await sql(`UPDATE escrows SET "arbitratedDisposition" = 'COMPLETED', "arbitratedTriggeredBy" = $2 WHERE id = $1`, mockId, ARBITER)).toBe('OK')
    expect(await sql(`UPDATE escrows SET type = 'MULTISIG' WHERE id = $1`, mockId)).toMatch(refused)
    await prisma.$executeRaw`DELETE FROM escrows WHERE id = ${mockId}`
    // a pre-F8B row keeps settling: a status update leaves its (frozen) slot alone and is not refused
    await legacyResidue(f, 'REFUNDED')
    await escrowService.markPaymentSent(f.e.id, f.buyer.id)
    expect((await prisma.escrow.findUniqueOrThrow({ where: { id: f.e.id } })).status).toBe('PAYMENT_PENDING')
    expect(await sql(`UPDATE escrows SET "cooperativeDisposition" = NULL, "cooperativeTriggeredBy" = NULL WHERE id = $1`, f.e.id)).toMatch(/immutable once frozen/)
  })

  // ─── legacy rows: the read-only preflight ─────────────────────────────────────────────────────────────

  it('F8B-10/12: the read-only preflight flags a pre-F8B frozen disposition on a signature-collection escrow, never repairs it, and passes a clean one', async () => {
    pg.requirePostgres('preflight')
    const { runDispositionProvenancePreflight } = require('../../scripts/disposition-provenance-preflight')
    const legacy = await locked('pf-legacy'), contradicted = await locked('pf-contra'), clean = await locked('pf-clean')
    // the pre-F8B residue: a refused direct REFUND froze the field on a still-locked escrow
    await legacyResidue(legacy, 'REFUNDED')
    // ... and on an escrow whose signing round later released it
    await escrowService.markPaymentSent(contradicted.e.id, contradicted.buyer.id)
    await escrowService.initiateRelease(contradicted.e.id, undefined, contradicted.seller.id)
    await completeRound(contradicted)
    await settled(contradicted, 'COMPLETED')
    await legacyResidue(contradicted, 'REFUNDED')
    // direct-execution rail rows (MOCK): a terminal slot with its settlement txid is SAFE; without one, UNVERIFIABLE
    const mock = async (txReleaseId: string | null, slots: object) => (await prisma.escrow.create({ data: { tradeId: (await prisma.trade.create({ data: { offerId: clean.t.offerId, buyerId: clean.buyer.id, sellerId: clean.seller.id, asset: 'BTC', amount: '0.001', priceUsd: '1', totalUsd: '0.001', status: 'ACTIVE' } })).id, type: 'MOCK', asset: 'BTC', lockedAmount: '0.001', status: 'COMPLETED', txReleaseId, ...slots } })).id
    const tx = () => 'mock-tx-' + randomBytes(4).toString('hex')
    const mockSafe = await mock(tx(), { cooperativeDisposition: 'COMPLETED', cooperativeTriggeredBy: clean.seller.id })
    const mockBlind = await mock(null, { cooperativeDisposition: 'COMPLETED', cooperativeTriggeredBy: clean.seller.id })
    // a failed cooperative REFUND, then the arbiter's RELEASE: the arbitrated slot decides; the cooperative one is history
    const mockArbitrated = await mock(tx(), { cooperativeDisposition: 'REFUNDED', cooperativeTriggeredBy: clean.seller.id, arbitratedDisposition: 'COMPLETED', arbitratedTriggeredBy: ARBITER })
    const mockContradicted = await mock(tx(), { cooperativeDisposition: 'REFUNDED', cooperativeTriggeredBy: clean.seller.id })
    const before = await Promise.all([legacy, contradicted, clean].map(durable))
    const report = await runDispositionProvenancePreflight(process.env.DATABASE_URL!)
    expect(report.results.find((r: any) => r.escrowId === mockSafe)).toMatchObject({ classification: 'SAFE', findings: [] })
    expect(report.results.find((r: any) => r.escrowId === mockBlind)).toMatchObject({ classification: 'UNVERIFIABLE', findings: [] })
    expect(report.results.find((r: any) => r.escrowId === mockArbitrated)).toMatchObject({ classification: 'SAFE', findings: [] })
    expect(report.results.find((r: any) => r.escrowId === mockContradicted)).toMatchObject({ classification: 'REVIEW_REQUIRED', findings: [{ kind: 'DISPOSITION_CONTRADICTS_OUTCOME' }] })
    const of = (f: Fx) => report.results.find((r: any) => r.escrowId === f.e.id)
    expect(of(legacy)).toMatchObject({ classification: 'REVIEW_REQUIRED', status: 'FUNDS_LOCKED', findings: [{ kind: 'SIGNATURE_COLLECTION_DIRECT_DISPOSITION' }] })
    expect(of(contradicted)?.classification).toBe('REVIEW_REQUIRED')
    expect(of(contradicted)?.findings.map((x: any) => x.kind)).toEqual(['SIGNATURE_COLLECTION_DIRECT_DISPOSITION', 'DISPOSITION_CONTRADICTS_OUTCOME'])
    expect(of(clean)).toBeUndefined()
    expect(report.reviewRequired).toBeGreaterThanOrEqual(2)
    expect(await Promise.all([legacy, contradicted, clean].map(durable))).toEqual(before)
  })
})
