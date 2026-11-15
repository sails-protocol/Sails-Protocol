// tests/integration/feeCollectionRecognitionIntegration.test.ts
//
// Missão 11 Fase 5 — real-Postgres proof of the full collection-recognition
// lifecycle (A, E, F) and the new §9 reconciliation detection functions,
// against a real database with the real DB-native VALID_COLLECTION_TRANSITIONS
// guard in play (not a fake repository). Complements:
//   - tests/feeCollectionRecognitionService.test.ts (unit-level state machine)
//   - tests/multisigFeeConfirmationJob.test.ts (unit-level chain re-verification)
//   - tests/multisigFeeOutputIdentification.test.ts (unit-level deterministic
//     output identification)
//
// Missão 11 Fase 5.3 §B — this file used to fall back to a stale,
// hardcoded ":5433" connection string whenever `DATABASE_URL` wasn't
// already present in `process.env` at module-evaluation time. Confirmed
// reproducible in isolation (`npx jest --runInBand
// tests/integration/feeCollectionRecognitionIntegration.test.ts` alone):
// all 12 assertions below silently early-returned while Jest still
// reported "12 passed" — a genuine false green, even though the real
// local Postgres (.env's own DATABASE_URL, port 5432) was reachable the
// entire time. Fixed the same way feePolicyImmutability.test.ts was: (1)
// connection string now comes from `config.database.url` (dotenv-resolved,
// canonical — the same source Fase 5.2's own
// escrowArbiterCommitmentIntegration.test.ts already established), never
// a second guessed fallback; (2) unreachable Postgres now FAILS the test
// loudly (requirePostgres() throws) instead of silently returning.

import { PrismaClient, Prisma } from '@prisma/client'
import { createPostgresIntegrationHarness } from './postgresTestHarness'

const COLLECTIBLE_ADDRESS = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'

