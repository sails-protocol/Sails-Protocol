// AUD1X-R2 - dispatch authority and recovery, on real PostgreSQL and the production services.
//
// The independent adversarial review of AUD1X-H1 found three defects around one race: the live resolve flow, the C4
// dispatch recovery and the assigned arbiter's own initiate-* can all build the signing round of one committed ruling.
//   AR-01  the live flow took "someone else already built it" for ITS failure and reverted the signed ruling (and
//          deleted its Outcome), stranding the other executor's round;
//   AR-03  the same revert could erase the record of an execution whose authorization (even claim/broadcast) was
//          already committed;
//   AR-04  a round could be persisted on an escrow that had meanwhile become terminal (a second authorization followed).
// Every scenario below is a deterministic barrier (a paused call, never a sleep) around the REAL production code: the
// dispute resolve flow, C4 (reconcileMissingDispatch), initiate-*, the ADR-005/ADR-004 gates, the claim, the provider's
// real PSBT construction/finalization, the ST-1 cleanup. What is not real: the chain (an explorer stub that records
// every broadcast) and each fault injection, named where used (a pause, an injected throw, or a legacy-shaped row).
import { PrismaClient } from '@prisma/client'
import * as bitcoin from 'bitcoinjs-lib'
import * as ecc from '@bitcoinerlab/secp256k1'
import { createHash } from 'crypto'
import nacl from 'tweetnacl'
import { ECPairFactory } from 'ecpair'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { registerTestParticipant, closeTestRedis } from './identityTestHelpers'
import { MULTISIG_CAPABILITY_PROFILE_V1 } from '@satsails/p2p-schemas'
import { boundOfferInput, sellerPixAccount } from './economicFixtures'

bitcoin.initEccLib(ecc)
const ECPair = ECPairFactory(ecc)
const NET = bitcoin.networks.testnet
const keyOf = (label: string) => ECPair.fromPrivateKey(createHash('sha256').update(`r2-${label}`).digest())
const pubHex = (k: { publicKey: Uint8Array }) => Buffer.from(k.publicKey).toString('hex')
const destination = (label: string) => bitcoin.payments.p2wpkh({ pubkey: Buffer.from(keyOf(label).publicKey), network: NET }).address!
const addrOf = (script: Uint8Array) => { try { return bitcoin.address.fromOutputScript(script, NET) } catch { return 'non-standard' } }

type Ruling = 'RELEASE' | 'REFUND' | 'SPLIT'

