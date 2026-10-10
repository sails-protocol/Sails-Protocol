// #244 (R2) — real-Postgres proof that stale dispute-pending cleanup can never destroy a signing round
// that durably accepted a signature after cleanup's zero-signature snapshot.
//
// Interleavings are forced deterministically with the real escrow-scoped advisory lock: the test holds
// the lock, queues the contenders behind it in a known order (PostgreSQL grants a lock's waiters in queue
// order, observed through pg_locks), then releases it. No timing guesses decide who wins.
//
// The race tests drive cleanup's real delete decision point, deletePendingRoundIfStillUnsigned() (the only
// way reconcileStalePendingDisputeTranslations() deletes; tests/disputePendingReconciliation.test.ts proves
// that routing). The full reconciler is not run here: its candidate scan covers every MULTISIG pending row
// in the shared database, and this suite only touches rows it created.
//
// "Restart" means an independent module graph with its own PrismaClient (jest.isolateModules), not an OS crash.
import { PrismaClient } from '@prisma/client'
import { createHash, randomBytes } from 'crypto'
import * as bitcoin from 'bitcoinjs-lib'
import * as ecc from '@bitcoinerlab/secp256k1'
import { ECPairFactory } from 'ecpair'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'
import { boundOfferRow, boundTradeRow, sellerPixAccount } from './economicFixtures'

