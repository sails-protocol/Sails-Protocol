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
import { createBoundTrade } from './helpers/committedPairFixture'

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
  })

  afterEach(() => {
    if (dbAvailable) {
      config.settlement.protocolFeeCollectionAddress = originalCollectionAddress
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
    const bound = await createBoundTrade(prisma) // F4: real keys + an E21-admitted trade; bound.commit() = its COMMITTED pair
    const { buyer, seller, trade } = bound
    const offer = await prisma.offer.findUniqueOrThrow({ where: { id: trade.offerId } })
    const boundPairId = await bound.commit()

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
          tradeId: trade.id, commitmentPairId: boundPairId, type: 'MULTISIG', asset: 'BTC', lockedAmount: '0.001', status: 'PAYMENT_PENDING',
          feePolicyVersionId: policy.id, snapshotProtocolFeeRate: '0.004', snapshotPayerModel: 'SELLER_PAYS', snapshotEconomicBasis: 'SELLER_DELIVERED_VALUE',
          snapshotFeeCollectionAddress: COLLECTIBLE_ADDRESS, snapshotFeeCollectionWaivedPreFunding: false,
        },
      })
    } else {
      escrow = await prisma.escrow.create({ data: { tradeId: trade.id, commitmentPairId: boundPairId, type: 'MULTISIG', asset: 'BTC', lockedAmount: '0.001', status: 'PAYMENT_PENDING' } })
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
  // BROADCAST over DROPPED on such a tie). Every reader orders by seq alone (CTO 246). Each case below writes two
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

    // A row with a chosen seq, as the migration leaves historical rows. The seq-assign trigger replaces any client
    // value, so only a superuser bypassing triggers (session_replication_role = replica) can write one.
    function historical(data: Prisma.FeeCollectionEvidenceUncheckedCreateInput) {
      return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`)
        return tx.feeCollectionEvidence.create({ data })
      })
    }

    // Two rows sharing one recordedAt; `later` gets the higher seq. physicallyReversed inserts `later` first.
    async function tiedPair(feeObligationId: string, earlier: EvidenceData, later: EvidenceData, physicallyReversed: boolean) {
      const recordedAt = new Date(Date.now() + 86_400_000)
      const [lo, hi] = await nextSeqs()
      const write = (data: EvidenceData, seq: number) => historical({ ...data, feeObligationId, recordedAt, seq })
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

    it('two writers racing on one obligation: every reader agrees with the greatest seq, on every read', async () => {
      requirePostgres('cto239 race')
      for (let round = 0; round < 10; round++) {
        const o = await obligationIn('IN_PROGRESS', `race${round}`)
        await feeCollectionEvidenceRepository.record({ feeObligationId: o.obligationId, kind: 'BROADCAST', txid: TXID_A })
        await Promise.all([
          feeCollectionRecognitionService.recordDropped(o.obligationId, TXID_A),
          feeCollectionRecognitionService.recordReplacement(o.obligationId, TXID_A, TXID_B),
        ])
        const rows = await prisma.$queryRawUnsafe<Array<{ kind: string; seq: number }>>(
          `SELECT kind::text AS kind, seq FROM fee_collection_evidence WHERE "feeObligationId" = $1 ORDER BY seq DESC`,
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

    // ─── CTO 245 — sequence order vs commit order ───────────────────────
    // Two real connections, explicit BEGIN/COMMIT. Rule under test: latest = greatest seq among COMMITTED rows;
    // seq = nextval at INSERT, not commit order; recordedAt (DB default = transaction start) is informational.
    describe('CTO 245 — interleaved transactions (two real connections)', () => {
      type Row = { id: string; seq: number; ms: number }
      type Ev = { kind: string; txid: string; amount?: string; dpv?: boolean; scriptPubKey?: string }
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
      const FORCED_AT = '2099-01-01 00:00:00.123'
      let a: import('pg').Client
      let b: import('pg').Client

      beforeEach(async () => {
        if (!dbAvailable) return
        const { Client } = require('pg')
        a = new Client({ connectionString: config.database.url })
        b = new Client({ connectionString: config.database.url })
        await a.connect()
        await b.connect()
      })
      afterEach(async () => {
        if (!dbAvailable) return
        await a.end()
        await b.end()
      })

      const txStartMs = async (c: import('pg').Client) =>
        (await c.query(`SELECT (extract(epoch FROM now()::timestamp(3)) * 1000)::float8 AS ms`)).rows[0].ms as number

      async function insert(c: import('pg').Client, feeObligationId: string, ev: Ev, recordedAt?: string): Promise<Row> {
        const cols = ['id', '"feeObligationId"', 'kind', 'txid', 'amount', '"distributionPolicyVersionId"']
        const vals = ['gen_random_uuid()::text', '$1', '$2::"FeeCollectionEvidenceKind"', '$3', '$4::decimal', '$5']
        const params: unknown[] = [feeObligationId, ev.kind, ev.txid, ev.amount ?? null, ev.dpv ? livePolicyId : null]
        if (recordedAt) { cols.push('"recordedAt"'); params.push(recordedAt); vals.push(`$${params.length}::timestamp(3)`) }
        if (ev.scriptPubKey) { cols.push('"scriptPubKey"'); params.push(ev.scriptPubKey); vals.push(`$${params.length}`) }
        const r = await c.query(
          `INSERT INTO fee_collection_evidence (${cols.join(', ')}) VALUES (${vals.join(', ')})
           RETURNING id, seq, (extract(epoch FROM "recordedAt") * 1000)::float8 AS ms`, params)
        return r.rows[0]
      }

      // Every changed reader, for one obligation.
      async function readers(obligationId: string, escrowId: string) {
        const listed = await feeCollectionEvidenceRepository.listForObligation(obligationId)
        const mine = <T extends { feeObligationId: string }>(rows: T[]) => rows.find((r) => r.feeObligationId === obligationId)
        return {
          listed: listed.map((e) => e.id),
          unresolved: mine(await reconciliation.findUnresolvedChainEvents())?.lastEvidenceKind ?? null,
          mismatchAmount: mine(await reconciliation.findCollectionEvidenceMismatches())?.confirmedEvidenceAmount ?? null,
          notYetAllocated: mine(await distributionReconciliation.findCollectedNotYetAllocated())?.confirmationEvidenceId ?? null,
          details: (await escrowRepository.findByIdWithDetails(escrowId))!.feeObligation!.evidence.map((e) => e.id),
          detailsByTrade: (await escrowRepository.findByTradeIdWithDetails((await prisma.escrow.findUniqueOrThrow({ where: { id: escrowId } })).tradeId))!.feeObligation!.evidence.map((e) => e.id),
        }
      }

      // IN_PROGRESS: A writes DROPPED, B writes BROADCAST (latest DROPPED => flagged).
      // COLLECTED: A writes CONFIRMED with a wrong amount, B with the computed fee (latest A => mismatch).
      const sets: Record<'IN_PROGRESS' | 'COLLECTED', { A: Ev; B: Ev }> = {
        IN_PROGRESS: { A: { kind: 'DROPPED', txid: TXID_A }, B: { kind: 'BROADCAST', txid: TXID_B } },
        COLLECTED: { A: { kind: 'CONFIRMED', txid: TXID_A, amount: '0.00000999', dpv: true }, B: { kind: 'CONFIRMED', txid: TXID_B, amount: '0.000004', dpv: true } },
      }
      function expected(status: 'IN_PROGRESS' | 'COLLECTED', visible: Row[], latest: Row, A?: Row) {
        const ids = visible.map((r) => r.id)
        const latestIsA = latest === A
        return status === 'IN_PROGRESS'
          ? { listed: ids, unresolved: latestIsA ? 'DROPPED' : null, mismatchAmount: null, notYetAllocated: null, details: [], detailsByTrade: [] }
          : { listed: ids, unresolved: null, mismatchAmount: latestIsA ? '0.00000999' : null, notYetAllocated: latest.id, details: ids, detailsByTrade: ids }
      }

      describe.each([['IN_PROGRESS'], ['COLLECTED']] as const)('%s obligation', (status) => {
        const { A: evA, B: evB } = sets[status]

        it('(lock-wait inversion, CTO 246) B begins first, waits for the obligation lock A holds, inserts and commits last: B is latest for every reader although its recordedAt is earlier', async () => {
          requirePostgres('cto246 inversion')
          const o = await obligationIn(status, `246inv-${status}`)
          const lock = `SELECT 1 FROM fee_obligations WHERE id = $1 FOR UPDATE` // the row lock the collectionStatus CAS takes
          await b.query('BEGIN')
          await sleep(15)
          await a.query('BEGIN')
          await a.query(lock, [o.obligationId])
          const rowA = await insert(a, o.obligationId, evB)
          const bLocked = b.query(lock, [o.obligationId]) // blocks until A commits
          await sleep(50)
          await a.query('COMMIT')
          await bLocked
          const rowB = await insert(b, o.obligationId, evA)
          await b.query('COMMIT')
          expect(rowB.ms).toBeLessThan(rowA.ms) // recordedAt order is the reverse of commit order
          expect(rowB.seq).toBeGreaterThan(rowA.seq) // seq follows the lock order
          expect(await readers(o.obligationId, o.escrow.id)).toEqual(expected(status, [rowA, rowB], rowB, rowB))
        })

        it('(a) latest = greatest committed seq; forced equal recordedAt: A reserves the lower seq, B commits first; A committing later never becomes latest (no retroactive flip)', async () => {
          requirePostgres('cto245 a')
          const o = await obligationIn(status, `245a-${status}`)
          await a.query('BEGIN')
          const rowA = await insert(a, o.obligationId, evA, FORCED_AT)
          await b.query('BEGIN')
          const rowB = await insert(b, o.obligationId, evB, FORCED_AT)
          await b.query('COMMIT')
          expect(rowA.seq).toBeLessThan(rowB.seq)
          expect(rowA.ms).toBe(rowB.ms)
          expect(await readers(o.obligationId, o.escrow.id)).toEqual(expected(status, [rowB], rowB))
          await a.query('COMMIT')
          expect(await readers(o.obligationId, o.escrow.id)).toEqual(expected(status, [rowA, rowB], rowB, rowA))
        })

        it('(b) latest = greatest committed seq; natural recordedAt: A begins and reserves the lower seq, B commits first; B stays latest after A commits', async () => {
          requirePostgres('cto245 b')
          const o = await obligationIn(status, `245b-${status}`)
          await a.query('BEGIN')
          const rowA = await insert(a, o.obligationId, evA)
          await b.query('BEGIN')
          const rowB = await insert(b, o.obligationId, evB)
          await b.query('COMMIT')
          expect(rowA.ms).toBeLessThanOrEqual(rowB.ms)
          expect(rowA.seq).toBeLessThan(rowB.seq)
          expect(await readers(o.obligationId, o.escrow.id)).toEqual(expected(status, [rowB], rowB))
          await a.query('COMMIT')
          expect(await readers(o.obligationId, o.escrow.id)).toEqual(expected(status, [rowA, rowB], rowB, rowA))
        })

        it('(c) latest = greatest committed seq, recordedAt ignored: A begins first (earlier recordedAt) but inserts after B (higher seq), so A becomes latest when it commits', async () => {
          requirePostgres('cto245 c')
          const o = await obligationIn(status, `245c-${status}`)
          await a.query('BEGIN')
          const aStart = await txStartMs(a)
          await sleep(15)
          await b.query('BEGIN')
          const rowB = await insert(b, o.obligationId, evB)
          await b.query('COMMIT')
          expect(await readers(o.obligationId, o.escrow.id)).toEqual(expected(status, [rowB], rowB))
          const rowA = await insert(a, o.obligationId, evA)
          await a.query('COMMIT')
          expect(rowA.ms).toBe(aStart) // recordedAt is A's transaction start, not its insert time
          expect(rowA.ms).toBeLessThan(rowB.ms)
          expect(rowA.seq).toBeGreaterThan(rowB.seq)
          expect(await readers(o.obligationId, o.escrow.id)).toEqual(expected(status, [rowB, rowA], rowA, rowA))
        })

        it('(d) latest = greatest COMMITTED seq: a rolled-back insert leaves a gap in seq and changes no reader', async () => {
          requirePostgres('cto245 d')
          const o = await obligationIn(status, `245d-${status}`)
          await a.query('BEGIN')
          const rowA = await insert(a, o.obligationId, evA, FORCED_AT)
          await b.query('BEGIN')
          const rowB = await insert(b, o.obligationId, evB, FORCED_AT)
          await b.query('COMMIT')
          const before = await readers(o.obligationId, o.escrow.id)
          await a.query('ROLLBACK')
          expect(await readers(o.obligationId, o.escrow.id)).toEqual(before)
          expect(before).toEqual(expected(status, [rowB], rowB))
          const seqs = await prisma.$queryRawUnsafe<Array<{ seq: number }>>(`SELECT seq FROM fee_collection_evidence WHERE seq IN ($1, $2)`, rowA.seq, rowB.seq)
          expect(seqs.map((r) => r.seq)).toEqual([rowB.seq])
        })

        it('(e) the only answer change: a HIGHER seq inserted before an earlier read but committed after it becomes latest on the next read', async () => {
          requirePostgres('cto245 e')
          const o = await obligationIn(status, `245e-${status}`)
          await b.query('BEGIN')
          await a.query('BEGIN')
          const rowB = await insert(b, o.obligationId, evB)
          const rowA = await insert(a, o.obligationId, evA)
          await b.query('COMMIT')
          expect(rowA.seq).toBeGreaterThan(rowB.seq)
          expect(await readers(o.obligationId, o.escrow.id)).toEqual(expected(status, [rowB], rowB))
          await a.query('COMMIT')
          expect(await readers(o.obligationId, o.escrow.id)).toEqual(expected(status, [rowB, rowA], rowA, rowA))
        })
      })

      // CTO 255 G1: the same lock-wait inversion for the four readers readers() does not cover. In each case the
      // row committed last has the EARLIER recordedAt, so recordedAt-first ordering (with seq only as a tiebreak)
      // picks the wrong row.
      describe('CTO 255 G1 — lock-wait inversion, remaining readers', () => {
        /** B begins first, A takes the obligation row lock, inserts `first` and commits; B then inserts `last`. */
        async function inverted(obligationId: string, first: Ev, last: Ev): Promise<{ first: Row; last: Row }> {
          const lock = `SELECT 1 FROM fee_obligations WHERE id = $1 FOR UPDATE`
          await b.query('BEGIN')
          await sleep(15)
          await a.query('BEGIN')
          await a.query(lock, [obligationId])
          const rowFirst = await insert(a, obligationId, first)
          const bLocked = b.query(lock, [obligationId])
          await sleep(50)
          await a.query('COMMIT')
          await bLocked
          const rowLast = await insert(b, obligationId, last)
          await b.query('COMMIT')
          expect(rowLast.ms).toBeLessThan(rowFirst.ms)
          expect(rowLast.seq).toBeGreaterThan(rowFirst.seq)
          return { first: rowFirst, last: rowLast }
        }

        it('allocate(): allocates the CONFIRMED generation committed last', async () => {
          requirePostgres('cto255 allocate inversion')
          const o = await obligationIn('COLLECTED', '255-alloc')
          const { last } = await inverted(o.obligationId, { kind: 'CONFIRMED', txid: TXID_A, dpv: true }, { kind: 'CONFIRMED', txid: TXID_B, dpv: true })
          const entries = await entitlementAllocationService.allocate(o.obligationId)
          const rows = await prisma.entitlementLedgerEntry.findMany({ where: { id: { in: entries.map((e) => e.id) } } })
          expect(rows.length).toBeGreaterThan(0)
          expect(new Set(rows.map((r) => r.confirmationEvidenceId))).toEqual(new Set([last.id]))
        })

        it('findSettlementTxidMismatches(): compares the BROADCAST committed last', async () => {
          requirePostgres('cto255 settlement txid inversion')
          const ok = await obligationIn('IN_PROGRESS', '255-txid-ok')
          await prisma.escrow.update({ where: { id: ok.escrow.id }, data: { txReleaseId: TXID_B } })
          await inverted(ok.obligationId, { kind: 'BROADCAST', txid: TXID_A }, { kind: 'BROADCAST', txid: TXID_B })
          const bad = await obligationIn('IN_PROGRESS', '255-txid-bad')
          await prisma.escrow.update({ where: { id: bad.escrow.id }, data: { txReleaseId: TXID_A } })
          await inverted(bad.obligationId, { kind: 'BROADCAST', txid: TXID_A }, { kind: 'BROADCAST', txid: TXID_B })

          const found = await reconciliation.findSettlementTxidMismatches()
          expect(found.some((r) => r.feeObligationId === ok.obligationId)).toBe(false)
          expect(found.find((r) => r.feeObligationId === bad.obligationId)?.evidenceTxid).toBe(TXID_B)
        })

        it('findWrongCollectionDestinationEvidence(): compares the BROADCAST/CONFIRMED script committed last', async () => {
          requirePostgres('cto255 destination inversion')
          const frozen = frozenScriptHex()
          const ok = await obligationIn('COLLECTED', '255-dest-ok')
          await inverted(ok.obligationId, { kind: 'BROADCAST', txid: TXID_A, scriptPubKey: 'not-the-frozen-script' }, { kind: 'CONFIRMED', txid: TXID_A, scriptPubKey: frozen })
          const bad = await obligationIn('COLLECTED', '255-dest-bad')
          await inverted(bad.obligationId, { kind: 'BROADCAST', txid: TXID_A, scriptPubKey: frozen }, { kind: 'CONFIRMED', txid: TXID_A, scriptPubKey: 'not-the-frozen-script' })

          const found = await reconciliation.findWrongCollectionDestinationEvidence()
          expect(found.some((r) => r.feeObligationId === ok.obligationId)).toBe(false)
          expect(found.find((r) => r.feeObligationId === bad.obligationId)?.actualScriptPubKey).toBe('not-the-frozen-script')
        })

        it('findReorgedGenerationsNotReversed(): a REORGED_OUT counts only when committed after the CONFIRMED row', async () => {
          requirePostgres('cto255 reorged inversion')
          const after = await obligationIn('COLLECTED', '255-reorg-after')
          const x = await inverted(after.obligationId, { kind: 'CONFIRMED', txid: TXID_A, dpv: true }, { kind: 'REORGED_OUT', txid: TXID_A })
          await entitlementAllocationService.allocate(after.obligationId)
          const before = await obligationIn('COLLECTED', '255-reorg-before')
          const y = await inverted(before.obligationId, { kind: 'REORGED_OUT', txid: TXID_A }, { kind: 'CONFIRMED', txid: TXID_A, dpv: true })
          await entitlementAllocationService.allocate(before.obligationId)

          const found = await distributionReconciliation.findReorgedGenerationsNotReversed()
          expect(found.some((r) => r.confirmationEvidenceId === x.first.id)).toBe(true)
          expect(found.some((r) => r.confirmationEvidenceId === y.last.id)).toBe(false)
        })
      })

      // Why recordedAt cannot order application writes either: Prisma Client fills @default(now()) itself.
      it('application writes: Prisma sets recordedAt at insert time (app clock), not the DB transaction start', async () => {
        requirePostgres('cto245 prisma recordedAt')
        const o = await obligationIn('IN_PROGRESS', '245-prisma')
        const { row, startMs } = await prisma.$transaction(async (tx) => {
          const [{ ms }] = await tx.$queryRawUnsafe<Array<{ ms: number }>>(`SELECT (extract(epoch FROM now()::timestamp(3)) * 1000)::float8 AS ms`)
          await tx.$executeRawUnsafe('SELECT pg_sleep(0.2)')
          return { row: await feeCollectionEvidenceRepository.record({ feeObligationId: o.obligationId, kind: 'DROPPED', txid: TXID_A }, tx), startMs: ms }
        })
        expect(row.recordedAt.getTime() - startMs).toBeGreaterThanOrEqual(150)
      })
    })

    // ─── CTO 245 — seq is write-once ────────────────────────────────────
    describe('CTO 245 — seq immutability trigger', () => {
      it('an UPDATE that changes seq is refused; an UPDATE of another column (note) still works and keeps seq', async () => {
        requirePostgres('cto245 seq immutability')
        const o = await obligationIn('IN_PROGRESS', '245-immut')
        const row = await feeCollectionEvidenceRepository.record({ feeObligationId: o.obligationId, kind: 'DROPPED', txid: TXID_A })
        await expect(prisma.$executeRawUnsafe(`UPDATE fee_collection_evidence SET seq = seq + 1000000 WHERE id = $1`, row.id))
          .rejects.toThrow(/seq is immutable/)
        await expect(prisma.feeCollectionEvidence.update({ where: { id: row.id }, data: { seq: row.seq + 1 } })).rejects.toThrow(/seq is immutable/)
        await prisma.$executeRawUnsafe(`UPDATE fee_collection_evidence SET note = 'cto245' WHERE id = $1`, row.id)
        const after = await prisma.feeCollectionEvidence.findUnique({ where: { id: row.id } })
        expect(after!.note).toBe('cto245')
        expect(after!.seq).toBe(row.seq)
      })

      // CTO 255 G3 / 261: the client can never choose seq. Probed as sails_runtime under #650's grants (it could);
      // the trigger applies to every role, so the superuser test connection proves the same rule.
      it.each([['huge', 2147483000], ['duplicate', 1], ['negative', -5]])('an INSERT with an explicit %s seq gets the next sequence value instead', async (_l, chosen) => {
        requirePostgres('cto261 seq assigned')
        const o = await obligationIn('IN_PROGRESS', `261-seq-${_l}`)
        const before = await feeCollectionEvidenceRepository.record({ feeObligationId: o.obligationId, kind: 'BROADCAST', txid: TXID_A })
        const [row] = await prisma.$queryRawUnsafe<Array<{ seq: number }>>(
          `INSERT INTO fee_collection_evidence (id, "feeObligationId", kind, txid, seq) VALUES (gen_random_uuid()::text, $1, 'DROPPED', $2, $3) RETURNING seq`,
          o.obligationId, TXID_A, chosen)
        expect(row.seq).not.toBe(chosen)
        expect(row.seq).toBeGreaterThan(before.seq)
        const viaPrisma = await prisma.feeCollectionEvidence.create({ data: { feeObligationId: o.obligationId, kind: 'DROPPED', txid: TXID_A, seq: chosen } })
        expect(viaPrisma.seq).toBeGreaterThan(row.seq)
        expect((await feeCollectionEvidenceRepository.listForObligation(o.obligationId)).map((e) => e.seq)).toEqual([before.seq, row.seq, viaPrisma.seq])
      })
    })

    // ─── CTO 261 — REORGED_OUT: one transaction, claim first, stale txid refused ───────────────
    describe('CTO 261 — recordReorgAndRevert() is transactional and refuses a stale txid', () => {
      it('a reorg reported for a superseded generation records nothing and reverts nothing', async () => {
        requirePostgres('cto261 stale reorg')
        const o = await obligationIn('IN_PROGRESS', '261-stale')
        const broadcast = { vout: 0, scriptPubKey: 'deadbeef', amount: '0.000004' }
        await feeCollectionEvidenceRepository.record({ feeObligationId: o.obligationId, kind: 'BROADCAST', txid: TXID_A, ...broadcast } as any)
        await feeCollectionRecognitionService.recognizeConfirmation(o.obligationId, TXID_A, 800_000)
        await feeCollectionRecognitionService.recordReorgAndRevert(o.obligationId, TXID_A) // G1 reorged out
        await feeCollectionEvidenceRepository.record({ feeObligationId: o.obligationId, kind: 'BROADCAST', txid: TXID_B, ...broadcast } as any)
        await feeCollectionRecognitionService.recognizeConfirmation(o.obligationId, TXID_B, 800_010) // G2
        const rowsBefore = await feeCollectionEvidenceRepository.listForObligation(o.obligationId)

        // A second sweep instance still holding G1's txid from an older listing:
        await expect(feeCollectionRecognitionService.recordReorgAndRevert(o.obligationId, TXID_A)).rejects.toThrow(/stale reorg observation/)
        expect(await feeCollectionEvidenceRepository.listForObligation(o.obligationId)).toHaveLength(rowsBefore.length)
        expect((await prisma.feeObligation.findUnique({ where: { id: o.obligationId } }))!.collectionStatus).toBe('COLLECTED')
      })

      it('a genuine reorg of the latest generation records REORGED_OUT after it and reverts COLLECTED -> IN_PROGRESS', async () => {
        requirePostgres('cto261 genuine reorg')
        const o = await obligationIn('IN_PROGRESS', '261-genuine')
        await feeCollectionEvidenceRepository.record({ feeObligationId: o.obligationId, kind: 'BROADCAST', txid: TXID_A, vout: 0, scriptPubKey: 'deadbeef', amount: '0.000004' } as any)
        await feeCollectionRecognitionService.recognizeConfirmation(o.obligationId, TXID_A, 800_000)
        expect(await feeCollectionRecognitionService.recordReorgAndRevert(o.obligationId, TXID_A)).toEqual({ reverted: true })
        const rows = await feeCollectionEvidenceRepository.listForObligation(o.obligationId)
        expect(rows.map((e) => e.kind)).toEqual(['BROADCAST', 'CONFIRMED', 'REORGED_OUT'])
        expect((await prisma.feeObligation.findUnique({ where: { id: o.obligationId } }))!.collectionStatus).toBe('IN_PROGRESS')
      })

      it('a claim lost to a concurrent revert rolls back: no second REORGED_OUT row', async () => {
        requirePostgres('cto261 concurrent reorg')
        const o = await obligationIn('IN_PROGRESS', '261-concurrent')
        await feeCollectionEvidenceRepository.record({ feeObligationId: o.obligationId, kind: 'BROADCAST', txid: TXID_A, vout: 0, scriptPubKey: 'deadbeef', amount: '0.000004' } as any)
        await feeCollectionRecognitionService.recognizeConfirmation(o.obligationId, TXID_A, 800_000)
        const results = await Promise.allSettled([
          feeCollectionRecognitionService.recordReorgAndRevert(o.obligationId, TXID_A),
          feeCollectionRecognitionService.recordReorgAndRevert(o.obligationId, TXID_A),
        ])
        expect(results.filter((r) => r.status === 'fulfilled' && (r.value as any).reverted)).toHaveLength(1)
        const reorged = (await feeCollectionEvidenceRepository.listForObligation(o.obligationId)).filter((e) => e.kind === 'REORGED_OUT')
        expect(reorged.length).toBeLessThanOrEqual(2) // the loser either rolled back or, arriving after the commit, saw IN_PROGRESS
        expect((await prisma.feeObligation.findUnique({ where: { id: o.obligationId } }))!.collectionStatus).toBe('IN_PROGRESS')
      })
    })

    // ─── CTO 245 (A) — economic impact of a historical tie ──────────────
    // Rows that predate the seq column got seq in physical order. These cases fix which row a historical tie
    // resolves to and show what allocate() does with it. They characterize current behavior; they do not
    // change it (economic policy is a CTO decision).
    describe('CTO 245 (A) — historical same-millisecond CONFIRMED tie, economic outcome', () => {
      async function otherPolicyId(): Promise<string> {
        const { distributionPolicyService } = require('../../src/modules/open-settlement/distribution-policy.service')
        const { distributionRecipientRepository } = require('../../src/modules/open-settlement/distribution-recipient-repository')
        const recipient = await distributionRecipientRepository.create({ class: `FIXTURE_CTO245_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, label: 'cto245-other' })
        const draft = await distributionPolicyService.createDraft({ label: `cto245-${Date.now()}`, createdBy: 'cto245-integration-test' })
        await distributionPolicyService.addRecipient(draft.id, recipient.id, '100')
        return draft.id
      }

      it.each([['live policy holds the higher seq', true], ['other policy holds the higher seq', false]])(
        'allocate(): on two tied CONFIRMED rows frozen to different policies, the higher seq decides who is entitled (%s)', async (_l, liveHigher) => {
          requirePostgres('cto245 A policy')
          const other = await otherPolicyId()
          const o = await obligationIn('COLLECTED', '245A-policy')
          const [low, high] = liveHigher ? [other, livePolicyId] : [livePolicyId, other]
          await tiedPair(o.obligationId, { kind: 'CONFIRMED', txid: TXID_A, distributionPolicyVersionId: low }, { kind: 'CONFIRMED', txid: TXID_A, distributionPolicyVersionId: high }, true)
          await entitlementAllocationService.allocate(o.obligationId)
          const entries = await prisma.entitlementLedgerEntry.findMany({ where: { feeObligationId: o.obligationId } })
          expect(new Set(entries.map((e) => e.distributionPolicyVersionId))).toEqual(new Set([high]))
        })

      // Was the STOP characterization (CTO 245): before #653 the second allocate() succeeded and entitled the same
      // revenue twice. Composed with #653 (CTO 272) it must be refused while the first allocation is unreversed.
      it('an obligation allocated on the tie row the old order picked is NOT allocated again once seq makes the other row latest', async () => {
        requirePostgres('cto245 A double allocation')
        const o = await obligationIn('COLLECTED', '245A-double')
        const recordedAt = new Date(Date.now() + 86_400_000)
        const [lo, hi] = await nextSeqs()
        const confirmed = { kind: 'CONFIRMED' as const, txid: TXID_A, distributionPolicyVersionId: livePolicyId, feeObligationId: o.obligationId, recordedAt }
        const x = await historical({ ...confirmed, seq: lo })
        await entitlementAllocationService.allocate(o.obligationId) // as if allocated before the migration, on x
        const y = await historical({ ...confirmed, seq: hi }) // the tied row seq now ranks higher

        const flagged = await distributionReconciliation.findCollectedNotYetAllocated()
        expect(flagged.find((r) => r.feeObligationId === o.obligationId)?.confirmationEvidenceId).toBe(y.id)
        await expect(entitlementAllocationService.allocate(o.obligationId)).rejects.toThrow(/earlier generation .* is still allocated/)
        const entries = await prisma.entitlementLedgerEntry.findMany({ where: { feeObligationId: o.obligationId, kind: 'ALLOCATION' } })
        const sumFor = (id: string) => entries.filter((e) => e.confirmationEvidenceId === id).reduce((s, e) => s.plus(e.amount), new Prisma.Decimal(0))
        expect(sumFor(x.id).isZero()).toBe(false)
        expect(sumFor(y.id).isZero()).toBe(true) // the revenue stays entitled once

        // Only after the first generation is fully reversed may the row seq now ranks latest be allocated.
        await entitlementAllocationService.reverseGeneration(x.id)
        await entitlementAllocationService.allocate(o.obligationId)
        const all = await prisma.entitlementLedgerEntry.findMany({ where: { feeObligationId: o.obligationId } })
        expect(all.reduce((s, e) => s.plus(e.amount), new Prisma.Decimal(0)).toString()).toBe(sumFor(x.id).toString())
      })
    })
  })
})
