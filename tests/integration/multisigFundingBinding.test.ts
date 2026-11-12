// tests/integration/multisigFundingBinding.test.ts
//
// CTO 25 funding binding - one committed MULTISIG address per escrow, funding selection that never picks by explorer
// order, a reorg sweep that only (re)confirms the recorded outpoint, and round input binding at creation and at
// execution. Real PostgreSQL, real 2-of-3 P2WSH PSBTs, real services; the explorer is simulated and serves an explicit,
// ordered UTXO list. Every key is derived per test from a label; every txid is synthetic.
import * as bitcoin from 'bitcoinjs-lib'
import * as ecc from 'tiny-secp256k1'
import { ECPairFactory } from 'ecpair'
import { createHash, randomBytes } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { registerTestParticipant, closeTestRedis } from './identityTestHelpers'
import { MULTISIG_CAPABILITY_PROFILE_V1 } from '@satsails/p2p-schemas'
import * as H from './pendingRoundLifecycleHarness'

const ECPair = ECPairFactory(ecc)
// Salted per run: integration files share a database (and reruns reuse it), and an address is committed only once.
const RUN = randomBytes(8).toString('hex')
const key = (label: string) => ECPair.fromPrivateKey(createHash('sha256').update(`aux2-fund-${RUN}-${label}`).digest(), { network: H.NETWORK })
const hex = (k: ReturnType<typeof key>) => Buffer.from(k.publicKey).toString('hex')
const txid = (label: string) => createHash('sha256').update(`aux2-fund-tx-${label}-${Math.random()}-${Date.now()}`).digest('hex')
const VALUE = 100_000