describe('#244 stale dispute-pending cleanup vs concurrent signature — real Postgres', () => {
  jest.setTimeout(60_000)
  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let submitTransactionSignature: typeof import('../../src/modules/open-settlement/escrow-pending-tx').submitTransactionSignature
  let deletePendingRoundIfStillUnsigned: typeof import('../../src/modules/open-settlement/dispute-pending-reconciliation').deletePendingRoundIfStillUnsigned
  let restarted: {
    prisma: PrismaClient
    deletePendingRoundIfStillUnsigned: typeof deletePendingRoundIfStillUnsigned
    redis: { quit(): Promise<unknown> }
  } | undefined

  beforeAll(async () => {
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ submitTransactionSignature } = require('../../src/modules/open-settlement/escrow-pending-tx'))
    ;({ deletePendingRoundIfStillUnsigned } = require('../../src/modules/open-settlement/dispute-pending-reconciliation'))
    jest.isolateModules(() => {
      restarted = {
        prisma: require('../../src/common/database').prisma,
        deletePendingRoundIfStillUnsigned: require('../../src/modules/open-settlement/dispute-pending-reconciliation').deletePendingRoundIfStillUnsigned,
        redis: require('../../src/common/redis').redis,
      }
    })
  })

  afterEach(() => jest.restoreAllMocks())

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

  const newUser = () => prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })

  // #235 R7G-B2A — a submitted signature is verified against its round and the signer's frozen key before it
  // is stored, so the rounds here are real PSBTs over a real 2-of-3 funding surface and the buyer signs for real.
  const ECPair = ECPairFactory(ecc)
  const keyOf = (label: string) => ECPair.fromPrivateKey(createHash('sha256').update(`r244-${label}`).digest())
  const buyerKey = keyOf('buyer'), sellerKey = keyOf('seller'), arbiterKey = keyOf('arbiter')
  const network = () => {
    const { config } = require('../../src/config')
    return require('../../src/modules/open-settlement/multisig.provider').networkFor(config.multisig.network) as bitcoin.Network
  }
  const fundingSurface = () => bitcoin.payments.p2wsh({
    redeem: bitcoin.payments.p2ms({ m: 2, pubkeys: [buyerKey, sellerKey, arbiterKey].map((k) => Buffer.from(k.publicKey)).sort(Buffer.compare), network: network() }),
    network: network(),
  })
  /** A real unsigned round spending a (fixture) outpoint of the funding surface. */
  const round = (to: string) => {
    const fs = fundingSurface()
    const psbt = new bitcoin.Psbt({ network: network() })
    psbt.addInput({ hash: randomBytes(32).toString('hex'), index: 0, witnessUtxo: { script: fs.output!, value: 100_000n }, witnessScript: fs.redeem!.output! })
    psbt.addOutput({ address: bitcoin.payments.p2wpkh({ pubkey: Buffer.from(keyOf(to).publicKey), network: network() }).address!, value: 99_000n })
    return psbt.toBase64()
  }
  const buyerSigns = (unsignedPsbtBase64: string) => {
    const copy = bitcoin.Psbt.fromBase64(unsignedPsbtBase64, { network: network() })
    copy.signInput(0, buyerKey)
    return copy.toBase64()
  }

  /** A MULTISIG escrow with a RESOLVED dispute and a zero-signature pending round older than the cleanup margin. */
  async function fixture(requiredSigners: 'both' | 'buyer' = 'both') {
    const [buyer, seller, arbiter] = await Promise.all([newUser(), newUser(), newUser()])
    const acct = await sellerPixAccount(prisma, seller.id)
    const offer = await prisma.offer.create({
      data: { userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '65000', minAmount: '0.001', maxAmount: '1', ...boundOfferRow(acct) },
    })
    const trade = await prisma.trade.create({
      data: { ...boundTradeRow(acct), offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, asset: 'BTC', amount: '0.01', priceUsd: '65000', totalUsd: '650' },
    })
    const escrow = await prisma.escrow.create({ data: { tradeId: trade.id, type: 'MULTISIG', asset: 'BTC', lockedAmount: '0.001', status: 'DISPUTED', multisigAddr: fundingSurface().address!, txLockId: randomBytes(32).toString('hex'), txLockVout: 0 } }) // #235 R7G F8A: a funded escrow
    await prisma.escrowParticipantKey.createMany({ data: [
      { escrowId: escrow.id, role: 'buyer', participantId: buyer.id, pubkey: Buffer.from(buyerKey.publicKey).toString('hex') },
      { escrowId: escrow.id, role: 'seller', participantId: seller.id, pubkey: Buffer.from(sellerKey.publicKey).toString('hex') },
      { escrowId: escrow.id, role: 'arbiter', participantId: arbiter.id, pubkey: Buffer.from(arbiterKey.publicKey).toString('hex') },
    ] })
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id } })
    const dispute = await prisma.dispute.create({
      data: { tradeId: trade.id, escrowId: escrow.id, openedBy: buyer.id, reason: '#244', arbiterId: arbiter.id, status: 'RESOLVED', ruling: 'RELEASE', authoritySignature: 'st1-test-authority', resolvedAt: new Date() },
    })
    const pending = await prisma.escrowPendingTransaction.create({
      data: {
        escrowId: escrow.id, kind: 'release', toAddress: 'bc1qtest', unsignedPsbtBase64: round('release'),
        requiredSigners: requiredSigners === 'both' ? [buyer.id, seller.id] : [buyer.id], triggeredBy: arbiter.id,
        // The ruling's round (the only kind this cleanup ever meets): it carries its dispute's provenance.
        // #239D refuses cooperative signatures once a dispute exists, so a provenance-less round here would
        // test a path that no longer accepts signatures at all.
        disputeId: dispute.id, rulingAppealRound: 0, rulingArbiterId: arbiter.id, rulingOutcome: 'RELEASE',
        rulingAuthoritySignature: 'st1-test-authority', rulingAuthorityIssuedAt: dispute.resolvedAt,
        createdAt: new Date(Date.now() - 10 * 60 * 1000),
      },
    })
    return { escrow, pending, buyer, seller }
  }

  const roundState = async (pendingId: string, client: PrismaClient = prisma) => ({
    pending: (await client.escrowPendingTransaction.findUnique({ where: { id: pendingId }, select: { id: true } })) !== null,
    signatures: await client.escrowTransactionSignature.count({ where: { pendingTxId: pendingId } }),
  })

  async function generation(pendingId: string) {
    const row = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { id: pendingId } })
    if (!row.disputeId || row.rulingAppealRound === null || !row.rulingArbiterId ||
        !row.rulingOutcome || !row.rulingAuthoritySignature || !row.rulingAuthorityIssuedAt) {
      throw new Error('test fixture missing complete ruling provenance')
    }
    return {
      disputeId: row.disputeId, rulingAppealRound: row.rulingAppealRound,
      rulingArbiterId: row.rulingArbiterId, rulingOutcome: row.rulingOutcome,
      rulingAuthoritySignature: row.rulingAuthoritySignature,
      rulingAuthorityIssuedAt: row.rulingAuthorityIssuedAt,
    }
  }

  /** Cleanup as the reconciler runs it: a candidate snapshot first, then the lock-protected delete decision. */
  async function cleanup(pendingId: string, escrowId: string) {
    const snapshot = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { id: pendingId }, include: { signatures: true } })
    return { snapshotSignatures: snapshot.signatures.length, outcome: await deletePendingRoundIfStillUnsigned(pendingId, escrowId, await generation(pendingId)) }
  }

  // ── deterministic interleaving harness ──────────────────────────────────────────────────────────

  const waitingOnAdvisoryLocks = async () => (await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)[0].n
  async function untilWaiting(n: number) {
    for (let i = 0; i < 500; i++) {
      if ((await waitingOnAdvisoryLocks()) === n) return
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error(`expected ${n} advisory-lock waiter(s), saw ${await waitingOnAdvisoryLocks()}`)
  }
  /** Holds the escrow's advisory lock (withEscrowFundingLock()'s key) until released. */
  async function holdEscrowLock(escrowId: string) {
    let release!: () => void
    const released = new Promise<void>((r) => { release = r })
    let acquired!: () => void
    const isHeld = new Promise<void>((r) => { acquired = r })
    const done = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${escrowId})::bigint)`
      acquired()
      await released
    }, { timeout: 30_000 })
    await isHeld
    return async () => { release(); await done }
  }

  // ── T1: the historical race ─────────────────────────────────────────────────────────────────────

  it('T1 reproduces the historical race: zero-signature snapshot, a signature lands, the unconditional delete cascades it away', async () => {
    pg.requirePostgres('historical race')
    const { pending, buyer } = await fixture()
    const snapshot = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { id: pending.id }, include: { signatures: true } })
    expect(snapshot.signatures).toHaveLength(0) // cleanup decides: eligible

    // The pre-#244 signer: no serialization with cleanup.
    await prisma.escrowTransactionSignature.create({ data: { pendingTxId: pending.id, participantId: buyer.id, signedPsbtBase64: 'buyer-signed' } })
    expect(await roundState(pending.id)).toEqual({ pending: true, signatures: 1 })

    // The pre-#244 delete, authorized only by the stale snapshot.
    await prisma.escrowPendingTransaction.delete({ where: { id: pending.id } })
    expect(await roundState(pending.id)).toEqual({ pending: false, signatures: 0 }) // the accepted signature was destroyed
  })

  // ── T2 / T3: both winners ───────────────────────────────────────────────────────────────────────

  it('T2 signer wins: signature committed first; cleanup (snapshot said zero) re-checks under the lock and keeps the round', async () => {
    pg.requirePostgres('signer wins')
    const { escrow, pending, buyer } = await fixture()
    const release = await holdEscrowLock(escrow.id)

    const signer = submitTransactionSignature(escrow.id, buyer.id, buyerSigns(pending.unsignedPsbtBase64))
    await untilWaiting(1) // signer queued first
    const cleaner = cleanup(pending.id, escrow.id)
    await untilWaiting(2) // cleanup took its snapshot, queued second
    await release()

    const signed = await signer
    const cleaned = await cleaner
    expect(signed).toMatchObject({ complete: false, submittedCount: 1 })
    expect(cleaned).toEqual({ snapshotSignatures: 0, outcome: 'SIGNED_MEANWHILE' })
    expect(await roundState(pending.id)).toEqual({ pending: true, signatures: 1 })
  })

  it('T3 cleanup wins: zero signatures proven under the lock, round deleted; the signer re-checks and fails closed with no orphan signature', async () => {
    pg.requirePostgres('cleanup wins')
    const { escrow, pending, buyer } = await fixture()
    const release = await holdEscrowLock(escrow.id)

    const cleaner = cleanup(pending.id, escrow.id)
    await untilWaiting(1) // cleanup queued first
    const signer = submitTransactionSignature(escrow.id, buyer.id, buyerSigns(pending.unsignedPsbtBase64)).then(() => 'accepted', (err: Error) => err.message)
    await untilWaiting(2) // signer read the (still existing) round, queued second
    await release()

    expect(await cleaner).toEqual({ snapshotSignatures: 0, outcome: 'DELETED' })
    expect(await signer).toMatch(/^Escrow \S+'s pending release \S+ no longer exists \(cleaned up or replaced\) — signature not accepted/) // the service's own error, not a raw database error
    expect(await roundState(pending.id)).toEqual({ pending: false, signatures: 0 })
    expect(await prisma.escrowPendingTransaction.findUnique({ where: { escrowId: escrow.id } })).toBeNull() // nothing resurrected
  })

  it('T3b a signer that read a round cleanup then deleted never signs into a different round that exists by the time it gets the lock', async () => {
    pg.requirePostgres('generation check')
    const { escrow, pending, buyer, seller } = await fixture()
    const release = await holdEscrowLock(escrow.id)

    const cleaner = cleanup(pending.id, escrow.id)
    await untilWaiting(1)
    // How a later round comes to exist is #239's lifecycle, not this test's: it only has to exist before
    // the signer gets the lock, so it is created by a lock holder queued between cleanup and the signer.
    const creator = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${escrow.id})::bigint)`
      return tx.escrowPendingTransaction.create({
        data: { escrowId: escrow.id, kind: 'refund', toAddress: 'bc1qrefund', unsignedPsbtBase64: round('refund'), requiredSigners: [buyer.id, seller.id], triggeredBy: seller.id },
      })
    }, { timeout: 30_000 })
    await untilWaiting(2)
    const signer = submitTransactionSignature(escrow.id, buyer.id, buyerSigns(pending.unsignedPsbtBase64)).then(() => 'accepted', (err: Error) => err.message)
    await untilWaiting(3) // the signer read round A
    await release()
    expect(await cleaner).toMatchObject({ outcome: 'DELETED' })
    const roundB = await creator

    expect(await signer).toMatch(/^Escrow \S+'s pending release \S+ no longer exists \(cleaned up or replaced\) — signature not accepted/) // the service's own error, not a raw database error
    expect(await roundState(roundB.id)).toEqual({ pending: true, signatures: 0 })
    expect(await roundState(pending.id)).toEqual({ pending: false, signatures: 0 })
  })

  // ── T4 / T5 ─────────────────────────────────────────────────────────────────────────────────────

  it('T4 a genuinely stale unsigned round is deleted exactly once', async () => {
    pg.requirePostgres('genuinely stale')
    const { escrow, pending } = await fixture()

    const authority = await generation(pending.id)
    expect(await deletePendingRoundIfStillUnsigned(pending.id, escrow.id, authority)).toBe('DELETED')
    expect(await deletePendingRoundIfStillUnsigned(pending.id, escrow.id, authority)).toBe('ALREADY_GONE')
    expect(await roundState(pending.id)).toEqual({ pending: false, signatures: 0 })
  })

  it('T5 two reconcilers race the same round: at most one delete, the other converges to already-cleaned, no error', async () => {
    pg.requirePostgres('concurrent cleanup')
    const { escrow, pending } = await fixture()

    const authority = await generation(pending.id)
    const outcomes = await Promise.all([
      deletePendingRoundIfStillUnsigned(pending.id, escrow.id, authority),
      deletePendingRoundIfStillUnsigned(pending.id, escrow.id, authority),
    ])

    expect(outcomes.sort()).toEqual(['ALREADY_GONE', 'DELETED'])
    expect(await roundState(pending.id)).toEqual({ pending: false, signatures: 0 })
  })

  // ── T6: restart ─────────────────────────────────────────────────────────────────────────────────

  it('T6 restart: an independent process observes only durable truth for both winners and decides the same way', async () => {
    pg.requirePostgres('restart')
    const signed = await fixture()
    await submitTransactionSignature(signed.escrow.id, signed.buyer.id, buyerSigns(signed.pending.unsignedPsbtBase64))
    const unsigned = await fixture()
    const unsignedAuthority = await generation(unsigned.pending.id)
    const signedAuthority = await generation(signed.pending.id)
    expect(await deletePendingRoundIfStillUnsigned(unsigned.pending.id, unsigned.escrow.id, unsignedAuthority)).toBe('DELETED')

    const fresh = restarted!
    expect(await roundState(signed.pending.id, fresh.prisma)).toEqual({ pending: true, signatures: 1 })
    expect(await roundState(unsigned.pending.id, fresh.prisma)).toEqual({ pending: false, signatures: 0 })
    expect(await fresh.deletePendingRoundIfStillUnsigned(signed.pending.id, signed.escrow.id, signedAuthority)).toBe('SIGNED_MEANWHILE')
    expect(await fresh.deletePendingRoundIfStillUnsigned(unsigned.pending.id, unsigned.escrow.id, unsignedAuthority)).toBe('ALREADY_GONE')
    expect(await roundState(signed.pending.id, fresh.prisma)).toEqual({ pending: true, signatures: 1 })
  })

  // ── ST-1 provisional authority fail-closed regressions (NOT the D->E concurrency proof) ──

  it('ST1-A rejects deletion without a complete caller generation and preserves the pending row', async () => {
    pg.requirePostgres('missing caller provenance')
    const { escrow, pending } = await fixture()
    expect(await deletePendingRoundIfStillUnsigned(pending.id, escrow.id)).toBe('PROVENANCE_REJECTED')
    expect(await roundState(pending.id)).toEqual({ pending: true, signatures: 0 })
  })

  it('ST1-B rejects a mismatched appeal generation and preserves the pending row', async () => {
    pg.requirePostgres('mismatched generation')
    const { escrow, pending } = await fixture()
    const authority = await generation(pending.id)
    expect(await deletePendingRoundIfStillUnsigned(pending.id, escrow.id, {
      ...authority, rulingAppealRound: authority.rulingAppealRound + 1,
    })).toBe('PROVENANCE_REJECTED')
    expect(await roundState(pending.id)).toEqual({ pending: true, signatures: 0 })
  })

  it('ST1-C rejects deletion when the durable dispute generation has advanced', async () => {
    pg.requirePostgres('durable generation mismatch')
    const { escrow, pending } = await fixture()
    const authority = await generation(pending.id)
    // Fixture mutation only: this is NOT a real appeal() race or an authority proof.
    await prisma.dispute.update({ where: { id: authority.disputeId }, data: { appealRound: authority.rulingAppealRound + 1 } })
    expect(await deletePendingRoundIfStillUnsigned(pending.id, escrow.id, authority)).toBe('PROVENANCE_REJECTED')
    expect(await roundState(pending.id)).toEqual({ pending: true, signatures: 0 })
  })

  // ── T7: no economic step under the lock ────────────────────────────────────────────────────────

  it('T7 the escrow lock is released before the first post-signature gate (and so before any provider/economic step)', async () => {
    pg.requirePostgres('lock scope')
    const { escrow, pending, buyer } = await fixture('buyer') // the buyer's signature completes the round
    const authority = require('../../src/modules/open-settlement/economic-disposition-authority')
    let lockFreeAtFirstGate: boolean | undefined
    jest.spyOn(authority, 'authorizeDisputedPendingExecution').mockImplementation(async () => {
      // Probed from an independent connection: a held escrow lock would make this false.
      lockFreeAtFirstGate = await restarted!.prisma.$transaction(async (tx) =>
        (await tx.$queryRaw<Array<{ free: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtext(${escrow.id})::bigint) AS free`)[0].free)
      throw new Error('stop before the economic path (test)')
    })

    await expect(submitTransactionSignature(escrow.id, buyer.id, buyerSigns(pending.unsignedPsbtBase64))).rejects.toThrow(/stop before the economic path/)
    expect(lockFreeAtFirstGate).toBe(true)
  })
})
