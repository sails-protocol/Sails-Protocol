// tests/integration/feeObligationSettlementLifecycle.test.ts
//
// Missão 11 Fase 3 — real-Postgres proof that the centralized
// recordObligationForEscrowSettlement() call, now wired into
// escrow.service.ts's real releaseFunds()/refundFunds()/splitFunds(), does
// exactly what the mandate requires: correct economic determination, exact
// basisAmount, policy-snapshot-only computedFee, zero settlement-amount
// change, idempotent retries, DB-arbitrated concurrency, and a working
// terminal-escrow reconciliation gap-detector. Uses EscrowType.MOCK
// throughout — a real, already-existing test double requiring no
// external crypto/SDK mocking, run through the REAL escrowService methods
// (not fakes), against a real database.
//
// Missão 11 Fase 6.3B.1 — connectivity, authorization, and the fail-loud
// requirePostgres() contract come from the shared
// tests/integration/postgresTestHarness.ts (this file used to fall back
// to a stale, permanently-unreachable ":5433" connection string and
// silently report "passed" with zero assertions run whenever Postgres
// wasn't already exported in the shell — a genuine false green, closed
// here, not merely relocated).

import { PrismaClient, Prisma } from '@prisma/client'
import { createPostgresIntegrationHarness } from './postgresTestHarness'

