// tests/integration/multisigScriptAuthority.test.ts
//
// #235 R7G-B2A — SCRIPT_AUTHORITY_IMMUTABILITY_V1, MULTISIG_KEY_DISTINCTNESS_V1 and LOCAL_SIGNATURE_VALIDATION_V1 on
// real PostgreSQL, with real secp256k1 keys and signatures (bitcoinjs-lib / @bitcoinerlab/secp256k1).
//
// The explorer is mocked ADDRESS-FAITHFULLY: a UTXO is visible only at the address it was sent to, and every
// broadcast is captured. Each broadcast is checked by an independent P2WSH 2-of-3 validator (BIP141 program hash,
// BIP143 sighash, ordered CHECKMULTISIG matching) — never by Sails' own code. A "node" is an independent module
// graph (jest.isolateModules) with its own PrismaClient.

import { PrismaClient } from '@prisma/client'
import * as bitcoin from 'bitcoinjs-lib'
import * as ecc from '@bitcoinerlab/secp256k1'
import { ECPairFactory } from 'ecpair'
import { createHash, randomBytes } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import { MULTISIG_CAPABILITY_PROFILE_V1 } from '@satsails/p2p-schemas'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { boundOfferRow, boundTradeRow, sellerPixAccount, deleteFixtureAccounts } from './economicFixtures'
import { closeTestRedis } from './identityTestHelpers'
import { classifyMultisigRow } from '../../scripts/multisig-script-authority-preflight'

bitcoin.initEccLib(ecc)
const ECPair = ECPairFactory(ecc)
const NET = bitcoin.networks.testnet
const keyOf = (label: string) => ECPair.fromPrivateKey(createHash('sha256').update(`r7gb2a-${label}`).digest(), { network: NET })
const hex = (k: { publicKey: Uint8Array }) => Buffer.from(k.publicKey).toString('hex')
const payout = (label: string) => bitcoin.payments.p2wpkh({ pubkey: Buffer.from(ecc.pointFromScalar(createHash('sha256').update(label).digest(), true)!), network: NET }).address!
const PROFILE = MULTISIG_CAPABILITY_PROFILE_V1
const FUNDING = 100_000

// ─── address-faithful explorer, broadcast capture ─────────────────────────────────────────────────────
const chain = new Map<string, Array<{ txid: string; vout: number; value: number }>>()
const broadcasts: string[] = []
const utxoQueries: string[] = []
function explorer() {
  global.fetch = jest.fn(async (url: any, init?: any) => {
    const u = String(url)
    if (u.includes('/blocks/tip/height')) return { ok: true, text: async () => '200' } as any
    if (u.includes('/fees/recommended')) return { ok: true, json: async () => ({ halfHourFee: 2, fastestFee: 3 }) } as any
    const st = u.match(/\/tx\/([0-9a-f]{64})\/status/)
    if (st) return funded.has(st[1]) ? { ok: true, json: async () => ({ confirmed: true, block_height: 100 }) } as any : { ok: false, status: 404, text: async () => 'not found', json: async () => ({}) } as any
    const m = u.match(/\/address\/([^/]+)\/utxo/)
    if (m) { utxoQueries.push(m[1]); return { ok: true, json: async () => (chain.get(m[1]) ?? []).map((x) => ({ ...x, status: { confirmed: true } })) } as any }
    if (u.endsWith('/tx') && init?.method === 'POST') {
      broadcasts.push(String(init.body))
      return { ok: true, status: 200, text: async () => bitcoin.Transaction.fromHex(String(init.body)).getId() } as any
    }
    return { ok: false, status: 404, text: async () => 'not found', json: async () => ({}) } as any
  }) as any
}
const funded = new Set<string>() // only real funding transactions are known to the "network"
const fund = (address: string) => { const txid = randomBytes(32).toString('hex'); funded.add(txid); chain.set(address, [{ txid, vout: 0, value: FUNDING }]) }

// ─── independent P2WSH 2-of-3 validation ──────────────────────────────────────────────────────────────
function validateSpend(rawHex: string, fundedAddress: string, value = FUNDING): { valid: boolean; why: string } {
  const tx = bitcoin.Transaction.fromHex(rawHex)
  const w = tx.ins[0].witness
  if (w.length !== 4 || w[0].length !== 0) return { valid: false, why: 'witness shape' }
  const witnessScript = Buffer.from(w[3])
  const program = Buffer.from(bitcoin.address.toOutputScript(fundedAddress, NET)).subarray(2)
  if (!createHash('sha256').update(witnessScript).digest().equals(program)) return { valid: false, why: 'program mismatch' }
  const pubkeys = bitcoin.script.decompile(witnessScript)!.slice(1, 4).map((c) => Buffer.from(c as Uint8Array))
  let k = 0
  for (const sigBuf of [w[1], w[2]]) {
    const { signature, hashType } = bitcoin.script.signature.decode(Buffer.from(sigBuf))
    const hash = tx.hashForWitnessV0(0, witnessScript, BigInt(value), hashType)
    while (k < pubkeys.length && !ecc.verify(hash, pubkeys[k], signature)) k++
    if (k === pubkeys.length) return { valid: false, why: 'signature does not verify' }
    k++
  }
  return { valid: true, why: '2 valid ordered signatures' }
}
const p2wshOf = (pubs: Buffer[]) => bitcoin.payments.p2wsh({ redeem: bitcoin.payments.p2ms({ m: 2, pubkeys: [...pubs].sort(Buffer.compare), network: NET }), network: NET })

