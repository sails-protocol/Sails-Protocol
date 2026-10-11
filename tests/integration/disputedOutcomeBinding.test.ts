// AUD-1 - a signed, durable dispute Outcome is binding economic authority. Real PostgreSQL, production services:
// no path that creates or executes a disputed disposition may execute one that contradicts the Outcome's kind,
// destinations or amounts.
//
// Reproduces audit probes P3 (right after the ST-1 cleanup deleted a stale round) and P3b (the C4 window: Outcome
// committed, round never persisted) - against the production initiate-* path, the production signature path and
// the C8 recovery. Every rejection is accompanied by the economic-effect counts that did not move.
//
// What is real: PostgreSQL; escrow / trade / dispute / payout addresses / participant keys (production services);
// the ruling (resolveDispute() -> commitAuthoritativeDisputeRuling() -> real PSBT translation) or, for the C4 window,
// the production Outcome commit alone; appeal(); initiateRelease/Refund/Split(); submitTransactionSignature();
// reconcileUnclaimedFullySignedPending(); the ST-1 cleanup. What is not: the chain (an explorer stub serving one
// funding UTXO and recording broadcasts) and each fault injection, named where used.
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
const keyOf = (label: string) => ECPair.fromPrivateKey(createHash('sha256').update(`aud1-${label}`).digest())
const pubHex = (k: { publicKey: Uint8Array }) => Buffer.from(k.publicKey).toString('hex')
const destination = (label: string) =>
  bitcoin.payments.p2wpkh({ pubkey: Buffer.from(keyOf(label).publicKey), network: bitcoin.networks.testnet }).address!

