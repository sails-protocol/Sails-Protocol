// tests/integration/staleDisputeCleanupSignatureRace.test.ts
//
// Issue #244 - stale dispute-pending cleanup (reconcileStalePendingDisputeTranslations()) must never delete a signing
// round that accepted a signature after cleanup's zero-signature snapshot. Real PostgreSQL.
//
// Interleavings are forced with the real escrow-scoped advisory lock (withEscrowFundingLock()'s key): the test holds
// it, queues the contenders behind it in a known order (PostgreSQL grants a lock's waiters in queue order, observed in
// pg_locks), then releases it. Cleanup runs through its public entry point, its candidate scan narrowed to the rows
// this suite created (the scan otherwise covers every MULTISIG pending row in the shared database).
import { PrismaClient } from '@prisma/client'
import { randomBytes } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'

// Issue #239 - this suite proves lock interleaving, not Bitcoin signatures: its rounds carry placeholder PSBTs, so the
// PSBT check is stubbed here (it is proven with real PSBTs in tests/integration/pendingRoundLifecycle.test.ts).
jest.mock('../../src/modules/open-settlement/multisig-round-proofs', () => ({
  ...jest.requireActual('../../src/modules/open-settlement/multisig-round-proofs'),
  verifySignerPartialSignature: (_unsigned: string, signed: string) => signed,
}))