describe('MULTISIG funding binding (real PostgreSQL)', () => {
  jest.setTimeout(300_000)
  const pg = createPostgresIntegrationHarness()
  let prisma: any, escrowService: any, identityService: any, liquidityRouter: any, tradeService: any, payoutAddressService: any
  let submitSig: any, sweep: any, evidence: any, feePolicyService: any, MultisigProvider: any, multisigProvider: any, config: any
  let chain: H.Chain; let realFetch: typeof fetch; let posts = 0
  let utxos: Array<{ txid: string; vout: number; value: number }> = []

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'false'; process.env.MULTISIG_SEED = process.env.MULTISIG_SEED || 'aux2-fund-seed'
    await pg.probe()
    if (!pg.isAvailable()) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ escrowService } = require('../../src/modules/open-settlement/escrow.service'))
    ;({ identityService } = require('../../src/modules/open-identity/identity.service'))
    ;({ liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service'))
    ;({ tradeService } = require('../../src/modules/open-p2p/trade.service'))
    ;({ payoutAddressService } = require('../../src/modules/open-settlement/payout-address.service'))
    ;({ submitTransactionSignature: submitSig } = require('../../src/modules/open-settlement/escrow-pending-tx'))
    ;({ sweepMultisigFundingReorgs: sweep } = require('../../src/modules/open-settlement/multisig-funding-reorg-sweep'))
    ;({ escrowFundingEvidenceService: evidence } = require('../../src/modules/open-settlement/escrow-funding-evidence.service'))
    ;({ feePolicyService } = require('../../src/modules/open-settlement/fee-policy.service'))
    ;({ MultisigProvider, multisigProvider } = require('../../src/modules/open-settlement/multisig.provider'))
    ;({ config } = require('../../src/config'))
    const { intentEngine } = require('../../src/core/intent-engine'); const { OpenP2PTradeIntentHandler } = require('../../src/modules/open-p2p/intent-handler')
    intentEngine.registerHandler(OpenP2PTradeIntentHandler)
  })
  afterAll(async () => { if (prisma) await prisma.$disconnect(); await closeTestRedis() })

  beforeEach(() => {
    if (!pg.isAvailable()) return
    chain = H.newChain(); realFetch = global.fetch; posts = 0; utxos = []
    const base = H.explorer(chain)
    global.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
      const url = String(input)
      if (init?.method === 'POST' && url.endsWith('/tx')) {
        posts++
        const raw = init.body as string; const id = bitcoin.Transaction.fromHex(raw).getId()
        chain.broadcasts.push(id); chain.hex.set(id, raw); chain.mempool.add(id)
        return { ok: true, status: 200, text: async () => id, json: async () => ({}) } as unknown as Response
      }
      if (url.includes('/utxo')) {
        const body = utxos.map((u) => ({ ...u, status: { confirmed: true } }))
        return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response
      }
      return base(url, init as RequestInit)
    }) as typeof fetch
  })
  afterEach(() => { jest.restoreAllMocks(); if (realFetch) global.fetch = realFetch })

  /** A MULTISIG escrow (fee regime pinned to "no policy") whose buyer and seller submit the keys derived from `keys`. */
  async function escrow(label: string, keys = label, fee = false) {
    const seller = await registerTestParticipant(identityService, 'Seller'); const buyer = await registerTestParticipant(identityService, 'Buyer')
    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER' })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    // fee: a published 0.4% policy and a collection address are pinned for createEscrow()'s real snapshot path.
    const policy = fee ? await prisma.feePolicyVersion.create({ data: {
      label: `aux2-fund-${RUN}-${label}`, railScope: `MULTISIG-aux2-fund-${RUN}-${label}`, status: 'PUBLISHED', publishedAt: new Date(),
      protocolFeeRate: '0.004', payerModel: 'SELLER_PAYS', economicBasis: 'SELLER_DELIVERED_VALUE',
      nodeOperatorPct: '30', treasuryPct: '25', walletRebatePct: '35', arbitratorReservePct: '10', requiredConfirmations: 2, createdBy: 'aux2-fund-test',
    } }) : null
    const live = jest.spyOn(feePolicyService, 'findLivePolicyForRail').mockResolvedValue(policy)
    const collection = config.settlement.protocolFeeCollectionAddress
    if (fee) config.settlement.protocolFeeCollectionAddress = H.testnetAddress(`${label}-fee`)
    let e: any
    try { e = await escrowService.createEscrow({ tradeId: trade.id, type: 'MULTISIG', lockedAmount: '0.001', asset: 'BTC' }, seller.id) } finally { live.mockRestore(); config.settlement.protocolFeeCollectionAddress = collection }
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: e.id } })
    await payoutAddressService.setPayoutAddress(buyer.id, 'BTC', H.testnetAddress(`${label}-buyer`))
    await payoutAddressService.setPayoutAddress(seller.id, 'BTC', H.testnetAddress(`${label}-seller`))
    return { label, id: e.id as string, tradeId: trade.id as string, buyerId: buyer.id as string, sellerId: seller.id as string, buyerKey: key(`${keys}-b`), sellerKey: key(`${keys}-s`) }
  }
  type E = Awaited<ReturnType<typeof escrow>>
  const commit = async (e: E) => {
    await escrowService.submitParticipantKey(e.id, e.buyerId, hex(e.buyerKey), MULTISIG_CAPABILITY_PROFILE_V1)
    return escrowService.submitParticipantKey(e.id, e.sellerId, hex(e.sellerKey), MULTISIG_CAPABILITY_PROFILE_V1)
  }
  const row = (e: E) => prisma.escrow.findUniqueOrThrow({ where: { id: e.id } })
  const fund = (label: string, value = VALUE) => { const id = txid(label); chain.fundings.add(id); return { txid: id, vout: 0, value } }
  const lock = (e: E) => escrowService.lockFunds(e.id, e.sellerId).then(() => 'locked', (err: Error) => `${err.constructor?.name}: ${err.message}`)
  const outcome = (p: Promise<unknown>) => p.then(() => 'ok', (err: any) => ({ name: err.constructor?.name, code: err.code, statusCode: err.statusCode, message: err.message }))
  const evidenceOf = async (e: E) => (await prisma.escrowFundingEvidence.findMany({ where: { escrowId: e.id }, orderBy: { recordedAt: 'asc' } })).map((x: any) => ({ kind: x.kind, txid: x.txid }))
  const sign = (psbtBase64: string, k: ReturnType<typeof key>) => { const p = bitcoin.Psbt.fromBase64(psbtBase64, { network: H.NETWORK }); p.signInput(0, k); return p.toBase64() }
  const log = (label: string, data: unknown) => console.log(`[evidence] ${JSON.stringify({ label, ...(data as object) })}`)

  async function lockedEscrow(label: string) {
    const e = await escrow(label); await commit(e)
    const x = fund(`${label}-x`); utxos = [x]
    expect(await lock(e)).toBe('locked')
    return { e, x }
  }

  describe('one committed address per escrow', () => {
    it('a second escrow deriving an already committed address is refused with 409, keeps its submitted keys, and commits once a fresh key is submitted', async () => {
      pg.requirePostgres('address uniqueness')
      const a = await escrow('uniq-a', 'shared'); const b = await escrow('uniq-b', 'shared')
      await commit(a)
      const refused = await outcome(commit(b))
      const bRow = await row(b); const aRow = await row(a)
      const keys = await prisma.escrowParticipantKey.findMany({ where: { escrowId: b.id }, select: { role: true } })
      log('address uniqueness', { refused, a: aRow.multisigAddr, b: bRow.multisigAddr, bKeys: keys.map((k: any) => k.role).sort() })
      expect(refused).toMatchObject({ statusCode: 409, code: 'MULTISIG_ADDRESS_ALREADY_COMMITTED' })
      expect(bRow.multisigAddr).toBeNull()
      expect(keys.map((k: any) => k.role).sort()).toEqual(['buyer', 'seller']) // nothing removed; no arbiter row, no address
      await escrowService.submitParticipantKey(b.id, b.buyerId, hex(key('uniq-b-fresh')), MULTISIG_CAPABILITY_PROFILE_V1)
      const after = await row(b)
      expect(after.multisigAddr).toBeTruthy()
      expect(after.multisigAddr).not.toBe(aRow.multisigAddr)
    })

    it.each([['COMMIT', true], ['ROLLBACK', false]] as const)('the database, not a pre-check, settles a race: a concurrent uncommitted claim of the address, then %s', async (end, refusedExpected) => {
      pg.requirePostgres(`address race ${end}`)
      const a = await escrow(`race-${end}-a`, `race-${end}`); const b = await escrow(`race-${end}-b`, `race-${end}`)
      const { address } = await multisigProvider.getDepositAddress(b.tradeId, hex(b.buyerKey), hex(b.sellerKey))
      await escrowService.submitParticipantKey(b.id, b.buyerId, hex(b.buyerKey), MULTISIG_CAPABILITY_PROFILE_V1)
      let finish!: () => void; const gate = new Promise<void>((r) => { finish = r }); let held = false
      const holder = prisma.$transaction(async (tx: any) => {
        await tx.$executeRawUnsafe(`UPDATE "escrows" SET "multisigAddr" = $2 WHERE "id" = $1`, a.id, address)
        held = true; await gate
        if (end === 'ROLLBACK') throw new Error('rollback on purpose')
      }, { timeout: 60_000 }).catch(() => 'rolled back')
      for (let i = 0; i < 200 && !held; i++) await new Promise((r) => setTimeout(r, 25))
      const racing = outcome(escrowService.submitParticipantKey(b.id, b.sellerId, hex(b.sellerKey), MULTISIG_CAPABILITY_PROFILE_V1))
      let waited = false
      for (let i = 0; i < 200 && !waited; i++) {
        waited = (await prisma.$queryRaw`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%UPDATE%escrows%'`)[0].n > 0
        if (!waited) await new Promise((r) => setTimeout(r, 25))
      }
      finish(); await holder
      const result = await racing
      log(`address race ${end}`, { waitedOnIndex: waited, result, a: (await row(a)).multisigAddr === address, b: (await row(b)).multisigAddr === address })
      expect(waited).toBe(true)
      if (refusedExpected) {
        expect(result).toMatchObject({ statusCode: 409, code: 'MULTISIG_ADDRESS_ALREADY_COMMITTED' })
        expect((await row(b)).multisigAddr).toBeNull()
      } else {
        expect(result).toBe('ok')
        expect((await row(b)).multisigAddr).toBe(address)
      }
    })
  })

  describe('funding selection', () => {
    it('two UTXOs satisfying the funding rule at the escrow\'s address: lockFunds is refused and nothing is recorded', async () => {
      pg.requirePostgres('ambiguous lock')
      const e = await escrow('amb'); await commit(e)
      utxos = [fund('amb-1'), fund('amb-2')]
      const result = await lock(e)
      const r = await row(e)
      log('ambiguous lock', { result, status: r.status, txLockId: r.txLockId, evidence: await evidenceOf(e) })
      expect(result).toMatch(/2 UTXOs at .* each satisfy this escrow's funding rule/)
      expect(r).toMatchObject({ status: 'CREATED', txLockId: null, txLockVout: null, fundedAmount: null })
      expect(await evidenceOf(e)).toEqual([])
    })

    it('a UTXO already recorded as another escrow\'s funding is never taken, even when listed first', async () => {
      pg.requirePostgres('claimed outpoint')
      const e = await escrow('claimed'); await commit(e)
      const x = fund('claimed-x'); const y = fund('claimed-y')
      const other = await escrow('claimed-other')
      await prisma.escrow.update({ where: { id: other.id }, data: { txLockId: x.txid, txLockVout: 0 } }) // recorded elsewhere
      utxos = [x, y]
      expect(await lock(e)).toBe('locked')
      expect(await row(e)).toMatchObject({ txLockId: y.txid, txLockVout: 0 })
    })

    it('fundedAmount is recorded, in BTC, for a MULTISIG escrow without a fee policy', async () => {
      pg.requirePostgres('fundedAmount')
      const { e } = await lockedEscrow('funded')
      expect((await row(e)).fundedAmount.toString()).toBe('0.001')
    })
  })

  describe('protocol fee > 0 (0.4%): funding T + Fmax = 100 400 sats', () => {
    it('fundedAmount is 0.001004 BTC (100 400 sats, not 100400 BTC), and the fee-bearing cooperative release binds and completes', async () => {
      pg.requirePostgres('fee binding')
      const e = await escrow('fee-ok', 'fee-ok', true); await commit(e)
      const x = fund('fee-ok-x', 100_400); utxos = [x]
      expect(await lock(e)).toBe('locked')
      const r = await row(e)
      expect(r.fundedAmount.toString()).toBe('0.001004')
      await escrowService.markPaymentSent(e.id, e.buyerId)
      const round = await escrowService.initiateRelease(e.id, undefined, e.sellerId)
      const built = bitcoin.Psbt.fromBase64(round.unsignedPsbtBase64, { network: H.NETWORK })
      expect(Number(built.data.inputs[0].witnessUtxo!.value)).toBe(100_400)
      expect(built.txOutputs.map((o) => bitcoin.address.fromOutputScript(o.script, H.NETWORK))).toContain(H.testnetAddress('fee-ok-fee'))
      await submitSig(e.id, e.buyerId, sign(round.unsignedPsbtBase64, e.buyerKey))
      const done = await submitSig(e.id, e.sellerId, sign(round.unsignedPsbtBase64, e.sellerKey))
      log('fee binding', { fundedAmount: r.fundedAmount.toString(), outputs: built.txOutputs.map((o) => Number(o.value)), posts })
      expect(done.complete).toBe(true)
      expect(posts).toBe(1)
    })

    it('a fee-bearing round whose input carries T (100 000) instead of T + Fmax (100 400) is refused at creation', async () => {
      pg.requirePostgres('fee binding value')
      const e = await escrow('fee-short', 'fee-short', true); await commit(e)
      utxos = [fund('fee-short-x', 100_400)]
      expect(await lock(e)).toBe('locked')
      await escrowService.markPaymentSent(e.id, e.buyerId)
      const release = MultisigProvider.prototype.buildUnsignedRelease
      jest.spyOn(MultisigProvider.prototype, 'buildUnsignedRelease').mockImplementation(async function (this: any, ...args: any[]) {
        const r = await release.apply(this, args)
        const p = bitcoin.Psbt.fromBase64(r.psbtBase64, { network: H.NETWORK })
        const q = new bitcoin.Psbt({ network: H.NETWORK })
        q.addInput({ hash: p.txInputs[0].hash, index: p.txInputs[0].index, witnessUtxo: { ...p.data.inputs[0].witnessUtxo!, value: 100_000n }, witnessScript: p.data.inputs[0].witnessScript! })
        for (const o of p.txOutputs) q.addOutput({ script: o.script, value: o.value })
        return { ...r, psbtBase64: q.toBase64() }
      } as never)
      const result = await outcome(escrowService.initiateRelease(e.id, undefined, e.sellerId))
      expect(result).toMatchObject({ code: 'ROUND_INPUT_MISMATCH' })
      expect((result as any).message).toMatch(/input value is 100000 sats, the recorded funded amount is 100400 sats/)
      expect(posts).toBe(0)
    })
  })

  describe('reorg sweep', () => {
    it('only the recorded outpoint is (re)confirmed: another UTXO at the address is ignored while it is there, and stays REPLACEMENT_OBSERVED after', async () => {
      pg.requirePostgres('sweep')
      const { e, x } = await lockedEscrow('sweep')
      const z = fund('sweep-z')
      const tick = async (list: typeof utxos) => {
        utxos = list
        const r = await sweep()
        return { result: ['stillGood', 'reconfirmed', 'replacementObserved', 'stillPending', 'reverted'].find((k) => r[k].includes(e.id)) ?? 'none', uncertain: await evidence.isFundingUncertain(e.id) }
      }
      const t1 = await tick([z, x]) // recorded X present, an extra exact-value UTXO listed first
      const t2 = await tick([z]) // X gone, Z remains
      const t3 = await tick([z])
      const t4 = await tick([x]) // X back
      const ev = await evidenceOf(e)
      log('sweep', { X: x.txid, Z: z.txid, t1, t2, t3, t4, evidence: ev })
      expect(t1).toEqual({ result: 'stillGood', uncertain: false })
      expect(t2).toEqual({ result: 'replacementObserved', uncertain: true })
      expect(t3).toEqual({ result: 'stillPending', uncertain: true }) // never promoted to RECONFIRMED
      expect(t4).toEqual({ result: 'reconfirmed', uncertain: false })
      expect(ev).toEqual([
        { kind: 'OBSERVED_CONFIRMED', txid: x.txid }, { kind: 'REPLACEMENT_OBSERVED', txid: z.txid }, { kind: 'RECONFIRMED', txid: x.txid },
      ])
    })
  })

  describe('round input binding', () => {
    /** The provider's own PSBT, rebuilt with one input-side change. */
    function tamper(psbtBase64: string, how: 'vout' | 'value' | 'script' | 'twoInputs') {
      const src = bitcoin.Psbt.fromBase64(psbtBase64, { network: H.NETWORK })
      const inp = src.txInputs[0]; const data = src.data.inputs[0]
      const other = bitcoin.payments.p2wsh({ redeem: bitcoin.payments.p2ms({ m: 2, pubkeys: ['o1', 'o2', 'o3'].map((l) => Buffer.from(key(l).publicKey)), network: H.NETWORK }), network: H.NETWORK })
      const p = new bitcoin.Psbt({ network: H.NETWORK })
      p.addInput({
        hash: inp.hash, index: how === 'vout' ? inp.index + 1 : inp.index,
        witnessUtxo: { script: how === 'script' ? other.output! : data.witnessUtxo!.script, value: how === 'value' ? data.witnessUtxo!.value + 1n : data.witnessUtxo!.value },
        witnessScript: how === 'script' ? other.redeem!.output! : data.witnessScript!,
      })
      if (how === 'twoInputs') p.addInput({ hash: 'dd'.repeat(32), index: 0, witnessUtxo: data.witnessUtxo!, witnessScript: data.witnessScript! })
      for (const o of src.txOutputs) p.addOutput({ script: o.script, value: o.value })
      return p.toBase64()
    }

    it.each(['vout', 'value', 'script', 'twoInputs'] as const)('creation: a translation whose input differs (%s) is refused with 409, no round, no POST', async (how) => {
      pg.requirePostgres(`binding creation ${how}`)
      const { e } = await lockedEscrow(`bind-c-${how}`)
      await escrowService.markPaymentSent(e.id, e.buyerId)
      const release = MultisigProvider.prototype.buildUnsignedRelease
      jest.spyOn(MultisigProvider.prototype, 'buildUnsignedRelease').mockImplementation(async function (this: any, ...args: any[]) {
        const r = await release.apply(this, args); return { ...r, psbtBase64: tamper(r.psbtBase64, how) }
      } as never)
      const result = await outcome(escrowService.initiateRelease(e.id, undefined, e.sellerId))
      log(`binding creation ${how}`, { result })
      expect(result).toMatchObject({ name: 'RoundInputMismatch', code: 'ROUND_INPUT_MISMATCH', statusCode: 409 })
      expect(await prisma.escrowPendingTransaction.count({ where: { escrowId: e.id } })).toBe(0)
      expect(posts).toBe(0)
    })

    it('execution: a persisted round whose input no longer matches is refused before any gate or claim; round and signatures stay, no POST', async () => {
      pg.requirePostgres('binding execution')
      const { e } = await lockedEscrow('bind-x')
      await escrowService.markPaymentSent(e.id, e.buyerId)
      await escrowService.initiateRelease(e.id, undefined, e.sellerId)
      const honest = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: e.id } })
      const altered = tamper(honest.unsignedPsbtBase64, 'vout')
      await prisma.escrowPendingTransaction.update({ where: { id: honest.id }, data: { unsignedPsbtBase64: altered } }) // a row that no longer binds
      const before = await row(e)
      await submitSig(e.id, e.buyerId, sign(altered, e.buyerKey))
      const result = await outcome(submitSig(e.id, e.sellerId, sign(altered, e.sellerKey)))
      const after = await row(e)
      const state = {
        status: after.status, txReleaseId: after.txReleaseId, rounds: await prisma.escrowPendingTransaction.count({ where: { escrowId: e.id } }),
        signatures: await prisma.escrowTransactionSignature.count({ where: { pendingTxId: honest.id } }),
        capabilityAuthorizations: await prisma.capabilityExecutionAuthorization.count({ where: { escrowId: e.id } }).catch(() => 'n/a'),
      }
      log('binding execution', { result, posts, before: before.status, state })
      expect(result).toMatchObject({ name: 'RoundInputMismatch', code: 'ROUND_INPUT_MISMATCH', statusCode: 409 })
      expect(posts).toBe(0)
      expect(state).toMatchObject({ status: before.status, txReleaseId: null, rounds: 1, signatures: 2 })
    })

    it('control: the honest cooperative release spends the recorded funding and completes with one POST', async () => {
      pg.requirePostgres('binding control')
      const { e, x } = await lockedEscrow('bind-ok')
      await escrowService.markPaymentSent(e.id, e.buyerId)
      const round = await escrowService.initiateRelease(e.id, undefined, e.sellerId)
      await submitSig(e.id, e.buyerId, sign(round.unsignedPsbtBase64, e.buyerKey))
      const r = await submitSig(e.id, e.sellerId, sign(round.unsignedPsbtBase64, e.sellerKey))
      const spent = bitcoin.Transaction.fromHex(chain.hex.get(chain.broadcasts[0])!).ins[0]
      expect(r.complete).toBe(true)
      expect(posts).toBe(1)
      expect(`${Buffer.from(spent.hash).reverse().toString('hex')}:${spent.index}`).toBe(`${x.txid}:0`)
      expect((await row(e)).status).toBe('COMPLETED')
    })
  })
})
