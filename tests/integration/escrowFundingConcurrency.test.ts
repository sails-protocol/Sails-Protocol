// tests/integration/escrowFundingConcurrency.test.ts
//
// Missão 11 Fase 9.3 — VERIFIED REMEDIATION. Real-Postgres proof that
// withEscrowFundingLock() (escrow-lifecycle.ts) closes the reorg/
// lifecycle TOCTOU race an independently-reproduced red-team finding
// surfaced (Kimi K3 R1 MULTI-03/REORG-01/REORG-02/FAIL-04, corrected
// P0→P2 after reproduction — see SAILS-KIMI-K3-RED-TEAM-R1-CTO-TRIAGE.md).
//
// Unlike tests/escrowFundingEvidenceService.test.ts (fake repo) and
// tests/multisigFundingReorgSweep.test.ts (mocked Prisma), this uses a
// REAL Postgres connection so pg_advisory_xact_lock is enforced by the
// server itself, not simulated in JS — the same "real DB, not a mock"
// discipline tests/integration/postgresProductionReadiness.test.ts
// already established for PostgresEventStore's identical locking pattern.
//
// Deterministic race technique (mirrors postgresProductionReadiness.test.ts's
// "abort leaves no leaked lock" test): a helper transaction manually runs
// `SELECT pg_advisory_xact_lock(hashtext(escrowId)::bigint)`, holds it
// open for a short delay, writes evidence, then commits — releasing the
// lock. The real operation under test is started a tick later, so it
// deterministically blocks on the SAME advisory lock key until the
// helper's transaction commits, then re-reads evidence through its own
// now-acquired lock and sees the fresh row. This proves the actual
// database-level serialization, not a timing coincidence.
process.env.MOCK_ESCROW = 'false'
process.env.MULTISIG_SEED = process.env.MULTISIG_SEED || 'funding-concurrency-test-seed'
process.env.TRUSTED_ARBITRATORS = process.env.TRUSTED_ARBITRATORS || 'funding-concurrency-test-arbiter'
process.env.MULTISIG_EXPLORER_API_URL = process.env.MULTISIG_EXPLORER_API_URL || 'https://mempool.space/api'
process.env.MULTISIG_FUNDING_REQUIRED_CONFIRMATIONS = process.env.MULTISIG_FUNDING_REQUIRED_CONFIRMATIONS || '1'

import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { createHash } from 'crypto'
import * as bitcoin from 'bitcoinjs-lib'
import * as ecc from 'tiny-secp256k1'
import { ECPairFactory } from 'ecpair'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { registerTestParticipant, closeTestRedis, preserveTestRedis } from './identityTestHelpers'
import { MULTISIG_CAPABILITY_PROFILE_V1 } from '@satsails/p2p-schemas'

bitcoin.initEccLib(ecc)
const ECPair = ECPairFactory(ecc)
const btcTestnet = bitcoin.networks.testnet