describe('Issue #244 - stale dispute-pending cleanup vs a concurrent signature (real PostgreSQL)', () => {
  jest.setTimeout(60_000)
  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let submitTransactionSignature: typeof import('../../src/modules/open-settlement/escrow-pending-tx').submitTransactionSignature
  let reconcileStalePendingDisputeTranslations: typeof import('../../src/modules/open-settlement/dispute-pending-reconciliation').reconcileStalePendingDisputeTranslations
  let mine: string[] = []
  // A failed assertion must not leave a held lock or a queued contender running into the next test.
  let held: Array<() => Promise<void>> = []
  let inflight: Array<Promise<unknown>> = []
  const track = <T>(p: Promise<T>): Promise<T> => { inflight.push(p.catch(() => undefined)); return p }

  beforeAll(async () => {
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ submitTransactionSignature } = require('../../src/modules/open-settlement/escrow-pending-tx'))
    ;({ reconcileStalePendingDisputeTranslations } = require('../../src/modules/open-settlement/dispute-pending-reconciliation'))
  })

  beforeEach(() => {
    mine = []
    if (!dbAvailable) return
    const findMany = prisma.escrowPendingTransaction.findMany.bind(prisma.escrowPendingTransaction)
    jest.spyOn(prisma.escrowPendingTransaction, 'findMany').mockImplementation(((args: { where: object }) =>
      findMany({ ...args, where: { ...args.where, id: { in: mine } } })) as never)
  })

  afterEach(async () => {
    for (const release of held) await release().catch(() => undefined)
    await Promise.all(inflight)
    held = []
    inflight = []
    jest.restoreAllMocks()
  })

  afterAll(async () => {
    if (dbAvailable) {
      await prisma.$disconnect()
      await closeTestRedis()
    }
  })

  const newUser = () => prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })

  /** A MULTISIG escrow with a RESOLVED dispute (no durable Outcome) and a zero-signature round older than the margin. */
  async function fixture(requiredSigners: 'both' | 'buyer' = 'both') {
    const [buyer, seller, arbiter] = await Promise.all([newUser(), newUser(), newUser()])
    const offer = await prisma.offer.create({
      data: { userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '65000', minAmount: '0.001', maxAmount: '1', paymentMethod: 'PIX' },
    })
    const trade = await prisma.trade.create({
      data: { offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, asset: 'BTC', amount: '0.01', priceUsd: '65000', totalUsd: '650' },
    })
    const escrow = await prisma.escrow.create({ data: { tradeId: trade.id, type: 'MULTISIG', asset: 'BTC', lockedAmount: '0.001', status: 'DISPUTED' } })
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id } })
    const dispute = await prisma.dispute.create({
      data: { tradeId: trade.id, escrowId: escrow.id, openedBy: buyer.id, reason: '#244', arbiterId: arbiter.id, status: 'RESOLVED', ruling: 'RELEASE', resolvedAt: new Date() },
    })
    // Issue #239 - the signer's registered key is read under the escrow lock (the PSBT check itself is stubbed above).
    await prisma.escrowParticipantKey.createMany({ data: [
      { escrowId: escrow.id, role: 'buyer', participantId: buyer.id, pubkey: 'buyer-key' },
      { escrowId: escrow.id, role: 'seller', participantId: seller.id, pubkey: 'seller-key' },
    ] })
    const pending = await prisma.escrowPendingTransaction.create({
      data: {
        // A ruling's round (disputeId): the stale cleanup's own subject; a cooperative round takes no signature once DISPUTED (#239).
        disputeId: dispute.id,
        escrowId: escrow.id, kind: 'release', toAddress: 'bc1qtest', unsignedPsbtBase64: 'stub',
        requiredSigners: requiredSigners === 'both' ? [buyer.id, seller.id] : [buyer.id], triggeredBy: arbiter.id,
        createdAt: new Date(Date.now() - 10 * 60 * 1000),
      },
    })
    mine.push(pending.id)
    return { escrow, pending, buyer, seller }
  }

  const roundState = async (pendingId: string) => ({
    pending: (await prisma.escrowPendingTransaction.findUnique({ where: { id: pendingId }, select: { id: true } })) !== null,
    signatures: await prisma.escrowTransactionSignature.count({ where: { pendingTxId: pendingId } }),
  })

  const waitingOnAdvisoryLocks = async () => (await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)[0].n
  async function untilWaiting(n: number) {
    for (let i = 0; i < 500; i++) {
      if ((await waitingOnAdvisoryLocks()) === n) return
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error(`expected ${n} advisory-lock waiter(s), saw ${await waitingOnAdvisoryLocks()}`)
  }
  /** Holds the escrow's advisory lock until the returned function is called; `inside` runs while it is held. */
  async function holdEscrowLock(escrowId: string) {
    let release!: (inside?: (tx: unknown) => Promise<unknown>) => void
    const released = new Promise<((tx: unknown) => Promise<unknown>) | undefined>((r) => { release = r })
    let acquired!: () => void
    const isHeld = new Promise<void>((r) => { acquired = r })
    const done = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${escrowId})::bigint)`
      acquired()
      const inside = await released
      if (inside) await inside(tx)
    }, { timeout: 30_000 })
    await isHeld
    let once = false
    const releaseOnce = async (inside?: (tx: any) => Promise<unknown>) => { if (once) return; once = true; release(inside); await done }
    held.push(() => releaseOnce())
    return releaseOnce
  }

  it('signer first: cleanup took its zero-signature snapshot, the signature commits, cleanup re-checks under the lock and keeps the round', async () => {
    pg.requirePostgres('signer first')
    const { escrow, pending, buyer } = await fixture()
    const release = await holdEscrowLock(escrow.id)

    const signer = track(submitTransactionSignature(escrow.id, buyer.id, 'buyer-signed'))
    await untilWaiting(1) // the signer is queued first, before writing anything
    const cleaner = track(reconcileStalePendingDisputeTranslations())
    await untilWaiting(2) // cleanup read zero signatures and is queued second
    await release()

    expect(await signer).toMatchObject({ complete: false, submittedCount: 1 })
    expect(await cleaner).toEqual({ reconciled: [], skippedTooYoung: [], skippedHasSignatures: [escrow.id], failed: [] })
    expect(await roundState(pending.id)).toEqual({ pending: true, signatures: 1 })
  })

  it('cleanup first (reverse order): the round is deleted, the later signature is refused explicitly and nothing is left behind', async () => {
    pg.requirePostgres('cleanup first')
    const { escrow, pending, buyer } = await fixture()
    const release = await holdEscrowLock(escrow.id)

    const cleaner = track(reconcileStalePendingDisputeTranslations())
    await untilWaiting(1)
    const signer = track(submitTransactionSignature(escrow.id, buyer.id, 'buyer-signed')).then(() => 'accepted', (err: Error) => err.message)
    await untilWaiting(2)
    await release()

    expect((await cleaner).reconciled).toEqual([{ escrowId: escrow.id, pendingTransactionId: pending.id, verdict: 'DELETED_NO_OUTCOME' }])
    expect(await signer).toMatch(/has no pending transaction awaiting signatures/)
    expect(await roundState(pending.id)).toEqual({ pending: false, signatures: 0 })
  })

  it('round identity: a round that replaced the snapshotted one before the delete is never deleted', async () => {
    pg.requirePostgres('round identity')
    const { escrow, pending, buyer, seller } = await fixture()
    const release = await holdEscrowLock(escrow.id)

    const cleaner = track(reconcileStalePendingDisputeTranslations())
    await untilWaiting(1)
    let replacement = ''
    await release(async (tx: any) => {
      await tx.escrowPendingTransaction.delete({ where: { id: pending.id } })
      replacement = (await tx.escrowPendingTransaction.create({
        data: { escrowId: escrow.id, kind: 'refund', toAddress: 'bc1qrefund', unsignedPsbtBase64: 'stub-b', requiredSigners: [buyer.id, seller.id], triggeredBy: seller.id },
      })).id
    })

    expect(await cleaner).toEqual({ reconciled: [], skippedTooYoung: [], skippedHasSignatures: [], failed: [] })
    expect(await roundState(replacement)).toEqual({ pending: true, signatures: 0 })
  })

  it('a genuinely stale unsigned round is still deleted, on both delete paths (no Outcome; guard failed), exactly once', async () => {
    pg.requirePostgres('legitimate cleanup')
    const outsider = await fixture()
    mine.pop() // another suite's stale round: the narrowed scan must leave it alone
    const noOutcome = await fixture()
    const guardFailed = await fixture()
    const outcome = require('../../src/modules/open-settlement/dispute-outcome')
    const guard = require('../../src/modules/open-settlement/dispatch-translation-guard')
    const load = outcome.loadDisputeRulingRecord
    jest.spyOn(outcome, 'loadDisputeRulingRecord').mockImplementation(async (escrowId: unknown, round: unknown) =>
      escrowId === guardFailed.escrow.id ? { outcomeContent: { ruling: 'RELEASE' } } : load(escrowId, round))
    jest.spyOn(outcome, 'fromDisputeRulingRow').mockReturnValue({ outcome: { content: { ruling: 'RELEASE' } } })
    jest.spyOn(guard, 'validateTranslatedOutputsAgainstOutcome').mockReturnValue({ ok: false, mismatches: ['destination'] })

    const first = await reconcileStalePendingDisputeTranslations()
    expect(first.reconciled.map((r) => [r.escrowId, r.verdict]).sort()).toEqual([
      [noOutcome.escrow.id, 'DELETED_NO_OUTCOME'], [guardFailed.escrow.id, 'DELETED_GUARD_FAILED']].sort())
    expect(first.failed).toEqual([])
    expect(await reconcileStalePendingDisputeTranslations()).toEqual({ reconciled: [], skippedTooYoung: [], skippedHasSignatures: [], failed: [] })
    expect(await roundState(noOutcome.pending.id)).toEqual({ pending: false, signatures: 0 })
    expect(await roundState(guardFailed.pending.id)).toEqual({ pending: false, signatures: 0 })
    expect(await roundState(outsider.pending.id)).toEqual({ pending: true, signatures: 0 })
    await prisma.escrowPendingTransaction.delete({ where: { id: outsider.pending.id } })
  })

  it('two cleanups racing on the same round: one delete, the other reports nothing and fails nothing', async () => {
    pg.requirePostgres('concurrent cleanup')
    const { escrow, pending } = await fixture()
    const release = await holdEscrowLock(escrow.id)

    const a = track(reconcileStalePendingDisputeTranslations())
    const b = track(reconcileStalePendingDisputeTranslations())
    await untilWaiting(2) // both read the same zero-signature snapshot
    await release()

    const reports = await Promise.all([a, b])
    expect(reports.flatMap((r) => r.reconciled)).toEqual([{ escrowId: escrow.id, pendingTransactionId: pending.id, verdict: 'DELETED_NO_OUTCOME' }])
    expect(reports.flatMap((r) => [...r.failed, ...r.skippedHasSignatures])).toEqual([])
    expect(await roundState(pending.id)).toEqual({ pending: false, signatures: 0 })
  })

  it('restart: a cleanup that dies after its delete and before commit leaves the round intact, signable, and the next run decides from durable state', async () => {
    pg.requirePostgres('restart')
    const { escrow, pending, buyer } = await fixture()
    const lifecycle = require('../../src/modules/open-settlement/escrow-lifecycle')
    const realLock = lifecycle.withEscrowFundingLock
    jest.spyOn(lifecycle, 'withEscrowFundingLock').mockImplementationOnce(((id: string, fn: (tx: unknown) => Promise<unknown>) =>
      realLock(id, async (tx: unknown) => { await fn(tx); throw new Error('process died before commit') })) as never)

    expect((await reconcileStalePendingDisputeTranslations()).failed).toEqual([{ escrowId: escrow.id, error: 'process died before commit' }])
    expect(await roundState(pending.id)).toEqual({ pending: true, signatures: 0 }) // the delete rolled back with it

    await submitTransactionSignature(escrow.id, buyer.id, 'buyer-signed')
    expect(await reconcileStalePendingDisputeTranslations()).toEqual({ reconciled: [], skippedTooYoung: [], skippedHasSignatures: [escrow.id], failed: [] })
    expect(await roundState(pending.id)).toEqual({ pending: true, signatures: 1 })
  })

  it('the signer holds the escrow lock only to write its signature: it is free again before the first economic gate', async () => {
    pg.requirePostgres('lock scope')
    const { escrow, buyer } = await fixture('buyer') // the buyer's signature completes the round
    const authority = require('../../src/modules/open-settlement/economic-disposition-authority')
    let lockFree: boolean | undefined
    jest.spyOn(authority, 'authorizeDisputedPendingExecution').mockImplementation(async () => {
      lockFree = await prisma.$transaction(async (tx) =>
        (await tx.$queryRaw<Array<{ free: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtext(${escrow.id})::bigint) AS free`)[0].free)
      throw new Error('stop before the economic path (test)')
    })

    await expect(submitTransactionSignature(escrow.id, buyer.id, 'buyer-signed')).rejects.toThrow(/stop before the economic path/)
    expect(lockFree).toBe(true)
  })

  // Issue #343 (AUX-B3, PR A) - declared-fee parity with the live guard, with the REAL guard on a REAL PSBT (every test above stubs the
  // guard or has no Outcome). Only the ruling record is supplied (the same two spies the guard-failed test above uses); the guard runs.
  describe('declared miner fee parity (real guard, real PSBT)', () => {
    const IMPLIED_FEE = 500 // input 100_500, one faithful output of 100_000

    /** Gives a fixture's round a real PSBT and a stored declared fee, and serves the real Outcome for its escrow. */
    function realRound(f: { escrow: { id: string }; pending: { id: string } }, declaredFee: number | null) {
      const bitcoin = require('bitcoinjs-lib')
      const { config } = require('../../src/config')
      const network = require('../../src/modules/open-settlement/multisig.provider').networkFor(config.multisig.network)
      const address = bitcoin.payments.p2wpkh({ pubkey: Buffer.from('021744d7bd3cd8e7f62e7aa8f7db8292680b745d09f8f40377c4bbbc0136d4e299', 'hex'), network }).address
      const psbt = new bitcoin.Psbt({ network })
      psbt.addInput({ hash: 'a'.repeat(64), index: 0, witnessUtxo: { script: bitcoin.address.toOutputScript(address, network), value: BigInt(100_500) } })
      psbt.addOutput({ address, value: BigInt(100_000) })
      const { buildRulingOutcomeContent } = require('../../src/modules/open-settlement/dispute-outcome')
      const { buildArbitrationOutcome, buildOutcomeDestinationBinding } = require('../../src/modules/open-settlement/economic-outcome')
      const outcome = buildArbitrationOutcome(
        buildRulingOutcomeContent('RELEASE', '100000', 'BTC', 'buyer-1', 'seller-1', null),
        buildOutcomeDestinationBinding([{ beneficiary: 'buyer-1', destination: address }]),
      )
      return { outcome, ready: prisma.escrowPendingTransaction.update({ where: { id: f.pending.id }, data: { unsignedPsbtBase64: psbt.toBase64(), minerFeeSats: declaredFee } }) }
    }
    function serveOutcome(escrowIds: string[], outcome: unknown) {
      const outcomeModule = require('../../src/modules/open-settlement/dispute-outcome')
      const load = outcomeModule.loadDisputeRulingRecord
      jest.spyOn(outcomeModule, 'loadDisputeRulingRecord').mockImplementation(async (escrowId: unknown, round: unknown) =>
        escrowIds.includes(escrowId as string) ? { outcomeContent: { ruling: 'RELEASE' } } : load(escrowId, round))
      jest.spyOn(outcomeModule, 'fromDisputeRulingRow').mockReturnValue({ outcome })
    }

    it('only a declared fee that disagrees with the PSBT is deleted; a matching and a null fee are left alone; a second run changes nothing', async () => {
      pg.requirePostgres('fee parity')
      const mismatch = await fixture()
      const matching = await fixture()
      const legacy = await fixture()
      const a = realRound(mismatch, IMPLIED_FEE - 100)
      await Promise.all([a.ready, realRound(matching, IMPLIED_FEE).ready, realRound(legacy, null).ready])
      serveOutcome([mismatch.escrow.id, matching.escrow.id, legacy.escrow.id], a.outcome)

      const first = await reconcileStalePendingDisputeTranslations()
      expect(first.failed).toEqual([])
      expect(first.reconciled.map((r) => [r.escrowId, r.verdict]).sort()).toEqual([
        [mismatch.escrow.id, 'DELETED_GUARD_FAILED'], [matching.escrow.id, 'LEFT_GUARD_PASSED'], [legacy.escrow.id, 'LEFT_GUARD_PASSED']].sort())
      expect(await roundState(mismatch.pending.id)).toEqual({ pending: false, signatures: 0 })
      expect(await roundState(matching.pending.id)).toEqual({ pending: true, signatures: 0 })
      expect(await roundState(legacy.pending.id)).toEqual({ pending: true, signatures: 0 })

      const second = await reconcileStalePendingDisputeTranslations()
      expect(second.reconciled.map((r) => [r.escrowId, r.verdict]).sort()).toEqual([[matching.escrow.id, 'LEFT_GUARD_PASSED'], [legacy.escrow.id, 'LEFT_GUARD_PASSED']].sort())
      await prisma.escrowPendingTransaction.deleteMany({ where: { id: { in: [matching.pending.id, legacy.pending.id] } } })
    })

    it('signer first: the signature commits before the fee-mismatch delete, and the round keeps it', async () => {
      pg.requirePostgres('fee parity, signer first')
      const f = await fixture()
      const r = realRound(f, IMPLIED_FEE - 100)
      await r.ready
      serveOutcome([f.escrow.id], r.outcome)
      const release = await holdEscrowLock(f.escrow.id)

      const signer = track(submitTransactionSignature(f.escrow.id, f.buyer.id, 'buyer-signed'))
      await untilWaiting(1) // the signer is queued first, before writing anything
      const cleaner = track(reconcileStalePendingDisputeTranslations())
      await untilWaiting(2) // cleanup read zero signatures, the real guard rejected the declared fee, and its delete is queued second
      await release()

      expect(await signer).toMatchObject({ complete: false, submittedCount: 1 })
      expect(await cleaner).toEqual({ reconciled: [], skippedTooYoung: [], skippedHasSignatures: [f.escrow.id], failed: [] })
      expect(await roundState(f.pending.id)).toEqual({ pending: true, signatures: 1 })
    })
  })
})