describe('AUD-1 disputed economic Outcome binding - real PostgreSQL', () => {
  jest.setTimeout(240_000)

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
  let revertDisputeRulingRecord: (escrowId: string, appealRound: number) => Promise<void>
  let submitTransactionSignature: (escrowId: string, participantId: string, signedPsbtBase64: string) => Promise<any>
  let deletePendingRoundIfStillUnsigned: (pendingId: string, escrowId: string, generation: any) => Promise<string>
  let reconcileUnclaimedFullySignedPending: (report: any) => Promise<void>
  let reconcileMissingDispatch: () => Promise<any>
  let economicDispositionLockKey: (disputeId: string) => string
  let escrowRepository: any
  let loadParticipantPubkeys: (escrowId: string) => Promise<{ buyerPubkey?: string; sellerPubkey?: string; arbiterPubkey?: string }>
  let getSignatureCollectionProvider: (type: string) => any
  let restarted: { prisma: PrismaClient; submitTransactionSignature: typeof submitTransactionSignature; redis: { quit(): Promise<unknown> } } | undefined

  const ARBITER_ID = 'aud1-arbiter-1'
  const ARBITER2_ID = 'aud1-arbiter-2'
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
    process.env.MULTISIG_SEED = process.env.MULTISIG_SEED || 'aud1-seed'
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
    ;({ commitAuthoritativeDisputeRuling, revertDisputeRulingRecord } = require('../../src/modules/open-settlement/dispute-outcome'))
    ;({ submitTransactionSignature } = require('../../src/modules/open-settlement/escrow-pending-tx'))
    ;({ deletePendingRoundIfStillUnsigned } = require('../../src/modules/open-settlement/dispute-pending-reconciliation'))
    ;({ reconcileUnclaimedFullySignedPending } = require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service'))
    ;({ reconcileMissingDispatch } = require('../../src/modules/open-settlement/dispute-dispatch-recovery'))
    ;({ economicDispositionLockKey } = require('../../src/modules/open-settlement/economic-disposition-authority'))
    ;({ escrowRepository } = require('../../src/modules/open-settlement/escrow-repository'))
    ;({ loadParticipantPubkeys } = require('../../src/modules/open-settlement/escrow-lifecycle'))
    ;({ getSignatureCollectionProvider } = require('../../src/modules/open-settlement/escrow-providers'))
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
      await prisma.user.upsert({ where: { id }, update: { publicKey: pubHex(kp) }, create: { id, publicKey: pubHex(kp), displayName: `AUD-1 arbiter ${id}` } })
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

  // ── chain stub: one funding UTXO per escrow; every broadcast is recorded ───────────────────────

  function chain(txid: string): void {
    global.fetch = jest.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'POST' && url.endsWith('/tx')) { broadcasts.push(String(init.body)); return { ok: true, text: async () => 'mock-txid' } as any }
      if (url.includes('/blocks/tip/height')) return { ok: true, text: async () => '100' } as any
      if (url.includes(`/tx/${txid}/status`)) return { ok: true, json: async () => ({ confirmed: true, block_height: 100 }) } as any
      if (url.includes('/v1/fees/recommended')) return { ok: true, json: async () => ({ halfHourFee: 5, fastestFee: 8 }) } as any
      // Any other transaction (a round's own txid) is unknown to the network: the recoveries must ask the gate, not converge.
      if (/\/tx\/[0-9a-f]{64}(\/status)?$/.test(url)) return { ok: false, status: 404, text: async () => 'not found', json: async () => ({}) } as any
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
    const txid = createHash('sha256').update(`aud1-${label}-${Date.now()}-${seq}`).digest('hex')
    chain(txid)
    await escrowService.lockFunds(escrow.id, seller.id)
    const dispute = await getDisputeService().raiseDispute(trade.id, buyer.id, `AUD-1 ${label}`)
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

  /** FAULT INJECTION (used once, to reach the state P3 reached): the stored round no longer pays what the Outcome authorized. */
  async function staleAndClean(o: Opened, pendingId: string): Promise<void> {
    const row = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { id: pendingId } })
    const original = bitcoin.Psbt.fromBase64(row.unsignedPsbtBase64, { network: bitcoin.networks.testnet })
    const input = original.data.inputs[0]
    const copy = new bitcoin.Psbt({ network: bitcoin.networks.testnet })
    copy.addInput({ hash: original.txInputs[0].hash, index: original.txInputs[0].index, witnessUtxo: input.witnessUtxo!, witnessScript: input.witnessScript! })
    copy.addOutput({ address: destination('not-the-beneficiary'), value: BigInt(original.txOutputs[0].value) })
    await prisma.escrowPendingTransaction.update({
      where: { id: pendingId },
      data: { unsignedPsbtBase64: copy.toBase64(), requiredSigners: [o.buyerId, o.sellerId], createdAt: new Date(Date.now() - 600_000) },
    })
    const r = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { id: pendingId } })
    const outcome = await deletePendingRoundIfStillUnsigned(pendingId, o.escrowId, {
      disputeId: r.disputeId, rulingAppealRound: r.rulingAppealRound, rulingArbiterId: r.rulingArbiterId,
      rulingOutcome: r.rulingOutcome, rulingAuthoritySignature: r.rulingAuthoritySignature, rulingAuthorityIssuedAt: r.rulingAuthorityIssuedAt,
    })
    expect(outcome).toBe('DELETED') // the ST-1 cleanup, as audit probe P3 reached it
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

  const sign = async (psbtBase64: string, key: ReturnType<typeof keyOf>) => {
    const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network: bitcoin.networks.testnet })
    psbt.signInput(0, key)
    return psbt.toBase64()
  }

  const paidTo = () => broadcasts.map((hex) => bitcoin.Transaction.fromHex(hex).outs.map((out) => {
    try { return bitcoin.address.fromOutputScript(out.script, bitcoin.networks.testnet) } catch { return 'non-standard' }
  }))

  /**
   * FAULT INJECTION (what earlier code could have persisted): a ROUND CONTRADICTING THE RULING, built by the real
   * provider and carrying the ruling's provenance - exactly the row initiate-refund produced in audit probe P3 -
   * written without going through the construction boundary.
   */
  async function forgeContradictingRound(o: Opened, kind: 'refund' | 'release') {
    const escrow = await escrowRepository.findById(o.escrowId)
    const dispute = await prisma.dispute.findUniqueOrThrow({ where: { id: o.disputeId } })
    const provider = getSignatureCollectionProvider('MULTISIG')
    const keys = await loadParticipantPubkeys(o.escrowId)
    const record = { ...escrow, buyerId: o.buyerId, sellerId: o.sellerId, ...keys, triggeredBy: o.arbiterId }
    chain(o.txid)
    const built = kind === 'refund'
      ? await provider.buildUnsignedRefund(record, o.sellerDestination)
      : await provider.buildUnsignedRelease(record, o.buyerDestination)
    return prisma.escrowPendingTransaction.create({
      data: {
        escrowId: o.escrowId, kind, toAddress: kind === 'refund' ? o.sellerDestination : o.buyerDestination,
        unsignedPsbtBase64: built.psbtBase64, requiredSigners: built.requiredSigners, triggeredBy: o.arbiterId,
        minerFeeSats: built.minerFeeSats, signaturesConfidential: true,
        disputeId: dispute.id, rulingAppealRound: dispute.appealRound, rulingArbiterId: dispute.arbiterId, rulingOutcome: dispute.ruling,
        rulingAuthoritySignature: dispute.authoritySignature, rulingAuthorityIssuedAt: dispute.authorityIssuedAt,
      },
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
    name: 'aud1-stub', arbitrators: [ARBITER_ID, ARBITER2_ID],
    async assign() { return ARBITER_ID },
    async assignAppealPanel() { return ARBITER2_ID },
  })

  // ── lock barrier ────────────────────────────────────────────────────────────────────────────────

  const waitingOnAdvisoryLocks = async () => (await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)[0].n
  async function untilWaiting(n: number) {
    for (let i = 0; i < 1000; i++) {
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

  const REFUSED = /AUD-1|does not correspond to the authoritative Outcome/

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // Reproduction of P3 / P3b, and the construction boundary
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  it('P3 right after the ST-1 cleanup deleted the stale round of a RELEASE ruling, initiate-refund is refused: zero economic effect', async () => {
    const o = await openedDispute('p3')
    const round = await rule(o, 'RELEASE')
    await staleAndClean(o, round.id)
    const before = await effects(o)

    await expect(escrowService.initiateRefund(o.escrowId, o.arbiterId)).rejects.toThrow(REFUSED)

    expect(await effects(o)).toEqual(before)
    expect(before).toMatchObject({ status: 'DISPUTED', rounds: 0, authorizations: 0, broadcasts: 0 })
  })

  it('P3b in the C4 window (Outcome committed, no round, no cleanup involved) initiate-refund is refused; the ruling\'s own RELEASE is still dispatched', async () => {
    const o = await openedDispute('p3b')
    await commitOnly(o, 'RELEASE')
    const before = await effects(o)

    await expect(escrowService.initiateRefund(o.escrowId, o.arbiterId)).rejects.toThrow(REFUSED)
    expect(await effects(o)).toEqual(before)

    // The authorized disposition is not harmed: the C4 resume (the same call) persists the round that matches.
    const resumed = await escrowService.initiateRelease(o.escrowId, o.buyerDestination, o.arbiterId)
    expect(resumed).toMatchObject({ kind: 'release', rulingOutcome: 'RELEASE', disputeId: o.disputeId })
    expect((await effects(o)).rounds).toBe(1)
  })

  it('R reversed direction: a REFUND ruling refuses initiate-release (and any explicit destination), and still dispatches its own REFUND', async () => {
    const o = await openedDispute('rev')
    await commitOnly(o, 'REFUND')
    const before = await effects(o)

    await expect(escrowService.initiateRelease(o.escrowId, undefined, o.arbiterId)).rejects.toThrow(REFUSED)
    await expect(escrowService.initiateRelease(o.escrowId, o.sellerDestination, o.arbiterId)).rejects.toThrow(REFUSED)
    expect(await effects(o)).toEqual(before)

    const resumed = await escrowService.initiateRefund(o.escrowId, o.arbiterId, o.sellerDestination)
    expect(resumed).toMatchObject({ kind: 'refund', rulingOutcome: 'REFUND' })
  })

  it('S a SPLIT ruling refuses release, refund, a different buyer share and different destinations; only the ruled split is persisted', async () => {
    const o = await openedDispute('split')
    await commitOnly(o, 'SPLIT', 6000)
    const before = await effects(o)

    await expect(escrowService.initiateRelease(o.escrowId, o.buyerDestination, o.arbiterId)).rejects.toThrow(REFUSED)
    await expect(escrowService.initiateRefund(o.escrowId, o.arbiterId, o.sellerDestination)).rejects.toThrow(REFUSED)
    await expect(escrowService.initiateSplit(o.escrowId, o.buyerDestination, o.sellerDestination, 9000, o.arbiterId)).rejects.toThrow(REFUSED)
    await expect(escrowService.initiateSplit(o.escrowId, destination('attacker'), o.sellerDestination, 6000, o.arbiterId)).rejects.toThrow(REFUSED)
    expect(await effects(o)).toEqual(before)

    const round = await escrowService.initiateSplit(o.escrowId, o.buyerDestination, o.sellerDestination, 6000, o.arbiterId)
    expect(round).toMatchObject({ kind: 'split', buyerBps: 6000, rulingOutcome: 'SPLIT' })
  })

  it('D an arbiter-chosen destination is not a bypass: initiate-release to an address the Outcome does not name is refused', async () => {
    const o = await openedDispute('dest')
    await commitOnly(o, 'RELEASE')
    const before = await effects(o)
    await expect(escrowService.initiateRelease(o.escrowId, destination('arbiter-wallet'), o.arbiterId)).rejects.toThrow(REFUSED)
    expect(await effects(o)).toEqual(before)
  })

  it('G the former arbiter of an appealed generation gets no round', async () => {
    const o = await openedDispute('gen')
    await commitOnly(o, 'RELEASE')
    await makeAppealable(o)
    await appealService().appeal(o.disputeId, o.buyerId)
    expect((await prisma.dispute.findUniqueOrThrow({ where: { id: o.disputeId } })).status).toBe('APPEALED')
    const before = await effects(o)

    await expect(escrowService.initiateRelease(o.escrowId, o.buyerDestination, o.arbiterId)).rejects.toThrow(/AUD-1|no resolved ruling|Forbidden|not the current assigned arbiter/)
    await expect(escrowService.initiateRefund(o.escrowId, o.arbiterId, o.sellerDestination)).rejects.toThrow()
    expect(await effects(o)).toEqual(before)
  })

  it('W (superseded by AUD1X-H1) before any ruling NO round is built for a disputed MULTISIG escrow - the audit showed such a round was not inert: it carried the arbiter signature', async () => {
    const o = await openedDispute('prior')
    const before = await effects(o)

    await expect(escrowService.initiateRelease(o.escrowId, o.buyerDestination, o.arbiterId)).rejects.toThrow(/AUD-1 \(H1\)/)

    expect(await effects(o)).toEqual(before)
    expect(before).toMatchObject({ status: 'DISPUTED', rounds: 0, authorizations: 0, broadcasts: 0 })
  })

  it('M a ruling whose durable Outcome is absent has no authority to dispatch: construction fails closed', async () => {
    const o = await openedDispute('miss')
    await commitOnly(o, 'RELEASE')
    await revertDisputeRulingRecord(o.escrowId, 0) // production's own deleter of a ruling record
    const before = await effects(o)
    await expect(escrowService.initiateRelease(o.escrowId, o.buyerDestination, o.arbiterId)).rejects.toThrow(/no durable Core-authoritative Outcome/)
    expect(await effects(o)).toEqual(before)
  })

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // The execution boundary judges the stored round independently of construction
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  it('E a contradicting round persisted by earlier code is refused at execution: the seller\'s signature is the last thing that happens', async () => {
    const o = await openedDispute('exec')
    await commitOnly(o, 'RELEASE')
    const forged = await forgeContradictingRound(o, 'refund')
    expect(forged.rulingOutcome).toBe('RELEASE') // provenance of the ruling, the kind of a refund: audit probe P3's row
    const signed = await sign(forged.unsignedPsbtBase64, sellerKey)
    chain(o.txid)
    const before = await effects(o)

    await expect(submitTransactionSignature(o.escrowId, o.sellerId, signed)).rejects.toThrow(REFUSED)

    const after = await effects(o)
    expect(after).toMatchObject({ status: 'DISPUTED', txReleaseId: null, authorizations: 0, broadcasts: 0, transitions: before.transitions })
    expect(paidTo()).toEqual([])
  })

  it('K the kind of a round is part of the authority: a round whose transaction pays the ruled destination but is labelled another disposition is refused (the label would claim the wrong terminal status)', async () => {
    const o = await openedDispute('kind')
    const round = await rule(o, 'RELEASE') // production round: pays the buyer, kind release, single required signer: the buyer
    // FAULT INJECTION: only the label differs; the transaction is exactly what the Outcome authorized.
    await prisma.escrowPendingTransaction.update({ where: { id: round.id }, data: { kind: 'refund' } })
    chain(o.txid)
    const before = await effects(o)

    await expect(submitTransactionSignature(o.escrowId, o.buyerId, await sign(round.unsignedPsbtBase64, buyerKey))).rejects.toThrow(/contradicts the signed ruling RELEASE/)

    expect(await effects(o)).toMatchObject({ status: 'DISPUTED', txReleaseId: null, broadcasts: 0, authorizations: 0, transitions: before.transitions })
  })

  it('E2 an authorization an earlier gate committed for the same contradicting round is not a way around the binding (reuse path)', async () => {
    const o = await openedDispute('reuse')
    await commitOnly(o, 'RELEASE')
    const forged = await forgeContradictingRound(o, 'refund')
    // FAULT INJECTION: the authorization the earlier, generation-only gate would have committed for this round.
    const { economicDispositionOperationDigest } = require('../../src/modules/open-settlement/economic-disposition-authority')
    const dispute = await prisma.dispute.findUniqueOrThrow({ where: { id: o.disputeId } })
    await prisma.economicDispositionAuthorization.create({
      data: {
        pendingOperationId: forged.id, escrowId: o.escrowId, disputeId: o.disputeId, appealRound: 0,
        arbiterId: dispute.arbiterId!, ruling: dispute.ruling!, operationDigest: economicDispositionOperationDigest(forged),
      },
    })
    chain(o.txid)
    const before = await effects(o)

    await expect(submitTransactionSignature(o.escrowId, o.sellerId, await sign(forged.unsignedPsbtBase64, sellerKey))).rejects.toThrow(REFUSED)

    expect(await effects(o)).toMatchObject({ status: 'DISPUTED', txReleaseId: null, broadcasts: 0, authorizations: before.authorizations })
  })

  it('C8 the recovery of a fully signed, unclaimed round passes through the same gate: the contradicting round is never broadcast', async () => {
    const o = await openedDispute('c8')
    await commitOnly(o, 'RELEASE')
    const forged = await forgeContradictingRound(o, 'refund')
    // FAULT INJECTION: the complete signature set was persisted (the crash window C8 recovers).
    await prisma.escrowTransactionSignature.create({
      data: { pendingTxId: forged.id, participantId: o.sellerId, signedPsbtBase64: await sign(forged.unsignedPsbtBase64, sellerKey) },
    })
    chain(o.txid)
    const before = await effects(o)

    // The recovery claims one candidate at a time from the whole (shared) database: run it until this round was reached.
    const report: any = { recovered: [], completionEffectsRecovered: [], requiresManualReview: [], failed: [], resumedUnclaimed: [], alreadyClaimedConcurrently: [], projectionsRecovered: [], completionVerified: [], locksAdvanced: [] }
    for (let i = 0; i < 60; i++) {
      await reconcileUnclaimedFullySignedPending(report)
      const claimed = await prisma.escrowPendingTransaction.findUnique({ where: { id: forged.id }, select: { unclaimedRecoveryAttemptedAt: true } })
      if (claimed?.unclaimedRecoveryAttemptedAt) break
    }
    expect((await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { id: forged.id } })).unclaimedRecoveryAttemptedAt).not.toBeNull()

    const mine = (rows: Array<{ escrowId: string }>) => rows.filter((r) => r.escrowId === o.escrowId)
    expect(mine(report.resumedUnclaimed)).toEqual([])
    expect(mine(report.recovered)).toEqual([])
    expect(JSON.stringify([mine(report.failed), mine(report.requiresManualReview)])).toMatch(REFUSED)
    expect(await effects(o)).toMatchObject({ status: 'DISPUTED', txReleaseId: null, broadcasts: 0, authorizations: before.authorizations })
  })

  it('X1 a round whose durable Outcome is later absent is refused at execution (fail closed), signature kept', async () => {
    const o = await openedDispute('x1')
    const round = await rule(o, 'RELEASE') // production round, single required signer: the buyer
    await revertDisputeRulingRecord(o.escrowId, 0)
    chain(o.txid)
    const before = await effects(o)

    await expect(submitTransactionSignature(o.escrowId, o.buyerId, await sign(round.unsignedPsbtBase64, buyerKey))).rejects.toThrow(/no durable Core-authoritative Outcome/)

    expect(await effects(o)).toMatchObject({ status: 'DISPUTED', txReleaseId: null, broadcasts: 0, authorizations: 0, signatures: before.signatures + 1 })
  })

  it('X2 an Outcome of another ruling than the dispute\'s is inconsistent durable state: refused at execution', async () => {
    const o = await openedDispute('x2')
    const round = await rule(o, 'RELEASE')
    // FAULT INJECTION: the immutable record says REFUND while dispute and round say RELEASE.
    await prisma.$executeRaw`UPDATE semantic_transition_records SET "outcomeContent" = jsonb_set("outcomeContent", '{ruling}', '"REFUND"')
      WHERE "interactionId" = ${o.escrowId} AND "transitionType" = 'escrow.dispute.rule' AND "appealRound" = 0`
    chain(o.txid)
    await expect(submitTransactionSignature(o.escrowId, o.buyerId, await sign(round.unsignedPsbtBase64, buyerKey))).rejects.toThrow(/not the RESOLVED RELEASE transition/)
    expect(await effects(o)).toMatchObject({ status: 'DISPUTED', broadcasts: 0, authorizations: 0 })
  })

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // The rails that settle without a signing round (direct executors): same binding, same authority
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  it('DX a direct executor on a resolved ruling executes only that ruling: refund and split are refused, nothing moves; the ruled release is not harmed', async () => {
    requirePostgres('DX')
    seq += 1
    const uniq = `dx-${Date.now()}-${seq}`
    const seller = await prisma.user.create({ data: { id: `seller-${uniq}`, publicKey: `pk-seller-${uniq}` } })
    const buyer = await prisma.user.create({ data: { id: `buyer-${uniq}`, publicKey: `pk-buyer-${uniq}` } })
    const arbiter = await prisma.user.create({ data: { id: `arbiter-${uniq}`, publicKey: `pk-arbiter-${uniq}` } })
    const offer = await prisma.offer.create({
      data: { id: `offer-${uniq}`, userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER', status: 'ACTIVE' },
    })
    const trade = await prisma.trade.create({
      data: { id: `trade-${uniq}`, offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, amount: '0.001', asset: 'BTC', priceUsd: '60000', totalUsd: '60', status: 'DISPUTED' },
    })
    const escrow = await prisma.escrow.create({
      data: { id: `escrow-${uniq}`, tradeId: trade.id, type: 'MOCK', status: 'DISPUTED', lockedAmount: '0.001', asset: 'BTC', feeCharged: '0' },
    })
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id } })
    await prisma.dispute.create({
      data: {
        id: `dispute-${uniq}`, tradeId: trade.id, escrowId: escrow.id, openedBy: buyer.id, reason: 'AUD-1 direct executor', arbiterId: arbiter.id,
        status: 'RESOLVED', ruling: 'RELEASE', resolvedAt: new Date(), appealRound: 0, authoritySignature: `sig-${uniq}`, authorityIssuedAt: new Date(),
      },
    })
    const events = () => prisma.escrowEvent.count({ where: { escrowId: escrow.id } })
    const before = { status: (await prisma.escrow.findUniqueOrThrow({ where: { id: escrow.id } })).status, events: await events() }

    await expect(escrowService.refundFunds(escrow.id, arbiter.id)).rejects.toThrow(/AUD-1/)
    await expect(escrowService.splitFunds(escrow.id, undefined, undefined, 5000, arbiter.id)).rejects.toThrow(/AUD-1/)
    expect({ status: (await prisma.escrow.findUniqueOrThrow({ where: { id: escrow.id } })).status, events: await events() }).toEqual(before)

    // The disposition the ruling decided is still the arbiter's to execute (it passes the binding; whatever the
    // rail does next - payout address, provider - is unchanged behaviour and not this suite's subject).
    await expect(escrowService.releaseFunds(escrow.id, undefined, arbiter.id)).rejects.not.toThrow(/AUD-1/)
  })

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // Valid flows are preserved
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  it('V the ruled RELEASE is dispatched, signed and executed exactly once, paying the buyer\'s destination; a replay changes nothing', async () => {
    const o = await openedDispute('valid')
    const round = await rule(o, 'RELEASE')
    expect(round).toMatchObject({ kind: 'release', rulingOutcome: 'RELEASE' })
    chain(o.txid)

    const done = await submitTransactionSignature(o.escrowId, o.buyerId, await sign(round.unsignedPsbtBase64, buyerKey))
    expect(done.complete).toBe(true)

    const after = await effects(o)
    expect(after).toMatchObject({ status: 'COMPLETED', broadcasts: 1, authorizations: 1 })
    expect(paidTo()[0]).toContain(o.buyerDestination)
    expect(paidTo()[0]).not.toContain(o.sellerDestination)
    // Replaying the same signature after completion neither re-broadcasts nor authorizes again.
    await submitTransactionSignature(o.escrowId, o.buyerId, await sign(round.unsignedPsbtBase64, buyerKey)).catch(() => undefined)
    expect(await effects(o)).toMatchObject({ status: 'COMPLETED', broadcasts: 1, authorizations: 1 })
  })

  it('V2 the ruled REFUND and the ruled SPLIT execute through the same boundaries', async () => {
    const refund = await openedDispute('v-refund')
    const refundRound = await rule(refund, 'REFUND')
    expect(refundRound).toMatchObject({ kind: 'refund' })
    chain(refund.txid)
    expect((await submitTransactionSignature(refund.escrowId, refund.sellerId, await sign(refundRound.unsignedPsbtBase64, sellerKey))).complete).toBe(true)
    expect(await effects(refund)).toMatchObject({ status: 'REFUNDED', authorizations: 1 })

    const split = await openedDispute('v-split')
    const splitRound = await rule(split, 'SPLIT', 6000)
    expect(splitRound).toMatchObject({ kind: 'split', buyerBps: 6000 })
    chain(split.txid)
    const outcome = await submitTransactionSignature(split.escrowId, splitRound.requiredSigners[0], await sign(splitRound.unsignedPsbtBase64, splitRound.requiredSigners[0] === split.buyerId ? buyerKey : sellerKey))
    expect(outcome.complete).toBe(true)
    expect(await effects(split)).toMatchObject({ status: 'SPLIT', authorizations: 1 })
  })

  it('A the C4 recovery sweep still resumes a ruling whose round never persisted, with the round that matches the Outcome', async () => {
    const o = await openedDispute('c4')
    await commitOnly(o, 'RELEASE')
    chain(o.txid)
    // The sweep is bounded and the database shared: claim until this escrow was reached.
    let claimed = false
    for (let i = 0; i < 40 && !claimed; i++) {
      const report = await reconcileMissingDispatch()
      claimed = report.claimed.includes(o.escrowId)
    }
    expect(claimed).toBe(true)
    const round = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: o.escrowId } })
    expect(round).toMatchObject({ kind: 'release', rulingOutcome: 'RELEASE', disputeId: o.disputeId })
  })

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // Concurrency and restart
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  it('U a committed authorization of a legitimate round stays reusable after a later appeal (ADR-005 s4 idempotency): the binding judges the generation recorded in the authorization', async () => {
    const o = await openedDispute('reuse-ok')
    const round = await rule(o, 'RELEASE')
    const { authorizeDisputedPendingExecution } = require('../../src/modules/open-settlement/economic-disposition-authority')
    const first = await authorizeDisputedPendingExecution(round)
    expect(first).toMatchObject({ pendingOperationId: round.id, ruling: 'RELEASE' })
    await makeAppealable(o)
    await appealService().appeal(o.disputeId, o.buyerId)

    const again = await authorizeDisputedPendingExecution(round)

    expect(again.id).toBe(first.id)
    expect(await prisma.economicDispositionAuthorization.count({ where: { escrowId: o.escrowId } })).toBe(1)
  })

  it('Q1 signer first, appeal second (queued behind the dispute lock): the ruled disposition executes once; the appeal then proceeds', async () => {
    const o = await openedDispute('q1')
    const round = await rule(o, 'RELEASE')
    await makeAppealable(o)
    const signed = await sign(round.unsignedPsbtBase64, buyerKey)
    chain(o.txid)

    const release = await holdD(o)
    const signer = submitTransactionSignature(o.escrowId, o.buyerId, signed)
    await untilWaiting(1)
    const appeal = appealService().appeal(o.disputeId, o.buyerId).then((v: any) => v, (e: Error) => e)
    await untilWaiting(2)
    // AUD1X-H1: the execution needs the escrow's own arbiter commitment (a production escrow always holds it; appeal()'s
    // fixture removes it only for its own pre-check, which has run by now) - give it back before the signer proceeds.
    while (removedCommitments.length) await prisma.escrowParticipantKey.create({ data: removedCommitments.pop()! })
    await release()

    expect((await signer).complete).toBe(true)
    await appeal
    expect(await effects(o)).toMatchObject({ status: 'COMPLETED', broadcasts: 1, authorizations: 1 })
    expect(paidTo()[0]).toContain(o.buyerDestination)
  })

  it('Q2 appeal first, signer second: the superseded generation executes nothing', async () => {
    const o = await openedDispute('q2')
    const round = await rule(o, 'RELEASE')
    await makeAppealable(o)
    const signed = await sign(round.unsignedPsbtBase64, buyerKey)
    chain(o.txid)

    const release = await holdD(o)
    const appeal = appealService().appeal(o.disputeId, o.buyerId)
    await untilWaiting(1)
    const signer = submitTransactionSignature(o.escrowId, o.buyerId, signed).then((v: any) => v, (e: Error) => e)
    await untilWaiting(2)
    await release()

    await appeal
    expect(await signer).toBeInstanceOf(Error)
    expect(await effects(o)).toMatchObject({ status: 'DISPUTED', broadcasts: 0, authorizations: 0 })
  })

  it('RS restart: an independent module graph (own client) judges the contradicting round from durable state alone and refuses it', async () => {
    const o = await openedDispute('restart')
    await commitOnly(o, 'RELEASE')
    const forged = await forgeContradictingRound(o, 'refund')
    const signed = await sign(forged.unsignedPsbtBase64, sellerKey)
    chain(o.txid)

    await expect(restarted!.submitTransactionSignature(o.escrowId, o.sellerId, signed)).rejects.toThrow(REFUSED)

    expect(await effects(o)).toMatchObject({ status: 'DISPUTED', txReleaseId: null, broadcasts: 0, authorizations: 0 })
    // and a second attempt, again from a fresh process view, is refused the same way
    await expect(restarted!.submitTransactionSignature(o.escrowId, o.sellerId, signed)).rejects.toThrow(REFUSED)
  })
})

