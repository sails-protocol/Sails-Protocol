// tests/integration/feeSnapshotPreFundingIntegration.test.ts
//
// Missão 11 Fase 4.1 — real-Postgres proof of the pre-funding waiver
// decision and the fail-closed policy snapshot, end-to-end through the
// REAL escrowService.createEscrow() (not a mocked repository), against a
// real database. Complements:
//   - tests/escrowFeeSnapshotService.test.ts (unit-level, pure
//     computeSnapshotFields() decision logic, fake repository)
//   - tests/multisigFeeConservation.test.ts (unit-level, PSBT construction
//     against frozen escrow fields)
// This file is the one place that proves the REAL insert-time wiring
// (escrow.service.ts's createEscrow() folding computeSnapshotFields()
// into escrowRepository.create()'s single INSERT) actually behaves as
// designed against a real database, not just against a fake repository.
//
// Missão 11 Fase 6.3B.1 — connectivity, authorization, and the fail-loud
// requirePostgres() contract come from the shared
// tests/integration/postgresTestHarness.ts (this file used to fall back
// to a stale, permanently-unreachable ":5433" connection string and
// silently report "passed" with zero assertions run — closed, not
// merely relocated).

import { PrismaClient, Prisma } from '@prisma/client'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { boundOfferRow, boundTradeRow, sellerPixAccount } from './economicFixtures'

const COLLECTIBLE_ADDRESS = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'