describe('AUD1X-R2 dispatch authority and recovery - real PostgreSQL', () => {
  jest.setTimeout(300_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let escrowService: any, identityService: any, liquidityRouter: any, tradeService: any, payoutAddressService: any
  let getDisputeService: () => any
  let signAuthorityDecision: (payload: unknown, secretKey: Uint8Array) => string
  let commitAuthoritativeDisputeRuling: (...args: any[]) => Promise<{ committed: boolean }>
  let loadDisputeRulingRecord: (escrowId: string, round: number) => Promise<any>
  let submitTransactionSignature: (escrowId: string, participantId: string, signedPsbtBase64: string) => Promise<any>
  let reconcileMissingDispatch: () => Promise<any>
  let reconcilePendingSettlements: (options?: { projectionGraceMs?: number }) => Promise<any>
  let economicDispositionOperationDigest: (pending: any) => string
  let economicDispositionLockKey: (disputeId: string) => string
  let deletePendingRoundIfStillUnsigned: (pendingId: string, escrowId: string, generation: any) => Promise<string>
  let authorizeDisputedPendingExecution: (pending: any) => Promise<any>
  let loadParticipantPubkeys: (escrowId: string) => Promise<any>
  let escrowRepository: any
  let multisigProvider: any
  let dispatchModule: any
  let restarted: { prisma: PrismaClient; submitTransactionSignature: typeof submitTransactionSignature; initiateRelease: (...a: any[]) => Promise<any>; redis: { quit(): Promise<unknown> } } | undefined

  const ARBITER_ID = 'r2-arbiter-1'
  const ARBITER2_ID = 'r2-arbiter-2'
  const arbiterKp = nacl.sign.keyPair()
  const arbiter2Kp = nacl.sign.keyPair()
  const buyerKey = keyOf('buyer')
  const sellerKey = keyOf('seller')
  let realFetch: typeof fetch
  const broadcasts: string[] = []
  let seq = 0

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'false'
    process.env.MULTISIG_SEED = process.env.MULTISIG_SEED || 'r2-seed'
    process.env.TRUSTED_ARBITRATORS = `${ARBITER_ID},${ARBITER2_ID}`
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ escrowService } = require('../../src/modules/open-settlement/escrow.service'))
    ;({ identityService } = require('../../src/modules/open-identity/identity.service'))
    ;({ liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service'))
    ;({ tradeService } = require('../../src/modules/open-p2p/trade.service'))
    ;({ getDisputeService } = require('../../src/modules/open-settlement/dispute.service'))
    ;({ payoutAddressService } = require('../../src/modules/open-settlement/payout-address.service'))
    ;({ signAuthorityDecision } = require('../../src/modules/open-settlement/arbitration-authority'))
    ;({ commitAuthoritativeDisputeRuling, loadDisputeRulingRecord } = require('../../src/modules/open-settlement/dispute-outcome'))
    ;({ submitTransactionSignature } = require('../../src/modules/open-settlement/escrow-pending-tx'))
    ;({ reconcileMissingDispatch } = require('../../src/modules/open-settlement/dispute-dispatch-recovery'))
    ;({ authorizeDisputedPendingExecution, economicDispositionOperationDigest, economicDispositionLockKey } = require('../../src/modules/open-settlement/economic-disposition-authority'))
    ;({ deletePendingRoundIfStillUnsigned } = require('../../src/modules/open-settlement/dispute-pending-reconciliation'))
    ;({ reconcilePendingSettlements } = require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service'))
    ;({ loadParticipantPubkeys } = require('../../src/modules/open-settlement/escrow-lifecycle'))
    ;({ escrowRepository } = require('../../src/modules/open-settlement/escrow-repository'))
    ;({ multisigProvider } = require('../../src/modules/open-settlement/multisig.provider'))
    dispatchModule = require('../../src/modules/open-settlement/dispute-dispatch')
    const { intentEngine } = require('../../src/core/intent-engine')
    const { OpenP2PTradeIntentHandler } = require('../../src/modules/open-p2p/intent-handler')
    intentEngine.registerHandler(OpenP2PTradeIntentHandler)
    require('../../src/common/events/handlers').registerEventHandlers()
    jest.isolateModules(() => {
      const pendingTx = require('../../src/modules/open-settlement/escrow-pending-tx')
      restarted = {
        prisma: require('../../src/common/database').prisma,
        submitTransactionSignature: pendingTx.submitTransactionSignature,
        initiateRelease: pendingTx.initiateRelease,
        redis: require('../../src/common/redis').redis,
      }
    })
    for (const [id, kp] of [[ARBITER_ID, arbiterKp], [ARBITER2_ID, arbiter2Kp]] as const) {
      await prisma.user.upsert({ where: { id }, update: { publicKey: pubHex(kp) }, create: { id, publicKey: pubHex(kp), displayName: `R2 arbiter ${id}` } })
    }
  })
  beforeEach(() => { realFetch = global.fetch; broadcasts.length = 0 })
  afterEach(() => { global.fetch = realFetch; jest.restoreAllMocks() })
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

  // ── chain stub: one funding UTXO per escrow; every broadcast recorded; unknown txids are 404 ──────────────────
  function chain(txid: string): void {
    global.fetch = jest.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'POST' && url.endsWith('/tx')) {
        const spent = Buffer.from(bitcoin.Transaction.fromHex(String(init.body)).ins[0].hash).reverse().toString('hex')
        if (spent !== txid) return { ok: false, status: 400, text: async () => 'not this test\'s outpoint', json: async () => ({}) } as any
        broadcasts.push(String(init.body)); return { ok: true, text: async () => 'stub' } as any
      }
      if (url.includes('/blocks/tip/height')) return { ok: true, text: async () => '100' } as any
      if (url.includes(`/tx/${txid}/status`)) return { ok: true, json: async () => ({ confirmed: true, block_height: 100 }) } as any
      if (url.includes('/v1/fees/recommended')) return { ok: true, json: async () => ({ halfHourFee: 5, fastestFee: 8 }) } as any
      if (/\/tx\/[0-9a-f]{64}(\/status|\/outspend\/\d+)?$/.test(url)) return { ok: false, status: 404, text: async () => 'not found', json: async () => ({}) } as any
      return { ok: true, json: async () => [{ txid, vout: 0, value: 100_000, status: { confirmed: true } }] } as any
    }) as any
  }

  // ── fixtures ─────────────────────────────────────────────────────────────────────────────────────────────────
  interface Opened { escrowId: string; tradeId: string; disputeId: string; buyerId: string; sellerId: string; arbiterId: string; buyerDestination: string; sellerDestination: string; txid: string }
  async function openedDispute(label: string): Promise<Opened> {
    pg.requirePostgres(label)
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
    const txid = createHash('sha256').update(`r2-${label}-${Date.now()}-${seq}`).digest('hex')
    chain(txid)
    await escrowService.lockFunds(escrow.id, seller.id)
    const dispute = await getDisputeService().raiseDispute(trade.id, buyer.id, `R2 ${label}`)
    const buyerDestination = destination(`buyer-${label}-${seq}`)
    const sellerDestination = destination(`seller-${label}-${seq}`)
    await payoutAddressService.setPayoutAddress(buyer.id, 'BTC', buyerDestination)
    await payoutAddressService.setPayoutAddress(seller.id, 'BTC', sellerDestination)
    return { escrowId: escrow.id, tradeId: trade.id, disputeId: dispute.id, buyerId: buyer.id, sellerId: seller.id, arbiterId: dispute.arbiterId, buyerDestination, sellerDestination, txid }
  }
  const payloadFor = (o: Opened, ruling: Ruling, bps: number | null, at = new Date()) =>
    ({ disputeId: o.disputeId, escrowId: o.escrowId, appealRound: 0, authorityId: o.arbiterId, outcome: ruling, buyerBps: bps, issuedAt: at.toISOString() })
  /** The live resolve flow (production path): the call a test pauses, races and lets fail. */
  function resolve(o: Opened, ruling: Ruling, bps: number | null = null) {
    const payload = payloadFor(o, ruling, bps)
    const signature = signAuthorityDecision(payload, arbiterKp.secretKey)
    return () => getDisputeService().resolveDispute(o.disputeId, o.arbiterId, ruling, undefined, undefined, bps ?? undefined, signature, payload.issuedAt)
  }
  /** The C4 window: the production Outcome commit ran (RESOLVED, durable record) and nothing else. */
  async function commitOnly(o: Opened, ruling: Ruling, bps: number | null = null): Promise<void> {
    const payload = payloadFor(o, ruling, bps)
    const row = await prisma.dispute.findUniqueOrThrow({ where: { id: o.disputeId } })
    const committed = await commitAuthoritativeDisputeRuling(
      { id: o.disputeId, escrowId: o.escrowId, status: row.status, appealRound: 0 },
      payload, signAuthorityDecision(payload, arbiterKp.secretKey), pubHex(arbiterKp), '100000', 'BTC', o.buyerId, o.sellerId,
    )
    expect(committed.committed).toBe(true)
  }
  const partialSigPubkeys = (psbtBase64: string): string[] =>
    (bitcoin.Psbt.fromBase64(psbtBase64, { network: NET }).data.inputs[0].partialSig ?? []).map((p) => Buffer.from(p.pubkey).toString('hex'))
  const sign = (psbtBase64: string, key: ReturnType<typeof keyOf>) => { const p = bitcoin.Psbt.fromBase64(psbtBase64, { network: NET }); p.signInput(0, key); return p.toBase64() }
  const paidTo = () => broadcasts.map((hex) => bitcoin.Transaction.fromHex(hex).outs.map((out) => addrOf(out.script)))

  /** Every count that would move if a disposition were authorized, executed or erased. */
  async function effects(o: Opened) {
    const escrow = await prisma.escrow.findUniqueOrThrow({ where: { id: o.escrowId } })
    const dispute = await prisma.dispute.findUniqueOrThrow({ where: { id: o.disputeId } })
    const rounds = await prisma.escrowPendingTransaction.findMany({ where: { escrowId: o.escrowId } })
    return {
      escrow: escrow.status as string,
      txReleaseId: escrow.txReleaseId as string | null,
      dispute: dispute.status as string,
      ruling: dispute.ruling as string | null,
      outcome: (await loadDisputeRulingRecord(o.escrowId, 0)) ? 'present' : 'absent',
      roundIds: rounds.map((r: any) => r.id as string),
      roundEmbedsArbiterSignature: rounds.some((r: any) => partialSigPubkeys(r.unsignedPsbtBase64).length > 0),
      signatures: await prisma.escrowTransactionSignature.count({ where: { pendingTx: { escrowId: o.escrowId } } }),
      authorizations: await prisma.economicDispositionAuthorization.count({ where: { escrowId: o.escrowId } }),
      broadcasts: broadcasts.length,
    }
  }
  const settle = <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: Error) => ({ ok: false as const, error: e.message }))

  /** Pauses the first call of obj[method] for this escrow until go() (proceeds) or fail(err) (throws instead). */
  function hold(obj: any, method: string, matches: (args: any[]) => boolean) {
    let settleGate!: (v: 'go' | Error) => void
    const gate = new Promise<'go' | Error>((r) => { settleGate = r })
    let reached!: () => void
    const atPause = new Promise<void>((r) => { reached = r })
    const real = obj[method].bind(obj)
    let used = false
    jest.spyOn(obj, method).mockImplementation(async (...args: any[]) => {
      if (!used && matches(args)) {
        used = true
        reached()
        const verdict = await gate
        if (verdict !== 'go') throw verdict
      }
      return real(...args)
    })
    return { atPause, go: () => settleGate('go'), fail: (e: Error) => settleGate(e) }
  }
  const forEscrow = (o: Opened) => (args: any[]) => args[0]?.id === o.escrowId || args[0] === o.escrowId

  async function c4Until(o: Opened) {
    let last: any
    for (let i = 0; i < 60; i++) {
      last = await reconcileMissingDispatch()
      if (last.claimed.includes(o.escrowId)) return last
    }
    return last
  }
  const mine = (o: Opened, rows: any[] | undefined) => (rows ?? []).filter((x: any) => x.escrowId === o.escrowId)
  const roundOf = (o: Opened) => prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: o.escrowId } })

  /** The witness of the broadcast transaction, verified signature by signature against the escrow's own script. */
  async function verifyBroadcastWitness(o: Opened, partyPubkey: string) {
    const tx = bitcoin.Transaction.fromHex(broadcasts[0])
    const witness = tx.ins[0].witness
    expect(witness).toHaveLength(4)
    const witnessScript = Buffer.from(witness[3])
    const arbiterPubkey = (await loadParticipantPubkeys(o.escrowId)).arbiterPubkey as string
    const hash = tx.hashForWitnessV0(0, witnessScript, 100_000n, bitcoin.Transaction.SIGHASH_ALL)
    const signers = [witness[1], witness[2]].map((w) => {
      const { signature, hashType } = bitcoin.script.signature.decode(Buffer.from(w))
      expect(hashType).toBe(bitcoin.Transaction.SIGHASH_ALL)
      return [arbiterPubkey, partyPubkey].find((k) => ecc.verify(hash, Buffer.from(k, 'hex'), signature))
    })
    expect(new Set(signers)).toEqual(new Set([arbiterPubkey, partyPubkey]))
  }

  /** FAULT INJECTION - a round of the dispute's current generation, persisted the way the construction would, with a chosen payout. */
  async function persistRound(o: Opened, opts: { kind: 'release' | 'refund'; payTo: string; recordedRuling?: string; authoritySignature?: string; ruled?: boolean }) {
    const escrow = await escrowRepository.findById(o.escrowId)
    const dispute = await prisma.dispute.findUniqueOrThrow({ where: { id: o.disputeId } })
    const keys = await loadParticipantPubkeys(o.escrowId)
    const record = { ...escrow, status: 'DISPUTED', buyerId: o.buyerId, sellerId: o.sellerId, ...keys, triggeredBy: o.arbiterId }
    chain(o.txid)
    const built = opts.kind === 'refund' ? await multisigProvider.buildUnsignedRefund(record, opts.payTo) : await multisigProvider.buildUnsignedRelease(record, opts.payTo)
    return prisma.escrowPendingTransaction.create({
      data: {
        escrowId: o.escrowId, kind: opts.kind, toAddress: opts.payTo, unsignedPsbtBase64: built.psbtBase64, requiredSigners: built.requiredSigners,
        triggeredBy: o.arbiterId, minerFeeSats: built.minerFeeSats, signaturesConfidential: true, disputeId: dispute.id,
        rulingAppealRound: dispute.appealRound, rulingArbiterId: dispute.arbiterId,
        rulingOutcome: (opts.recordedRuling ?? dispute.ruling) as any,
        rulingAuthoritySignature: opts.authoritySignature ?? dispute.authoritySignature,
        rulingAuthorityIssuedAt: dispute.authorityIssuedAt,
      } as any,
    })
  }

  const KINDS = [
    ['RELEASE', null, 'buyer', 'buildUnsignedRelease', 'initiateRelease'],
    ['REFUND', null, 'seller', 'buildUnsignedRefund', 'initiateRefund'],
    ['SPLIT', 3000, 'buyer', 'buildUnsignedSplit', 'initiateSplit'],
  ] as const
  const signerOf = (o: Opened, role: 'buyer' | 'seller') => role === 'buyer' ? { key: buyerKey, id: o.buyerId } : { key: sellerKey, id: o.sellerId }
  const destinationsOf = (o: Opened, ruling: Ruling) =>
    ruling === 'RELEASE' ? [o.buyerDestination] : ruling === 'REFUND' ? [o.sellerDestination] : [o.buyerDestination, o.sellerDestination]

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // AR-01 - dispatch is idempotent
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════

  it.each(KINDS)('AR-01 %s: C4 builds the round while the live flow is still building - the live flow adopts it, the ruling and its Outcome stand, the round executes exactly once', async (ruling, bps, role, buildMethod) => {
    const o = await openedDispute(`a1-${ruling.toLowerCase()}`)
    chain(o.txid)
    // FAULT-INJECTION POINT (a pause, not a mock of behaviour): the live flow's own PSBT build is slow.
    const pause = hold(multisigProvider, buildMethod, forEscrow(o))
    const live = settle(resolve(o, ruling, bps)())
    await pause.atPause
    expect(await effects(o)).toMatchObject({ dispute: 'RESOLVED', outcome: 'present', roundIds: [] })
    const c4 = await c4Until(o)
    const c4Round = await roundOf(o)
    expect(mine(o, c4.resumed)).toHaveLength(1)
    pause.go()

    const result = await live

    expect(result.ok).toBe(true) // before AUD1X-R2: "already has a pending ... transaction awaiting signatures", and the ruling reverted
    const after = await effects(o)
    expect(after).toMatchObject({ dispute: 'RESOLVED', ruling, outcome: 'present', roundIds: [c4Round.id], authorizations: 0, broadcasts: 0, escrow: 'DISPUTED' })
    expect(after.roundEmbedsArbiterSignature).toBe(false)

    const signer = signerOf(o, role)
    chain(o.txid)
    expect((await submitTransactionSignature(o.escrowId, signer.id, sign(c4Round.unsignedPsbtBase64, signer.key))).complete).toBe(true)
    expect(await effects(o)).toMatchObject({ escrow: ruling === 'RELEASE' ? 'COMPLETED' : ruling === 'REFUND' ? 'REFUNDED' : 'SPLIT', broadcasts: 1, authorizations: 1, dispute: 'RESOLVED', outcome: 'present' })
    expect(paidTo()[0].sort()).toEqual(destinationsOf(o, ruling).sort())
    await verifyBroadcastWitness(o, pubHex(signer.key))
  })

  it('AR-01 the other order: C4 builds between the Outcome commit and the live flow\'s dispatch-eligibility check - the live flow still succeeds', async () => {
    const o = await openedDispute('a1-eligibility')
    chain(o.txid)
    const pause = hold(dispatchModule, 'assertDisputeDispatchEligible', forEscrow(o))
    const live = settle(resolve(o, 'RELEASE')())
    await pause.atPause
    await c4Until(o)
    const c4Round = await roundOf(o)
    pause.go()

    const result = await live

    expect(result.ok).toBe(true) // before: "Dispatch eligibility check failed ... dispatch already occurred" and the ruling reverted
    expect(await effects(o)).toMatchObject({ dispute: 'RESOLVED', outcome: 'present', roundIds: [c4Round.id], authorizations: 0, broadcasts: 0 })
  })

  it('AR-01 the live flow first: C4 finds the dispatch done and creates nothing; a repeated initiate is refused as before (one round per escrow) and changes nothing', async () => {
    const o = await openedDispute('a1-live-first')
    await resolve(o, 'RELEASE')()
    const first = await roundOf(o)

    const c4 = await c4Until(o)
    expect(mine(o, c4.resumed)).toEqual([])
    const again = await settle(escrowService.initiateRelease(o.escrowId, o.buyerDestination, o.arbiterId))

    expect(again.ok).toBe(false)
    expect(!again.ok && again.error).toMatch(/already has a pending/)
    expect((await effects(o)).roundIds).toEqual([first.id])
    expect(await prisma.economicDispositionAuthorization.count({ where: { escrowId: o.escrowId } })).toBe(0)
  })

  it('AR-01 two executors build at the same instant (both reach the provider build before either writes): exactly one round is created, the other is told it lost', async () => {
    const o = await openedDispute('a1-two-builders')
    await commitOnly(o, 'RELEASE')
    chain(o.txid)
    let arrived = 0
    let open!: () => void
    const bothArrived = new Promise<void>((r) => { open = r })
    const real = multisigProvider.buildUnsignedRelease.bind(multisigProvider)
    jest.spyOn(multisigProvider, 'buildUnsignedRelease').mockImplementation(async (...args: any[]) => {
      if (args[0]?.id !== o.escrowId) return real(...args)
      arrived += 1
      if (arrived === 2) open()
      await bothArrived
      return real(...args)
    })

    const [a, b] = await Promise.all([
      settle(escrowService.initiateRelease(o.escrowId, o.buyerDestination, o.arbiterId)),
      settle(escrowService.initiateRelease(o.escrowId, o.buyerDestination, o.arbiterId)),
    ])

    expect(arrived).toBe(2)
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
    const loser = a.ok ? b : a
    expect(!loser.ok && loser.error).toMatch(/already has a pending/)
    expect((await effects(o)).roundIds).toHaveLength(1)
  })

  it('AR-01 two C4 workers at once: one round, no failure, no authorization', async () => {
    const o = await openedDispute('a1-two-c4')
    await commitOnly(o, 'RELEASE')
    chain(o.txid)

    const [r1, r2] = await Promise.all([c4Until(o), c4Until(o)])

    expect(mine(o, r1.failed)).toEqual([])
    expect(mine(o, r2.failed)).toEqual([])
    expect(mine(o, r1.resumed).length + mine(o, r2.resumed).length).toBeLessThanOrEqual(1)
    const after = await effects(o)
    expect(after.roundIds).toHaveLength(1)
    expect(after).toMatchObject({ dispute: 'RESOLVED', authorizations: 0, broadcasts: 0 })
  })

  it('AR-01 retry after restart: a fresh module graph (no memory of the first) creates no second round and no authorization', async () => {
    const o = await openedDispute('a1-restart')
    await commitOnly(o, 'RELEASE')
    chain(o.txid)
    await c4Until(o)
    const first = await roundOf(o)

    const again = await settle(restarted!.initiateRelease(o.escrowId, o.buyerDestination, o.arbiterId))

    expect(again.ok).toBe(false)
    expect(!again.ok && again.error).toMatch(/already has a pending/)
    expect(await effects(o)).toMatchObject({ roundIds: [first.id], authorizations: 0, dispute: 'RESOLVED', outcome: 'present' })
  })

  it('AR-01 a round of this generation that is NOT the ruling dispatch is refused with the reasons and never adopted - and the ruling is preserved, not reverted (wrong payee; wrong kind)', async () => {
    for (const variant of ['payee', 'kind'] as const) {
      const o = await openedDispute(`a1-divergent-${variant}`)
      chain(o.txid)
      const pause = hold(multisigProvider, 'buildUnsignedRelease', forEscrow(o))
      const live = settle(resolve(o, 'RELEASE')())
      await pause.atPause
      // a divergent round of the committed generation appears (a legacy or foreign writer): the live flow must not take it for its own
      const divergent = variant === 'payee'
        ? await persistRound(o, { kind: 'release', payTo: destination('attacker') })
        : await persistRound(o, { kind: 'refund', payTo: o.sellerDestination, recordedRuling: 'RELEASE' })
      pause.go()

      const result = await live

      expect(result.ok).toBe(false)
      expect(!result.ok && result.error).toMatch(/not the dispatch of the ruling/)
      expect(!result.ok && result.error).toMatch(variant === 'payee' ? /destination|AUD-1/ : /is a refund, this dispatch is a release|AUD-1/)
      const after = await effects(o)
      expect(after).toMatchObject({ dispute: 'RESOLVED', ruling: 'RELEASE', outcome: 'present', roundIds: [divergent.id], authorizations: 0, broadcasts: 0 })
    }
  })

  it('AR-01 a round of a superseded or different signed authority is not adopted (stale generation), and cannot execute', async () => {
    const o = await openedDispute('a1-stale')
    chain(o.txid)
    const pause = hold(multisigProvider, 'buildUnsignedRelease', forEscrow(o))
    const live = settle(resolve(o, 'RELEASE')())
    await pause.atPause
    const stale = await persistRound(o, { kind: 'release', payTo: o.buyerDestination, authoritySignature: 'stale-authority-signature' })
    pause.go()

    const result = await live
    expect(result.ok).toBe(false) // a round recording ANOTHER authority is not this generation's: there is nothing to adopt...
    // ...and it is not this ruling's round, so the failure is state 1: the ruling is reverted as before (the stale round is
    // the ST1-R1 residual - nothing here removes it)
    expect((await effects(o)).dispute).toBe('OPENED')
    const executed = await settle(submitTransactionSignature(o.escrowId, o.buyerId, sign(stale.unsignedPsbtBase64, buyerKey)))
    expect(executed.ok).toBe(false)
    expect(await effects(o)).toMatchObject({ escrow: 'DISPUTED', authorizations: 0, broadcasts: 0 })
  })

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // AR-03 - a dispatch failure does not revoke a committed authority
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════

  it('AR-03 state 1 is unchanged: a failure before any round or authorization exists still reverts the ruling, and the arbiter can re-rule and dispatch', async () => {
    const o = await openedDispute('a3-state1')
    chain(o.txid)
    const pause = hold(multisigProvider, 'buildUnsignedRelease', forEscrow(o))
    const live = settle(resolve(o, 'RELEASE')())
    await pause.atPause
    pause.fail(new Error('injected: the explorer is unreachable'))

    const result = await live

    expect(result.ok).toBe(false)
    expect(await effects(o)).toMatchObject({ dispute: 'OPENED', ruling: null, outcome: 'absent', roundIds: [], authorizations: 0 })
    // the arbiter's honest retry is not blocked by anything left behind
    chain(o.txid)
    await resolve(o, 'RELEASE')()
    expect(await effects(o)).toMatchObject({ dispute: 'RESOLVED', outcome: 'present' })
    expect((await effects(o)).roundIds).toHaveLength(1)
  })

  it('AR-03 a failure AFTER the round was persisted (the response is lost): the dispatch exists and is proven, so the call succeeds; ruling, Outcome and round stand and the round executes', async () => {
    const o = await openedDispute('a3-after-construction')
    chain(o.txid)
    // FAULT INJECTION: the real initiate runs to completion, then the call is made to fail
    const real = escrowService.initiateRelease.bind(escrowService)
    jest.spyOn(escrowService, 'initiateRelease').mockImplementationOnce(async (...args: any[]) => {
      await real(...args)
      throw new Error('injected: connection lost after the round was persisted')
    })

    const result = await settle(resolve(o, 'RELEASE')())

    expect(result.ok).toBe(true)
    const after = await effects(o)
    expect(after).toMatchObject({ dispute: 'RESOLVED', ruling: 'RELEASE', outcome: 'present', authorizations: 0, broadcasts: 0 })
    expect(after.roundIds).toHaveLength(1)

    const round = await roundOf(o)
    chain(o.txid)
    expect((await submitTransactionSignature(o.escrowId, o.buyerId, sign(round.unsignedPsbtBase64, buyerKey))).complete).toBe(true)
    expect(await effects(o)).toMatchObject({ escrow: 'COMPLETED', broadcasts: 1, authorizations: 1, dispute: 'RESOLVED', outcome: 'present' })
  })

  // The live flow fails at each stage the OTHER executor's round has reached. Every stage keeps the ruling and the Outcome.
  it.each([
    ['a stored signature (no authorization yet)', 'signature'],
    ['a committed authorization (gate passed, nothing claimed)', 'authorization'],
    ['a claimed transition (the provider is mid-broadcast)', 'claim'],
    ['a broadcast and confirmed settlement', 'broadcast'],
  ] as const)('AR-03 revert versus %s: the ruling and its Outcome are preserved and the execution completes with one broadcast', async (_name, stage) => {
    const o = await openedDispute(`a3-${stage}`)
    chain(o.txid)
    const pause = hold(multisigProvider, 'buildUnsignedRelease', forEscrow(o))
    const live = settle(resolve(o, 'RELEASE')())
    await pause.atPause
    await c4Until(o)
    const round = await roundOf(o)
    const buyerCopy = sign(round.unsignedPsbtBase64, buyerKey)
    chain(o.txid)

    let execution: Promise<any> | undefined
    let finalize: ReturnType<typeof hold> | undefined
    if (stage === 'signature') {
      await prisma.escrowTransactionSignature.create({ data: { pendingTxId: round.id, participantId: o.buyerId, signedPsbtBase64: buyerCopy } })
    } else if (stage === 'authorization') {
      await prisma.escrowTransactionSignature.create({ data: { pendingTxId: round.id, participantId: o.buyerId, signedPsbtBase64: buyerCopy } })
      await authorizeDisputedPendingExecution(round) // what the live gate commits immediately before its claim
    } else if (stage === 'claim') {
      finalize = hold(multisigProvider, 'finalizeRelease', forEscrow(o))
      execution = settle(submitTransactionSignature(o.escrowId, o.buyerId, buyerCopy))
      await finalize.atPause
      expect(await effects(o)).toMatchObject({ escrow: 'COMPLETED', authorizations: 1, broadcasts: 0 }) // claimed, not broadcast
    } else {
      expect((await submitTransactionSignature(o.escrowId, o.buyerId, buyerCopy)).complete).toBe(true)
      expect(await effects(o)).toMatchObject({ escrow: 'COMPLETED', broadcasts: 1, authorizations: 1 })
    }

    pause.fail(new Error('injected: the live flow own dispatch fails'))
    const liveResult = await live

    expect(liveResult.ok).toBe(true) // the dispatch exists (proven round, or a committed authorization): the call is an idempotent success...
    const during = await effects(o)
    expect(during).toMatchObject({ dispute: 'RESOLVED', ruling: 'RELEASE', outcome: 'present' }) // ...and nothing durable is undone
    if (stage !== 'claim' && stage !== 'broadcast') expect(during.roundIds).toEqual([round.id])

    if (stage === 'claim') {
      finalize!.go()
      expect((await execution!).ok).toBe(true)
    } else if (stage !== 'broadcast') {
      expect((await submitTransactionSignature(o.escrowId, o.buyerId, buyerCopy)).complete).toBe(true)
    }
    const final = await effects(o)
    expect(final).toMatchObject({ escrow: 'COMPLETED', dispute: 'RESOLVED', ruling: 'RELEASE', outcome: 'present', broadcasts: 1, authorizations: 1 })
    expect(final.txReleaseId).not.toBeNull()
    expect(paidTo()[0]).toEqual([o.buyerDestination])
    await verifyBroadcastWitness(o, pubHex(buyerKey))
  })

  it.each([
    ['REFUND', null, 'seller', 'buildUnsignedRefund', 'REFUNDED'],
    ['SPLIT', 3000, 'buyer', 'buildUnsignedSplit', 'SPLIT'],
  ] as const)('AR-03 %s: the dispatch failed after its round was executed to the end - ruling and Outcome stand, the call is an idempotent success', async (ruling, bps, role, buildMethod, terminal) => {
    const o = await openedDispute(`a3-settled-${ruling.toLowerCase()}`)
    chain(o.txid)
    const pause = hold(multisigProvider, buildMethod, forEscrow(o))
    const live = settle(resolve(o, ruling, bps)())
    await pause.atPause
    await c4Until(o)
    const round = await roundOf(o)
    const signer = signerOf(o, role)
    chain(o.txid)
    expect((await submitTransactionSignature(o.escrowId, signer.id, sign(round.unsignedPsbtBase64, signer.key))).complete).toBe(true)
    expect(await effects(o)).toMatchObject({ escrow: terminal, broadcasts: 1, authorizations: 1, roundIds: [] })
    pause.fail(new Error('injected: the live flow own dispatch fails'))

    const result = await live

    expect(result.ok).toBe(true)
    expect(await effects(o)).toMatchObject({ escrow: terminal, dispute: 'RESOLVED', ruling, outcome: 'present', broadcasts: 1, authorizations: 1 })
  })

  it('AR-03 replay after a partial failure and a restart: the authorization is reused, one broadcast, one authorization', async () => {
    const o = await openedDispute('a3-replay')
    await resolve(o, 'RELEASE')()
    const round = await roundOf(o)
    const buyerCopy = sign(round.unsignedPsbtBase64, buyerKey)
    chain(o.txid)
    // FAULT INJECTION: the provider fails after the gate committed the authorization and the claim was taken (the claim is reverted)
    jest.spyOn(multisigProvider, 'finalizeRelease').mockImplementationOnce(async () => { throw new Error('injected: provider failure after the authorization') })
    expect((await settle(submitTransactionSignature(o.escrowId, o.buyerId, buyerCopy))).ok).toBe(false)
    expect(await effects(o)).toMatchObject({ escrow: 'DISPUTED', authorizations: 1, broadcasts: 0, dispute: 'RESOLVED', outcome: 'present' })
    jest.restoreAllMocks()
    chain(o.txid)

    const first = await restarted!.submitTransactionSignature(o.escrowId, o.buyerId, buyerCopy)
    const replay = await settle(submitTransactionSignature(o.escrowId, o.buyerId, buyerCopy))

    expect(first.complete).toBe(true)
    expect(replay.ok).toBe(false) // nothing left to execute
    expect(await effects(o)).toMatchObject({ escrow: 'COMPLETED', authorizations: 1, broadcasts: 1 })
  })

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // AR-04 - no round, and no new authorization, for an escrow that is already terminal
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════

  it('AR-04 an initiate that read the escrow before it was settled persists nothing once the escrow is terminal, and mints no second authorization', async () => {
    const o = await openedDispute('a4-construction')
    await commitOnly(o, 'RELEASE')
    chain(o.txid)
    const pause = hold(multisigProvider, 'buildUnsignedRelease', forEscrow(o))
    const late = settle(escrowService.initiateRelease(o.escrowId, o.buyerDestination, o.arbiterId))
    await pause.atPause
    // meanwhile C4's round is signed and executed to the end
    await c4Until(o)
    const round = await roundOf(o)
    chain(o.txid)
    expect((await submitTransactionSignature(o.escrowId, o.buyerId, sign(round.unsignedPsbtBase64, buyerKey))).complete).toBe(true)
    expect(await effects(o)).toMatchObject({ escrow: 'COMPLETED', broadcasts: 1, authorizations: 1, roundIds: [] })
    pause.go()

    const result = await late

    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toMatch(/Invalid escrow transition/)
    expect(await effects(o)).toMatchObject({ escrow: 'COMPLETED', broadcasts: 1, authorizations: 1, roundIds: [], dispute: 'RESOLVED', outcome: 'present' })
  })

  it('AR-04 a round that already sits on a terminal escrow cannot obtain an authorization: refused before the gate', async () => {
    const o = await openedDispute('a4-execution')
    await resolve(o, 'RELEASE')()
    const real = await roundOf(o)
    chain(o.txid)
    expect((await submitTransactionSignature(o.escrowId, o.buyerId, sign(real.unsignedPsbtBase64, buyerKey))).complete).toBe(true)
    expect(await effects(o)).toMatchObject({ escrow: 'COMPLETED', authorizations: 1, broadcasts: 1 })
    // FAULT INJECTION: the orphan the audit's A2b produced (a second round persisted after the settlement)
    const orphan = await persistRound(o, { kind: 'release', payTo: o.buyerDestination })

    const refused = await settle(submitTransactionSignature(o.escrowId, o.buyerId, sign(orphan.unsignedPsbtBase64, buyerKey)))

    expect(refused.ok).toBe(false)
    expect(!refused.ok && refused.error).toMatch(/Invalid escrow transition/)
    expect(await prisma.economicDispositionAuthorization.count({ where: { escrowId: o.escrowId } })).toBe(1) // not 2
    expect(broadcasts).toHaveLength(1)
  })


  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // Lock order, behaviourally: the construction is held right after its FIRST advisory lock while the real ST-1 cleanup
  // (D then E) is started. D-then-E cannot deadlock; a construction that took E first would (PostgreSQL 40P01).
  // A suite that merely did not observe a deadlock proves nothing: this one fails against the reversed order.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════

  it('LOCK construction (paused after its first advisory lock) versus the ST-1 cleanup: the construction takes the dispute lock first and nothing deadlocks', async () => {
    const o = await openedDispute('lock-order')
    await commitOnly(o, 'RELEASE')
    chain(o.txid)
    const dKey = economicDispositionLockKey(o.disputeId)
    let first: 'D' | 'E' | null = null
    let resume!: () => void
    const resumed = new Promise<void>((r) => { resume = r })
    let held!: () => void
    const isHeld = new Promise<void>((r) => { held = r })
    const realTransaction = prisma.$transaction.bind(prisma)
    let armed = true
    // FAULT-INJECTION POINT (a pause only): the first advisory lock taken for this dispute or escrow, inside any
    // transaction, is observed and the transaction is held there.
    jest.spyOn(prisma, '$transaction').mockImplementation(((fn: any, opts: any) => {
      if (typeof fn !== 'function' || !armed) return realTransaction(fn, opts)
      return realTransaction(async (tx: any) => fn(new Proxy(tx, {
        get(target, prop) {
          const value = Reflect.get(target, prop)
          if (prop !== '$executeRaw' || !armed) return typeof value === 'function' ? value.bind(target) : value
          return async (strings: TemplateStringsArray, ...values: unknown[]) => {
            const out = await value.call(target, strings, ...values)
            if (armed && /pg_advisory_xact_lock/.test(strings.join('?')) && (values.includes(o.escrowId) || values.includes(dKey))) {
              armed = false
              first = values.includes(dKey) ? 'D' : 'E'
              held()
              await resumed
            }
            return out
          }
        },
      })), opts)
    }) as any)
    const construct = settle(escrowService.initiateRelease(o.escrowId, o.buyerDestination, o.arbiterId))
    await isHeld
    jest.restoreAllMocks() // the cleanup runs on the real client
    chain(o.txid)
    const generation = { disputeId: o.disputeId, rulingAppealRound: 0, rulingArbiterId: o.arbiterId, rulingOutcome: 'RELEASE', rulingAuthoritySignature: 'x', rulingAuthorityIssuedAt: new Date() }
    const cleanup = settle(deletePendingRoundIfStillUnsigned('00000000-0000-0000-0000-000000000000', o.escrowId, generation))
    // the cleanup must be queued on the lock the construction holds before the construction continues
    for (let i = 0; i < 500; i++) {
      const [{ n }] = await prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`
      if (n >= 1) break
      await new Promise((r) => setTimeout(r, 10))
    }
    resume()

    const [c, k] = await Promise.all([construct, cleanup])

    expect(first).toBe('D')
    expect([c, k].some((x) => !x.ok && /deadlock detected|40P01/i.test(x.error))).toBe(false)
    expect(c.ok).toBe(true)
  })

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // AR-05 - PASS 1 produces the arbiter signature only under an authorization that still describes its round
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════

  /** PASS 1 (and every pass after it) until this escrow has been visited; what was reported about it is returned. */
  async function runPass1Until(o: Opened) {
    const manualReview: any[] = []
    for (let i = 0; i < 80; i++) {
      const report = await reconcilePendingSettlements({ projectionGraceMs: 50 * 365 * 24 * 3600 * 1000 })
      manualReview.push(...(report.requiresManualReview ?? []).filter((r: any) => r.escrowId === o.escrowId))
      const row = await prisma.escrow.findUniqueOrThrow({ where: { id: o.escrowId }, select: { settlementRecoveryAttemptedAt: true } })
      if (row.settlementRecoveryAttemptedAt) break
    }
    return { manualReview }
  }

  /** A terminal escrow whose claim happened and whose broadcast never did: the shape PASS 1 exists for. */
  async function terminalWithoutBroadcast(label: string) {
    const o = await openedDispute(label)
    await resolve(o, 'RELEASE')()
    const round = await roundOf(o)
    await prisma.escrowTransactionSignature.create({ data: { pendingTxId: round.id, participantId: o.buyerId, signedPsbtBase64: sign(round.unsignedPsbtBase64, buyerKey) } })
    await prisma.escrow.update({ where: { id: o.escrowId }, data: { status: 'COMPLETED' } }) // FAULT INJECTION: claimed, then the process died
    chain(o.txid)
    return { o, round }
  }

  it('AR-05 control: under the authorization the gate committed for the round, PASS 1 still completes the recovery (one broadcast, valid witness)', async () => {
    const { o, round } = await terminalWithoutBroadcast('a5-control')
    await authorizeDisputedPendingExecution(round)

    await runPass1Until(o)

    expect(broadcasts).toHaveLength(1)
    await verifyBroadcastWitness(o, pubHex(buyerKey))
    expect(paidTo()[0]).toEqual([o.buyerDestination])
  })

  it('AR-05 an authorization committed for a CONTRADICTING ruling (the shape the pre-AUD-1 gate could leave) is never a means to sign: manual review, no broadcast', async () => {
    const { o, round } = await terminalWithoutBroadcast('a5-contradicting')
    // FAULT INJECTION: an authorization whose ruling contradicts the round it names, digest otherwise genuine
    await prisma.economicDispositionAuthorization.create({
      data: {
        pendingOperationId: round.id, escrowId: o.escrowId, disputeId: o.disputeId, appealRound: 0, arbiterId: o.arbiterId,
        ruling: 'REFUND', operationDigest: economicDispositionOperationDigest(round),
      },
    })

    const seen = await runPass1Until(o)

    expect(broadcasts).toHaveLength(0)
    expect(JSON.stringify(seen.manualReview)).toMatch(/no execution authorization supplied the arbiter signature/)
    expect((await prisma.escrow.findUniqueOrThrow({ where: { id: o.escrowId } })).txReleaseId).toBeNull()
  })

  it('AR-05 an authorization whose digest does not describe this round is not a means to sign either', async () => {
    const { o, round } = await terminalWithoutBroadcast('a5-digest')
    await prisma.economicDispositionAuthorization.create({
      data: {
        pendingOperationId: round.id, escrowId: o.escrowId, disputeId: o.disputeId, appealRound: 0, arbiterId: o.arbiterId,
        ruling: 'RELEASE', operationDigest: 'f'.repeat(64),
      },
    })

    const seen = await runPass1Until(o)

    expect(broadcasts).toHaveLength(0)
    expect(JSON.stringify(seen.manualReview)).toMatch(/no execution authorization supplied the arbiter signature/)
  })

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // AUD1X-R3 - economic truth (AR2-01), recovery of a committed attempt (AR2-02), destination metadata (AR2-03)
  //
  // The R2 adversarial gate found that an authorization of the same appeal round was taken for THIS ruling's executed
  // dispatch by its generation number alone. Each scenario below builds the durable state on the production services
  // and, where earlier code is the only author of a state, injects it (named FAULT INJECTION; triggers bypassed with
  // session_replication_role = replica, the way a legacy writer would have left it).
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════

  async function inject(fn: (tx: any) => Promise<void>) {
    await prisma.$transaction(async (tx: any) => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`
      await fn(tx)
    })
  }
  /** FAULT INJECTION - the pre-R2 revert of an executed ruling: dispute back to OPENED, its Outcome deleted (and, if the
   *  process died before it, no terminal claim record - so a later revert has no MOOT to land on). */
  const legacyRevert = (o: Opened, opts: { dropTerminalRecord: boolean }) => inject(async (tx) => {
    await tx.dispute.update({ where: { id: o.disputeId }, data: { status: 'OPENED', ruling: null, resolvedAt: null, authoritySignature: null, authorityIssuedAt: null, authorityBuyerBps: null } })
    await tx.semanticTransitionRecord.deleteMany({ where: { interactionId: o.escrowId } })
    if (opts.dropTerminalRecord) await tx.escrowEvent.deleteMany({ where: { escrowId: o.escrowId, toStatus: { in: ['COMPLETED', 'REFUNDED', 'SPLIT'] } } })
  })
  /** FAULT INJECTION - an authorization committed before the gate recorded which ruling it authorized. */
  const forgetIdentity = (o: Opened) => prisma.$executeRaw`
    UPDATE economic_disposition_authorizations SET "rulingAuthoritySignature" = NULL, "outcomeRecordId" = NULL WHERE "escrowId" = ${o.escrowId}`
  const authorizationsOf = (o: Opened) => prisma.$queryRaw<{ id: string; pendingOperationId: string; ruling: string; arbiterId: string; rulingAuthoritySignature: string | null; outcomeRecordId: string | null; operationDigest: string }[]>`
    SELECT id, "pendingOperationId", ruling::text AS ruling, "arbiterId", "rulingAuthoritySignature", "outcomeRecordId", "operationDigest"
    FROM economic_disposition_authorizations WHERE "escrowId" = ${o.escrowId} ORDER BY "authorizedAt", id`
  /** The live flow, then the beneficiary's signature: the ruling is executed to the end on the production path. */
  async function executeRuling(o: Opened, ruling: Ruling, bps: number | null, role: 'buyer' | 'seller') {
    chain(o.txid)
    await resolve(o, ruling, bps)()
    const round = await roundOf(o)
    const signer = signerOf(o, role)
    chain(o.txid)
    expect((await submitTransactionSignature(o.escrowId, signer.id, sign(round.unsignedPsbtBase64, signer.key))).complete).toBe(true)
    return round
  }
  function resolveAs(o: Opened, arbiterId: string, kp: nacl.SignKeyPair, ruling: Ruling, bps: number | null = null) {
    const payload = { ...payloadFor(o, ruling, bps), authorityId: arbiterId }
    const signature = signAuthorityDecision(payload, kp.secretKey)
    return () => getDisputeService().resolveDispute(o.disputeId, arbiterId, ruling, undefined, undefined, bps ?? undefined, signature, payload.issuedAt)
  }
  const TERMINAL: Record<Ruling, string> = { RELEASE: 'COMPLETED', REFUND: 'REFUNDED', SPLIT: 'SPLIT' }

  it('R3 the gate records, in its own transaction, the signed ruling and the durable Outcome record it authorized', async () => {
    const o = await openedDispute('r3-identity')
    await executeRuling(o, 'RELEASE', null, 'buyer')

    const [authorization] = await authorizationsOf(o)
    const dispute = await prisma.dispute.findUniqueOrThrow({ where: { id: o.disputeId } })
    const outcome = await loadDisputeRulingRecord(o.escrowId, 0)

    expect(authorization.rulingAuthoritySignature).toBe(dispute.authoritySignature)
    expect(authorization.outcomeRecordId).toBe(outcome.id)
  })

  // ─── AR2-01: a later ruling of the same appeal round is never taken for the executed one ───────────────────────

  it.each([
    ['REFUND executed (seller paid), RELEASE now ruled', 'REFUND', null, 'seller', 'RELEASE', null],
    ['RELEASE executed (buyer paid), REFUND now ruled', 'RELEASE', null, 'buyer', 'REFUND', null],
    ['SPLIT 30% executed, SPLIT 70% now ruled (another allocation)', 'SPLIT', 3000, 'buyer', 'SPLIT', 7000],
    ['RELEASE executed, RELEASE ruled again (same appeal round and arbiter, another signature)', 'RELEASE', null, 'buyer', 'RELEASE', null],
  ] as const)('AR2-01 %s: the new ruling is not adopted - error, ruling reverted, the executed authorization untouched, no fund movement', async (_name, first, firstBps, role, second, secondBps) => {
    const o = await openedDispute(`r3-a1-${first.toLowerCase()}-${second.toLowerCase()}-${secondBps ?? 0}`)
    await executeRuling(o, first, firstBps, role)
    const executedAuthority = await authorizationsOf(o)
    const paid = paidTo()
    await legacyRevert(o, { dropTerminalRecord: true })

    const result = await settle(resolve(o, second, secondBps)())

    expect(result.ok).toBe(false)
    expect(await effects(o)).toMatchObject({ escrow: TERMINAL[first], dispute: 'OPENED', ruling: null, outcome: 'absent', broadcasts: 1, authorizations: 1 })
    expect(await authorizationsOf(o)).toEqual(executedAuthority) // the historical authority is not erased or rewritten
    expect(paidTo()).toEqual(paid)
  })

  it('AR2-01 with the terminal claim record still present the revert lands on MOOT (the escrow is already disposed of)', async () => {
    const o = await openedDispute('r3-a1-moot')
    await executeRuling(o, 'REFUND', null, 'seller')
    await legacyRevert(o, { dropTerminalRecord: false })

    const result = await settle(resolve(o, 'RELEASE')())

    expect(result.ok).toBe(false)
    expect(await effects(o)).toMatchObject({ escrow: 'REFUNDED', dispute: 'MOOT', ruling: null, outcome: 'absent', broadcasts: 1, authorizations: 1 })
  })

  it('AR2-01 same kind, another recipient: RELEASE paid to the old address, RELEASE ruled again after the buyer changed address - not adopted', async () => {
    const o = await openedDispute('r3-a1-recipient')
    await executeRuling(o, 'RELEASE', null, 'buyer')
    await legacyRevert(o, { dropTerminalRecord: true })
    const newAddress = destination(`buyer-moved-${seq}`)
    await payoutAddressService.setPayoutAddress(o.buyerId, 'BTC', newAddress)

    const result = await settle(resolve(o, 'RELEASE')())

    expect(result.ok).toBe(false)
    expect(await effects(o)).toMatchObject({ escrow: 'COMPLETED', dispute: 'OPENED', outcome: 'absent', broadcasts: 1 })
    expect(paidTo()).toEqual([[o.buyerDestination]])
  })

  it('AR2-01 the same ruling by another arbiter: never adopted', async () => {
    const o = await openedDispute('r3-a1-arbiter')
    await executeRuling(o, 'RELEASE', null, 'buyer')
    await legacyRevert(o, { dropTerminalRecord: true })
    await inject(async (tx) => { await tx.dispute.update({ where: { id: o.disputeId }, data: { arbiterId: ARBITER2_ID } }) })

    const result = await settle(resolveAs(o, ARBITER2_ID, arbiter2Kp, 'RELEASE')())

    expect(result.ok).toBe(false)
    const after = await effects(o)
    expect(after).toMatchObject({ escrow: 'COMPLETED', broadcasts: 1, authorizations: 1 })
    expect(after.dispute).not.toBe('RESOLVED')
    expect(after.outcome).toBe('absent')
  })

  it('AR2-01 the identical signed ruling committed again (new Outcome record): not proven either way - error, ruling and Outcome preserved, nothing erased', async () => {
    const o = await openedDispute('r3-a1-replay')
    chain(o.txid)
    const sameRuling = resolve(o, 'RELEASE')
    await sameRuling()
    const round = await roundOf(o)
    chain(o.txid)
    expect((await submitTransactionSignature(o.escrowId, o.buyerId, sign(round.unsignedPsbtBase64, buyerKey))).complete).toBe(true)
    await legacyRevert(o, { dropTerminalRecord: true })

    const result = await settle(sameRuling())

    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toMatch(/not proven to be this ruling's executed dispatch.*another durable Outcome record/)
    expect(await effects(o)).toMatchObject({ escrow: 'COMPLETED', dispute: 'RESOLVED', ruling: 'RELEASE', outcome: 'present', broadcasts: 1, authorizations: 1 })
  })

  /** The R2 AR-03 shape: the live flow's own dispatch fails after C4's round of the same ruling was executed. */
  async function executedWhileLiveFlowPaused(label: string) {
    const o = await openedDispute(label)
    chain(o.txid)
    const pause = hold(multisigProvider, 'buildUnsignedRelease', forEscrow(o))
    const live = settle(resolve(o, 'RELEASE')())
    await pause.atPause
    await c4Until(o)
    const round = await roundOf(o)
    chain(o.txid)
    expect((await submitTransactionSignature(o.escrowId, o.buyerId, sign(round.unsignedPsbtBase64, buyerKey))).complete).toBe(true)
    return { o, finish: async () => { pause.fail(new Error('injected: the live flow own dispatch fails')); return live } }
  }

  it('AR2-01 a legacy authorization (no recorded identity) of the same ruling and arbiter: not adopted and not reverted - error, ruling and Outcome preserved', async () => {
    const { o, finish } = await executedWhileLiveFlowPaused('r3-a1-legacy-same')
    await forgetIdentity(o)

    const result = await finish()

    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toMatch(/legacy/)
    expect(await effects(o)).toMatchObject({ escrow: 'COMPLETED', dispute: 'RESOLVED', ruling: 'RELEASE', outcome: 'present', broadcasts: 1, authorizations: 1 })
  })

  it('AR2-01 a legacy authorization of ANOTHER ruling: a positive contradiction - reverted as before #440', async () => {
    const o = await openedDispute('r3-a1-legacy-other')
    await executeRuling(o, 'REFUND', null, 'seller')
    await forgetIdentity(o)
    await legacyRevert(o, { dropTerminalRecord: true })

    const result = await settle(resolve(o, 'RELEASE')())

    expect(result.ok).toBe(false)
    expect(await effects(o)).toMatchObject({ escrow: 'REFUNDED', dispute: 'OPENED', outcome: 'absent', broadcasts: 1, authorizations: 1 })
  })

  it('AR2-01 this ruling\'s own authorization but no executed transaction recorded on the escrow: never reported as settled - error, ruling preserved', async () => {
    const { o, finish } = await executedWhileLiveFlowPaused('r3-a1-unexecuted')
    await inject(async (tx) => { await tx.escrow.update({ where: { id: o.escrowId }, data: { txReleaseId: null } }) })

    const result = await finish()

    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toMatch(/no executed transaction is recorded/)
    expect(await effects(o)).toMatchObject({ escrow: 'COMPLETED', dispute: 'RESOLVED', ruling: 'RELEASE', outcome: 'present', broadcasts: 1 })
  })

  it('AR2-01 control: this ruling\'s own authorization, executed - adopted (the R2 AR-03 contract, now on proven identity)', async () => {
    const { o, finish } = await executedWhileLiveFlowPaused('r3-a1-control')

    const result = await finish()

    expect(result.ok).toBe(true)
    expect(await effects(o)).toMatchObject({ escrow: 'COMPLETED', dispute: 'RESOLVED', ruling: 'RELEASE', outcome: 'present', broadcasts: 1, authorizations: 1 })
  })

  // ─── AR2-02: PASS 1 and a committed attempt whose Outcome was deleted after its authorization ─────────────────

  /** Claimed (terminal), signature collected, authorized by the real gate - and the process died before the broadcast. */
  async function committedNotBroadcast(label: string) {
    const { o, round } = await terminalWithoutBroadcast(label)
    await authorizeDisputedPendingExecution(round)
    return { o, round }
  }

  it('AR2-02 the committed attempt whose Outcome a legacy revert deleted is completed by PASS 1: one broadcast, valid witness, to the authorized destination; a restarted reconciler broadcasts nothing more', async () => {
    const { o } = await committedNotBroadcast('r3-a2-recover')
    await legacyRevert(o, { dropTerminalRecord: false })

    await runPass1Until(o)
    await runPass1Until(o) // a restarted reconciler finds nothing left to do

    expect(broadcasts).toHaveLength(1)
    await verifyBroadcastWitness(o, pubHex(buyerKey))
    expect(paidTo()[0]).toEqual([o.buyerDestination])
    expect((await prisma.escrow.findUniqueOrThrow({ where: { id: o.escrowId } })).txReleaseId).toBe(bitcoin.Transaction.fromHex(broadcasts[0]).getId())
  })

  it('AR2-02 concurrent reconcilers on that attempt: every broadcast is the one authorized transaction (same bytes, same txid) and one result is persisted', async () => {
    // PASS 1's contract is at-least-once against chain truth (its header): racing instances may each send the SAME
    // transaction before either sees it on the network. This stub never reports it as known, so the race is maximal.
    const { o } = await committedNotBroadcast('r3-a2-concurrent')
    await legacyRevert(o, { dropTerminalRecord: false })

    await Promise.all([runPass1Until(o), runPass1Until(o), runPass1Until(o)])

    expect(broadcasts.length).toBeGreaterThanOrEqual(1)
    expect(new Set(broadcasts).size).toBe(1) // byte-identical: no second disposition, no second signature
    expect(paidTo()[0]).toEqual([o.buyerDestination])
    expect((await prisma.escrow.findUniqueOrThrow({ where: { id: o.escrowId } })).txReleaseId).toBe(bitcoin.Transaction.fromHex(broadcasts[0]).getId())
  })

  it.each([
    ['its recorded ruling contradicts the round', (o: Opened) => inject(async (tx) => { await tx.economicDispositionAuthorization.updateMany({ where: { escrowId: o.escrowId }, data: { ruling: 'REFUND' } }) })],
    ['its recorded signed ruling is another one', (o: Opened) => prisma.$executeRaw`UPDATE economic_disposition_authorizations SET "rulingAuthoritySignature" = 'another-ruling' WHERE "escrowId" = ${o.escrowId}`],
    ['its digest does not describe the round', (o: Opened) => inject(async (tx) => { await tx.economicDispositionAuthorization.updateMany({ where: { escrowId: o.escrowId }, data: { operationDigest: 'f'.repeat(64) } }) })],
    ['it predates recorded ruling identity (legacy: which ruling it was bound to is not proven)', (o: Opened) => forgetIdentity(o)],
    ['it records the signed ruling but no Outcome record (never bound to an Outcome)', (o: Opened) => prisma.$executeRaw`UPDATE economic_disposition_authorizations SET "outcomeRecordId" = NULL WHERE "escrowId" = ${o.escrowId}`],
  ] as const)('AR2-02 the Outcome is gone and the authorization %s: never a means to sign - manual review, no broadcast, not settled', async (_name, tamper) => {
    const { o } = await committedNotBroadcast(`r3-a2-refuse-${seq}`)
    await legacyRevert(o, { dropTerminalRecord: false })
    await tamper(o)

    const seen = await runPass1Until(o)

    expect(broadcasts).toHaveLength(0)
    expect(JSON.stringify(seen.manualReview)).toMatch(/no execution authorization supplied the arbiter signature/)
    expect((await prisma.escrow.findUniqueOrThrow({ where: { id: o.escrowId } })).txReleaseId).toBeNull()
  })

  it('AR2-02 the Outcome is PRESENT but no longer what the round pays: the recorded identity is no substitute for the binding - refused, no broadcast', async () => {
    const { o } = await committedNotBroadcast('r3-a2-present-contradiction')
    // FAULT INJECTION: the durable Outcome of that appeal round names another buyer destination than the round pays
    const outcome = await loadDisputeRulingRecord(o.escrowId, 0)
    const rebound = JSON.parse(JSON.stringify(outcome.outcomeDestinationBinding).split(o.buyerDestination).join(destination('attacker-outcome')))
    await inject(async (tx) => { await tx.semanticTransitionRecord.update({ where: { id: outcome.id }, data: { outcomeDestinationBinding: rebound } }) })

    const seen = await runPass1Until(o)

    expect(broadcasts).toHaveLength(0)
    expect(JSON.stringify(seen.manualReview)).toMatch(/no execution authorization supplied the arbiter signature/)
  })

  it('AR2-02 the transaction is already on the network (crash after broadcast) and the authorization is legacy: converges with no signature and no broadcast', async () => {
    const { o, round } = await committedNotBroadcast('r3-a2-on-chain')
    await legacyRevert(o, { dropTerminalRecord: false })
    await forgetIdentity(o)
    const roundTxid = bitcoin.Transaction.fromBuffer(Buffer.from(bitcoin.Psbt.fromBase64(round.unsignedPsbtBase64, { network: NET }).data.globalMap.unsignedTx.toBuffer())).getId()
    const stub = global.fetch
    global.fetch = (async (url: string, init?: any) => (String(url).includes(`/tx/${roundTxid}/status`)
      ? { ok: true, json: async () => ({ confirmed: true, block_height: 101 }) } as any
      : (stub as any)(url, init))) as any

    await runPass1Until(o)

    expect(broadcasts).toHaveLength(0)
    expect((await prisma.escrow.findUniqueOrThrow({ where: { id: o.escrowId } })).txReleaseId).toBe(roundTxid)
  })

  // ─── AR2-03: the round row's destination copy is metadata; the transaction is what pays ──────────────────────

  /** The live flow paused at construction while a round of the same ruling is persisted with a chosen payout/copy. */
  async function liveFlowMeetsRound(label: string, payTo: (o: Opened) => string, copy: (o: Opened) => string) {
    const o = await openedDispute(label)
    chain(o.txid)
    const pause = hold(multisigProvider, 'buildUnsignedRelease', forEscrow(o))
    const live = settle(resolve(o, 'RELEASE')())
    await pause.atPause
    const round = await persistRound(o, { kind: 'release', payTo: payTo(o) })
    await inject(async (tx) => { await tx.escrowPendingTransaction.update({ where: { id: round.id }, data: { toAddress: copy(o) } }) })
    pause.go()
    return { o, round, result: await live }
  }

  it('AR2-03 a stale destination copy over a transaction that pays the Outcome: the live flow succeeds, the ruling stands, the round pays the Outcome destination', async () => {
    const { o, round, result } = await liveFlowMeetsRound('r3-a3-copy', (x) => x.buyerDestination, () => destination('documentary-only'))

    expect(result.ok).toBe(true)
    expect(await effects(o)).toMatchObject({ dispute: 'RESOLVED', ruling: 'RELEASE', outcome: 'present', roundIds: [round.id] })
    chain(o.txid)
    expect((await submitTransactionSignature(o.escrowId, o.buyerId, sign(round.unsignedPsbtBase64, buyerKey))).complete).toBe(true)
    expect(paidTo()).toEqual([[o.buyerDestination]])
    await verifyBroadcastWitness(o, pubHex(buyerKey))
  })

  it('AR2-03 a correct destination copy over a transaction that pays someone else: refused (error, ruling preserved) and never executed', async () => {
    const { o, round, result } = await liveFlowMeetsRound('r3-a3-psbt', () => destination('attacker-r3'), (x) => x.buyerDestination)

    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toMatch(/AUD-1 binding/)
    expect(await effects(o)).toMatchObject({ dispute: 'RESOLVED', ruling: 'RELEASE', outcome: 'present', roundIds: [round.id] })
    chain(o.txid)
    const exec = await settle(submitTransactionSignature(o.escrowId, o.buyerId, sign(round.unsignedPsbtBase64, buyerKey)))
    expect(exec.ok).toBe(false)
    expect(broadcasts).toHaveLength(0)
  })

  it('AR2-03 recovery of the stale-copy round (claimed, crash before broadcast): PASS 1 pays the Outcome destination once', async () => {
    const { o, round, result } = await liveFlowMeetsRound('r3-a3-recovery', (x) => x.buyerDestination, () => destination('documentary-only-2'))
    expect(result.ok).toBe(true)
    await prisma.escrowTransactionSignature.create({ data: { pendingTxId: round.id, participantId: o.buyerId, signedPsbtBase64: sign(round.unsignedPsbtBase64, buyerKey) } })
    await authorizeDisputedPendingExecution(await roundOf(o)) // the stored row, with its stale copy (the digest covers it)
    await prisma.escrow.update({ where: { id: o.escrowId }, data: { status: 'COMPLETED' } }) // FAULT INJECTION: claimed, then the process died
    chain(o.txid)

    await runPass1Until(o)
    await runPass1Until(o)

    expect(paidTo()).toEqual([[o.buyerDestination]])
    await verifyBroadcastWitness(o, pubHex(buyerKey))
  })

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // AUD1X-R4 - the revert of a committed ruling deletes ITS Outcome, and only if it was reverted
  //
  // Finding A (Gatekeeper, independent review of #440/#441): the failure handler of the live resolve flow ran
  //   updateMany(dispute WHERE status/ruling/arbiter/round/signature = this ruling)   <- result not looked at
  //   revertDisputeRulingRecord(escrow, round)                                        <- unconditional, by round only
  // so when the update matched nothing (the dispute no longer holds THIS ruling: another ruling of the same round, an
  // appeal's later generation, any other writer) the delete still removed whatever record sat at (escrow, round).
  // Every scenario below is real PostgreSQL and the production services; each fault injection is named.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════

  const disputeRowOf = (o: Opened) => prisma.dispute.findUniqueOrThrow({ where: { id: o.disputeId } })

  // The database is shared with the other suites of the lane (multisigScriptAuthority's PREFLIGHT counts every escrow
  // without a script-committed arbiter identity): what a probe removes to reach a legacy shape it puts back.
  const removedArbiterCommitments: Array<{ escrowId: string; role: string; participantId: string; pubkey: string }> = []
  afterEach(async () => {
    while (removedArbiterCommitments.length) {
      const row = removedArbiterCommitments.pop()!
      await prisma.escrowParticipantKey.create({ data: row })
    }
  })

  /** Every durable fact a revert (or a refused revert) could move: the dispute, both rounds' Outcome records, effects, events. */
  async function revertSnapshot(o: Opened) {
    const d = await disputeRowOf(o)
    const record = async (round: number) => {
      const r = await loadDisputeRulingRecord(o.escrowId, round)
      return r ? { proof: r.attributionRawProof as string, ruling: (r.outcomeContent as any)?.ruling as string } : null
    }
    return {
      dispute: { status: d.status as string, ruling: d.ruling as string | null, round: d.appealRound, signature: d.authoritySignature as string | null, arbiter: d.arbiterId as string | null },
      outcome0: await record(0),
      outcome1: await record(1),
      effects: await effects(o),
      escrowEvents: await prisma.escrowEvent.count({ where: { escrowId: o.escrowId } }),
    }
  }

  /** The names of the events emitted from now on (the real bus still receives them). */
  function emittedEvents(): () => string[] {
    const { eventBus } = require('../../src/common/events/event-bus')
    const names: string[] = []
    const real = eventBus.emit.bind(eventBus)
    jest.spyOn(eventBus, 'emit').mockImplementation(async (...args: any[]) => { names.push(String(args[0])); return real(...args) })
    return () => names
  }

  /**
   * The live resolve flow, held right after the Core-authoritative commit (dispute RESOLVED with this signature, its
   * Outcome record durable, locks released) and before its dispatch builds anything: the exact window in which the
   * failure handler of that call later runs.
   */
  async function pausedAfterCommit(label: string) {
    const o = await openedDispute(label)
    chain(o.txid)
    const priorStatus = (await disputeRowOf(o)).status as string
    const pause = hold(multisigProvider, 'buildUnsignedRelease', forEscrow(o))
    const live = settle(resolve(o, 'RELEASE')())
    await pause.atPause
    const committed = await disputeRowOf(o)
    expect(committed).toMatchObject({ status: 'RESOLVED', ruling: 'RELEASE' })
    return {
      o, priorStatus, live, signature: committed.authoritySignature as string,
      /** the dispatch of THIS call fails: its failure handler decides and reverts */
      failDispatch: () => { pause.fail(new Error('injected: the dispatch of this ruling failed')); return live },
    }
  }

  /** Waits until some backend is queued behind an advisory lock (a deterministic barrier, no sleeping on a guess). */
  async function waitForLockWaiter(until?: () => boolean, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const [{ n }] = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`
      if (Number(n) >= 1 || (until && until())) return Number(n)
      if (Date.now() > deadline) throw new Error('no backend ever queued behind an advisory lock')
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  /**
   * A row lock on the Outcome record of this escrow, held by a connection that is none of the handler's: the handler's
   * DELETE queues behind it - at exactly the statement under test, whatever the code around it looks like. `then` runs
   * inside the holder's transaction right before it commits (so a change made there is what the queued DELETE then
   * re-evaluates its predicate against, as PostgreSQL does for a row updated by a concurrent committed transaction).
   */
  function holdRecordRowLock(o: Opened, then?: (tx: any) => Promise<void>) {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let locked!: () => void
    const held = new Promise<void>((r) => { locked = r })
    const done = prisma.$transaction(async (tx: any) => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`
      await tx.$queryRaw`SELECT id FROM semantic_transition_records WHERE "interactionId" = ${o.escrowId} FOR UPDATE`
      locked()
      await gate
      if (then) await then(tx)
    }, { timeout: 120_000, maxWait: 30_000 })
    return { held, release, done }
  }

  /** Waits until the revert's DELETE of the Outcome record is queued behind a lock: the handler holds D and E and has reverted the dispute row. */
  async function waitForRecordDeletionBlocked(timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const [{ n }] = await prisma.$queryRaw<{ n: bigint }[]>`
        SELECT count(*)::bigint AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query ILIKE 'DELETE FROM%semantic_transition_records%'`
      if (Number(n) >= 1) return
      if (Date.now() > deadline) throw new Error('the handler never reached the deletion of the Outcome record')
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  it('R4-1 the dispute no longer holds this ruling (update matches nothing) while its Outcome record exists: nothing is deleted, nothing is reverted, the call fails', async () => {
    const { o, failDispatch } = await pausedAfterCommit('r4-count0')
    const events = emittedEvents()
    // FAULT INJECTION: another writer moved the dispute off this ruling (status/signature) and left the record behind
    await inject(async (tx) => { await tx.dispute.update({ where: { id: o.disputeId }, data: { status: 'OPENED', ruling: null, resolvedAt: null, authoritySignature: null, authorityIssuedAt: null, authorityBuyerBps: null } }) })
    const before = await revertSnapshot(o)
    expect(before.outcome0).not.toBeNull()

    const result = await failDispatch()

    expect(result.ok).toBe(false)
    // fail-closed AND diagnosable: the refusal names what it protected and carries the dispatch failure it replaced
    expect(!result.ok && result.error).toMatch(/no longer holds the ruling this call committed.*no Outcome record was deleted.*injected: the dispatch of this ruling failed/)
    expect(await revertSnapshot(o)).toEqual(before) // the dispute and its Outcome stand; no effect, no event row, no broadcast
    expect(events()).not.toContain('dispute.resolved')
  })

  it('R4-2 the update matches exactly this ruling and the record is its own: the revert is applied once and completely, and the ruling can be redriven after a restart', async () => {
    const { o, priorStatus, signature, failDispatch } = await pausedAfterCommit('r4-count1')
    const events = emittedEvents()
    const record = await loadDisputeRulingRecord(o.escrowId, 0)
    expect(record.attributionRawProof).toBe(signature) // the record carries the authority it was committed under

    const result = await failDispatch()

    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toMatch(/injected: the dispatch of this ruling failed/)
    expect(await revertSnapshot(o)).toMatchObject({
      dispute: { status: priorStatus, ruling: null, signature: null }, outcome0: null, outcome1: null,
      effects: { escrow: 'DISPUTED', roundIds: [], authorizations: 0, broadcasts: 0, signatures: 0 },
    })
    expect(events()).not.toContain('dispute.resolved')

    // restart + redrive: the arbiter's own re-submission of the same decision commits again and executes once
    chain(o.txid)
    await resolve(o, 'RELEASE')()
    const round = await roundOf(o)
    expect((await restarted!.submitTransactionSignature(o.escrowId, o.buyerId, sign(round.unsignedPsbtBase64, buyerKey))).complete).toBe(true)
    expect(broadcasts).toHaveLength(1)
    expect(paidTo()[0]).toEqual([o.buyerDestination])
  })

  it('R4-3 generation N+1: an appeal supersedes the ruling while its dispatch is held; the failing call of generation N neither reverts nor erases anything of N+1, nor the record of N', async () => {
    const { o, signature, failDispatch } = await pausedAfterCommit('r4-generation')
    const events = emittedEvents()
    // production appeal (the escrow's arbiter commitment removed with its trigger bypassed: the legacy shape appeal() accepts) and the production commit of generation 1
    await inject(async (tx) => {
      const commitment = await tx.escrowParticipantKey.findUnique({ where: { escrowId_role: { escrowId: o.escrowId, role: 'arbiter' } } })
      if (commitment) removedArbiterCommitments.push({ escrowId: commitment.escrowId, role: commitment.role, participantId: commitment.participantId, pubkey: commitment.pubkey })
      await tx.escrowParticipantKey.deleteMany({ where: { escrowId: o.escrowId, role: 'arbiter' } })
    })
    const { DisputeService } = require('../../src/modules/open-settlement/dispute.service')
    const service = new DisputeService({ name: 'r4-stub', arbitrators: [ARBITER_ID, ARBITER2_ID], async assign() { return ARBITER_ID }, async assignAppealPanel() { return ARBITER2_ID } })
    const appealed = await service.appeal(o.disputeId, o.buyerId)
    expect(appealed.dispute).toMatchObject({ status: 'APPEALED', appealRound: 1, arbiterId: ARBITER2_ID })
    const payload = { disputeId: o.disputeId, escrowId: o.escrowId, appealRound: 1, authorityId: ARBITER2_ID, outcome: 'REFUND', buyerBps: null, issuedAt: new Date().toISOString() }
    const secondSignature = signAuthorityDecision(payload, arbiter2Kp.secretKey)
    const committed = await commitAuthoritativeDisputeRuling(
      { id: o.disputeId, escrowId: o.escrowId, status: 'APPEALED', appealRound: 1 },
      payload, secondSignature, pubHex(arbiter2Kp), '100000', 'BTC', o.buyerId, o.sellerId,
    )
    expect(committed.committed).toBe(true)
    const before = await revertSnapshot(o)
    expect(before.dispute).toMatchObject({ status: 'RESOLVED', round: 1, ruling: 'REFUND', signature: secondSignature })
    expect(before.outcome0?.proof).toBe(signature)
    expect(before.outcome1?.proof).toBe(secondSignature)

    const result = await failDispatch()

    expect(result.ok).toBe(false)
    expect(await revertSnapshot(o)).toEqual(before) // generation 1 untouched; generation 0's record is history, not erased
    expect(events()).not.toContain('dispute.resolved')
  })

  it('R4-4 the same appeal round, the same ruling and the same arbiter, signed AGAIN: its dispute and its Outcome stand, the failing call of the earlier signature changes nothing, and the standing ruling is then executed after a restart', async () => {
    const { o, signature, failDispatch } = await pausedAfterCommit('r4-signature')
    const events = emittedEvents()
    // FAULT INJECTION: the earlier code's revert of the first ruling (dispute reopened, its records deleted); the arbiter then
    // re-signs the same decision for the same appeal round (production commit: another signature, another Outcome record at
    // the same key) - the only thing that tells the two authorities apart is the signed authority itself
    await legacyRevert(o, { dropTerminalRecord: false })
    await commitOnly(o, 'RELEASE')
    const standing = await disputeRowOf(o)
    expect(standing).toMatchObject({ status: 'RESOLVED', ruling: 'RELEASE', appealRound: 0, arbiterId: o.arbiterId })
    expect(standing.authoritySignature).not.toBe(signature)
    const before = await revertSnapshot(o)
    expect(before.outcome0).toEqual({ proof: standing.authoritySignature, ruling: 'RELEASE' })

    const result = await failDispatch()

    expect(result.ok).toBe(false)
    expect(await revertSnapshot(o)).toEqual(before) // the Outcome of the standing ruling was not deleted by another authority's failure
    expect(events()).not.toContain('dispute.resolved')

    // restart + redrive: C4 dispatches the standing ruling; the buyer completes it; one broadcast, to the buyer
    chain(o.txid)
    await c4Until(o)
    const round = await roundOf(o)
    expect(round).toMatchObject({ kind: 'release', rulingOutcome: 'RELEASE', rulingAuthoritySignature: standing.authoritySignature })
    chain(o.txid)
    expect((await restarted!.submitTransactionSignature(o.escrowId, o.buyerId, sign(round.unsignedPsbtBase64, buyerKey))).complete).toBe(true)
    expect(broadcasts).toHaveLength(1)
    expect(paidTo()[0]).toEqual([o.buyerDestination])
  })

  it('R4-4b the same appeal round now holds ANOTHER RULING (REFUND, signed after the RELEASE): the standing dispute and Outcome are not touched by the failing RELEASE call', async () => {
    const { o, failDispatch } = await pausedAfterCommit('r4-ruling')
    // FAULT INJECTION: as R4-4, but the standing authority rules the opposite disposition
    await legacyRevert(o, { dropTerminalRecord: false })
    await commitOnly(o, 'REFUND')
    const standing = await disputeRowOf(o)
    expect(standing).toMatchObject({ status: 'RESOLVED', ruling: 'REFUND', appealRound: 0 })
    const before = await revertSnapshot(o)

    const result = await failDispatch()

    expect(result.ok).toBe(false)
    expect(await revertSnapshot(o)).toEqual(before)
  })

  it('R4-5 the Outcome record is replaced between the decision and the deletion: the record of the other authority is not deleted and the dispute revert is rolled back with it', async () => {
    const { o, signature, failDispatch } = await pausedAfterCommit('r4-substituted')
    const events = emittedEvents()
    // FAULT INJECTION, from a connection that holds none of the handler's locks: after the handler decided and reverted the
    // dispute row, and while its DELETE of the record is queued, the record at (escrow, round) becomes another authority's
    const lock = holdRecordRowLock(o, async (tx) => {
      await tx.semanticTransitionRecord.updateMany({ where: { interactionId: o.escrowId }, data: { attributionRawProof: 'another-authority-signature' } })
    })
    await lock.held
    const before = await revertSnapshot(o)
    const versionsBefore = await rowVersions(o)
    expect(before.outcome0?.proof).toBe(signature)

    const live = failDispatch()
    await waitForRecordDeletionBlocked()
    lock.release()
    await lock.done
    const result = await live

    expect(result.ok).toBe(false)
    const after = await revertSnapshot(o)
    expect(after.dispute).toEqual(before.dispute) // no partial revert: the dispute still holds the ruling
    // storage level: the handler's UPDATE of the dispute ran and was rolled back - the live version is still the original one
    expect((await rowVersions(o)).dispute).toBe(versionsBefore.dispute)
    expect(after.outcome0).toEqual({ proof: 'another-authority-signature', ruling: 'RELEASE' }) // the other authority's record stands
    expect(after.effects).toEqual(before.effects)
    expect(events()).not.toContain('dispute.resolved')
  })

  it('R4-6 C4 and the failure handler: C4 queued behind the handler (which holds D and E mid-revert) builds nothing from the ruling being reverted', async () => {
    const { o, priorStatus, failDispatch } = await pausedAfterCommit('r4-c4')
    chain(o.txid)
    let c4Settled = false
    const lock = holdRecordRowLock(o)
    await lock.held
    const live = failDispatch()
    await waitForRecordDeletionBlocked() // the handler holds D then E, has reverted the dispute row and not yet the record
    const c4 = reconcileMissingDispatch().then((v: any) => { c4Settled = true; return v })
    await waitForLockWaiter(() => c4Settled)
    lock.release()
    await lock.done

    const [result] = await Promise.all([live, c4])

    expect(result.ok).toBe(false)
    expect(await revertSnapshot(o)).toMatchObject({
      dispute: { status: priorStatus, ruling: null, signature: null }, outcome0: null,
      effects: { roundIds: [], authorizations: 0, broadcasts: 0, signatures: 0, escrow: 'DISPUTED' },
    })
  })

  it('R4-7 the ST-1 cleanup of a stale round of an earlier ruling, started while the handler holds D and E: no deadlock, no extra effect, a consistent end state', async () => {
    const { o, priorStatus, signature, failDispatch } = await pausedAfterCommit('r4-cleanup')
    const stale = await persistRound(o, { kind: 'release', payTo: o.buyerDestination, authoritySignature: 'an-earlier-reverted-ruling' })
    const generation = { disputeId: stale.disputeId, rulingAppealRound: stale.rulingAppealRound, rulingArbiterId: stale.rulingArbiterId, rulingOutcome: stale.rulingOutcome, rulingAuthoritySignature: stale.rulingAuthoritySignature, rulingAuthorityIssuedAt: stale.rulingAuthorityIssuedAt }
    await prisma.escrowPendingTransaction.update({ where: { id: stale.id }, data: { createdAt: new Date(Date.now() - 10 * 60 * 1000) } })
    expect((await revertSnapshot(o)).outcome0?.proof).toBe(signature)
    const lock = holdRecordRowLock(o)
    await lock.held
    const live = failDispatch()
    await waitForRecordDeletionBlocked()
    let cleanupSettled = false
    const cleanup = settle(deletePendingRoundIfStillUnsigned(stale.id, o.escrowId, generation)).then((v) => { cleanupSettled = true; return v })
    await waitForLockWaiter(() => cleanupSettled)
    lock.release()
    await lock.done

    const [result, cleaned] = await Promise.all([live, cleanup])

    expect(result.ok).toBe(false)
    // it completed (no deadlock, no lock timeout) and decided under the authority it proved: a round of an earlier
    // ruling is deleted or rejected by provenance, never "guard passed" and never left to sign
    expect(cleaned.ok && ['DELETED', 'ALREADY_GONE', 'PROVENANCE_REJECTED']).toContain(cleaned.ok ? cleaned.v : undefined)
    const after = await revertSnapshot(o)
    expect(after.dispute).toMatchObject({ status: priorStatus, ruling: null, signature: null })
    expect(after.outcome0).toBeNull()
    expect(after.effects).toMatchObject({ authorizations: 0, broadcasts: 0, signatures: 0, escrow: 'DISPUTED' })
  })

  it('R4-8 two attempts to revert the same committed ruling at once (the unit the handler uses): exactly one reverts, the other is refused and changes nothing, no deadlock', async () => {
    const authority = require('../../src/modules/open-settlement/ruling-dispatch-authority')
    const { o, priorStatus, signature, failDispatch } = await pausedAfterCommit('r4-twice')
    const dispute = await disputeRowOf(o)
    const attempt = () => prisma.$transaction(async (tx: any) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${economicDispositionLockKey(o.disputeId)})::bigint)`
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${o.escrowId})::bigint)`
      await authority.revertCommittedRuling(tx, {
        disputeId: o.disputeId, escrowId: o.escrowId, appealRound: dispute.appealRound, arbiterId: dispute.arbiterId, ruling: 'RELEASE', authoritySignature: signature,
      }, { status: priorStatus, ruling: null, resolvedAt: null, authoritySignature: null, authorityIssuedAt: null, authorityBuyerBps: null }, new Error('injected'))
    })

    const settled = await Promise.allSettled([attempt(), attempt()])

    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1)
    expect(settled.filter((s) => s.status === 'rejected')).toHaveLength(1)
    expect(await revertSnapshot(o)).toMatchObject({ dispute: { status: priorStatus, ruling: null, signature: null }, outcome0: null })
    expect((await failDispatch()).ok).toBe(false) // the original call still fails cleanly (its own revert finds nothing to do)
    expect(await revertSnapshot(o)).toMatchObject({ dispute: { status: priorStatus, ruling: null }, outcome0: null, effects: { authorizations: 0, broadcasts: 0, roundIds: [] } })
  })

  it('R4-9 a record that carries no attribution at all is not "this ruling\'s": it is not deleted either', async () => {
    const { o, failDispatch } = await pausedAfterCommit('r4-noproof')
    // FAULT INJECTION: a record whose proof column was never written (the column is nullable)
    await inject(async (tx) => { await tx.semanticTransitionRecord.updateMany({ where: { interactionId: o.escrowId }, data: { attributionRawProof: null } }) })
    const before = await revertSnapshot(o)
    const versionsBefore = await rowVersions(o)

    const result = await failDispatch()

    expect(result.ok).toBe(false)
    const after = await revertSnapshot(o)
    expect(after.dispute).toEqual(before.dispute)
    expect(await rowVersions(o)).toEqual(versionsBefore) // storage level: neither the dispute nor the record was rewritten by a committed transaction
    expect(await prisma.semanticTransitionRecord.count({ where: { interactionId: o.escrowId } })).toBe(1)
  })

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // AUD1X-R4 final negative proof
  //   - the revert is atomic at the storage level (xmin: a committed rewrite of a row would change it),
  //   - when the dispute stops holding the ruling BETWEEN the decision and the update (signature or generation),
  //   - a dispatch-translation guard failure caused by a controlled divergence between the dispute's authority and the Outcome.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════

  /** The version stamp (xmin) of the live rows a revert could rewrite. A committed new version of a row changes it; a rolled-back one does not. */
  async function rowVersions(o: Opened) {
    const [d] = await prisma.$queryRaw<{ xmin: string }[]>`SELECT xmin::text AS xmin FROM disputes WHERE id = ${o.disputeId}`
    const records = await prisma.$queryRaw<{ appealRound: number; xmin: string }[]>`
      SELECT "appealRound", xmin::text AS xmin FROM semantic_transition_records WHERE "interactionId" = ${o.escrowId} ORDER BY "appealRound"`
    return { dispute: d.xmin, records }
  }

  /**
   * A row lock on the DISPUTE row held by a separate connection, released only on demand: the handler's conditional UPDATE
   * queues behind it, i.e. exactly between its decision and its update. `then` runs in the holder's transaction right before
   * it commits, so the handler's UPDATE re-evaluates its predicate against the row version the holder wrote.
   */
  function holdDisputeRowLock(o: Opened, then: (tx: any) => Promise<void>) {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let locked!: () => void
    const held = new Promise<void>((r) => { locked = r })
    let xid = ''
    const done = prisma.$transaction(async (tx: any) => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`
      await tx.$queryRaw`SELECT id FROM disputes WHERE id = ${o.disputeId} FOR UPDATE`
      const [{ x }] = await tx.$queryRaw<{ x: string }[]>`SELECT (txid_current() % 4294967296)::text AS x`
      xid = x
      locked()
      await gate
      await then(tx)
    }, { timeout: 120_000, maxWait: 30_000 })
    return { held, release, done, xid: () => xid }
  }

  /** Waits until the handler's UPDATE of the dispute is queued behind a lock. */
  async function waitForDisputeUpdateBlocked(timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const [{ n }] = await prisma.$queryRaw<{ n: bigint }[]>`
        SELECT count(*)::bigint AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query ILIKE 'UPDATE%disputes%'`
      if (Number(n) >= 1) return
      if (Date.now() > deadline) throw new Error('the handler never reached the update of the dispute row')
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  it.each([
    ['another authority signed this round and took over the slot (dispute signature and record both replaced)', 'signature'],
    ['an appeal advanced the dispute to the next generation', 'generation'],
  ] as const)('R4-11 between the decision and the update, %s: the update matches nothing - the call fails, the handler writes nothing at all (xmin) and the record of the generation it knew stays', async (_name, kind) => {
    const { o, signature, failDispatch } = await pausedAfterCommit(`r4-between-${kind}`)
    const events = emittedEvents()
    const takeOver = 'another-authority-signature'
    const lock = holdDisputeRowLock(o, async (tx) => {
      if (kind === 'signature') {
        await tx.dispute.update({ where: { id: o.disputeId }, data: { authoritySignature: takeOver } })
        await tx.semanticTransitionRecord.updateMany({ where: { interactionId: o.escrowId }, data: { attributionRawProof: takeOver } })
      } else {
        await tx.dispute.update({ where: { id: o.disputeId }, data: { status: 'APPEALED', appealRound: 1, ruling: null, resolvedAt: null, authoritySignature: null, authorityIssuedAt: null, authorityBuyerBps: null, arbiterId: ARBITER2_ID } })
      }
    })
    await lock.held
    const escrowEventsBefore = await prisma.escrowEvent.count({ where: { escrowId: o.escrowId } })
    const effectsBefore = await effects(o)

    const live = failDispatch()
    await waitForDisputeUpdateBlocked() // the handler decided REVERT and is now queued on the UPDATE of the dispute row
    lock.release()
    await lock.done
    const result = await live

    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toMatch(/no longer holds the ruling this call committed.*no Outcome record was deleted.*injected: the dispatch of this ruling failed/)
    const after = await revertSnapshot(o)
    expect(after.dispute).toMatchObject(kind === 'signature'
      ? { status: 'RESOLVED', ruling: 'RELEASE', round: 0, signature: takeOver }
      : { status: 'APPEALED', ruling: null, round: 1, signature: null })
    expect(after.outcome0).toEqual({ proof: kind === 'signature' ? takeOver : signature, ruling: 'RELEASE' }) // the record of the generation the handler knew was not deleted
    expect(after.effects).toEqual({ ...effectsBefore, dispute: after.effects.dispute, ruling: after.effects.ruling })
    expect(await prisma.escrowEvent.count({ where: { escrowId: o.escrowId } })).toBe(escrowEventsBefore)
    expect(events()).not.toContain('dispute.resolved')
    // storage level: the dispute row's live version is the holder's, no later transaction wrote it
    const versions = await rowVersions(o)
    expect(versions.dispute).toBe(lock.xid())
  })

  // ─── a translation-guard failure caused by a controlled divergence between the dispute's authority and the Outcome ───

  /** True when this tree contains the Gatekeeper's ST1-R2 guard-failure handling (#436); false for the stack alone. */
  const hasGatekeeperGuardHandling = () =>
    (require('fs') as typeof import('fs')).readFileSync(require('path').join(__dirname, '../../src/modules/open-settlement/dispute.service.ts'), 'utf8').includes('St1R2DeletionRefused')

  /**
   * FAULT INJECTION, deterministic and in-line: while the live flow reads the Outcome it is about to dispatch against
   * (assertDisputeDispatchEligible), the durable Outcome's buyer destination is another address - and restored right after.
   * The flow therefore judges the translation against an Outcome that differs from the durable one: the dispute's authority
   * (the signed ruling) and the Outcome it dispatches disagree, the construction (which re-reads the durable Outcome under
   * its own locks) accepts the real transaction, and the post-construction guard rejects it. This is the only way the guard
   * fails since AUD-1; it cannot happen with an honest Outcome.
   */
  function divergentOutcomeRead(o: Opened) {
    const dispatchMod = require('../../src/modules/open-settlement/dispute-dispatch')
    const real = dispatchMod.assertDisputeDispatchEligible
    let once = true
    jest.spyOn(dispatchMod, 'assertDisputeDispatchEligible').mockImplementation(async (...args: any[]) => {
      if (!once || args[0] !== o.escrowId) return real(...args)
      once = false
      const row = await prisma.semanticTransitionRecord.findFirstOrThrow({ where: { interactionId: o.escrowId } })
      const original = row.outcomeDestinationBinding
      const divergent = JSON.parse(JSON.stringify(original).split(o.buyerDestination).join(destination('divergent-outcome-destination')))
      await inject(async (tx) => { await tx.semanticTransitionRecord.update({ where: { id: row.id }, data: { outcomeDestinationBinding: divergent } }) })
      try { return await real(...args) } finally {
        await inject(async (tx) => { await tx.semanticTransitionRecord.update({ where: { id: row.id }, data: { outcomeDestinationBinding: original } }) })
      }
    })
  }

  it('R4-12 the post-construction translation guard fails on a controlled divergence between the dispute\'s authority and the Outcome: with the Gatekeeper\'s guard handling the dispute, the Outcome, the generation and the round are preserved whole; without it the ruling is reverted atomically; both end redrivable', async () => {
    const gatekeeper = hasGatekeeperGuardHandling()
    const o = await openedDispute('r4-guard')
    chain(o.txid)
    divergentOutcomeRead(o)
    const events = emittedEvents()
    const dispute0 = await disputeRowOf(o)

    const result = await settle(resolve(o, 'RELEASE')())

    expect(result.ok).toBe(false)
    expect(events()).not.toContain('dispute.resolved')
    const after = await revertSnapshot(o)
    const committed = await disputeRowOf(o)
    expect(after.effects).toMatchObject({ authorizations: 0, signatures: 0, broadcasts: 0, escrow: 'DISPUTED' })
    if (gatekeeper) {
      // #436: the guard rejected the pending round but the exact-generation deletion was refused - nothing is unwound
      expect(!result.ok && result.error).toMatch(/ST1-R2: guard rejected pending .* exact-generation deletion was refused \(GUARD_PASSED\)/)
      expect(after.dispute).toMatchObject({ status: 'RESOLVED', ruling: 'RELEASE', round: 0, arbiter: o.arbiterId })
      expect(committed.authoritySignature).toBeTruthy()
      expect(after.outcome0).toEqual({ proof: committed.authoritySignature, ruling: 'RELEASE' })
      expect(after.effects.roundIds).toHaveLength(1)
      // restart + redrive: the preserved round is valid against the durable Outcome; the buyer completes it; one broadcast, to the buyer
      const round = await roundOf(o)
      expect(round).toMatchObject({ kind: 'release', rulingOutcome: 'RELEASE', rulingAuthoritySignature: committed.authoritySignature, rulingAppealRound: 0 })
      chain(o.txid)
      expect((await restarted!.submitTransactionSignature(o.escrowId, o.buyerId, sign(round.unsignedPsbtBase64, buyerKey))).complete).toBe(true)
      expect(broadcasts).toHaveLength(1)
      expect(paidTo()[0]).toEqual([o.buyerDestination])
    } else {
      // the stack alone: the guard failure deletes the unsigned round and the generic revert undoes the ruling - atomically, with its own record only
      expect(after.dispute).toMatchObject({ status: dispute0.status, ruling: null, signature: null })
      expect(after.outcome0).toBeNull()
      expect(after.effects.roundIds).toEqual([])
      // restart + redrive: the arbiter's own re-submission of the same decision commits again and executes once
      chain(o.txid)
      await resolve(o, 'RELEASE')()
      const round = await roundOf(o)
      expect((await restarted!.submitTransactionSignature(o.escrowId, o.buyerId, sign(round.unsignedPsbtBase64, buyerKey))).complete).toBe(true)
      expect(broadcasts).toHaveLength(1)
      expect(paidTo()[0]).toEqual([o.buyerDestination])
    }
  })

  it('R4-13 the post-construction guard fails and the persisted round REALLY diverges from the durable Outcome (so the round is deleted): the ruling is then reverted atomically with its own record - the same end state with and without the Gatekeeper\'s guard handling - and the ruling is redrivable after a restart', async () => {
    const o = await openedDispute('r4-guard-deleted')
    chain(o.txid)
    const events = emittedEvents()
    const priorStatus = (await disputeRowOf(o)).status as string
    // FAULT INJECTION 1 (after the construction persisted a valid round): the DURABLE Outcome now names another buyer destination, so the
    // stored transaction no longer corresponds to it when the cleanup / the guard re-evaluate it from durable state.
    const escrowMod = require('../../src/modules/open-settlement/escrow.service')
    const realInitiate = escrowMod.escrowService.initiateRelease.bind(escrowMod.escrowService)
    jest.spyOn(escrowMod.escrowService, 'initiateRelease').mockImplementation(async (...args: any[]) => {
      const pending = await realInitiate(...args)
      const row = await prisma.semanticTransitionRecord.findFirstOrThrow({ where: { interactionId: o.escrowId } })
      const divergent = JSON.parse(JSON.stringify(row.outcomeDestinationBinding).split(o.buyerDestination).join(destination('divergent-durable-outcome')))
      await inject(async (tx) => { await tx.semanticTransitionRecord.update({ where: { id: row.id }, data: { outcomeDestinationBinding: divergent } }) })
      return pending
    })
    // FAULT INJECTION 2: the guard that runs after the construction (the second call: the first is the construction's own binding) rejects.
    const guardMod = require('../../src/modules/open-settlement/dispatch-translation-guard')
    const realGuard = guardMod.assertTranslationMatchesOutcome
    let calls = 0
    jest.spyOn(guardMod, 'assertTranslationMatchesOutcome').mockImplementation((...args: any[]) => {
      calls += 1
      if (calls === 2) throw new Error('injected: the translation guard rejected the persisted round')
      return realGuard(...args)
    })

    const result = await settle(resolve(o, 'RELEASE')())

    expect(calls).toBe(2)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toMatch(/injected: the translation guard rejected the persisted round/)
    expect(events()).not.toContain('dispute.resolved')
    // the round was deleted (by the exact-generation cleanup with the Gatekeeper's handling, by the plain deletion without it) and the
    // generic revert undid the ruling, deleting the record of the authority that signed it - the same end state in both trees
    expect(await revertSnapshot(o)).toMatchObject({
      dispute: { status: priorStatus, ruling: null, signature: null }, outcome0: null, outcome1: null,
      effects: { escrow: 'DISPUTED', roundIds: [], authorizations: 0, signatures: 0, broadcasts: 0 },
    })

    // restart + redrive: the same signed decision commits again with a sound record, dispatches and executes once
    jest.restoreAllMocks()
    chain(o.txid)
    await resolve(o, 'RELEASE')()
    const round = await roundOf(o)
    expect((await restarted!.submitTransactionSignature(o.escrowId, o.buyerId, sign(round.unsignedPsbtBase64, buyerKey))).complete).toBe(true)
    expect(broadcasts).toHaveLength(1)
    expect(paidTo()[0]).toEqual([o.buyerDestination])
  })
})
