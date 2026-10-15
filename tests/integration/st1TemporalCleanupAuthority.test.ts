// ST-1 - real-PostgreSQL proof of the temporal authority and lock order of the stale ruling-round cleanup
// (dispute-pending-reconciliation.ts). Companion to staleDisputeCleanupSignatureRace.test.ts (#244: no signature
// is lost); this suite is about WHICH authority a delete may rest on, and in which order the locks are taken.
//
// What is real here: PostgreSQL; the escrow, trade, dispute, payout addresses and participant keys (production
// services); the ruling (DisputeService.resolveDispute() -> commitAuthoritativeDisputeRuling() -> the real
// translation to a PSBT and the real pending round with its recorded ruling generation); appeal();
// submitTransactionSignature(); authorizeDisputedPendingExecution(); and the cleanup under test. What is not:
// the chain (an explorer stub that serves one funding UTXO), and the fault injections, each named where used.
//
// Interleavings are never timing guesses. A test holds one of the two advisory locks (D = the dispute's
// `economic-disposition:<id>` lock, E = the escrow lock) on a separate connection, starts the contenders in
// a known order, observes through pg_locks that each is queued, then releases; PostgreSQL grants the waiters
// of a lock in queue order.
//
// Not proven here, and not claimed: that no other lock order exists anywhere in the codebase. The tests cover
// the actors that take the dispute lock, the escrow lock or both on this graph, with a control that shows the
// instrument would see an inversion. Absence of a failure is not a proof of absence of cycles.
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
const keyOf = (label: string) => ECPair.fromPrivateKey(createHash('sha256').update(`st1-${label}`).digest())
const pubHex = (k: { publicKey: Uint8Array }) => Buffer.from(k.publicKey).toString('hex')
const destination = (label: string) =>
  bitcoin.payments.p2wpkh({ pubkey: Buffer.from(keyOf(label).publicKey), network: bitcoin.networks.testnet }).address!