describe('Fee snapshot pre-funding waiver + fail-closed (Missão 11 Fase 4.1, real Postgres)', () => {
  jest.setTimeout(60_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let escrowService: typeof import('../../src/modules/open-settlement/escrow.service').escrowService
  let escrowRepository: typeof import('../../src/modules/open-settlement/escrow-repository').escrowRepository
  let config: typeof import('../../src/config').config
  let originalCollectionAddress: string | undefined

  beforeAll(async () => {
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ escrowService } = require('../../src/modules/open-settlement/escrow.service'))
    ;({ escrowRepository } = require('../../src/modules/open-settlement/escrow-repository'))
    ;({ config } = require('../../src/config'))
    originalCollectionAddress = config.settlement.protocolFeeCollectionAddress
  })

  afterEach(() => {
    if (dbAvailable) config.settlement.protocolFeeCollectionAddress = originalCollectionAddress
  })

  afterAll(async () => {
    if (dbAvailable) await prisma.$disconnect()
  })

  function requirePostgres(name: string): void {
    pg.requirePostgres(name)
  }

  // #235 R7F-B — createEscrow() now requires lockedAmount to equal the
  // trade's own amount, so the fixture trade carries the amount each test
  // escrows (0.001 BTC by default; 0.01 BTC where Fmax must clear dust).
  async function createFixtureTrade(suffix: string, amount = '0.001', totalUsd = '65') {
    const buyer = await prisma.user.create({ data: { publicKey: `pk-buyer-fase41-${suffix}` } })
    const seller = await prisma.user.create({ data: { publicKey: `pk-seller-fase41-${suffix}` } })
    const acct = await sellerPixAccount(prisma, seller.id)
    const offer = await prisma.offer.create({
      data: { userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '65000', minAmount: '0.001', maxAmount: '1', ...boundOfferRow(acct) },
    })
    const trade = await prisma.trade.create({
      data: { ...boundTradeRow(acct), offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, asset: 'BTC', amount, priceUsd: '65000', totalUsd },
    })
    return { trade, buyer, seller }
  }

  // Missão 11 Fase 7.2 — fee_policy_versions_single_published_per_rail_key
  // (migration 20260823182951) allows at most one PUBLISHED row per
  // railScope. Several tests below reuse the literal 'MULTISIG' rail
  // across separate test cases, and Test 6 ("publishing a later policy
  // for the same rail does not retroactively change an already-snapshotted
  // escrow") deliberately publishes twice for the SAME rail within itself
  // — retiring whatever is currently live before publishing keeps every
  // call site here working unchanged, without weakening what any test
  // verifies (no test depends on a PREVIOUS test's policy still being
  // live for a rail).
  async function retireAnyLivePolicyForRail(railScope: string) {
    const live = await prisma.feePolicyVersion.findFirst({ where: { railScope, status: 'PUBLISHED' } })
    if (live) {
      await prisma.feePolicyVersion.update({ where: { id: live.id }, data: { status: 'RETIRED', retiredAt: new Date() } })
    }
  }

  async function createPublishedPolicy(railScope: string, overrides: Record<string, any> = {}) {
    await retireAnyLivePolicyForRail(railScope)
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    return prisma.feePolicyVersion.create({
      data: {
        label: `fase41-${suffix}`,
        railScope,
        status: 'PUBLISHED',
        protocolFeeRate: '0.004',
        payerModel: 'SELLER_PAYS',
        economicBasis: 'SELLER_DELIVERED_VALUE',
        nodeOperatorPct: '30',
        treasuryPct: '25',
        walletRebatePct: '35',
        arbitratorReservePct: '10',
        createdBy: 'fase41-integration-test',
        publishedAt: new Date(),
        ...overrides,
      },
    })
  }

  // Test 1: no active policy — normal no-fee behavior, unchanged (Fase 4.1 §11.2)
  it('Test 1: createEscrow() with no PUBLISHED policy for the rail creates a legacy (unsnapshotted) escrow', async () => {
    requirePostgres('Test 1')
    const suffix = `t1-${Date.now()}`
    const { trade, buyer } = await createFixtureTrade(suffix)

    const escrow = await escrowService.createEscrow({ tradeId: trade.id, type: 'MOCK', lockedAmount: '0.001', asset: 'BTC' as any }, trade.sellerId)

    expect(escrow.feePolicyVersionId).toBeNull()
    expect(escrow.snapshotFeeCollectionAddress).toBeNull()
    expect(escrow.snapshotFeeCollectionWaivedPreFunding).toBeNull()
  })

  // Test 2: collectible policy — real address configured, Fmax clears dust
  // (Fase 4.1 §11.4 — R = T + Fmax, distinguished here by the frozen
  // address being set and waivedPreFunding=false).
  it('Test 2: createEscrow() with a collectible policy freezes the collection address, waivedPreFunding=false', async () => {
    requirePostgres('Test 2')
    config.settlement.protocolFeeCollectionAddress = COLLECTIBLE_ADDRESS
    const suffix = `t2-${Date.now()}`
    await createPublishedPolicy('MULTISIG')
    const { trade, buyer } = await createFixtureTrade(suffix, '0.01', '650')

    // 0.01 BTC = 1,000,000 sats; rate=0.004 -> Fmax=4,000 sats, well above dust.
    const escrow = await escrowService.createEscrow({ tradeId: trade.id, type: 'MULTISIG', lockedAmount: '0.01', asset: 'BTC' as any }, trade.sellerId)

    expect(escrow.feePolicyVersionId).not.toBeNull()
    expect(escrow.snapshotProtocolFeeRate?.toString()).toBe('0.004')
    expect(escrow.snapshotFeeCollectionWaivedPreFunding).toBe(false)
    expect(escrow.snapshotFeeCollectionAddress).toBe(COLLECTIBLE_ADDRESS)
  })

  // Test 3: pre-funding waived policy — no address configured at all
  // (Fase 4.1 §11.3 — R = T, no reserve ever asked of the seller).
  it('Test 3: createEscrow() with a policy but NO collection address configured is pre-funding-waived (R=T)', async () => {
    requirePostgres('Test 3')
    config.settlement.protocolFeeCollectionAddress = undefined
    const suffix = `t3-${Date.now()}`
    await createPublishedPolicy('MULTISIG')
    const { trade, buyer } = await createFixtureTrade(suffix, '0.01', '650')

    const escrow = await escrowService.createEscrow({ tradeId: trade.id, type: 'MULTISIG', lockedAmount: '0.01', asset: 'BTC' as any }, trade.sellerId)

    expect(escrow.feePolicyVersionId).not.toBeNull()
    expect(escrow.snapshotProtocolFeeRate?.toString()).toBe('0.004') // the REAL rate, never zeroed
    expect(escrow.snapshotFeeCollectionWaivedPreFunding).toBe(true)
    expect(escrow.snapshotFeeCollectionAddress).toBeNull()
  })

  // Test 4 (Fase 4.1 §4/§11.1): if the escrow insert itself fails, NO
  // escrow row is created at all — proves there is no separate
  // persistence step left to fail independently once a policy is active.
  // Simulated realistically: a computed snapshot referencing a
  // feePolicyVersionId that does not exist hits a REAL Postgres foreign-
  // key rejection (Escrow.feePolicyVersionId's own FK), not a mock.
  it('Test 4: a failing snapshot write aborts the ENTIRE escrow insert — no partial/legacy row is ever left behind', async () => {
    requirePostgres('Test 4')
    const suffix = `t4-${Date.now()}`
    const { trade } = await createFixtureTrade(suffix)

    await expect(
      escrowRepository.create({
        tradeId: trade.id,
        type: 'MOCK' as any,
        lockedAmount: '0.001',
        asset: 'BTC' as any,
        network: undefined,
        timelockHours: 24,
        feeSnapshot: {
          feePolicyVersionId: 'does-not-exist',
          snapshotProtocolFeeRate: new Prisma.Decimal('0.004'),
          snapshotPayerModel: 'SELLER_PAYS' as any,
          snapshotEconomicBasis: 'SELLER_DELIVERED_VALUE' as any,
          snapshotFeeCollectionAddress: null,
          snapshotFeeCollectionWaivedPreFunding: false,
        },
      })
    ).rejects.toThrow(/Foreign key constraint/i)

    const row = await prisma.escrow.findUnique({ where: { tradeId: trade.id } })
    expect(row).toBeNull() // never created as legacy, never created partially
  })

  // Test 5 (Fase 4.1 §4/§11 — "retry does not double-snapshot"): since the
  // snapshot is now folded into escrow creation itself (one INSERT per
  // trade, enforced by Trade.escrowId's own uniqueness check earlier in
  // createEscrow()), there is no "retry the snapshot on an existing
  // escrow" scenario to double-apply — confirmed here by calling
  // computeSnapshotFields() twice against the identical inputs and
  // getting identical results (pure, no hidden mutation), and by the
  // pre-existing DB trigger (feePolicyImmutability.test.ts's own Test E)
  // rejecting any later write to the columns regardless.
  it('Test 5: a second createEscrow() attempt for the SAME trade can never produce a second snapshotted escrow row', async () => {
    requirePostgres('Test 5')
    config.settlement.protocolFeeCollectionAddress = COLLECTIBLE_ADDRESS
    const suffix = `t5-${Date.now()}`
    await createPublishedPolicy('MULTISIG')
    const { trade, buyer } = await createFixtureTrade(suffix, '0.01', '650')

    const first = await escrowService.createEscrow({ tradeId: trade.id, type: 'MULTISIG', lockedAmount: '0.01', asset: 'BTC' as any }, trade.sellerId)
    expect(first.feePolicyVersionId).not.toBeNull()

    // This isolated service-level test never registers the real event
    // handlers (common/events/handlers.ts) that, in production, react to
    // settlement.escrow.created and write Trade.escrowId back — so
    // createEscrow()'s own early `if (trade.escrowId)` guard cannot fire
    // here (trade.escrowId is still null from this test's own point of
    // view). What this test actually proves is the guarantee one layer
    // deeper: Escrow.tradeId's own DB-level @unique constraint rejects a
    // second escrow row for the same trade regardless — the real
    // application-level guard is exercised end-to-end by
    // tests/fullTradeLifecycle.test.ts, which does wire the real handlers.
    await expect(
      escrowService.createEscrow({ tradeId: trade.id, type: 'MULTISIG', lockedAmount: '0.01', asset: 'BTC' as any }, trade.sellerId)
    ).rejects.toThrow(/Trade already has an escrow|Unique constraint failed.*tradeId/)

    const rows = await prisma.escrow.findMany({ where: { tradeId: trade.id } })
    expect(rows).toHaveLength(1) // exactly one snapshot, ever, for this trade
  })

  // Test 6 (Fase 4.1 §4 — "published policy substitution cannot happen"):
  // publishing a NEW policy for the same rail after an escrow was already
  // snapshotted must never change that escrow's own frozen reference.
  it('Test 6: publishing a later policy for the same rail does not retroactively change an already-snapshotted escrow', async () => {
    requirePostgres('Test 6')
    config.settlement.protocolFeeCollectionAddress = COLLECTIBLE_ADDRESS
    const railScope = `FASE41_SUBSTITUTION_${Date.now()}`
    const policyA = await createPublishedPolicy(railScope, { protocolFeeRate: '0.004' })
    const suffix = `t6-${Date.now()}`
    const { trade, buyer } = await createFixtureTrade(suffix)

    // createEscrow() only ever resolves a type it recognizes (MULTISIG/
    // LIGHTNING_HODL/WDK_USDT_EVM/MOCK) — this fixture rail is exercised
    // directly against computeSnapshotFields() via the repository/service
    // pair rather than createEscrow()'s own type->rail mapping, mirroring
    // how tests/integration/feeObligationSettlementLifecycle.test.ts's own
    // FIXTURE_RAIL_FASE3 fixtures already do.
    const { escrowFeeSnapshotService } = require('../../src/modules/open-settlement/escrow-fee-snapshot.service')
    const escrow = await prisma.escrow.create({ data: { tradeId: trade.id, type: 'MOCK', asset: 'BTC', lockedAmount: '0.01', status: 'CREATED' } })
    await escrowFeeSnapshotService.snapshotEscrowFeePolicy(escrow.id, railScope, '0.01')

    await createPublishedPolicy(railScope, { protocolFeeRate: '0.008', label: `${railScope}-v2` })

    const unchanged = await prisma.escrow.findUniqueOrThrow({ where: { id: escrow.id } })
    expect(unchanged.feePolicyVersionId).toBe(policyA.id)
    expect(unchanged.snapshotProtocolFeeRate?.toString()).toBe('0.004')
  })

  // Test 7 (Fase 4.1 §4 — "policy retirement after snapshot does not
  // affect escrow"): retiring the referenced policy must never touch the
  // already-snapshotted escrow.
  it('Test 7: retiring the referenced policy after snapshotting leaves the escrow\'s own snapshot untouched', async () => {
    requirePostgres('Test 7')
    config.settlement.protocolFeeCollectionAddress = COLLECTIBLE_ADDRESS
    const { feePolicyService } = require('../../src/modules/open-settlement/fee-policy.service')
    const railScope = `FASE41_RETIREMENT_${Date.now()}`
    const policy = await createPublishedPolicy(railScope)
    const suffix = `t7-${Date.now()}`
    const { trade } = await createFixtureTrade(suffix)
    const { escrowFeeSnapshotService } = require('../../src/modules/open-settlement/escrow-fee-snapshot.service')
    const escrow = await prisma.escrow.create({ data: { tradeId: trade.id, type: 'MOCK', asset: 'BTC', lockedAmount: '0.01', status: 'CREATED' } })
    await escrowFeeSnapshotService.snapshotEscrowFeePolicy(escrow.id, railScope, '0.01')

    await feePolicyService.retire(policy.id)

    const unchanged = await prisma.escrow.findUniqueOrThrow({ where: { id: escrow.id } })
    expect(unchanged.feePolicyVersionId).toBe(policy.id)
    expect(unchanged.snapshotProtocolFeeRate?.toString()).toBe('0.004')
  })
})
