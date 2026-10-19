// AUD1X-H1 - the MULTISIG bearer-capability correction, on real PostgreSQL and the production services.
//
// The independent audit of AUD-1 (PR #437) found that on MULTISIG - the only production-selectable rail - the
// platform arbiter signature was built INTO the round at construction. Before any signed ruling existed, the assigned
// arbiter's session alone obtained a transaction its beneficiary completed OUTSIDE Sails with their own key (probe
// F1); it blocked the honest ruling for good (F1) and survived a committed Outcome (F2); and a round could be
// persisted from a pre-lock dispute snapshot after a ruling landed (F3).
//
// The correction (A) builds a disputed MULTISIG round only for a RESOLVED, signed ruling re-read under the dispute
// and escrow locks (D then E), and (B) produces the arbiter signature at EXECUTION only, in memory, after the
// ADR-005/ADR-004 gates, from the authorization that gate pass committed.
//
// F1/F2/F3 are kept here as permanent regression tests. What is real: PostgreSQL; escrow/trade/dispute/payout
// addresses/participant keys (production services); the ruling (resolveDispute() -> commitAuthoritativeDisputeRuling()
// -> real PSBT translation); appeal(); initiate-*; submitTransactionSignature(); the C4 and C8 recoveries; real PSBTs,
// real keys, real witness verification. What is not: the chain (an explorer stub that records, never sends, every
// broadcast) and each fault injection, named where used.
import { PrismaClient } from '@prisma/client'
import * as bitcoin from 'bitcoinjs-lib'
import * as ecc from '@bitcoinerlab/secp256k1'
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import nacl from 'tweetnacl'
import { ECPairFactory } from 'ecpair'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { registerTestParticipant, closeTestRedis } from './identityTestHelpers'
import { MULTISIG_CAPABILITY_PROFILE_V1 } from '@satsails/p2p-schemas'
import { boundOfferInput, sellerPixAccount } from './economicFixtures'

bitcoin.initEccLib(ecc)
const ECPair = ECPairFactory(ecc)
const NET = bitcoin.networks.testnet
const keyOf = (label: string) => ECPair.fromPrivateKey(createHash('sha256').update(`h1-${label}`).digest())
const pubHex = (k: { publicKey: Uint8Array }) => Buffer.from(k.publicKey).toString('hex')
const destination = (label: string) => bitcoin.payments.p2wpkh({ pubkey: Buffer.from(keyOf(label).publicKey), network: NET }).address!
const addrOf = (script: Uint8Array) => { try { return bitcoin.address.fromOutputScript(script, NET) } catch { return 'non-standard' } }

