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
import { boundOfferRow, boundTradeRow, sellerPixAccount } from './economicFixtures'

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
    const acct = await sellerPixAccount(prisma, seller.id)
    const offer = await prisma.offer.create({ data: { userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '65000', minAmount: '0.001', maxAmount: '1', ...boundOfferRow(acct) } })
    const trade = await prisma.trade.create({ data: { ...boundTradeRow(acct), offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, asset: 'BTC', amount: '0.001', priceUsd: '65000', totalUsd: '65' } })

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
          txLockId: require('crypto').randomBytes(32).toString('hex'), txLockVout: 0, // #235 R7G F8A: as lockFunds() writes it
          feePolicyVersionId: policy.id, snapshotProtocolFeeRate: '0.004', snapshotPayerModel: 'SELLER_PAYS', snapshotEconomicBasis: 'SELLER_DELIVERED_VALUE',
          snapshotFeeCollectionAddress: COLLECTIBLE_ADDRESS, snapshotFeeCollectionWaivedPreFunding: false,
        },
      })
    } else {
      escrow = await prisma.escrow.create({ data: { tradeId: trade.id, type: 'MULTISIG', asset: 'BTC', lockedAmount: '0.001', status: 'PAYMENT_PENDING', txLockId: require('crypto').randomBytes(32).toString('hex'), txLockVout: 0 } })
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
})
