// tests/integration/offerIntentIdempotencyUniqueness.test.ts
//
// CROSS-LAYER-SEMANTIC-CORRECTIVE-1-R5 (item 37, 2026-09-14) — real-
// Postgres proof for the property `tests/idempotency.test.ts`'s
// in-memory `FakeIntentStore`/`FakeOfferStore` simulations already
// prove abstractly: for one supplied idempotency key, at most one
// canonical `Intent` and at most one `Offer` can ever exist, and the
// database itself — not application-level bookkeeping — is what makes
// that true. The mission explicitly asked for this: "the final proof
// for this property should include a real-Postgres integration test
// for whichever unique/reconciliation mechanism is chosen. Do not rely
// solely on an in-memory simulation for this last boundary."
//
// Two independent things are proven here:
// 1. The real `Offer.intentId` column carries a genuine Postgres unique
//    constraint (`prisma/migrations/20260914010000_offer_intent_id_unique`)
//    — a raw, direct `prisma.offer.create()` with a duplicate `intentId`
//    is rejected by the database itself, not by any application code.
// 2. `liquidityRouter.createOffer()`'s real, unmocked `persistOffer()`
//    correctly recovers an already-durable Offer for a canonical Intent
//    rather than creating a second one — proven by manually staging the
//    exact "prior attempt's Intent AND Offer both genuinely committed,
//    but the claim row itself is still FAILED" state (the real-world
//    shape of a lost acknowledgement) directly via Prisma, then calling
//    the real `createOffer()` with the SAME idempotency key/payload and
//    confirming it reconciles to the one existing Offer instead of
//    inserting a duplicate.

import { PrismaClient } from '@prisma/client'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { registerTestParticipant, closeTestRedis } from './identityTestHelpers'