describe('Fee collection recognition — real lifecycle + reconciliation (Missão 11 Fase 5, real Postgres)', () => {
  jest.setTimeout(60_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let feeCollectionRecognitionService: typeof import('../../src/modules/open-settlement/fee-collection-recognition.service').feeCollectionRecognitionService
  let getProtocolRevenueSummary: typeof import('../../src/modules/open-settlement/fee-revenue-reporting').getProtocolRevenueSummary
  let reconciliation: typeof import('../../src/modules/open-settlement/fee-obligation-reconciliation')
  let checkRailActivationReadiness: typeof import('../../src/modules/open-settlement/fee-activation-readiness').checkRailActivationReadiness
  let config: typeof import('../../src/config').config
  let originalCollectionAddress: string | undefined
  let originalProtocolFeeRate: number

  beforeAll(async () => {
    await pg.probe()
    dbAvailable = pg.isAvailable()
    ;({ config } = require('../../src/config'))
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ feeCollectionRecognitionService } = require('../../src/modules/open-settlement/fee-collection-recognition.service'))
    ;({ getProtocolRevenueSummary } = require('../../src/modules/open-settlement/fee-revenue-reporting'))
    reconciliation = require('../../src/modules/open-settlement/fee-obligation-reconciliation')
    ;({ checkRailActivationReadiness } = require('../../src/modules/open-settlement/fee-activation-readiness'))
    originalCollectionAddress = config.settlement.protocolFeeCollectionAddress
    originalProtocolFeeRate = config.settlement.protocolFeeRate
  })

  afterEach(() => {
    if (dbAvailable) {
      config.settlement.protocolFeeCollectionAddress = originalCollectionAddress
      config.settlement.protocolFeeRate = originalProtocolFeeRate
    }
  })

  afterAll(async () => {
    if (dbAvailable) await prisma.$disconnect()
  })

  // Missão 11 Fase 6.3B.1 — delegates to the centralized harness
  // (tests/integration/postgresTestHarness.ts).
  function requirePostgres(name: string): void {
    pg.requirePostgres(name)
  }

  async function createFixtureEscrowWithObligation(suffix: string, opts: { withPolicy?: boolean } = { withPolicy: true }) {
    const buyer = await prisma.user.create({ data: { publicKey: `pk-buyer-fase5-${suffix}` } })
    const seller = await prisma.user.create({ data: { publicKey: `pk-seller-fase5-${suffix}` } })
    const offer = await prisma.offer.create({ data: { userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '65000', minAmount: '0.001', maxAmount: '1', paymentMethod: 'PIX' } })
    const trade = await prisma.trade.create({ data: { offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, asset: 'BTC', amount: '0.001', priceUsd: '65000', totalUsd: '65' } })

    let policy: any = null
    let escrow: any
    if (opts.withPolicy) {
      policy = await prisma.feePolicyVersion.create({
        data: {
          // Missão 11 Fase 7.2 — fee_policy_versions_single_published_per_rail_key
          // (migration 20260823182951) allows at most one PUBLISHED row per
          // railScope. Unique per call — this is a separate field from
          // Escrow.type ('MULTISIG' below, a real enum value this rail
          // genuinely uses), and no lookup in this file resolves a
          // FeePolicyVersion BY railScope (checkRailActivationReadiness()
          // further down takes the literal 'MULTISIG' directly, unrelated
          // to this policy row) — confirmed by direct read before this fix.
          label: `fase5-${suffix}`, railScope: `MULTISIG-${suffix}`, status: 'PUBLISHED', publishedAt: new Date(),
          protocolFeeRate: '0.004', payerModel: 'SELLER_PAYS', economicBasis: 'SELLER_DELIVERED_VALUE',
          nodeOperatorPct: '30', treasuryPct: '25', walletRebatePct: '35', arbitratorReservePct: '10',
          requiredConfirmations: 2, createdBy: 'fase5-integration-test',
        },
      })
      escrow = await prisma.escrow.create({
        data: {
          tradeId: trade.id, type: 'MULTISIG', asset: 'BTC', lockedAmount: '0.001', status: 'PAYMENT_PENDING',
          feePolicyVersionId: policy.id, snapshotProtocolFeeRate: '0.004', snapshotPayerModel: 'SELLER_PAYS', snapshotEconomicBasis: 'SELLER_DELIVERED_VALUE',
          snapshotFeeCollectionAddress: COLLECTIBLE_ADDRESS, snapshotFeeCollectionWaivedPreFunding: false,
        },
      })
    } else {
      escrow = await prisma.escrow.create({ data: { tradeId: trade.id, type: 'MULTISIG', asset: 'BTC', lockedAmount: '0.001', status: 'PAYMENT_PENDING' } })
    }

    const obligation = policy
      ? await prisma.feeObligation.create({
          data: { escrowId: escrow.id, feePolicyVersionId: policy.id, economicDetermination: 'OWED', collectionStatus: 'PENDING_COLLECTION', basisAmount: '0.001', computedFee: '0.000004', asset: 'BTC' },
        })
      : null

    return { escrow, trade, policy, obligation }
  }

  // Test A (§15): broadcast -> IN_PROGRESS, real evidence, real DB trigger.
  it('Test A: recordBroadcastAndAdvance() persists real evidence and transitions PENDING_COLLECTION -> IN_PROGRESS', async () => {
    requirePostgres('Test A')
    const { obligation } = await createFixtureEscrowWithObligation(`a-${Date.now()}`)

    await feeCollectionRecognitionService.recordBroadcastAndAdvance(obligation!.id, { txid: 'a'.repeat(64), vout: 1, scriptPubKey: 'deadbeef', amountSats: 4000 })

    const updated = await prisma.feeObligation.findUniqueOrThrow({ where: { id: obligation!.id } })
    expect(updated.collectionStatus).toBe('IN_PROGRESS')
    const evidence = await prisma.feeCollectionEvidence.findMany({ where: { feeObligationId: obligation!.id } })
    expect(evidence).toHaveLength(1)
    expect(evidence[0].kind).toBe('BROADCAST')
    expect(evidence[0].txid).toBe('a'.repeat(64))
  })

  // Test E/F (§14/§15): revenue summary proof. Uses DELTAS against a
  // baseline taken immediately before this test's own action, never
  // absolute totals — this shared dev database accumulates real fixture
  // rows from every other test/session in this mission's history, so an
  // absolute assertion would be fragile against pre-existing noise; the
  // INVARIANT this test actually proves (no double-counting across the
  // COLLECTED -> DISTRIBUTED move) is exactly as real either way.
  it('Test E/F: COLLECTED counts as gross revenue exactly once; moving to DISTRIBUTED does not double-count', async () => {
    requirePostgres('Test E/F')
    const baseline = await getProtocolRevenueSummary('BTC')
    const { obligation } = await createFixtureEscrowWithObligation(`ef-${Date.now()}`)
    await feeCollectionRecognitionService.recordBroadcastAndAdvance(obligation!.id, { txid: 'b'.repeat(64), vout: 0, scriptPubKey: 'cafe', amountSats: 4000 })
    await feeCollectionRecognitionService.recognizeConfirmation(obligation!.id, 'b'.repeat(64), 800_000)

    const afterCollected = await getProtocolRevenueSummary('BTC')
    const grossDelta = afterCollected.grossCollected.minus(baseline.grossCollected)
    expect(grossDelta.toString()).toBe('0.000004') // this obligation's own computedFee, and only this much
    const collectedDelta = afterCollected.undistributedCollected.minus(baseline.undistributedCollected)
    expect(collectedDelta.toString()).toBe('0.000004')

    // Simulate distribution (bucket-distribution mechanics are out of this
    // phase's scope — directly moving collectionStatus is enough to prove
    // the reporting invariant).
    await prisma.feeObligation.update({ where: { id: obligation!.id }, data: { collectionStatus: 'DISTRIBUTED' } })

    const afterDistributed = await getProtocolRevenueSummary('BTC')
    const grossDeltaAfterDistribution = afterDistributed.grossCollected.minus(baseline.grossCollected)
    expect(grossDeltaAfterDistribution.toString()).toBe(grossDelta.toString()) // same total, never additive on top
    const distributedDelta = afterDistributed.alreadyDistributed.minus(baseline.alreadyDistributed)
    expect(distributedDelta.toString()).toBe('0.000004')
    const collectedDeltaAfterDistribution = afterDistributed.undistributedCollected.minus(baseline.undistributedCollected)
    expect(collectedDeltaAfterDistribution.toString()).toBe('0') // moved OUT of undistributedCollected, not left behind
  })

  // Test K (§15): WAIVED obligation with evidence is a real, detectable anomaly.
  it('Test K: findWaivedOrBypassedWithEvidence() detects a WAIVED obligation carrying evidence it should never have', async () => {
    requirePostgres('Test K')
    const { obligation } = await createFixtureEscrowWithObligation(`k-${Date.now()}`)
    await prisma.feeObligation.update({ where: { id: obligation!.id }, data: { collectionStatus: 'WAIVED' } })
    // Directly inserting evidence here simulates the anomaly this function
    // exists to catch — the real code path never does this (escrow-pending-tx.ts's
    // own guard only calls recordBroadcastAndAdvance for a non-waived outcome).
    await prisma.feeCollectionEvidence.create({ data: { feeObligationId: obligation!.id, kind: 'BROADCAST', txid: 'c'.repeat(64) } })

    const found = await reconciliation.findWaivedOrBypassedWithEvidence()
    expect(found.some((r: any) => r.feeObligationId === obligation!.id)).toBe(true)
  })

  it('a clean WAIVED obligation with no evidence is never flagged', async () => {
    requirePostgres('clean WAIVED')
    const { obligation } = await createFixtureEscrowWithObligation(`k-clean-${Date.now()}`)
    await prisma.feeObligation.update({ where: { id: obligation!.id }, data: { collectionStatus: 'WAIVED' } })

    const found = await reconciliation.findWaivedOrBypassedWithEvidence()
    expect(found.some((r: any) => r.feeObligationId === obligation!.id)).toBe(false)
  })

  it('findSettlementTxidMismatches() detects when the escrow\'s own txReleaseId disagrees with recorded evidence', async () => {
    requirePostgres('txid mismatch')
    const { escrow, obligation } = await createFixtureEscrowWithObligation(`txid-${Date.now()}`)
    await prisma.escrow.update({ where: { id: escrow.id }, data: { txReleaseId: 'd'.repeat(64) } })
    await feeCollectionRecognitionService.recordBroadcastAndAdvance(obligation!.id, { txid: 'e'.repeat(64), vout: 0, scriptPubKey: 'beef', amountSats: 4000 }) // deliberately different txid

    const found = await reconciliation.findSettlementTxidMismatches()
    const row = found.find((r: any) => r.feeObligationId === obligation!.id)
    expect(row).toBeDefined()
    expect(row!.escrowTxReleaseId).toBe('d'.repeat(64))
    expect(row!.evidenceTxid).toBe('e'.repeat(64))
  })

  it('findDuplicateBroadcastEvidence() detects two BROADCAST rows sharing the identical txid', async () => {
    requirePostgres('duplicate evidence')
    const { obligation } = await createFixtureEscrowWithObligation(`dup-${Date.now()}`)
    await prisma.feeCollectionEvidence.create({ data: { feeObligationId: obligation!.id, kind: 'BROADCAST', txid: 'f'.repeat(64) } })
    await prisma.feeCollectionEvidence.create({ data: { feeObligationId: obligation!.id, kind: 'BROADCAST', txid: 'f'.repeat(64) } })

    const found = await reconciliation.findDuplicateBroadcastEvidence()
    const row = found.find((r: any) => r.feeObligationId === obligation!.id)
    expect(row).toBeDefined()
    expect(row!.count).toBe(2)
  })

  it('findWrongCollectionDestinationEvidence() detects evidence paying a script other than the escrow\'s frozen destination', async () => {
    requirePostgres('wrong destination')
    const { obligation } = await createFixtureEscrowWithObligation(`dest-${Date.now()}`)
    await feeCollectionRecognitionService.recordBroadcastAndAdvance(obligation!.id, { txid: 'g'.repeat(64), vout: 0, scriptPubKey: 'not-the-frozen-script', amountSats: 4000 })

    const found = await reconciliation.findWrongCollectionDestinationEvidence()
    expect(found.some((r: any) => r.feeObligationId === obligation!.id)).toBe(true)
  })

  it('findUnresolvedChainEvents() detects an IN_PROGRESS obligation whose last evidence is DROPPED', async () => {
    requirePostgres('dropped')
    const { obligation } = await createFixtureEscrowWithObligation(`dropped-${Date.now()}`)
    await feeCollectionRecognitionService.recordBroadcastAndAdvance(obligation!.id, { txid: 'h'.repeat(64), vout: 0, scriptPubKey: 'deadbeef', amountSats: 4000 })
    await feeCollectionRecognitionService.recordDropped(obligation!.id, 'h'.repeat(64))

    const found = await reconciliation.findUnresolvedChainEvents()
    const row = found.find((r: any) => r.feeObligationId === obligation!.id)
    expect(row).toBeDefined()
    expect(row!.lastEvidenceKind).toBe('DROPPED')
  })

  it('findUnresolvedChainEvents() detects a DISTRIBUTED obligation whose reorg could not be auto-reverted', async () => {
    requirePostgres('reorg after distributed')
    const { obligation } = await createFixtureEscrowWithObligation(`reorg-${Date.now()}`)
    await feeCollectionRecognitionService.recordBroadcastAndAdvance(obligation!.id, { txid: 'i'.repeat(64), vout: 0, scriptPubKey: 'deadbeef', amountSats: 4000 })
    await feeCollectionRecognitionService.recognizeConfirmation(obligation!.id, 'i'.repeat(64), 800_000)
    await prisma.feeObligation.update({ where: { id: obligation!.id }, data: { collectionStatus: 'DISTRIBUTED' } })
    const result = await feeCollectionRecognitionService.recordReorgAndRevert(obligation!.id, 'i'.repeat(64))
    expect(result.reverted).toBe(false)

    const found = await reconciliation.findUnresolvedChainEvents()
    const row = found.find((r: any) => r.feeObligationId === obligation!.id)
    expect(row).toBeDefined()
    expect(row!.lastEvidenceKind).toBe('REORGED_OUT')
  })

  // §13 activation readiness
  it('checkRailActivationReadiness("MULTISIG") reports concrete blockers when misconfigured', async () => {
    requirePostgres('readiness blocked')
    config.settlement.protocolFeeCollectionAddress = undefined

    const readiness = await checkRailActivationReadiness('MULTISIG')
    expect(readiness.ready).toBe(false)
    expect(readiness.blockers.some((b: string) => b.includes('SAILS_PROTOCOL_FEE_COLLECTION_ADDRESS'))).toBe(true)
  })

  it('checkRailActivationReadiness("MULTISIG") is unblocked on config once misconfiguration is fixed (DB triggers/keys permitting)', async () => {
    requirePostgres('readiness ready')
    config.settlement.protocolFeeCollectionAddress = COLLECTIBLE_ADDRESS

    const readiness = await checkRailActivationReadiness('MULTISIG')
    // Never asserts unconditional readiness (MULTISIG_SEED/TRUSTED_ARBITRATORS
    // depend on this environment's own .env, not this test) — only that the
    // one blocker this test controls is gone.
    expect(readiness.blockers.some((b: string) => b.includes('SAILS_PROTOCOL_FEE_COLLECTION_ADDRESS'))).toBe(false)
  })

  it('checkRailActivationReadiness("LIGHTNING_HODL") reports the single, definitive rail-capability blocker', async () => {
    requirePostgres('readiness LIGHTNING_HODL')
    const readiness = await checkRailActivationReadiness('LIGHTNING_HODL')
    expect(readiness.ready).toBe(false)
    expect(readiness.blockers).toHaveLength(1)
    expect(readiness.blockers[0]).toMatch(/No real, atomic Protocol Fee collection implementation exists for rail 'LIGHTNING_HODL'/)
  })

  // ─── CTO 239 — deterministic "latest evidence" ────────────────────────
  // recordedAt is timestamp(3); two rows of one obligation can share a millisecond (CI run 43748566359 picked
  // BROADCAST over DROPPED on such a tie). Every reader orders by (recordedAt, seq). Each case below writes two
  // rows with an IDENTICAL recordedAt and asserts the row with the higher seq wins, twice: once inserted in seq
  // order and once physically reversed (higher seq inserted first), so the answer cannot come from physical order.
  describe('CTO 239 — latest evidence is deterministic on recordedAt ties', () => {
    type EvidenceData = Omit<Prisma.FeeCollectionEvidenceUncheckedCreateInput, 'feeObligationId' | 'recordedAt' | 'seq'>
    const TXID_A = 'a'.repeat(64)
    const TXID_B = 'b'.repeat(64)
    let distributionReconciliation: typeof import('../../src/modules/open-settlement/distribution-reconciliation')
    let entitlementAllocationService: typeof import('../../src/modules/open-settlement/entitlement-allocation.service').entitlementAllocationService
    let escrowRepository: typeof import('../../src/modules/open-settlement/escrow-repository').escrowRepository
    let feeCollectionEvidenceRepository: typeof import('../../src/modules/open-settlement/fee-collection-evidence-repository').feeCollectionEvidenceRepository
    let livePolicyId: string

    beforeAll(async () => {
      if (!dbAvailable) return
      distributionReconciliation = require('../../src/modules/open-settlement/distribution-reconciliation')
      ;({ entitlementAllocationService } = require('../../src/modules/open-settlement/entitlement-allocation.service'))
      ;({ escrowRepository } = require('../../src/modules/open-settlement/escrow-repository'))
      ;({ feeCollectionEvidenceRepository } = require('../../src/modules/open-settlement/fee-collection-evidence-repository'))
      const { distributionPolicyService } = require('../../src/modules/open-settlement/distribution-policy.service')
      const { distributionRecipientRepository } = require('../../src/modules/open-settlement/distribution-recipient-repository')
      // findCollectedNotYetAllocated() returns nothing without a PUBLISHED policy; allocate() needs a real one.
      const live = await distributionPolicyService.findLivePolicy()
      if (live) {
        livePolicyId = live.id
      } else {
        const recipient = await distributionRecipientRepository.create({ class: `FIXTURE_CTO239_${Date.now()}`, label: 'cto239' })
        const draft = await distributionPolicyService.createDraft({ label: `cto239-${Date.now()}`, createdBy: 'cto239-integration-test' })
        await distributionPolicyService.addRecipient(draft.id, recipient.id, '100')
        livePolicyId = (await distributionPolicyService.publish(draft.id)).id
      }
    })

    async function nextSeqs(): Promise<[number, number]> {
      const rows = await prisma.$queryRawUnsafe<Array<{ v: number }>>(
        `SELECT nextval(pg_get_serial_sequence('fee_collection_evidence', 'seq'))::int AS v FROM generate_series(1, 2)`,
      )
      const [lo, hi] = rows.map((r) => r.v).sort((x, y) => x - y)
      return [lo, hi]
    }

    // Two rows sharing one recordedAt; `later` gets the higher seq. physicallyReversed inserts `later` first.
    async function tiedPair(feeObligationId: string, earlier: EvidenceData, later: EvidenceData, physicallyReversed: boolean) {
      const recordedAt = new Date(Date.now() + 86_400_000)
      const [lo, hi] = await nextSeqs()
      const write = (data: EvidenceData, seq: number) => prisma.feeCollectionEvidence.create({ data: { ...data, feeObligationId, recordedAt, seq } })
      if (physicallyReversed) {
        const l = await write(later, hi)
        return { earlier: await write(earlier, lo), later: l }
      }
      const e = await write(earlier, lo)
      return { earlier: e, later: await write(later, hi) }
    }

    async function obligationIn(status: 'IN_PROGRESS' | 'COLLECTED', suffix: string) {
      const fixture = await createFixtureEscrowWithObligation(`cto239-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
      const obligationId: string = fixture.obligation!.id
      await prisma.feeObligation.update({ where: { id: obligationId }, data: { collectionStatus: 'IN_PROGRESS' } })
      if (status === 'COLLECTED') await prisma.feeObligation.update({ where: { id: obligationId }, data: { collectionStatus: 'COLLECTED' } })
      return { ...fixture, obligationId }
    }

    function frozenScriptHex(): string {
      const bitcoin = require('bitcoinjs-lib')
      const { networkFor } = require('../../src/modules/open-settlement/multisig.provider')
      return Buffer.from(bitcoin.address.toOutputScript(COLLECTIBLE_ADDRESS, networkFor(config.multisig.network))).toString('hex')
    }

    describe.each([['inserted in seq order', false], ['physically reversed', true]])('%s', (_label, reversed) => {
      it('findUnresolvedChainEvents(): BROADCAST then DROPPED in the same millisecond flags DROPPED; the reverse does not', async () => {
        requirePostgres('cto239 unresolved')
        const dropped = await obligationIn('IN_PROGRESS', 'drop')
        await tiedPair(dropped.obligationId, { kind: 'BROADCAST', txid: TXID_A }, { kind: 'DROPPED', txid: TXID_A }, reversed)
        const notDropped = await obligationIn('IN_PROGRESS', 'nodrop')
        await tiedPair(notDropped.obligationId, { kind: 'DROPPED', txid: TXID_A }, { kind: 'BROADCAST', txid: TXID_B }, reversed)

        const found = await reconciliation.findUnresolvedChainEvents()
        expect(found.find((r) => r.feeObligationId === dropped.obligationId)?.lastEvidenceKind).toBe('DROPPED')
        expect(found.some((r) => r.feeObligationId === notDropped.obligationId)).toBe(false)
      })

      it('findCollectionEvidenceMismatches(): the latest CONFIRMED amount on a tie is the one compared', async () => {
        requirePostgres('cto239 confirmed amount')
        const ok = await obligationIn('COLLECTED', 'amt-ok')
        await tiedPair(ok.obligationId, { kind: 'CONFIRMED', txid: TXID_A, amount: '0.00000999' }, { kind: 'CONFIRMED', txid: TXID_A, amount: '0.000004' }, reversed)
        const bad = await obligationIn('COLLECTED', 'amt-bad')
        await tiedPair(bad.obligationId, { kind: 'CONFIRMED', txid: TXID_A, amount: '0.000004' }, { kind: 'CONFIRMED', txid: TXID_A, amount: '0.00000999' }, reversed)

        const found = await reconciliation.findCollectionEvidenceMismatches()
        expect(found.some((r) => r.feeObligationId === ok.obligationId)).toBe(false)
        expect(found.find((r) => r.feeObligationId === bad.obligationId)?.confirmedEvidenceAmount).toBe('0.00000999')
      })

      it('findSettlementTxidMismatches(): the latest BROADCAST txid on a tie is the one compared', async () => {
        requirePostgres('cto239 settlement txid')
        const ok = await obligationIn('IN_PROGRESS', 'txid-ok')
        await prisma.escrow.update({ where: { id: ok.escrow.id }, data: { txReleaseId: TXID_A } })
        await tiedPair(ok.obligationId, { kind: 'BROADCAST', txid: TXID_B }, { kind: 'BROADCAST', txid: TXID_A }, reversed)
        const bad = await obligationIn('IN_PROGRESS', 'txid-bad')
        await prisma.escrow.update({ where: { id: bad.escrow.id }, data: { txReleaseId: TXID_A } })
        await tiedPair(bad.obligationId, { kind: 'BROADCAST', txid: TXID_A }, { kind: 'BROADCAST', txid: TXID_B }, reversed)

        const found = await reconciliation.findSettlementTxidMismatches()
        expect(found.some((r) => r.feeObligationId === ok.obligationId)).toBe(false)
        expect(found.find((r) => r.feeObligationId === bad.obligationId)?.evidenceTxid).toBe(TXID_B)
      })

      it('findWrongCollectionDestinationEvidence(): the latest BROADCAST/CONFIRMED script on a tie is the one compared', async () => {
        requirePostgres('cto239 destination')
        const frozen = frozenScriptHex()
        const ok = await obligationIn('COLLECTED', 'dest-ok')
        await tiedPair(ok.obligationId, { kind: 'BROADCAST', txid: TXID_A, scriptPubKey: 'not-the-frozen-script' }, { kind: 'CONFIRMED', txid: TXID_A, scriptPubKey: frozen }, reversed)
        const bad = await obligationIn('COLLECTED', 'dest-bad')
        await tiedPair(bad.obligationId, { kind: 'BROADCAST', txid: TXID_A, scriptPubKey: frozen }, { kind: 'CONFIRMED', txid: TXID_A, scriptPubKey: 'not-the-frozen-script' }, reversed)

        const found = await reconciliation.findWrongCollectionDestinationEvidence()
        expect(found.some((r) => r.feeObligationId === ok.obligationId)).toBe(false)
        expect(found.find((r) => r.feeObligationId === bad.obligationId)?.actualScriptPubKey).toBe('not-the-frozen-script')
      })

      it('listForObligation() + recognizeConfirmation(): the last BROADCAST on a tie is the one confirmed', async () => {
        requirePostgres('cto239 last broadcast')
        const o = await obligationIn('IN_PROGRESS', 'lastbc')
        const broadcast = { kind: 'BROADCAST' as const, vout: 0, scriptPubKey: 'deadbeef', amount: '0.000004' }
        await tiedPair(o.obligationId, { ...broadcast, txid: TXID_A }, { ...broadcast, txid: TXID_B }, reversed)

        const listed = await feeCollectionEvidenceRepository.listForObligation(o.obligationId)
        expect(listed.map((e) => e.txid)).toEqual([TXID_A, TXID_B])
        await expect(feeCollectionRecognitionService.recognizeConfirmation(o.obligationId, TXID_A, 800_000)).rejects.toThrow(/does not match/)
        await feeCollectionRecognitionService.recognizeConfirmation(o.obligationId, TXID_B, 800_000)
        expect((await prisma.feeObligation.findUnique({ where: { id: o.obligationId } }))!.collectionStatus).toBe('COLLECTED')
      })

      it('allocate(): the latest CONFIRMED on a tie is the generation it reads', async () => {
        requirePostgres('cto239 allocate')
        const o = await obligationIn('COLLECTED', 'alloc')
        const confirmed = { kind: 'CONFIRMED' as const, txid: TXID_A, distributionPolicyVersionId: null }
        const { earlier, later } = await tiedPair(o.obligationId, confirmed, confirmed, reversed)

        const err: Error = await entitlementAllocationService.allocate(o.obligationId).then(
          () => { throw new Error('allocate() should have refused') },
          (e: Error) => e,
        )
        expect(err.message).toContain(`confirmed generation ${later.id} has no frozen distribution policy`)
        expect(err.message).not.toContain(earlier.id)
      })

      it('findCollectedNotYetAllocated(): reports the latest CONFIRMED on a tie', async () => {
        requirePostgres('cto239 not yet allocated')
        const o = await obligationIn('COLLECTED', 'notalloc')
        const confirmed = { kind: 'CONFIRMED' as const, txid: TXID_A, distributionPolicyVersionId: livePolicyId }
        const { later } = await tiedPair(o.obligationId, confirmed, confirmed, reversed)

        const found = await distributionReconciliation.findCollectedNotYetAllocated()
        expect(found.find((r) => r.feeObligationId === o.obligationId)?.confirmationEvidenceId).toBe(later.id)
      })

      it('findReorgedGenerationsNotReversed(): a same-millisecond REORGED_OUT counts only when recorded after the CONFIRMED row', async () => {
        requirePostgres('cto239 reorged generation')
        const confirmed = { kind: 'CONFIRMED' as const, txid: TXID_A, distributionPolicyVersionId: livePolicyId }
        const reorged = { kind: 'REORGED_OUT' as const, txid: TXID_A }
        const after = await obligationIn('COLLECTED', 'reorg-after')
        const a = await tiedPair(after.obligationId, confirmed, reorged, reversed)
        await entitlementAllocationService.allocate(after.obligationId)
        const before = await obligationIn('COLLECTED', 'reorg-before')
        const b = await tiedPair(before.obligationId, reorged, confirmed, reversed)
        await entitlementAllocationService.allocate(before.obligationId)

        const found = await distributionReconciliation.findReorgedGenerationsNotReversed()
        expect(found.some((r) => r.confirmationEvidenceId === a.earlier.id)).toBe(true)
        expect(found.some((r) => r.confirmationEvidenceId === b.later.id)).toBe(false)
      })

      it('escrowRepository details: CONFIRMED rows on a tie come back in seq order', async () => {
        requirePostgres('cto239 escrow details')
        const o = await obligationIn('COLLECTED', 'details')
        const { earlier, later } = await tiedPair(o.obligationId, { kind: 'CONFIRMED', txid: TXID_A }, { kind: 'CONFIRMED', txid: TXID_B }, reversed)

        const byId = await escrowRepository.findByIdWithDetails(o.escrow.id)
        expect(byId!.feeObligation!.evidence.map((e) => e.id)).toEqual([earlier.id, later.id])
        const byTrade = await escrowRepository.findByTradeIdWithDetails(o.trade.id)
        expect(byTrade!.feeObligation!.evidence.map((e) => e.id)).toEqual([earlier.id, later.id])
      })
    })

    it('a separate process (restart) after a table rewrite (VACUUM FULL) reads the same latest evidence', async () => {
      requirePostgres('cto239 restart')
      const o = await obligationIn('IN_PROGRESS', 'restart')
      await tiedPair(o.obligationId, { kind: 'BROADCAST', txid: TXID_A }, { kind: 'DROPPED', txid: TXID_A }, true)
      await prisma.$executeRawUnsafe('VACUUM FULL "fee_collection_evidence"')

      const inProcess = await reconciliation.findUnresolvedChainEvents()
      expect(inProcess.find((r) => r.feeObligationId === o.obligationId)?.lastEvidenceKind).toBe('DROPPED')

      // A new Node process: new module graph, new Prisma client, new connection pool.
      const { execFile } = require('child_process')
      const root = require('path').resolve(__dirname, '..', '..')
      const code = `
        const r = require(${JSON.stringify(root + '/src/modules/open-settlement/fee-obligation-reconciliation')})
        const { prisma } = require(${JSON.stringify(root + '/src/common/database')})
        r.findUnresolvedChainEvents().then(async (rows) => {
          const row = rows.find((x) => x.feeObligationId === ${JSON.stringify(o.obligationId)})
          process.stdout.write('LAST=' + (row ? row.lastEvidenceKind : 'NONE') + '\\n')
          await prisma.$disconnect()
        }, (e) => { console.error(e); process.exit(1) })
      `
      const stdout: string = await new Promise((resolve, reject) => {
        execFile(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', code], { cwd: root, env: process.env, timeout: 90_000 },
          (err: Error | null, out: string, errOut: string) => (err ? reject(new Error(err.message + ' ' + errOut.slice(0, 600))) : resolve(out)))
      })
      expect(stdout).toContain('LAST=DROPPED')
    })

    it('two writers racing on one obligation: every reader agrees with the (recordedAt, seq) maximum, on every read', async () => {
      requirePostgres('cto239 race')
      for (let round = 0; round < 10; round++) {
        const o = await obligationIn('IN_PROGRESS', `race${round}`)
        await feeCollectionEvidenceRepository.record({ feeObligationId: o.obligationId, kind: 'BROADCAST', txid: TXID_A })
        await Promise.all([
          feeCollectionRecognitionService.recordDropped(o.obligationId, TXID_A),
          feeCollectionRecognitionService.recordReplacement(o.obligationId, TXID_A, TXID_B),
        ])
        const rows = await prisma.$queryRawUnsafe<Array<{ kind: string; seq: number }>>(
          `SELECT kind::text AS kind, seq FROM fee_collection_evidence WHERE "feeObligationId" = $1 ORDER BY "recordedAt" DESC, seq DESC`,
          o.obligationId,
        )
        expect(new Set(rows.map((r) => r.seq)).size).toBe(3)
        const expectedLast = rows[0].kind
        for (let read = 0; read < 3; read++) {
          const listed = await feeCollectionEvidenceRepository.listForObligation(o.obligationId)
          expect(listed[listed.length - 1].kind).toBe(expectedLast)
          const flagged = (await reconciliation.findUnresolvedChainEvents()).some((r) => r.feeObligationId === o.obligationId)
          expect(flagged).toBe(expectedLast === 'DROPPED')
        }
      }
    })
  })
})
