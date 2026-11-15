// tests/integration/distributionEntitlementFoundation.test.ts
//
// Missão 11 Fase 6.3A — real-Postgres proof of the Distribution & Entitlement
// Accounting Foundation: DistributionRecipient, DistributionPolicyVersion,
// DistributionPolicyRecipient, EntitlementLedgerEntry, the atomic allocation
// transaction, reorg reversal, reconfirmation/reallocation, deterministic
// balance reconstruction, and the DB-native invariants backing all of it.
//
// Follows the exact "config.database.url, requirePostgres() throws loudly"
// hygiene this suite's own Fase 5.3 closure established — never the stale
// hardcoded-port silent-skip pattern.
//
// NO production percentages, NO 0.40% activation, NO real payout — every
// policy/weight/fee value created below is an explicitly-labeled fixture.

import { PrismaClient, Prisma } from '@prisma/client'
import { createPostgresIntegrationHarness } from './postgresTestHarness'

describe('Distribution & Entitlement Accounting Foundation (Missão 11 Fase 6.3A, real Postgres)', () => {
  jest.setTimeout(60_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let distributionRecipientRepository: typeof import('../../src/modules/open-settlement/distribution-recipient-repository').distributionRecipientRepository
  let distributionPolicyService: typeof import('../../src/modules/open-settlement/distribution-policy.service').distributionPolicyService
  let entitlementAllocationService: typeof import('../../src/modules/open-settlement/entitlement-allocation.service').entitlementAllocationService
  let entitlementLedgerRepository: typeof import('../../src/modules/open-settlement/entitlement-ledger-repository').entitlementLedgerRepository
  let feeCollectionRecognitionService: typeof import('../../src/modules/open-settlement/fee-collection-recognition.service').feeCollectionRecognitionService
  let feeCollectionEvidenceRepository: typeof import('../../src/modules/open-settlement/fee-collection-evidence-repository').feeCollectionEvidenceRepository
  let reconciliation: typeof import('../../src/modules/open-settlement/distribution-reconciliation')

  beforeAll(async () => {
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ distributionRecipientRepository } = require('../../src/modules/open-settlement/distribution-recipient-repository'))
    ;({ distributionPolicyService } = require('../../src/modules/open-settlement/distribution-policy.service'))
    ;({ entitlementAllocationService } = require('../../src/modules/open-settlement/entitlement-allocation.service'))
    ;({ entitlementLedgerRepository } = require('../../src/modules/open-settlement/entitlement-ledger-repository'))
    ;({ feeCollectionRecognitionService } = require('../../src/modules/open-settlement/fee-collection-recognition.service'))
    ;({ feeCollectionEvidenceRepository } = require('../../src/modules/open-settlement/fee-collection-evidence-repository'))
    reconciliation = require('../../src/modules/open-settlement/distribution-reconciliation')
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
    const trade = await prisma.trade.create({ data: { offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, asset: 'BTC', amount: '0.001', priceUsd: '65000', totalUsd: '65' } })
    return { buyer, seller, trade }
  }

  // Missão 11 Fase 7.2 — fee_policy_versions_single_published_per_rail_key
  // (migration 20260823182951) allows at most one PUBLISHED row per
  // railScope. This file's own sumBalance(recipientId, asset, rail) calls
  // filter by the literal 'MULTISIG' rail string (EntitlementLedgerEntry.rail
  // is populated from the policy's own railScope at allocation time) — so
  // railScope must stay the literal 'MULTISIG' here, unlike files where no
  // downstream query depends on the exact string. Retiring whatever is
  // currently live for MULTISIG before publishing a fresh fixture keeps
  // every test isolated without weakening what any of them verify.
  async function retireAnyLiveMultisigFeePolicy() {
    const live = await prisma.feePolicyVersion.findFirst({ where: { railScope: 'MULTISIG', status: 'PUBLISHED' } })
    if (live) {
      await prisma.feePolicyVersion.update({ where: { id: live.id }, data: { status: 'RETIRED', retiredAt: new Date() } })
    }
  }

  async function fixtureFeePolicy() {
    await retireAnyLiveMultisigFeePolicy()
    return prisma.feePolicyVersion.create({
      data: {
        label: `fase6-3a-feepolicy-${suffix()}`, railScope: 'MULTISIG', status: 'PUBLISHED', publishedAt: new Date(),
        protocolFeeRate: '0.004', payerModel: 'SELLER_PAYS', economicBasis: 'SELLER_DELIVERED_VALUE',
        nodeOperatorPct: '30', treasuryPct: '25', walletRebatePct: '35', arbitratorReservePct: '10',
        requiredConfirmations: 1, createdBy: 'fase6-3a-integration-test',
      },
    })
  }

  /** Drives a fresh FeeObligation all the way to COLLECTED via the REAL
   *  FeeCollectionRecognitionService (not a hand-built row) — computedFeeBtc
   *  is a BTC-decimal string (e.g. '0.00000040' for 40 sats), matching
   *  FeeObligation.computedFee's own real representation. */
  async function fixtureCollectedObligation(computedFeeBtc: string): Promise<{ obligationId: string; confirmationEvidenceId: string }> {
    const { trade } = await fixtureTrade()
    const feePolicy = await fixtureFeePolicy()
    const escrow = await prisma.escrow.create({ data: { tradeId: trade.id, type: 'MOCK', asset: 'BTC', lockedAmount: '0.001' } })
    const obligation = await prisma.feeObligation.create({
      data: {
        escrowId: escrow.id, feePolicyVersionId: feePolicy.id, economicDetermination: 'OWED',
        collectionStatus: 'PENDING_COLLECTION', basisAmount: '0.001', computedFee: computedFeeBtc, asset: 'BTC',
      },
    })
    const txid = require('crypto').createHash('sha256').update(obligation.id + suffix()).digest('hex')
    await feeCollectionRecognitionService.recordBroadcastAndAdvance(obligation.id, { txid, vout: 1, scriptPubKey: 'deadbeef', amountSats: 1 })
    await feeCollectionRecognitionService.recognizeConfirmation(obligation.id, txid, 800_000)

    const confirmed = await prisma.feeCollectionEvidence.findFirst({ where: { feeObligationId: obligation.id, kind: 'CONFIRMED' }, orderBy: { recordedAt: 'desc' } })
    return { obligationId: obligation.id, confirmationEvidenceId: confirmed!.id }
  }

  /** Reconfirmation after a reorg: the obligation is already IN_PROGRESS
   *  (recordReorgAndRevert()'s own COLLECTED -> IN_PROGRESS transition), so
   *  recordBroadcastAndAdvance() cannot be reused (it hardcodes the
   *  PENDING_COLLECTION -> IN_PROGRESS edge, the FIRST-ever broadcast only).
   *  A genuine re-broadcast of a REPLACEMENT/retry transaction while already
   *  IN_PROGRESS records a fresh BROADCAST evidence row directly (append-
   *  only, real production code has no narrower "re-broadcast" method
   *  either — recordDropped()/recordReplacement() also don't transition
   *  status), then recognizeConfirmation() proceeds normally since it only
   *  requires IN_PROGRESS, which already holds. */
  async function reconfirm(obligationId: string, txid: string, confirmedAtHeight: number) {
    await feeCollectionEvidenceRepository.record({ feeObligationId: obligationId, kind: 'BROADCAST', txid, vout: 1, scriptPubKey: 'deadbeef', amount: new Prisma.Decimal(1).dividedBy(1e8) })
    await feeCollectionRecognitionService.recognizeConfirmation(obligationId, txid, confirmedAtHeight)
  }

  async function fixtureRecipient(label: string) {
    return distributionRecipientRepository.create({ class: `FIXTURE_${suffix().toUpperCase().replace(/[^A-Z0-9]/g, '')}`, label })
  }

  async function fixturePublishedPolicy(recipients: Array<{ recipientId: string; weightPct: string }>) {
    // Missão 11 Fase 7.2 — distribution_policy_versions_single_published_key
    // (migration 20260823182951) allows at most one PUBLISHED
    // DistributionPolicyVersion globally (it carries no rail/scope column
    // — confirmed a true global singleton by direct schema read).
    // Retiring whatever is currently live before publishing a fresh
    // fixture keeps every test in this file isolated without weakening
    // what any of them verify — no test here depends on a PREVIOUS test's
    // own policy still being live; each reads back its OWN policy/entries
    // by id.
    const live = await distributionPolicyService.findLivePolicy()
    if (live) await distributionPolicyService.retire(live.id)
    const draft = await distributionPolicyService.createDraft({ label: `fixture-policy-${suffix()}`, createdBy: 'fase6-3a-integration-test' })
    for (const r of recipients) {
      await distributionPolicyService.addRecipient(draft.id, r.recipientId, r.weightPct)
    }
    return distributionPolicyService.publish(draft.id)
  }

  // ─── Policy lifecycle ─────────────────────────────────────────────────
  describe('DistributionPolicyVersion lifecycle', () => {
    it('publish() rejects a policy whose weights do not sum to exactly 100', async () => {
      requirePostgres('sum mismatch rejected')
      const r1 = await fixtureRecipient('r1')
      const draft = await distributionPolicyService.createDraft({ label: `bad-sum-${suffix()}`, createdBy: 'test' })
      await distributionPolicyService.addRecipient(draft.id, r1.id, '99')
      await expect(distributionPolicyService.publish(draft.id)).rejects.toThrow(/not exactly 100/)
    })

    it('publish() rejects a zero-weight recipient', async () => {
      requirePostgres('zero weight rejected')
      const r1 = await fixtureRecipient('r1')
      const r2 = await fixtureRecipient('r2')
      const draft = await distributionPolicyService.createDraft({ label: `zero-weight-${suffix()}`, createdBy: 'test' })
      await distributionPolicyService.addRecipient(draft.id, r1.id, '100')
      await distributionPolicyService.addRecipient(draft.id, r2.id, '0')
      await expect(distributionPolicyService.publish(draft.id)).rejects.toThrow(/strictly greater than 0/)
    })

    it('publish() rejects an empty policy (no recipients)', async () => {
      requirePostgres('empty policy rejected')
      const draft = await distributionPolicyService.createDraft({ label: `empty-${suffix()}`, createdBy: 'test' })
      await expect(distributionPolicyService.publish(draft.id)).rejects.toThrow(/no recipients/)
    })

    it('publish() accepts an exact sum-to-100 policy, including a fractional split (33.33/66.67 fixture)', async () => {
      requirePostgres('33.33/66.67 fixture accepted')
      const r1 = await fixtureRecipient('r1')
      const r2 = await fixtureRecipient('r2')
      const policy = await fixturePublishedPolicy([{ recipientId: r1.id, weightPct: '33.33' }, { recipientId: r2.id, weightPct: '66.67' }])
      expect(policy.status).toBe('PUBLISHED')
    })

    it('DB trigger rejects raw SQL mutation of a recipient row once the parent policy is PUBLISHED', async () => {
      requirePostgres('DB-native policy immutability')
      const r1 = await fixtureRecipient('r1')
      const policy = await fixturePublishedPolicy([{ recipientId: r1.id, weightPct: '100' }])
      const row = await prisma.distributionPolicyRecipient.findFirstOrThrow({ where: { policyVersionId: policy.id } })

      await expect(
        prisma.$executeRawUnsafe(`UPDATE distribution_policy_recipients SET "weightPct" = 50 WHERE id = $1`, row.id)
      ).rejects.toThrow(/economic fields are immutable/)

      await expect(
        prisma.$executeRawUnsafe(`DELETE FROM distribution_policy_recipients WHERE id = $1`, row.id)
      ).rejects.toThrow(/cannot delete a recipient row/)

      const r2 = await fixtureRecipient('r2')
      await expect(
        prisma.$executeRawUnsafe(`INSERT INTO distribution_policy_recipients (id, "policyVersionId", "recipientId", "weightPct", "createdAt") VALUES (gen_random_uuid()::text, $1, $2, 10, now())`, policy.id, r2.id)
      ).rejects.toThrow(/cannot add a recipient row/)
    })

    it('a retired policy remains historically queryable and its weights are still immutable', async () => {
      requirePostgres('retired policy queryable + immutable')
      const r1 = await fixtureRecipient('r1')
      const policy = await fixturePublishedPolicy([{ recipientId: r1.id, weightPct: '100' }])
      const retired = await distributionPolicyService.retire(policy.id)
      expect(retired.status).toBe('RETIRED')

      const found = await distributionPolicyService.findLivePolicy()
      // retiring removes it from "live" (findPublished only selects status=PUBLISHED)
      expect(found?.id).not.toBe(policy.id)

      const row = await prisma.distributionPolicyRecipient.findFirstOrThrow({ where: { policyVersionId: policy.id } })
      await expect(
        prisma.$executeRawUnsafe(`UPDATE distribution_policy_recipients SET "weightPct" = 1 WHERE id = $1`, row.id)
      ).rejects.toThrow(/economic fields are immutable/)
    })
  })

  // ─── DistributionRecipient identity ────────────────────────────────────
  describe('DistributionRecipient identity', () => {
    it('at most one singleton (NULL identityKey) row may exist per class', async () => {
      requirePostgres('singleton recipient uniqueness')
      const cls = `SINGLETON_TEST_${suffix().toUpperCase().replace(/[^A-Z0-9]/g, '')}`
      await distributionRecipientRepository.create({ class: cls, label: 'first' })
      await expect(distributionRecipientRepository.create({ class: cls, label: 'second' })).rejects.toThrow()
    })

    it('multiple distinct-identityKey rows of the SAME class are permitted (future multi-instance class readiness)', async () => {
      requirePostgres('multi-instance class readiness')
      const cls = `MULTI_TEST_${suffix().toUpperCase().replace(/[^A-Z0-9]/g, '')}`
      const a = await distributionRecipientRepository.create({ class: cls, identityKey: 'node-a', label: 'Node A' })
      const b = await distributionRecipientRepository.create({ class: cls, identityKey: 'node-b', label: 'Node B' })
      expect(a.id).not.toBe(b.id)
    })
  })

  // ─── Allocation fail-closed ────────────────────────────────────────────
  describe('Allocation fails closed', () => {
    it('allocate() throws when the obligation is not COLLECTED', async () => {
      requirePostgres('non-collected obligation rejected')
      const { trade } = await fixtureTrade()
      const feePolicy = await fixtureFeePolicy()
      const escrow = await prisma.escrow.create({ data: { tradeId: trade.id, type: 'MOCK', asset: 'BTC', lockedAmount: '0.001' } })
      const obligation = await prisma.feeObligation.create({
        data: { escrowId: escrow.id, feePolicyVersionId: feePolicy.id, economicDetermination: 'OWED', collectionStatus: 'PENDING_COLLECTION', basisAmount: '0.001', computedFee: '0.00000040', asset: 'BTC' },
      })
      await expect(entitlementAllocationService.allocate(obligation.id)).rejects.toThrow(/is not COLLECTED/)
    })

    it('allocate() throws when no PUBLISHED DistributionPolicyVersion exists (no implicit Treasury fallback)', async () => {
      requirePostgres('no policy fail-closed')
      // Retire every currently-published policy so this test is genuinely
      // isolated from any policy other tests in this file may have left
      // PUBLISHED.
      const live = await prisma.distributionPolicyVersion.findMany({ where: { status: 'PUBLISHED' } })
      for (const p of live) await distributionPolicyService.retire(p.id)

      // Missão 11 Fase 7.2 — the "no policy" determination now happens at
      // COLLECTED time (recognizeConfirmation() freezes a null reference
      // when zero policy is PUBLISHED), not at allocate() time — the
      // error message changed accordingly; the underlying fail-closed
      // behavior (no implicit Treasury fallback) is unchanged.
      const { obligationId } = await fixtureCollectedObligation('0.00000040')
      await expect(entitlementAllocationService.allocate(obligationId)).rejects.toThrow(/no frozen distribution policy/)
    })
  })

  // ─── 100% SAILS_PROTOCOL fixture — no fractional complexity ────────────
  describe('100% single-recipient policy (bootstrap direction, NOT activated in production)', () => {
    it('C=1, 41, and 40000 sats each allocate exactly, whole, to the single recipient', async () => {
      requirePostgres('100% single-recipient fixture')
      const treasury = await fixtureRecipient('Treasury-fixture')
      await fixturePublishedPolicy([{ recipientId: treasury.id, weightPct: '100' }])

      for (const [btc, expectedSats] of [['0.00000001', '1'], ['0.00000041', '41'], ['0.00040000', '40000']] as const) {
        const { obligationId } = await fixtureCollectedObligation(btc)
        const entries = await entitlementAllocationService.allocate(obligationId)
        expect(entries).toHaveLength(1)
        expect(entries[0].recipientId).toBe(treasury.id)
        expect(new Prisma.Decimal(entries[0].amount).toString()).toBe(expectedSats)
      }
    })
  })

  // ─── 90/10 fractional fixture — proves no rounding extraction ─────────
  describe('90/10 fixture — fractional entitlement, no rounding extraction (illustrative only, NOT production)', () => {
    it('1, 2, 3, 41, 101 sats each split exactly with fractional Node amounts, sum always exact', async () => {
      requirePostgres('90/10 fractional split')
      const treasury = await fixtureRecipient('Treasury-9010')
      const node = await fixtureRecipient('Node-9010')
      await fixturePublishedPolicy([{ recipientId: treasury.id, weightPct: '90' }, { recipientId: node.id, weightPct: '10' }])

      const cases: Array<[string, string, string]> = [
        ['0.00000001', '0.9', '0.1'],
        ['0.00000002', '1.8', '0.2'],
        ['0.00000003', '2.7', '0.3'],
        ['0.00000041', '36.9', '4.1'],
        ['0.00000101', '90.9', '10.1'],
      ]
      let nodeRunningTotal = new Prisma.Decimal(0)
      for (const [btc, expectedTreasury, expectedNode] of cases) {
        const { obligationId } = await fixtureCollectedObligation(btc)
        const entries = await entitlementAllocationService.allocate(obligationId)
        const treasuryEntry = entries.find((e) => e.recipientId === treasury.id)!
        const nodeEntry = entries.find((e) => e.recipientId === node.id)!
        expect(new Prisma.Decimal(treasuryEntry.amount).toString()).toBe(expectedTreasury)
        expect(new Prisma.Decimal(nodeEntry.amount).toString()).toBe(expectedNode)
        // Exact conservation: sum of this generation's entries == collected amount.
        const sum = entries.reduce((acc, e) => acc.plus(e.amount), new Prisma.Decimal(0))
        const cSats = new Prisma.Decimal(btc).times(1e8)
        expect(sum.toString()).toBe(cSats.toString())
        nodeRunningTotal = nodeRunningTotal.plus(nodeEntry.amount)
      }
      // Fractional accumulation across obligations — the mandate's own
      // 14.8-sat example, proven via a real balance query, never rounded,
      // never absorbed by Treasury.
      expect(nodeRunningTotal.toString()).toBe('14.8')
      const balance = await entitlementLedgerRepository.sumBalance(node.id, 'BTC', 'MULTISIG')
      expect(balance.toString()).toBe('14.8')
    })

    it('no rounding extraction: Treasury never receives Node\'s fractional remainder', async () => {
      requirePostgres('no rounding extraction')
      const treasury = await fixtureRecipient('Treasury-noext')
      const node = await fixtureRecipient('Node-noext')
      await fixturePublishedPolicy([{ recipientId: treasury.id, weightPct: '90' }, { recipientId: node.id, weightPct: '10' }])

      const { obligationId } = await fixtureCollectedObligation('0.00000001') // 1 sat
      const entries = await entitlementAllocationService.allocate(obligationId)
      const treasuryEntry = entries.find((e) => e.recipientId === treasury.id)!
      // 90% of 1 sat is exactly 0.9 — NOT rounded up to 1 by absorbing Node's 0.1.
      expect(new Prisma.Decimal(treasuryEntry.amount).toString()).toBe('0.9')
    })
  })

  // ─── Large values / Decimal precision boundary ─────────────────────────
  describe('Large values — Decimal(48,8) precision boundary', () => {
    it('a fee near the real Bitcoin supply cap (2,100,000,000,000,000 sats = 21,000,000 BTC) allocates and conserves exactly', async () => {
      requirePostgres('large value precision')
      const treasury = await fixtureRecipient('Treasury-large')
      const node = await fixtureRecipient('Node-large')
      await fixturePublishedPolicy([{ recipientId: treasury.id, weightPct: '90' }, { recipientId: node.id, weightPct: '10' }])

      // 21,000,000 BTC in decimal — far larger than any real single trade's
      // fee, chosen specifically to exercise Decimal(48,8)'s 40 integer
      // digits against the entire real Bitcoin supply as a bound, per
      // Missão 11 Fase 6.3A §A's own precision proof.
      const { obligationId } = await fixtureCollectedObligation('21000000.00000000')
      const entries = await entitlementAllocationService.allocate(obligationId)
      const sum = entries.reduce((acc, e) => acc.plus(e.amount), new Prisma.Decimal(0))
      expect(sum.toString()).toBe('2100000000000000') // exactly 21,000,000 * 1e8, no overflow, no truncation
      const treasuryEntry = entries.find((e) => e.recipientId === treasury.id)!
      const nodeEntry = entries.find((e) => e.recipientId === node.id)!
      expect(new Prisma.Decimal(treasuryEntry.amount).toString()).toBe('1890000000000000')
      expect(new Prisma.Decimal(nodeEntry.amount).toString()).toBe('210000000000000')
    })
  })

  // ─── Idempotency / concurrency ──────────────────────────────────────────
  describe('Idempotency and concurrency', () => {
    it('retrying allocate() for the same obligation fails cleanly (double-allocation refused)', async () => {
      requirePostgres('retry allocation refused')
      const treasury = await fixtureRecipient('Treasury-retry')
      await fixturePublishedPolicy([{ recipientId: treasury.id, weightPct: '100' }])
      const { obligationId } = await fixtureCollectedObligation('0.00000041')

      await entitlementAllocationService.allocate(obligationId)
      await expect(entitlementAllocationService.allocate(obligationId)).rejects.toThrow(/already been allocated/)
    })

    it('two concurrent allocate() calls for the same obligation: exactly one succeeds, no double allocation', async () => {
      requirePostgres('concurrent allocation')
      const treasury = await fixtureRecipient('Treasury-concurrent')
      await fixturePublishedPolicy([{ recipientId: treasury.id, weightPct: '100' }])
      const { obligationId } = await fixtureCollectedObligation('0.00000041')

      const results = await Promise.allSettled([
        entitlementAllocationService.allocate(obligationId),
        entitlementAllocationService.allocate(obligationId),
      ])
      const fulfilled = results.filter((r) => r.status === 'fulfilled')
      const rejected = results.filter((r) => r.status === 'rejected')
      expect(fulfilled).toHaveLength(1)
      expect(rejected).toHaveLength(1)

      const balance = await entitlementLedgerRepository.sumBalance(treasury.id, 'BTC', 'MULTISIG')
      expect(balance.toString()).toBe('41')
    })

    it('retrying reverseEntry() for the same entry fails cleanly (double-reversal refused)', async () => {
      requirePostgres('retry reversal refused')
      const treasury = await fixtureRecipient('Treasury-retry-rev')
      await fixturePublishedPolicy([{ recipientId: treasury.id, weightPct: '100' }])
      const { obligationId } = await fixtureCollectedObligation('0.00000041')
      const [entry] = await entitlementAllocationService.allocate(obligationId)

      await entitlementAllocationService.reverseEntry(entry.id)
      await expect(entitlementAllocationService.reverseEntry(entry.id)).rejects.toThrow(/already been reversed/)
    })

    it('two concurrent reverseEntry() calls for the same entry: exactly one succeeds', async () => {
      requirePostgres('concurrent reversal')
      const treasury = await fixtureRecipient('Treasury-concurrent-rev')
      await fixturePublishedPolicy([{ recipientId: treasury.id, weightPct: '100' }])
      const { obligationId } = await fixtureCollectedObligation('0.00000041')
      const [entry] = await entitlementAllocationService.allocate(obligationId)

      const results = await Promise.allSettled([
        entitlementAllocationService.reverseEntry(entry.id),
        entitlementAllocationService.reverseEntry(entry.id),
      ])
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)

      const balance = await entitlementLedgerRepository.sumBalance(treasury.id, 'BTC', 'MULTISIG')
      expect(balance.toString()).toBe('0')
    })
  })

  // ─── Reorg reversal ──────────────────────────────────────────────────────
  describe('Reorg reversal', () => {
    it('reverseGeneration() offsets every entry in a generation to exactly net zero, original entries untouched', async () => {
      requirePostgres('reorg reversal nets to zero')
      const treasury = await fixtureRecipient('Treasury-reorg')
      const node = await fixtureRecipient('Node-reorg')
      const policy = await fixturePublishedPolicy([{ recipientId: treasury.id, weightPct: '90' }, { recipientId: node.id, weightPct: '10' }])
      const { obligationId, confirmationEvidenceId } = await fixtureCollectedObligation('0.00000101') // 101 sats

      const allocations = await entitlementAllocationService.allocate(obligationId)
      await entitlementAllocationService.reverseGeneration(confirmationEvidenceId)

      const allEntries = await entitlementLedgerRepository.listForGeneration(confirmationEvidenceId)
      expect(allEntries).toHaveLength(4) // 2 ALLOCATION + 2 REVERSAL
      const net = allEntries.reduce((acc, e) => acc.plus(e.amount), new Prisma.Decimal(0))
      expect(net.toString()).toBe('0')

      // Original allocation entries remain, exactly as written, forever.
      for (const original of allocations) {
        const stillThere = await entitlementLedgerRepository.findById(original.id)
        expect(stillThere).not.toBeNull()
        expect(stillThere!.amount.toString()).toBe(new Prisma.Decimal(original.amount).toString())
        expect(stillThere!.distributionPolicyVersionId).toBe(policy.id)
      }
    })

    it('DB trigger enforces append-only: no UPDATE or DELETE ever succeeds on entitlement_ledger_entries', async () => {
      requirePostgres('DB-native append-only ledger')
      const treasury = await fixtureRecipient('Treasury-appendonly')
      await fixturePublishedPolicy([{ recipientId: treasury.id, weightPct: '100' }])
      const { obligationId } = await fixtureCollectedObligation('0.00000041')
      const [entry] = await entitlementAllocationService.allocate(obligationId)

      await expect(
        prisma.$executeRawUnsafe(`UPDATE entitlement_ledger_entries SET amount = 999 WHERE id = $1`, entry.id)
      ).rejects.toThrow(/append-only — rows may never be updated/)

      await expect(
        prisma.$executeRawUnsafe(`DELETE FROM entitlement_ledger_entries WHERE id = $1`, entry.id)
      ).rejects.toThrow(/append-only — rows may never be deleted/)
    })

    it('DB trigger rejects an ALLOCATION row against non-CONFIRMED evidence (BROADCAST kind)', async () => {
      requirePostgres('DB-native confirmed-evidence guard')
      const { trade } = await fixtureTrade()
      const feePolicy = await fixtureFeePolicy()
      const escrow = await prisma.escrow.create({ data: { tradeId: trade.id, type: 'MOCK', asset: 'BTC', lockedAmount: '0.001' } })
      const obligation = await prisma.feeObligation.create({
        data: { escrowId: escrow.id, feePolicyVersionId: feePolicy.id, economicDetermination: 'OWED', collectionStatus: 'PENDING_COLLECTION', basisAmount: '0.001', computedFee: '0.00000041', asset: 'BTC' },
      })
      const txid = require('crypto').createHash('sha256').update(obligation.id).digest('hex')
      await feeCollectionRecognitionService.recordBroadcastAndAdvance(obligation.id, { txid, vout: 1, scriptPubKey: 'deadbeef', amountSats: 1 })
      const broadcastEvidence = await prisma.feeCollectionEvidence.findFirstOrThrow({ where: { feeObligationId: obligation.id, kind: 'BROADCAST' } })

      const treasury = await fixtureRecipient('Treasury-wrongkind')
      const policy = await fixturePublishedPolicy([{ recipientId: treasury.id, weightPct: '100' }])

      await expect(
        prisma.entitlementLedgerEntry.create({
          data: { feeObligationId: obligation.id, confirmationEvidenceId: broadcastEvidence.id, distributionPolicyVersionId: policy.id, recipientId: treasury.id, asset: 'BTC', rail: 'MULTISIG', kind: 'ALLOCATION', amount: '41' },
        })
      ).rejects.toThrow(/must reference a CONFIRMED FeeCollectionEvidence row/)
    })

    it('DB trigger rejects an entry whose confirmationEvidenceId belongs to a DIFFERENT feeObligationId', async () => {
      requirePostgres('DB-native wrong-obligation-pairing guard')
      const { confirmationEvidenceId } = await fixtureCollectedObligation('0.00000041')
      const { obligationId: otherObligationId } = await fixtureCollectedObligation('0.00000101')
      const treasury = await fixtureRecipient('Treasury-wrongobligation')
      const policy = await fixturePublishedPolicy([{ recipientId: treasury.id, weightPct: '100' }])

      await expect(
        prisma.entitlementLedgerEntry.create({
          data: { feeObligationId: otherObligationId, confirmationEvidenceId, distributionPolicyVersionId: policy.id, recipientId: treasury.id, asset: 'BTC', rail: 'MULTISIG', kind: 'ALLOCATION', amount: '41' },
        })
      ).rejects.toThrow(/refusing a wrong obligation\/evidence pairing/)
    })

    it('DB CHECK constraint rejects sign mismatch (ALLOCATION with negative amount)', async () => {
      requirePostgres('DB-native sign check')
      const { obligationId, confirmationEvidenceId } = await fixtureCollectedObligation('0.00000041')
      const treasury = await fixtureRecipient('Treasury-signcheck')
      const policy = await fixturePublishedPolicy([{ recipientId: treasury.id, weightPct: '100' }])

      await expect(
        prisma.entitlementLedgerEntry.create({
          data: { feeObligationId: obligationId, confirmationEvidenceId, distributionPolicyVersionId: policy.id, recipientId: treasury.id, asset: 'BTC', rail: 'MULTISIG', kind: 'ALLOCATION', amount: '-41' },
        })
      ).rejects.toThrow()
    })
  })

  // ─── Reconfirmation / new generation (the T1-T6 proof) ─────────────────
  describe('Reconfirmation creates a new generation without duplicating revenue (Phase 6.2.1 T1-T6 proof)', () => {
    it('reconfirmation under the SAME policy: A1+R1=0, A2=C, both generations independently queryable', async () => {
      requirePostgres('reconfirmation same policy')
      const treasury = await fixtureRecipient('Treasury-reconfirm-same')
      const policy = await fixturePublishedPolicy([{ recipientId: treasury.id, weightPct: '100' }])
      const { obligationId } = await fixtureCollectedObligation('0.00000041')

      // T1-T2: first confirmation + allocation.
      const evidence1 = await prisma.feeCollectionEvidence.findFirstOrThrow({ where: { feeObligationId: obligationId, kind: 'CONFIRMED' } })
      const [a1] = await entitlementAllocationService.allocate(obligationId)
      expect(a1.amount).toBe('41')

      // T3: reorg — reverts collectionStatus and reverses the generation.
      const [confirmed] = await prisma.feeCollectionEvidence.findMany({ where: { feeObligationId: obligationId, kind: 'CONFIRMED' } })
      await feeCollectionRecognitionService.recordReorgAndRevert(obligationId, confirmed.txid!)
      const [r1] = await entitlementAllocationService.reverseGeneration(evidence1.id)
      expect(r1.amount).toBe('-41')

      // T5-T6: reconfirmation (a NEW CONFIRMED evidence row) + a fresh allocation, SAME policy.
      const newTxid = require('crypto').createHash('sha256').update(obligationId + 'reconfirm').digest('hex')
      await reconfirm(obligationId, newTxid, 800_100)
      const evidence2 = await prisma.feeCollectionEvidence.findFirstOrThrow({ where: { feeObligationId: obligationId, kind: 'CONFIRMED', txid: newTxid } })
      expect(evidence2.id).not.toBe(evidence1.id) // a genuinely NEW generation identity

      const [a2] = await entitlementAllocationService.allocate(obligationId)
      expect(a2.amount).toBe('41')

      // Net economic revenue recognized: exactly C (41), never 2C (82).
      const balance = await entitlementLedgerRepository.sumBalance(treasury.id, 'BTC', 'MULTISIG')
      expect(balance.toString()).toBe('41')

      // Historical query still shows BOTH generations, each correctly tied to its own evidence row.
      const allEntries = await entitlementLedgerRepository.listForObligation(obligationId)
      const gen1Entries = allEntries.filter((e) => e.confirmationEvidenceId === evidence1.id)
      const gen2Entries = allEntries.filter((e) => e.confirmationEvidenceId === evidence2.id)
      expect(gen1Entries.map((e) => e.kind).sort()).toEqual(['ALLOCATION', 'REVERSAL'])
      expect(gen2Entries.map((e) => e.kind)).toEqual(['ALLOCATION'])
      expect(new Set(allEntries.map((e) => e.distributionPolicyVersionId))).toEqual(new Set([policy.id])) // same policy both times
    })

    it('reconfirmation under a NEWER policy: first generation stays frozen to V1, second generation freezes to V2, V1 never overwritten', async () => {
      requirePostgres('reconfirmation newer policy — full T1-T6 proof')
      const treasuryV1 = await fixtureRecipient('Treasury-v1')
      const v1 = await fixturePublishedPolicy([{ recipientId: treasuryV1.id, weightPct: '100' }])
      const { obligationId } = await fixtureCollectedObligation('0.00000041')

      // T1-T2: allocate under V1.
      const evidence1 = await prisma.feeCollectionEvidence.findFirstOrThrow({ where: { feeObligationId: obligationId, kind: 'CONFIRMED' } })
      const [a1] = await entitlementAllocationService.allocate(obligationId)
      expect(a1.amount).toBe('41')

      // T3: reorg + reversal.
      const [confirmed] = await prisma.feeCollectionEvidence.findMany({ where: { feeObligationId: obligationId, kind: 'CONFIRMED' } })
      await feeCollectionRecognitionService.recordReorgAndRevert(obligationId, confirmed.txid!)
      await entitlementAllocationService.reverseGeneration(evidence1.id)

      // T4: V1 retires, V2 publishes.
      await distributionPolicyService.retire(v1.id)
      const treasuryV2 = await fixtureRecipient('Treasury-v2')
      const v2 = await fixturePublishedPolicy([{ recipientId: treasuryV2.id, weightPct: '100' }])

      // T5-T6: reconfirm + allocate under V2.
      const newTxid = require('crypto').createHash('sha256').update(obligationId + 'v2').digest('hex')
      await reconfirm(obligationId, newTxid, 800_200)
      const evidence2 = await prisma.feeCollectionEvidence.findFirstOrThrow({ where: { feeObligationId: obligationId, kind: 'CONFIRMED', txid: newTxid } })
      const [a2] = await entitlementAllocationService.allocate(obligationId)
      expect(a2.recipientId).toBe(treasuryV2.id)

      // Never overwrite V1 with V2: gen1's allocation still references V1.
      const allEntries = await entitlementLedgerRepository.listForObligation(obligationId)
      const gen1Allocation = allEntries.find((e) => e.confirmationEvidenceId === evidence1.id && e.kind === 'ALLOCATION')!
      const gen2Allocation = allEntries.find((e) => e.confirmationEvidenceId === evidence2.id && e.kind === 'ALLOCATION')!
      expect(gen1Allocation.distributionPolicyVersionId).toBe(v1.id)
      expect(gen2Allocation.distributionPolicyVersionId).toBe(v2.id)
      expect(gen1Allocation.recipientId).toBe(treasuryV1.id)
      expect(gen2Allocation.recipientId).toBe(treasuryV2.id)

      // Net revenue exactly C, split correctly: V1's treasury nets zero (reversed), V2's treasury holds C.
      const balanceV1 = await entitlementLedgerRepository.sumBalance(treasuryV1.id, 'BTC', 'MULTISIG')
      const balanceV2 = await entitlementLedgerRepository.sumBalance(treasuryV2.id, 'BTC', 'MULTISIG')
      expect(balanceV1.toString()).toBe('0')
      expect(balanceV2.toString()).toBe('41')
    })

    it('multiple reorg/reconfirm cycles (3x) still net to exactly one C, never duplicated', async () => {
      requirePostgres('multiple reorg cycles')
      const treasury = await fixtureRecipient('Treasury-multicycle')
      await fixturePublishedPolicy([{ recipientId: treasury.id, weightPct: '100' }])
      const { obligationId } = await fixtureCollectedObligation('0.00000101')

      for (let cycle = 0; cycle < 3; cycle++) {
        const evidence = await prisma.feeCollectionEvidence.findFirstOrThrow({ where: { feeObligationId: obligationId, kind: 'CONFIRMED' }, orderBy: { recordedAt: 'desc' } })
        await entitlementAllocationService.allocate(obligationId)
        const confirmedRow = await prisma.feeCollectionEvidence.findUniqueOrThrow({ where: { id: evidence.id } })
        await feeCollectionRecognitionService.recordReorgAndRevert(obligationId, confirmedRow.txid!)
        await entitlementAllocationService.reverseGeneration(evidence.id)

        const newTxid = require('crypto').createHash('sha256').update(`${obligationId}-cycle-${cycle}`).digest('hex')
        await reconfirm(obligationId, newTxid, 800_300 + cycle)
      }
      // Final confirmation (4th, never reorged) gets a real, lasting allocation.
      await entitlementAllocationService.allocate(obligationId)

      const balance = await entitlementLedgerRepository.sumBalance(treasury.id, 'BTC', 'MULTISIG')
      expect(balance.toString()).toBe('101') // exactly C, never 4x, never 0
    })

    // CTO 252-P P3: G9/G10 is keyed on the generation, so nothing stopped a second generation being allocated
    // while the first was still allocated (reorg recorded, reversal not yet run): the same revenue entitled twice.
    it('allocate() refuses a new generation while an earlier one is still allocated; succeeds once it is reversed', async () => {
      requirePostgres('no second live generation')
      const treasury = await fixtureRecipient('Treasury-live-gen')
      await fixturePublishedPolicy([{ recipientId: treasury.id, weightPct: '100' }])
      const { obligationId, confirmationEvidenceId } = await fixtureCollectedObligation('0.00000041')
      await entitlementAllocationService.allocate(obligationId)

      const [confirmed] = await prisma.feeCollectionEvidence.findMany({ where: { feeObligationId: obligationId, kind: 'CONFIRMED' } })
      await feeCollectionRecognitionService.recordReorgAndRevert(obligationId, confirmed.txid!)
      await reconfirm(obligationId, require('crypto').createHash('sha256').update(obligationId + 'live-gen').digest('hex'), 800_400)

      await expect(entitlementAllocationService.allocate(obligationId)).rejects.toThrow(/still allocated/)
      expect((await entitlementLedgerRepository.sumBalance(treasury.id, 'BTC', 'MULTISIG')).toString()).toBe('41')

      await entitlementAllocationService.reverseGeneration(confirmationEvidenceId)
      await entitlementAllocationService.allocate(obligationId)
      expect((await entitlementLedgerRepository.sumBalance(treasury.id, 'BTC', 'MULTISIG')).toString()).toBe('41')
    })

    // CTO 254: the guard must not depend on WHICH confirmation row the reader picks. A second CONFIRMED row of the
    // same obligation that becomes "latest" (an ordering change such as #652's on a historical recordedAt tie, with
    // no reorg in between) must not make already-allocated revenue eligible again.
    it('a second CONFIRMED row that becomes latest does not re-open allocation (order-independent)', async () => {
      requirePostgres('order-independent single allocation')
      const treasury = await fixtureRecipient('Treasury-order-indep')
      await fixturePublishedPolicy([{ recipientId: treasury.id, weightPct: '100' }])
      const { obligationId, confirmationEvidenceId } = await fixtureCollectedObligation('0.00000041')
      await entitlementAllocationService.allocate(obligationId)

      const first = await prisma.feeCollectionEvidence.findUniqueOrThrow({ where: { id: confirmationEvidenceId } })
      const { id: _id, recordedAt, ...copy } = first
      await prisma.feeCollectionEvidence.create({ data: { ...copy, recordedAt: new Date(recordedAt.getTime() + 1000) } as any })

      await expect(entitlementAllocationService.allocate(obligationId)).rejects.toThrow(/still allocated/)
      await expect(entitlementAllocationService.allocate(obligationId)).rejects.toThrow(/still allocated/) // a retry is refused the same way
      expect((await entitlementLedgerRepository.sumBalance(treasury.id, 'BTC', 'MULTISIG')).toString()).toBe('41')
    })

    // The check above only holds if no collection-status change commits while allocate() runs: allocate() must
    // hold the obligation row (FOR NO KEY UPDATE, the lock the status UPDATE itself takes).
    it('allocate() waits for a concurrent holder of the obligation row before reading it', async () => {
      requirePostgres('allocate serializes on the obligation row')
      const treasury = await fixtureRecipient('Treasury-row-lock')
      await fixturePublishedPolicy([{ recipientId: treasury.id, weightPct: '100' }])
      const { obligationId } = await fixtureCollectedObligation('0.00000041')
      const { Client } = require('pg')
      const holder = new Client({ connectionString: process.env.DATABASE_URL })
      await holder.connect()
      try {
        await holder.query('BEGIN')
        await holder.query('SELECT 1 FROM fee_obligations WHERE id = $1 FOR NO KEY UPDATE', [obligationId])
        const pending = entitlementAllocationService.allocate(obligationId).then(() => 'allocated', (e: Error) => e.message)
        let waiting = false
        for (let i = 0; i < 60 && !waiting; i++) {
          const { rows } = await holder.query(
            'SELECT count(*)::int AS n FROM pg_stat_activity WHERE pg_backend_pid() = ANY (pg_blocking_pids(pid))')
          waiting = rows[0].n > 0
          if (!waiting) await new Promise((r) => setTimeout(r, 50))
        }
        // Undo the status as the reorg path would, then release: allocate() must see it and refuse.
        await holder.query(`UPDATE fee_obligations SET "collectionStatus" = 'IN_PROGRESS' WHERE id = $1`, [obligationId])
        await holder.query('COMMIT')
        expect(waiting).toBe(true)
        expect(await pending).toMatch(/is not COLLECTED/)
      } finally {
        await holder.end()
      }
    })
  })

  // ─── Reconciliation ──────────────────────────────────────────────────────
  describe('Reconciliation — detect, never fix', () => {
    it('findGenerationSumMismatches() reports nothing for a healthy foundation', async () => {
      requirePostgres('reconciliation clean baseline')
      const treasury = await fixtureRecipient('Treasury-reconcile')
      const node = await fixtureRecipient('Node-reconcile')
      await fixturePublishedPolicy([{ recipientId: treasury.id, weightPct: '90' }, { recipientId: node.id, weightPct: '10' }])
      const { obligationId } = await fixtureCollectedObligation('0.00000101')
      await entitlementAllocationService.allocate(obligationId)

      const mismatches = await reconciliation.findGenerationSumMismatches()
      const forThisObligation = mismatches.filter((m) => m.feeObligationId === obligationId)
      expect(forThisObligation).toHaveLength(0)
    })

    it('findPolicyWeightSumMismatches() reports nothing for a healthy foundation', async () => {
      requirePostgres('policy weight reconciliation clean')
      const treasury = await fixtureRecipient('Treasury-reconcile2')
      const policy = await fixturePublishedPolicy([{ recipientId: treasury.id, weightPct: '100' }])
      const mismatches = await reconciliation.findPolicyWeightSumMismatches()
      expect(mismatches.find((m) => m.policyVersionId === policy.id)).toBeUndefined()
    })

    it('findNegativeRecipientBalances() reports nothing for a healthy foundation', async () => {
      requirePostgres('negative balance reconciliation clean')
      const treasury = await fixtureRecipient('Treasury-reconcile3')
      await fixturePublishedPolicy([{ recipientId: treasury.id, weightPct: '100' }])
      const { obligationId } = await fixtureCollectedObligation('0.00000041')
      await entitlementAllocationService.allocate(obligationId)

      const negatives = await reconciliation.findNegativeRecipientBalances()
      expect(negatives.find((n) => n.recipientId === treasury.id)).toBeUndefined()
    })

    it('findAssetRailMismatches() reports nothing for a healthy foundation', async () => {
      requirePostgres('asset/rail reconciliation clean')
      const treasury = await fixtureRecipient('Treasury-reconcile4')
      await fixturePublishedPolicy([{ recipientId: treasury.id, weightPct: '100' }])
      const { obligationId } = await fixtureCollectedObligation('0.00000041')
      await entitlementAllocationService.allocate(obligationId)

      const mismatches = await reconciliation.findAssetRailMismatches()
      const entries = await entitlementLedgerRepository.listForObligation(obligationId)
      expect(mismatches.filter((m) => entries.some((e) => e.id === m.entryId))).toHaveLength(0)
    })

    it('findReorgedGenerationsNotReversed() detects a reorg that was recognized but never reversed', async () => {
      requirePostgres('reorg-not-reversed detection')
      const treasury = await fixtureRecipient('Treasury-unreversed')
      await fixturePublishedPolicy([{ recipientId: treasury.id, weightPct: '100' }])
      const { obligationId, confirmationEvidenceId } = await fixtureCollectedObligation('0.00000041')
      await entitlementAllocationService.allocate(obligationId)

      const evidence = await prisma.feeCollectionEvidence.findUniqueOrThrow({ where: { id: confirmationEvidenceId } })
      await feeCollectionRecognitionService.recordReorgAndRevert(obligationId, evidence.txid!)
      // Deliberately do NOT call reverseGeneration() — simulating the gap.

      const gaps = await reconciliation.findReorgedGenerationsNotReversed()
      expect(gaps.find((g) => g.confirmationEvidenceId === confirmationEvidenceId)).toBeDefined()
    })
  })
})
