// P4 / Gate 3 - RED SPECIFICATION of the option (iii-a) guard on re-creating a disputed pending operation after a
// committed Economic Disposition Authorization (docs/p4-gate3-unknown-outcome-contract.md, section 5).
//
// STATUS: the guard is NOT implemented, no migration exists. These tests are written first and are EXPECTED TO FAIL
// today (R0, R3a, R3b, R4, R5, R6, R7, R9) or to pass as controls (R8, R10). Each failure is classified in its comment:
//   BEHAVIOR - the guard's decision is missing (the production code does what the spec forbids/omits);
//   SCHEMA   - the additive columns / partial unique index of (iii-a) do not exist yet;
//   RECOVERY - the convergence-to-the-public-txid path does not exist yet.
// R1/R2 of the specification are the existing #436 tests V3-E3b / V3-E3c (st1TemporalCleanupAuthority).
//
// Knobs and names that this specification pins (to be confirmed at implementation time):
//   - settle window: env DISPUTED_RECREATION_SETTLE_WINDOW_MS (inert today)
//   - refusal message token: `DISPUTED_RECREATION_REFUSED[<CAUSE>]`, CAUSE in
//     WINDOW | TXID_PUBLIC | OUTPOINT_SPENT | CHAIN_UNREADABLE | LEGACY_EDA | INTENT_MISMATCH
//   - columns on economic_disposition_authorizations: unsignedTxid, intentDigest, supersededAt,
//     supersededByPendingOperationId; index economic_disposition_one_live_per_generation
//
// What is real: PostgreSQL, the escrow/trade/dispute/ruling services, the real MULTISIG PSBT construction and
// finalization, the ADR-005/ADR-004 gates. What is not: the chain (a stateful explorer fixture that records every
// transmission attempt and knows which transactions are public) and the named fault injections (the lost pending row).
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
const keyOf = (label: string) => ECPair.fromPrivateKey(createHash('sha256').update(`p4iii-${label}`).digest())
const pubHex = (k: { publicKey: Uint8Array }) => Buffer.from(k.publicKey).toString('hex')
const destination = (label: string) => bitcoin.payments.p2wpkh({ pubkey: Buffer.from(keyOf(label).publicKey), network: NET }).address!
const addrOf = (script: Uint8Array) => { try { return bitcoin.address.fromOutputScript(script, NET) } catch { return 'non-standard' } }
const unsignedTxid = (psbtBase64: string) =>
  bitcoin.Transaction.fromBuffer(Buffer.from(bitcoin.Psbt.fromBase64(psbtBase64, { network: NET }).data.globalMap.unsignedTx.toBuffer())).getId()
const sign = (psbtBase64: string, key: ReturnType<typeof keyOf>) => { const p = bitcoin.Psbt.fromBase64(psbtBase64, { network: NET }); p.signInput(0, key); return p.toBase64() }

const SETTLE_WINDOW_ENV = 'DISPUTED_RECREATION_SETTLE_WINDOW_MS'
const NEW_COLUMNS = ['unsignedTxid', 'intentDigest', 'supersededAt', 'supersededByPendingOperationId']