describe('Offer/Intent idempotency uniqueness — real Postgres (CROSS-LAYER-SEMANTIC-CORRECTIVE-1-R5)', () => {
  jest.setTimeout(30_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let identityService: typeof import('../../src/modules/open-identity/identity.service').identityService
  let liquidityRouter: typeof import('../../src/modules/open-liquidity/liquidity.service').liquidityRouter
  let intentEngine: typeof import('../../src/core/intent-engine').intentEngine
  let hashIdempotentPayload: typeof import('../../src/common/idempotency').hashIdempotentPayload
  let OpenP2PTradeIntentHandler: any

  const RUN_ID = Date.now().toString(36)

  beforeAll(async () => {
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return

    ;({ prisma } = require('../../src/common/database'))
    ;({ identityService } = require('../../src/modules/open-identity/identity.service'))
    ;({ liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service'))
    ;({ intentEngine } = require('../../src/core/intent-engine'))
    ;({ hashIdempotentPayload } = require('../../src/common/idempotency'))
    ;({ OpenP2PTradeIntentHandler } = require('../../src/modules/open-p2p/intent-handler'))
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

  async function makeSeller(_suffix: string) {
    return registerTestParticipant(identityService, 'Seller')
  }

  // Item 1 — the database itself enforces the invariant, not application
  // code. A raw, direct prisma.offer.create() (bypassing persistOffer()'s
  // own reconciliation entirely) with a duplicate intentId must be
  // rejected by Postgres's own unique constraint.
  it('the real Offer.intentId column rejects a second Offer for the same Intent — a genuine database-level constraint, not an application-level check', async () => {
    requirePostgres('Offer.intentId unique constraint')

    const seller = await makeSeller('db-constraint')
    const firstOffer = await liquidityRouter.createOffer({
      userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.01', paymentMethod: 'OTHER',
    })
    expect(firstOffer.intentId).toBeTruthy()

    // A raw duplicate insert, deliberately bypassing persistOffer()'s own
    // reconciliation logic — this proves the CONSTRAINT itself exists,
    // independent of whether the application code that normally guards
    // against this is even running.
    await expect(
      prisma.offer.create({
        data: {
          userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.01',
          paymentMethod: 'OTHER', intentId: firstOffer.intentId,
        },
      })
    ).rejects.toThrow(/Unique constraint/i)

    const count = await prisma.offer.count({ where: { intentId: firstOffer.intentId } })
    expect(count).toBe(1) // the rejected insert left no partial row behind
  })

  // Item 2 — the real, unmocked createOffer() end-to-end reconciliation
  // path, exercising the exact "committed but acknowledgement lost"
  // scenario the mission describes: a PRIOR attempt's Intent AND Offer
  // both genuinely exist (staged directly via Prisma, modeling what a
  // real prior HTTP request would have left behind), but its
  // IdempotencyKey claim row is still FAILED (modeling the caller never
  // having learned that the whole attempt actually succeeded). A retry
  // with the identical idempotency key + payload must recover the ONE
  // existing Offer, never insert a second one.
  it('createOffer() retried with the same key after a staged "committed but ack-lost" prior attempt recovers the existing Offer — no duplicate Intent or Offer is created', async () => {
    requirePostgres('createOffer() Offer/Intent reconciliation after ack-lost')

    const seller = await makeSeller('ack-lost')
    const idempotencyKey = `ack-lost-${RUN_ID}`
    const input = {
      userId: seller.id, asset: 'BTC' as const, side: 'SELL' as const, priceUsd: '61000', priceBrl: undefined,
      minAmount: '0.002', maxAmount: '0.02', paymentMethod: 'OTHER' as const, paymentDetails: undefined,
      network: undefined, description: undefined, idempotencyKey,
    }

    // Stage the "prior attempt fully succeeded but the claim itself is
    // FAILED" state by driving the real intentEngine.create() (with the
    // real idempotencyClaimId marker) and a real prisma.offer.create()
    // directly — this is exactly what runAndSettle()'s own persist()
    // would have produced had the ORIGINAL caller's connection dropped
    // right after both real inserts committed.
    const claim = await prisma.idempotencyKey.create({
      data: {
        scope: 'liquidity.offer.create',
        participantId: seller.id,
        key: idempotencyKey,
        requestHash: hashIdempotentPayload({
          asset: input.asset, side: input.side, priceUsd: input.priceUsd, priceBrl: input.priceBrl,
          minAmount: input.minAmount, maxAmount: input.maxAmount, paymentMethod: input.paymentMethod,
          paymentDetails: input.paymentDetails, network: input.network, description: input.description,
        }),
        status: 'FAILED',
      },
    })

    const stagedIntent = await intentEngine.create(
      'TradeIntent',
      { asset: input.asset, side: input.side, maxValue: '1220.00000000', minValue: '122.00000000', fiatMethod: input.paymentMethod, network: input.network },
      seller.id,
      undefined,
      claim.id
    )
    const stagedOffer = await prisma.offer.create({
      data: {
        userId: seller.id, asset: input.asset, side: input.side, priceUsd: input.priceUsd,
        minAmount: input.minAmount, maxAmount: input.maxAmount, paymentMethod: input.paymentMethod,
        intentId: stagedIntent.id,
      },
    })

    // The retry: same key, same logical payload. Must reconcile to the
    // ALREADY-STAGED Intent and Offer, never create new ones.
    const result = await liquidityRouter.createOffer(input)

    expect(result.id).toBe(stagedOffer.id)
    expect(result.intentId).toBe(stagedIntent.id)

    const offerCount = await prisma.offer.count({ where: { intentId: stagedIntent.id } })
    expect(offerCount).toBe(1) // no second Offer was created

    const intentCount = await prisma.intent.count({ where: { idempotencyClaimId: claim.id } })
    expect(intentCount).toBe(1) // no second Intent was created

    // The claim itself is now settled away from FAILED — a further retry
    // would take the COMPLETED/UNKNOWN recover() path, not persist() again.
    const finalClaim = await prisma.idempotencyKey.findUnique({ where: { id: claim.id } })
    expect(['COMPLETED', 'UNKNOWN']).toContain(finalClaim!.status)
  })

  // Item 3 — CROSS-LAYER-SEMANTIC-CORRECTIVE-1-R5.1 CORRECTION
  // (2026-09-14): this test's own name/comment previously claimed to
  // prove "a true pre-commit failure... remains legitimately retryable"
  // — WRONG. Both calls below succeed; this proves ordinary EXACT-RETRY
  // replay via the COMPLETED path (recover(), never persist() again) —
  // a real and useful property, but NOT a pre-commit-failure test. The
  // genuine pre-commit-failure property is proven separately by the NEW
  // test immediately below (item 4), added specifically because this
  // one's claim was found to be unsupported by a CTO review.
  it('createOffer() with an idempotency key: an exact retry recovers the SAME Offer via the normal COMPLETED path, never creating a second one', async () => {
    requirePostgres('createOffer() exact-retry recovery')

    const seller = await makeSeller('exact-retry')
    const idempotencyKey = `exact-retry-${RUN_ID}`
    const input = {
      userId: seller.id, asset: 'BTC' as const, side: 'BUY' as const, priceUsd: '59000',
      minAmount: '0.001', maxAmount: '0.005', paymentMethod: 'OTHER' as const, idempotencyKey,
    }

    const first = await liquidityRouter.createOffer(input)
    const second = await liquidityRouter.createOffer(input)

    expect(second.id).toBe(first.id)
    expect(second.intentId).toBe(first.intentId)

    const offerCount = await prisma.offer.count({ where: { intentId: first.intentId! } })
    expect(offerCount).toBe(1)
  })

  // Item 4 — CROSS-LAYER-SEMANTIC-CORRECTIVE-1-R5.1 (2026-09-14): the
  // genuine pre-commit-failure test item 3 was mislabeled as. Drives the
  // REAL, unmocked createOffer() -> persistOffer() -> withIdempotency()
  // orchestration against a REAL Postgres for everything — the canonical
  // Intent's own creation, the IdempotencyKey claim row's real
  // FAILED -> IN_PROGRESS reclaim, and the retry's real second
  // `prisma.offer.create()` call. The ONLY simulated element is the
  // FIRST Offer INSERT's own outcome: `prisma.offer.create` is spied on
  // (not mocked away — the spy delegates to the real implementation on
  // every call after the first) to reject exactly once with a plain,
  // non-P2002 Error, modeling a genuine transient rejection BEFORE the
  // statement would have executed (e.g. a dropped connection, a
  // statement timeout) — indistinguishable, from persistOffer()'s own
  // perspective, from any other real pre-commit failure, and NOT the
  // "insert already committed" case items 2/3 above already cover.
  it('createOffer() with an idempotency key: a genuine pre-commit Offer INSERT failure (before commit) leaves the claim retryable, and the retry succeeds by reusing the SAME canonical Intent — exactly one Intent and one Offer ultimately exist', async () => {
    requirePostgres('createOffer() genuine pre-commit Offer failure retry')

    const seller = await makeSeller('precommit-fail')
    const idempotencyKey = `precommit-fail-${RUN_ID}`
    const input = {
      userId: seller.id, asset: 'BTC' as const, side: 'SELL' as const, priceUsd: '62000',
      minAmount: '0.001', maxAmount: '0.01', paymentMethod: 'OTHER' as const, idempotencyKey,
    }

    const realOfferCreate = prisma.offer.create.bind(prisma.offer)
    let offerCreateCalls = 0
    const spy = jest.spyOn(prisma.offer, 'create').mockImplementation((async (...args: unknown[]) => {
      offerCreateCalls++
      if (offerCreateCalls === 1) {
        throw new Error('simulated genuine pre-commit Offer INSERT failure — e.g. a dropped connection before the statement executed')
      }
      return (realOfferCreate as (...a: unknown[]) => unknown)(...args)
    }) as typeof prisma.offer.create)

    try {
      // 1. First attempt: the Intent is created for real; the Offer
      // INSERT itself genuinely never executes.
      await expect(liquidityRouter.createOffer(input)).rejects.toThrow('simulated genuine pre-commit Offer INSERT failure')
      expect(offerCreateCalls).toBe(1)

      const intentAfterFailure = await prisma.intent.findFirst({
        where: { participantId: seller.id, type: 'TradeIntent' },
        orderBy: { createdAt: 'desc' },
      })
      expect(intentAfterFailure).toBeTruthy() // the canonical Intent genuinely exists

      const offerCountAfterFailure = await prisma.offer.count({ where: { intentId: intentAfterFailure!.id } })
      expect(offerCountAfterFailure).toBe(0) // nothing durable for the Offer — a REAL pre-commit failure, not a disguised success

      const claimAfterFailure = await prisma.idempotencyKey.findUnique({
        where: { scope_participantId_key: { scope: 'liquidity.offer.create', participantId: seller.id, key: idempotencyKey } },
      })
      expect(claimAfterFailure!.status).toBe('FAILED') // retryable, per Defect B's own atomic reclaim

      // 2. Retry — the spy lets this second call through to the real insert.
      const result = await liquidityRouter.createOffer(input)

      expect(offerCreateCalls).toBe(2) // the retry's insert genuinely ran
      expect(result.intentId).toBe(intentAfterFailure!.id) // (1) the SAME canonical Intent is reused

      const finalOfferCount = await prisma.offer.count({ where: { intentId: intentAfterFailure!.id } })
      expect(finalOfferCount).toBe(1) // (2) exactly one Offer ultimately exists — (6) no duplicate Offer

      const finalIntentCount = await prisma.intent.count({ where: { idempotencyClaimId: claimAfterFailure!.id } })
      expect(finalIntentCount).toBe(1) // (5) no duplicate Intent

      const finalClaim = await prisma.idempotencyKey.findUnique({ where: { id: claimAfterFailure!.id } })
      expect(['COMPLETED', 'UNKNOWN']).toContain(finalClaim!.status) // (4) the claim settles COMPLETED/UNKNOWN — (3) the retry itself succeeded (asserted above, `result` is a real Offer)
    } finally {
      spy.mockRestore()
    }
  })
})