describe('#235 R7G-B2A — MULTISIG script authority (real PostgreSQL, real cryptography)', () => {
  jest.setTimeout(180_000)

  const pg = createPostgresIntegrationHarness()
  let prisma: PrismaClient
  let escrowService: any, getProvider: any, multisigProvider: any
  let ARBITER: string
  const extra: Array<{ prisma: any; redis?: any }> = []
  let realFetch: typeof fetch

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'false'
    process.env.MULTISIG_SEED = 'r7gb2a-seed'
    process.env.TRUSTED_ARBITRATORS = 'r7gb2a-arbiter'
    process.env.MULTISIG_NETWORK = 'testnet'
    process.env.MULTISIG_FUNDING_REQUIRED_CONFIRMATIONS = '1'
    await pg.probe()
    if (!pg.isAvailable()) return
    ;({ prisma } = require('../../src/common/database'))
    require('../../src/common/events/handlers').registerEventHandlers()
    ;({ escrowService } = require('../../src/modules/open-settlement/escrow.service'))
    ;({ getSettlementProvider: getProvider } = require('../../src/modules/open-settlement/escrow-providers'))
    ;({ multisigProvider } = require('../../src/modules/open-settlement/multisig.provider'))
    ARBITER = multisigProvider.getArbiterPubkeyHex('r7gb2a-arbiter')
    realFetch = global.fetch
    explorer()
  })

  afterAll(async () => {
    if (!pg.isAvailable()) return
    global.fetch = realFetch
    try {
      const users = (await prisma.user.findMany({ where: { displayName: { startsWith: 'r7gb2a-' } }, select: { id: true } })).map((u) => u.id)
      const tradeIds = (await prisma.trade.findMany({ where: { OR: [{ buyerId: { in: users } }, { sellerId: { in: users } }] }, select: { id: true } })).map((t) => t.id)
      const escrowIds = (await prisma.escrow.findMany({ where: { tradeId: { in: tradeIds } }, select: { id: true } })).map((e) => e.id)
      const pendingIds = (await prisma.escrowPendingTransaction.findMany({ where: { escrowId: { in: escrowIds } }, select: { id: true } })).map((p) => p.id)
      await prisma.$transaction(async (tx) => {
        // Test-owned rows only; both key guards are re-enabled inside the same transaction.
        await tx.$executeRawUnsafe('ALTER TABLE escrow_participant_keys DISABLE TRIGGER escrow_participant_keys_arbiter_immutability_guard')
        await tx.$executeRawUnsafe('ALTER TABLE escrow_participant_keys DISABLE TRIGGER escrow_participant_keys_script_authority_guard')
        await tx.$executeRaw`DELETE FROM escrow_participant_keys WHERE "escrowId" = ANY(${escrowIds})`
        await tx.$executeRawUnsafe('ALTER TABLE escrow_participant_keys ENABLE TRIGGER escrow_participant_keys_script_authority_guard')
        await tx.$executeRawUnsafe('ALTER TABLE escrow_participant_keys ENABLE TRIGGER escrow_participant_keys_arbiter_immutability_guard')
      })
      const refs = await prisma.$queryRaw<Array<{ table_name: string; column_name: string }>>`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name IN ('tradeId', 'escrowId', 'interactionId', 'pendingTxId')
          AND table_name NOT IN ('trades', 'escrows', 'escrow_participant_keys')`
      for (let pass = 0; pass < 5; pass++) {
        for (const { table_name, column_name } of refs) {
          const ids = column_name === 'tradeId' ? tradeIds : column_name === 'pendingTxId' ? pendingIds : escrowIds
          await prisma.$executeRawUnsafe(`DELETE FROM "${table_name}" WHERE "${column_name}" = ANY($1)`, ids).catch(() => undefined)
        }
      }
      await prisma.$executeRaw`DELETE FROM event_projection_claims WHERE "subjectId" = ANY(${tradeIds}) OR "subjectId" = ANY(${escrowIds})`
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
    let n!: { escrowService: any; prisma: any; redis?: any }
    jest.isolateModules(() => {
      n = { escrowService: require('../../src/modules/open-settlement/escrow.service').escrowService, prisma: require('../../src/common/database').prisma, redis: require('../../src/common/redis').redis }
    })
    extra.push(n)
    return n
  }

  async function trade(label: string) {
    const mk = async (r: string) => prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex'), displayName: `r7gb2a-${label}-${r}-${randomBytes(3).toString('hex')}` } })
    const seller = await mk('s'), buyer = await mk('b')
    for (const p of [buyer, seller]) await prisma.payoutAddress.create({ data: { participantId: p.id, asset: 'BTC', address: payout(p.id) } })
    const acct = await sellerPixAccount(prisma, seller.id)
    const offer = await prisma.offer.create({ data: { userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '1', minAmount: '0.00000001', maxAmount: '100', ...boundOfferRow(acct) } })
    const t = await prisma.trade.create({ data: { ...boundTradeRow(acct), offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, asset: 'BTC', amount: '0.001', priceUsd: '1', totalUsd: '0.001', status: 'ACTIVE' } })
    const e = await escrowService.createEscrow({ tradeId: t.id, asset: 'BTC', lockedAmount: '0.001', type: 'MULTISIG' }, seller.id)
    return { t, e, buyer, seller, keys: { buyer: keyOf(`${label}-buyer`), seller: keyOf(`${label}-seller`), other: keyOf(`${label}-other`) } }
  }
  type Fx = Awaited<ReturnType<typeof trade>>
  const submit = (svc: any, f: Fx, role: 'buyer' | 'seller', pub: string) => svc.submitParticipantKey(f.e.id, f[role].id, pub, PROFILE)
  async function addressed(label: string) {
    const f = await trade(label)
    await submit(escrowService, f, 'buyer', hex(f.keys.buyer))
    await submit(escrowService, f, 'seller', hex(f.keys.seller))
    const addr = (await prisma.escrow.findUniqueOrThrow({ where: { id: f.e.id } })).multisigAddr!
    return { ...f, addr }
  }
  async function locked(label: string) {
    const f = await addressed(label)
    fund(f.addr)
    await escrowService.lockFunds(f.e.id, f.seller.id)
    return f
  }
  const escrowRow = (id: string) => prisma.escrow.findUniqueOrThrow({ where: { id } })
  const rowsDerive = async (escrowId: string) => {
    const ks = await prisma.escrowParticipantKey.findMany({ where: { escrowId } })
    const pick = (r: string) => Buffer.from(ks.find((k) => k.role === r)!.pubkey, 'hex')
    return p2wshOf([pick('buyer'), pick('seller'), pick('arbiter')]).address
  }
  const outcome = async (p: Promise<unknown>) => { try { await p; return 'OK' } catch (e: any) { return String(e?.message ?? e) } }
  const pendingOf = (escrowId: string) => prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId } })
  const sigRows = (pendingTxId: string) => prisma.escrowTransactionSignature.count({ where: { pendingTxId } })
  const terminalEvents = (tradeId: string) => prisma.durableEventRecord.count({ where: { correlationId: tradeId, eventName: { in: ['settlement.escrow.refunded', 'settlement.escrow.released', 'settlement.escrow.split'] } } })
  const signCopy = (b64: string, k: any) => { const p = bitcoin.Psbt.fromBase64(b64, { network: NET }); p.signInput(0, k); return p.toBase64() }
  /** A copy of the stored round carrying `pubkey` with an arbitrary `signature` (already DER + sighash-encoded). */
  const withSig = (b64: string, pubkey: Buffer, signature: Buffer) => {
    const p = bitcoin.Psbt.fromBase64(b64, { network: NET })
    p.updateInput(0, { partialSig: [{ pubkey, signature }] })
    return p.toBase64()
  }
  /** The BIP143 sighash of the stored round's input 0 with the round's own script/amount, optionally overridden. */
  const roundSighash = (b64: string, opts: { value?: bigint; hashType?: number } = {}) => {
    const p = bitcoin.Psbt.fromBase64(b64, { network: NET })
    const tx = bitcoin.Transaction.fromBuffer(Buffer.from(p.data.globalMap.unsignedTx.toBuffer()))
    const i = p.data.inputs[0]
    return tx.hashForWitnessV0(0, Buffer.from(i.witnessScript!), opts.value ?? i.witnessUtxo!.value, opts.hashType ?? bitcoin.Transaction.SIGHASH_ALL)
  }
  const der = (k: any, hash: Uint8Array, hashType = bitcoin.Transaction.SIGHASH_ALL) => Buffer.from(bitcoin.script.signature.encode(Buffer.from(k.sign(hash)), hashType))

  /** Every refused signature: not persisted, not counted, nothing finalized/broadcast, no terminal status or event. */
  async function expectSignatureRefused(f: Fx, participant: 'buyer' | 'seller', b64: string, message: RegExp) {
    const pending = await pendingOf(f.e.id)
    const before = { sigs: await sigRows(pending.id), broadcasts: broadcasts.length, status: (await escrowRow(f.e.id)).status, events: await terminalEvents(f.t.id) }
    await expect(escrowService.submitTransactionSignature(f.e.id, f[participant].id, b64)).rejects.toThrow(message)
    expect(await sigRows(pending.id)).toBe(before.sigs) // S11/S12
    expect((await pendingOf(f.e.id)).bilateralAuthorityAt).toBeNull()
    expect(broadcasts.length).toBe(before.broadcasts) // S13/S14
    expect((await escrowRow(f.e.id)).status).toBe(before.status) // S15
    expect(await terminalEvents(f.t.id)).toBe(before.events)
  }

  // ─── migration preflight (P1-P8) ──────────────────────────────────────────────────────────────────────

  it('PREFLIGHT: the migration refuses P1-P8 legacy state, the read-only tool classifies the same rows identically, and nothing is changed', async () => {
    pg.requirePostgres('PREFLIGHT')
    const sql = readFileSync(join(__dirname, '../../prisma/migrations/20261006120000_multisig_script_authority/migration.sql'), 'utf8')
    // The migration's own preflight statements, executed verbatim (one statement per call).
    const at = (marker: string) => sql.indexOf(marker)
    const preflight = [
      sql.slice(at('CREATE FUNCTION pg_temp.sails_bech32_program'), at('-- sha256 of the 2-of-3')),
      sql.slice(at('CREATE FUNCTION pg_temp.sails_p2wsh_2of3_program'), at('DO $$')),
      sql.slice(at('DO $$'), at('DROP FUNCTION pg_temp.sails_p2wsh_2of3_program')),
    ]
    const f = await trade('pf')
    const k = (l: string) => hex(keyOf(`pf-${l}`))
    const good = p2wshOf([k('b'), k('s'), ARBITER].map((h) => Buffer.from(h, 'hex'))).address!
    const cases: Array<[string, { buyer: string | null; seller: string | null; arbiter: string | null; addr: string }]> = [
      ['P1', { buyer: null, seller: k('s'), arbiter: ARBITER, addr: good }],
      ['P2', { buyer: k('b'), seller: null, arbiter: ARBITER, addr: good }],
      ['P3', { buyer: k('b'), seller: k('s'), arbiter: null, addr: good }],
      ['P4', { buyer: 'zz' + k('b').slice(2), seller: k('s'), arbiter: ARBITER, addr: good }],
      ['P5', { buyer: k('b'), seller: k('b').toUpperCase(), arbiter: ARBITER, addr: good }],
      ['P6', { buyer: ARBITER, seller: k('s'), arbiter: ARBITER, addr: good }],
      ['P7', { buyer: k('b'), seller: ARBITER, arbiter: ARBITER, addr: good }],
      ['P8', { buyer: k('b'), seller: k('s'), arbiter: ARBITER, addr: p2wshOf([k('x'), k('s'), ARBITER].map((h) => Buffer.from(h, 'hex'))).address! }],
      ['sound', { buyer: k('b'), seller: k('s'), arbiter: ARBITER, addr: good }],
    ]
    let refusal = ''
    await prisma.$transaction(async (tx) => {
      for (const [label, c] of cases) {
        const e = await tx.escrow.create({ data: { tradeId: (await tx.trade.create({ data: { sellerPaymentAccountId: f.t.sellerPaymentAccountId, offerId: f.t.offerId, buyerId: f.buyer.id, sellerId: f.seller.id, asset: 'BTC', amount: '0.001', priceUsd: '1', totalUsd: '0.001' } })).id, type: 'MULTISIG', asset: 'BTC', lockedAmount: '0.001', status: 'CREATED', multisigAddr: c.addr } })
        for (const [role, pub] of [['buyer', c.buyer], ['seller', c.seller], ['arbiter', c.arbiter]] as const) {
          if (pub) await tx.escrowParticipantKey.create({ data: { escrowId: e.id, role, participantId: role, pubkey: pub } })
        }
        expect([label, classifyMultisigRow({ id: e.id, status: 'CREATED', multisigAddr: c.addr, ...c })]).toEqual([label, label === 'sound' ? null : label])
      }
      await tx.$executeRawUnsafe(preflight[0])
      await tx.$executeRawUnsafe(preflight[1])
      refusal = await tx.$executeRawUnsafe(preflight[2]).then(() => 'installed', (err: Error) => err.message)
      throw new Error('rollback the fixtures')
    }).catch((err: Error) => { if (err.message !== 'rollback the fixtures') throw err })
    for (const p of ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8']) expect(refusal).toContain(p)
    expect(refusal).toContain('Nothing was changed')
    // And on the current database (committed state) the tool finds nothing to block.
    const { runPreflight } = require('../../scripts/multisig-script-authority-preflight')
    const report = await runPreflight(process.env.DATABASE_URL!)
    expect(report.violating).toBe(0)
  })

  // ─── DB defense in depth (R) ──────────────────────────────────────────────────────────────────────────

  it('R: after the address — direct SQL UPDATE/DELETE of a participant key and multisigAddr A->B / A->NULL are refused; A->A and pre-address corrections are allowed; same on another node', async () => {
    pg.requirePostgres('R')
    const pre = await trade('r-pre')
    await submit(escrowService, pre, 'buyer', hex(pre.keys.buyer))
    expect(await outcome(prisma.$executeRaw`UPDATE escrow_participant_keys SET pubkey = ${hex(pre.keys.other)} WHERE "escrowId" = ${pre.e.id} AND role = 'buyer'`)).toBe('OK')

    const f = await addressed('r')
    const B = node()
    for (const db of [prisma, B.prisma]) {
      expect(await outcome(db.$executeRaw`UPDATE escrow_participant_keys SET pubkey = ${hex(f.keys.other)} WHERE "escrowId" = ${f.e.id} AND role = 'buyer'`)).toMatch(/derived its funding address and is immutable/)
      expect(await outcome(db.$executeRaw`UPDATE escrow_participant_keys SET "capabilityProfile" = NULL WHERE "escrowId" = ${f.e.id} AND role = 'seller'`)).toMatch(/is immutable/)
      expect(await outcome(db.$executeRaw`DELETE FROM escrow_participant_keys WHERE "escrowId" = ${f.e.id} AND role = 'seller'`)).toMatch(/may not be deleted/)
      expect(await outcome(db.$executeRaw`UPDATE escrows SET "multisigAddr" = ${payout('elsewhere')} WHERE id = ${f.e.id}`)).toMatch(/multisigAddr is write-once/)
      expect(await outcome(db.$executeRaw`UPDATE escrows SET "multisigAddr" = NULL WHERE id = ${f.e.id}`)).toMatch(/multisigAddr is write-once/)
      expect(await outcome(db.$executeRaw`UPDATE escrows SET "multisigAddr" = ${f.addr} WHERE id = ${f.e.id}`)).toBe('OK') // A -> A
      expect(await outcome(db.escrowParticipantKey.update({ where: { escrowId_role: { escrowId: f.e.id, role: 'buyer' } }, data: { pubkey: hex(f.keys.other) } }))).toMatch(/is immutable/) // repository/ORM bypass
    }
    expect((await escrowRow(f.e.id)).multisigAddr).toBe(f.addr)
    expect(await rowsDerive(f.e.id)).toBe(f.addr)
  })

  // ─── service idempotency + N7-N9 ──────────────────────────────────────────────────────────────────────

  it('E/N7/N8/N9: before the address a key can be corrected and the address derives from the winning key; after it the same key is a no-op and a different key is refused', async () => {
    pg.requirePostgres('E')
    const f = await trade('e')
    await submit(escrowService, f, 'buyer', hex(f.keys.other))
    await submit(escrowService, f, 'buyer', hex(f.keys.buyer)) // N7/N9: correction before the address
    await submit(escrowService, f, 'seller', hex(f.keys.seller))
    const row = await escrowRow(f.e.id)
    expect(row.multisigAddr).toBe(p2wshOf([f.keys.buyer.publicKey, f.keys.seller.publicKey, Buffer.from(ARBITER, 'hex')].map((x) => Buffer.from(x))).address)
    await expect(submit(escrowService, f, 'buyer', hex(f.keys.buyer))).resolves.toBeTruthy() // idempotent
    await expect(submit(node().escrowService, f, 'buyer', hex(f.keys.buyer).toUpperCase())).resolves.toBeTruthy() // same key bytes, other node
    for (const role of ['buyer', 'seller'] as const) {
      await expect(submit(escrowService, f, role, hex(f.keys.other))).rejects.toThrow(/key can no longer change/) // N8
    }
    await expect(escrowService.submitParticipantKey(f.e.id, f.buyer.id, hex(f.keys.buyer), undefined)).rejects.toThrow(/key can no longer change/) // profile is frozen too
    expect(await rowsDerive(f.e.id)).toBe(row.multisigAddr)
  })

  // ─── distinctness D1-D8 + real duplicate-key proof (G) ────────────────────────────────────────────────

  it('G: without distinctness one key fills two CHECKMULTISIG positions — a single holder spends alone (independent validator)', async () => {
    pg.requirePostgres('G')
    const s = keyOf('g-seller')
    for (const [label, dup] of [['buyer = seller', Buffer.from(s.publicKey)], ['participant = arbiter', null]] as const) {
      const arbiterKey = keyOf('g-arbiter')
      const twice = dup ?? Buffer.from(arbiterKey.publicKey)
      const signer = dup ? s : arbiterKey
      const w = p2wshOf([twice, twice, dup ? Buffer.from(arbiterKey.publicKey) : Buffer.from(s.publicKey)])
      const tx = new bitcoin.Transaction(); tx.version = 2
      tx.addInput(Buffer.from(randomBytes(32)), 0); tx.addOutput(Buffer.from(bitcoin.address.toOutputScript(payout('g'), NET)), 99_000n)
      const script = Buffer.from(w.redeem!.output!)
      const sig = der(signer, tx.hashForWitnessV0(0, script, BigInt(FUNDING), bitcoin.Transaction.SIGHASH_ALL))
      tx.setWitness(0, [Buffer.alloc(0), sig, sig, script])
      expect([label, validateSpend(tx.toHex(), w.address!)]).toEqual([label, { valid: true, why: '2 valid ordered signatures' }])
    }
  })

  it.each([
    ['D2 buyer = seller', (f: Fx) => [hex(f.keys.seller), hex(f.keys.seller)]],
    ['D3 buyer = arbiter', (f: Fx) => [ARBITER, hex(f.keys.seller)]],
    ['D4 seller = arbiter', (f: Fx) => [hex(f.keys.buyer), ARBITER]],
    ['D5 same key in different hex case', (f: Fx) => [hex(f.keys.seller).toUpperCase(), hex(f.keys.seller)]],
  ])('%s — refused before the address is persisted (D6), with no lock possible (D7), on any node (D8)', async (label, pair) => {
    pg.requirePostgres(String(label))
    const f = await trade(`d-${String(label).slice(0, 2)}`)
    const [b, s] = (pair as (f: Fx) => string[])(f)
    await submit(escrowService, f, 'buyer', b)
    await expect(submit(node().escrowService, f, 'seller', s)).rejects.toThrow(/are the same key/)
    const row = await escrowRow(f.e.id)
    expect(row.multisigAddr).toBeNull()
    expect(await prisma.escrowParticipantKey.count({ where: { escrowId: f.e.id, role: 'arbiter' } })).toBe(0)
    const queries = utxoQueries.length
    await expect(escrowService.lockFunds(f.e.id, f.seller.id)).rejects.toThrow()
    expect(utxoQueries.length).toBe(queries)
    expect((await escrowRow(f.e.id)).status).toBe('CREATED')
  })

  it('D1: three distinct keys derive the address', async () => {
    pg.requirePostgres('D1')
    const f = await addressed('d1')
    expect(await rowsDerive(f.e.id)).toBe(f.addr)
  })

  // ─── derived == persisted (H), lockFunds A2 (I), recovery (P) ─────────────────────────────────────────

  it('H/I/P/RFD5: an escrow whose keys do not derive its persisted address fails closed everywhere — lock, rescan, refund, release, split, reconciliation — on any node, with no address rewrite and no side effect', async () => {
    pg.requirePostgres('H')
    const f = await locked('h')
    // A legacy mismatch, created the only way it still can be: rows inserted pre-trigger (simulated by disabling
    // the guard for this one write, then re-enabling it in the same transaction).
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE escrow_participant_keys DISABLE TRIGGER escrow_participant_keys_script_authority_guard')
      await tx.$executeRaw`UPDATE escrow_participant_keys SET pubkey = ${hex(f.keys.other)} WHERE "escrowId" = ${f.e.id} AND role = 'buyer'`
      await tx.$executeRawUnsafe('ALTER TABLE escrow_participant_keys ENABLE TRIGGER escrow_participant_keys_script_authority_guard')
    })
    expect(await rowsDerive(f.e.id)).not.toBe(f.addr)
    const mismatch = /no longer derive its persisted funding address/
    const queries = utxoQueries.length
    const B = node()
    for (const svc of [escrowService, B.escrowService]) {
      await expect(svc.initiateRefund(f.e.id, f.seller.id)).rejects.toThrow(mismatch)
    }
    expect(await prisma.escrowPendingTransaction.count({ where: { escrowId: f.e.id } })).toBe(0)
    const row = await escrowRow(f.e.id)
    const { loadParticipantPubkeys } = require('../../src/modules/open-settlement/escrow-lifecycle')
    const input = { ...row, lockedAmount: row.lockedAmount.toString(), buyerId: f.buyer.id, sellerId: f.seller.id, ...(await loadParticipantPubkeys(f.e.id)) }
    await expect(multisigProvider.rescanFunding(input)).rejects.toThrow(mismatch)
    await expect(multisigProvider.lockFunds(input)).rejects.toThrow(mismatch)
    await expect(multisigProvider.buildUnsignedRelease(input, payout('x'))).rejects.toThrow(mismatch)
    await expect(multisigProvider.buildUnsignedSplit({ ...input, status: 'DISPUTED', triggeredBy: 'r7gb2a-arbiter' }, payout('x'), payout('y'), 5000)).rejects.toThrow(mismatch)
    const recon = await multisigProvider.reconcilePendingSettlement({ ...input, txLockId: row.txLockId }, (await (async () => {
      const p = new bitcoin.Psbt({ network: NET }); const a = p2wshOf([f.keys.buyer.publicKey, f.keys.seller.publicKey, Buffer.from(ARBITER, 'hex')].map((x) => Buffer.from(x)))
      p.addInput({ hash: row.txLockId!, index: 0, witnessUtxo: { script: a.output!, value: BigInt(FUNDING) }, witnessScript: a.redeem!.output! }); p.addOutput({ address: payout('x'), value: 99_000n })
      p.signInput(0, f.keys.buyer); p.signInput(0, f.keys.seller); return p.toBase64()
    })()), [])
    expect(recon.outcome).toBe('ANOMALY')
    expect(utxoQueries.length).toBe(queries) // never asked the explorer about any other address
    expect((await escrowRow(f.e.id)).multisigAddr).toBe(f.addr) // never re-pointed
  })

  it('I: a normal lock keeps the persisted address (A -> A), and lockFunds never queries another address', async () => {
    pg.requirePostgres('I')
    const f = await addressed('i')
    fund(f.addr)
    const before = utxoQueries.length
    await escrowService.lockFunds(f.e.id, f.seller.id)
    expect(new Set(utxoQueries.slice(before))).toEqual(new Set([f.addr]))
    expect((await escrowRow(f.e.id)).multisigAddr).toBe(f.addr)
    expect((await escrowRow(f.e.id)).status).toBe('FUNDS_LOCKED')
  })

  // ─── refund RFD1-RFD7, release N, signature matrix S1-S15, A14 (K), PSBT authority (L) ────────────────

  it('RFD1/RFD4/RFD7/S1/S2: the frozen keyset refunds — both valid signatures accepted, finalized, broadcast and VALID against the funded script', async () => {
    pg.requirePostgres('RFD1')
    const f = await locked('rfd1')
    await escrowService.initiateRefund(f.e.id, f.seller.id)
    const pending = await pendingOf(f.e.id)
    await escrowService.submitTransactionSignature(f.e.id, f.buyer.id, signCopy(pending.unsignedPsbtBase64, f.keys.buyer)) // S1
    const before = broadcasts.length
    await escrowService.submitTransactionSignature(f.e.id, f.seller.id, signCopy(pending.unsignedPsbtBase64, f.keys.seller)) // S2
    expect((await escrowRow(f.e.id)).status).toBe('REFUNDED')
    expect(validateSpend(broadcasts[before], f.addr)).toEqual({ valid: true, why: '2 valid ordered signatures' })
  })

  it('RFD2/RFD3/RFD6: replacement after the address is refused; a fresh node reconstructs A and refunds it', async () => {
    pg.requirePostgres('RFD2')
    const f = await locked('rfd2')
    await expect(submit(escrowService, f, 'buyer', hex(f.keys.other))).rejects.toThrow(/key can no longer change/)
    const B = node()
    await B.escrowService.initiateRefund(f.e.id, f.seller.id)
    const pending = await pendingOf(f.e.id)
    expect(bitcoin.Psbt.fromBase64(pending.unsignedPsbtBase64, { network: NET }).data.inputs[0].witnessUtxo!.script).toEqual(new Uint8Array(bitcoin.address.toOutputScript(f.addr, NET)))
  })

  it('N: release — valid buyer + seller signatures complete it with a VALID spend; a forged one never does', async () => {
    pg.requirePostgres('N')
    const f = await locked('rel')
    await escrowService.markPaymentSent(f.e.id, f.buyer.id)
    await escrowService.initiateRelease(f.e.id, undefined, f.seller.id)
    const pending = await pendingOf(f.e.id)
    const other = bitcoin.Psbt.fromBase64(pending.unsignedPsbtBase64, { network: NET })
    await expectSignatureRefused(f, 'seller', withSig(pending.unsignedPsbtBase64, Buffer.from(f.keys.seller.publicKey), der(f.keys.seller, roundSighash(pending.unsignedPsbtBase64, { value: 1n }))), /not a valid signature/)
    void other
    await escrowService.submitTransactionSignature(f.e.id, f.buyer.id, signCopy(pending.unsignedPsbtBase64, f.keys.buyer))
    const before = broadcasts.length
    await escrowService.submitTransactionSignature(f.e.id, f.seller.id, signCopy(pending.unsignedPsbtBase64, f.keys.seller))
    expect((await escrowRow(f.e.id)).status).toBe('COMPLETED')
    expect(validateSpend(broadcasts[before], f.addr).valid).toBe(true)
  })

  it('S4/K (A14): a well-formed signature by the expected key over a DIFFERENT message is refused by Sails itself — nothing persisted, counted, finalized, broadcast or claimed', async () => {
    pg.requirePostgres('S4')
    const f = await locked('s4')
    await escrowService.initiateRefund(f.e.id, f.seller.id)
    const pending = await pendingOf(f.e.id)
    const forged = new bitcoin.Psbt({ network: NET })
    const round = bitcoin.Psbt.fromBase64(pending.unsignedPsbtBase64, { network: NET })
    forged.addInput({ hash: Buffer.from(round.txInputs[0].hash).reverse().toString('hex'), index: round.txInputs[0].index, witnessUtxo: round.data.inputs[0].witnessUtxo!, witnessScript: round.data.inputs[0].witnessScript! })
    forged.addOutput({ address: payout('attacker'), value: 50_000n })
    forged.signInput(0, f.keys.buyer)
    await expectSignatureRefused(f, 'buyer', withSig(pending.unsignedPsbtBase64, Buffer.from(f.keys.buyer.publicKey), Buffer.from(forged.data.inputs[0].partialSig![0].signature)), /not a valid signature/)
    // The seller's valid signature alone cannot complete it either.
    await escrowService.submitTransactionSignature(f.e.id, f.seller.id, signCopy(pending.unsignedPsbtBase64, f.keys.seller))
    expect((await escrowRow(f.e.id)).status).toBe('FUNDS_LOCKED')
  })

  it.each([
    ['S5 valid signature by the wrong private key, labelled as the buyer', (f: Fx, b64: string) => withSig(b64, Buffer.from(f.keys.buyer.publicKey), der(f.keys.other, roundSighash(b64))), /not a valid signature/],
    ['S5b a signature for a key outside the script', (f: Fx, b64: string) => withSig(b64, Buffer.from(f.keys.other.publicKey), der(f.keys.other, roundSighash(b64))), /key other than yours/],
    ['S5c the counterparty signature, submitted as your own', (f: Fx, b64: string) => signCopy(b64, f.keys.seller), /key other than yours/],
    ['S8 SIGHASH_NONE (valid for that hash type)', (f: Fx, b64: string) => withSig(b64, Buffer.from(f.keys.buyer.publicKey), der(f.keys.buyer, roundSighash(b64, { hashType: bitcoin.Transaction.SIGHASH_NONE }), bitcoin.Transaction.SIGHASH_NONE)), /not SIGHASH_ALL/],
    ['S8b signed over a different amount', (f: Fx, b64: string) => withSig(b64, Buffer.from(f.keys.buyer.publicKey), der(f.keys.buyer, roundSighash(b64, { value: 1n }))), /not a valid signature/],
    ['S9 malformed DER', (f: Fx, b64: string) => withSig(b64, Buffer.from(f.keys.buyer.publicKey), Buffer.from('3006020101020101ff', 'hex')), /not a valid signature|Invalid|valid PSBT/],
    ['S9b no signature for your key at all', (_f: Fx, b64: string) => b64, /no signature for your key/],
  ])('%s — refused with no durable effect', async (label, make, message) => {
    pg.requirePostgres(String(label))
    const f = await locked(`s-${String(label).slice(0, 3)}`)
    await escrowService.initiateRefund(f.e.id, f.seller.id)
    const pending = await pendingOf(f.e.id)
    let b64: string
    try { b64 = (make as any)(f, pending.unsignedPsbtBase64) } catch (err: any) { expect(String(label)).toMatch(/S9/); return void expect(err).toBeTruthy() }
    await expectSignatureRefused(f, 'buyer', b64, message as RegExp)
  })

  it('S6/S10/L: a signature valid for another escrow\'s round, or for a rebuilt different context, is refused; the exact stored round\'s signature passes', async () => {
    pg.requirePostgres('S6')
    const f = await locked('s6')
    const g = await locked('s6g')
    await escrowService.initiateRefund(f.e.id, f.seller.id)
    await escrowService.initiateRefund(g.e.id, g.seller.id)
    const pf = await pendingOf(f.e.id), pgx = await pendingOf(g.e.id)
    // S6: a whole valid copy of another round.
    await expectSignatureRefused(f, 'buyer', signCopy(pgx.unsignedPsbtBase64, g.keys.buyer), /not a copy of this escrow's pending transaction/)
    // S10/L: the buyer's valid signature over another context, spliced into this round.
    const ctx = bitcoin.Psbt.fromBase64(pf.unsignedPsbtBase64, { network: NET })
    const rebuilt = new bitcoin.Psbt({ network: NET })
    rebuilt.addInput({ hash: Buffer.from(ctx.txInputs[0].hash).reverse().toString('hex'), index: ctx.txInputs[0].index, witnessUtxo: ctx.data.inputs[0].witnessUtxo!, witnessScript: ctx.data.inputs[0].witnessScript! })
    rebuilt.addOutput({ address: payout('rebuilt'), value: 99_500n })
    rebuilt.signInput(0, f.keys.buyer)
    await expectSignatureRefused(f, 'buyer', withSig(pf.unsignedPsbtBase64, Buffer.from(f.keys.buyer.publicKey), Buffer.from(rebuilt.data.inputs[0].partialSig![0].signature)), /not a valid signature/)
    // S7: a signature computed for input index 1 of a two-input context.
    const two = bitcoin.Transaction.fromBuffer(Buffer.from(ctx.data.globalMap.unsignedTx.toBuffer()))
    two.ins.unshift({ ...two.ins[0], hash: Buffer.from(randomBytes(32)), index: 7 })
    const sig7 = der(f.keys.buyer, two.hashForWitnessV0(1, Buffer.from(ctx.data.inputs[0].witnessScript!), ctx.data.inputs[0].witnessUtxo!.value, bitcoin.Transaction.SIGHASH_ALL))
    await expectSignatureRefused(f, 'buyer', withSig(pf.unsignedPsbtBase64, Buffer.from(f.keys.buyer.publicKey), sig7), /not a valid signature/)
    // The exact stored round's signature passes (and is the one persisted).
    await escrowService.submitTransactionSignature(f.e.id, f.buyer.id, signCopy(pf.unsignedPsbtBase64, f.keys.buyer))
    expect(await sigRows(pf.id)).toBe(1)
  })

  it('S3/O: disputed release/SPLIT — the arbiter pre-signature over the frozen script validates; a buyer signature completes a VALID spend; a tampered arbiter signature blocks finalization before broadcast', async () => {
    pg.requirePostgres('S3')
    const f = await locked('s3')
    const row = await escrowRow(f.e.id)
    const { loadParticipantPubkeys } = require('../../src/modules/open-settlement/escrow-lifecycle')
    const input = { ...row, lockedAmount: row.lockedAmount.toString(), buyerId: f.buyer.id, sellerId: f.seller.id, status: 'DISPUTED', triggeredBy: 'r7gb2a-arbiter', ...(await loadParticipantPubkeys(f.e.id)) }
    for (const build of [() => multisigProvider.buildUnsignedRelease(input, payout('buyer')), () => multisigProvider.buildUnsignedSplit(input, payout('buyer'), payout('seller'), 4000)]) {
      const { psbtBase64, requiredSigners } = await build()
      expect(requiredSigners).toEqual([f.buyer.id])
      const buyerSigned = signCopy(psbtBase64, f.keys.buyer)
      expect(() => multisigProvider.validatePartialSignature(input, psbtBase64, buyerSigned, hex(f.keys.buyer))).not.toThrow() // S3: arbiter sig already in the round is accepted as-is
      const before = broadcasts.length
      const done = await multisigProvider.finalizeRelease(input, psbtBase64, [buyerSigned])
      expect(validateSpend(done.rawTxHex, f.addr).valid).toBe(true)
      expect(broadcasts.length).toBe(before + 1)
      // A tampered pre-signature (arbiter key, wrong message) is caught at finalization, before broadcast.
      const tampered = bitcoin.Psbt.fromBase64(psbtBase64, { network: NET })
      const arb = tampered.data.inputs[0].partialSig![0]
      const bad = bitcoin.Psbt.fromBase64(tampered.toBase64(), { network: NET })
      bad.data.inputs[0].partialSig = [{ pubkey: arb.pubkey, signature: der(keyOf('not-the-arbiter'), roundSighash(psbtBase64)) }]
      const n = broadcasts.length
      await expect(multisigProvider.finalizeRelease(input, bad.toBase64(), [signCopy(bad.toBase64(), f.keys.buyer)])).rejects.toThrow(/does not verify/)
      expect(broadcasts.length).toBe(n)
    }
  })

  it('C9/M18: a legacy persisted invalid signature (written before validation existed) cannot finalize — refused before broadcast, no terminal status', async () => {
    pg.requirePostgres('C9')
    const f = await locked('c9')
    await escrowService.initiateRefund(f.e.id, f.seller.id)
    const pending = await pendingOf(f.e.id)
    await prisma.escrowTransactionSignature.create({ data: { pendingTxId: pending.id, participantId: f.buyer.id, signedPsbtBase64: withSig(pending.unsignedPsbtBase64, Buffer.from(f.keys.buyer.publicKey), der(f.keys.buyer, roundSighash(pending.unsignedPsbtBase64, { value: 1n }))) } })
    const before = broadcasts.length
    await expect(escrowService.submitTransactionSignature(f.e.id, f.seller.id, signCopy(pending.unsignedPsbtBase64, f.keys.seller))).rejects.toThrow(/does not verify|failed to combine/)
    expect(broadcasts.length).toBe(before)
    expect((await escrowRow(f.e.id)).status).toBe('FUNDS_LOCKED')
    expect(await terminalEvents(f.t.id)).toBe(0)
  })

  // ─── multi-node N1-N6, N10, crash C1-C4 ───────────────────────────────────────────────────────────────

  it('N1/N2/N10: two nodes racing the second key against a buyer replacement — every outcome leaves keys that derive the persisted address', async () => {
    pg.requirePostgres('N1')
    const B = node()
    const seen = new Set<string>()
    for (let i = 0; i < 10; i++) {
      const f = await trade(`n1-${i}`)
      await submit(escrowService, f, 'buyer', hex(f.keys.buyer))
      const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
      const [second, replace] = await Promise.allSettled([
        delay(i % 2 ? (i % 5) * 8 : 0).then(() => submit(i % 2 ? escrowService : B.escrowService, f, 'seller', hex(f.keys.seller))),
        delay(i % 2 ? 0 : (i % 5) * 8).then(() => submit(i % 2 ? B.escrowService : escrowService, f, 'buyer', hex(f.keys.other))),
      ])
      expect(second.status).toBe('fulfilled')
      const row = await escrowRow(f.e.id)
      expect(await rowsDerive(f.e.id)).toBe(row.multisigAddr) // the frozen keyset always derives the address
      seen.add(replace.status)
    }
    expect(seen.size).toBe(2) // both orders happened: replacement before the address (N9) and refused after it (N8)
  })

  it('N3-N6: with the address committed, a key mutation from another node is refused while lock, refund, release and signing proceed', async () => {
    pg.requirePostgres('N3')
    const f = await addressed('n3')
    const B = node()
    fund(f.addr)
    const [lock, mut] = await Promise.allSettled([escrowService.lockFunds(f.e.id, f.seller.id), submit(B.escrowService, f, 'buyer', hex(f.keys.other))])
    expect([lock.status, mut.status]).toEqual(['fulfilled', 'rejected'])
    const [refund, mut2] = await Promise.allSettled([escrowService.initiateRefund(f.e.id, f.seller.id), submit(B.escrowService, f, 'seller', hex(f.keys.other))])
    expect([refund.status, mut2.status]).toEqual(['fulfilled', 'rejected'])
    const pending = await pendingOf(f.e.id)
    const [sig, mut3] = await Promise.allSettled([escrowService.submitTransactionSignature(f.e.id, f.buyer.id, signCopy(pending.unsignedPsbtBase64, f.keys.buyer)), submit(B.escrowService, f, 'buyer', hex(f.keys.other))])
    expect([sig.status, mut3.status]).toEqual(['fulfilled', 'rejected'])
    expect(await rowsDerive(f.e.id)).toBe(f.addr)
  })

  it('C1-C4: a crash inside the key/address transaction rolls back key and address together; after commit a restarted node sees the frozen keyset', async () => {
    pg.requirePostgres('C1')
    const f = await trade('c1')
    await submit(escrowService, f, 'buyer', hex(f.keys.buyer))
    const original = prisma.$transaction.bind(prisma)
    for (const failAt of ['escrowParticipantKey.upsert', 'escrow.update']) {
      const [model, method] = failAt.split('.')
      const spy = jest.spyOn(prisma, '$transaction').mockImplementationOnce((fn: any, ...rest: any[]) => original((tx: any) => fn(new Proxy(tx, {
        get(t, p) {
          const v = Reflect.get(t, p)
          if (p !== model) return typeof v === 'function' ? v.bind(t) : v
          return new Proxy(v, { get(d, m) { const fv = Reflect.get(d, m); return m === method ? async (...a: any[]) => { await fv.apply(d, a); throw new Error('injected crash') } : (typeof fv === 'function' ? fv.bind(d) : fv) } })
        },
      })), ...rest))
      try { await expect(submit(escrowService, f, 'seller', hex(f.keys.seller))).rejects.toThrow('injected crash') } finally { spy.mockRestore() }
      expect((await escrowRow(f.e.id)).multisigAddr).toBeNull()
      expect(await prisma.escrowParticipantKey.count({ where: { escrowId: f.e.id, role: 'seller' } })).toBe(0)
    }
    await submit(escrowService, f, 'seller', hex(f.keys.seller))
    const addr = (await escrowRow(f.e.id)).multisigAddr
    await expect(submit(node().escrowService, f, 'buyer', hex(f.keys.other))).rejects.toThrow(/key can no longer change/) // C4
    expect(await rowsDerive(f.e.id)).toBe(addr)
  })
})