describe('ST-1 stale ruling-round cleanup - temporal authority and lock order (real Postgres)', () => {
  jest.setTimeout(180_000)

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
  let submitTransactionSignature: (escrowId: string, participantId: string, signedPsbtBase64: string) => Promise<any>
  let authorizeDisputedPendingExecution: (pending: any) => Promise<any>
  let economicDispositionLockKey: (disputeId: string) => string
  let revertDisputeRulingRecord: (escrowId: string, appealRound: number) => Promise<void>
  let commitAuthoritativeDisputeRuling: (...args: any[]) => Promise<{ committed: boolean }>
  let deletePendingRoundIfStillUnsigned: (pendingId: string, escrowId: string, generation: any) => Promise<string>
  let reconcileStalePendingDisputeTranslations: () => Promise<any>
  let restarted: { prisma: PrismaClient; deletePendingRoundIfStillUnsigned: typeof deletePendingRoundIfStillUnsigned; reconcileStalePendingDisputeTranslations: typeof reconcileStalePendingDisputeTranslations; redis: { quit(): Promise<unknown> } } | undefined

  const ARBITER_ID = 'st1-temporal-arbiter-1'
  const ARBITER2_ID = 'st1-temporal-arbiter-2'
  const arbiterKp = nacl.sign.keyPair()
  const arbiter2Kp = nacl.sign.keyPair()
  const buyerKey = keyOf('buyer')
  const sellerKey = keyOf('seller')
  let realFetch: typeof fetch
  const displacedArbiterKeys = new Map<string, any>()

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'false'
    process.env.MULTISIG_SEED = process.env.MULTISIG_SEED || 'st1-temporal-seed'
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
    ;({ submitTransactionSignature } = require('../../src/modules/open-settlement/escrow-pending-tx'))
    ;({ authorizeDisputedPendingExecution, economicDispositionLockKey } = require('../../src/modules/open-settlement/economic-disposition-authority'))
    ;({ revertDisputeRulingRecord, commitAuthoritativeDisputeRuling } = require('../../src/modules/open-settlement/dispute-outcome'))
    ;({ deletePendingRoundIfStillUnsigned, reconcileStalePendingDisputeTranslations } = require('../../src/modules/open-settlement/dispute-pending-reconciliation'))
    const { intentEngine } = require('../../src/core/intent-engine')
    const { OpenP2PTradeIntentHandler } = require('../../src/modules/open-p2p/intent-handler')
    intentEngine.registerHandler(OpenP2PTradeIntentHandler)
    require('../../src/common/events/handlers').registerEventHandlers()
    jest.isolateModules(() => {
      restarted = {
        prisma: require('../../src/common/database').prisma,
        deletePendingRoundIfStillUnsigned: require('../../src/modules/open-settlement/dispute-pending-reconciliation').deletePendingRoundIfStillUnsigned,
        reconcileStalePendingDisputeTranslations: require('../../src/modules/open-settlement/dispute-pending-reconciliation').reconcileStalePendingDisputeTranslations,
        redis: require('../../src/common/redis').redis,
      }
    })

    for (const [id, kp] of [[ARBITER_ID, arbiterKp], [ARBITER2_ID, arbiter2Kp]] as const) {
      await prisma.user.upsert({
        where: { id },
        update: { publicKey: pubHex(kp) },
        create: { id, publicKey: pubHex(kp), displayName: `ST-1 temporal arbiter ${id}` },
      })
    }
  })

  beforeEach(() => { realFetch = global.fetch })
  afterEach(() => { global.fetch = realFetch; jest.restoreAllMocks() })

  afterAll(async () => {
    if (dbAvailable) {
      // Restore the exact arbiter commitment removed by the legacy appeal fixture.
      // Do not let a synthetic P3 violation escape into the shared PG lane.
      for (const [escrowId, original] of displacedArbiterKeys) {
        await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SET LOCAL session_replication_role = replica`
          const current = await tx.escrowParticipantKey.findFirst({ where: { escrowId, role: 'arbiter' } })
          // An appeal may install a new arbiter commitment for the next generation.
          // Preserve it: restoring the previous key would rewrite current authority.
          // The original absence must still be repaired when no commitment exists.
          if (!current) await tx.escrowParticipantKey.create({ data: original })
        })
      }
      await prisma.$disconnect()
      if (restarted) {
        await restarted.prisma.$disconnect()
        await restarted.redis.quit().catch(() => {})
      }
      await closeTestRedis()
    }
  })

  // ── fixture: production services up to a committed ruling and its pending round ─────────────────

  /** The one chain fact the production translation needs: a confirmed funding UTXO of 100 000 sats. */
  function serveFundingUtxo(txid: string): void {
    global.fetch = jest.fn(async (url: string) => {
      if (url.includes('/blocks/tip/height')) return { ok: true, text: async () => '100' } as any
      if (url.includes(`/tx/${txid}/status`)) return { ok: true, json: async () => ({ confirmed: true, block_height: 100 }) } as any
      if (url.includes('/v1/fees/recommended')) return { ok: true, json: async () => ({ halfHourFee: 5, fastestFee: 8 }) } as any
      return { ok: true, json: async () => [{ txid, vout: 0, value: 100_000, status: { confirmed: true } }] } as any
    }) as any
  }

  interface Opened {
    escrowId: string; tradeId: string; disputeId: string; buyerId: string; sellerId: string; arbiterId: string
    buyerDestination: string; sellerDestination: string
  }
  let seq = 0

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
    serveFundingUtxo(createHash('sha256').update(`st1-temporal-${label}-${Date.now()}-${seq}`).digest('hex'))
    await escrowService.lockFunds(escrow.id, seller.id)

    const dispute = await getDisputeService().raiseDispute(trade.id, buyer.id, `ST-1 temporal authority - ${label}`)
    const buyerDestination = destination(`buyer-${label}-${seq}`)
    const sellerDestination = destination(`seller-${label}-${seq}`)
    await payoutAddressService.setPayoutAddress(buyer.id, 'BTC', buyerDestination)
    await payoutAddressService.setPayoutAddress(seller.id, 'BTC', sellerDestination)
    return { escrowId: escrow.id, tradeId: trade.id, disputeId: dispute.id, buyerId: buyer.id, sellerId: seller.id, arbiterId: dispute.arbiterId, buyerDestination, sellerDestination }
  }

  /** Rules the dispute through the production path; the production dispatch persists the pending round. */
  async function rule(o: Opened, service: any, ruling: 'RELEASE' | 'REFUND', arbiterId: string, kp: nacl.SignKeyPair) {
    const dispute = await prisma.dispute.findUniqueOrThrow({ where: { id: o.disputeId } })
    const escrow = await prisma.escrow.findUniqueOrThrow({ where: { id: o.escrowId } })
    serveFundingUtxo(escrow.txLockId!) // the explorer stub serves one escrow's funding output at a time
    const issuedAt = new Date().toISOString()
    const payload = { disputeId: o.disputeId, escrowId: o.escrowId, appealRound: dispute.appealRound, authorityId: arbiterId, outcome: ruling, buyerBps: null, issuedAt }
    const signature = signAuthorityDecision(payload, kp.secretKey)
    await service.resolveDispute(o.disputeId, arbiterId, ruling, undefined, undefined, undefined, signature, issuedAt)
    return prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: o.escrowId } })
  }

  /**
   * FIXTURE SHAPE: the legacy escrow appeal() accepts - no script-committed arbiter identity. On the production
   * path a MULTISIG escrow always has one (written when its deposit address is derived, deletion refused by a
   * database trigger) and appeal() refuses it, so generation N+1 is unreachable for MULTISIG today. The row is
   * removed with the trigger bypassed for this one transaction (session_replication_role needs a superuser, as
   * the test database user is) to reach the state of an escrow that predates the commitment.
   */
  const makeAppealable = (o: Opened) => prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`
    const original = await tx.escrowParticipantKey.findFirst({ where: { escrowId: o.escrowId, role: 'arbiter' } })
    if (!original) throw new Error(`ST1 fixture missing original arbiter commitment for ${o.escrowId}`)
    const deleted = await tx.escrowParticipantKey.deleteMany({ where: { escrowId: o.escrowId, role: 'arbiter' } })
    if (deleted.count !== 1) throw new Error(`ST1 fixture expected one arbiter commitment for ${o.escrowId}`)
    displacedArbiterKeys.set(o.escrowId, original)
  })
  /** A DisputeService whose appeal panel is ARBITER2 (the market provider is not the subject here). */
  const appealService = () => new DisputeService({
    name: 'st1-stub', arbitrators: [ARBITER_ID, ARBITER2_ID],
    async assign() { return ARBITER_ID },
    async assignAppealPanel() { return ARBITER2_ID },
  })

  /** A round old enough for the cleanup margin. */
  const age = (pendingId: string) =>
    prisma.escrowPendingTransaction.update({ where: { id: pendingId }, data: { createdAt: new Date(Date.now() - 10 * 60 * 1000) } })

  /** The same spend (input, value, witness script) paying `address` instead. */
  function redirected(unsignedPsbtBase64: string, address: string): string {
    const network = bitcoin.networks.testnet
    const original = bitcoin.Psbt.fromBase64(unsignedPsbtBase64, { network })
    const input = original.data.inputs[0]
    const copy = new bitcoin.Psbt({ network })
    copy.addInput({
      hash: original.txInputs[0].hash, index: original.txInputs[0].index,
      witnessUtxo: input.witnessUtxo!, witnessScript: input.witnessScript!,
    })
    copy.addOutput({ address, value: BigInt(original.txOutputs[0].value) })
    return copy.toBase64()
  }

  /** FAULT INJECTION: the stored transaction no longer pays what the Outcome authorized (a translator that went wrong). */
  async function corrupt(pendingId: string): Promise<void> {
    const row = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { id: pendingId } })
    await prisma.escrowPendingTransaction.update({
      where: { id: pendingId }, data: { unsignedPsbtBase64: redirected(row.unsignedPsbtBase64, destination('not-the-beneficiary')) },
    })
  }

  /**
   * Generation N+1 of a MULTISIG dispute: appeal() (production) then the production commit of the second
   * ruling (real signed decision, real Outcome record). Its pending round is then persisted the way
   * initiateSignatureCollectionCore() persists it - provenance copied from the committed dispute row - because
   * the production dispatch cannot run here: appeal() refuses a MULTISIG escrow that has an arbiter commitment,
   * and the dispatch refuses one that has none. Generation N+1 is unreachable for MULTISIG today; the cleanup's
   * contract is nevertheless generation-bound, and this is what proves it.
   */
  async function secondGeneration(o: Opened, previous: { unsignedPsbtBase64: string }, ruling: 'RELEASE' | 'REFUND') {
    await makeAppealable(o)
    const appealed = await appealService().appeal(o.disputeId, o.buyerId)
    expect(appealed.dispute).toMatchObject({ status: 'APPEALED', appealRound: 1, arbiterId: ARBITER2_ID })
    const issuedAt = new Date().toISOString()
    const payload = { disputeId: o.disputeId, escrowId: o.escrowId, appealRound: 1, authorityId: ARBITER2_ID, outcome: ruling, buyerBps: null, issuedAt }
    const committed = await commitAuthoritativeDisputeRuling(
      { id: o.disputeId, escrowId: o.escrowId, status: 'APPEALED', appealRound: 1 },
      payload, signAuthorityDecision(payload, arbiter2Kp.secretKey), pubHex(arbiter2Kp), '100000', 'BTC', o.buyerId, o.sellerId,
    )
    expect(committed.committed).toBe(true)
    const d = await disputeOf(o)
    expect(d).toMatchObject({ status: 'RESOLVED', appealRound: 1, ruling })
    const payee = ruling === 'RELEASE' ? o.buyerDestination : o.sellerDestination
    return prisma.escrowPendingTransaction.create({
      data: {
        escrowId: o.escrowId, kind: ruling === 'RELEASE' ? 'release' : 'refund', toAddress: payee,
        unsignedPsbtBase64: redirected(previous.unsignedPsbtBase64, payee), requiredSigners: [o.buyerId, o.sellerId],
        triggeredBy: ARBITER2_ID, signaturesConfidential: true,
        disputeId: o.disputeId, rulingAppealRound: d.appealRound, rulingArbiterId: d.arbiterId, rulingOutcome: d.ruling,
        rulingAuthoritySignature: d.authoritySignature, rulingAuthorityIssuedAt: d.authorityIssuedAt,
        createdAt: new Date(Date.now() - 10 * 60 * 1000),
      },
    })
  }

  /** FIXTURE SHAPE: a release round needing both parties, so one signature leaves it incomplete (not finalized). */
  const needBothSigners = (pendingId: string, o: Opened) =>
    prisma.escrowPendingTransaction.update({ where: { id: pendingId }, data: { requiredSigners: [o.buyerId, o.sellerId] } })

  /** A stale round: aged and no longer the transaction its Outcome authorized. */
  async function stale(pendingId: string, o: Opened): Promise<void> {
    await needBothSigners(pendingId, o)
    await corrupt(pendingId)
    await age(pendingId)
  }

  async function generationOf(pendingId: string) {
    const row = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { id: pendingId } })
    if (!row.disputeId || row.rulingAppealRound === null || !row.rulingArbiterId ||
        !row.rulingOutcome || !row.rulingAuthoritySignature || !row.rulingAuthorityIssuedAt) {
      throw new Error('the pending round has no complete ruling provenance')
    }
    return {
      disputeId: row.disputeId, rulingAppealRound: row.rulingAppealRound, rulingArbiterId: row.rulingArbiterId,
      rulingOutcome: row.rulingOutcome, rulingAuthoritySignature: row.rulingAuthoritySignature,
      rulingAuthorityIssuedAt: row.rulingAuthorityIssuedAt,
    }
  }

  const roundState = async (pendingId: string, client: PrismaClient = prisma) => ({
    pending: (await client.escrowPendingTransaction.findUnique({ where: { id: pendingId }, select: { id: true } })) !== null,
    signatures: await client.escrowTransactionSignature.count({ where: { pendingTxId: pendingId } }),
  })
  const disputeOf = (o: Opened) => prisma.dispute.findUniqueOrThrow({ where: { id: o.disputeId } })
  const edaCount = (o: Opened) => prisma.economicDispositionAuthorization.count({ where: { escrowId: o.escrowId } })
  const outcomeRecords = (o: Opened) => prisma.semanticTransitionRecord.count({ where: { interactionId: o.escrowId, transitionType: 'escrow.dispute.rule' } })

  /** Submits the buyer's real partial signature over the stored round. */
  async function buyerSigns(pendingId: string): Promise<string> {
    const row = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { id: pendingId } })
    const psbt = bitcoin.Psbt.fromBase64(row.unsignedPsbtBase64, { network: bitcoin.networks.testnet })
    psbt.signInput(0, buyerKey)
    return psbt.toBase64()
  }

  function requirePostgres(name: string): void {
    pg.requirePostgres(name)
  }

  /** Runs the real entry point with its candidate scan limited to these escrows (the database is shared with other suites). */
  async function reconcileScoped(escrowIds: string[], times = 1): Promise<any[]> {
    const delegate: any = prisma.escrowPendingTransaction
    const real = delegate.findMany.bind(delegate)
    const spy = jest.spyOn(delegate, 'findMany').mockImplementation((args: any) =>
      real({ ...args, where: { AND: [args?.where ?? {}, { escrowId: { in: escrowIds } }] } }))
    try {
      return await Promise.all(Array.from({ length: times }, () => reconcileStalePendingDisputeTranslations()))
    } finally {
      spy.mockRestore()
    }
  }

  // ── deterministic interleaving harness ──────────────────────────────────────────────────────────

  const waitingOnAdvisoryLocks = async () => (await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)[0].n
  async function untilWaiting(n: number) {
    for (let i = 0; i < 1000; i++) {
      if ((await waitingOnAdvisoryLocks()) === n) return
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error(`expected ${n} advisory-lock waiter(s), saw ${await waitingOnAdvisoryLocks()}`)
  }

  /** Holds one advisory lock key (the text hashed by hashtext(), as every production site does) until released. */
  async function hold(key: string) {
    let release!: () => void
    const released = new Promise<void>((r) => { release = r })
    let acquired!: () => void
    const isHeld = new Promise<void>((r) => { acquired = r })
    const done = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key})::bigint)`
      acquired()
      await released
    }, { timeout: 60_000 })
    await isHeld
    return async () => { release(); await done }
  }
  const holdE = (o: Opened) => hold(o.escrowId)
  const holdD = (o: Opened) => hold(economicDispositionLockKey(o.disputeId))

  /** Which of this escrow's two locks each backend holds or waits for, read from pg_locks. */
  async function lockMap(o: Opened) {
    return prisma.$queryRaw<Array<{ pid: number; granted: boolean; lock: 'D' | 'E' }>>`
      SELECT l.pid, l.granted, k.name AS lock
      FROM pg_locks l
      JOIN (VALUES (${economicDispositionLockKey(o.disputeId)}::text, 'D'::text), (${o.escrowId}::text, 'E'::text)) AS k(key, name)
        ON l.classid::bigint = ((hashtext(k.key)::bigint >> 32) & 4294967295) AND l.objid::bigint = (hashtext(k.key)::bigint & 4294967295)
      WHERE l.locktype = 'advisory' AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())`
  }

  const decide = (pendingId: string, escrowId: string, generation: any) => deletePendingRoundIfStillUnsigned(pendingId, escrowId, generation)

  /**
   * Records, for every interactive transaction the production code opens through the shared client, the order in
   * which it takes advisory locks (classified D / E / other), selects rows FOR UPDATE and writes rows. The
   * recording wraps the transaction client; nothing about what the code does changes.
   */
  function recordLockOrder(escrowIds: Set<string>) {
    const real = (prisma as any).$transaction.bind(prisma)
    const transactions: string[][] = []
    const classify = (key: string) =>
      key.startsWith('economic-disposition:') ? 'D' : escrowIds.has(key) ? 'E' : `X:${key.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{16,}/g, '#').slice(0, 40)}`
    const WRITES = new Set(['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany'])
    const wrap = (tx: any, sequence: string[]) => new Proxy(tx, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver)
        if (prop === '$executeRaw' && typeof value === 'function') {
          return (strings: TemplateStringsArray, ...values: unknown[]) => {
            if (Array.isArray(strings) && strings.join('?').includes('pg_advisory_xact_lock')) sequence.push(classify(String(values[0])))
            return value.call(target, strings, ...values)
          }
        }
        if (prop === '$queryRaw' && typeof value === 'function') {
          return (strings: TemplateStringsArray, ...values: unknown[]) => {
            const sql = Array.isArray(strings) ? strings.join('?') : ''
            if (sql.includes('FOR UPDATE')) sequence.push(`R:${(/FROM\s+(\w+)/.exec(sql) ?? [])[1] ?? 'rows'}`)
            return value.call(target, strings, ...values)
          }
        }
        if (typeof prop === 'string' && !prop.startsWith('$') && value && typeof value === 'object') {
          return new Proxy(value, {
            get(model, method) {
              const f = (model as any)[method]
              if (typeof f !== 'function') return f
              return (...args: unknown[]) => {
                if (WRITES.has(String(method))) sequence.push(`R:${prop}`)
                return f.apply(model, args)
              }
            },
          })
        }
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const spy = jest.spyOn(prisma as any, '$transaction').mockImplementation(((arg: any, options?: any) => {
      if (typeof arg !== 'function') return real(arg, options)
      return real((tx: any) => {
        const sequence: string[] = []
        transactions.push(sequence)
        return arg(wrap(tx, sequence))
      }, options)
    }) as any)
    return { transactions, stop: () => spy.mockRestore() }
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // (9) lock order: D then E, observed
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  it('L1 the cleanup takes D, then E: with E held elsewhere it holds D and waits for E; with D held elsewhere it holds nothing and waits for D', async () => {
    const o = await openedDispute('l1')
    const pending = await rule(o, getDisputeService(), 'RELEASE', o.arbiterId, arbiterKp)
    await stale(pending.id, o)
    const generation = await generationOf(pending.id)

    const releaseE = await holdE(o)
    const cleaner = decide(pending.id, o.escrowId, generation)
    await untilWaiting(1)
    const whileEHeld = await lockMap(o)
    const waiterPid = whileEHeld.find((l) => !l.granted)!.pid
    expect(whileEHeld.filter((l) => l.pid === waiterPid).map((l) => `${l.lock}:${l.granted ? 'granted' : 'waiting'}`).sort())
      .toEqual(['D:granted', 'E:waiting'])
    await releaseE()
    expect(await cleaner).toBe('DELETED')

    // The round is gone, but the decision still takes the locks before it reads anything.
    const releaseD = await holdD(o)
    const second = decide(pending.id, o.escrowId, generation)
    await untilWaiting(1)
    const whileDHeld = await lockMap(o)
    const second_pid = whileDHeld.find((l) => !l.granted)!.pid
    expect(whileDHeld.filter((l) => l.pid === second_pid).map((l) => `${l.lock}:${l.granted ? 'granted' : 'waiting'}`)).toEqual(['D:waiting'])
    await releaseD()
    expect(await second).toBe('ALREADY_GONE')
  })

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // (1) generation N / N+1
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  it('N1 a delete nominated under generation N cannot touch the pending round of generation N+1 (stale nomination, real appeal, real second ruling)', async () => {
    const o = await openedDispute('n1')
    const round0 = await rule(o, getDisputeService(), 'RELEASE', o.arbiterId, arbiterKp)
    await stale(round0.id, o)
    const generation0 = await generationOf(round0.id) // the nomination: taken now, decided later

    // Generation N is removed by a legitimate cleanup; only then can the dispute move on and rule again.
    expect(await decide(round0.id, o.escrowId, generation0)).toBe('DELETED')
    const round1 = await secondGeneration(o, round0, 'REFUND')
    expect(round1.id).not.toBe(round0.id)
    expect(round1).toMatchObject({ disputeId: o.disputeId, rulingAppealRound: 1, rulingArbiterId: ARBITER2_ID, rulingOutcome: 'REFUND' })
    expect(await outcomeRecords(o)).toBe(2)

    // The stale nomination for N arrives now. Even if the round of N+1 is itself stale and guard-failing, the
    // nomination for N has no authority over it - by id, and by generation if handed its id.
    await corrupt(round1.id)
    expect(await decide(round0.id, o.escrowId, generation0)).toBe('ALREADY_GONE')
    expect(await decide(round1.id, o.escrowId, generation0)).toBe('PROVENANCE_REJECTED')
    expect(await roundState(round1.id)).toEqual({ pending: true, signatures: 0 })

    // Its own generation, re-proven under the locks, does authorize it.
    expect(await decide(round1.id, o.escrowId, await generationOf(round1.id))).toBe('DELETED')
    expect(await outcomeRecords(o)).toBe(2) // both durable Outcomes untouched
    expect(await edaCount(o)).toBe(0)
  })

  it('N2 the round of generation N+1 is judged against ITS Outcome: valid for N+1 it is kept even though it could never satisfy the Outcome of N', async () => {
    const o = await openedDispute('n2')
    const round0 = await rule(o, getDisputeService(), 'RELEASE', o.arbiterId, arbiterKp)
    await stale(round0.id, o)
    expect(await decide(round0.id, o.escrowId, await generationOf(round0.id))).toBe('DELETED')
    const round1 = await secondGeneration(o, round0, 'REFUND') // pays the seller; Outcome 0 paid the buyer

    expect(await decide(round1.id, o.escrowId, await generationOf(round1.id))).toBe('GUARD_PASSED')
    expect(await roundState(round1.id)).toEqual({ pending: true, signatures: 0 })
  })

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // (2) a concurrent appeal, before and after the cleanup acquires its authority
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  it('A1 appeal acquires the dispute lock first: the cleanup, queued behind it, finds the generation superseded and deletes nothing', async () => {
    const o = await openedDispute('a1')
    const pending = await rule(o, getDisputeService(), 'RELEASE', o.arbiterId, arbiterKp)
    await stale(pending.id, o)
    await makeAppealable(o)
    const generation = await generationOf(pending.id)

    const releaseD = await holdD(o)
    const appeal = appealService().appeal(o.disputeId, o.buyerId)
    await untilWaiting(1) // appeal queued first
    const cleaner = decide(pending.id, o.escrowId, generation)
    await untilWaiting(2) // cleanup queued second
    await releaseD()

    expect((await appeal).dispute).toMatchObject({ status: 'APPEALED', appealRound: 1 })
    expect(await cleaner).toBe('PROVENANCE_REJECTED')
    expect(await roundState(pending.id)).toEqual({ pending: true, signatures: 0 })
    expect(await edaCount(o)).toBe(0)
  })

  it('A2 the cleanup acquires the dispute lock first: it decides under the authority it proved, and the appeal then proceeds', async () => {
    const o = await openedDispute('a2')
    const pending = await rule(o, getDisputeService(), 'RELEASE', o.arbiterId, arbiterKp)
    await stale(pending.id, o)
    await makeAppealable(o)
    const generation = await generationOf(pending.id)

    const releaseD = await holdD(o)
    const cleaner = decide(pending.id, o.escrowId, generation)
    await untilWaiting(1) // cleanup queued first
    const appeal = appealService().appeal(o.disputeId, o.buyerId)
    await untilWaiting(2) // appeal queued second
    await releaseD()

    expect(await cleaner).toBe('DELETED')
    expect((await appeal).dispute).toMatchObject({ status: 'APPEALED', appealRound: 1 })
    expect(await roundState(pending.id)).toEqual({ pending: false, signatures: 0 })
    expect(await outcomeRecords(o)).toBe(1) // the Outcome of generation 0 is history, never edited
  })

  it('A3 the appeal commits between the cleanup\'s nomination and its decision: the decision rejects it (real appeal, no barrier needed)', async () => {
    const o = await openedDispute('a3')
    const pending = await rule(o, getDisputeService(), 'RELEASE', o.arbiterId, arbiterKp)
    await stale(pending.id, o)
    await makeAppealable(o)
    const generation = await generationOf(pending.id)
    await appealService().appeal(o.disputeId, o.buyerId)
    expect(await decide(pending.id, o.escrowId, generation)).toBe('PROVENANCE_REJECTED')
    expect(await roundState(pending.id)).toEqual({ pending: true, signatures: 0 })
  })

  it('A4 a dispute no longer RESOLVED while every other recorded fact still matches (defence in depth: a writer that moves only the status) is rejected', async () => {
    const o = await openedDispute('a4')
    const pending = await rule(o, getDisputeService(), 'RELEASE', o.arbiterId, arbiterKp)
    await stale(pending.id, o)
    const generation = await generationOf(pending.id)
    await prisma.dispute.update({ where: { id: o.disputeId }, data: { status: 'MOOT' } })

    expect(await decide(pending.id, o.escrowId, generation)).toBe('PROVENANCE_REJECTED')
    expect(await roundState(pending.id)).toEqual({ pending: true, signatures: 0 })
  })

  it('A5 a writer OUTSIDE the dispute lock (none exists today; the guarantee must not depend on that) changes the dispute while the cleanup decides: the row lock makes the cleanup wait and then reject', async () => {
    const o = await openedDispute('a5')
    const pending = await rule(o, getDisputeService(), 'RELEASE', o.arbiterId, arbiterKp)
    await stale(pending.id, o)
    const generation = await generationOf(pending.id)

    let commit!: () => void
    const mayCommit = new Promise<void>((r) => { commit = r })
    let written!: () => void
    const hasWritten = new Promise<void>((r) => { written = r })
    const rogue = prisma.$transaction(async (tx) => {
      await tx.dispute.update({ where: { id: o.disputeId }, data: { status: 'APPEALED', ruling: null, appealRound: 1 } })
      written()
      await mayCommit
    }, { timeout: 30_000 })
    await hasWritten

    const cleaner = decide(pending.id, o.escrowId, generation)
    let blocked = false
    for (let i = 0; i < 100 && !blocked; i++) {
      const rows = await prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND wait_event = 'transactionid' AND datname = current_database()`
      blocked = rows[0].n > 0
      if (!blocked) await new Promise((r) => setTimeout(r, 20))
    }
    expect(blocked).toBe(true) // the cleanup is queued on the dispute row, not deciding on a stale read
    commit()
    await rogue

    expect(await cleaner).toBe('PROVENANCE_REJECTED')
    expect(await roundState(pending.id)).toEqual({ pending: true, signatures: 0 })
  })

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // (3) no durable signature is lost
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  it('S1 the signer takes the escrow lock first: its signature is durable and the cleanup, queued behind it, keeps the round', async () => {
    const o = await openedDispute('s1')
    const pending = await rule(o, getDisputeService(), 'RELEASE', o.arbiterId, arbiterKp)
    await stale(pending.id, o)
    const generation = await generationOf(pending.id)
    const signed = await buyerSigns(pending.id)

    const releaseE = await holdE(o)
    const signer = submitTransactionSignature(o.escrowId, o.buyerId, signed)
    await untilWaiting(1)
    const cleaner = decide(pending.id, o.escrowId, generation)
    await untilWaiting(2)
    await releaseE()

    expect(await signer).toMatchObject({ complete: false, submittedCount: 1 })
    expect(await cleaner).toBe('SIGNED_MEANWHILE')
    expect(await roundState(pending.id)).toEqual({ pending: true, signatures: 1 })
  })

  it('S2 the cleanup takes the escrow lock first: the round is deleted and the signer fails closed, leaving no orphan signature', async () => {
    const o = await openedDispute('s2')
    const pending = await rule(o, getDisputeService(), 'RELEASE', o.arbiterId, arbiterKp)
    await stale(pending.id, o)
    const generation = await generationOf(pending.id)
    const signed = await buyerSigns(pending.id)

    const releaseE = await holdE(o)
    const cleaner = decide(pending.id, o.escrowId, generation)
    await untilWaiting(1)
    const signer = submitTransactionSignature(o.escrowId, o.buyerId, signed).then(() => 'accepted', (err: Error) => err.message)
    await untilWaiting(2)
    await releaseE()

    expect(await cleaner).toBe('DELETED')
    expect(await signer).toMatch(/no longer exists \(cleaned up or replaced\) - signature not accepted|no longer exists \(cleaned up or replaced\) — signature not accepted/)
    expect(await roundState(pending.id)).toEqual({ pending: false, signatures: 0 })
    expect(await prisma.escrowTransactionSignature.count({ where: { pendingTxId: pending.id } })).toBe(0)
  })

  it('S3 a signature accepted on the round after the generation was appealed is durable, and the cleanup keeps it (the signature outranks the dispute check)', async () => {
    const o = await openedDispute('s3')
    const pending = await rule(o, getDisputeService(), 'RELEASE', o.arbiterId, arbiterKp)
    await stale(pending.id, o)
    await makeAppealable(o)
    await appealService().appeal(o.disputeId, o.buyerId)

    const accepted = await submitTransactionSignature(o.escrowId, o.buyerId, await buyerSigns(pending.id))
    expect(accepted).toMatchObject({ complete: false, submittedCount: 1 })
    expect(await decide(pending.id, o.escrowId, await generationOf(pending.id))).toBe('SIGNED_MEANWHILE')
    expect(await roundState(pending.id)).toEqual({ pending: true, signatures: 1 })
  })

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // (4) reversal of the authority; already committed economic effects
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  it('E1 production resolveDispute guard failure deletes only its unsigned exact round before reverting authority', async () => {
    const o = await openedDispute('e1')
    const realInitiate = escrowService.initiateRelease.bind(escrowService)
    let persistedId: string | undefined
    jest.spyOn(escrowService, 'initiateRelease').mockImplementation(async (...args: unknown[]) => {
      const result = await (realInitiate as (...a: unknown[]) => Promise<unknown>)(...args)
      const pending = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: o.escrowId } })
      persistedId = pending.id
      // Inject an invalid translation precisely after production persists it and
      // before resolveDispute's own guard inspects it. No helper is called by the test.
      await corrupt(pending.id)
      // The service guards the returned translation, not a second DB read.
      // Reflect the corrupted persisted PSBT in the production service's
      // return value so both guard inputs and durable bytes are identical.
      const corrupted = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { id: pending.id } })
      return { ...(result as object), unsignedPsbtBase64: corrupted.unsignedPsbtBase64 }
    })
    const dispute = await disputeOf(o)
    const issuedAt = new Date().toISOString()
    const payload = { disputeId: o.disputeId, escrowId: o.escrowId, appealRound: dispute.appealRound, authorityId: o.arbiterId, outcome: 'RELEASE' as const, buyerBps: null, issuedAt }
    const signature = signAuthorityDecision(payload, arbiterKp.secretKey)
    await expect(getDisputeService().resolveDispute(o.disputeId, o.arbiterId, 'RELEASE', undefined, undefined, undefined, signature, issuedAt)).rejects.toThrow()
    expect(persistedId).toBeDefined()
    expect(await roundState(persistedId!)).toEqual({ pending: false, signatures: 0 })
    expect(await outcomeRecords(o)).toBe(0)
    expect((await disputeOf(o)).status).not.toBe('RESOLVED')
  })

  it('F1 declared miner fee mismatch rejects exact unsigned round without erasing its ruling before proof', async () => {
    const o = await openedDispute('fee-mismatch')
    const pending = await rule(o, getDisputeService(), 'RELEASE', o.arbiterId, arbiterKp)
    const stored = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { id: pending.id } })
    // Fault injection: the declared fee no longer agrees with the signed transaction's
    // economic outputs. This is durable input to the same production guard used by cleanup.
    await prisma.escrowPendingTransaction.update({
      where: { id: pending.id },
      data: { minerFeeSats: Number(stored.minerFeeSats ?? 0) + 1 },
    })
    expect(await decide(pending.id, o.escrowId, await generationOf(pending.id))).toBe('DELETED')
    expect(await roundState(pending.id)).toEqual({ pending: false, signatures: 0 })
    expect(await outcomeRecords(o)).toBe(1)
    expect((await disputeOf(o)).status).toBe('RESOLVED')
  })

  it('F2 signed pending with mismatched miner fee is never deleted by fee-parity cleanup', async () => {
    const o = await openedDispute('fee-signed')
    const pending = await rule(o, getDisputeService(), 'RELEASE', o.arbiterId, arbiterKp)
    const stored = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { id: pending.id } })
    await prisma.escrowPendingTransaction.update({
      where: { id: pending.id },
      data: { minerFeeSats: Number(stored.minerFeeSats ?? 0) + 1 },
    })
    await prisma.escrowTransactionSignature.create({
      data: { pendingTxId: pending.id, participantId: o.buyerId, signedPsbtBase64: 'st1-f2-signed-veto' },
    })
    expect(await decide(pending.id, o.escrowId, await generationOf(pending.id))).toBe('SIGNED_MEANWHILE')
    expect(await roundState(pending.id)).toEqual({ pending: true, signatures: 1 })
    expect(await outcomeRecords(o)).toBe(1)
    expect((await disputeOf(o)).status).toBe('RESOLVED')
  })

  it('E2 production resolveDispute refuses cleanup of a signed round and preserves the committed ruling', async () => {
    const o = await openedDispute('e2')
    const realInitiate = escrowService.initiateRelease.bind(escrowService)
    let persistedId: string | undefined
    jest.spyOn(escrowService, 'initiateRelease').mockImplementation(async (...args: unknown[]) => {
      const result = await (realInitiate as (...a: unknown[]) => Promise<unknown>)(...args)
      const pending = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: o.escrowId } })
      persistedId = pending.id
      await corrupt(pending.id)
      // Simulate a signer winning the race before the service guard runs.
      // An existing signature is durable economic evidence: deletion must refuse.
      await prisma.escrowTransactionSignature.create({
        data: { pendingTxId: pending.id, participantId: o.buyerId, signedPsbtBase64: 'st1-e2-race-proof' },
      })
      const corrupted = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { id: pending.id } })
      return { ...(result as object), unsignedPsbtBase64: corrupted.unsignedPsbtBase64 }
    })
    const dispute = await disputeOf(o)
    const issuedAt = new Date().toISOString()
    const payload = { disputeId: o.disputeId, escrowId: o.escrowId, appealRound: dispute.appealRound, authorityId: o.arbiterId, outcome: 'RELEASE' as const, buyerBps: null, issuedAt }
    const signature = signAuthorityDecision(payload, arbiterKp.secretKey)
    await expect(getDisputeService().resolveDispute(o.disputeId, o.arbiterId, 'RELEASE', undefined, undefined, undefined, signature, issuedAt))
      .rejects.toThrow(/ST1-R2|deletion proof|SIGNED_MEANWHILE/i)
    expect(persistedId).toBeDefined()
    expect(await roundState(persistedId!)).toEqual({ pending: true, signatures: 1 })
    expect((await disputeOf(o)).status).toBe('RESOLVED')
    expect(await outcomeRecords(o)).toBe(1)
  })

  it('V1 after-persist throw never erases the committed Outcome; cleanup deletes an invalid unsigned pending', async () => {
    const o = await openedDispute('v1')
    const realInitiate = escrowService.initiateRelease.bind(escrowService)
    const failing = jest.spyOn(escrowService, 'initiateRelease').mockImplementation(async (...args: unknown[]) => {
      await (realInitiate as (...a: unknown[]) => Promise<unknown>)(...args)
      throw new Error('injected: failure after the round was persisted')
    })
    const dispute = await prisma.dispute.findUniqueOrThrow({ where: { id: o.disputeId } })
    const issuedAt = new Date().toISOString()
    const payload = { disputeId: o.disputeId, escrowId: o.escrowId, appealRound: dispute.appealRound, authorityId: o.arbiterId, outcome: 'RELEASE' as const, buyerBps: null, issuedAt }
    try {
      await expect(getDisputeService().resolveDispute(o.disputeId, o.arbiterId, 'RELEASE', undefined, undefined, undefined, signAuthorityDecision(payload, arbiterKp.secretKey), issuedAt))
        .rejects.toThrow(/ST1-R2 V3/)
    } finally {
      failing.mockRestore()
    }
    const pending = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: o.escrowId } })
    expect(pending.disputeId).toBe(o.disputeId)
    expect((await disputeOf(o)).status).toBe('RESOLVED')
    expect(await outcomeRecords(o)).toBe(1)
    await stale(pending.id, o)
    expect(await decide(pending.id, o.escrowId, await generationOf(pending.id))).toBe('DELETED')
    expect(await roundState(pending.id)).toEqual({ pending: false, signatures: 0 })
  })

  it('V3-N no-persist dispatch failure reverts the exact ruling and Outcome without orphan pending', async () => {
    const o = await openedDispute('v3-no-persist')
    const before = await disputeOf(o)
    const failure = jest.spyOn(escrowService, 'initiateRelease').mockRejectedValueOnce(new Error('injected: dispatch rejected before persistence'))
    const issuedAt = new Date().toISOString()
    const payload = { disputeId: o.disputeId, escrowId: o.escrowId, appealRound: before.appealRound, authorityId: o.arbiterId, outcome: 'RELEASE' as const, buyerBps: null, issuedAt }
    try {
      await expect(getDisputeService().resolveDispute(o.disputeId, o.arbiterId, 'RELEASE', undefined, undefined, undefined, signAuthorityDecision(payload, arbiterKp.secretKey), issuedAt))
        .rejects.toThrow(/dispatch rejected before persistence/)
    } finally {
      failure.mockRestore()
    }
    expect(await prisma.escrowPendingTransaction.findUnique({ where: { escrowId: o.escrowId } })).toBeNull()
    const after = await disputeOf(o)
    expect(after.status).toBe(before.status)
    expect(after.ruling).toBeNull()
    expect(after.authoritySignature).toBeNull()
    expect(await outcomeRecords(o)).toBe(0)
  })

  it('V3-A injected Outcome deletion failure rolls back the dispute update atomically', async () => {
    const o = await openedDispute('v3-atomic-fault')
    const before = await disputeOf(o)
    const realTransaction = prisma.$transaction.bind(prisma)
    let injected = false
    // Intercept only the transaction that deletes this escrow's ruling Outcome.
    // The actual dispute update and database transaction still execute against PostgreSQL.
    const transactionSpy = jest.spyOn(prisma, '$transaction').mockImplementation(((callback: any, options?: any) => {
      if (typeof callback !== 'function') return (realTransaction as any)(callback, options)
      return (realTransaction as any)(async (tx: any) => callback(new Proxy(tx, {
        get(target, prop) {
          if (prop === 'semanticTransitionRecord') {
            return new Proxy(target.semanticTransitionRecord, {
              get(delegate, method) {
                if (method === 'deleteMany') return async (args: any) => {
                  if (args?.where?.interactionId === o.escrowId &&
                      args?.where?.transitionType === 'escrow.dispute.rule') {
                    injected = true
                    throw new Error('injected: atomic Outcome deletion failure')
                  }
                  return delegate.deleteMany(args)
                }
                const value = (delegate as any)[method]
                return typeof value === 'function' ? value.bind(delegate) : value
              },
            })
          }
          const value = (target as any)[prop]
          return typeof value === 'function' ? value.bind(target) : value
        },
      })), options)
    }) as any)
    const dispatch = jest.spyOn(escrowService, 'initiateRelease')
      .mockRejectedValueOnce(new Error('injected: dispatch failed before pending persistence'))
    const issuedAt = new Date().toISOString()
    const payload = { disputeId: o.disputeId, escrowId: o.escrowId, appealRound: before.appealRound, authorityId: o.arbiterId, outcome: 'RELEASE' as const, buyerBps: null, issuedAt }
    try {
      await expect(getDisputeService().resolveDispute(o.disputeId, o.arbiterId, 'RELEASE', undefined, undefined, undefined, signAuthorityDecision(payload, arbiterKp.secretKey), issuedAt))
        .rejects.toThrow(/atomic Outcome deletion failure/)
    } finally {
      dispatch.mockRestore()
      transactionSpy.mockRestore()
    }
    expect(injected).toBe(true)
    // If updateMany were committed before deleteMany, this would incorrectly
    // restore OPEN while leaving the committed Outcome behind.
    const afterFault = await disputeOf(o)
    expect(afterFault.status).toBe('RESOLVED')
    expect(afterFault.ruling).toBe('RELEASE')
    expect(afterFault.authoritySignature).toBeTruthy()
    expect(await outcomeRecords(o)).toBe(1)
    expect(await prisma.escrowPendingTransaction.findUnique({ where: { escrowId: o.escrowId } })).toBeNull()

    // Remove the injected fault, then retry the same signed decision. The
    // original ruling is still durable and must not be duplicated or erased.
    // A repeated call must not manufacture a second Outcome or pending round.
    const dispatchRetry = jest.spyOn(escrowService, 'initiateRelease')
      .mockRejectedValueOnce(new Error('injected: retry dispatch unavailable'))
    try {
      await expect(getDisputeService().resolveDispute(o.disputeId, o.arbiterId, 'RELEASE', undefined, undefined, undefined, signAuthorityDecision(payload, arbiterKp.secretKey), issuedAt))
        .rejects.toThrow()
    } finally {
      dispatchRetry.mockRestore()
    }
    expect((await disputeOf(o)).status).toBe('RESOLVED')
    expect(await outcomeRecords(o)).toBe(1)
  })

  it('V3-PG PostgreSQL division-by-zero aborts the real D-to-E rollback transaction atomically', async () => {
    const o = await openedDispute('v3-pg-atomic')
    const before = await disputeOf(o)
    const realTransaction = prisma.$transaction.bind(prisma)
    let databaseFaultAttempted = false
    // Trigger a real SQLSTATE 22012 inside the same live PostgreSQL
    // transaction, at the Outcome-delete boundary AFTER dispute.updateMany.
    const transactionSpy = jest.spyOn(prisma, '$transaction').mockImplementation(((callback: any, options?: any) => {
      if (typeof callback !== 'function') return (realTransaction as any)(callback, options)
      return (realTransaction as any)((tx: any) => callback(new Proxy(tx, {
        get(target, prop) {
          if (prop === 'semanticTransitionRecord') {
            return new Proxy(target.semanticTransitionRecord, {
              get(delegate, method) {
                if (method === 'deleteMany') return async (args: any) => {
                  if (args?.where?.interactionId === o.escrowId &&
                      args?.where?.transitionType === 'escrow.dispute.rule') {
                    databaseFaultAttempted = true
                    await tx.$executeRawUnsafe('SELECT 1 / 0')
                    throw new Error('PostgreSQL unexpectedly accepted division by zero')
                  }
                  return delegate.deleteMany(args)
                }
                const value = (delegate as any)[method]
                return typeof value === 'function' ? value.bind(delegate) : value
              },
            })
          }
          const value = (target as any)[prop]
          return typeof value === 'function' ? value.bind(target) : value
        },
      })), options)
    }) as any)
    const dispatch = jest.spyOn(escrowService, 'initiateRelease')
      .mockRejectedValueOnce(new Error('injected: no pending persisted'))
    const issuedAt = new Date().toISOString()
    const payload = { disputeId: o.disputeId, escrowId: o.escrowId, appealRound: before.appealRound, authorityId: o.arbiterId, outcome: 'RELEASE' as const, buyerBps: null, issuedAt }
    try {
      await expect(getDisputeService().resolveDispute(o.disputeId, o.arbiterId, 'RELEASE', undefined, undefined, undefined, signAuthorityDecision(payload, arbiterKp.secretKey), issuedAt))
        .rejects.toThrow(/division by zero/i)
    } finally {
      dispatch.mockRestore()
      transactionSpy.mockRestore()
    }
    expect(databaseFaultAttempted).toBe(true)
    // The PostgreSQL error must roll back the *entire* dispute mutation,
    // not merely preserve status while silently altering the generation.
    const afterSqlFault = await disputeOf(o)
    expect(afterSqlFault.status).toBe('RESOLVED')
    expect(afterSqlFault.ruling).toBe('RELEASE')
    expect(afterSqlFault.appealRound).toBe(before.appealRound)
    expect(afterSqlFault.authoritySignature).toBeTruthy()
    expect(await outcomeRecords(o)).toBe(1)
    expect(await prisma.escrowPendingTransaction.findUnique({ where: { escrowId: o.escrowId } })).toBeNull()

    // Fault is removed. A fresh dispatch failure must now take the normal
    // guarded rollback path and remove the original ruling/Outcome exactly once.
    const retryFailure = jest.spyOn(escrowService, 'initiateRelease')
      .mockRejectedValueOnce(new Error('injected: clean retry without pending'))
    try {
      await expect(getDisputeService().resolveDispute(o.disputeId, o.arbiterId, 'RELEASE', undefined, undefined, undefined, signAuthorityDecision(payload, arbiterKp.secretKey), issuedAt))
        .rejects.toThrow()
    } finally {
      retryFailure.mockRestore()
    }
    // A repeated decision must not erase the durable authority established
    // before the database fault or manufacture a second Outcome.
    const afterReplay = await disputeOf(o)
    expect(afterReplay.status).toBe('RESOLVED')
    expect(afterReplay.ruling).toBe('RELEASE')
    expect(afterReplay.appealRound).toBe(before.appealRound)
    expect(afterReplay.authoritySignature).toBe(afterSqlFault.authoritySignature)
    expect(await outcomeRecords(o)).toBe(1)
    expect(await prisma.escrowPendingTransaction.findUnique({ where: { escrowId: o.escrowId } })).toBeNull()

    // The public resolveDispute API intentionally refuses replay of a
    // RESOLVED ruling. Recovery of a persisted ruling is a separate operation,
    // not another signed decision through the original endpoint.
    await expect(getDisputeService().resolveDispute(o.disputeId, o.arbiterId, 'RELEASE', undefined, undefined, undefined, signAuthorityDecision(payload, arbiterKp.secretKey), issuedAt))
      .rejects.toThrow(/already resolved/i)
    expect(await prisma.escrowPendingTransaction.findUnique({ where: { escrowId: o.escrowId } })).toBeNull()
    expect(await outcomeRecords(o)).toBe(1)
    expect((await disputeOf(o)).authoritySignature).toBe(afterSqlFault.authoritySignature)
  })

  it('V3-E durable economic authorization refuses rollback even when dispatch loses its pending round', async () => {
    const o = await openedDispute('v3-eda-no-pending')
    const realInitiate = escrowService.initiateRelease.bind(escrowService)
    const failing = jest.spyOn(escrowService, 'initiateRelease').mockImplementation(async (...args: unknown[]) => {
      await (realInitiate as (...a: unknown[]) => Promise<unknown>)(...args)
      const pending = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: o.escrowId } })
      await authorizeDisputedPendingExecution(pending)
      expect(await edaCount(o)).toBe(1)
      // Fault injection: emulate pending lifecycle loss after a durable economic
      // authorization. This is an adversarial state, not claimed as a normal path.
      await prisma.escrowPendingTransaction.delete({ where: { id: pending.id } })
      throw new Error('injected: authorized pending disappeared before dispatch returned')
    })
    const before = await disputeOf(o)
    const issuedAt = new Date().toISOString()
    const payload = { disputeId: o.disputeId, escrowId: o.escrowId, appealRound: before.appealRound, authorityId: o.arbiterId, outcome: 'RELEASE' as const, buyerBps: null, issuedAt }
    try {
      await expect(getDisputeService().resolveDispute(o.disputeId, o.arbiterId, 'RELEASE', undefined, undefined, undefined, signAuthorityDecision(payload, arbiterKp.secretKey), issuedAt))
        .rejects.toThrow(/ST1-R2 V3/)
    } finally {
      failing.mockRestore()
    }
    expect(await edaCount(o)).toBe(1)
    const preserved = await disputeOf(o)
    expect(preserved.status).toBe('RESOLVED')
    expect(preserved.ruling).toBe('RELEASE')
    expect(preserved.appealRound).toBe(before.appealRound)
    expect(preserved.authoritySignature).toBeTruthy()
    expect(await outcomeRecords(o)).toBe(1)
    expect(await prisma.escrowPendingTransaction.findUnique({ where: { escrowId: o.escrowId } })).toBeNull()
    // The recovery sweep must not erase a committed economic authorization
    // merely because its originating pending row is absent.
    const [recovery] = await reconcileScoped([o.escrowId])
    expect(recovery.reconciled).not.toContainEqual(expect.objectContaining({ escrowId: o.escrowId }))
    expect(await edaCount(o)).toBe(1)
    expect(await disputeOf(o)).toEqual(preserved)
    expect(await outcomeRecords(o)).toBe(1)
  })

  it('V3 after-persist dispatch throw preserves exact durable authority and pending for restart recovery', async () => {
    const o = await openedDispute('v3')
    const realInitiate = escrowService.initiateRelease.bind(escrowService)
    const failing = jest.spyOn(escrowService, 'initiateRelease').mockImplementation(async (...args: unknown[]) => {
      await (realInitiate as (...a: unknown[]) => Promise<unknown>)(...args)
      throw new Error('injected: failure after the round was persisted')
    })
    const dispute = await disputeOf(o)
    const issuedAt = new Date().toISOString()
    const payload = { disputeId: o.disputeId, escrowId: o.escrowId, appealRound: dispute.appealRound, authorityId: o.arbiterId, outcome: 'RELEASE' as const, buyerBps: null, issuedAt }
    const signature = signAuthorityDecision(payload, arbiterKp.secretKey)
    try {
      await expect(getDisputeService().resolveDispute(o.disputeId, o.arbiterId, 'RELEASE', undefined, undefined, undefined, signature, issuedAt))
        .rejects.toThrow(/ST1-R2 V3/)
    } finally {
      failing.mockRestore()
    }
    const pending = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: o.escrowId } })
    expect(await roundState(pending.id)).toEqual({ pending: true, signatures: 0 })
    expect((await disputeOf(o)).status).toBe('RESOLVED')
    expect(await outcomeRecords(o)).toBe(1)
    await age(pending.id)
    const [report] = await reconcileScoped([o.escrowId])
    expect(report.reconciled).toEqual(expect.arrayContaining([
      expect.objectContaining({ escrowId: o.escrowId, verdict: 'LEFT_GUARD_PASSED' }),
    ]))
    expect(await roundState(pending.id)).toEqual({ pending: true, signatures: 0 })
    expect(await outcomeRecords(o)).toBe(1)
  })

  it('V3-WK SIGKILLs the actual writer OS process after its real pending persists, then recovers independently', async () => {
    const o = await openedDispute('v3-writer-sigkill')
    const escrow = await prisma.escrow.findUniqueOrThrow({ where: { id: o.escrowId } })
    const dispute = await disputeOf(o)
    const issuedAt = new Date().toISOString()
    const payload = { disputeId: o.disputeId, escrowId: o.escrowId, appealRound: dispute.appealRound, authorityId: o.arbiterId, outcome: 'RELEASE' as const, buyerBps: null, issuedAt }
    const signature = signAuthorityDecision(payload, arbiterKp.secretKey)
    const { spawn } = require('child_process') as typeof import('child_process')
    const { resolve } = require('path') as typeof import('path')
    const childCode = String.raw`
      require('ts-node/register/transpile-only')
      const { prisma } = require('./src/common/database')
      const { escrowService } = require('./src/modules/open-settlement/escrow.service')
      const { getDisputeService } = require('./src/modules/open-settlement/dispute.service')
      const { intentEngine } = require('./src/core/intent-engine')
      const { OpenP2PTradeIntentHandler } = require('./src/modules/open-p2p/intent-handler')
      intentEngine.registerHandler(OpenP2PTradeIntentHandler)
      require('./src/common/events/handlers').registerEventHandlers()
      const txid = process.env.ST1_WRITER_TXID
      global.fetch = async url => {
        const path = String(url)
        if (path.includes('/blocks/tip/height')) return { ok: true, text: async () => '100' }
        if (path.includes('/tx/' + txid + '/status')) return { ok: true, json: async () => ({ confirmed: true, block_height: 100 }) }
        if (path.includes('/v1/fees/recommended')) return { ok: true, json: async () => ({ halfHourFee: 5, fastestFee: 8 }) }
        return { ok: true, json: async () => [{ txid, vout: 0, value: 100000, status: { confirmed: true } }] }
      }
      const realInitiate = escrowService.initiateRelease.bind(escrowService)
      escrowService.initiateRelease = async (...args) => {
        const result = await realInitiate(...args)
        const row = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: process.env.ST1_WRITER_ESCROW } })
        process.stdout.write('ST1_WRITER_PERSISTED:' + row.id + '\\n')
        await new Promise(() => {})
        return result
      }
      getDisputeService().resolveDispute(
        process.env.ST1_WRITER_DISPUTE, process.env.ST1_WRITER_ARBITER, 'RELEASE',
        undefined, undefined, undefined, process.env.ST1_WRITER_SIGNATURE,
        process.env.ST1_WRITER_ISSUED_AT
      ).catch(e => { process.stderr.write(String(e.stack || e)); process.exit(1) })
    `
    const child = spawn(process.execPath, ['-e', childCode], {
      cwd: resolve(__dirname, '../..'),
      env: {
        ...process.env, MOCK_ESCROW: 'false',
        MULTISIG_SEED: process.env.MULTISIG_SEED || 'st1-temporal-seed',
        TRUSTED_ARBITRATORS: process.env.TRUSTED_ARBITRATORS || ARBITER_ID,
        ST1_WRITER_TXID: escrow.txLockId!, ST1_WRITER_ESCROW: o.escrowId,
        ST1_WRITER_DISPUTE: o.disputeId, ST1_WRITER_ARBITER: o.arbiterId,
        ST1_WRITER_SIGNATURE: signature, ST1_WRITER_ISSUED_AT: issuedAt,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const marker = await new Promise<string>((done, reject) => {
      const watchdog = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('writer never persisted: ' + stderr.slice(-2000))) }, 60_000)
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
        const match = stdout.match(/ST1_WRITER_PERSISTED:([^\r\n]+)/)
        if (match) { clearTimeout(watchdog); done(match[1]) }
      })
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      child.on('error', err => { clearTimeout(watchdog); reject(err) })
      child.on('exit', code => { if (!stdout.includes('ST1_WRITER_PERSISTED:')) { clearTimeout(watchdog); reject(new Error('writer exited ' + code + ': ' + stderr.slice(-2000))) } })
    })
    const killed = new Promise<{ signal: NodeJS.Signals | null }>((done) => child.once('close', (_code, signal) => done({ signal })))
    child.kill('SIGKILL')
    expect((await killed).signal).toBe('SIGKILL')
    const pending = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { id: marker } })
    const before = await disputeOf(o)
    const generation = await generationOf(marker)
    expect(before.status).toBe('RESOLVED')
    expect(await outcomeRecords(o)).toBe(1)
    await age(marker)
    const recoveryCode = String.raw`
      require('ts-node/register/transpile-only')
      const { prisma } = require('./src/common/database')
      const { reconcileStalePendingDisputeTranslations } = require('./src/modules/open-settlement/dispute-pending-reconciliation')
      reconcileStalePendingDisputeTranslations().then(async report => {
        process.stdout.write('ST1_RECOVERY:' + JSON.stringify(report) + '\\n')
        await prisma.$disconnect()
        process.exit(0)
      }).catch(async e => { process.stderr.write(String(e.stack || e)); await prisma.$disconnect(); process.exit(1) })
    `
    const recovered = await new Promise<{ code: number | null; output: string; errors: string }>((done, reject) => {
      const worker = spawn(process.execPath, ['-e', recoveryCode], {
        cwd: resolve(__dirname, '../..'),
        env: { ...process.env, MOCK_ESCROW: 'false', MULTISIG_SEED: process.env.MULTISIG_SEED || 'st1-temporal-seed' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''; let errors = ''
      worker.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
      worker.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString() })
      const watchdog = setTimeout(() => worker.kill('SIGKILL'), 60_000)
      worker.on('error', e => { clearTimeout(watchdog); reject(e) })
      worker.on('close', code => { clearTimeout(watchdog); done({ code, output, errors }) })
    })
    expect(recovered.code).toBe(0)
    const line = recovered.output.split('\n').find(x => x.startsWith('ST1_RECOVERY:'))
    expect(line).toBeDefined()
    const report = JSON.parse(line!.slice('ST1_RECOVERY:'.length))
    expect(report.reconciled).toContainEqual(expect.objectContaining({
      escrowId: o.escrowId, pendingTransactionId: marker, verdict: 'LEFT_GUARD_PASSED',
    }))
    expect(await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { id: marker } })).toEqual(pending)
    expect(await generationOf(marker)).toEqual(generation)
    expect(await disputeOf(o)).toEqual(before)
    expect(await outcomeRecords(o)).toBe(1)
    expect(await edaCount(o)).toBe(0)
  })

  it('V3-OS a fresh OS process preserves the exact persisted ruling after a writer-side post-persist failure', async () => {
    const o = await openedDispute('v3-os-post-persist')
    const realInitiate = escrowService.initiateRelease.bind(escrowService)
    const failing = jest.spyOn(escrowService, 'initiateRelease').mockImplementation(async (...args: unknown[]) => {
      await (realInitiate as (...a: unknown[]) => Promise<unknown>)(...args)
      throw new Error('injected: writer returned failure after durable pending')
    })
    const dispute = await disputeOf(o)
    const issuedAt = new Date().toISOString()
    const payload = { disputeId: o.disputeId, escrowId: o.escrowId, appealRound: dispute.appealRound, authorityId: o.arbiterId, outcome: 'RELEASE' as const, buyerBps: null, issuedAt }
    try {
      await expect(getDisputeService().resolveDispute(o.disputeId, o.arbiterId, 'RELEASE', undefined, undefined, undefined, signAuthorityDecision(payload, arbiterKp.secretKey), issuedAt))
        .rejects.toThrow(/ST1-R2 V3/)
    } finally {
      failing.mockRestore()
    }
    const pending = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: o.escrowId } })
    const before = await disputeOf(o)
    const generation = await generationOf(pending.id)
    await age(pending.id)
    const { spawn } = require('child_process') as typeof import('child_process')
    const { resolve } = require('path') as typeof import('path')
    const childCode = `
      require('ts-node/register/transpile-only')
      const { prisma } = require('./src/common/database')
      const { reconcileStalePendingDisputeTranslations } = require('./src/modules/open-settlement/dispute-pending-reconciliation')
      ;(async () => {
        const report = await reconcileStalePendingDisputeTranslations()
        process.stdout.write('ST1_V3_OS_RESULT:' + JSON.stringify(report) + '\\n')
        await prisma.$disconnect()
        process.exit(0)
      })().catch(async err => {
        process.stderr.write(String(err.stack || err) + '\\n')
        await prisma.$disconnect().catch(() => {})
        process.exit(1)
      })
    `
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
      const child = spawn(process.execPath, ['-e', childCode], {
        cwd: resolve(__dirname, '../..'),
        env: { ...process.env, MOCK_ESCROW: 'false', MULTISIG_SEED: process.env.MULTISIG_SEED || 'st1-temporal-seed' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''; let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      const watchdog = setTimeout(() => child.kill('SIGKILL'), 60_000)
      child.on('error', err => { clearTimeout(watchdog); reject(err) })
      child.on('close', code => { clearTimeout(watchdog); done({ code, stdout, stderr }) })
    })
    expect({ code: result.code, stderr: result.stderr.slice(-2000) }).toEqual({ code: 0, stderr: expect.any(String) })
    const line = result.stdout.split('\n').find(x => x.startsWith('ST1_V3_OS_RESULT:'))
    expect(line).toBeDefined()
    const report = JSON.parse(line!.slice('ST1_V3_OS_RESULT:'.length))
    expect(report.reconciled).toContainEqual(expect.objectContaining({
      escrowId: o.escrowId, pendingTransactionId: pending.id, verdict: 'LEFT_GUARD_PASSED',
    }))
    // A committed generation must not be changed by the recovery worker.
    // Compare both the pending row and its parent dispute, not just counts.
    const afterPending = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { id: pending.id } })
    expect(afterPending.rulingAuthoritySignature).toBe(generation.rulingAuthoritySignature)
    expect(afterPending.rulingAppealRound).toBe(generation.rulingAppealRound)
    expect(afterPending.disputeId).toBe(o.disputeId)
    expect(await prisma.escrowPendingTransaction.count({ where: { escrowId: o.escrowId } })).toBe(1)
    expect(await roundState(pending.id)).toEqual({ pending: true, signatures: 0 })
    expect(await disputeOf(o)).toEqual(before)
    expect(await outcomeRecords(o)).toBe(1)
    expect(await edaCount(o)).toBe(0)
    // A second independent recovery process must be idempotent: no new
    // pending, signature, Outcome, or economic authorization may appear.
    const replay = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
      const child = spawn(process.execPath, ['-e', childCode], {
        cwd: resolve(__dirname, '../..'),
        env: { ...process.env, MOCK_ESCROW: 'false', MULTISIG_SEED: process.env.MULTISIG_SEED || 'st1-temporal-seed' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''; let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      const watchdog = setTimeout(() => child.kill('SIGKILL'), 60_000)
      child.on('error', err => { clearTimeout(watchdog); reject(err) })
      child.on('close', code => { clearTimeout(watchdog); done({ code, stdout, stderr }) })
    })
    expect({ code: replay.code, stderr: replay.stderr.slice(-2000) }).toEqual({ code: 0, stderr: expect.any(String) })
    const replayLine = replay.stdout.split('\n').find(x => x.startsWith('ST1_V3_OS_RESULT:'))
    expect(replayLine).toBeDefined()
    const replayReport = JSON.parse(replayLine!.slice('ST1_V3_OS_RESULT:'.length))
    expect(replayReport.reconciled).not.toContainEqual(expect.objectContaining({
      escrowId: o.escrowId, verdict: 'DELETED_GUARD_FAILED',
    }))
    const replayPending = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: o.escrowId } })
    expect(replayPending.id).toBe(pending.id)
    expect(replayPending.rulingAuthoritySignature).toBe(generation.rulingAuthoritySignature)
    expect(replayPending.rulingAppealRound).toBe(generation.rulingAppealRound)
    expect(replayPending.disputeId).toBe(o.disputeId)
    expect(await prisma.escrowPendingTransaction.count({ where: { escrowId: o.escrowId } })).toBe(1)
    expect(await disputeOf(o)).toEqual(before)
    expect(await outcomeRecords(o)).toBe(1)
    expect(await edaCount(o)).toBe(0)
  })

  it('V3-S a signature persisted before dispatch throws is never lost by the rollback path', async () => {
    const o = await openedDispute('v3-signed')
    const realInitiate = escrowService.initiateRelease.bind(escrowService)
    const failing = jest.spyOn(escrowService, 'initiateRelease').mockImplementation(async (...args: unknown[]) => {
      await (realInitiate as (...a: unknown[]) => Promise<unknown>)(...args)
      const pending = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: o.escrowId } })
      await prisma.escrowTransactionSignature.create({
        data: { pendingTxId: pending.id, participantId: o.buyerId, signedPsbtBase64: 'st1-v3-signed-before-throw' },
      })
      throw new Error('injected: signed after persist')
    })
    const dispute = await disputeOf(o)
    const issuedAt = new Date().toISOString()
    const payload = { disputeId: o.disputeId, escrowId: o.escrowId, appealRound: dispute.appealRound, authorityId: o.arbiterId, outcome: 'RELEASE' as const, buyerBps: null, issuedAt }
    try {
      await expect(getDisputeService().resolveDispute(o.disputeId, o.arbiterId, 'RELEASE', undefined, undefined, undefined, signAuthorityDecision(payload, arbiterKp.secretKey), issuedAt))
        .rejects.toThrow(/ST1-R2 V3/)
    } finally {
      failing.mockRestore()
    }
    const pending = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: o.escrowId } })
    expect(await roundState(pending.id)).toEqual({ pending: true, signatures: 1 })
    expect((await disputeOf(o)).status).toBe('RESOLVED')
    expect(await outcomeRecords(o)).toBe(1)
    expect(await decide(pending.id, o.escrowId, await generationOf(pending.id))).toBe('SIGNED_MEANWHILE')
    expect(await roundState(pending.id)).toEqual({ pending: true, signatures: 1 })
  })

  it('V3-R repeated restart-style reconciliation preserves the same valid generation without duplicate dispatch', async () => {
    const o = await openedDispute('v3-repeat')
    const realInitiate = escrowService.initiateRelease.bind(escrowService)
    const failing = jest.spyOn(escrowService, 'initiateRelease').mockImplementation(async (...args: unknown[]) => {
      await (realInitiate as (...a: unknown[]) => Promise<unknown>)(...args)
      throw new Error('injected: after persisted dispatch')
    })
    const dispute = await disputeOf(o)
    const issuedAt = new Date().toISOString()
    const payload = { disputeId: o.disputeId, escrowId: o.escrowId, appealRound: dispute.appealRound, authorityId: o.arbiterId, outcome: 'RELEASE' as const, buyerBps: null, issuedAt }
    try {
      await expect(getDisputeService().resolveDispute(o.disputeId, o.arbiterId, 'RELEASE', undefined, undefined, undefined, signAuthorityDecision(payload, arbiterKp.secretKey), issuedAt))
        .rejects.toThrow(/ST1-R2 V3/)
    } finally {
      failing.mockRestore()
    }
    const pending = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: o.escrowId } })
    await age(pending.id)
    const reports = await reconcileScoped([o.escrowId], 2)
    for (const report of reports) {
      expect(report.failed).toEqual([])
      expect(report.reconciled).toEqual(expect.arrayContaining([
        expect.objectContaining({ escrowId: o.escrowId, verdict: 'LEFT_GUARD_PASSED' }),
      ]))
    }
    expect(await prisma.escrowPendingTransaction.count({ where: { escrowId: o.escrowId } })).toBe(1)
    expect(await roundState(pending.id)).toEqual({ pending: true, signatures: 0 })
    expect((await disputeOf(o)).status).toBe('RESOLVED')
    expect(await outcomeRecords(o)).toBe(1)
  })

  it('V3-I independent module graph reconciles an after-persist throw using only durable state', async () => {
    const o = await openedDispute('v3-isolated')
    const realInitiate = escrowService.initiateRelease.bind(escrowService)
    const failing = jest.spyOn(escrowService, 'initiateRelease').mockImplementation(async (...args: unknown[]) => {
      await (realInitiate as (...a: unknown[]) => Promise<unknown>)(...args)
      throw new Error('injected: after persisted dispatch')
    })
    const dispute = await disputeOf(o)
    const issuedAt = new Date().toISOString()
    const payload = { disputeId: o.disputeId, escrowId: o.escrowId, appealRound: dispute.appealRound, authorityId: o.arbiterId, outcome: 'RELEASE' as const, buyerBps: null, issuedAt }
    try {
      await expect(getDisputeService().resolveDispute(o.disputeId, o.arbiterId, 'RELEASE', undefined, undefined, undefined, signAuthorityDecision(payload, arbiterKp.secretKey), issuedAt))
        .rejects.toThrow(/ST1-R2 V3/)
    } finally {
      failing.mockRestore()
    }
    const pending = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: o.escrowId } })
    await age(pending.id)
    // The separately loaded module graph uses a different Prisma client.
    // Scope the scan to this escrow without substituting the reconciler.
    const independent = restarted!
    const delegate: any = independent.prisma.escrowPendingTransaction
    const realFindMany = delegate.findMany.bind(delegate)
    const spy = jest.spyOn(delegate, 'findMany').mockImplementation((args: any) =>
      realFindMany({ ...args, where: { AND: [args?.where ?? {}, { escrowId: o.escrowId }] } }))
    try {
      const report = await independent.reconcileStalePendingDisputeTranslations()
      expect(report.failed).toEqual([])
      expect(report.reconciled).toEqual(expect.arrayContaining([
        expect.objectContaining({ escrowId: o.escrowId, verdict: 'LEFT_GUARD_PASSED' }),
      ]))
    } finally {
      spy.mockRestore()
    }
    expect(await roundState(pending.id, independent.prisma)).toEqual({ pending: true, signatures: 0 })
    expect((await disputeOf(o)).status).toBe('RESOLVED')
    expect(await outcomeRecords(o)).toBe(1)
  })

  it('V3-G an older generation cannot authorize deletion after appeal advances the dispute', async () => {
    const o = await openedDispute('v3-generation')
    const pending = await rule(o, getDisputeService(), 'RELEASE', o.arbiterId, arbiterKp)
    const oldGeneration = await generationOf(pending.id)
    await stale(pending.id, o)
    await makeAppealable(o)
    await appealService().appeal(o.disputeId, o.buyerId)
    const appealed = await disputeOf(o)
    expect(appealed.status).not.toBe('RESOLVED')
    expect(appealed.appealRound).toBeGreaterThan(oldGeneration.rulingAppealRound)
    const outcomeBefore = await outcomeRecords(o)
    expect(await decide(pending.id, o.escrowId, oldGeneration)).toBe('PROVENANCE_REJECTED')
    expect(await roundState(pending.id)).toEqual({ pending: true, signatures: 0 })
    expect(await outcomeRecords(o)).toBe(outcomeBefore)
    const after = await disputeOf(o)
    expect(after.appealRound).toBe(appealed.appealRound)
    expect(after.status).toBe(appealed.status)
    expect(await edaCount(o)).toBe(0)
  })

  it('V3-GA an N+1 appeal committed first makes an old-generation cleanup fail closed', async () => {
    const o = await openedDispute('v3-generation-appeal-first')
    const pending = await rule(o, getDisputeService(), 'RELEASE', o.arbiterId, arbiterKp)
    const oldGeneration = await generationOf(pending.id)
    await stale(pending.id, o)
    await makeAppealable(o)
    // The legacy MULTISIG appeal fixture advances the generation using the
    // actual appeal service. It must commit before old cleanup is invoked.
    await appealService().appeal(o.disputeId, o.buyerId)
    const appealed = await disputeOf(o)
    expect(appealed.appealRound).toBeGreaterThan(oldGeneration.rulingAppealRound)
    expect(appealed.status).not.toBe('RESOLVED')
    const outcomeCount = await outcomeRecords(o)
    const pendingBefore = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { id: pending.id } })
    // The stale N decision cannot delete a pending or rewrite an N+1 dispute.
    const verdict = await decide(pending.id, o.escrowId, oldGeneration)
    expect(verdict).toBe('PROVENANCE_REJECTED')
    expect(await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { id: pending.id } })).toEqual(pendingBefore)
    expect(await disputeOf(o)).toEqual(appealed)
    expect(await outcomeRecords(o)).toBe(outcomeCount)
    expect(await edaCount(o)).toBe(0)
    // Exercise the production sweep as well as the direct guarded deleter.
    // A stale worker must not reinterpret the old pending as deletable after
    // the appeal has committed a new generation.
    const [recovery] = await reconcileScoped([o.escrowId])
    expect(recovery.reconciled).not.toContainEqual(expect.objectContaining({
      escrowId: o.escrowId,
      verdict: 'DELETED_GUARD_FAILED',
    }))
    expect(await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { id: pending.id } })).toEqual(pendingBefore)
    expect(await disputeOf(o)).toEqual(appealed)
    expect(await outcomeRecords(o)).toBe(outcomeCount)
    // Idempotent replay: a second sweep must not reinterpret the N+1 state
    // as permission to delete the old pending or its economic Outcome.
    const [secondRecovery] = await reconcileScoped([o.escrowId])
    expect(secondRecovery.reconciled).not.toContainEqual(expect.objectContaining({
      escrowId: o.escrowId,
      verdict: 'DELETED_GUARD_FAILED',
    }))
    expect(await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { id: pending.id } })).toEqual(pendingBefore)
    expect(await disputeOf(o)).toEqual(appealed)
    expect(await outcomeRecords(o)).toBe(outcomeCount)
    expect(await edaCount(o)).toBe(0)
  })

  it('V3-GR blocked old-generation cleanup resumes safely after the D lock is released', async () => {
    const o = await openedDispute('v3-generation-race')
    const pending = await rule(o, getDisputeService(), 'RELEASE', o.arbiterId, arbiterKp)
    const oldGeneration = await generationOf(pending.id)
    await stale(pending.id, o)
    await makeAppealable(o)
    const releaseD = await holdD(o)
    let released = false
    try {
      const cleanup = decide(pending.id, o.escrowId, oldGeneration)
      for (let i = 0; i < 1000; i++) {
        if ((await lockMap(o)).some(row => row.lock === 'D' && !row.granted)) break
        if (i === 999) throw new Error('old-generation cleanup never waited on D lock')
        await new Promise<void>(done => setTimeout(done, 10))
      }
      await releaseD()
      released = true
      // Cleanup is allowed to delete this stale unsigned pending before
      // the appeal commits. It must not mutate the later appeal generation.
      expect(await cleanup).toBe('DELETED')
      expect(await roundState(pending.id)).toEqual({ pending: false, signatures: 0 })
      await appealService().appeal(o.disputeId, o.buyerId)
      const appealed = await disputeOf(o)
      expect(appealed.appealRound).toBeGreaterThan(oldGeneration.rulingAppealRound)
      expect(await decide(pending.id, o.escrowId, oldGeneration)).not.toBe('DELETED')
      expect(await roundState(pending.id)).toEqual({ pending: false, signatures: 0 })
      const after = await disputeOf(o)
      expect(after.appealRound).toBe(appealed.appealRound)
      expect(after.status).toBe(appealed.status)
    } finally {
      if (!released) await releaseD()
    }
  })

  it('V2 a committed Economic Disposition Authorization names the round: the cleanup never deletes it, before or after an appeal', async () => {
    const o = await openedDispute('v2')
    const pending = await rule(o, getDisputeService(), 'RELEASE', o.arbiterId, arbiterKp)
    await stale(pending.id, o)
    const row = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { id: pending.id } })
    await authorizeDisputedPendingExecution(row) // the production gate commits the authorization
    expect(await edaCount(o)).toBe(1)
    const authorizedPending = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { id: pending.id } })
    const authorizedGeneration = await generationOf(pending.id)
    const authorizedOutcomeCount = await outcomeRecords(o)
    expect(authorizedOutcomeCount).toBe(1)

    expect(await decide(pending.id, o.escrowId, await generationOf(pending.id))).toBe('PROVENANCE_REJECTED')
    await makeAppealable(o)
    await appealService().appeal(o.disputeId, o.buyerId) // a later appeal is prospective (ADR-005 s4)
    expect(await decide(pending.id, o.escrowId, await generationOf(pending.id))).toBe('PROVENANCE_REJECTED')
    expect(await roundState(pending.id)).toEqual({ pending: true, signatures: 0 })
    expect(await edaCount(o)).toBe(1)
    const preservedPending = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { id: pending.id } })
    expect(preservedPending.id).toBe(authorizedPending.id)
    expect(preservedPending.rulingAuthoritySignature).toBe(authorizedPending.rulingAuthoritySignature)
    expect(await generationOf(pending.id)).toEqual(authorizedGeneration)
    expect(await outcomeRecords(o)).toBe(authorizedOutcomeCount)
  })

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // (5) absent Outcome: fail closed
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  it('O1 a RESOLVED dispute whose Outcome record is absent: nothing is deleted, the round is reported, no DELETED_NO_OUTCOME exists', async () => {
    const o = await openedDispute('o1')
    const pending = await rule(o, getDisputeService(), 'RELEASE', o.arbiterId, arbiterKp)
    await stale(pending.id, o)
    await revertDisputeRulingRecord(o.escrowId, 0) // production's own deleter of a ruling record
    expect(await outcomeRecords(o)).toBe(0)
    expect((await disputeOf(o)).status).toBe('RESOLVED')

    expect(await decide(pending.id, o.escrowId, await generationOf(pending.id))).toBe('OUTCOME_ABSENT')
    const [report] = await reconcileScoped([o.escrowId])
    expect(report.failed).toEqual([{ escrowId: o.escrowId, error: expect.stringMatching(/no durable Core-authoritative Outcome/) }])
    expect(report.reconciled).toEqual([])
    expect(JSON.stringify(report)).not.toContain('DELETED_NO_OUTCOME')
    expect(await roundState(pending.id)).toEqual({ pending: true, signatures: 0 })
  })

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // (6) ambiguous provenance: no automatic deletion
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  it('P1 a round with partial or absent ruling provenance is reported and never deleted', async () => {
    const o = await openedDispute('p1')
    const pending = await rule(o, getDisputeService(), 'RELEASE', o.arbiterId, arbiterKp)
    await stale(pending.id, o)

    await prisma.escrowPendingTransaction.update({ where: { id: pending.id }, data: { rulingAuthoritySignature: null } })
    let [report] = await reconcileScoped([o.escrowId])
    expect(report.failed).toEqual([{ escrowId: o.escrowId, error: 'missing or ambiguous pending ruling provenance; refusing cleanup' }])
    expect(await roundState(pending.id)).toEqual({ pending: true, signatures: 0 })

    // A cooperative-shaped round (no provenance at all) on an escrow that has a RESOLVED dispute.
    await prisma.escrowPendingTransaction.update({
      where: { id: pending.id },
      data: { disputeId: null, rulingAppealRound: null, rulingArbiterId: null, rulingOutcome: null, rulingAuthoritySignature: null, rulingAuthorityIssuedAt: null },
    })
    ;[report] = await reconcileScoped([o.escrowId])
    expect(report.failed).toEqual([{ escrowId: o.escrowId, error: 'missing or ambiguous pending ruling provenance; refusing cleanup' }])
    expect(await roundState(pending.id)).toEqual({ pending: true, signatures: 0 })
  })

  it('P1b a caller without generation or with the wrong escrow cannot delete an unsigned guard-failing round', async () => {
    const o = await openedDispute('p1b')
    const other = await openedDispute('p1b-other')
    const pending = await rule(o, getDisputeService(), 'RELEASE', o.arbiterId, arbiterKp)
    await stale(pending.id, o)
    const generation = await generationOf(pending.id)

    expect(await deletePendingRoundIfStillUnsigned(pending.id, o.escrowId, undefined)).toBe('PROVENANCE_REJECTED')
    expect(await deletePendingRoundIfStillUnsigned(pending.id, other.escrowId, generation)).toBe('PROVENANCE_REJECTED')
    expect(await roundState(pending.id)).toEqual({ pending: true, signatures: 0 })
    expect(await outcomeRecords(o)).toBe(1)

    // The same round is deletable only with its exact escrow and recorded generation.
    expect(await deletePendingRoundIfStillUnsigned(pending.id, o.escrowId, generation)).toBe('DELETED')
    expect(await roundState(pending.id)).toEqual({ pending: false, signatures: 0 })
    expect(await outcomeRecords(o)).toBe(1)
  })

  it('P1c a forged authority signature in the nominated generation cannot delete a pending round', async () => {
    const o = await openedDispute('p1c')
    const pending = await rule(o, getDisputeService(), 'RELEASE', o.arbiterId, arbiterKp)
    await stale(pending.id, o)
    const generation = await generationOf(pending.id)

    expect(await deletePendingRoundIfStillUnsigned(pending.id, o.escrowId, {
      ...generation, rulingAuthoritySignature: generation.rulingAuthoritySignature + '-forged',
    })).toBe('PROVENANCE_REJECTED')
    expect(await roundState(pending.id)).toEqual({ pending: true, signatures: 0 })
    expect(await outcomeRecords(o)).toBe(1)

    expect(await deletePendingRoundIfStillUnsigned(pending.id, o.escrowId, generation)).toBe('DELETED')
    expect(await roundState(pending.id)).toEqual({ pending: false, signatures: 0 })
    expect(await outcomeRecords(o)).toBe(1)
  })

  it('P1d a forged ruling appeal round cannot delete the current generation', async () => {
    const o = await openedDispute('p1d')
    const pending = await rule(o, getDisputeService(), 'RELEASE', o.arbiterId, arbiterKp)
    await stale(pending.id, o)
    const generation = await generationOf(pending.id)

    expect(await deletePendingRoundIfStillUnsigned(pending.id, o.escrowId, {
      ...generation, rulingAppealRound: generation.rulingAppealRound + 1,
    })).toBe('PROVENANCE_REJECTED')
    expect(await roundState(pending.id)).toEqual({ pending: true, signatures: 0 })
    expect(await outcomeRecords(o)).toBe(1)

    expect(await deletePendingRoundIfStillUnsigned(pending.id, o.escrowId, generation)).toBe('DELETED')
    expect(await roundState(pending.id)).toEqual({ pending: false, signatures: 0 })
    expect(await outcomeRecords(o)).toBe(1)
  })

  it('P1e an exact generation is not permission to delete a translation that still passes its Outcome guard', async () => {
    const o = await openedDispute('p1e')
    const pending = await rule(o, getDisputeService(), 'RELEASE', o.arbiterId, arbiterKp)
    const generation = await generationOf(pending.id)

    // The candidate is unsigned and has exact provenance, but its production
    // translation is intact. The outcome guard must veto deletion.
    expect(await roundState(pending.id)).toEqual({ pending: true, signatures: 0 })
    expect(await deletePendingRoundIfStillUnsigned(pending.id, o.escrowId, generation)).toBe('GUARD_PASSED')
    expect(await roundState(pending.id)).toEqual({ pending: true, signatures: 0 })
    expect(await outcomeRecords(o)).toBe(1)
  })

  it('P2 a round whose recorded provenance names another escrow\'s dispute is rejected even though it is internally consistent', async () => {
    const mine = await openedDispute('p2a')
    const other = await openedDispute('p2b')
    const pending = await rule(mine, getDisputeService(), 'RELEASE', mine.arbiterId, arbiterKp)
    await rule(other, getDisputeService(), 'RELEASE', other.arbiterId, arbiterKp)
    await stale(pending.id, mine)
    const otherDispute = await disputeOf(other)
    await prisma.escrowPendingTransaction.update({
      where: { id: pending.id },
      data: {
        disputeId: other.disputeId, rulingAppealRound: otherDispute.appealRound, rulingArbiterId: otherDispute.arbiterId,
        rulingOutcome: otherDispute.ruling, rulingAuthoritySignature: otherDispute.authoritySignature, rulingAuthorityIssuedAt: otherDispute.authorityIssuedAt,
      },
    })

    expect(await decide(pending.id, mine.escrowId, await generationOf(pending.id))).toBe('PROVENANCE_REJECTED')
    expect(await roundState(pending.id)).toEqual({ pending: true, signatures: 0 })
  })

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // (7) several reconcilers: at most one delete
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  it('M1 six concurrent decisions on one round: exactly one deletes, the others converge to already-gone, no error', async () => {
    const o = await openedDispute('m1')
    const pending = await rule(o, getDisputeService(), 'RELEASE', o.arbiterId, arbiterKp)
    await stale(pending.id, o)
    const generation = await generationOf(pending.id)

    const outcomes = await Promise.all(Array.from({ length: 6 }, () => decide(pending.id, o.escrowId, generation)))
    expect(outcomes.filter((x) => x === 'DELETED')).toHaveLength(1)
    expect(outcomes.filter((x) => x === 'ALREADY_GONE')).toHaveLength(5)
    expect(await roundState(pending.id)).toEqual({ pending: false, signatures: 0 })
  })

  it('M2 three concurrent full reconcilers (the real entry point): the round is deleted once and reported once', async () => {
    const o = await openedDispute('m2')
    const pending = await rule(o, getDisputeService(), 'RELEASE', o.arbiterId, arbiterKp)
    await stale(pending.id, o)

    const reports = await reconcileScoped([o.escrowId], 3)
    const deleted = reports.flatMap((r) => r.reconciled.filter((x: any) => x.verdict === 'DELETED_GUARD_FAILED'))
    expect(deleted).toEqual([{ escrowId: o.escrowId, pendingTransactionId: pending.id, verdict: 'DELETED_GUARD_FAILED' }])
    expect(reports.flatMap((r) => r.failed)).toEqual([])
    expect(await roundState(pending.id)).toEqual({ pending: false, signatures: 0 })
  })

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // (8) restart and replay
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  it('R1 the cleanup\'s backend dies holding D and waiting for E: nothing changed, no lock survives, a restarted process converges once', async () => {
    const o = await openedDispute('r1')
    const pending = await rule(o, getDisputeService(), 'RELEASE', o.arbiterId, arbiterKp)
    await stale(pending.id, o)
    const generation = await generationOf(pending.id)
    const disputeBefore = await disputeOf(o)

    const releaseE = await holdE(o)
    const doomed = decide(pending.id, o.escrowId, generation).then(() => 'completed', (err: Error) => `died: ${err.message}`)
    await untilWaiting(1)
    const waiter = (await lockMap(o)).find((l) => !l.granted)!
    await prisma.$executeRaw`SELECT pg_terminate_backend(${waiter.pid}::int)`
    expect(await doomed).toMatch(/^died/)
    await releaseE()

    expect(await waitingOnAdvisoryLocks()).toBe(0)
    expect(await roundState(pending.id, restarted!.prisma)).toEqual({ pending: true, signatures: 0 })
    expect(await edaCount(o)).toBe(0)

    // An independent module graph (its own client) decides from durable state only, exactly once.
    expect(await restarted!.deletePendingRoundIfStillUnsigned(pending.id, o.escrowId, generation)).toBe('DELETED')
    expect(await decide(pending.id, o.escrowId, generation)).toBe('ALREADY_GONE')
    expect(await roundState(pending.id)).toEqual({ pending: false, signatures: 0 })
    // no economic duplication, no generation change
    expect(await edaCount(o)).toBe(0)
    expect(await disputeOf(o)).toEqual(disputeBefore)
    expect(await outcomeRecords(o)).toBe(1)
  })

  it('R1-P a fresh OS child process executes the real reconciliation entrypoint against persisted state', async () => {
    const o = await openedDispute('r1-os-child')
    const pending = await rule(o, getDisputeService(), 'RELEASE', o.arbiterId, arbiterKp)
    await stale(pending.id, o)
    const before = await disputeOf(o)
    const { spawn } = require('child_process') as typeof import('child_process')
    const { resolve } = require('path') as typeof import('path')
    const childCode = `
      require('ts-node/register/transpile-only')
      const { prisma } = require('./src/common/database')
      const { reconcileStalePendingDisputeTranslations } = require('./src/modules/open-settlement/dispute-pending-reconciliation')
      ;(async () => {
        const result = await reconcileStalePendingDisputeTranslations()
        process.stdout.write('ST1_CHILD_RESULT:' + JSON.stringify(result) + '\\n')
        await prisma.$disconnect()
        process.exit(0)
      })().catch(async err => {
        process.stderr.write(String(err.stack || err) + '\\n')
        await prisma.$disconnect().catch(() => {})
        process.exit(1)
      })
    `
    const childResult = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
      const child = spawn(process.execPath, ['-e', childCode], {
        cwd: resolve(__dirname, '../..'),
        env: { ...process.env, MOCK_ESCROW: 'false', MULTISIG_SEED: process.env.MULTISIG_SEED || 'st1-temporal-seed' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      const watchdog = setTimeout(() => child.kill('SIGKILL'), 60_000)
      child.on('error', (err) => { clearTimeout(watchdog); reject(err) })
      child.on('close', (code) => { clearTimeout(watchdog); done({ code, stdout, stderr }) })
    })
    expect({ exitCode: childResult.code, stderr: childResult.stderr.slice(-4000) }).toEqual({ exitCode: 0, stderr: expect.any(String) })
    const resultLine = childResult.stdout.split('\n').find(line => line.startsWith('ST1_CHILD_RESULT:'))
    expect({ foundResultLine: Boolean(resultLine), exitCode: childResult.code, stdoutTail: childResult.stdout.slice(-2000), stderrTail: childResult.stderr.slice(-2000) }).toEqual({ foundResultLine: true, exitCode: 0, stdoutTail: expect.any(String), stderrTail: expect.any(String) })
    const report = JSON.parse(resultLine!.slice('ST1_CHILD_RESULT:'.length))
    expect(report.reconciled).toContainEqual({
      escrowId: o.escrowId, pendingTransactionId: pending.id, verdict: 'DELETED_GUARD_FAILED',
    })
    expect(await roundState(pending.id)).toEqual({ pending: false, signatures: 0 })
    expect(await disputeOf(o)).toEqual(before)
    expect(await outcomeRecords(o)).toBe(1)
    expect(await edaCount(o)).toBe(0)
    // Replay through the production entrypoint after the independent child
    // has exited: no additional deletion, dispatch, or authority change.
    const [replay] = await reconcileScoped([o.escrowId])
    expect(replay).toEqual({
      reconciled: [], skippedTooYoung: [], skippedHasSignatures: [], alreadyCleaned: [], failed: [],
    })
    expect(await roundState(pending.id)).toEqual({ pending: false, signatures: 0 })
    expect(await disputeOf(o)).toEqual(before)
    expect(await outcomeRecords(o)).toBe(1)
    expect(await edaCount(o)).toBe(0)
  })

  it('R1-K an OS process is SIGKILLed after a durable ruling, and a fresh process reconciles without changing authority', async () => {
    const o = await openedDispute('r1-killed-child')
    const pending = await rule(o, getDisputeService(), 'RELEASE', o.arbiterId, arbiterKp)
    await stale(pending.id, o)
    const generation = await generationOf(pending.id)
    const before = await disputeOf(o)
    const { spawn } = require('child_process') as typeof import('child_process')
    const { resolve } = require('path') as typeof import('path')
    const childCode = `
      require('ts-node/register/transpile-only')
      const { prisma } = require('./src/common/database')
      const { reconcileStalePendingDisputeTranslations } = require('./src/modules/open-settlement/dispute-pending-reconciliation')
      ;(async () => {
        const result = await reconcileStalePendingDisputeTranslations()
        process.stdout.write('ST1_CHILD_RESULT:' + JSON.stringify(result) + '\\n')
        await prisma.$disconnect()
        process.exit(0)
      })().catch(async err => {
        process.stderr.write(String(err.stack || err) + '\\n')
        await prisma.$disconnect().catch(() => {})
        process.exit(1)
      })
    `
    // A holds the real E lock, preventing any cleanup mutation by process B.
    // B must be demonstrably waiting on that lock before the OS kills it.
    const releaseE = await holdE(o)
    let child: import('child_process').ChildProcessWithoutNullStreams | undefined
    try {
      child = spawn(process.execPath, ['-e', childCode], {
        cwd: resolve(__dirname, '../..'),
        env: { ...process.env, MOCK_ESCROW: 'false', TRUSTED_ARBITRATORS: process.env.TRUSTED_ARBITRATORS || '' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let childStdout = ''; let childStderr = ''
      child.stdout.on('data', (chunk: Buffer) => { childStdout += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { childStderr += chunk.toString() })
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
        child!.on('error', reject)
        child!.on('close', (code, signal) => done({ code, signal }))
      })
      // Observe this escrow's E-lock waiter, not an unrelated suite's advisory lock.
      // The child must still be alive when PostgreSQL reports the blocked worker.
      let waitTimeout: ReturnType<typeof setTimeout> | undefined
      const waitForTarget = (async (): Promise<'waiting'> => {
        for (let i = 0; i < 1000; i++) {
          if ((await lockMap(o)).some(row => row.lock === 'E' && !row.granted)) return 'waiting'
          await new Promise<void>(done => setTimeout(done, 10))
        }
        throw new Error('R1-K child did not wait on the target escrow E lock')
      })()
      const waitResult = await Promise.race([
        waitForTarget,
        exited.then(() => 'exited' as const),
        new Promise<'timeout'>(done => { waitTimeout = setTimeout(() => done('timeout'), 45_000) }),
      ]).finally(() => { if (waitTimeout) clearTimeout(waitTimeout) })
      if (waitResult !== 'waiting') {
        throw new Error(`R1-K child did not reach advisory lock (${waitResult}); stdout=${childStdout.slice(-2000)} stderr=${childStderr.slice(-2000)}`)
      }
      const targetWaiters = (await lockMap(o)).filter(row => row.lock === 'E' && !row.granted)
      expect(targetWaiters).toHaveLength(1)
      // Confirm the target waiter is a live PostgreSQL backend. This alone does
      // not correlate its PID to the Node child; process identity remains unproven.
      const waiterActivity = await prisma.$queryRaw<Array<{ pid: number; state: string | null }>>`
        SELECT pid, state FROM pg_stat_activity WHERE pid = ${targetWaiters[0].pid}::int
      `
      expect(waiterActivity).toHaveLength(1)
      expect(waiterActivity[0].state).toBe('active')
      child.kill('SIGKILL')
      const death = await exited
      expect(death.signal).toBe('SIGKILL')
    } finally {
      if (child && !child.killed) child.kill('SIGKILL')
      await releaseE()
    }
    expect(await roundState(pending.id)).toEqual({ pending: true, signatures: 0 })
    expect(await disputeOf(o)).toEqual(before)
    expect(await outcomeRecords(o)).toBe(1)
    expect(await edaCount(o)).toBe(0)
    // Recovery must be performed by a fresh OS process, not the Jest parent.
    const recovery = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
      const worker = spawn(process.execPath, ['-e', childCode], {
        cwd: resolve(__dirname, '../..'),
        env: { ...process.env, MOCK_ESCROW: 'false', TRUSTED_ARBITRATORS: process.env.TRUSTED_ARBITRATORS || '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''; let stderr = ''
      const watchdog = setTimeout(() => worker.kill('SIGKILL'), 60_000)
      worker.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      worker.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      worker.on('error', err => { clearTimeout(watchdog); reject(err) })
      worker.on('close', code => { clearTimeout(watchdog); done({ code, stdout, stderr }) })
    })
    expect({ code: recovery.code, stderr: recovery.stderr.slice(-2000) }).toEqual({ code: 0, stderr: expect.any(String) })
    const marker = recovery.stdout.split('\n').find(line => line.startsWith('ST1_CHILD_RESULT:'))
    expect(marker).toBeDefined()
    const report = JSON.parse(marker!.slice('ST1_CHILD_RESULT:'.length))
    expect(report.reconciled).toContainEqual({ escrowId: o.escrowId, pendingTransactionId: pending.id, verdict: 'DELETED_GUARD_FAILED' })
    expect(await roundState(pending.id)).toEqual({ pending: false, signatures: 0 })
    expect(await deletePendingRoundIfStillUnsigned(pending.id, o.escrowId, generation)).toBe('ALREADY_GONE')
    expect(await disputeOf(o)).toEqual(before)
    expect(await outcomeRecords(o)).toBe(1)
    expect(await edaCount(o)).toBe(0)
    // Re-enter the actual reconciliation entrypoint after the recovered process exits.
    // The old generation must not be nominated or mutated again.
    const [postRecoveryReplay] = await reconcileScoped([o.escrowId])
    expect(postRecoveryReplay).toEqual({
      reconciled: [], skippedTooYoung: [], skippedHasSignatures: [], alreadyCleaned: [], failed: [],
    })
    expect(await roundState(pending.id)).toEqual({ pending: false, signatures: 0 })
    expect(await disputeOf(o)).toEqual(before)
    expect(await outcomeRecords(o)).toBe(1)
    expect(await edaCount(o)).toBe(0)
  })

  it('R2 replaying the whole sweep after the round is gone changes nothing durable', async () => {
    const o = await openedDispute('r2')
    const pending = await rule(o, getDisputeService(), 'RELEASE', o.arbiterId, arbiterKp)
    await stale(pending.id, o)
    const [first] = await reconcileScoped([o.escrowId])
    expect(first.reconciled).toEqual([{ escrowId: o.escrowId, pendingTransactionId: pending.id, verdict: 'DELETED_GUARD_FAILED' }])
    const disputeAfter = await disputeOf(o)

    for (let i = 0; i < 3; i++) {
      const [replay] = await reconcileScoped([o.escrowId])
      expect(replay).toEqual({ reconciled: [], skippedTooYoung: [], skippedHasSignatures: [], alreadyCleaned: [], failed: [] })
    }
    expect(await disputeOf(o)).toEqual(disputeAfter)
    expect(await edaCount(o)).toBe(0)
    expect(await outcomeRecords(o)).toBe(1)
  })

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // (9) deadlocks: stress over every actor of the graph, and a control that proves the instrument works
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  it('X1 the advisory-lock order observed inside the production transactions of every actor of the graph is acyclic, and D is never taken after E', async () => {
    const escrowIds = new Set<string>()
    const recording = recordLockOrder(escrowIds)
    try {
      // Flow 1: raise, rule (commit + dispatch), a signature, the economic gate, the cleanup.
      const f1 = await openedDispute('x1a'); escrowIds.add(f1.escrowId)
      const p1 = await rule(f1, getDisputeService(), 'RELEASE', f1.arbiterId, arbiterKp)
      await needBothSigners(p1.id, f1)
      await submitTransactionSignature(f1.escrowId, f1.buyerId, await buyerSigns(p1.id))
      await authorizeDisputedPendingExecution(await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { id: p1.id } }))
      await age(p1.id)
      await decide(p1.id, f1.escrowId, await generationOf(p1.id))

      // Flow 2: after-persist dispatch failure preserves the ruling under D -> E locks.
      const f2 = await openedDispute('x1b'); escrowIds.add(f2.escrowId)
      const realInitiate = escrowService.initiateRelease.bind(escrowService)
      const failing = jest.spyOn(escrowService, 'initiateRelease').mockImplementation(async (...args: unknown[]) => {
        await (realInitiate as (...a: unknown[]) => Promise<unknown>)(...args)
        throw new Error('injected: failure after the round was persisted')
      })
      const d2 = await prisma.dispute.findUniqueOrThrow({ where: { id: f2.disputeId } })
      const issuedAt = new Date().toISOString()
      const payload2 = { disputeId: f2.disputeId, escrowId: f2.escrowId, appealRound: d2.appealRound, authorityId: f2.arbiterId, outcome: 'RELEASE' as const, buyerBps: null, issuedAt }
      await expect(getDisputeService().resolveDispute(f2.disputeId, f2.arbiterId, 'RELEASE', undefined, undefined, undefined, signAuthorityDecision(payload2, arbiterKp.secretKey), issuedAt)).rejects.toThrow(/ST1-R2 V3/)
      failing.mockRestore()

      // Flow 3: a stale round, an appeal, the cleanup, and the real entry point.
      const f3 = await openedDispute('x1c'); escrowIds.add(f3.escrowId)
      const p3 = await rule(f3, getDisputeService(), 'RELEASE', f3.arbiterId, arbiterKp)
      await stale(p3.id, f3)
      await reconcileScoped([f3.escrowId])
      await makeAppealable(f3)
      await appealService().appeal(f3.disputeId, f3.buyerId)
    } finally {
      recording.stop()
    }

    const edges = new Set<string>()
    for (const sequence of recording.transactions) {
      const compact = sequence.filter((c, i) => i === 0 || c !== sequence[i - 1])
      for (let i = 0; i < compact.length; i++) for (let j = i + 1; j < compact.length; j++) if (compact[i] !== compact[j]) edges.add(`${compact[i]} -> ${compact[j]}`)
    }
    // eslint-disable-next-line no-console
    console.warn('ST1 OBSERVED LOCK ORDER', JSON.stringify([...edges].sort()))
    expect(edges.has('D -> E')).toBe(true) // the cleanup and the revert, observed
    expect(edges.has('E -> D')).toBe(false)
    // Acyclicity is asserted over the advisory locks - the serialization domains of this graph. Row writes are
    // recorded per table, which is not a deadlock criterion (a cycle needs the SAME row in opposite order), so
    // their edges are evidence for the reader of the logged list, not a pass/fail predicate here.
    const adjacency = new Map<string, string[]>()
    for (const edge of edges) {
      const [a, b] = edge.split(' -> ')
      if (a.startsWith('R:') || b.startsWith('R:')) continue
      adjacency.set(a, [...(adjacency.get(a) ?? []), b])
    }
    const state = new Map<string, 'visiting' | 'done'>()
    const cyclic = (node: string): boolean => {
      if (state.get(node) === 'done') return false
      if (state.get(node) === 'visiting') return true
      state.set(node, 'visiting')
      const found = (adjacency.get(node) ?? []).some(cyclic)
      state.set(node, 'done')
      return found
    }
    expect([...adjacency.keys()].some(cyclic)).toBe(false)
  })

  it('G1 stress: cleanup x2, signer-then-gate and appeal race on four escrows - no deadlock, no lock timeout, every end state self-consistent', async () => {
    const escrows: Array<{ o: Opened; pendingId: string; signed: string }> = []
    for (let i = 0; i < 4; i++) {
      const o = await openedDispute(`g1-${i}`)
      const pending = await rule(o, getDisputeService(), 'RELEASE', o.arbiterId, arbiterKp)
      await stale(pending.id, o)
      await makeAppealable(o)
      escrows.push({ o, pendingId: pending.id, signed: await buyerSigns(pending.id) })
    }
    const jitter = () => new Promise((r) => setTimeout(r, Math.floor(Math.random() * 40)))
    const attempts = await Promise.all(escrows.map(async ({ o, pendingId, signed }) => {
      const generation = await generationOf(pendingId)
      const row = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { id: pendingId } })
      expect(row.signaturesConfidential).toBe(true)
      const settle = <T>(p: Promise<T>) => p.then((value) => ({ ok: true as const, value }), (err: Error) => ({ ok: false as const, message: String(err.message) }))
      const results = await Promise.all([
        jitter().then(() => settle(decide(pendingId, o.escrowId, generation))),
        jitter().then(() => settle(decide(pendingId, o.escrowId, generation))),
        // the signer, then - as in production, where the gate runs only for a round that has its signatures - the gate
        jitter().then(async () => {
          const signed_ = await settle(submitTransactionSignature(o.escrowId, o.buyerId, signed))
          return signed_.ok ? { signer: signed_, gate: await settle(authorizeDisputedPendingExecution(row)) } : { signer: signed_, gate: null }
        }),
        jitter().then(() => settle(appealService().appeal(o.disputeId, o.buyerId))),
      ])
      return { o, pendingId, results }
    }))

    for (const { o, pendingId, results } of attempts) {
      const flat = [results[0], results[1], (results[2] as any).signer, (results[2] as any).gate, results[3]].filter(Boolean) as Array<{ ok: boolean; message?: string }>
      for (const r of flat) {
        if (!r.ok) expect(r.message).not.toMatch(/deadlock|40P01|lock timeout|55P03|canceling statement/i)
      }
      const [cleanA, cleanB, signing] = results as [any, any, { signer: { ok: boolean }; gate: { ok: boolean } | null }, any]
      const state = await roundState(pendingId)
      const eda = await edaCount(o)
      // a signature is durable exactly when its signer was told it was accepted
      expect(state.signatures).toBe(signing.signer.ok ? 1 : 0)
      // a signature never outlives its round, and a committed authorization needs both
      if (state.signatures > 0) expect(state.pending).toBe(true)
      if (eda > 0) { expect(state.signatures).toBe(1); expect(state.pending).toBe(true) }
      expect(eda).toBe(signing.gate?.ok ? 1 : 0)
      // at most one of the cleaners deleted, and only if no signature and no authorization was there to protect
      const deletions = [cleanA, cleanB].filter((c) => c.ok && c.value === 'DELETED').length
      expect(deletions).toBeLessThanOrEqual(1)
      if (deletions === 1) expect(state).toEqual({ pending: false, signatures: 0 })
    }
  })

  it('K1 a lock wait is bounded: behind a stalled holder the cleanup fails with a lock timeout, deletes nothing and succeeds once the holder is gone', async () => {
    const o = await openedDispute('k1')
    const pending = await rule(o, getDisputeService(), 'RELEASE', o.arbiterId, arbiterKp)
    await stale(pending.id, o)
    const generation = await generationOf(pending.id)

    const releaseD = await holdD(o) // a stalled holder of the dispute lock
    const started = Date.now()
    await expect(decide(pending.id, o.escrowId, generation)).rejects.toThrow(/lock timeout|55P03/i)
    expect(Date.now() - started).toBeLessThan(5000) // bounded: the sweep never hangs behind the holder
    expect(await roundState(pending.id)).toEqual({ pending: true, signatures: 0 })
    await releaseD()

    expect(await decide(pending.id, o.escrowId, generation)).toBe('DELETED')
  })

  it('G2 control: an acquirer that takes E then D against the cleanup (D then E) IS detected as a deadlock, so G1\'s silence means something', async () => {
    const o = await openedDispute('g2')
    const pending = await rule(o, getDisputeService(), 'RELEASE', o.arbiterId, arbiterKp)
    await stale(pending.id, o)
    const generation = await generationOf(pending.id)

    let proceed!: () => void
    const go = new Promise<void>((r) => { proceed = r })
    let holdsE!: () => void
    const eHeld = new Promise<void>((r) => { holdsE = r })
    const inverted = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${o.escrowId})::bigint)` // E first
      holdsE()
      await go
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${economicDispositionLockKey(o.disputeId)})::bigint)` // then D
    }, { timeout: 30_000 }).then(() => 'completed', (err: Error) => String(err.message))
    await eHeld
    const cleaner = decide(pending.id, o.escrowId, generation).then((r) => r, (err: Error) => String(err.message))
    await untilWaiting(1) // the cleanup holds D and waits for E
    proceed() // the inverted acquirer now asks for D

    const results = await Promise.all([inverted, cleaner])
    expect(results.some((r) => /deadlock/i.test(String(r)))).toBe(true)
  })
})