describe('P4 (iii-a) disputed pending re-creation guard - RED specification (real PostgreSQL)', () => {
  jest.setTimeout(300_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let escrowService: any, identityService: any, liquidityRouter: any, tradeService: any, payoutAddressService: any
  let getDisputeService: () => any
  let signAuthorityDecision: (payload: unknown, secretKey: Uint8Array) => string
  let submitTransactionSignature: (escrowId: string, participantId: string, signedPsbtBase64: string) => Promise<any>
  let authorizeDisputedPendingExecution: (pending: any) => Promise<any>
  let reconcilePendingSettlements: () => Promise<any>

  const ARBITER_ID = 'p4iii-arbiter-1'
  const ARBITER2_ID = 'p4iii-arbiter-2'
  const arbiterKp = nacl.sign.keyPair()
  const arbiter2Kp = nacl.sign.keyPair()
  const buyerKey = keyOf('buyer')
  const sellerKey = keyOf('seller')
  let realFetch: typeof fetch
  let seq = 0
  const createdEscrowIds: string[] = []

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'false'
    process.env.MULTISIG_SEED = process.env.MULTISIG_SEED || 'p4iii-seed'
    process.env.TRUSTED_ARBITRATORS = `${ARBITER_ID},${ARBITER2_ID}`
    process.env[SETTLE_WINDOW_ENV] = String(15 * 60_000)
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
    ;({ submitTransactionSignature } = require('../../src/modules/open-settlement/escrow-pending-tx'))
    ;({ authorizeDisputedPendingExecution } = require('../../src/modules/open-settlement/economic-disposition-authority'))
    ;({ reconcilePendingSettlements } = require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service'))
    const { intentEngine } = require('../../src/core/intent-engine')
    intentEngine.registerHandler(require('../../src/modules/open-p2p/intent-handler').OpenP2PTradeIntentHandler)
    require('../../src/common/events/handlers').registerEventHandlers()
    for (const [id, kp] of [[ARBITER_ID, arbiterKp], [ARBITER2_ID, arbiter2Kp]] as const) {
      await prisma.user.upsert({ where: { id }, update: { publicKey: pubHex(kp) }, create: { id, publicKey: pubHex(kp), displayName: `P4-iii arbiter ${id}` } })
    }
  })
  beforeEach(() => { realFetch = global.fetch })
  afterEach(() => { global.fetch = realFetch })
  afterAll(async () => {
    delete process.env[SETTLE_WINDOW_ENV]
    if (dbAvailable) {
      // The "lost pending" scenarios leave exactly the state PASS 0b exists to find (a DISPUTED escrow with a live
      // authorization and no pending operation). Left in a shared database it is a recovery candidate for every later
      // suite - one that asserts a global reconciliation report under a permissive explorer mock sees it (reproduced:
      // signatureCollectionRestartConvergence after this file). Remove this suite's authorizations and rounds.
      await prisma.economicDispositionAuthorization.deleteMany({ where: { escrowId: { in: createdEscrowIds } } })
      await prisma.escrowPendingTransaction.deleteMany({ where: { escrowId: { in: createdEscrowIds } } })
      await prisma.$disconnect()
      await closeTestRedis()
    }
  })

  // ── stateful chain fixture: every transmission attempt is recorded; public transactions are known; the funding outpoint
  // is spent by the first accepted transaction; reads can be switched off ────────────────────────────────────────────────
  interface Ctl { funding: string; known: Set<string>; spentBy: string | null; posts: string[]; mode: 'ok' | 'down'; acceptThenAnswer502: boolean }
  function useChain(funding: string): Ctl {
    const ctl: Ctl = { funding, known: new Set(), spentBy: null, posts: [], mode: 'ok', acceptThenAnswer502: false }
    global.fetch = (async (url: string, init?: { method?: string; body?: string }) => {
      const u = String(url)
      if (init?.method === 'POST' && u.endsWith('/tx')) {
        const txid = bitcoin.Transaction.fromHex(String(init.body)).getId()
        ctl.posts.push(txid)
        if (ctl.spentBy && ctl.spentBy !== txid) return { ok: false, status: 400, text: async () => 'txn-mempool-conflict' } as any
        ctl.spentBy = txid; ctl.known.add(txid)
        if (ctl.acceptThenAnswer502) { ctl.acceptThenAnswer502 = false; return { ok: false, status: 502, text: async () => 'gateway timeout' } as any }
        return { ok: true, status: 200, text: async () => txid } as any
      }
      if (ctl.mode === 'down') throw new Error('explorer unreachable (read-side outage)')
      if (u.includes('/blocks/tip/height')) return { ok: true, status: 200, text: async () => '100' } as any
      if (u.includes('/v1/fees/recommended')) return { ok: true, status: 200, json: async () => ({ halfHourFee: 5, fastestFee: 8 }) } as any
      const status = u.match(/\/tx\/([0-9a-f]{64})\/status/)
      if (status) {
        return status[1] === ctl.funding || ctl.known.has(status[1])
          ? { ok: true, status: 200, json: async () => ({ confirmed: true, block_height: 100 }) } as any
          : { ok: false, status: 404, text: async () => 'Transaction not found', json: async () => ({}) } as any
      }
      return { ok: true, status: 200, json: async () => (ctl.spentBy ? [] : [{ txid: ctl.funding, vout: 0, value: 100_000, status: { confirmed: true } }]) } as any
    }) as any
    return ctl
  }

  interface Opened { escrowId: string; tradeId: string; disputeId: string; buyerId: string; sellerId: string; arbiterId: string; buyerDestination: string; sellerDestination: string; txid: string; ctl: Ctl }
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
    createdEscrowIds.push(escrow.id)
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id } })
    await escrowService.submitParticipantKey(escrow.id, buyer.id, pubHex(buyerKey), MULTISIG_CAPABILITY_PROFILE_V1)
    await escrowService.submitParticipantKey(escrow.id, seller.id, pubHex(sellerKey), MULTISIG_CAPABILITY_PROFILE_V1)
    const txid = createHash('sha256').update(`p4iii-${label}-${Date.now()}-${seq}`).digest('hex')
    const ctl = useChain(txid)
    await escrowService.lockFunds(escrow.id, seller.id)
    const dispute = await getDisputeService().raiseDispute(trade.id, buyer.id, `P4-iii ${label}`)
    const buyerDestination = destination(`buyer-${label}-${seq}`)
    const sellerDestination = destination(`seller-${label}-${seq}`)
    await payoutAddressService.setPayoutAddress(buyer.id, 'BTC', buyerDestination)
    await payoutAddressService.setPayoutAddress(seller.id, 'BTC', sellerDestination)
    return { escrowId: escrow.id, tradeId: trade.id, disputeId: dispute.id, buyerId: buyer.id, sellerId: seller.id, arbiterId: dispute.arbiterId, buyerDestination, sellerDestination, txid, ctl }
  }
  const settle = <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: Error) => ({ ok: false as const, error: e.message }))
  const rulingRelease = (o: Opened) => {
    const issuedAt = new Date().toISOString()
    const payload = { disputeId: o.disputeId, escrowId: o.escrowId, appealRound: 0, authorityId: o.arbiterId, outcome: 'RELEASE', buyerBps: null, issuedAt }
    return () => getDisputeService().resolveDispute(o.disputeId, o.arbiterId, 'RELEASE', undefined, undefined, undefined, signAuthorityDecision(payload, arbiterKp.secretKey), issuedAt)
  }
  const roundOf = (o: Opened) => prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: o.escrowId } })
  const pendingCount = (o: Opened) => prisma.escrowPendingTransaction.count({ where: { escrowId: o.escrowId } })
  const edaCount = (o: Opened) => prisma.economicDispositionAuthorization.count({ where: { escrowId: o.escrowId } })
  const recreate = (o: Opened) => escrowService.initiateRelease(o.escrowId, o.buyerDestination, o.arbiterId)
  const cause = (message: string) => message.match(/DISPUTED_RECREATION_REFUSED\[([A-Z_]+)\]/)?.[1] ?? 'none'
  const ageEda = (o: Opened) => prisma.economicDispositionAuthorization.updateMany({ where: { escrowId: o.escrowId }, data: { authorizedAt: new Date(Date.now() - 3 * 3_600_000) } })

  /** Reads the (iii-a) columns; `schema: 'missing'` when the migration does not exist yet. */
  async function edaRows(o: Opened) {
    try {
      const rows = await prisma.$queryRaw<Array<{ pendingOperationId: string; supersededAt: Date | null; supersededByPendingOperationId: string | null; unsignedTxid: string | null }>>`
        SELECT "pendingOperationId", "supersededAt", "supersededByPendingOperationId", "unsignedTxid"
        FROM economic_disposition_authorizations WHERE "escrowId" = ${o.escrowId} ORDER BY "authorizedAt"`
      return { schema: 'present' as const, rows }
    } catch { return { schema: 'missing' as const, rows: [] } }
  }

  /**
   * The state the guard is about: a ruling, a round, a COMMITTED authorization, and then the pending row is lost
   * (FAULT INJECTION: the row is deleted directly; the authorization survives).
   *  'never-sent' - the authorization was committed, nothing was transmitted;
   *  'public'     - the round was transmitted, the network accepted it, the answer was lost (HTTP 502), then the row is lost.
   */
  async function committedThenLost(label: string, mode: 'never-sent' | 'public') {
    const o = await openedDispute(label)
    await rulingRelease(o)()
    const pending = await roundOf(o)
    const oldTxid = unsignedTxid(pending.unsignedPsbtBase64)
    if (mode === 'never-sent') {
      await authorizeDisputedPendingExecution(pending)
    } else {
      o.ctl.acceptThenAnswer502 = true
      const attempt = await settle(submitTransactionSignature(o.escrowId, o.buyerId, sign(pending.unsignedPsbtBase64, buyerKey)))
      expect(attempt.ok).toBe(false)
      expect(o.ctl.known.has(oldTxid)).toBe(true)
    }
    expect(await edaCount(o)).toBe(1)
    await prisma.escrowPendingTransaction.delete({ where: { id: pending.id } })
    expect(await pendingCount(o)).toBe(0)
    return { o, pending, oldTxid }
  }

  // ── R0 SCHEMA ─────────────────────────────────────────────────────────────────────────────────────────────────────
  it('R0 [SCHEMA] the additive columns and the one-live-per-generation partial unique index exist', async () => {
    pg.requirePostgres('R0')
    const columns = (await prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'economic_disposition_authorizations'`).map((r) => r.column_name)
    const indexes = (await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'economic_disposition_authorizations'`).map((r) => r.indexname)
    expect({
      missingColumns: NEW_COLUMNS.filter((c) => !columns.includes(c)),
      hasLiveIndex: indexes.includes('economic_disposition_one_live_per_generation'),
    }).toEqual({ missingColumns: [], hasLiveIndex: true })
  })

  // ── R3 the old transaction is already public ──────────────────────────────────────────────────────────────────────
  it('R3a [BEHAVIOR] committed authorization, the old round\'s transaction is PUBLIC, pending lost: re-creation is refused and no second distinct transaction is ever transmitted', async () => {
    const { o, oldTxid } = await committedThenLost('r3a', 'public')
    const attempt = await settle(recreate(o))
    if (attempt.ok) {
      // what today's code does next, observed rather than assumed: the new round is signed and executed
      const round = await roundOf(o)
      await settle(submitTransactionSignature(o.escrowId, o.buyerId, sign(round.unsignedPsbtBase64, buyerKey)))
    }
    expect({
      refused: !attempt.ok,
      cause: attempt.ok ? 'none' : cause(attempt.error),
      distinctTransmitted: [...new Set(o.ctl.posts)],
    }).toEqual({ refused: true, cause: 'TXID_PUBLIC', distinctTransmitted: [oldTxid] })
  })

  it('R3b [RECOVERY] the same state converges to the PUBLIC transaction: the escrow records the old txid as its settlement result', async () => {
    const { o, oldTxid } = await committedThenLost('r3b', 'public')
    for (let lap = 0; lap < 15; lap++) {
      await reconcilePendingSettlements()
      if ((await prisma.escrow.findUniqueOrThrow({ where: { id: o.escrowId } })).txReleaseId) break
    }
    const escrow = await prisma.escrow.findUniqueOrThrow({ where: { id: o.escrowId }, select: { status: true, txReleaseId: true } })
    // RECOVERY today: with the pending row gone nothing can name the old transaction (the authorization stores only a digest)
    expect(escrow).toEqual({ status: 'COMPLETED', txReleaseId: oldTxid })
  })

  // ── R4 liveness after the window ─────────────────────────────────────────────────────────────────────────────────
  it('R4 [SCHEMA] window elapsed, old txid unknown on the chain, outpoint unspent, same intent: exactly one new round, the old authorization is superseded, one live authorization', async () => {
    const { o } = await committedThenLost('r4', 'never-sent')
    await ageEda(o)
    const attempt = await settle(recreate(o))
    if (attempt.ok) await authorizeDisputedPendingExecution(await roundOf(o))
    const { schema, rows } = await edaRows(o)
    const live = rows.filter((r) => r.supersededAt === null).length
    expect({
      allowed: attempt.ok, pendings: await pendingCount(o), schema, live,
      oldSuperseded: rows.length > 0 && rows[0].supersededAt !== null && rows[0].supersededByPendingOperationId === (attempt.ok ? (await roundOf(o)).id : null),
    }).toEqual({ allowed: true, pendings: 1, schema: 'present', live: 1, oldSuperseded: true })
  })

  // ── R5 / R6 fail closed on chain truth ───────────────────────────────────────────────────────────────────────────
  it('R5 [BEHAVIOR] window elapsed but the explorer is unreadable: re-creation is refused with the guard\'s cause (fail closed), nothing created, nothing transmitted', async () => {
    const { o } = await committedThenLost('r5', 'never-sent')
    await ageEda(o)
    o.ctl.mode = 'down'
    const attempt = await settle(recreate(o))
    o.ctl.mode = 'ok'
    expect({
      refused: !attempt.ok, cause: attempt.ok ? 'none' : cause(attempt.error), pendings: await pendingCount(o), eda: await edaCount(o), transmitted: o.ctl.posts,
    }).toEqual({ refused: true, cause: 'CHAIN_UNREADABLE', pendings: 0, eda: 1, transmitted: [] })
  })

  it('R6 [BEHAVIOR] window elapsed but the funding outpoint is already spent by another transaction: refused with the guard\'s cause, nothing transmitted', async () => {
    const { o } = await committedThenLost('r6', 'never-sent')
    await ageEda(o)
    const stranger = 'ab'.repeat(32)
    o.ctl.spentBy = stranger; o.ctl.known.add(stranger)
    const attempt = await settle(recreate(o))
    expect({
      refused: !attempt.ok, cause: attempt.ok ? 'none' : cause(attempt.error), pendings: await pendingCount(o), transmitted: o.ctl.posts,
    }).toEqual({ refused: true, cause: 'OUTPOINT_SPENT', pendings: 0, transmitted: [] })
  })

  // ── R7 legacy authorization ──────────────────────────────────────────────────────────────────────────────────────
  it('R7 [BEHAVIOR] an authorization that cannot name its transaction (legacy: no unsignedTxid), window elapsed: refused - it cannot be proven', async () => {
    const { o } = await committedThenLost('r7', 'never-sent')
    await ageEda(o)
    // legacy shape: where the column exists it is nulled; where it does not, every authorization is already legacy
    await prisma.$executeRawUnsafe(`UPDATE economic_disposition_authorizations SET "unsignedTxid" = NULL WHERE "escrowId" = '${o.escrowId}'`).catch(() => undefined)
    const attempt = await settle(recreate(o))
    expect({ refused: !attempt.ok, cause: attempt.ok ? 'none' : cause(attempt.error), pendings: await pendingCount(o) })
      .toEqual({ refused: true, cause: 'LEGACY_EDA', pendings: 0 })
  })

  // ── R8 control ───────────────────────────────────────────────────────────────────────────────────────────────────
  it('R8 [CONTROL] a different disposition than the committed ruling (a REFUND round under a RELEASE ruling) is refused whatever the guard does', async () => {
    const { o } = await committedThenLost('r8', 'never-sent')
    await ageEda(o)
    const attempt = await settle(escrowService.initiateRefund(o.escrowId, o.arbiterId, o.sellerDestination))
    expect({ refused: !attempt.ok, pendings: await pendingCount(o) }).toEqual({ refused: true, pendings: 0 })
  })

  // ── R9 concurrency ───────────────────────────────────────────────────────────────────────────────────────────────
  it('R9 [SCHEMA] two concurrent re-creations after the window: exactly one round wins, exactly one live authorization, the old one superseded, no deadlock', async () => {
    const { o } = await committedThenLost('r9', 'never-sent')
    await ageEda(o)
    const results = await Promise.all([settle(recreate(o)), settle(recreate(o))])
    const winners = results.filter((r) => r.ok).length
    if (winners > 0) await authorizeDisputedPendingExecution(await roundOf(o))
    const { schema, rows } = await edaRows(o)
    expect({ winners, pendings: await pendingCount(o), schema, live: rows.filter((r) => r.supersededAt === null).length })
      .toEqual({ winners: 1, pendings: 1, schema: 'present', live: 1 })
  })

  // ── R11 / R12 added with the implementation: the window, and the database backstop ──────────────────────────────
  it('R11 [BEHAVIOR] inside the settle window (just committed), txid unknown, outpoint unspent, same intent: refused with WINDOW - the lost round may still be in flight', async () => {
    const { o } = await committedThenLost('r11', 'never-sent')
    const attempt = await settle(recreate(o))
    expect({ refused: !attempt.ok, cause: attempt.ok ? 'none' : cause(attempt.error), pendings: await pendingCount(o), transmitted: o.ctl.posts })
      .toEqual({ refused: true, cause: 'WINDOW', pendings: 0, transmitted: [] })
  })

  it('R12 [INDEX] the database refuses a second LIVE authorization for one dispute generation, and accepts it once the first is superseded', async () => {
    const { o } = await committedThenLost('r12', 'never-sent')
    const eda = await prisma.economicDispositionAuthorization.findFirstOrThrow({ where: { escrowId: o.escrowId } })
    let n = 0
    const another = () => prisma.economicDispositionAuthorization.create({
      data: { pendingOperationId: `r12-${Date.now()}-${++n}`, escrowId: eda.escrowId, disputeId: eda.disputeId, appealRound: eda.appealRound, arbiterId: eda.arbiterId, ruling: eda.ruling, operationDigest: 'r12' },
    })
    const whileLive = await settle(another())
    await prisma.economicDispositionAuthorization.update({ where: { id: eda.id }, data: { supersededAt: new Date() } })
    const afterSupersession = await settle(another())
    expect({ refusedWhileLive: !whileLive.ok, acceptedAfterSupersession: afterSupersession.ok }).toEqual({ refusedWhileLive: true, acceptedAfterSupersession: true })
  })

  // ── R10 assumption pin (section 5.2) ─────────────────────────────────────────────────────────────────────────────
  it('R10 [ASSUMPTION PIN] two rounds for one disputed escrow both spend only the canonical outpoint and pay only the Outcome\'s destination (and the fee address)', async () => {
    const { o, pending } = await committedThenLost('r10', 'never-sent')
    await ageEda(o)
    const second = await settle(recreate(o))
    expect(second.ok).toBe(true)
    const escrow = await prisma.escrow.findUniqueOrThrow({ where: { id: o.escrowId }, select: { snapshotFeeCollectionAddress: true } })
    const allowed = new Set([o.buyerDestination, ...(escrow.snapshotFeeCollectionAddress ? [escrow.snapshotFeeCollectionAddress] : [])])
    const describeRound = (psbtBase64: string) => {
      const tx = bitcoin.Transaction.fromBuffer(Buffer.from(bitcoin.Psbt.fromBase64(psbtBase64, { network: NET }).data.globalMap.unsignedTx.toBuffer()))
      return {
        inputs: tx.ins.map((i) => `${Buffer.from(i.hash).reverse().toString('hex')}:${i.index}`),
        outsOutsideTheOutcome: tx.outs.map((out) => addrOf(out.script)).filter((a) => !allowed.has(a)),
      }
    }
    const first = describeRound(pending.unsignedPsbtBase64)
    const next = describeRound((await roundOf(o)).unsignedPsbtBase64)
    expect({ first, next }).toEqual({
      first: { inputs: [`${o.txid}:0`], outsOutsideTheOutcome: [] },
      next: { inputs: [`${o.txid}:0`], outsOutsideTheOutcome: [] },
    })
  })
})
