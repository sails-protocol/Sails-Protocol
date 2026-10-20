// tests/integration/feePolicyImmutability.test.ts
//
// Missão 11 Fase 2.2 — real-Postgres proof of the two-layer FeePolicyVersion
// immutability guarantee (Fase 2.1 §1 decision D): (1) the repository's
// narrow surface, (2) a real BEFORE UPDATE trigger. tests/feePolicyService.test.ts
// covers the SERVICE-level structural validation (percentage sums, negative
// values) against a fake repository — this file covers the two things that
// can only be proven against a real database: whether a raw SQL UPDATE is
// actually rejected (mocked Prisma cannot prove this — a mock has no
// trigger), and whether the Escrow fee-snapshot columns get the same
// protection.
//
// Missão 11 Fase 5.3 §B — this file used to fall back to a stale,
// hardcoded ":5433" connection string whenever `DATABASE_URL` wasn't
// already present in `process.env` at module-evaluation time (before
// `src/config`'s own `dotenv/config` import had ever run). Confirmed
// reproducible: run in an isolated process (`npx jest --runInBand
// tests/integration/feePolicyImmutability.test.ts` alone, nothing else in
// the same worker), every single assertion below silently early-returned
// while Jest still reported "8 passed" — a genuine false green, not a
// hypothetical one, even though the real local Postgres (.env's own
// DATABASE_URL, port 5432) was reachable the entire time. Fixed two ways:
// (1) the connection string now comes from `config.database.url` itself
// (the same canonical, dotenv-resolved source Fase 5.2's own
// escrowArbiterCommitmentIntegration.test.ts already established), never
// a second, independently-guessed fallback; (2) unreachable Postgres now
// FAILS the test loudly (requirePostgres() throws) instead of silently
// returning — a test that requires real Postgres must never appear green
// without having actually run.

import { PrismaClient } from '@prisma/client'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { boundOfferRow, boundTradeRow, sellerPixAccount } from './economicFixtures'