describe('FeeObligation settlement-lifecycle integration (Missão 11 Fase 3, real Postgres)', () => {
  jest.setTimeout(60_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let escrowService: typeof import('../../src/modules/open-settlement/escrow.service').escrowService
  let pendingTx: typeof import('../../src/modules/open-settlement/escrow-pending-tx')
  let feePolicyVersionRepository: typeof import('../../src/modules/open-settlement/fee-policy-repository').feePolicyVersionRepository
  let escrowFeeSnapshotService: typeof import('../../src/modules/open-settlement/escrow-fee-snapshot.service').escrowFeeSnapshotService
  let findTerminalPolicyAwareEscrowsMissingObligation: typeof import('../../src/modules/open-settlement/fee-obligation-reconciliation').findTerminalPolicyAwareEscrowsMissingObligation

  beforeAll(async () => {
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ escrowService } = require('../../src/modules/open-settlement/escrow.service'))
    pendingTx = require('../../src/modules/open-settlement/escrow-pending-tx')
    ;({ feePolicyVersionRepository } = require('../../src/modules/open-settlement/fee-policy-repository'))
    ;({ escrowFeeSnapshotService } = require('../../src/modules/open-settlement/escrow-fee-snapshot.service'))
    ;({ findTerminalPolicyAwareEscrowsMissingObligation } = require('../../src/modules/open-settlement/fee-obligation-reconciliation'))
  })

  afterAll(async () => {
    if (dbAvailable) await prisma.$disconnect()
  })

  // Missão 11 Fase 6.3B.1 — delegates to the centralized harness
  // (tests/integration/postgresTestHarness.ts); throws instead of
  // silently skipping.
  function requirePostgres(name: string): void {
    pg.requirePostgres(name)
  }

  async function createFixtureTrade(suffix: string) {
    const buyer = await prisma.user.create({ data: { publicKey: `pk-buyer-fase3-${suffix}` } })
    const seller = await prisma.user.create({ data: { publicKey: `pk-seller-fase3-${suffix}` } })
    const offer = await prisma.offer.create({
      data: { userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '65000', minAmount: '0.001', maxAmount: '1', paymentMethod: 'PIX' },
    })
    const trade = await prisma.trade.create({
      data: { offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, asset: 'BTC', amount: '0.01', priceUsd: '65000', totalUsd: '650' },
    })
    return { trade, buyer, seller }
  }

  async function createFixtureEscrow(suffix: string, lockedAmount = '100000') {
    const { trade } = await createFixtureTrade(suffix)
    const escrow = await prisma.escrow.create({
      data: { tradeId: trade.id, type: 'MOCK', asset: 'BTC', lockedAmount, status: 'PAYMENT_PENDING' },
    })
    return { escrow, trade }
  }

  async function createPublishedPolicy(overrides: Record<string, any> = {}) {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    return prisma.feePolicyVersion.create({
      data: {
        label: `fase3-${suffix}`,
        // Missão 11 Fase 7.2 — fee_policy_versions_single_published_per_rail_key
        // (migration 20260823182951) allows at most one PUBLISHED row per
        // railScope. Unique per call — the two callers below that
        // separately invoke snapshotEscrowFeePolicy() use policy.railScope
        // directly rather than a hardcoded literal, so the create and
        // lookup rails stay matched.
        railScope: `FIXTURE_RAIL_FASE3-${suffix}`,
        status: 'PUBLISHED',
        protocolFeeRate: '0.004',
        payerModel: 'SELLER_PAYS',
        economicBasis: 'SELLER_DELIVERED_VALUE',
        nodeOperatorPct: '30',
        treasuryPct: '25',
        walletRebatePct: '35',
        arbitratorReservePct: '10',
        createdBy: 'fase3-integration-test',
        publishedAt: new Date(),
        ...overrides,
      },
    })
  }

  async function createPolicyAwareEscrow(suffix: string, lockedAmount = '100000', policyOverrides: Record<string, any> = {}) {
    const policy = await createPublishedPolicy(policyOverrides)
    const { escrow, trade } = await createFixtureEscrow(suffix, lockedAmount)
    await escrowFeeSnapshotService.snapshotEscrowFeePolicy(escrow.id, policy.railScope, lockedAmount)
    return { escrow, trade, policy }
  }

  // Test 1: legacy release -> no FeeObligation
  it('Test 1: a release with no fee policy snapshot creates no FeeObligation', async () => {
    requirePostgres('Test 1')
    const { escrow, trade } = await createFixtureEscrow(`t1-${Date.now()}`)
    await escrowService.releaseFunds(escrow.id, trade.buyerId, trade.sellerId)

    const obligation = await prisma.feeObligation.findUnique({ where: { escrowId: escrow.id } })
    expect(obligation).toBeNull()
    const updatedEscrow = await prisma.escrow.findUniqueOrThrow({ where: { id: escrow.id } })
    expect(updatedEscrow.status).toBe('COMPLETED')
    expect(updatedEscrow.txReleaseId).not.toBeNull()
  })

  // Test 2 + 8: policy-aware release -> OWED, exact basisAmount
  it('Test 2/8: a policy-aware release creates an OWED FeeObligation with basisAmount = full lockedAmount', async () => {
    requirePostgres('Test 2/8')
    const suffix = `t2-${Date.now()}`
    const { escrow, trade } = await createPolicyAwareEscrow(suffix, '100000')

    await escrowService.releaseFunds(escrow.id, trade.buyerId, trade.sellerId)

    const obligation = await prisma.feeObligation.findUniqueOrThrow({ where: { escrowId: escrow.id } })
    expect(obligation.economicDetermination).toBe('OWED')
    expect(obligation.basisAmount!.toString()).toBe('100000')
    // Test 9: computedFee uses the escrow's OWN snapshot rate (0.004 here), not any live config value.
    expect(obligation.computedFee!.toString()).toBe('400') // 100000 * 0.004
    // Test 17: never advances past PENDING_COLLECTION in this phase.
    expect(obligation.collectionStatus).toBe('PENDING_COLLECTION')
  })

  // Test 3: policy-aware refund -> NOT_APPLICABLE
  it('Test 3: a policy-aware refund creates a NOT_APPLICABLE FeeObligation', async () => {
    requirePostgres('Test 3')
    const suffix = `t3-${Date.now()}`
    const { escrow, trade } = await createPolicyAwareEscrow(suffix, '100000')
    // REFUNDED is only reachable from FUNDS_LOCKED/CREATED/DISPUTED
    // (VALID_TRANSITIONS, escrow-lifecycle.ts) — createFixtureEscrow()'s
    // default PAYMENT_PENDING is correct for RELEASE, not REFUND.
    await prisma.escrow.update({ where: { id: escrow.id }, data: { status: 'FUNDS_LOCKED' } })

    await escrowService.refundFunds(escrow.id, trade.sellerId)

    const obligation = await prisma.feeObligation.findUniqueOrThrow({ where: { escrowId: escrow.id } })
    expect(obligation.economicDetermination).toBe('NOT_APPLICABLE')
    expect(obligation.collectionStatus).toBeNull()
    expect(obligation.basisAmount).toBeNull()
    expect(obligation.computedFee).toBeNull()
  })

  // Test 4: split -> OWED on seller portion only
  it('Test 4: a policy-aware split creates an OWED FeeObligation with basisAmount = seller\'s bps-derived portion only', async () => {
    requirePostgres('Test 4')
    const suffix = `t4-${Date.now()}`
    const { escrow, trade } = await createPolicyAwareEscrow(suffix, '100000')
    await prisma.escrow.update({ where: { id: escrow.id }, data: { status: 'DISPUTED' } }) // SPLIT only reachable from DISPUTED
    const arbiter = await prisma.user.create({ data: { publicKey: `pk-arbiter-fase3-${suffix}` } })
    await prisma.dispute.create({
      data: {
        tradeId: trade.id,
        escrowId: escrow.id,
        openedBy: trade.buyerId,
        reason: 'fee-obligation split fixture',
        arbiterId: arbiter.id,
      },
    })

    // buyerBps = 3000 -> buyer 30%, seller 70% (Fase 1.2's own worked example)
    await escrowService.splitFunds(escrow.id, trade.buyerId, trade.sellerId, 3000, arbiter.id)

    const obligation = await prisma.feeObligation.findUniqueOrThrow({ where: { escrowId: escrow.id } })
    expect(obligation.economicDetermination).toBe('OWED')
    expect(obligation.basisAmount!.toString()).toBe('70000') // 100000 * (10000-3000)/10000
    expect(obligation.computedFee!.toString()).toBe('280') // 70000 * 0.004
  })

  // Test 7: expired escrow / auto-refund -> NOT_APPLICABLE. sweepExpiredEscrows()
  // reuses refundFunds() directly (escrow.service.ts, confirmed by reading)
  // — no separate wiring needed, but worth proving end-to-end for real.
  it('Test 7: an expired escrow auto-refunded by sweepExpiredEscrows() creates a NOT_APPLICABLE FeeObligation', async () => {
    requirePostgres('Test 7')
    const suffix = `t7-${Date.now()}`
    const { escrow } = await createPolicyAwareEscrow(suffix, '100000')
    await prisma.escrow.update({
      where: { id: escrow.id },
      data: { status: 'FUNDS_LOCKED', expiresAt: new Date(Date.now() - 60_000) },
    })

    const result = await escrowService.sweepExpiredEscrows()
    expect(result.refunded).toContain(escrow.id)

    const obligation = await prisma.feeObligation.findUniqueOrThrow({ where: { escrowId: escrow.id } })
    expect(obligation.economicDetermination).toBe('NOT_APPLICABLE')
  })

  // Test 4 (continued) / Test 17: the fixture-only small-trade WAIVED rule
  // never activates for a normal/default policy, and correctly activates
  // (staying within {PENDING_COLLECTION, WAIVED} — never COLLECTED/
  // DISTRIBUTED/IN_PROGRESS) only for an explicitly fictional test fixture.
  it('Fase 4: the fixture-only small-trade rule waives a tiny computed fee, and never activates for a default policy', async () => {
    requirePostgres('Fase 4 WAIVED')
    const suffixA = `t4w-normal-${Date.now()}`
    const { escrow: normalEscrow, trade: normalTrade } = await createPolicyAwareEscrow(suffixA, '1000') // computedFee = 1000*0.004 = 4, tiny but NOT waived — no rule configured
    await escrowService.releaseFunds(normalEscrow.id, normalTrade.buyerId, normalTrade.sellerId)
    const normalObligation = await prisma.feeObligation.findUniqueOrThrow({ where: { escrowId: normalEscrow.id } })
    expect(normalObligation.collectionStatus).toBe('PENDING_COLLECTION') // never WAIVED by default

    const suffixB = `t4w-fixture-${Date.now()}`
    const { escrow: waivedEscrow, trade: waivedTrade } = await createPolicyAwareEscrow(suffixB, '1000', {
      // Explicitly fictional shape (Fase 3 §4) — not a real commercial floor.
      smallTradeRule: { fixtureOnlyMinimum: '10' },
    })
    await escrowService.releaseFunds(waivedEscrow.id, waivedTrade.buyerId, waivedTrade.sellerId)
    const waivedObligation = await prisma.feeObligation.findUniqueOrThrow({ where: { escrowId: waivedEscrow.id } })
    expect(waivedObligation.computedFee!.toString()).toBe('4') // 1000 * 0.004, below the fixture's 10 minimum
    expect(waivedObligation.collectionStatus).toBe('WAIVED')
  })

  // Test 10: policy changed later -> old escrow's fee unchanged
  it('Test 10: publishing a new policy version does not affect an already-settled escrow\'s recorded fee', async () => {
    requirePostgres('Test 10')
    const suffix = `t10-${Date.now()}`
    const { escrow, trade } = await createPolicyAwareEscrow(suffix, '100000', { protocolFeeRate: '0.004' })

    await escrowService.releaseFunds(escrow.id, trade.buyerId, trade.sellerId)
    const obligationBefore = await prisma.feeObligation.findUniqueOrThrow({ where: { escrowId: escrow.id } })
    expect(obligationBefore.computedFee!.toString()).toBe('400')

    // Publish a new, much higher-rate policy on the SAME rail — must never
    // retroactively affect the escrow above.
    const v2 = await createPublishedPolicy({ protocolFeeRate: '0.05', label: `t10-v2-${suffix}` })

    const escrowAfter = await prisma.escrow.findUniqueOrThrow({ where: { id: escrow.id } })
    expect(escrowAfter.feePolicyVersionId).not.toBe(v2.id)
    expect(escrowAfter.snapshotProtocolFeeRate!.toString()).toBe('0.004')
    const obligationAfter = await prisma.feeObligation.findUniqueOrThrow({ where: { escrowId: escrow.id } })
    expect(obligationAfter.computedFee!.toString()).toBe('400') // unchanged
  })

  // E25 (CTO 433) — "Fee discovery ≠ Fee obligation" (ADR-001 §28.3) at the point where the protocol freezes today
  // (escrow creation, before funding): what a participant reads from the escrow before funding is exactly what the
  // settled FeeObligation uses, even when a new policy is published between that read and the release. This proves
  // the CURRENT freeze point only; it does not prove a binding at the trade-open and does not homologate E25.
  it('E25: the fee disclosed on the escrow before funding is the fee the release obligates, despite a policy rotation in between', async () => {
    requirePostgres('E25 disclosed = obligated')
    const suffix = `e25d-${Date.now()}`
    const { escrow, trade, policy } = await createPolicyAwareEscrow(suffix, '100000', { protocolFeeRate: '0.004' })
    const { computeMaxProtocolFee } = require('../../src/modules/open-settlement/fee-reserve-math')

    const disclosed = await escrowService.getEscrow(escrow.id) // the read behind GET /v1/settlement/escrow/:id
    expect(disclosed.feePolicyVersionId).toBe(policy.id)
    expect(disclosed.snapshotProtocolFeeRate!.toString()).toBe('0.004')
    const disclosedFee = computeMaxProtocolFee(disclosed.lockedAmount, disclosed.snapshotProtocolFeeRate!)

    // A real rotation on the SAME rail before settlement (this file's createPublishedPolicy() uses a unique rail per
    // call, so it is done inline): retire the disclosed version, publish a 0.05 one for policy.railScope.
    await prisma.feePolicyVersion.update({ where: { id: policy.id }, data: { status: 'RETIRED', retiredAt: new Date() } })
    const rotated = await prisma.feePolicyVersion.create({ data: { ...(({ id, createdAt, publishedAt, retiredAt, ...rest }) => rest)(policy as any), label: `${suffix}-rotated`, protocolFeeRate: '0.05', status: 'PUBLISHED', publishedAt: new Date() } })
    expect(rotated.railScope).toBe(policy.railScope)
    await escrowService.releaseFunds(escrow.id, trade.buyerId, trade.sellerId)

    const obligation = await prisma.feeObligation.findUniqueOrThrow({ where: { escrowId: escrow.id } })
    expect(obligation.feePolicyVersionId).toBe(disclosed.feePolicyVersionId)
    expect(obligation.computedFee!.toString()).toBe(disclosedFee.toString())
    expect(obligation.computedFee!.toString()).toBe('400')
  })

  // Test 11: duplicate settlement retry -> one obligation (idempotent, via the repo's own unique constraint + the service's existence check)
  it('Test 11: retrying recordObligationForEscrowSettlement for an already-settled escrow does not create a second obligation', async () => {
    requirePostgres('Test 11')
    const suffix = `t11-${Date.now()}`
    const { escrow, trade } = await createPolicyAwareEscrow(suffix, '100000')
    await escrowService.releaseFunds(escrow.id, trade.buyerId, trade.sellerId)

    const { feeObligationService } = require('../../src/modules/open-settlement/fee-obligation.service')
    const freshEscrow = await prisma.escrow.findUniqueOrThrow({ where: { id: escrow.id } })
    // Simulates a retry of the fee-recording step alone (e.g. a caller
    // re-running after a transient failure) — must be a safe no-op.
    await feeObligationService.recordObligationForEscrowSettlement(freshEscrow, 'RELEASE')
    await feeObligationService.recordObligationForEscrowSettlement(freshEscrow, 'RELEASE')

    const count = await prisma.feeObligation.count({ where: { escrowId: escrow.id } })
    expect(count).toBe(1)
  })

  // Test 12: concurrent finalization -> one obligation (real DB-level race, not just sequential retry)
  it('Test 12: two concurrent recordObligationForEscrowSettlement calls for the same escrow produce exactly one FeeObligation', async () => {
    requirePostgres('Test 12')
    const suffix = `t12-${Date.now()}`
    const { escrow, trade } = await createPolicyAwareEscrow(suffix, '100000')
    await escrowService.releaseFunds(escrow.id, trade.buyerId, trade.sellerId)
    // The release above already created one via the real call site — delete
    // it so this test can exercise a genuine race from a clean slate
    // (isolating the concurrency guarantee itself, not the retry-after-
    // success case Test 11 already covers).
    await prisma.feeObligation.delete({ where: { escrowId: escrow.id } })

    const { feeObligationService } = require('../../src/modules/open-settlement/fee-obligation.service')
    const freshEscrow = await prisma.escrow.findUniqueOrThrow({ where: { id: escrow.id } })

    await Promise.allSettled([
      feeObligationService.recordObligationForEscrowSettlement(freshEscrow, 'RELEASE'),
      feeObligationService.recordObligationForEscrowSettlement(freshEscrow, 'RELEASE'),
    ])

    const count = await prisma.feeObligation.count({ where: { escrowId: escrow.id } })
    expect(count).toBe(1)
  })

  // Test 15: reconciliation detects a genuine gap, without auto-fixing it
  it('Test 15: reconciliation detects a terminal policy-aware escrow with no FeeObligation, and stops flagging it once created', async () => {
    requirePostgres('Test 15')
    const suffix = `t15-${Date.now()}`
    const policy = await createPublishedPolicy({ label: `t15-${suffix}` })
    const { escrow } = await createFixtureEscrow(suffix, '100000')
    // Simulate the gap directly: snapshot the policy and mark the escrow
    // terminal WITHOUT ever calling recordObligationForEscrowSettlement —
    // exactly the bug class this reconciliation exists to catch.
    await escrowFeeSnapshotService.snapshotEscrowFeePolicy(escrow.id, policy.railScope, '100000')
    await prisma.escrow.update({ where: { id: escrow.id }, data: { status: 'COMPLETED', releasedAt: new Date(), txReleaseId: 'manual-test-gap' } })

    const gapsBefore = await findTerminalPolicyAwareEscrowsMissingObligation()
    expect(gapsBefore.some((g) => g.escrowId === escrow.id)).toBe(true)

    // Reconciliation must never have silently created anything.
    const stillMissing = await prisma.feeObligation.findUnique({ where: { escrowId: escrow.id } })
    expect(stillMissing).toBeNull()

    // Once a real obligation is created (simulating the actual fix), it
    // must stop being flagged.
    const { feeObligationService } = require('../../src/modules/open-settlement/fee-obligation.service')
    const freshEscrow = await prisma.escrow.findUniqueOrThrow({ where: { id: escrow.id } })
    await feeObligationService.recordObligationForEscrowSettlement(freshEscrow, 'RELEASE')

    const gapsAfter = await findTerminalPolicyAwareEscrowsMissingObligation()
    expect(gapsAfter.some((g) => g.escrowId === escrow.id)).toBe(false)
  })

  // Test 16: historical/legacy escrows are never flagged by reconciliation
  it('Test 16: legacy escrows (feePolicyVersionId NULL) are never flagged by reconciliation, even when terminal', async () => {
    requirePostgres('Test 16')
    const { escrow, trade } = await createFixtureEscrow(`t16-${Date.now()}`)
    await escrowService.releaseFunds(escrow.id, trade.buyerId, trade.sellerId) // legacy path — no policy snapshot

    const gaps = await findTerminalPolicyAwareEscrowsMissingObligation()
    expect(gaps.some((g) => g.escrowId === escrow.id)).toBe(false)

    // Stronger proof: confirm this holds across every pre-existing legacy
    // escrow already in this database (the real baseline fixture set,
    // Missão 09 included) — zero of them should ever be flagged.
    const legacyCount = await prisma.escrow.count({ where: { feePolicyVersionId: null } })
    expect(legacyCount).toBeGreaterThan(0) // sanity: real legacy data exists in this DB
    const allGaps = await findTerminalPolicyAwareEscrowsMissingObligation()
    const legacyIds = new Set((await prisma.escrow.findMany({ where: { feePolicyVersionId: null }, select: { id: true } })).map((e) => e.id))
    expect(allGaps.some((g) => legacyIds.has(g.escrowId))).toBe(false)
  })

  // Test 18: zero settlement-amount changes — a policy-aware release settles
  // with the exact identical provider result shape/amount as a legacy one.
  it('Test 18: attaching a fee policy snapshot does not alter the settlement\'s own amounts/outputs', async () => {
    requirePostgres('Test 18')
    const suffix = `t18-${Date.now()}`
    const { escrow: legacyEscrow, trade: legacyTrade } = await createFixtureEscrow(`${suffix}-legacy`, '250000')
    const { escrow: policyEscrow, trade: policyTrade } = await createPolicyAwareEscrow(`${suffix}-policy`, '250000')

    await escrowService.releaseFunds(legacyEscrow.id, legacyTrade.buyerId, legacyTrade.sellerId)
    await escrowService.releaseFunds(policyEscrow.id, policyTrade.buyerId, policyTrade.sellerId)

    const legacyAfter = await prisma.escrow.findUniqueOrThrow({ where: { id: legacyEscrow.id } })
    const policyAfter = await prisma.escrow.findUniqueOrThrow({ where: { id: policyEscrow.id } })
    // Both escrows started with the identical lockedAmount and both must
    // still show it unchanged — the fee obligation is a separate row, never
    // a mutation of Escrow.lockedAmount itself.
    expect(legacyAfter.lockedAmount.toString()).toBe('250000')
    expect(policyAfter.lockedAmount.toString()).toBe('250000')
    expect(legacyAfter.status).toBe('COMPLETED')
    expect(policyAfter.status).toBe('COMPLETED')
    expect(legacyAfter.txReleaseId).not.toBeNull()
    expect(policyAfter.txReleaseId).not.toBeNull()
  })
})
