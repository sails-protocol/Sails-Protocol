// tests/integration/collectedTimeDistributionFreeze.test.ts
//
// Missão 11 Fase 7.2 — CTO-frozen decision: DistributionPolicyVersion
// becomes economically binding at COLLECTED time (FeeCollectionEvidence
// (CONFIRMED) recorded), never at whenever an allocation worker happens
// to run. This file is the real-Postgres, end-to-end proof of that
// decision — every fixture below drives the REAL production code path
// (feeCollectionRecognitionService.recognizeConfirmation() /
// entitlementAllocationService.allocate()), never a hand-built row that
// bypasses the freeze logic itself.
//
// §R adversarial-test items covered here: 1-10, 16-18, 21-22 (see this
// mandate's own numbered list). Items 11-15 (exclusivity + raw-SQL
// bypass) live in economicPolicyExclusivity.test.ts; items 19-20
// (operator CLI) live in economicPolicyOperatorCli.test.ts; item 23
// (arbiter commitment regression) is escrowArbiterCommitmentIntegration.
// test.ts's own unchanged job, not duplicated here.

import { PrismaClient, Prisma } from '@prisma/client'
import { createPostgresIntegrationHarness } from './postgresTestHarness'

describe('COLLECTED-time DistributionPolicyVersion freeze (Missão 11 Fase 7.2, real Postgres)', () => {
  jest.setTimeout(60_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let distributionRecipientRepository: typeof import('../../src/modules/open-settlement/distribution-recipient-repository').distributionRecipientRepository
  let distributionPolicyService: typeof import('../../src/modules/open-settlement/distribution-policy.service').distributionPolicyService
  let entitlementAllocationService: typeof import('../../src/modules/open-settlement/entitlement-allocation.service').entitlementAllocationService
  let entitlementLedgerRepository: typeof import('../../src/modules/open-settlement/entitlement-ledger-repository').entitlementLedgerRepository
  let feeCollectionRecognitionService: typeof import('../../src/modules/open-settlement/fee-collection-recognition.service').feeCollectionRecognitionService
  let escrowService: typeof import('../../src/modules/open-settlement/escrow.service').escrowService
  let nativeUnitDecimalsFor: typeof import('../../src/modules/open-settlement/entitlement-allocation.service').nativeUnitDecimalsFor

  beforeAll(async () => {
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ distributionRecipientRepository } = require('../../src/modules/open-settlement/distribution-recipient-repository'))
    ;({ distributionPolicyService } = require('../../src/modules/open-settlement/distribution-policy.service'))
    ;({ entitlementAllocationService, nativeUnitDecimalsFor } = require('../../src/modules/open-settlement/entitlement-allocation.service'))
    ;({ entitlementLedgerRepository } = require('../../src/modules/open-settlement/entitlement-ledger-repository'))
    ;({ feeCollectionRecognitionService } = require('../../src/modules/open-settlement/fee-collection-recognition.service'))
    ;({ escrowService } = require('../../src/modules/open-settlement/escrow.service'))
  })

  afterAll(async () => {
    if (dbAvailable) await prisma.$disconnect()
  })

  function requirePostgres(name: string): void {
    pg.requirePostgres(name)
  }

  function suffix() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }

  async function fixtureTrade() {
    const s = suffix()
    const buyer = await prisma.user.create({ data: { publicKey: `pk-buyer-${s}` } })
    const seller = await prisma.user.create({ data: { publicKey: `pk-seller-${s}` } })
    const offer = await prisma.offer.create({ data: { userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '65000', minAmount: '0.001', maxAmount: '1', paymentMethod: 'PIX' } })
    return prisma.trade.create({ data: { offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, asset: 'BTC', amount: '0.001', priceUsd: '65000', totalUsd: '65' } })
  }

  /** A fresh, uniquely-railed FeePolicyVersion + escrow + PENDING_COLLECTION
   *  FeeObligation — everything recognizeConfirmation() needs, but not yet
   *  broadcast/confirmed (the test itself drives that, so it can freely
   *  publish/retire DistributionPolicyVersions in between). */
  async function fixtureObligation(computedFeeBtc: string): Promise<string> {
    const trade = await fixtureTrade()
    const railScope = `FIXTURE_RAIL_COLLECTED_FREEZE-${suffix()}`
    const feePolicy = await prisma.feePolicyVersion.create({
      data: {
        label: `fase7-2-freeze-feepolicy-${suffix()}`, railScope, status: 'PUBLISHED', publishedAt: new Date(),
        protocolFeeRate: '0.004', payerModel: 'SELLER_PAYS', economicBasis: 'SELLER_DELIVERED_VALUE',
        requiredConfirmations: 1, createdBy: 'fase7-2-freeze-test',
      },
    })
    const escrow = await prisma.escrow.create({ data: { tradeId: trade.id, type: 'MOCK', asset: 'BTC', lockedAmount: '0.001' } })
    const obligation = await prisma.feeObligation.create({
      data: {
        escrowId: escrow.id, feePolicyVersionId: feePolicy.id, economicDetermination: 'OWED',
        collectionStatus: 'PENDING_COLLECTION', basisAmount: '0.001', computedFee: computedFeeBtc, asset: 'BTC',
      },
    })
    return obligation.id
  }

  async function broadcastAndConfirm(obligationId: string, txid: string, confirmedAtHeight = 800_000) {
    await feeCollectionRecognitionService.recordBroadcastAndAdvance(obligationId, { txid, vout: 1, scriptPubKey: 'deadbeef', amountSats: 1 })
    await feeCollectionRecognitionService.recognizeConfirmation(obligationId, txid, confirmedAtHeight)
  }

  /** Reconfirmation after a reorg — same pattern
   *  distributionEntitlementFoundation.test.ts already established: a
   *  genuine re-broadcast of a replacement transaction records a fresh
   *  BROADCAST row (recordBroadcastAndAdvance() only handles the FIRST
   *  broadcast), then recognizeConfirmation() proceeds normally. */
  async function reconfirm(obligationId: string, txid: string, confirmedAtHeight: number) {
    const { feeCollectionEvidenceRepository } = require('../../src/modules/open-settlement/fee-collection-evidence-repository')
    await feeCollectionEvidenceRepository.record({ feeObligationId: obligationId, kind: 'BROADCAST', txid, vout: 1, scriptPubKey: 'deadbeef', amount: new Prisma.Decimal(1).dividedBy(1e8) })
    await feeCollectionRecognitionService.recognizeConfirmation(obligationId, txid, confirmedAtHeight)
  }

  async function fixtureRecipient() {
    return distributionRecipientRepository.create({ class: `FIXTURE_${suffix().toUpperCase().replace(/[^A-Z0-9]/g, '')}`, label: 'fixture-recipient' })
  }

  async function publish100PctPolicy(): Promise<string> {
    const live = await distributionPolicyService.findLivePolicy()
    if (live) await distributionPolicyService.retire(live.id)
    const recipient = await fixtureRecipient()
    const draft = await distributionPolicyService.createDraft({ label: `fase7-2-policy-${suffix()}`, createdBy: 'fase7-2-freeze-test' })
    await distributionPolicyService.addRecipient(draft.id, recipient.id, '100')
    const published = await distributionPolicyService.publish(draft.id)
    return published.id
  }

  async function retireLivePolicyIfAny() {
    const live = await distributionPolicyService.findLivePolicy()
    if (live) await distributionPolicyService.retire(live.id)
  }

  async function latestConfirmedEvidence(obligationId: string) {
    return prisma.feeCollectionEvidence.findFirst({ where: { feeObligationId: obligationId, kind: 'CONFIRMED' }, orderBy: { seq: 'desc' } })
  }

  // ─── R1-R3: freeze at COLLECTED, allocate() uses the frozen value ───────
  it('R1/R3: G1 freezes P1 at CONFIRMED time, and allocate(G1) uses exactly P1', async () => {
    requirePostgres('R1/R3')
    await retireLivePolicyIfAny()
    const p1 = await publish100PctPolicy()
    const obligationId = await fixtureObligation('0.00000500')
    await broadcastAndConfirm(obligationId, `t1-${suffix()}`.padEnd(64, '0'))

    const evidence = await latestConfirmedEvidence(obligationId)
    expect(evidence!.distributionPolicyVersionId).toBe(p1)

    const entries = await entitlementAllocationService.allocate(obligationId)
    expect(entries).toHaveLength(1)
    const entry = await prisma.entitlementLedgerEntry.findUnique({ where: { id: entries[0].id } })
    expect(entry!.distributionPolicyVersionId).toBe(p1)
  })

  // ─── R2: publishing P2 before allocate() does not affect G1 ─────────────
  it('R2: publishing P2 after G1 is CONFIRMED (but before allocate() runs) does not change which policy G1 uses', async () => {
    requirePostgres('R2')
    await retireLivePolicyIfAny()
    const p1 = await publish100PctPolicy()
    const obligationId = await fixtureObligation('0.00000600')
    await broadcastAndConfirm(obligationId, `t2-${suffix()}`.padEnd(64, '0'))

    // P2 published AFTER G1's freeze, BEFORE allocate() ever runs.
    await distributionPolicyService.retire(p1)
    const p2 = await publish100PctPolicy()
    expect(p2).not.toBe(p1)

    const entries = await entitlementAllocationService.allocate(obligationId)
    const entry = await prisma.entitlementLedgerEntry.findUnique({ where: { id: entries[0].id } })
    expect(entry!.distributionPolicyVersionId).toBe(p1) // NOT p2
  })

  // ─── R4/R5: raw SQL cannot mutate or clear the frozen reference ─────────
  it('R4: raw SQL cannot replace G1\'s frozen policy reference with a different one', async () => {
    requirePostgres('R4')
    await retireLivePolicyIfAny()
    const p1 = await publish100PctPolicy()
    const obligationId = await fixtureObligation('0.00000700')
    await broadcastAndConfirm(obligationId, `t4-${suffix()}`.padEnd(64, '0'))
    const evidence = await latestConfirmedEvidence(obligationId)

    await distributionPolicyService.retire(p1)
    const p2 = await publish100PctPolicy()

    await expect(
      prisma.$executeRawUnsafe(`UPDATE fee_collection_evidence SET "distributionPolicyVersionId" = $1 WHERE id = $2`, p2, evidence!.id)
    ).rejects.toThrow(/immutable/i)
  })

  it('R5: raw SQL cannot clear G1\'s frozen policy reference to NULL', async () => {
    requirePostgres('R5')
    await retireLivePolicyIfAny()
    await publish100PctPolicy()
    const obligationId = await fixtureObligation('0.00000800')
    await broadcastAndConfirm(obligationId, `t5-${suffix()}`.padEnd(64, '0'))
    const evidence = await latestConfirmedEvidence(obligationId)

    await expect(
      prisma.$executeRawUnsafe(`UPDATE fee_collection_evidence SET "distributionPolicyVersionId" = NULL WHERE id = $1`, evidence!.id)
    ).rejects.toThrow(/immutable/i)
  })

  // ─── R6-R8: reorg + reconfirmation ───────────────────────────────────────
  it('R6/R7/R8: a reorg leaves G1/P1 historical; a reconfirmation freezes G2 to the then-live P2; allocation for G2 uses P2', async () => {
    requirePostgres('R6/R7/R8')
    await retireLivePolicyIfAny()
    const p1 = await publish100PctPolicy()
    const obligationId = await fixtureObligation('0.00000900')
    const txid1 = `t6a-${suffix()}`.padEnd(64, '0')
    await broadcastAndConfirm(obligationId, txid1)
    const g1 = await latestConfirmedEvidence(obligationId)
    expect(g1!.distributionPolicyVersionId).toBe(p1)

    // Reorg — obligation reverts COLLECTED -> IN_PROGRESS. G1's own row is
    // never touched (append-only) — re-read it to prove that directly.
    await feeCollectionRecognitionService.recordReorgAndRevert(obligationId, txid1)
    const g1AfterReorg = await prisma.feeCollectionEvidence.findUnique({ where: { id: g1!.id } })
    expect(g1AfterReorg!.distributionPolicyVersionId).toBe(p1) // R6: still historical, still P1

    // A new policy becomes live before the reconfirmation.
    await distributionPolicyService.retire(p1)
    const p2 = await publish100PctPolicy()

    const txid2 = `t6b-${suffix()}`.padEnd(64, '0')
    await reconfirm(obligationId, txid2, 800_010)
    const g2 = await latestConfirmedEvidence(obligationId)
    expect(g2!.id).not.toBe(g1!.id) // a genuinely new generation
    expect(g2!.distributionPolicyVersionId).toBe(p2) // R7: G2 freezes the then-live P2

    // R8: allocation for the CURRENT generation (G2) uses P2, not P1 —
    // allocate() always resolves to the most recent CONFIRMED row.
    const entries = await entitlementAllocationService.allocate(obligationId)
    const entry = await prisma.entitlementLedgerEntry.findUnique({ where: { id: entries[0].id } })
    expect(entry!.confirmationEvidenceId).toBe(g2!.id)
    expect(entry!.distributionPolicyVersionId).toBe(p2)

    // G1 itself remains permanently, visibly tied to P1 — never rewritten.
    const g1Final = await prisma.feeCollectionEvidence.findUnique({ where: { id: g1!.id } })
    expect(g1Final!.distributionPolicyVersionId).toBe(p1)
  })

  // ─── R9/R10: zero-policy semantics ───────────────────────────────────────
  it('R9/R10: a zero-policy G1 (nothing PUBLISHED at CONFIRMED time) stays NULL forever, and a later P2 can never retroactively claim it', async () => {
    requirePostgres('R9/R10')
    await retireLivePolicyIfAny() // deliberately leave ZERO policy PUBLISHED
    const obligationId = await fixtureObligation('0.00001000')
    await broadcastAndConfirm(obligationId, `t9-${suffix()}`.padEnd(64, '0'))

    const g1 = await latestConfirmedEvidence(obligationId)
    expect(g1!.distributionPolicyVersionId).toBeNull()

    // allocate() must fail closed — not adopt whatever becomes live later.
    await expect(entitlementAllocationService.allocate(obligationId)).rejects.toThrow(/no frozen distribution policy/)

    // A policy published AFTER confirmation...
    await publish100PctPolicy()

    // ...still cannot retroactively claim G1's revenue.
    await expect(entitlementAllocationService.allocate(obligationId)).rejects.toThrow(/no frozen distribution policy/)
    const g1Reread = await prisma.feeCollectionEvidence.findUnique({ where: { id: g1!.id } })
    expect(g1Reread!.distributionPolicyVersionId).toBeNull() // R9: NULL forever, no backfill
  })

  // ─── R16/R17: legacy FeePolicyVersion field disposition ─────────────────
  it('R16/R17: a historical FeePolicyVersion with real legacy bucket percentages remains fully readable, and a new one can publish without them', async () => {
    requirePostgres('R16/R17')
    const s = suffix()
    const historical = await prisma.feePolicyVersion.create({
      data: {
        label: `historical-with-legacy-pcts-${s}`, railScope: `FIXTURE_RAIL_LEGACY_READABLE-${s}`, status: 'PUBLISHED', publishedAt: new Date(),
        protocolFeeRate: '0.004', payerModel: 'SELLER_PAYS', economicBasis: 'SELLER_DELIVERED_VALUE',
        nodeOperatorPct: '30', treasuryPct: '25', walletRebatePct: '35', arbitratorReservePct: '10',
        requiredConfirmations: 1, createdBy: 'fase7-2-legacy-readability-test',
      },
    })
    const reread = await prisma.feePolicyVersion.findUnique({ where: { id: historical.id } })
    expect(reread!.nodeOperatorPct?.toString()).toBe('30')
    expect(reread!.treasuryPct?.toString()).toBe('25')
    expect(reread!.walletRebatePct?.toString()).toBe('35')
    expect(reread!.arbitratorReservePct?.toString()).toBe('10')

    const newPolicy = await prisma.feePolicyVersion.create({
      data: {
        label: `new-without-legacy-pcts-${s}`, railScope: `FIXTURE_RAIL_LEGACY_OPTIONAL-${s}`, status: 'PUBLISHED', publishedAt: new Date(),
        protocolFeeRate: '0.004', payerModel: 'SELLER_PAYS', economicBasis: 'SELLER_DELIVERED_VALUE',
        requiredConfirmations: 1, createdBy: 'fase7-2-legacy-readability-test',
      },
    })
    expect(newPolicy.nodeOperatorPct).toBeNull()
  })

  // ─── R18: bootstrap 100%-treasury conservation (real recognition flow) ──
  it('R18: a bootstrap-shaped 100%-treasury policy, frozen via the real recognition flow, allocates exactly F with sum(entitlements) = F', async () => {
    requirePostgres('R18')
    await retireLivePolicyIfAny()
    const treasury = await distributionRecipientRepository.create({ class: `PROTOCOL_TREASURY_FIXTURE_${suffix().toUpperCase().replace(/[^A-Z0-9]/g, '')}`, label: 'fixture-bootstrap-treasury' })
    const draft = await distributionPolicyService.createDraft({ label: `fase7-2-bootstrap-100pct-${suffix()}`, createdBy: 'fase7-2-freeze-test' })
    await distributionPolicyService.addRecipient(draft.id, treasury.id, '100')
    const published = await distributionPolicyService.publish(draft.id)

    const computedFeeBtc = '0.00000777' // 777 sats — deliberately non-round
    const obligationId = await fixtureObligation(computedFeeBtc)
    await broadcastAndConfirm(obligationId, `t18-${suffix()}`.padEnd(64, '0'))

    const evidence = await latestConfirmedEvidence(obligationId)
    expect(evidence!.distributionPolicyVersionId).toBe(published.id)

    const entries = await entitlementAllocationService.allocate(obligationId)
    const decimals = nativeUnitDecimalsFor('BTC')
    const expectedNative = new Prisma.Decimal(computedFeeBtc).times(new Prisma.Decimal(10).pow(decimals))

    expect(entries).toHaveLength(1)
    expect(entries[0].recipientId).toBe(treasury.id)
    expect(new Prisma.Decimal(entries[0].amount).equals(expectedNative)).toBe(true)

    const obligationRow = await prisma.feeObligation.findUnique({ where: { id: obligationId }, include: { feePolicyVersion: { select: { railScope: true } } } })
    const balance = await entitlementLedgerRepository.sumBalance(treasury.id, 'BTC', obligationRow!.feePolicyVersion.railScope)
    expect(balance.equals(expectedNative)).toBe(true)

    await distributionPolicyService.retire(published.id) // never left live outside this test
  })

  // ─── R21/R22: authenticated escrow read exposes frozen historical policy ─
  it('R21/R22: GET-escrow-equivalent (escrowService.getEscrow()) exposes the frozen historical policy for a generation, unaffected by a LATER policy rotation', async () => {
    requirePostgres('R21/R22')
    await retireLivePolicyIfAny()
    const p1 = await publish100PctPolicy()
    const obligationId = await fixtureObligation('0.00001100')
    await broadcastAndConfirm(obligationId, `t21-${suffix()}`.padEnd(64, '0'))

    const obligationRow = await prisma.feeObligation.findUnique({ where: { id: obligationId } })
    const escrowDetail: any = await escrowService.getEscrow(obligationRow!.escrowId)

    expect(escrowDetail.distributionPolicyFreezes).toHaveLength(1)
    expect(escrowDetail.distributionPolicyFreezes[0].distributionPolicyVersionId).toBe(p1)
    expect(escrowDetail.distributionPolicyFreezes[0].distributionPolicy.recipients).toHaveLength(1)
    expect(escrowDetail.distributionPolicyFreezes[0].distributionPolicy.recipients[0].weightPct.toString()).toBe('100')
    // Internal fields must never leak into this response.
    expect(escrowDetail.distributionPolicyFreezes[0].distributionPolicy.createdBy).toBeUndefined()
    expect(escrowDetail.feeObligation).toBeUndefined()

    // R22 — rotate the live policy AFTER this escrow's generation was
    // already confirmed. The historical read must be unaffected.
    await distributionPolicyService.retire(p1)
    await publish100PctPolicy()

    const escrowDetailAfterRotation: any = await escrowService.getEscrow(obligationRow!.escrowId)
    expect(escrowDetailAfterRotation.distributionPolicyFreezes[0].distributionPolicyVersionId).toBe(p1) // unchanged
  })
})