describe('FeePolicyVersion / Escrow fee-snapshot immutability (Missão 11 Fase 2.2, real Postgres)', () => {
  jest.setTimeout(60_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient

  beforeAll(async () => {
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
  })

  afterAll(async () => {
    if (dbAvailable) await prisma.$disconnect()
  })

  // Missão 11 Fase 6.3B.1 — delegates to the centralized harness
  // (tests/integration/postgresTestHarness.ts), same call-site shape
  // every existing caller below already uses.
  function requirePostgres(name: string): void {
    pg.requirePostgres(name)
  }

  function fixturePolicyData(overrides: Record<string, any> = {}) {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    return {
      label: `test-fixture-${suffix}`,
      // Missão 11 Fase 7.2 — fee_policy_versions_single_published_per_rail_key
      // (migration 20260823182951) allows at most one PUBLISHED row per
      // railScope. Unique per call — all callers here reference policy.id
      // directly, never a rail lookup (confirmed by grep).
      railScope: `FIXTURE_RAIL_IMMUTABILITY_TEST-${suffix}`,
      protocolFeeRate: '0.004',
      payerModel: 'SELLER_PAYS' as const,
      economicBasis: 'SELLER_DELIVERED_VALUE' as const,
      nodeOperatorPct: '30',
      treasuryPct: '25',
      walletRebatePct: '35',
      arbitratorReservePct: '10',
      requiredConfirmations: 2, // fixture value (Missão 11 Fase 5 §3) — never a chosen production number
      createdBy: 'integration-test-fixture',
      ...overrides,
    }
  }

  // Test A: DRAFT economic fields CAN change (via raw SQL directly, proving
  // the trigger's own OLD.status <> 'DRAFT' condition genuinely gates on
  // status, not on some other property).
  it('Test A: a DRAFT policy\'s economic fields can be changed via raw SQL', async () => {
    requirePostgres('Test A')
    const draft = await prisma.feePolicyVersion.create({ data: fixturePolicyData() })

    await prisma.$executeRawUnsafe(`UPDATE fee_policy_versions SET "protocolFeeRate" = 0.01 WHERE id = $1`, draft.id)
    const updated = await prisma.feePolicyVersion.findUniqueOrThrow({ where: { id: draft.id } })
    // Prisma's Decimal.toString() normalizes trailing zeros away (unlike
    // psql's own NUMERIC(24,8) display) — compare numeric value, not string shape.
    expect(updated.protocolFeeRate.toString()).toBe('0.01')
  })

  // Test B: PUBLISHED economic fields cannot change via the repository (no
  // method exists) — proven at the type/interface level in
  // fee-policy-repository.ts itself (no update() member); reconfirmed here
  // behaviorally: publish() only ever writes status+publishedAt.
  it('Test B: FeePolicyService.publish() never touches economic columns, even though it has full row access', async () => {
    requirePostgres('Test B')
    const { FeePolicyService } = require('../../src/modules/open-settlement/fee-policy.service')
    const { feePolicyVersionRepository } = require('../../src/modules/open-settlement/fee-policy-repository')
    const service = new FeePolicyService(feePolicyVersionRepository)

    const draft = await prisma.feePolicyVersion.create({ data: fixturePolicyData() })
    const rateBefore = draft.protocolFeeRate.toString()

    const published = await service.publish(draft.id)
    expect(published.status).toBe('PUBLISHED')
    expect(published.protocolFeeRate.toString()).toBe(rateBefore)
  })

  // Test C: PUBLISHED economic fields CANNOT change via raw SQL — the core
  // proof the CTO explicitly required against a real database, not mocked
  // Prisma.
  it('Test C: a raw SQL UPDATE touching an economic column on a PUBLISHED policy is rejected by the database trigger', async () => {
    requirePostgres('Test C')
    const draft = await prisma.feePolicyVersion.create({ data: fixturePolicyData() })
    await prisma.feePolicyVersion.update({ where: { id: draft.id }, data: { status: 'PUBLISHED', publishedAt: new Date() } })

    await expect(
      prisma.$executeRawUnsafe(`UPDATE fee_policy_versions SET "protocolFeeRate" = 0.99 WHERE id = $1`, draft.id)
    ).rejects.toThrow(/economic\/identity fields are immutable/)

    const unchanged = await prisma.feePolicyVersion.findUniqueOrThrow({ where: { id: draft.id } })
    expect(unchanged.protocolFeeRate.toString()).toBe(draft.protocolFeeRate.toString())
  })

  // Test D: RETIRED stays exactly as locked as PUBLISHED.
  it('Test D: a raw SQL UPDATE touching an economic column on a RETIRED policy is also rejected', async () => {
    requirePostgres('Test D')
    const draft = await prisma.feePolicyVersion.create({ data: fixturePolicyData() })
    await prisma.feePolicyVersion.update({ where: { id: draft.id }, data: { status: 'PUBLISHED', publishedAt: new Date() } })
    await prisma.feePolicyVersion.update({ where: { id: draft.id }, data: { status: 'RETIRED', retiredAt: new Date() } })

    await expect(
      prisma.$executeRawUnsafe(`UPDATE fee_policy_versions SET "arbitratorReservePct" = 50 WHERE id = $1`, draft.id)
    ).rejects.toThrow(/economic\/identity fields are immutable/)

    // The status/retiredAt transition itself, done via the ORM one line
    // above, DID succeed — proving the trigger discriminates by COLUMN, not
    // by blanket-rejecting every update once status != DRAFT.
    const row = await prisma.feePolicyVersion.findUniqueOrThrow({ where: { id: draft.id } })
    expect(row.status).toBe('RETIRED')
    expect(row.retiredAt).not.toBeNull()
  })

  // Test D2 (Missão 11 Fase 5 §3): requiredConfirmations is protected by
  // the SAME trigger as every other economic/identity column — a
  // confirmation-depth rule cannot be changed out from under an escrow
  // that already snapshotted this policy.
  it('Test D2: a raw SQL UPDATE touching requiredConfirmations on a PUBLISHED policy is rejected', async () => {
    requirePostgres('Test D2')
    const draft = await prisma.feePolicyVersion.create({ data: fixturePolicyData() })
    await prisma.feePolicyVersion.update({ where: { id: draft.id }, data: { status: 'PUBLISHED', publishedAt: new Date() } })

    await expect(
      prisma.$executeRawUnsafe(`UPDATE fee_policy_versions SET "requiredConfirmations" = 99 WHERE id = $1`, draft.id)
    ).rejects.toThrow(/economic\/identity fields are immutable/)

    const unchanged = await prisma.feePolicyVersion.findUniqueOrThrow({ where: { id: draft.id } })
    expect(unchanged.requiredConfirmations).toBe(2)
  })

  // Test E: Escrow's own thin fee-policy scalar snapshot is immutable once set.
  it('Test E: an Escrow\'s fee-policy snapshot cannot change once set, via raw SQL', async () => {
    requirePostgres('Test E')
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const buyer = await prisma.user.create({ data: { publicKey: `pk-buyer-fee-snap-${suffix}` } })
    const seller = await prisma.user.create({ data: { publicKey: `pk-seller-fee-snap-${suffix}` } })
    const offer = await prisma.offer.create({
      data: { userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '65000', minAmount: '0.001', maxAmount: '1', paymentMethod: 'PIX' },
    })
    const trade = await prisma.trade.create({
      data: { offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, asset: 'BTC', amount: '0.01', priceUsd: '65000', totalUsd: '650' },
    })
    const escrow = await prisma.escrow.create({ data: { tradeId: trade.id, type: 'MOCK', asset: 'BTC', lockedAmount: '0.01' } })

    const policy = await prisma.feePolicyVersion.create({
      data: { ...fixturePolicyData(), status: 'PUBLISHED', publishedAt: new Date() },
    })

    await prisma.escrow.update({
      where: { id: escrow.id },
      data: { feePolicyVersionId: policy.id, snapshotProtocolFeeRate: policy.protocolFeeRate, snapshotPayerModel: policy.payerModel, snapshotEconomicBasis: policy.economicBasis },
    })

    // First write succeeded — confirm, then attempt a second write, which must fail.
    const afterFirstWrite = await prisma.escrow.findUniqueOrThrow({ where: { id: escrow.id } })
    expect(afterFirstWrite.snapshotProtocolFeeRate?.toString()).toBe(policy.protocolFeeRate.toString())

    await expect(
      prisma.$executeRawUnsafe(`UPDATE escrows SET "snapshotProtocolFeeRate" = 0.99 WHERE id = $1`, escrow.id)
    ).rejects.toThrow(/fee policy snapshot is immutable/)

    // An unrelated Escrow column (status) must remain freely updatable —
    // the trigger must not lock the whole row, only the four fee-snapshot
    // columns.
    await expect(prisma.escrow.update({ where: { id: escrow.id }, data: { status: 'FUNDS_LOCKED' } })).resolves.toMatchObject({ status: 'FUNDS_LOCKED' })

    const finalRow = await prisma.escrow.findUniqueOrThrow({ where: { id: escrow.id } })
    expect(finalRow.snapshotProtocolFeeRate?.toString()).toBe(policy.protocolFeeRate.toString())
  })

  // Test F (Fase 4.1 §3/§9): the two collection-destination-freeze
  // columns added in this pass are covered by the SAME immutability
  // trigger as the four Fase 2.2 columns above — a live config change
  // after an escrow is snapshotted must never be able to redirect it,
  // and the database itself is the real guarantee, not just application
  // code (multisig.provider.ts always reading the frozen field).
  it('Test F: an Escrow\'s frozen collection destination cannot change once set, via raw SQL (Fase 4.1)', async () => {
    requirePostgres('Test F')
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const buyer = await prisma.user.create({ data: { publicKey: `pk-buyer-fee-dest-${suffix}` } })
    const seller = await prisma.user.create({ data: { publicKey: `pk-seller-fee-dest-${suffix}` } })
    const acct = await sellerPixAccount(prisma, seller.id)
    const offer = await prisma.offer.create({
      data: { userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '65000', minAmount: '0.001', maxAmount: '1', ...boundOfferRow(acct) },
    })
    const trade = await prisma.trade.create({
      data: { ...boundTradeRow(acct), offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, asset: 'BTC', amount: '0.01', priceUsd: '65000', totalUsd: '650' },
    })
    const escrow = await prisma.escrow.create({ data: { tradeId: trade.id, type: 'MULTISIG', asset: 'BTC', lockedAmount: '0.01' } })

    const policy = await prisma.feePolicyVersion.create({
      data: { ...fixturePolicyData(), status: 'PUBLISHED', publishedAt: new Date() },
    })

    await prisma.escrow.update({
      where: { id: escrow.id },
      data: {
        feePolicyVersionId: policy.id,
        snapshotProtocolFeeRate: policy.protocolFeeRate,
        snapshotPayerModel: policy.payerModel,
        snapshotEconomicBasis: policy.economicBasis,
        snapshotFeeCollectionAddress: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
        snapshotFeeCollectionWaivedPreFunding: false,
      },
    })

    const afterFirstWrite = await prisma.escrow.findUniqueOrThrow({ where: { id: escrow.id } })
    expect(afterFirstWrite.snapshotFeeCollectionAddress).toBe('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')

    await expect(
      prisma.$executeRawUnsafe(`UPDATE escrows SET "snapshotFeeCollectionAddress" = 'tb1qattacker-or-later-config-change' WHERE id = $1`, escrow.id)
    ).rejects.toThrow(/fee policy snapshot is immutable/)

    await expect(
      prisma.$executeRawUnsafe(`UPDATE escrows SET "snapshotFeeCollectionWaivedPreFunding" = true WHERE id = $1`, escrow.id)
    ).rejects.toThrow(/fee policy snapshot is immutable/)

    const finalRow = await prisma.escrow.findUniqueOrThrow({ where: { id: escrow.id } })
    expect(finalRow.snapshotFeeCollectionAddress).toBe('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')
    expect(finalRow.snapshotFeeCollectionWaivedPreFunding).toBe(false)
  })

  // Test I (repository/FK level, complementing feePolicyService.test.ts's
  // service-level assertPublished proof): a FeeObligation's FK constraint
  // itself has no opinion on DRAFT vs PUBLISHED — that guard is deliberately
  // application-level (fee-policy.service.ts's assertPublished()), since
  // Prisma's FK cannot express "must reference a row where status=X". This
  // test proves the FK DOES still work as a real referential-integrity
  // guarantee (a nonexistent policy id is rejected by Postgres), which is
  // the part of "must reference a valid, real policy" the database enforces
  // on its own.
  it('Test I (FK layer): a FeeObligation referencing a nonexistent FeePolicyVersion is rejected by Postgres', async () => {
    requirePostgres('Test I (FK layer)')
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const buyer = await prisma.user.create({ data: { publicKey: `pk-buyer-fk-${suffix}` } })
    const seller = await prisma.user.create({ data: { publicKey: `pk-seller-fk-${suffix}` } })
    const offer = await prisma.offer.create({
      data: { userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '65000', minAmount: '0.001', maxAmount: '1', paymentMethod: 'PIX' },
    })
    const trade = await prisma.trade.create({
      data: { offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, asset: 'BTC', amount: '0.01', priceUsd: '65000', totalUsd: '650' },
    })
    const escrow = await prisma.escrow.create({ data: { tradeId: trade.id, type: 'MOCK', asset: 'BTC', lockedAmount: '0.01' } })

    await expect(
      prisma.feeObligation.create({
        data: { escrowId: escrow.id, feePolicyVersionId: 'does-not-exist', economicDetermination: 'OWED', collectionStatus: 'PENDING_COLLECTION', computedFee: '1', basisAmount: '1', asset: 'BTC' },
      })
    ).rejects.toThrow(/Foreign key constraint/i)
  })
})