describe('Escrow funding-evidence concurrency — real Postgres (Missão 11 Fase 9.3)', () => {
  jest.setTimeout(60_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let escrowService: import('../../src/modules/open-settlement/escrow.service').EscrowService
  let identityService: typeof import('../../src/modules/open-identity/identity.service').identityService
  let liquidityRouter: typeof import('../../src/modules/open-liquidity/liquidity.service').liquidityRouter
  let tradeService: typeof import('../../src/modules/open-p2p/trade.service').tradeService
  let intentEngine: typeof import('../../src/core/intent-engine').intentEngine
  let OpenP2PTradeIntentHandler: any
  let pendingTx: typeof import('../../src/modules/open-settlement/escrow-pending-tx')
  let escrowFundingEvidenceRepository: typeof import('../../src/modules/open-settlement/escrow-funding-evidence-repository').escrowFundingEvidenceRepository
  let sweepMultisigFundingReorgs: typeof import('../../src/modules/open-settlement/multisig-funding-reorg-sweep').sweepMultisigFundingReorgs
  let withEscrowFundingLock: typeof import('../../src/modules/open-settlement/escrow-lifecycle').withEscrowFundingLock

  const BUYER_PUBKEY = '021744d7bd3cd8e7f62e7aa8f7db8292680b745d09f8f40377c4bbbc0136d4e299'
  const SELLER_PUBKEY = '038e41e2cb09677fd4bde9f232871533925c4b628c25efdb9d572546293850ddd4'
  const RELEASE_ADDR = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'
  // A hand-typed second testnet address here previously had a bad
  // checksum/network mismatch (bitcoin.address.toOutputScript() rejected
  // it) — derived instead, same technique escrowArbiterCommitmentIntegration
  // .test.ts and multisigProvider.test.ts already use for a real, valid,
  // deterministic P2WPKH testnet address.
  const SELLER_ADDR = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(ECPair.fromPrivateKey(createHash('sha256').update('funding-concurrency-split-seller').digest(), { network: btcTestnet }).publicKey),
    network: btcTestnet,
  }).address!
  // M9.10-R: derived from the actual env var (not a second, independently
  // hardcoded literal) so this can never silently drift from whatever
  // TRUSTED_ARBITRATORS this process actually started with. Line 27's own
  // `||` default only fires when the var was empty going in — once CI
  // started setting a real ambient value (M9.10-R, ci.yml/ci-tests.yml),
  // a hardcoded literal here would keep claiming a match that no longer
  // held, producing exactly the "identity does not match the arbiter
  // public key committed... at creation time" error this now avoids.
  // Same split/trim convention config/index.ts's own trustedArbitrators
  // parsing uses.
  const ARBITER_ID = process.env.TRUSTED_ARBITRATORS!.split(',')[0].trim()
  const RUN_ID = Date.now().toString(36)

  let realFetch: typeof fetch

  function mockExplorerForUtxo(txid: string, vout: number, valueSats: number): void {
    global.fetch = jest.fn(async (url: string) => {
      if (url.includes('/blocks/tip/height')) return { ok: true, text: async () => '100' } as any
      if (url.includes(`/tx/${txid}/status`)) return { ok: true, json: async () => ({ confirmed: true, block_height: 100 }) } as any
      // multisig.provider.ts's fetchFeeRateSatsPerVByte() — used by
      // buildUnsignedRelease/Refund/Split when building a real PSBT.
      if (url.includes('/v1/fees/recommended')) return { ok: true, json: async () => ({ halfHourFee: 5 }) } as any
      return { ok: true, json: async () => [{ txid, vout, value: valueSats, status: { confirmed: true } }] } as any
    }) as any
  }

  beforeAll(async () => {
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return

    ;({ prisma } = require('../../src/common/database'))
    ;({ escrowService } = require('../../src/modules/open-settlement/escrow.service'))
    ;({ identityService } = require('../../src/modules/open-identity/identity.service'))
    ;({ liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service'))
    ;({ tradeService } = require('../../src/modules/open-p2p/trade.service'))
    ;({ intentEngine } = require('../../src/core/intent-engine'))
    ;({ OpenP2PTradeIntentHandler } = require('../../src/modules/open-p2p/intent-handler'))
    pendingTx = require('../../src/modules/open-settlement/escrow-pending-tx')
    ;({ escrowFundingEvidenceRepository } = require('../../src/modules/open-settlement/escrow-funding-evidence-repository'))
    ;({ sweepMultisigFundingReorgs } = require('../../src/modules/open-settlement/multisig-funding-reorg-sweep'))
    ;({ withEscrowFundingLock } = require('../../src/modules/open-settlement/escrow-lifecycle'))
    intentEngine.registerHandler(OpenP2PTradeIntentHandler)
  })

  afterAll(async () => {
    if (dbAvailable) {
      await prisma.$disconnect()
      await closeTestRedis()
    }
  })

  function requirePostgres(name: string): void {
    pg.requirePostgres(name)
  }

  beforeEach(() => { realFetch = global.fetch })
  afterEach(() => { global.fetch = realFetch })

  function tick(ms = 15): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  async function makeLockedMultisigEscrow(suffix: string) {
    const seller = await registerTestParticipant(identityService, 'Seller')
    const buyer = await registerTestParticipant(identityService, 'Buyer')
    const offer = await liquidityRouter.createOffer({
      userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER',
    })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    const escrow = await escrowService.createEscrow({ tradeId: trade.id, type: 'MULTISIG', lockedAmount: '0.001', asset: 'BTC' }, seller.id)
    await escrowService.submitParticipantKey(escrow.id, buyer.id, BUYER_PUBKEY, MULTISIG_CAPABILITY_PROFILE_V1)
    await escrowService.submitParticipantKey(escrow.id, seller.id, SELLER_PUBKEY, MULTISIG_CAPABILITY_PROFILE_V1)

    // createHash, not template+padEnd — a suffix containing a hyphen (several
    // in this file do, e.g. 'recovery-refund') produces an invalid hex
    // string that silently truncates when parsed by bitcoinjs-lib, which
    // only surfaces once a real PSBT is actually built (buildUnsignedSpend's
    // psbt.addInput) — a hash is always valid hex regardless of input shape.
    const txid = createHash('sha256').update(`${RUN_ID}-${suffix}`).digest('hex')
    mockExplorerForUtxo(txid, 0, 100_000)
    await escrowService.lockFunds(escrow.id, seller.id)
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id } })

    return { escrowId: escrow.id, sellerId: seller.id, buyerId: buyer.id, tradeId: trade.id, txid }
  }

  // Manually acquires the SAME per-escrow advisory lock withEscrowFundingLock()
  // uses, holds it for `holdMs`, writes a REORGED_INVALIDATED (or
  // RECONFIRMED) evidence row inside that same transaction, then commits —
  // simulating exactly what a concurrent reorg-sweep tick's own locked
  // read-then-write would do, but with deterministic, test-controlled
  // timing instead of relying on real network/scan latency.
  async function simulateEvidenceWriteUnderLock(
    escrowId: string,
    kind: 'REORGED_INVALIDATED' | 'RECONFIRMED',
    holdMs: number,
    extra: { txid?: string } = {}
  ): Promise<void> {
    await prisma.$transaction(async (tx: any) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${escrowId})::bigint)`
      await tick(holdMs)
      await tx.escrowFundingEvidence.create({
        data: { escrowId, kind, txid: extra.txid, note: 'test-simulated concurrent evidence write under lock' },
      })
    })
  }

  describe('1. sweep-vs-markPaymentSent', () => {
    it('a REORGED_INVALIDATED write racing under the escrow lock is never missed by a concurrent markPaymentSent()', async () => {
      requirePostgres('sweep-vs-markPaymentSent')
      const { escrowId, buyerId } = await makeLockedMultisigEscrow('race-mps')

      const reorgWrite = simulateEvidenceWriteUnderLock(escrowId, 'REORGED_INVALIDATED', 80)
      await tick(15) // head start so the reorg transaction acquires the lock first
      const paymentAttempt = escrowService.markPaymentSent(escrowId, buyerId)

      await reorgWrite
      // Either the cheap early fail-fast (assertFundingNotUncertain, if it
      // happens to run after the reorg write already committed on this
      // particular environment's timing) or the authoritative locked
      // re-check (if it ran first and the write raced in afterward) may be
      // the one that actually throws — real-database timing, not a
      // property this test needs to pin down (see the identical reasoning
      // in tests 2/3 below). What matters: no interleaving ever lets
      // markPaymentSent() succeed on stale funding certainty.
      await expect(paymentAttempt).rejects.toThrow(/funding evidence (is currently|became) uncertain/)

      const escrow = await prisma.escrow.findUnique({ where: { id: escrowId } })
      expect(escrow!.status).toBe('FUNDS_LOCKED') // never advanced past the stale check
    })
  })

  describe('2. sweep-vs-initiateRelease', () => {
    it('a REORGED_INVALIDATED write racing under the escrow lock is never missed by a concurrent initiateRelease()', async () => {
      requirePostgres('sweep-vs-initiateRelease')
      const { escrowId, sellerId } = await makeLockedMultisigEscrow('race-rel')
      await prisma.escrow.update({ where: { id: escrowId }, data: { status: 'PAYMENT_PENDING' } })

      const reorgWrite = simulateEvidenceWriteUnderLock(escrowId, 'REORGED_INVALIDATED', 80)
      await tick(15)
      const releaseAttempt = pendingTx.initiateRelease(escrowId, RELEASE_ADDR, sellerId)

      await reorgWrite
      // Either the cheap early fail-fast (assertFundingNotUncertain, if it
      // happens to run after the reorg write already committed) or the
      // authoritative locked re-check (if it ran first and the write raced
      // in afterward) may be the one that actually throws — which layer
      // catches it is real-database timing, not a property this test
      // needs to pin down. What matters, and what both messages equally
      // prove, is the outcome below: no pending transaction is ever
      // created while funding is uncertain.
      await expect(releaseAttempt).rejects.toThrow(/funding evidence (is currently|became) uncertain/)

      const pending = await prisma.escrowPendingTransaction.findUnique({ where: { escrowId } })
      expect(pending).toBeNull() // no pending release transaction was ever created
    })
  })

  describe('3. sweep-vs-initiateSplit', () => {
    it('a REORGED_INVALIDATED write racing under the escrow lock is never missed by a concurrent initiateSplit()', async () => {
      requirePostgres('sweep-vs-initiateSplit')
      const { escrowId, tradeId, buyerId } = await makeLockedMultisigEscrow('race-split')
      await prisma.escrow.update({ where: { id: escrowId }, data: { status: 'DISPUTED' } })
      // A real, disputed split is arbiter-triggered — assertArbiterMatchesScript()
      // requires triggeredBy to be the identity actually committed into
      // this escrow's script (ARBITER_ID, matching TRUSTED_ARBITRATORS
      // set at the top of this file), and isSellerOrAssignedArbiter()
      // requires a real Dispute row naming that same arbiter.
      await prisma.dispute.create({ data: { tradeId, escrowId, openedBy: buyerId, reason: 'test fixture', arbiterId: ARBITER_ID } })

      const reorgWrite = simulateEvidenceWriteUnderLock(escrowId, 'REORGED_INVALIDATED', 80)
      await tick(15)
      const splitAttempt = pendingTx.initiateSplit(escrowId, RELEASE_ADDR, SELLER_ADDR, 5000, ARBITER_ID)

      await reorgWrite
      // See the initiateRelease test above for why either message is
      // accepted — the outcome (no pending transaction created) is what
      // this test actually proves.
      await expect(splitAttempt).rejects.toThrow(/funding evidence (is currently|became) uncertain/)

      const pending = await prisma.escrowPendingTransaction.findUnique({ where: { escrowId } })
      expect(pending).toBeNull()
    })
  })

  describe('4. two sweep workers, SAME escrow — no duplicate/racy evidence (also closes REORG-04)', () => {
    it('two concurrent sweepMultisigFundingReorgs() runs never both write for the same escrow — the second sees the first\'s committed result and no-ops', async () => {
      requirePostgres('two workers same escrow')
      const { escrowId, txid } = await makeLockedMultisigEscrow('two-workers-same')
      // A confirmed-but-shallow candidate (depth 1 < required 2, per this
      // file's MULTISIG_FUNDING_REQUIRED_CONFIRMATIONS=2 override below) —
      // both concurrent sweep ticks should observe this identical external
      // reality and, between them, write REORGED_INVALIDATED exactly once.
      process.env.MULTISIG_FUNDING_REQUIRED_CONFIRMATIONS = '2'
      preserveTestRedis() // keep ONE Redis client across resetModules() so afterAll can close it
      jest.resetModules()
      ;({ sweepMultisigFundingReorgs } = require('../../src/modules/open-settlement/multisig-funding-reorg-sweep'))
      global.fetch = jest.fn(async (url: string) => {
        if (url.includes('/blocks/tip/height')) return { ok: true, text: async () => '100' } as any
        if (url.includes(`/tx/${txid}/status`)) return { ok: true, json: async () => ({ confirmed: true, block_height: 100 }) } as any
        return { ok: true, json: async () => [{ txid, vout: 0, value: 100_000, status: { confirmed: true } }] } as any
      }) as any

      await Promise.all([sweepMultisigFundingReorgs(), sweepMultisigFundingReorgs()])

      const evidence = await escrowFundingEvidenceRepository.listForEscrow(escrowId)
      const kinds = evidence.map((e: any) => e.kind)
      // Exactly ONE new row beyond the original OBSERVED_CONFIRMED baseline
      // — never two REORGED_INVALIDATED rows for the identical observation,
      // proving the two workers serialized rather than both reading the
      // same stale "last" row and both deciding to write.
      expect(kinds).toEqual(['OBSERVED_CONFIRMED', 'REORGED_INVALIDATED'])

      process.env.MULTISIG_FUNDING_REQUIRED_CONFIRMATIONS = '1'
      preserveTestRedis() // keep ONE Redis client across resetModules() so afterAll can close it
      jest.resetModules()
      ;({ sweepMultisigFundingReorgs } = require('../../src/modules/open-settlement/multisig-funding-reorg-sweep'))
    })
  })

  describe('5. two workers, DIFFERENT escrows — no unnecessary global serialization', () => {
    it('holding escrow A\'s lock does not block a concurrent withEscrowFundingLock() call for escrow B', async () => {
      requirePostgres('two workers different escrows')
      const { escrowId: escrowA } = await makeLockedMultisigEscrow('iso-a')
      const { escrowId: escrowB } = await makeLockedMultisigEscrow('iso-b')

      const holdA = simulateEvidenceWriteUnderLock(escrowA, 'RECONFIRMED', 300)
      await tick(15) // ensure A's lock is acquired first

      const start = Date.now()
      await withEscrowFundingLock(escrowB, async (tx: any) => {
        await tx.escrowFundingEvidence.findMany({ where: { escrowId: escrowB } })
      })
      const elapsedMs = Date.now() - start

      // If the lock were accidentally global (not keyed per-escrowId), this
      // would have waited out A's ~300ms hold; a different key must return
      // near-instantly instead.
      expect(elapsedMs).toBeLessThan(250)

      await holdA // let A's held transaction finish before the test ends
    })
  })

  describe('6. REORGED_INVALIDATED racing a lifecycle re-check — visible the instant the lock is acquired', () => {
    it('withEscrowFundingLock() re-reads see a REORGED_INVALIDATED row committed by a concurrent lock holder a moment earlier', async () => {
      requirePostgres('REORGED_INVALIDATED racing lifecycle')
      const { escrowId } = await makeLockedMultisigEscrow('reorg-visible')

      const write = simulateEvidenceWriteUnderLock(escrowId, 'REORGED_INVALIDATED', 60)
      await tick(15)

      const sawUncertain = await withEscrowFundingLock(escrowId, async (tx: any) => {
        const rows = await tx.escrowFundingEvidence.findMany({ where: { escrowId }, orderBy: { recordedAt: 'asc' } })
        return rows[rows.length - 1].kind === 'REORGED_INVALIDATED'
      })

      await write
      expect(sawUncertain).toBe(true)
    })
  })

  describe('7. RECONFIRMED-racing-recovery — refund is never permanently blocked by the new lock', () => {
    it('initiateRefund() blocks transiently on a held escrow lock, then succeeds once it releases — recovery is delayed, never denied', async () => {
      requirePostgres('RECONFIRMED racing recovery')
      const { escrowId, sellerId } = await makeLockedMultisigEscrow('recovery-refund')
      await prisma.escrow.update({ where: { id: escrowId }, data: { status: 'FUNDS_LOCKED' } })

      const holdingWrite = simulateEvidenceWriteUnderLock(escrowId, 'RECONFIRMED', 100)
      await tick(15)
      // M8-RF (Destination Consistency) — initiateRefund() now resolves
      // the seller's registered PayoutAddress when no explicit
      // destination is supplied; this test is about the funding LOCK,
      // not destination resolution, so an explicit real testnet address
      // is passed to bypass that lookup entirely (mirrors this file's
      // own real-address fixtures elsewhere).
      const refundAttempt = pendingTx.initiateRefund(escrowId, sellerId, 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')

      // initiateRefund() never runs the funding-uncertainty check (refund
      // is a recovery path — see escrow-lifecycle.ts's own comment on
      // assertFundingNotUncertain()), so once the lock frees up it must
      // succeed, never reject due to the RECONFIRMED write racing it.
      await holdingWrite
      await expect(refundAttempt).resolves.toBeTruthy()

      const pending = await prisma.escrowPendingTransaction.findUnique({ where: { escrowId } })
      expect(pending).not.toBeNull()
      expect(pending!.kind).toBe('refund')
    })
  })

  describe('8. restart safety — no lock or state survives a fresh module/connection instantiation', () => {
    it('a committed locked write is durable and readable by a totally independent PrismaClient; the lock itself never leaks past commit', async () => {
      requirePostgres('restart safety')
      const { escrowId, txid } = await makeLockedMultisigEscrow('restart')

      await withEscrowFundingLock(escrowId, async (tx: any) => {
        await tx.escrowFundingEvidence.create({ data: { escrowId, kind: 'RECONFIRMED', txid, note: 'restart-safety fixture' } })
      })

      // Simulated restart: fresh require() of the repository module reads
      // the SAME rows back from Postgres — durable, not in-process state.
      preserveTestRedis() // keep ONE Redis client across resetModules() so afterAll can close it
      jest.resetModules()
      const freshRepo = require('../../src/modules/open-settlement/escrow-funding-evidence-repository').escrowFundingEvidenceRepository
      const afterRestart = await freshRepo.listForEscrow(escrowId)
      expect(afterRestart.map((e: any) => e.kind)).toEqual(['OBSERVED_CONFIRMED', 'RECONFIRMED'])

      // No leaked lock: a totally independent PrismaClient can immediately
      // acquire the identical advisory-lock key with no hang. If the
      // previous transaction's lock had leaked (e.g. a bug that never
      // committed/rolled back), this would hang until Jest's own timeout.
      const independentClient = new PrismaClient({ adapter: new PrismaPg({ connectionString: pg.getUrl() }) })
      try {
        const start = Date.now()
        await independentClient.$transaction(async (tx: any) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${escrowId})::bigint)`
        })
        expect(Date.now() - start).toBeLessThan(2_000)
      } finally {
        await independentClient.$disconnect()
      }
    })
  })

  describe('9. duplicate-observation idempotency', () => {
    it('running the sweep twice in a row against an unchanged external observation writes no duplicate evidence the second time', async () => {
      requirePostgres('duplicate observation idempotency')
      const { escrowId, txid } = await makeLockedMultisigEscrow('idempotent')
      mockExplorerForUtxo(txid, 0, 100_000) // same, unchanged UTXO both times

      const first = await sweepMultisigFundingReorgs()
      expect(first.stillGood).toEqual([escrowId])

      const second = await sweepMultisigFundingReorgs()
      expect(second.stillGood).toEqual([escrowId])

      const evidence = await escrowFundingEvidenceRepository.listForEscrow(escrowId)
      expect(evidence.map((e: any) => e.kind)).toEqual(['OBSERVED_CONFIRMED']) // no new row from either sweep run
    })
  })
})
