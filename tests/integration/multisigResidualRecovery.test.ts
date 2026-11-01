// tests/integration/multisigResidualRecovery.test.ts
//
// #235 R7G F8A — MULTISIG_RESIDUAL_VALUE_RECOVERY_V1 and the minimal F8 status guard, on real PostgreSQL with real
// secp256k1 keys, real PSBTs and an independent P2WSH 2-of-3 validator (BIP141 program hash, BIP143 sighash,
// ordered CHECKMULTISIG) — never Sails' own code.
//
// The explorer is a small stateful chain, address-faithful: deposits and broadcast transactions create outputs at
// the address they pay, a transaction spends exactly its inputs, mempool transactions are visible until mined, and
// /utxo, /tx/:id/status, /tx/:id/outspend/:vout and the tip height all derive from that one state. A "node" is an
// independent module graph (jest.isolateModules) with its own PrismaClient.

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
const keyOf = (label: string) => ECPair.fromPrivateKey(createHash('sha256').update(`r7gf8a-${label}`).digest(), { network: NET })
const hex = (k: { publicKey: Uint8Array }) => Buffer.from(k.publicKey).toString('hex')
const addressOf = (label: string) => bitcoin.payments.p2wpkh({ pubkey: Buffer.from(ecc.pointFromScalar(createHash('sha256').update(label).digest(), true)!), network: NET }).address!
const FUNDING = 100_000 // 0.001 BTC, the trade amount

// ─── a small address-faithful chain ─────────────────────────────────────────────────────────────────────
type ChainTx = { height: number | null; outputs: Array<{ address: string; value: number }>; spends: Array<{ txid: string; vout: number }> }
const txs = new Map<string, ChainTx>()
let tip = 200
let outage = false
let broadcastMode: 'ok' | 'accept-then-500' | 'reject' = 'ok'
const broadcasts: string[] = []
const spenderOf = (txid: string, vout: number) => [...txs.entries()].find(([, t]) => t.spends.some((s) => s.txid === txid && s.vout === vout))?.[0]
function utxosAt(address: string) {
  const out: Array<{ txid: string; vout: number; value: number; status: { confirmed: boolean } }> = []
  for (const [txid, t] of txs) t.outputs.forEach((o, vout) => { if (o.address === address && !spenderOf(txid, vout)) out.push({ txid, vout, value: o.value, status: { confirmed: t.height !== null } }) })
  return out
}
const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as any
const notFound = () => ({ ok: false, status: 404, text: async () => 'not found', json: async () => ({}) }) as any
function explorer() {
  global.fetch = jest.fn(async (url: any, init?: any) => {
    const u = String(url)
    if (outage) return { ok: false, status: 503, text: async () => 'unavailable', json: async () => ({}) } as any
    if (u.endsWith('/blocks/tip/height')) return { ok: true, status: 200, text: async () => String(tip) } as any
    if (u.includes('/fees/recommended')) return json({ halfHourFee: 2, fastestFee: 3 })
    let m = u.match(/\/tx\/([0-9a-f]{64})\/status$/)
    if (m) { const t = txs.get(m[1]); return t ? json(t.height === null ? { confirmed: false } : { confirmed: true, block_height: t.height }) : notFound() }
    m = u.match(/\/tx\/([0-9a-f]{64})\/outspend\/(\d+)$/)
    if (m) { const s = spenderOf(m[1], Number(m[2])); return json(s ? { spent: true, txid: s } : { spent: false }) }
    m = u.match(/\/address\/([^/]+)\/utxo$/)
    if (m) return json(utxosAt(m[1]))
    if (u.endsWith('/tx') && init?.method === 'POST') {
      const raw = String(init.body)
      if (broadcastMode === 'reject') return { ok: false, status: 400, text: async () => 'rejected (injected)' } as any
      const tx = bitcoin.Transaction.fromHex(raw)
      const id = tx.getId()
      if (!txs.has(id)) {
        txs.set(id, {
          height: null,
          outputs: tx.outs.map((o) => ({ address: bitcoin.address.fromOutputScript(Buffer.from(o.script), NET), value: Number(o.value) })),
          spends: tx.ins.map((i) => ({ txid: Buffer.from(i.hash).reverse().toString('hex'), vout: i.index })),
        })
        broadcasts.push(raw)
      }
      if (broadcastMode === 'accept-then-500') return { ok: false, status: 500, text: async () => 'connection reset (injected)' } as any
      return { ok: true, status: 200, text: async () => id } as any
    }
    return notFound()
  }) as any
}
/** A confirmed (or mempool) payment of `value` sats to `address` from outside. */
function deposit(address: string, value: number, confirmed = true) {
  const txid = randomBytes(32).toString('hex')
  txs.set(txid, { height: confirmed ? tip : null, outputs: [{ address, value }], spends: [] })
  return { txid, vout: 0, value }
}
function mine() { tip++; for (const t of txs.values()) if (t.height === null) t.height = tip }

// ─── independent P2WSH 2-of-3 validation ─────────────────────────────────────────────────────────────────
function validateSpend(rawHex: string, fundedAddress: string, value: number): { valid: boolean; why: string } {
  const tx = bitcoin.Transaction.fromHex(rawHex)
  const w = tx.ins[0].witness
  if (w.length !== 4 || w[0].length !== 0) return { valid: false, why: 'witness shape' }
  const witnessScript = Buffer.from(w[3])
  const program = Buffer.from(bitcoin.address.toOutputScript(fundedAddress, NET)).subarray(2)
  if (!createHash('sha256').update(witnessScript).digest().equals(program)) return { valid: false, why: 'program mismatch' }
  const pubkeys = bitcoin.script.decompile(witnessScript)!.slice(1, 4).map((c) => Buffer.from(c as Uint8Array))
  const signers: string[] = []
  let k = 0
  for (const sigBuf of [w[1], w[2]]) {
    const { signature, hashType } = bitcoin.script.signature.decode(Buffer.from(sigBuf))
    const hash = tx.hashForWitnessV0(0, witnessScript, BigInt(value), hashType)
    while (k < pubkeys.length && !ecc.verify(hash, pubkeys[k], signature)) k++
    if (k === pubkeys.length) return { valid: false, why: 'signature does not verify' }
    signers.push(pubkeys[k].toString('hex'))
    k++
  }
  return { valid: true, why: signers.join(',') }
}