describe('AUD1X-H1 MULTISIG bearer-capability correction - real PostgreSQL', () => {
  jest.setTimeout(300_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let escrowService: any
  let identityService: any
  let liquidityRouter: any
  let tradeService: any
  let DisputeService: any
  let getDisputeService: () => any
  let payoutAddressService: any
  let signAuthorityDecision: (payload: unknown, secretKey: Uint8Array) => string
  let commitAuthoritativeDisputeRuling: (...args: any[]) => Promise<{ committed: boolean }>
  let submitTransactionSignature: (escrowId: string, participantId: string, signedPsbtBase64: string) => Promise<any>
  let getPendingTransaction: (escrowId: string, viewerId: string) => Promise<any>
  let deletePendingRoundIfStillUnsigned: (pendingId: string, escrowId: string, generation: any) => Promise<string>
  let reconcileUnclaimedFullySignedPending: (report: any) => Promise<void>
  let reconcilePendingSettlements: (options?: { projectionGraceMs?: number }) => Promise<any>
  let authorizeDisputedPendingExecution: (pending: any) => Promise<any>
  let reconcileMissingDispatch: () => Promise<any>
  let economicDispositionLockKey: (disputeId: string) => string
  let escrowRepository: any
  let loadParticipantPubkeys: (escrowId: string) => Promise<{ buyerPubkey?: string; sellerPubkey?: string; arbiterPubkey?: string }>
  let multisigProvider: any
  let restarted: { prisma: PrismaClient; submitTransactionSignature: typeof submitTransactionSignature; redis: { quit(): Promise<unknown> } } | undefined

  const ARBITER_ID = 'h1-arbiter-1'
  const ARBITER2_ID = 'h1-arbiter-2'
  const arbiterKp = nacl.sign.keyPair()
  const arbiter2Kp = nacl.sign.keyPair()
  const buyerKey = keyOf('buyer')
  const sellerKey = keyOf('seller')
  let realFetch: typeof fetch
  const broadcasts: string[] = []
  const removedCommitments: Array<{ escrowId: string; role: string; participantId: string; pubkey: string }> = []
  let seq = 0

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'false'
    process.env.MULTISIG_SEED = process.env.MULTISIG_SEED || 'h1-seed'
    process.env.TRUSTED_ARBITRATORS = `${ARBITER_ID},${ARBITER2_ID}`
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ escrowService } = require('../../src/modules/open-settlement/escrow.service'))
    ;({ identityService } = require('../../src/modules/open-identity/identity.service'))
    ;({ liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service'))
    ;({ tradeService } = require('../../src/modules/open-p2p/trade.service'))
    ;({ DisputeService, getDisputeService } = require('../../src/modules/open-settlement/dispute.service'))
    ;({ payoutAddressService } = require('../../src/modules/open-settlement/payout-address.service'))
    ;({ signAuthorityDecision } = require('../../src/modules/open-settlement/arbitration-authority'))
    ;({ commitAuthoritativeDisputeRuling } = require('../../src/modules/open-settlement/dispute-outcome'))
    ;({ submitTransactionSignature, getPendingTransaction } = require('../../src/modules/open-settlement/escrow-pending-tx'))
    ;({ deletePendingRoundIfStillUnsigned } = require('../../src/modules/open-settlement/dispute-pending-reconciliation'))
    ;({ reconcileUnclaimedFullySignedPending, reconcilePendingSettlements } = require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service'))
    ;({ authorizeDisputedPendingExecution } = require('../../src/modules/open-settlement/economic-disposition-authority'))
    ;({ reconcileMissingDispatch } = require('../../src/modules/open-settlement/dispute-dispatch-recovery'))
    ;({ economicDispositionLockKey } = require('../../src/modules/open-settlement/economic-disposition-authority'))
    ;({ escrowRepository } = require('../../src/modules/open-settlement/escrow-repository'))
    ;({ loadParticipantPubkeys } = require('../../src/modules/open-settlement/escrow-lifecycle'))
    ;({ multisigProvider } = require('../../src/modules/open-settlement/multisig.provider'))
    const { intentEngine } = require('../../src/core/intent-engine')
    const { OpenP2PTradeIntentHandler } = require('../../src/modules/open-p2p/intent-handler')
    intentEngine.registerHandler(OpenP2PTradeIntentHandler)
    require('../../src/common/events/handlers').registerEventHandlers()
    jest.isolateModules(() => {
      restarted = {
        prisma: require('../../src/common/database').prisma,
        submitTransactionSignature: require('../../src/modules/open-settlement/escrow-pending-tx').submitTransactionSignature,
        redis: require('../../src/common/redis').redis,
      }
    })
    for (const [id, kp] of [[ARBITER_ID, arbiterKp], [ARBITER2_ID, arbiter2Kp]] as const) {
      await prisma.user.upsert({ where: { id }, update: { publicKey: pubHex(kp) }, create: { id, publicKey: pubHex(kp), displayName: `H1 arbiter ${id}` } })
    }
  })

  beforeEach(() => { realFetch = global.fetch; broadcasts.length = 0 })
  afterEach(async () => {
    global.fetch = realFetch
    jest.restoreAllMocks()
    // Shared database: a fixture that removed the arbiter commitment (to make appeal() reachable) gives it back.
    while (removedCommitments.length) await prisma.escrowParticipantKey.create({ data: removedCommitments.pop()! })
  })
  afterAll(async () => {
    if (dbAvailable) {
      await prisma.$disconnect()
      if (restarted) {
        await restarted.prisma.$disconnect()
        await restarted.redis.quit().catch(() => {})
      }
      await closeTestRedis()
    }
  })

  const requirePostgres = (name: string) => pg.requirePostgres(name)

  // ── chain stub: one funding UTXO per escrow; every broadcast is recorded; unknown txids are 404 ───────────────

  function chain(txid: string, opts: { failBroadcast?: boolean } = {}): void {
    global.fetch = jest.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'POST' && url.endsWith('/tx')) {
        if (opts.failBroadcast) return { ok: false, status: 503, text: async () => 'injected broadcast outage', json: async () => ({}) } as any
        const spent = Buffer.from(bitcoin.Transaction.fromHex(String(init.body)).ins[0].hash).reverse().toString('hex')
        if (spent !== txid) return { ok: false, status: 400, text: async () => 'not this test\'s outpoint', json: async () => ({}) } as any
        broadcasts.push(String(init.body)); return { ok: true, text: async () => 'mock-txid' } as any
      }
      if (url.includes('/blocks/tip/height')) return { ok: true, text: async () => '100' } as any
      if (url.includes(`/tx/${txid}/status`)) return { ok: true, json: async () => ({ confirmed: true, block_height: 100 }) } as any
      if (url.includes('/v1/fees/recommended')) return { ok: true, json: async () => ({ halfHourFee: 5, fastestFee: 8 }) } as any
      if (/\/tx\/[0-9a-f]{64}(\/status|\/outspend\/\d+)?$/.test(url)) return { ok: false, status: 404, text: async () => 'not found', json: async () => ({}) } as any
      return { ok: true, json: async () => [{ txid, vout: 0, value: 100_000, status: { confirmed: true } }] } as any
    }) as any
  }

  // ── fixtures ────────────────────────────────────────────────────────────────────────────────────

  interface Opened {
    escrowId: string; tradeId: string; disputeId: string; buyerId: string; sellerId: string; arbiterId: string
    buyerDestination: string; sellerDestination: string; txid: string
  }

  /** A funded MULTISIG escrow with an open dispute and registered destinations: nothing ruled yet. */
  async function openedDispute(label: string): Promise<Opened> {
    requirePostgres(label)
    seq += 1
    const seller = await registerTestParticipant(identityService, 'Seller')
    const buyer = await registerTestParticipant(identityService, 'Buyer')
    const offer = await liquidityRouter.createOffer({
      userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001',
      ...boundOfferInput(await sellerPixAccount(prisma, seller.id)),
    })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    const escrow = await escrowService.createEscrow({ tradeId: trade.id, type: 'MULTISIG', lockedAmount: '0.001', asset: 'BTC' }, seller.id)
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id } })
    await escrowService.submitParticipantKey(escrow.id, buyer.id, pubHex(buyerKey), MULTISIG_CAPABILITY_PROFILE_V1)
    await escrowService.submitParticipantKey(escrow.id, seller.id, pubHex(sellerKey), MULTISIG_CAPABILITY_PROFILE_V1)
    const txid = createHash('sha256').update(`h1-${label}-${Date.now()}-${seq}`).digest('hex')
    chain(txid)
    await escrowService.lockFunds(escrow.id, seller.id)
    const dispute = await getDisputeService().raiseDispute(trade.id, buyer.id, `H1 ${label}`)
    const buyerDestination = destination(`buyer-${label}-${seq}`)
    const sellerDestination = destination(`seller-${label}-${seq}`)
    await payoutAddressService.setPayoutAddress(buyer.id, 'BTC', buyerDestination)
    await payoutAddressService.setPayoutAddress(seller.id, 'BTC', sellerDestination)
    return { escrowId: escrow.id, tradeId: trade.id, disputeId: dispute.id, buyerId: buyer.id, sellerId: seller.id, arbiterId: dispute.arbiterId, buyerDestination, sellerDestination, txid }
  }

  const payloadFor = (o: Opened, round: number, authorityId: string, ruling: 'RELEASE' | 'REFUND' | 'SPLIT', buyerBps: number | null) =>
    ({ disputeId: o.disputeId, escrowId: o.escrowId, appealRound: round, authorityId, outcome: ruling, buyerBps, issuedAt: new Date().toISOString() })

  /** The ruling through the whole production path: commit, real PSBT translation, the round persisted. */
  async function rule(o: Opened, ruling: 'RELEASE' | 'REFUND' | 'SPLIT', buyerBps: number | null = null) {
    chain(o.txid)
    const payload = payloadFor(o, 0, o.arbiterId, ruling, buyerBps)
    await getDisputeService().resolveDispute(o.disputeId, o.arbiterId, ruling, undefined, undefined, buyerBps ?? undefined, signAuthorityDecision(payload, arbiterKp.secretKey), payload.issuedAt)
    return prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: o.escrowId } })
  }

  /** The C4 window: the production Outcome commit ran (RESOLVED, durable record) and nothing else - no round exists. */
  async function commitOnly(o: Opened, ruling: 'RELEASE' | 'REFUND' | 'SPLIT', buyerBps: number | null = null): Promise<void> {
    const payload = payloadFor(o, 0, o.arbiterId, ruling, buyerBps)
    const row = await prisma.dispute.findUniqueOrThrow({ where: { id: o.disputeId } })
    const committed = await commitAuthoritativeDisputeRuling(
      { id: o.disputeId, escrowId: o.escrowId, status: row.status, appealRound: 0 },
      payload, signAuthorityDecision(payload, arbiterKp.secretKey), pubHex(arbiterKp), '100000', 'BTC', o.buyerId, o.sellerId,
    )
    expect(committed.committed).toBe(true)
  }

  /** Every count that would move if a disposition were authorized or executed. */
  async function effects(o: Opened) {
    const escrow = await prisma.escrow.findUniqueOrThrow({ where: { id: o.escrowId } })
    return {
      status: escrow.status,
      txReleaseId: escrow.txReleaseId,
      rounds: await prisma.escrowPendingTransaction.count({ where: { escrowId: o.escrowId } }),
      signatures: await prisma.escrowTransactionSignature.count({ where: { pendingTx: { escrowId: o.escrowId } } }),
      authorizations: await prisma.economicDispositionAuthorization.count({ where: { escrowId: o.escrowId } }),
      transitions: await prisma.escrowEvent.count({ where: { escrowId: o.escrowId } }),
      broadcasts: broadcasts.length,
    }
  }

  const sign = (psbtBase64: string, key: ReturnType<typeof keyOf>) => {
    const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network: NET })
    psbt.signInput(0, key)
    return psbt.toBase64()
  }
  const partialSigPubkeys = (psbtBase64: string): string[] =>
    (bitcoin.Psbt.fromBase64(psbtBase64, { network: NET }).data.inputs[0].partialSig ?? []).map((p) => Buffer.from(p.pubkey).toString('hex'))
  const arbiterCommitmentOf = async (escrowId: string) =>
    (await prisma.escrowParticipantKey.findUniqueOrThrow({ where: { escrowId_role: { escrowId, role: 'arbiter' } } })).pubkey
  const paidTo = () => broadcasts.map((hex) => bitcoin.Transaction.fromHex(hex).outs.map((out) => addrOf(out.script)))

  /**
   * What the beneficiary can do with the PSBT Sails handed them WITHOUT calling Sails: sign locally and try to
   * finalize. Returns the finalized transaction when the PSBT alone suffices, null when it cannot be completed.
   */
  function completeOutOfBand(psbtBase64: string, key: ReturnType<typeof keyOf>): bitcoin.Transaction | null {
    try {
      const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network: NET })
      psbt.signInput(0, key)
      psbt.finalizeAllInputs()
      return psbt.extractTransaction()
    } catch {
      return null
    }
  }

  /** The witness of the broadcast transaction, verified signature by signature against the escrow's own script. */
  async function verifyBroadcastWitness(o: Opened, partyPubkey: string) {
    const tx = bitcoin.Transaction.fromHex(broadcasts[0])
    const witness = tx.ins[0].witness
    expect(witness).toHaveLength(4) // CHECKMULTISIG dummy, two signatures, the witness script
    const witnessScript = Buffer.from(witness[3])
    const scriptKeys = (bitcoin.script.decompile(witnessScript) ?? []).filter((c): c is Uint8Array => typeof c !== 'number').map((c) => Buffer.from(c).toString('hex'))
    const arbiterPubkey = await arbiterCommitmentOf(o.escrowId)
    expect(scriptKeys).toEqual(expect.arrayContaining([arbiterPubkey, partyPubkey]))
    const hash = tx.hashForWitnessV0(0, witnessScript, 100_000n, bitcoin.Transaction.SIGHASH_ALL)
    const signers: string[] = []
    for (const encoded of [witness[1], witness[2]]) {
      const { signature, hashType } = bitcoin.script.signature.decode(Buffer.from(encoded))
      expect(hashType).toBe(bitcoin.Transaction.SIGHASH_ALL)
      const who = [arbiterPubkey, partyPubkey].find((k) => ecc.verify(hash, Buffer.from(k, 'hex'), signature))
      expect(who).toBeDefined()
      signers.push(who!)
    }
    expect(new Set(signers)).toEqual(new Set([arbiterPubkey, partyPubkey]))
    // a segwit txid does not commit to the witness: it is the stored round's own
    return { tx, txid: tx.getId() }
  }

  /** FAULT INJECTION - the shape earlier code persisted: the round carries the arbiter signature already. */
  async function persistLegacyRound(o: Opened, kind: 'release' | 'refund', opts: { ruled: boolean }) {
    const escrow = await escrowRepository.findById(o.escrowId)
    const dispute = await prisma.dispute.findUniqueOrThrow({ where: { id: o.disputeId } })
    const keys = await loadParticipantPubkeys(o.escrowId)
    const record = { ...escrow, buyerId: o.buyerId, sellerId: o.sellerId, ...keys, triggeredBy: o.arbiterId }
    chain(o.txid)
    const built = kind === 'refund' ? await multisigProvider.buildUnsignedRefund(record, o.sellerDestination) : await multisigProvider.buildUnsignedRelease(record, o.buyerDestination)
    const legacy = bitcoin.Psbt.fromBase64(built.psbtBase64, { network: NET })
    legacy.signInput(0, multisigProvider.deriveArbiterKey(o.arbiterId)) // exactly what the removed construction code did
    return prisma.escrowPendingTransaction.create({
      data: {
        escrowId: o.escrowId, kind, toAddress: kind === 'refund' ? o.sellerDestination : o.buyerDestination,
        unsignedPsbtBase64: legacy.toBase64(), requiredSigners: built.requiredSigners, triggeredBy: o.arbiterId,
        minerFeeSats: built.minerFeeSats, signaturesConfidential: true,
        disputeId: dispute.id,
        ...(opts.ruled
          ? { rulingAppealRound: dispute.appealRound, rulingArbiterId: dispute.arbiterId, rulingOutcome: dispute.ruling,
              rulingAuthoritySignature: dispute.authoritySignature, rulingAuthorityIssuedAt: dispute.authorityIssuedAt }
          : {}),
      } as any,
    })
  }

  /** The legacy shape appeal() needs (no script-committed arbiter identity); restored in afterEach. */
  const makeAppealable = (o: Opened) => prisma.$transaction(async (tx) => {
    const c = await tx.escrowParticipantKey.findUnique({ where: { escrowId_role: { escrowId: o.escrowId, role: 'arbiter' } } })
    if (c) removedCommitments.push({ escrowId: c.escrowId, role: c.role, participantId: c.participantId, pubkey: c.pubkey })
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`
    await tx.escrowParticipantKey.deleteMany({ where: { escrowId: o.escrowId, role: 'arbiter' } })
  })
  const appealService = () => new DisputeService({
    name: 'h1-stub', arbitrators: [ARBITER_ID, ARBITER2_ID],
    async assign() { return ARBITER_ID },
    async assignAppealPanel() { return ARBITER2_ID },
  })

  // ── lock barrier ────────────────────────────────────────────────────────────────────────────────

  const waitingOnAdvisoryLocks = async () => (await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)[0].n
  async function untilWaiting(n: number) {
    for (let i = 0; i < 1500; i++) {
      if ((await waitingOnAdvisoryLocks()) === n) return
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error(`expected ${n} advisory-lock waiter(s), saw ${await waitingOnAdvisoryLocks()}`)
  }
  async function holdD(o: Opened) {
    let release!: () => void
    const released = new Promise<void>((r) => { release = r })
    let acquired!: () => void
    const isHeld = new Promise<void>((r) => { acquired = r })
    const done = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${economicDispositionLockKey(o.disputeId)})::bigint)`
      acquired()
      await released
    }, { timeout: 60_000 })
    await isHeld
    return async () => { release(); await done }
  }

  const REFUSED_H1 = /AUD1X-H1: dispute .* has no resolved ruling/
  const REFUSED = /AUD-1|does not correspond to the authoritative Outcome/

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // A - containment: a disputed MULTISIG round exists only for a RESOLVED, signed ruling (F1 / F2 / F3)
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  it('F1 (regression) before any ruling the arbiter session obtains NO round and NO PSBT, for any kind; the honest ruling is then dispatched and executes', async () => {
    const o = await openedDispute('f1')
    const before = await effects(o)

    await expect(escrowService.initiateRefund(o.escrowId, o.arbiterId)).rejects.toThrow(REFUSED_H1)
    await expect(escrowService.initiateRelease(o.escrowId, o.buyerDestination, o.arbiterId)).rejects.toThrow(REFUSED_H1)
    await expect(escrowService.initiateSplit(o.escrowId, o.buyerDestination, o.sellerDestination, 5000, o.arbiterId)).rejects.toThrow(REFUSED_H1)
    expect(await effects(o)).toEqual(before)
    expect(before).toMatchObject({ status: 'DISPUTED', rounds: 0, signatures: 0, authorizations: 0, broadcasts: 0 })

    // The audit's F1 left a pre-ruling round that made the honest ruling fail ("dispatch already occurred"): not any more.
    const round = await rule(o, 'RELEASE')
    expect(round).toMatchObject({ kind: 'release', rulingOutcome: 'RELEASE', disputeId: o.disputeId })
    expect((await prisma.dispute.findUniqueOrThrow({ where: { id: o.disputeId } })).status).toBe('RESOLVED')

    chain(o.txid)
    expect((await submitTransactionSignature(o.escrowId, o.buyerId, sign(round.unsignedPsbtBase64, buyerKey))).complete).toBe(true)
    expect(await effects(o)).toMatchObject({ status: 'COMPLETED', broadcasts: 1, authorizations: 1 })
    expect(paidTo()[0]).toContain(o.buyerDestination)
    expect(paidTo()[0]).not.toContain(o.sellerDestination)
  })

  it('F2 (regression) with a committed RELEASE Outcome (C4 window) a contradicting initiate is refused and no round of any kind coexists with it; C4 then dispatches the ruling', async () => {
    const o = await openedDispute('f2')
    await commitOnly(o, 'RELEASE')
    const before = await effects(o)

    await expect(escrowService.initiateRefund(o.escrowId, o.arbiterId)).rejects.toThrow(REFUSED)
    expect(await effects(o)).toEqual(before)
    expect(before.rounds).toBe(0)

    chain(o.txid)
    let claimed = false
    for (let i = 0; i < 40 && !claimed; i++) claimed = (await reconcileMissingDispatch()).claimed.includes(o.escrowId)
    expect(claimed).toBe(true)
    const round = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: o.escrowId } })
    expect(round).toMatchObject({ kind: 'release', rulingOutcome: 'RELEASE' })
    expect(partialSigPubkeys(round.unsignedPsbtBase64)).toEqual([]) // and the dispatched round carries no signature
  })

  it('F3 (regression) an appeal that lands between the snapshot and the write: the construction re-reads the authority under the dispute lock and persists nothing', async () => {
    const o = await openedDispute('f3')
    await commitOnly(o, 'RELEASE') // RESOLVED/RELEASE, generation 0, no round yet
    chain(o.txid)

    // FAULT-INJECTION POINT (a pause, not a mock of the behaviour): the construction has taken its RESOLVED
    // snapshot and loaded the arbiter commitment; it is held at the provider call, i.e. exactly between the snapshot
    // and the write. The appeal commits generation 1 in that window; the construction then resumes.
    let resume!: () => void
    const paused = new Promise<void>((r) => { resume = r })
    let reachedBuild!: () => void
    const atBuild = new Promise<void>((r) => { reachedBuild = r })
    const realBuild = multisigProvider.buildUnsignedRelease.bind(multisigProvider)
    jest.spyOn(multisigProvider, 'buildUnsignedRelease').mockImplementationOnce(async (...args: unknown[]) => {
      reachedBuild()
      await paused
      return realBuild(...args)
    })
    const construct = escrowService.initiateRelease(o.escrowId, o.buyerDestination, o.arbiterId).then((v: any) => v, (e: Error) => e)
    await atBuild
    await makeAppealable(o)
    await appealService().appeal(o.disputeId, o.buyerId)
    expect((await prisma.dispute.findUniqueOrThrow({ where: { id: o.disputeId } })).appealRound).toBe(1)
    resume()

    const outcome = await construct
    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toMatch(/AUD-1 \(H1\): the ruling authority of dispute .* is not what this release round was built for/)
    expect(await effects(o)).toMatchObject({ status: 'DISPUTED', rounds: 0, signatures: 0, authorizations: 0, broadcasts: 0 })
  })

  it('F3b the construction first, the appeal second (queued behind the dispute lock): the round is persisted for generation 0 and the appeal then supersedes it, the gate refusing it', async () => {
    const o = await openedDispute('f3b')
    await commitOnly(o, 'RELEASE')
    chain(o.txid)

    // the construction has read the arbiter commitment and built its PSBT before it queues on the dispute lock;
    // only then is the commitment removed (appeal()'s own precondition) and the appeal queued behind it.
    const release = await holdD(o)
    const construct = escrowService.initiateRelease(o.escrowId, o.buyerDestination, o.arbiterId)
    await untilWaiting(1)
    await makeAppealable(o)
    const appeal = appealService().appeal(o.disputeId, o.buyerId)
    await untilWaiting(2)
    await release()

    const round: any = await construct
    await appeal
    expect(round.rulingAppealRound).toBe(0)
    await expect(submitTransactionSignature(o.escrowId, o.buyerId, sign(round.unsignedPsbtBase64, buyerKey))).rejects.toThrow(/no longer current/)
    expect(await effects(o)).toMatchObject({ status: 'DISPUTED', broadcasts: 0, authorizations: 0 })
  })

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // B - the platform arbiter signature exists only at execution
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  it('B1 the round the ruling produces carries no signature: the beneficiary\'s own key is 1 of 2 and cannot complete it outside Sails', async () => {
    const o = await openedDispute('b1')
    const round = await rule(o, 'RELEASE')

    expect(partialSigPubkeys(round.unsignedPsbtBase64)).toEqual([])
    expect(round.requiredSigners).toEqual([o.buyerId])
    expect(completeOutOfBand(round.unsignedPsbtBase64, buyerKey)).toBeNull() // the F1 bearer transaction: gone
    expect(completeOutOfBand(round.unsignedPsbtBase64, sellerKey)).toBeNull()
  })

  it('B2 every way the round can be read - pending lookup for each role, the initiate return, the participant\'s stored copy - discloses no arbiter signature', async () => {
    const o = await openedDispute('b2')
    await commitOnly(o, 'RELEASE')
    chain(o.txid)
    // the initiate return value (the C4-style direct call the arbiter session can make once the ruling exists)
    const initiated = await escrowService.initiateRelease(o.escrowId, o.buyerDestination, o.arbiterId)
    expect(partialSigPubkeys(initiated.unsignedPsbtBase64)).toEqual([])

    await prisma.escrowTransactionSignature.create({ data: { pendingTxId: initiated.id, participantId: o.buyerId, signedPsbtBase64: sign(initiated.unsignedPsbtBase64, buyerKey) } })
    for (const viewer of [o.buyerId, o.sellerId, o.arbiterId]) {
      const view = await getPendingTransaction(o.escrowId, viewer)
      expect(partialSigPubkeys(view.unsignedPsbtBase64)).toEqual([])
      for (const s of view.signatures) {
        if (s.signedPsbtBase64) expect(partialSigPubkeys(s.signedPsbtBase64)).toEqual([pubHex(buyerKey)]) // only the buyer's own
      }
    }
    // the stored copy and the stored round: the buyer's copy alone still cannot be completed
    const stored = await prisma.escrowTransactionSignature.findFirstOrThrow({ where: { pendingTxId: initiated.id } })
    expect(completeOutOfBand(stored.signedPsbtBase64, buyerKey)).toBeNull() // the beneficiary alone: still 1 of 2
    expect(bitcoin.Psbt.fromBase64(stored.signedPsbtBase64, { network: NET }).data.inputs[0].partialSig).toHaveLength(1)
  })

  it.each([
    ['RELEASE', null, 'buyer'],
    ['REFUND', null, 'seller'],
    ['SPLIT', 3000, 'buyer'],
  ] as const)('B3 %s executes exactly as before: platform signature added at execution, valid 2-of-3 witness, identical to the pre-embedded transaction', async (ruling, bps, signerRole) => {
    const o = await openedDispute(`b3-${ruling.toLowerCase()}`)
    const round = await rule(o, ruling, bps)
    expect(partialSigPubkeys(round.unsignedPsbtBase64)).toEqual([])
    const signerKey = signerRole === 'buyer' ? buyerKey : sellerKey
    const signerId = signerRole === 'buyer' ? o.buyerId : o.sellerId
    const partyCopy = sign(round.unsignedPsbtBase64, signerKey)
    chain(o.txid)

    const done = await submitTransactionSignature(o.escrowId, signerId, partyCopy)

    expect(done.complete).toBe(true)
    const after = await effects(o)
    expect(after).toMatchObject({
      status: ruling === 'RELEASE' ? 'COMPLETED' : ruling === 'REFUND' ? 'REFUNDED' : 'SPLIT',
      broadcasts: 1, authorizations: 1,
    })
    const { txid } = await verifyBroadcastWitness(o, pubHex(signerKey))
    expect(after.txReleaseId).toBe(txid)
    if (ruling === 'RELEASE') expect(paidTo()[0]).toEqual([o.buyerDestination])
    if (ruling === 'REFUND') expect(paidTo()[0]).toEqual([o.sellerDestination])
    if (ruling === 'SPLIT') expect(paidTo()[0].sort()).toEqual([o.buyerDestination, o.sellerDestination].sort())

    // the signature protocol is unchanged: what the removed code would have broadcast, byte for byte
    const legacy = bitcoin.Psbt.fromBase64(round.unsignedPsbtBase64, { network: NET })
    legacy.signInput(0, multisigProvider.deriveArbiterKey(o.arbiterId))
    legacy.combine(bitcoin.Psbt.fromBase64(partyCopy, { network: NET }))
    legacy.finalizeAllInputs()
    expect(broadcasts[0]).toBe(legacy.extractTransaction().toHex())
    expect(txid).toBe(bitcoin.Transaction.fromBuffer(Buffer.from(bitcoin.Psbt.fromBase64(round.unsignedPsbtBase64, { network: NET }).data.globalMap.unsignedTx.toBuffer())).getId())
  })

  it('B4 a superseded generation executes nothing and the arbiter key is never used: no signature is produced for a stale round', async () => {
    const o = await openedDispute('b4')
    const round = await rule(o, 'RELEASE')
    const buyerCopy = sign(round.unsignedPsbtBase64, buyerKey)
    await makeAppealable(o)
    await appealService().appeal(o.disputeId, o.buyerId)
    chain(o.txid)
    const before = await effects(o)
    const signInput = jest.spyOn(bitcoin.Psbt.prototype, 'signInput')
    const derive = jest.spyOn(multisigProvider, 'deriveArbiterKey')

    await expect(submitTransactionSignature(o.escrowId, o.buyerId, buyerCopy)).rejects.toThrow(/no longer current/)

    expect(signInput).not.toHaveBeenCalled()
    expect(derive).not.toHaveBeenCalled()
    const after = await effects(o)
    expect(after).toMatchObject({ status: 'DISPUTED', broadcasts: 0, authorizations: 0, txReleaseId: null })
    expect(after.signatures).toBe(before.signatures + 1) // the buyer's own copy, retained; nothing else
    const stored = await prisma.escrowTransactionSignature.findFirstOrThrow({ where: { pendingTx: { escrowId: o.escrowId } } })
    expect(partialSigPubkeys(stored.signedPsbtBase64)).toEqual([pubHex(buyerKey)])
  })

  it('B5 a signing failure after the authorization: the claim is reverted, nothing is broadcast, the round and the buyer\'s signature are kept, and the retry executes exactly once', async () => {
    const o = await openedDispute('b5')
    const round = await rule(o, 'RELEASE')
    const buyerCopy = sign(round.unsignedPsbtBase64, buyerKey)
    chain(o.txid)
    jest.spyOn(multisigProvider, 'deriveArbiterKey').mockImplementationOnce(() => { throw new Error('arbiter key unavailable (injected)') })

    await expect(submitTransactionSignature(o.escrowId, o.buyerId, buyerCopy)).rejects.toThrow(/arbiter key unavailable/)

    expect(await effects(o)).toMatchObject({ status: 'DISPUTED', txReleaseId: null, broadcasts: 0, rounds: 1, signatures: 1, authorizations: 1 })

    const done = await submitTransactionSignature(o.escrowId, o.buyerId, buyerCopy)
    expect(done.complete).toBe(true)
    expect(await effects(o)).toMatchObject({ status: 'COMPLETED', broadcasts: 1, authorizations: 1 })
    await verifyBroadcastWitness(o, pubHex(buyerKey))
  })

  it('B5b a signed ruling cannot execute with a drifted arbiter key; the persisted round remains unsigned by the platform', async () => {
    const o = await openedDispute('b5b-key-drift')
    const round = await rule(o, 'RELEASE')
    const buyerCopy = sign(round.unsignedPsbtBase64, buyerKey)
    chain(o.txid)
    const committed = await prisma.dispute.findUniqueOrThrow({ where: { id: o.disputeId } })
    expect(committed.status).toBe('RESOLVED')
    expect(committed.authoritySignature).toBeTruthy()

    const realDerive = multisigProvider.deriveArbiterKey.bind(multisigProvider)
    jest.spyOn(multisigProvider, 'deriveArbiterKey').mockImplementationOnce(() => realDerive(ARBITER2_ID))
    await expect(submitTransactionSignature(o.escrowId, o.buyerId, buyerCopy))
      .rejects.toThrow(/does not derive the arbiter public key committed/)
    expect(await effects(o)).toMatchObject({ status: 'DISPUTED', txReleaseId: null, rounds: 1, signatures: 1, broadcasts: 0 })
    const retained = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { id: round.id } })
    expect(partialSigPubkeys(retained.unsignedPsbtBase64)).toEqual([])
    expect((await prisma.dispute.findUniqueOrThrow({ where: { id: o.disputeId } })).authoritySignature).toBe(committed.authoritySignature)
  })

  it('B6 restart: an independent module graph (its own client, no memory of the first) finalizes the round persisted by the first - the platform signature derives from configuration alone', async () => {
    const o = await openedDispute('b6')
    const round = await rule(o, 'RELEASE')
    const buyerCopy = sign(round.unsignedPsbtBase64, buyerKey)
    chain(o.txid)

    const done = await restarted!.submitTransactionSignature(o.escrowId, o.buyerId, buyerCopy)

    expect(done.complete).toBe(true)
    expect(await effects(o)).toMatchObject({ status: 'COMPLETED', broadcasts: 1, authorizations: 1 })
    await verifyBroadcastWitness(o, pubHex(buyerKey))
  })

  it('B7 concurrent workers: two simultaneous final signatures and the C8 recovery together broadcast once and commit one authorization; replay changes nothing', async () => {
    const o = await openedDispute('b7')
    const round = await rule(o, 'RELEASE')
    const buyerCopy = sign(round.unsignedPsbtBase64, buyerKey)
    chain(o.txid)

    const report: any = { recovered: [], completionEffectsRecovered: [], requiresManualReview: [], failed: [], resumedUnclaimed: [], alreadyClaimedConcurrently: [], projectionsRecovered: [], completionVerified: [], locksAdvanced: [], }
    const results = await Promise.all([
      submitTransactionSignature(o.escrowId, o.buyerId, buyerCopy).then((v: any) => v, (e: Error) => e),
      submitTransactionSignature(o.escrowId, o.buyerId, buyerCopy).then((v: any) => v, (e: Error) => e),
      reconcileUnclaimedFullySignedPending(report).then(() => null, (e: Error) => e),
    ])

    for (const r of results) {
      if (r instanceof Error) expect(r.message).not.toMatch(/deadlock detected|40P01/)
    }
    const after = await effects(o)
    expect(after.broadcasts).toBeLessThanOrEqual(1)
    expect(after.authorizations).toBeLessThanOrEqual(1)
    // whichever worker won, a replay finishes the same single execution
    await submitTransactionSignature(o.escrowId, o.buyerId, buyerCopy).catch(() => undefined)
    expect(await effects(o)).toMatchObject({ status: 'COMPLETED', broadcasts: 1, authorizations: 1 })
    expect(paidTo()).toHaveLength(1)
  })

  it('B8 C8: a fully signed, unclaimed new-style round executes only through the gate (one broadcast, platform signature added after it); once its generation is superseded nothing is signed or sent', async () => {
    const live = await openedDispute('b8-live')
    const liveRound = await rule(live, 'RELEASE')
    await prisma.escrowTransactionSignature.create({ data: { pendingTxId: liveRound.id, participantId: live.buyerId, signedPsbtBase64: sign(liveRound.unsignedPsbtBase64, buyerKey) } })
    chain(live.txid)
    const report = (): any => ({ recovered: [], completionEffectsRecovered: [], requiresManualReview: [], failed: [], resumedUnclaimed: [], alreadyClaimedConcurrently: [], projectionsRecovered: [], completionVerified: [], locksAdvanced: [] })
    const runUntilAttempted = async (roundId: string) => {
      // PASS 0 is globally bounded. Preserve reports across laps: an unrelated
      // candidate may be visited first, and the target may be recovered in an
      // earlier lap than the one that observes its attemptedAt marker.
      const aggregate = report()
      for (let i = 0; i < 80; i++) {
        const lap = report()
        await reconcileUnclaimedFullySignedPending(lap)
        for (const key of ['recovered', 'completionEffectsRecovered', 'requiresManualReview', 'failed', 'resumedUnclaimed', 'alreadyClaimedConcurrently', 'projectionsRecovered', 'completionVerified', 'locksAdvanced']) {
          aggregate[key].push(...lap[key])
        }
        const row = await prisma.escrowPendingTransaction.findUnique({ where: { id: roundId }, select: { unclaimedRecoveryAttemptedAt: true } })
        if (!row || row.unclaimedRecoveryAttemptedAt) break
      }
      return aggregate
    }
    const mine = (o: Opened, rows: any[]) => rows.filter((x: any) => x.escrowId === o.escrowId)

    const r1 = await runUntilAttempted(liveRound.id)
    const liveRecovery = { resumed: mine(live, r1.resumedUnclaimed), failed: mine(live, r1.failed), manual: mine(live, r1.requiresManualReview), concurrent: mine(live, r1.alreadyClaimedConcurrently), recovered: mine(live, r1.recovered), effects: await effects(live), pending: await prisma.escrowPendingTransaction.findUnique({ where: { id: liveRound.id }, select: { unclaimedRecoveryAttemptedAt: true, id: true } }) }
    if (liveRecovery.resumed.length !== 1) {
      // A persisted attemptedAt marker without a recovery report is NOT a
      // successful recovery. Surface all pass-zero classifications and the
      // durable signature state so a rare CI failure remains actionable.
      const signatureRows = await prisma.escrowTransactionSignature.findMany({
        where: { pendingTxId: liveRound.id },
        select: { participantId: true },
      })
      const durableRound = await prisma.escrowPendingTransaction.findUnique({
        where: { id: liveRound.id },
        select: { requiredSigners: true, unclaimedRecoveryAttemptedAt: true, kind: true },
      })
      throw new Error(`B8 C8 recovery evidence: ${JSON.stringify({ ...liveRecovery, durableRound, signedParticipantIds: signatureRows.map(s => s.participantId), passZeroReport: r1 })}`)
    }
    expect(liveRecovery.resumed).toEqual([expect.objectContaining({ escrowId: live.escrowId })])
    expect(await effects(live)).toMatchObject({ status: 'COMPLETED', broadcasts: 1, authorizations: 1 })
    await verifyBroadcastWitness(live, pubHex(buyerKey))

    // a second escrow whose generation was superseded before the recovery ran
    broadcasts.length = 0
    const stale = await openedDispute('b8-stale')
    const staleRound = await rule(stale, 'RELEASE')
    await prisma.escrowTransactionSignature.create({ data: { pendingTxId: staleRound.id, participantId: stale.buyerId, signedPsbtBase64: sign(staleRound.unsignedPsbtBase64, buyerKey) } })
    await makeAppealable(stale)
    await appealService().appeal(stale.disputeId, stale.buyerId)
    while (removedCommitments.length) await prisma.escrowParticipantKey.create({ data: removedCommitments.pop()! }) // appeal() needed it absent; the recovery needs the escrow's script
    chain(stale.txid)
    const signInput = jest.spyOn(bitcoin.Psbt.prototype, 'signInput')

    const r2 = await runUntilAttempted(staleRound.id)

    expect(mine(stale, r2.resumedUnclaimed)).toEqual([])
    expect(JSON.stringify(mine(stale, r2.failed))).toMatch(/no longer current/)
    expect(signInput).not.toHaveBeenCalled()
    expect(await effects(stale)).toMatchObject({ status: 'DISPUTED', broadcasts: 0, authorizations: 0 })
  })

  it('B9 legacy: a disputed round persisted BEFORE this change (arbiter signature embedded) still executes through the same gates, unchanged and not re-signed', async () => {
    const o = await openedDispute('b9')
    await commitOnly(o, 'RELEASE')
    const legacy = await persistLegacyRound(o, 'release', { ruled: true })
    expect(partialSigPubkeys(legacy.unsignedPsbtBase64)).toEqual([await arbiterCommitmentOf(o.escrowId)])
    const buyerCopy = sign(legacy.unsignedPsbtBase64, buyerKey)
    chain(o.txid)

    const done = await submitTransactionSignature(o.escrowId, o.buyerId, buyerCopy)

    expect(done.complete).toBe(true)
    expect(await effects(o)).toMatchObject({ status: 'COMPLETED', broadcasts: 1, authorizations: 1 })
    expect(paidTo()[0]).toEqual([o.buyerDestination])
    await verifyBroadcastWitness(o, pubHex(buyerKey))
  })

  it('B10 legacy: an authorization committed by earlier code for an embedded round is reused (ADR-005 s4) - and the binding still judges it', async () => {
    const o = await openedDispute('b10')
    await commitOnly(o, 'RELEASE')
    const legacy = await persistLegacyRound(o, 'release', { ruled: true })
    const { authorizeDisputedPendingExecution } = require('../../src/modules/open-settlement/economic-disposition-authority')
    const first = await authorizeDisputedPendingExecution(legacy)
    expect(first).toMatchObject({ pendingOperationId: legacy.id, ruling: 'RELEASE' })
    chain(o.txid)

    const done = await submitTransactionSignature(o.escrowId, o.buyerId, sign(legacy.unsignedPsbtBase64, buyerKey))

    expect(done.complete).toBe(true)
    expect(await prisma.economicDispositionAuthorization.count({ where: { escrowId: o.escrowId } })).toBe(1)
    expect(await effects(o)).toMatchObject({ status: 'COMPLETED', broadcasts: 1 })
  })

  /** PASS 1 (and every pass after it) until this escrow has been visited; what was reported about it is returned. */
  async function runPass1Until(o: Opened) {
    const manualReview: any[] = []
    const failed: any[] = []
    for (let i = 0; i < 80; i++) {
      const report = await reconcilePendingSettlements({ projectionGraceMs: 50 * 365 * 24 * 3600 * 1000 })
      manualReview.push(...(report.requiresManualReview ?? []).filter((r: any) => r.escrowId === o.escrowId))
      failed.push(...(report.failed ?? []).filter((r: any) => r.escrowId === o.escrowId))
      const row = await prisma.escrow.findUniqueOrThrow({ where: { id: o.escrowId }, select: { settlementRecoveryAttemptedAt: true } })
      if (row.settlementRecoveryAttemptedAt) break
    }
    return { manualReview, failed }
  }

  it('B11 PASS 1: a terminal escrow whose broadcast never happened is completed from its round, under the authorization the gate had committed for it', async () => {
    const o = await openedDispute('b11')
    const round = await rule(o, 'RELEASE')
    await prisma.escrowTransactionSignature.create({ data: { pendingTxId: round.id, participantId: o.buyerId, signedPsbtBase64: sign(round.unsignedPsbtBase64, buyerKey) } })
    await authorizeDisputedPendingExecution(round) // what the live path commits immediately before its claim
    // FAULT INJECTION: the live path claimed the transition and crashed before the broadcast and before the result was written
    await prisma.escrow.update({ where: { id: o.escrowId }, data: { status: 'COMPLETED' } })
    chain(o.txid)

    await runPass1Until(o)

    expect(broadcasts).toHaveLength(1)
    const { txid } = await verifyBroadcastWitness(o, pubHex(buyerKey))
    expect((await prisma.escrow.findUniqueOrThrow({ where: { id: o.escrowId } })).txReleaseId).toBe(txid)
    expect(paidTo()[0]).toEqual([o.buyerDestination])
  })

  it('B13 a cooperative (non-disputed) round is untouched: both parties sign, it executes, and the arbiter key is never derived or used', async () => {
    requirePostgres('b13')
    seq += 1
    const seller = await registerTestParticipant(identityService, 'Seller')
    const buyer = await registerTestParticipant(identityService, 'Buyer')
    const offer = await liquidityRouter.createOffer({
      userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001',
      ...boundOfferInput(await sellerPixAccount(prisma, seller.id)),
    })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    const escrow = await escrowService.createEscrow({ tradeId: trade.id, type: 'MULTISIG', lockedAmount: '0.001', asset: 'BTC' }, seller.id)
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id } })
    await escrowService.submitParticipantKey(escrow.id, buyer.id, pubHex(buyerKey), MULTISIG_CAPABILITY_PROFILE_V1)
    await escrowService.submitParticipantKey(escrow.id, seller.id, pubHex(sellerKey), MULTISIG_CAPABILITY_PROFILE_V1)
    const txid = createHash('sha256').update(`h1-coop-${Date.now()}-${seq}`).digest('hex')
    chain(txid)
    await escrowService.lockFunds(escrow.id, seller.id)
    const buyerDestination = destination(`coop-buyer-${seq}`)
    await payoutAddressService.setPayoutAddress(buyer.id, 'BTC', buyerDestination)
    await prisma.escrow.update({ where: { id: escrow.id }, data: { status: 'PAYMENT_PENDING' } })
    const o: Opened = { escrowId: escrow.id, tradeId: trade.id, disputeId: '', buyerId: buyer.id, sellerId: seller.id, arbiterId: '', buyerDestination, sellerDestination: '', txid }

    const round = await escrowService.initiateRelease(escrow.id, undefined, seller.id)
    expect(round.disputeId).toBeNull()
    expect(round.requiredSigners.sort()).toEqual([buyer.id, seller.id].sort())
    expect(partialSigPubkeys(round.unsignedPsbtBase64)).toEqual([])
    const buyerCopy = sign(round.unsignedPsbtBase64, buyerKey)
    const sellerCopy = sign(round.unsignedPsbtBase64, sellerKey)
    const signInput = jest.spyOn(bitcoin.Psbt.prototype, 'signInput')
    const derive = jest.spyOn(multisigProvider, 'deriveArbiterKey')

    await submitTransactionSignature(escrow.id, buyer.id, buyerCopy)
    const done = await submitTransactionSignature(escrow.id, seller.id, sellerCopy)

    expect(done.complete).toBe(true)
    expect(derive).not.toHaveBeenCalled()
    expect(signInput).not.toHaveBeenCalled() // the test's own signatures were made before the spies
    expect(await effects(o)).toMatchObject({ status: 'COMPLETED', broadcasts: 1, authorizations: 0 })
    expect(paidTo()[0]).toEqual([buyerDestination])
  })

  it('B12 PASS 1: the same terminal escrow with NO committed authorization is never completed: the platform signature is not produced, nothing is broadcast, it is surfaced for manual review', async () => {
    const o = await openedDispute('b12')
    const round = await rule(o, 'RELEASE')
    await prisma.escrowTransactionSignature.create({ data: { pendingTxId: round.id, participantId: o.buyerId, signedPsbtBase64: sign(round.unsignedPsbtBase64, buyerKey) } })
    await prisma.escrow.update({ where: { id: o.escrowId }, data: { status: 'COMPLETED' } }) // FAULT INJECTION as B11, without any gate pass
    chain(o.txid)
    const signInput = jest.spyOn(bitcoin.Psbt.prototype, 'signInput')

    const seen = await runPass1Until(o)

    expect(signInput).not.toHaveBeenCalled()
    expect(broadcasts).toHaveLength(0)
    expect((await prisma.escrow.findUniqueOrThrow({ where: { id: o.escrowId } })).txReleaseId).toBeNull()
    expect(JSON.stringify(seen.manualReview)).toMatch(/no execution authorization supplied the arbiter signature/)
    expect(await prisma.economicDispositionAuthorization.count({ where: { escrowId: o.escrowId } })).toBe(0) // recovery never mints one
  })

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // Lock order: construction takes D then E - the order of every other holder of both - no cycle
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  it('K1 construction, the ST-1 cleanup, the signature path and the C4/C8 recoveries running together never deadlock', async () => {
    const o = await openedDispute('k1')
    const round = await rule(o, 'RELEASE')
    chain(o.txid)
    const buyerCopy = sign(round.unsignedPsbtBase64, buyerKey)
    const generation = {
      disputeId: round.disputeId, rulingAppealRound: round.rulingAppealRound, rulingArbiterId: round.rulingArbiterId,
      rulingOutcome: round.rulingOutcome, rulingAuthoritySignature: round.rulingAuthoritySignature, rulingAuthorityIssuedAt: round.rulingAuthorityIssuedAt,
    }
    const report: any = { recovered: [], completionEffectsRecovered: [], requiresManualReview: [], failed: [], resumedUnclaimed: [], alreadyClaimedConcurrently: [], projectionsRecovered: [], completionVerified: [], locksAdvanced: [] }

    const settled = await Promise.allSettled([
      ...Array.from({ length: 4 }, () => escrowService.initiateRelease(o.escrowId, o.buyerDestination, o.arbiterId)),
      ...Array.from({ length: 4 }, () => deletePendingRoundIfStillUnsigned(round.id, o.escrowId, generation)),
      submitTransactionSignature(o.escrowId, o.buyerId, buyerCopy),
      reconcileMissingDispatch(),
      reconcileUnclaimedFullySignedPending(report),
    ])

    for (const r of settled) {
      if (r.status === 'rejected') expect(String(r.reason?.message ?? r.reason)).not.toMatch(/deadlock detected|40P01/)
    }
    const after = await effects(o)
    expect(after.broadcasts).toBeLessThanOrEqual(1)
  })

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // Legacy exposure inventory (read-only plan Q1-Q8) - validated on the shapes earlier code persisted
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  it('I1 the read-only inventory finds a pre-ruling round that embeds the arbiter signature, and does not flag a round built by this code', async () => {
    const legacyDispute = await openedDispute('i1-legacy')
    const legacyRound = await persistLegacyRound(legacyDispute, 'refund', { ruled: false }) // F1's row: no ruling, signature embedded
    const modern = await openedDispute('i1-modern')
    const modernRound = await rule(modern, 'RELEASE')

    const sqlText = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'aud1x-h1-legacy-inventory.sql'), 'utf8')
    const statements = sqlText.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(';').map((s) => s.trim())
      .filter((s) => s && !/^(BEGIN|ROLLBACK)/i.test(s))
    expect(statements).toHaveLength(8)
    expect(sqlText).toMatch(/BEGIN TRANSACTION READ ONLY/)
    expect(sqlText.replace(/--.*$/gm, '')).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT)\b/i)

    const found: Record<string, any[]> = {}
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY')
      for (const statement of statements) {
        const rows = await tx.$queryRawUnsafe<any[]>(statement)
        const label = String((statement.match(/'(Q\d_[a-z_]+)'/) ?? [])[1])
        found[label] = rows
      }
    })
    // the plan's transaction really is read-only: a write inside such a transaction is refused by the database
    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY')
      await tx.$executeRawUnsafe(`UPDATE escrow_pending_transactions SET kind = kind WHERE id = '${legacyRound.id}'`)
    })).rejects.toThrow(/read-only/i)

    const idsOf = (label: string, key: string) => (found[label] ?? []).map((r) => r[key])
    expect(idsOf('Q1_pre_ruling_disputed_round', 'round_id')).toContain(legacyRound.id)
    expect(idsOf('Q6_round_embeds_arbiter_signature', 'round_id')).toContain(legacyRound.id)
    expect(idsOf('Q1_pre_ruling_disputed_round', 'round_id')).not.toContain(modernRound.id)
    expect(idsOf('Q6_round_embeds_arbiter_signature', 'round_id')).not.toContain(modernRound.id)
  })
})