describe('#235 R7G F8A — MULTISIG residual value recovery (real PostgreSQL, real cryptography)', () => {
  jest.setTimeout(180_000)
  const pg = createPostgresIntegrationHarness()
  let prisma: PrismaClient
  let escrowService: any, tradeService: any, residual: any, multisigProvider: any
  const extra: Array<{ prisma: any; redis?: any }> = []
  let realFetch: typeof fetch
  let ARBITER_USER: string

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'false'
    process.env.MULTISIG_SEED = 'r7gf8a-seed'
    process.env.TRUSTED_ARBITRATORS = 'r7gf8a-arbiter'
    process.env.MULTISIG_NETWORK = 'testnet'
    process.env.MULTISIG_FUNDING_REQUIRED_CONFIRMATIONS = '2' // explicit TEST policy depth
    await pg.probe()
    if (!pg.isAvailable()) return
    ;({ prisma } = require('../../src/common/database'))
    require('../../src/common/events/handlers').registerEventHandlers()
    ;({ escrowService } = require('../../src/modules/open-settlement/escrow.service'))
    ;({ tradeService } = require('../../src/modules/open-p2p/trade.service'))
    ;({ multisigProvider } = require('../../src/modules/open-settlement/multisig.provider'))
    residual = require('../../src/modules/open-settlement/multisig-residual-recovery')
    ARBITER_USER = 'r7gf8a-arbiter'
    realFetch = global.fetch
    explorer()
  })

  afterAll(async () => {
    if (!pg.isAvailable()) return
    global.fetch = realFetch
    try {
      const users = (await prisma.user.findMany({ where: { displayName: { startsWith: 'r7gf8a-' } }, select: { id: true } })).map((u) => u.id)
      const tradeIds = (await prisma.trade.findMany({ where: { OR: [{ buyerId: { in: users } }, { sellerId: { in: users } }] }, select: { id: true } })).map((t) => t.id)
      const escrowIds = (await prisma.escrow.findMany({ where: { tradeId: { in: tradeIds } }, select: { id: true } })).map((e) => e.id)
      const pendingIds = (await prisma.escrowPendingTransaction.findMany({ where: { escrowId: { in: escrowIds } }, select: { id: true } })).map((p) => p.id)
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('ALTER TABLE escrow_residual_recoveries DISABLE TRIGGER escrow_residual_recoveries_guard')
        await tx.$executeRaw`DELETE FROM escrow_residual_recoveries WHERE "escrowId" = ANY(${escrowIds})`
        await tx.$executeRawUnsafe('ALTER TABLE escrow_residual_recoveries ENABLE TRIGGER escrow_residual_recoveries_guard')
        await tx.$executeRawUnsafe('ALTER TABLE escrow_participant_keys DISABLE TRIGGER escrow_participant_keys_arbiter_immutability_guard')
        await tx.$executeRawUnsafe('ALTER TABLE escrow_participant_keys DISABLE TRIGGER escrow_participant_keys_script_authority_guard')
        await tx.$executeRaw`DELETE FROM escrow_participant_keys WHERE "escrowId" = ANY(${escrowIds})`
        await tx.$executeRawUnsafe('ALTER TABLE escrow_participant_keys ENABLE TRIGGER escrow_participant_keys_script_authority_guard')
        await tx.$executeRawUnsafe('ALTER TABLE escrow_participant_keys ENABLE TRIGGER escrow_participant_keys_arbiter_immutability_guard')
      })
      const refs = await prisma.$queryRaw<Array<{ table_name: string; column_name: string }>>`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name IN ('tradeId', 'escrowId', 'interactionId', 'pendingTxId')
          AND table_name NOT IN ('trades', 'escrows', 'escrow_participant_keys', 'escrow_residual_recoveries')`
      for (let pass = 0; pass < 5; pass++) {
        for (const { table_name, column_name } of refs) {
          const ids = column_name === 'tradeId' ? tradeIds : column_name === 'pendingTxId' ? pendingIds : escrowIds
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

  beforeEach(() => { outage = false; broadcastMode = 'ok' })

  // ─── fixtures ─────────────────────────────────────────────────────────────────────────────────────────

  function node() {
    let n!: { residual: any; prisma: any; redis?: any }
    jest.isolateModules(() => {
      n = { residual: require('../../src/modules/open-settlement/multisig-residual-recovery'), prisma: require('../../src/common/database').prisma, redis: require('../../src/common/redis').redis }
    })
    extra.push(n)
    return n
  }
  /** A MULTISIG escrow with both participant keys: its funding address exists. */
  async function addressed(label: string) {
    const mk = async (r: string) => prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex'), displayName: `r7gf8a-${label}-${r}-${randomBytes(3).toString('hex')}` } })
    const seller = await mk('s'), buyer = await mk('b'), stranger = await mk('x')
    for (const p of [buyer, seller]) await prisma.payoutAddress.create({ data: { participantId: p.id, asset: 'BTC', address: addressOf(`payout-${p.id}`) } })
    const acct = await sellerPixAccount(prisma, seller.id)
    const offer = await prisma.offer.create({ data: { userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '1', minAmount: '0.00000001', maxAmount: '100', ...boundOfferRow(acct) } })
    const t = await prisma.trade.create({ data: { ...boundTradeRow(acct), offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, asset: 'BTC', amount: '0.001', priceUsd: '1', totalUsd: '0.001', status: 'ACTIVE' } })
    const e = await escrowService.createEscrow({ tradeId: t.id, asset: 'BTC', lockedAmount: '0.001', type: 'MULTISIG' }, seller.id)
    const keys = { buyer: keyOf(`${label}-buyer`), seller: keyOf(`${label}-seller`) }
    await escrowService.submitParticipantKey(e.id, buyer.id, hex(keys.buyer), MULTISIG_CAPABILITY_PROFILE_V1)
    await escrowService.submitParticipantKey(e.id, seller.id, hex(keys.seller), MULTISIG_CAPABILITY_PROFILE_V1)
    const addr = (await prisma.escrow.findUniqueOrThrow({ where: { id: e.id } })).multisigAddr!
    return { t, e, buyer, seller, stranger, keys, addr }
  }
  type Fx = Awaited<ReturnType<typeof addressed>>
  async function locked(label: string) {
    const f = await addressed(label)
    const funding = deposit(f.addr, FUNDING)
    mine()
    await escrowService.lockFunds(f.e.id, f.seller.id)
    return { ...f, funding }
  }
  async function refunded(label: string) {
    const f = await locked(label)
    await escrowService.initiateRefund(f.e.id, f.seller.id)
    const pending = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: f.e.id } })
    await escrowService.submitTransactionSignature(f.e.id, f.buyer.id, signCopy(pending.unsignedPsbtBase64, f.keys.buyer))
    await escrowService.submitTransactionSignature(f.e.id, f.seller.id, signCopy(pending.unsignedPsbtBase64, f.keys.seller))
    mine()
    return f
  }
  const escrowRow = (id: string) => prisma.escrow.findUniqueOrThrow({ where: { id } })
  const recoveryRow = (id: string) => prisma.escrowResidualRecovery.findUniqueOrThrow({ where: { id } })
  const outcome = async (p: Promise<unknown>) => { try { await p; return 'OK' } catch (e: any) { return String(e?.message ?? e) } }
  const signCopy = (b64: string, k: any) => { const p = bitcoin.Psbt.fromBase64(b64, { network: NET }); p.signInput(0, k); return p.toBase64() }
  async function commercial(f: Fx) {
    const { updatedAt: _ignored, ...e } = await escrowRow(f.e.id) // the whole commercial escrow row
    return { escrow: JSON.stringify(e), events: await prisma.escrowEvent.count({ where: { escrowId: f.e.id } }), settlementEvents: await prisma.durableEventRecord.count({ where: { correlationId: f.t.id, eventName: { startsWith: 'settlement.' } } }), pending: await prisma.escrowPendingTransaction.count({ where: { escrowId: f.e.id } }) }
  }
  /** Proposes, then both participants sign; returns the recovery after the live call. */
  async function recover(f: Fx, outpoint: { txid: string; vout: number }, destination: string, proposer: 'buyer' | 'seller' = 'seller') {
    const proposed = await residual.proposeResidualRecovery(f.e.id, f[proposer].id, { ...outpoint, destination })
    await residual.submitResidualRecoverySignature(proposed.id, f.buyer.id, signCopy(proposed.unsignedPsbtBase64, f.keys.buyer))
    const done = await residual.submitResidualRecoverySignature(proposed.id, f.seller.id, signCopy(proposed.unsignedPsbtBase64, f.keys.seller))
    return { proposed, done }
  }

  // ─── F8 (ported evidence): an addressed, unfunded escrow has no destructive termination ─────────────────

  it('F8/ADDRESSED_MULTISIG_ABANDONMENT_V1: every termination is refused while unfunded — through an outage, the sweep, reconciliation and a fresh node — and a late exact deposit is still recognized', async () => {
    pg.requirePostgres('F8 A')
    const f = await addressed('f8a')
    const snapshot = async () => ({ ...(await commercial(f)), trade: (await prisma.trade.findUniqueOrThrow({ where: { id: f.t.id } })).status, evidence: await prisma.escrowFundingEvidence.count({ where: { escrowId: f.e.id } }) })
    const before = await snapshot()
    expect(await outcome(tradeService.updateStatus(f.t.id, 'CANCELLED', f.buyer.id))).toMatch(/funding address, which may already hold funds/)
    expect(await outcome(tradeService.updateStatus(f.t.id, 'CANCELLED', f.seller.id))).toMatch(/funding address, which may already hold funds/)
    expect(await outcome(escrowService.initiateRefund(f.e.id, f.seller.id))).toMatch(/no recorded funding txid/)
    // the direct refund used to claim REFUNDED (freezing cooperativeDisposition) before the provider refused it; F8B
    // refuses it before any claim (the F8 status guard would refuse that claim too), so nothing is written
    expect(await outcome(escrowService.refundFunds(f.e.id, f.seller.id))).toMatch(/settles only through signature collection/)
    expect((await escrowRow(f.e.id)).cooperativeDisposition).toBeNull()
    outage = true
    expect(await outcome(escrowService.lockFunds(f.e.id, f.seller.id))).not.toBe('OK')
    outage = false
    await escrowService.sweepExpiredEscrows()
    await require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service').reconcilePendingSettlements({ projectionGraceMs: 0 })
    expect(await snapshot()).toEqual(before)
    const funding = deposit(f.addr, FUNDING); mine()
    let fresh!: any
    jest.isolateModules(() => { fresh = { escrowService: require('../../src/modules/open-settlement/escrow.service').escrowService, prisma: require('../../src/common/database').prisma, redis: require('../../src/common/redis').redis } })
    extra.push(fresh)
    await fresh.escrowService.lockFunds(f.e.id, f.seller.id)
    expect([(await escrowRow(f.e.id)).status, (await escrowRow(f.e.id)).txLockId]).toEqual(['FUNDS_LOCKED', funding.txid])
  })

  // ─── definition ───────────────────────────────────────────────────────────────────────────────────────

  it('RV-A..L: outputs are classified against canonical authority — canonical, funding candidate, unconfirmed, residual — and only participants can see them', async () => {
    pg.requirePostgres('definition')
    const f = await addressed('def')
    const partial = deposit(f.addr, FUNDING / 2)          // C/D wrong or partial amount
    const exact = deposit(f.addr, FUNDING)                 // B a funding candidate (lockFunds may claim it)
    mine(); mine()
    const pending = deposit(f.addr, 70_000, false)         // K mempool only
    const before = (await residual.observeResidualValue(f.e.id, f.buyer.id)).outputs
    const cls = (o: { txid: string }) => before.find((x: any) => x.txid === o.txid)?.classification
    expect([cls(partial), cls(exact), cls(pending)]).toEqual(['RESIDUAL', 'CANONICAL_CANDIDATE', 'UNCONFIRMED'])
    await escrowService.lockFunds(f.e.id, f.seller.id)
    const extraDeposit = deposit(f.addr, FUNDING)          // E/F an extra or duplicate deposit beside canonical funding
    mine(); mine()
    const after = (await residual.observeResidualValue(f.e.id, f.seller.id)).outputs
    const cls2 = (o: { txid: string }) => after.find((x: any) => x.txid === o.txid)?.classification
    expect([cls2(exact), cls2(partial), cls2(extraDeposit), cls2(pending)]).toEqual(['CANONICAL', 'RESIDUAL', 'RESIDUAL', 'RESIDUAL'])
    for (const who of [f.stranger.id, ARBITER_USER]) expect(await outcome(residual.observeResidualValue(f.e.id, who))).toMatch(/not an original participant/)
  })

  // ─── consent, execution, destination ──────────────────────────────────────────────────────────────────

  it('F8A-2/3/8/11-14 + J: a partial deposit while CREATED — only the buyer AND the seller together recover it, to the destination they committed, with a VALID spend; the escrow is untouched', async () => {
    pg.requirePostgres('consent')
    const f = await addressed('consent')
    const partial = deposit(f.addr, 40_000)
    mine(); mine()
    const before = await commercial(f)
    const D = addressOf('consent-destination')
    // F8A-14: neither the arbiter identity nor a stranger proposes, signs or cancels
    for (const who of [ARBITER_USER, f.stranger.id]) expect(await outcome(residual.proposeResidualRecovery(f.e.id, who, { ...partial, destination: D }))).toMatch(/not an original participant/)
    expect(await outcome(residual.proposeResidualRecovery(f.e.id, f.seller.id, { ...partial, destination: '' }))).toMatch(/explicit destination/)
    const r = await residual.proposeResidualRecovery(f.e.id, f.seller.id, { ...partial, destination: D })
    expect([r.status, r.destination, r.valueSats, r.proposedBy]).toEqual(['PROPOSED', D, '40000', f.seller.id])
    // the committed PSBT spends exactly that outpoint, to exactly D
    const unsigned = bitcoin.Psbt.fromBase64(r.unsignedPsbtBase64, { network: NET })
    expect([unsigned.txInputs.length, Buffer.from(unsigned.txInputs[0].hash).reverse().toString('hex'), unsigned.txOutputs.map((o) => o.address)]).toEqual([1, partial.txid, [D]])
    // F8A-11/12/13: signatures over another escrow, destination, outpoint or amount are refused
    const other = await addressed('consent-other')
    const otherPartial = deposit(other.addr, 40_000); mine(); mine()
    const otherRound = await residual.proposeResidualRecovery(other.e.id, other.seller.id, { ...otherPartial, destination: D })
    const wrongDest = new bitcoin.Psbt({ network: NET }); wrongDest.addInput({ ...unsigned.txInputs[0], witnessUtxo: unsigned.data.inputs[0].witnessUtxo, witnessScript: unsigned.data.inputs[0].witnessScript }); wrongDest.addOutput({ address: addressOf('thief'), value: unsigned.txOutputs[0].value })
    for (const [label, b64] of [
      ['another escrow', signCopy(otherRound.unsignedPsbtBase64, other.keys.buyer)],
      ['another destination', signCopy(wrongDest.toBase64(), f.keys.buyer)],
      ['the server arbiter key', (() => { const p = bitcoin.Psbt.fromBase64(r.unsignedPsbtBase64, { network: NET }); p.signInput(0, ECPair.fromPrivateKey(Buffer.from(multisigProviderArbiterSecret()), { network: NET })); return p.toBase64() })()],
      ['the seller key on the buyer\'s behalf', signCopy(r.unsignedPsbtBase64, f.keys.seller)],
    ] as const) {
      expect([label, await outcome(residual.submitResidualRecoverySignature(r.id, f.buyer.id, b64))]).toEqual([label, expect.stringMatching(/not a copy of this escrow's pending transaction|not part of input|other than yours|no signature for your key|not a valid signature/)])
    }
    // one participant alone: nothing executes, nothing broadcast, the counterparty never sees a signature
    const broadcastsBefore = broadcasts.length
    const half = await residual.submitResidualRecoverySignature(r.id, f.buyer.id, signCopy(r.unsignedPsbtBase64, f.keys.buyer))
    expect([half.status, half.buyerSigned, half.sellerSigned, JSON.stringify(half).includes('SignedPsbt')]).toEqual(['PROPOSED', true, false, false])
    expect(broadcasts.length).toBe(broadcastsBefore)
    // C2: the same signature again is idempotent; a different one is refused
    expect((await residual.submitResidualRecoverySignature(r.id, f.buyer.id, signCopy(r.unsignedPsbtBase64, f.keys.buyer))).status).toBe('PROPOSED')
    // both: SIGNED -> broadcast -> SUBMITTED, a VALID buyer+seller spend of exactly that outpoint to D
    const done = await residual.submitResidualRecoverySignature(r.id, f.seller.id, signCopy(r.unsignedPsbtBase64, f.keys.seller))
    expect(done.status).toBe('SUBMITTED')
    expect(broadcasts.length).toBe(broadcastsBefore + 1)
    const raw = broadcasts[broadcasts.length - 1]
    const valid = validateSpend(raw, f.addr, 40_000)
    expect(valid.valid).toBe(true)
    expect(valid.why.split(',').sort()).toEqual([hex(f.keys.buyer), hex(f.keys.seller)].sort()) // the arbiter key never signed
    const tx = bitcoin.Transaction.fromHex(raw)
    expect([tx.getId(), tx.outs.length, bitcoin.address.fromOutputScript(Buffer.from(tx.outs[0].script), NET), Number(tx.outs[0].value)]).toEqual([done.txid, 1, D, 40_000 - Number(r.feeSats)])
    mine(); mine()
    expect((await residual.reconcileResidualRecoveries()).confirmed).toContain(r.id)
    expect((await recoveryRow(r.id)).status).toBe('CONFIRMED')
    // F8A-7/8: the commercial escrow never moved, and its canonical funding is still recognized normally later
    expect(await commercial(f)).toEqual(before)
    deposit(f.addr, FUNDING); mine(); mine()
    await escrowService.lockFunds(f.e.id, f.seller.id)
    expect((await escrowRow(f.e.id)).status).toBe('FUNDS_LOCKED')
    function multisigProviderArbiterSecret(): Uint8Array {
      // the server's own arbiter key (it is part of the script) — signing with it is never accepted as a participant
      const { BIP32Factory } = require('bip32')
      const master = BIP32Factory(ecc).fromSeed(createHash('sha256').update('r7gf8a-seed').digest(), NET)
      const { keyIndexFor } = require('../../src/modules/open-settlement/multisig.provider')
      const node = master.derivePath(`m/0'/0/${keyIndexFor('arbiter', 'r7gf8a-arbiter')}`)
      expect(Buffer.from(node.publicKey).toString('hex')).toBe(multisigProvider.getArbiterPubkeyHex('r7gf8a-arbiter'))
      return node.privateKey
    }
  })

  // ─── terminal escrows ─────────────────────────────────────────────────────────────────────────────────

  it('F8A-6/7/19 + C12: after REFUNDED, a late deposit is recovered by both participants — three concurrent proposals make one recovery; the escrow stays REFUNDED with its history intact', async () => {
    pg.requirePostgres('terminal')
    const f = await refunded('term')
    expect((await escrowRow(f.e.id)).status).toBe('REFUNDED')
    const late = deposit(f.addr, 60_000)
    mine(); mine()
    const before = await commercial(f)
    const D = addressOf('terminal-destination')
    const results = await Promise.all([
      outcome(residual.proposeResidualRecovery(f.e.id, f.seller.id, { ...late, destination: D })),
      outcome(node().residual.proposeResidualRecovery(f.e.id, f.buyer.id, { ...late, destination: D })),
      outcome(node().residual.proposeResidualRecovery(f.e.id, f.buyer.id, { ...late, destination: addressOf('other') })),
    ])
    expect(results.filter((x) => x === 'OK')).toHaveLength(1)
    expect(results.filter((x) => x !== 'OK').every((x) => /already claimed by a live residual recovery/.test(x))).toBe(true)
    const [r] = await prisma.escrowResidualRecovery.findMany({ where: { escrowId: f.e.id } })
    await residual.submitResidualRecoverySignature(r.id, f.seller.id, signCopy(r.unsignedPsbtBase64, f.keys.seller))
    await residual.submitResidualRecoverySignature(r.id, f.buyer.id, signCopy(r.unsignedPsbtBase64, f.keys.buyer))
    mine(); mine()
    await residual.reconcileResidualRecoveries()
    expect((await recoveryRow(r.id)).status).toBe('CONFIRMED')
    expect(await commercial(f)).toEqual(before)
  })

  // ─── canonical / residual exclusion ───────────────────────────────────────────────────────────────────

  it('F8A-4/C5: canonical funding is never residual and a claimed residual outpoint never becomes canonical — service and database, both directions', async () => {
    pg.requirePostgres('exclusion')
    const f = await addressed('excl')
    const exact = deposit(f.addr, FUNDING)
    mine(); mine()
    expect(await outcome(residual.proposeResidualRecovery(f.e.id, f.seller.id, { ...exact, destination: addressOf('x') }))).toMatch(/CANONICAL_CANDIDATE, not residual value/)
    await escrowService.lockFunds(f.e.id, f.seller.id)
    expect(await outcome(residual.proposeResidualRecovery(f.e.id, f.seller.id, { ...exact, destination: addressOf('x') }))).toMatch(/is CANONICAL, not residual value/)
    // the database refuses a residual claim on the canonical outpoint even when the service is bypassed
    const insert = (txid: string, vout: number) => prisma.$executeRawUnsafe(
      `INSERT INTO escrow_residual_recoveries (id, "escrowId", "fundingAddress", "outpointTxid", "outpointVout", "valueSats", destination, "feeSats", "unsignedPsbtBase64", "proposedBy", "updatedAt")
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 1000, $5, 10, 'x', $6, now())`, f.e.id, f.addr, txid, vout, addressOf('x'), f.seller.id)
    await expect(insert(exact.txid, 0)).rejects.toThrow(/is a canonical funding outpoint/)
    // the other direction: an outpoint a live recovery claims can never be written as canonical funding
    const g = await addressed('excl2')
    const stray = deposit(g.addr, 30_000); mine(); mine()
    await residual.proposeResidualRecovery(g.e.id, g.buyer.id, { ...stray, destination: addressOf('y') })
    await expect(prisma.$executeRawUnsafe(`UPDATE escrows SET "txLockId" = $1, "txLockVout" = 0 WHERE id = $2`, stray.txid, g.e.id)).rejects.toThrow(/claimed by a live residual recovery/)
    // and a recovery is bound to its own escrow's address
    await expect(prisma.$executeRawUnsafe(
      `INSERT INTO escrow_residual_recoveries (id, "escrowId", "fundingAddress", "outpointTxid", "outpointVout", "valueSats", destination, "feeSats", "unsignedPsbtBase64", "proposedBy", "updatedAt")
       VALUES (gen_random_uuid()::text, $1, $2, $3, 0, 1000, $4, 10, 'x', $5, now())`, g.e.id, f.addr, randomBytes(32).toString('hex'), addressOf('x'), g.buyer.id)).rejects.toThrow(/bound to its MULTISIG escrow's persisted funding address/)
  })

  // ─── lifecycle, exactly-once, ambiguity ───────────────────────────────────────────────────────────────

  it('C1/C3/C4/F8A-5: buyer and seller sign concurrently on two nodes — one SIGNED transaction, one broadcast; cancel frees an unsigned outpoint, never a fully signed one', async () => {
    pg.requirePostgres('concurrency')
    const f = await locked('conc')
    const a = deposit(f.addr, 25_000), b = deposit(f.addr, 35_000)
    mine(); mine()
    // cancel before both signed releases the outpoint for a new intent
    const first = await residual.proposeResidualRecovery(f.e.id, f.buyer.id, { ...a, destination: addressOf('a1') })
    await residual.submitResidualRecoverySignature(first.id, f.buyer.id, signCopy(first.unsignedPsbtBase64, f.keys.buyer))
    expect((await residual.cancelResidualRecovery(first.id, f.seller.id)).status).toBe('CANCELLED')
    const second = await residual.proposeResidualRecovery(f.e.id, f.seller.id, { ...a, destination: addressOf('a2') })
    // C1: both signatures at once, on two nodes
    const broadcastsBefore = broadcasts.length
    await Promise.all([
      outcome(node().residual.submitResidualRecoverySignature(second.id, f.buyer.id, signCopy(second.unsignedPsbtBase64, f.keys.buyer))),
      outcome(node().residual.submitResidualRecoverySignature(second.id, f.seller.id, signCopy(second.unsignedPsbtBase64, f.keys.seller))),
    ])
    let row = await recoveryRow(second.id)
    if (row.status === 'PROPOSED') { // the loser of the race retries with its same signature
      const missing = row.buyerSignedPsbtBase64 ? 'seller' : 'buyer'
      await residual.submitResidualRecoverySignature(second.id, f[missing].id, signCopy(second.unsignedPsbtBase64, f.keys[missing]))
      row = await recoveryRow(second.id)
    }
    expect(['SIGNED', 'SUBMITTED']).toContain(row.status)
    expect(broadcasts.length - broadcastsBefore).toBe(1)
    expect(await outcome(residual.cancelResidualRecovery(second.id, f.buyer.id))).toMatch(/executed, never withdrawn/)
    // C4: a second intent for the same outpoint is refused while the first lives; another outpoint is fine
    expect(await outcome(residual.proposeResidualRecovery(f.e.id, f.buyer.id, { ...a, destination: addressOf('a3') }))).toMatch(/already claimed|not an unspent output/)
    expect((await residual.proposeResidualRecovery(f.e.id, f.buyer.id, { ...b, destination: addressOf('b1') })).status).toBe('PROPOSED')
    // the escrow's canonical funding is untouched by all of it
    expect((await escrowRow(f.e.id)).status).toBe('FUNDS_LOCKED')
  })

  it('F8A-9/10 + R8-R14 + C7-C9: an ambiguous broadcast and a refused one never produce a transaction B — fresh nodes and concurrent reconcilers converge on the same txid', async () => {
    pg.requirePostgres('ambiguity')
    const f = await locked('amb')
    const a = deposit(f.addr, 45_000); mine(); mine()
    const r = await residual.proposeResidualRecovery(f.e.id, f.buyer.id, { ...a, destination: addressOf('amb-d') })
    // R10: the network accepts the transaction but the response is lost
    broadcastMode = 'accept-then-500'
    await residual.submitResidualRecoverySignature(r.id, f.buyer.id, signCopy(r.unsignedPsbtBase64, f.keys.buyer))
    const s = await residual.submitResidualRecoverySignature(r.id, f.seller.id, signCopy(r.unsignedPsbtBase64, f.keys.seller))
    expect(s.status).toBe('SIGNED')
    const txid = s.txid
    broadcastMode = 'ok'
    // R14/C8/C9: fresh nodes reconcile concurrently — the network already has it: SUBMITTED, nothing rebuilt
    await Promise.all([node().residual.reconcileResidualRecoveries(), node().residual.reconcileResidualRecoveries(), residual.driveResidualRecovery(r.id)])
    expect([(await recoveryRow(r.id)).status, (await recoveryRow(r.id)).txid]).toEqual(['SUBMITTED', txid])
    // R9: a refused broadcast leaves it SIGNED; a later pass sends the same bytes
    const b = deposit(f.addr, 55_000); mine(); mine()
    const r2 = await residual.proposeResidualRecovery(f.e.id, f.seller.id, { ...b, destination: addressOf('amb-e') })
    broadcastMode = 'reject'
    await residual.submitResidualRecoverySignature(r2.id, f.seller.id, signCopy(r2.unsignedPsbtBase64, f.keys.seller))
    const s2 = await residual.submitResidualRecoverySignature(r2.id, f.buyer.id, signCopy(r2.unsignedPsbtBase64, f.keys.buyer))
    expect([s2.status, txs.has(s2.txid)]).toEqual(['SIGNED', false])
    broadcastMode = 'ok'
    await node().residual.reconcileResidualRecoveries()
    expect([(await recoveryRow(r2.id)).status, txs.has(s2.txid)]).toEqual(['SUBMITTED', true])
    mine(); mine()
    await node().residual.reconcileResidualRecoveries()
    expect([(await recoveryRow(r.id)).status, (await recoveryRow(r2.id)).status]).toEqual(['CONFIRMED', 'CONFIRMED'])
    // every broadcast of these outpoints was the one persisted transaction
    const spendsOf = (outpoint: { txid: string }) => broadcasts.filter((raw) => bitcoin.Transaction.fromHex(raw).ins.some((i) => Buffer.from(i.hash).reverse().toString('hex') === outpoint.txid)).map((raw) => bitcoin.Transaction.fromHex(raw).getId())
    expect([...new Set(spendsOf(a))]).toEqual([txid])
    expect([...new Set(spendsOf(b))]).toEqual([s2.txid])
  })

  it('REVIEW: a residual outpoint the participants spent outside Sails is never rebuilt — the signed recovery stops for review', async () => {
    pg.requirePostgres('review')
    const f = await locked('rev')
    const a = deposit(f.addr, 45_000); mine(); mine()
    const r = await residual.proposeResidualRecovery(f.e.id, f.buyer.id, { ...a, destination: addressOf('rev-d') })
    broadcastMode = 'reject'
    await residual.submitResidualRecoverySignature(r.id, f.buyer.id, signCopy(r.unsignedPsbtBase64, f.keys.buyer))
    await residual.submitResidualRecoverySignature(r.id, f.seller.id, signCopy(r.unsignedPsbtBase64, f.keys.seller))
    broadcastMode = 'ok'
    txs.set(randomBytes(32).toString('hex'), { height: tip, outputs: [{ address: addressOf('elsewhere'), value: 44_000 }], spends: [{ txid: a.txid, vout: 0 }] })
    const report = await residual.reconcileResidualRecoveries()
    expect(report.review.map((x: any) => x.id)).toContain(r.id)
    expect((await recoveryRow(r.id)).status).toBe('SIGNED')
  })

  // ─── evidence sufficiency ─────────────────────────────────────────────────────────────────────────────

  it('J/K/F8A-18: shallow, mempool-only or reorg-uncertain value is not recoverable, and an explorer outage changes nothing', async () => {
    pg.requirePostgres('evidence')
    const f = await locked('ev')
    const shallow = deposit(f.addr, 33_000) // 1 confirmation, the test policy needs 2
    expect(await outcome(residual.proposeResidualRecovery(f.e.id, f.buyer.id, { ...shallow, destination: addressOf('ev') }))).toMatch(/UNCONFIRMED, not residual value/)
    const mem = deposit(f.addr, 34_000, false)
    expect(await outcome(residual.proposeResidualRecovery(f.e.id, f.buyer.id, { ...mem, destination: addressOf('ev') }))).toMatch(/UNCONFIRMED/)
    outage = true
    expect(await outcome(residual.proposeResidualRecovery(f.e.id, f.buyer.id, { ...shallow, destination: addressOf('ev') }))).not.toBe('OK')
    outage = false
    mine(); mine()
    const { escrowFundingEvidenceRepository } = require('../../src/modules/open-settlement/escrow-funding-evidence-repository')
    await escrowFundingEvidenceRepository.record({ escrowId: f.e.id, kind: 'REORGED_INVALIDATED', txid: f.funding.txid, vout: 0 })
    expect(await outcome(residual.proposeResidualRecovery(f.e.id, f.buyer.id, { ...shallow, destination: addressOf('ev') }))).toMatch(/canonical funding evidence is currently uncertain/)
    expect(await prisma.escrowResidualRecovery.count({ where: { escrowId: f.e.id } })).toBe(0)
  })

  // ─── database authority ───────────────────────────────────────────────────────────────────────────────

  it('F8A-15 + DB: raw SQL cannot redirect, rewrite, erase or forge recovery authority', async () => {
    pg.requirePostgres('db')
    const f = await locked('db')
    const a = deposit(f.addr, 45_000); mine(); mine()
    const r = await residual.proposeResidualRecovery(f.e.id, f.buyer.id, { ...a, destination: addressOf('db-d') })
    const sql = (q: string, ...p: unknown[]) => prisma.$executeRawUnsafe(q, ...p)
    await expect(sql(`UPDATE escrow_residual_recoveries SET destination = $1 WHERE id = $2`, addressOf('thief'), r.id)).rejects.toThrow(/immutable/)
    await expect(sql(`UPDATE escrow_residual_recoveries SET "outpointVout" = 1 WHERE id = $1`, r.id)).rejects.toThrow(/immutable/)
    await expect(sql(`UPDATE escrow_residual_recoveries SET "unsignedPsbtBase64" = 'x' WHERE id = $1`, r.id)).rejects.toThrow(/immutable/)
    await expect(sql(`UPDATE escrow_residual_recoveries SET "valueSats" = 1 WHERE id = $1`, r.id)).rejects.toThrow(/immutable/)
    await expect(sql(`UPDATE escrow_residual_recoveries SET status = 'SIGNED', "signedTxHex" = 'ab', txid = $1 WHERE id = $2`, 'c'.repeat(64), r.id)).rejects.toThrow(/shape_check/)
    await expect(sql(`DELETE FROM escrow_residual_recoveries WHERE id = $1`, r.id)).rejects.toThrow(/cannot be deleted/)
    await residual.submitResidualRecoverySignature(r.id, f.buyer.id, signCopy(r.unsignedPsbtBase64, f.keys.buyer))
    await residual.submitResidualRecoverySignature(r.id, f.seller.id, signCopy(r.unsignedPsbtBase64, f.keys.seller))
    await expect(sql(`UPDATE escrow_residual_recoveries SET "signedTxHex" = 'ab' WHERE id = $1`, r.id)).rejects.toThrow(/write-once/)
    await expect(sql(`UPDATE escrow_residual_recoveries SET "buyerSignedPsbtBase64" = 'x' WHERE id = $1`, r.id)).rejects.toThrow(/write-once/)
    await expect(sql(`UPDATE escrow_residual_recoveries SET status = 'CANCELLED', "cancelledAt" = now(), "cancelledBy" = 'x' WHERE id = $1`, r.id)).rejects.toThrow(/not a recovery transition|shape_check/)
    await expect(sql(`UPDATE escrow_residual_recoveries SET status = 'PROPOSED' WHERE id = $1`, r.id)).rejects.toThrow(/not a recovery transition|shape_check/)
  })

  it('F8 status guard: raw SQL cannot give an unfunded MULTISIG escrow an economic or terminal state, nor manually cancel its trade', async () => {
    pg.requirePostgres('status guard')
    const f = await addressed('guard')
    for (const status of ['REFUNDED', 'COMPLETED', 'SPLIT', 'DISPUTED', 'PAYMENT_PENDING', 'EXPIRED']) {
      await expect(prisma.$executeRawUnsafe(`UPDATE escrows SET status = $1::"EscrowStatus" WHERE id = $2`, status, f.e.id)).rejects.toThrow(/without its canonical funding outpoint/)
    }
    await expect(prisma.$executeRawUnsafe(`UPDATE trades SET status = 'CANCELLED' WHERE id = $1`, f.t.id)).rejects.toThrow(/never cancelled manually/)
    expect(await outcome(tradeService.updateStatus(f.t.id, 'CANCELLED', f.buyer.id))).toMatch(/funding address/)
    // the legitimate lifecycle is unaffected: the claim before the outpoint is written, then the outpoint
    const g = await locked('guard2')
    expect((await escrowRow(g.e.id)).status).toBe('FUNDS_LOCKED')
    expect((await escrowRow(g.e.id)).txLockId).toBe(g.funding.txid)
  })

  // ─── read-only preflight ──────────────────────────────────────────────────────────────────────────────

  it('PREFLIGHT: classifies SAFE / REVIEW_REQUIRED / UNVERIFIABLE with evidence and changes nothing', async () => {
    pg.requirePostgres('preflight')
    const clean = await locked('pf-clean')
    const stray = await addressed('pf-stray')
    deposit(stray.addr, 20_000); mine(); mine()
    const late = await refunded('pf-late')
    deposit(late.addr, 22_000); mine(); mine()
    const { runMultisigResidualPreflight } = require('../../scripts/multisig-residual-preflight')
    const snapshot = async () => JSON.stringify(await prisma.escrow.findMany({ where: { id: { in: [clean.e.id, stray.e.id, late.e.id] } }, orderBy: { id: 'asc' } }))
    const before = await snapshot()
    const recoveriesBefore = await prisma.escrowResidualRecovery.count()
    const report = await runMultisigResidualPreflight(process.env.DATABASE_URL)
    const of = (id: string) => report.results.find((r: any) => r.escrowId === id)
    expect(of(clean.e.id).classification).toBe('SAFE')
    expect([of(stray.e.id).classification, of(stray.e.id).findings.map((x: any) => x.kind).sort()]).toEqual(['REVIEW_REQUIRED', ['ADDRESSED_CREATED_HOLDS_VALUE', 'RESIDUAL_VALUE']])
    expect([of(late.e.id).classification, of(late.e.id).findings.map((x: any) => x.kind)]).toEqual(['REVIEW_REQUIRED', ['RESIDUAL_VALUE']])
    outage = true
    const down = await runMultisigResidualPreflight(process.env.DATABASE_URL)
    outage = false
    expect(down.results.find((r: any) => r.escrowId === clean.e.id).classification).toBe('UNVERIFIABLE') // never SAFE without evidence
    expect([await snapshot(), await prisma.escrowResidualRecovery.count()]).toEqual([before, recoveriesBefore])
  })

  // ─── #235 R7G F8G: canonical settlement spends exactly the canonical outpoint ─────────────────────────────
  //
  // NF-F8G-1. Every canonical MULTISIG disposition is built through its real initiation path (cooperative release /
  // refund, and the arbiter's signed ruling for release / refund / split) on an escrow whose script ALSO holds a
  // confirmed residual output. The round's PSBT and the transaction actually broadcast must have exactly one input,
  // the persisted canonical outpoint; the residual output must stay unspent, RESIDUAL, and recoverable only by the
  // original buyer and seller.

  const arbiterKeys = nacl.sign.keyPair()
  let arbiterRegistered = false
  async function registerArbiter() {
    if (arbiterRegistered) return
    const publicKey = Buffer.from(arbiterKeys.publicKey).toString('hex')
    await prisma.user.upsert({ where: { id: ARBITER_USER }, update: { publicKey }, create: { id: ARBITER_USER, publicKey, displayName: ARBITER_USER } })
    arbiterRegistered = true
  }
  /** The escrow disputed, with the trusted arbiter assigned, once the trade projection has caught up. */
  async function disputedBy(f: Fx) {
    await registerArbiter()
    await escrowService.openDispute(f.e.id, f.buyer.id, 'f8g canonical isolation')
    await prisma.dispute.create({ data: { tradeId: f.t.id, escrowId: f.e.id, openedBy: f.buyer.id, reason: 'f8g canonical isolation', arbiterId: ARBITER_USER } })
    for (let i = 0; i < 100 && (await prisma.trade.findUniqueOrThrow({ where: { id: f.t.id } })).status !== 'DISPUTED'; i++) await new Promise((r) => setTimeout(r, 20))
  }
  /** The assigned arbiter's signed ruling (dispute.service.resolveDispute): for MULTISIG it opens the arbitrated round. */
  async function rule(f: Fx, ruling: 'RELEASE' | 'REFUND' | 'SPLIT', buyerBps: number | null = null) {
    const { signAuthorityDecision } = require('../../src/modules/open-settlement/arbitration-authority')
    const disputeId = (await prisma.dispute.findUniqueOrThrow({ where: { tradeId: f.t.id } })).id
    const issuedAt = new Date().toISOString()
    const signature = signAuthorityDecision({ disputeId, escrowId: f.e.id, appealRound: 0, authorityId: ARBITER_USER, outcome: ruling, buyerBps, issuedAt }, arbiterKeys.secretKey)
    await require('../../src/modules/open-settlement/dispute.service').getDisputeService()
      .resolveDispute(disputeId, ARBITER_USER, ruling, undefined, undefined, buyerBps ?? undefined, signature, issuedAt)
  }
  const inputsOf = (psbtBase64: string) => bitcoin.Psbt.fromBase64(psbtBase64, { network: NET }).txInputs
    .map((i) => ({ txid: Buffer.from(i.hash).reverse().toString('hex'), vout: i.index }))
  const classified = async (f: Fx, viewer: string) => (await residual.observeResidualValue(f.e.id, viewer)).outputs
    .map((o: any) => [o.txid, o.vout, o.classification])
  /** A locked escrow whose script also holds a later, confirmed, non-canonical deposit. */
  async function canonicalBesideResidual(label: string) {
    const f = await locked(label)
    const extra = deposit(f.addr, 30_000)
    mine(); mine()
    const row = await escrowRow(f.e.id)
    const canonical = { txid: row.txLockId!, vout: row.txLockVout! }
    expect(canonical).toEqual({ txid: f.funding.txid, vout: f.funding.vout })
    expect(utxosAt(f.addr).map((u) => [u.txid, u.vout]).sort()).toEqual([[canonical.txid, canonical.vout], [extra.txid, extra.vout]].sort())
    expect((await classified(f, f.buyer.id)).sort()).toEqual([[canonical.txid, canonical.vout, 'CANONICAL'], [extra.txid, extra.vout, 'RESIDUAL']].sort())
    return { ...f, extra, canonical }
  }
  /** Builds the disposition through `initiate`, proves its inputs, executes it, then proves the residual is untouched and recoverable. */
  async function settlesOnlyCanonical(f: Awaited<ReturnType<typeof canonicalBesideResidual>>, initiate: () => Promise<unknown>, terminal: string) {
    await initiate()
    const round = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: f.e.id } })
    // the round's transaction: exactly the canonical outpoint, on this escrow's own script - no second input, no sweep
    expect(inputsOf(round.unsignedPsbtBase64)).toEqual([f.canonical])
    const spent = bitcoin.Psbt.fromBase64(round.unsignedPsbtBase64, { network: NET }).data.inputs[0].witnessUtxo!
    expect([bitcoin.address.fromOutputScript(Buffer.from(spent.script), NET), Number(spent.value)]).toEqual([f.addr, FUNDING])
    for (const signer of round.requiredSigners) {
      await escrowService.submitTransactionSignature(f.e.id, signer, signCopy(round.unsignedPsbtBase64, signer === f.buyer.id ? f.keys.buyer : f.keys.seller))
    }
    const e = await escrowRow(f.e.id)
    expect(e.status).toBe(terminal)
    // the transaction actually broadcast spends exactly the canonical outpoint, with a valid 2-of-3 witness for it
    expect(txs.get(e.txReleaseId!)!.spends).toEqual([f.canonical])
    const raw = broadcasts.find((h) => bitcoin.Transaction.fromHex(h).getId() === e.txReleaseId)!
    expect(validateSpend(raw, f.addr, FUNDING).valid).toBe(true)
    mine(); mine()
    // the residual output: unspent, still RESIDUAL, and the only value left on the script
    expect(spenderOf(f.extra.txid, f.extra.vout)).toBeUndefined()
    expect(await classified(f, f.seller.id)).toEqual([[f.extra.txid, f.extra.vout, 'RESIDUAL']])
    // recoverable only by the original buyer and seller - never the arbiter or a stranger
    const D = addressOf(`f8g-destination-${f.e.id}`)
    for (const who of [ARBITER_USER, f.stranger.id]) {
      expect(await outcome(residual.proposeResidualRecovery(f.e.id, who, { ...f.extra, destination: D }))).toMatch(/not an original participant/)
    }
    const { proposed } = await recover(f, f.extra, D)
    mine(); mine()
    await residual.reconcileResidualRecoveries()
    const recovery = await recoveryRow(proposed.id)
    expect([recovery.status, txs.get(recovery.txid!)!.spends]).toEqual(['CONFIRMED', [{ txid: f.extra.txid, vout: f.extra.vout }]])
    expect(await classified(f, f.buyer.id)).toEqual([])
  }

  it('F8G-1: cooperative RELEASE spends exactly the canonical outpoint; the residual stays RESIDUAL and buyer+seller recoverable', async () => {
    pg.requirePostgres('F8G-1')
    const f = await canonicalBesideResidual('g-crel')
    await escrowService.markPaymentSent(f.e.id, f.buyer.id)
    await settlesOnlyCanonical(f, () => escrowService.initiateRelease(f.e.id, undefined, f.seller.id), 'COMPLETED')
  })

  it('F8G-2: cooperative REFUND spends exactly the canonical outpoint; the residual stays RESIDUAL and buyer+seller recoverable', async () => {
    pg.requirePostgres('F8G-2')
    const f = await canonicalBesideResidual('g-cref')
    await settlesOnlyCanonical(f, () => escrowService.initiateRefund(f.e.id, f.seller.id), 'REFUNDED')
  })

  it('F8G-3: arbitrated RELEASE spends exactly the canonical outpoint; the residual stays RESIDUAL and buyer+seller recoverable', async () => {
    pg.requirePostgres('F8G-3')
    const f = await canonicalBesideResidual('g-arel')
    await disputedBy(f)
    await settlesOnlyCanonical(f, () => rule(f, 'RELEASE'), 'COMPLETED')
  })

  it('F8G-4: arbitrated REFUND spends exactly the canonical outpoint; the residual stays RESIDUAL and buyer+seller recoverable', async () => {
    pg.requirePostgres('F8G-4')
    const f = await canonicalBesideResidual('g-aref')
    await disputedBy(f)
    await settlesOnlyCanonical(f, () => rule(f, 'REFUND'), 'REFUNDED')
  })

  it('F8G-5: arbitrated SPLIT spends exactly the canonical outpoint; the residual stays RESIDUAL and buyer+seller recoverable', async () => {
    pg.requirePostgres('F8G-5')
    const f = await canonicalBesideResidual('g-asplit')
    await disputedBy(f)
    await settlesOnlyCanonical(f, () => rule(f, 'SPLIT', 6000), 'SPLIT')
  })

  // ─── #235 R7G F8G: legacy locks without a vout (NF-F8G-2) ───────────────────────────────────────────────

  it('F8G-PREFLIGHT: a lock with a txid but no vout is REVIEW_REQUIRED (CANONICAL_OUTPOINT_VOUT_UNKNOWN), never SAFE, never resolved to one output; a modern lock has no such finding; read only', async () => {
    pg.requirePostgres('F8G preflight')
    const { runMultisigResidualPreflight } = require('../../scripts/multisig-residual-preflight')
    const modern = await locked('g-pf-modern')
    // a legacy-shaped lock whose funding transaction paid the script twice: the lock takes the canonical output, then
    // the row is made to look like a pre-vout (Missão 10) lock - the shape this finding exists for
    const legacy = await addressed('g-pf-legacy')
    const fundingTxid = randomBytes(32).toString('hex')
    txs.set(fundingTxid, { height: tip, outputs: [{ address: legacy.addr, value: FUNDING }, { address: legacy.addr, value: 12_000 }], spends: [] })
    mine(); mine()
    await escrowService.lockFunds(legacy.e.id, legacy.seller.id)
    expect([(await escrowRow(legacy.e.id)).txLockId, (await escrowRow(legacy.e.id)).txLockVout]).toEqual([fundingTxid, 0])
    await prisma.$executeRaw`UPDATE escrows SET "txLockVout" = NULL WHERE id = ${legacy.e.id}`
    // runtime semantics unchanged: both outputs of that txid are treated as canonical, neither is residual
    expect((await classified(legacy, legacy.buyer.id)).sort()).toEqual([[fundingTxid, 0, 'CANONICAL'], [fundingTxid, 1, 'CANONICAL']])
    const ids = [modern.e.id, legacy.e.id]
    const snapshot = async () => JSON.stringify([await prisma.escrow.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } }), await prisma.escrowResidualRecovery.count()])
    const before = await snapshot()

    const report = await runMultisigResidualPreflight(process.env.DATABASE_URL)
    const of = (r: any, id: string) => r.results.find((x: any) => x.escrowId === id)
    const finding = of(report, legacy.e.id).findings.find((x: any) => x.kind === 'CANONICAL_OUTPOINT_VOUT_UNKNOWN')
    expect(of(report, legacy.e.id).classification).toBe('REVIEW_REQUIRED')
    expect(finding.detail.txLockId).toBe(fundingTxid)
    expect(finding.detail.reason).toMatch(/cannot be uniquely identified from durable state; no output is chosen/)
    // both outputs of the txid are surfaced, and none is designated canonical
    expect(finding.detail.outputsSharingTxid.map((o: any) => [o.vout, o.valueSats])).toEqual([[0, FUNDING], [1, 12_000]])
    expect(Object.keys(finding.detail).sort()).toEqual(['outputsSharingTxid', 'reason', 'txLockId'])
    expect(of(report, modern.e.id).findings.map((x: any) => x.kind)).not.toContain('CANONICAL_OUTPOINT_VOUT_UNKNOWN')
    expect(of(report, modern.e.id).classification).toBe('SAFE')

    // an explorer outage never turns the null-vout row into SAFE (or merely UNVERIFIABLE)
    outage = true
    const down = await runMultisigResidualPreflight(process.env.DATABASE_URL)
    outage = false
    expect([of(down, legacy.e.id).classification, of(down, legacy.e.id).findings.map((x: any) => x.kind).sort()])
      .toEqual(['REVIEW_REQUIRED', ['CANONICAL_OUTPOINT_VOUT_UNKNOWN', 'EXPLORER_UNAVAILABLE']])
    expect(of(down, legacy.e.id).findings.find((x: any) => x.kind === 'CANONICAL_OUTPOINT_VOUT_UNKNOWN').detail.outputsSharingTxid).toEqual([])
    expect(of(down, modern.e.id).classification).toBe('UNVERIFIABLE')

    // read only: no row repaired, no vout manufactured, no recovery created
    expect(await snapshot()).toEqual(before)
    expect((await escrowRow(legacy.e.id)).txLockVout).toBeNull()
  })
})
