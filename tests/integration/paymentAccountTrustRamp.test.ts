// tests/integration/paymentAccountTrustRamp.test.ts
//
// #235 R7D (N2) — PaymentAccount.completedTrades is production truth, on real PostgreSQL.
//
// The seller's bound PaymentAccount (R7C: Trade.sellerPaymentAccountId) gains exactly one completed trade
// per CLEAN completion: escrow COMPLETED (its terminal transition exists), no dispute ever, bound account.
// The only writer is paymentAccountService.recordCleanBoundCompletion(), called by the durable
// settlement.escrow.released handler and keyed on (the escrow's COMPLETED transition, the trade) through
// applyEventProjectionOnce() — so serial replay, concurrent redelivery, a second node, a direct service
// call and PASS 3 recovery after a crash all converge on one increment. `chargebacks` has no writer.
//
// Patterns reused from durableProjectionCompletion.test.ts: a fixture claimed at QUEUE_HEAD is the one
// PASS 3 picks first; a second module graph with its own handlers is a second node; a graph that never
// registered handlers is a node that crashed after committing the transition but before projecting it.

import { PrismaClient } from '@prisma/client'
import { randomBytes } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { refusedThenHistoricalTrade } from './economicFixtures'
import { closeTestRedis } from './identityTestHelpers'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const QUEUE_HEAD = new Date('2000-01-01T00:00:00.000Z')
const KEY = 'payment-account.completed-trade'

describe('#235 R7D — payment-account trust ramp from durable clean completions (real PostgreSQL)', () => {
  jest.setTimeout(180_000)

  const pg = createPostgresIntegrationHarness()
  let prisma: PrismaClient
  let eventBus: any
  let liquidityRouter: any
  let tradeService: any
  let escrowService: any
  let paymentAccountService: any
  let reconcileIncompleteProjections: any
  let nodeB: { eventBus: any; accounts: any; prisma: PrismaClient; redis: any }
  let crashed: { escrowService: any; prisma: PrismaClient; redis: any }
  const ownedUserIds: string[] = []

  beforeAll(async () => {
    await pg.probe()
    if (!pg.isAvailable()) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ eventBus } = require('../../src/common/events/event-bus'))
    ;({ liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service'))
    ;({ tradeService } = require('../../src/modules/open-p2p/trade.service'))
    ;({ escrowService } = require('../../src/modules/open-settlement/escrow.service'))
    ;({ paymentAccountService } = require('../../src/modules/open-settlement/payment-account.service'))
    ;({ reconcileIncompleteProjections } = require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service'))
    const { intentEngine } = require('../../src/core/intent-engine')
    const { OpenP2PTradeIntentHandler } = require('../../src/modules/open-p2p/intent-handler')
    intentEngine.registerHandler(OpenP2PTradeIntentHandler)
    require('../../src/common/events/handlers').registerEventHandlers()

    jest.isolateModules(() => {
      require('../../src/common/events/handlers').registerEventHandlers()
      nodeB = {
        eventBus: require('../../src/common/events/event-bus').eventBus,
        accounts: require('../../src/modules/open-settlement/payment-account.service').paymentAccountService,
        prisma: require('../../src/common/database').prisma,
        redis: require('../../src/common/redis').redis,
      }
    })
    // A node that commits the release and then dies before any handler runs: no handlers registered.
    jest.isolateModules(() => {
      crashed = {
        escrowService: require('../../src/modules/open-settlement/escrow.service').escrowService,
        prisma: require('../../src/common/database').prisma,
        redis: require('../../src/common/redis').redis,
      }
    })
  })

  afterAll(async () => {
    if (!pg.isAvailable()) return
    try {
      await cleanupOwnedRows()
    } finally {
      for (const node of [nodeB, crashed]) {
        await node?.prisma.$disconnect().catch(() => undefined)
        await node?.redis.quit().catch(() => undefined)
      }
      await prisma.$disconnect()
      await closeTestRedis()
    }
  })

  // Only this suite's rows (participants are all named 'r7d-…'). The R7C write-once guard is disabled in
  // one transaction just long enough to reset the suite's own accounts, as in paymentAccountBindingAuthority.
  async function cleanupOwnedRows() {
    const named = await prisma.user.findMany({ where: { displayName: { startsWith: 'r7d-' } }, select: { id: true } })
    const users = [...new Set([...ownedUserIds, ...named.map((u) => u.id)])]
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE "payment_accounts" DISABLE TRIGGER payment_accounts_attestation_write_once_guard')
      await tx.$executeRaw`UPDATE payment_accounts SET signed = false, "signedBy" = NULL, "signedAt" = NULL, "attestationSource" = NULL, "attestedTradeId" = NULL WHERE "ownerId" = ANY(${users})`
      await tx.$executeRawUnsafe('ALTER TABLE "payment_accounts" ENABLE TRIGGER payment_accounts_attestation_write_once_guard')
    })
    const tradeIds = (await prisma.trade.findMany({ where: { OR: [{ buyerId: { in: users } }, { sellerId: { in: users } }] }, select: { id: true } })).map((t) => t.id)
    const escrowIds = (await prisma.escrow.findMany({ where: { tradeId: { in: tradeIds } }, select: { id: true } })).map((e) => e.id)
    const refs = await prisma.$queryRaw<Array<{ table_name: string; column_name: string }>>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name IN ('tradeId', 'escrowId', 'interactionId') AND table_name NOT IN ('trades', 'escrows')`
    for (let pass = 0; pass < 4; pass++) {
      for (const { table_name, column_name } of refs) {
        const ids = column_name === 'tradeId' ? tradeIds : escrowIds
        await prisma.$executeRawUnsafe(`DELETE FROM "${table_name}" WHERE "${column_name}" = ANY($1)`, ids).catch(() => undefined)
      }
    }
    await prisma.$executeRaw`DELETE FROM event_projection_claims WHERE "subjectId" = ANY(${tradeIds}) OR "subjectId" = ANY(${escrowIds})`
    await prisma.$executeRaw`UPDATE trades SET "escrowId" = NULL WHERE id = ANY(${tradeIds})`
    await prisma.$executeRaw`DELETE FROM escrows WHERE id = ANY(${escrowIds})`
    await prisma.$executeRaw`DELETE FROM trades WHERE id = ANY(${tradeIds})`
    await prisma.$executeRaw`DELETE FROM offers WHERE "userId" = ANY(${users})`
    await prisma.$executeRaw`DELETE FROM payment_accounts WHERE "ownerId" = ANY(${users})`
    await prisma.$executeRaw`DELETE FROM payout_addresses WHERE "participantId" = ANY(${users})`
    await prisma.$executeRaw`DELETE FROM intent_events WHERE "intentId" IN (SELECT id FROM intents WHERE "participantId" = ANY(${users}))`
    await prisma.$executeRaw`DELETE FROM intents WHERE "participantId" = ANY(${users})`
    await prisma.$executeRaw`DELETE FROM users WHERE id = ANY(${users})`
  }

  // ─── fixtures ─────────────────────────────────────────────────────────────────────────────────────────

  async function user(label: string) {
    const u = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex'), displayName: `r7d-${label}` } })
    ownedUserIds.push(u.id)
    return u
  }
  const account = (ownerId: string, method = 'PIX') =>
    paymentAccountService.getOrCreate(ownerId, `r7d-${randomBytes(10).toString('hex')}`, method)
  const count = async (accountId: string) => (await prisma.paymentAccount.findUniqueOrThrow({ where: { id: accountId } })).completedTrades
  const claims = (tradeId: string) => prisma.eventProjectionClaim.count({ where: { projectionKey: KEY, subjectId: tradeId } })

  async function waitFor(cond: () => Promise<boolean>, ms = 20_000) {
    const end = Date.now() + ms
    while (Date.now() < end) { if (await cond()) return; await sleep(50) }
    throw new Error('timed out waiting for condition')
  }
  const projected = (transitionId: string) => async () =>
    (await prisma.eventProjectionClaim.count({ where: { projectionKey: 'transition.projected', subjectId: transitionId } })) > 0

  /** SELL offer by `seller` declaring `acct` (or none), taken by `buyer`. */
  async function sellTrade(seller: { id: string }, buyer: { id: string }, acct?: { accountHash: string }) {
    const o = await liquidityRouter.createOffer({ userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '65000', minAmount: '0.0001', maxAmount: '1', paymentMethod: 'PIX', ...(acct ? { paymentAccountHash: acct.accountHash } : {}) })
    const admit = () => tradeService.createTrade({ offerId: o.id, counterpartyId: buyer.id, amount: '0.0005' })
    // #235 R7H-E3C — an undeclared (unbound) trade is no longer admitted; it is the historical (pre-E3C) row here.
    return acct ? admit() : refusedThenHistoricalTrade(prisma, tradeService, admit, 'UNBOUND_ACCOUNT', o, buyer.id, '0.0005')
  }

  /** Real MOCK escrow up to PAYMENT_PENDING; the release is left to the caller. */
  async function paymentPending(trade: { id: string; sellerId: string }, seller: { id: string }, buyer: { id: string }) {
    await prisma.payoutAddress.upsert({
      where: { participantId_asset: { participantId: buyer.id, asset: 'BTC' } },
      create: { participantId: buyer.id, asset: 'BTC', address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx' },
      update: {},
    })
    const escrow = await escrowService.createEscrow({ tradeId: trade.id, type: 'MOCK', lockedAmount: '0.0005', asset: 'BTC' }, trade.sellerId)
    await escrowService.lockFunds(escrow.id, seller.id)
    await escrowService.markPaymentSent(escrow.id, buyer.id)
    return escrow
  }

  /** The real clean release; returns once every projection of the COMPLETED transition has run. */
  async function releaseCleanly(trade: { id: string; sellerId: string }, seller: { id: string }, buyer: { id: string }) {
    const escrow = await paymentPending(trade, seller, buyer)
    await escrowService.releaseFunds(escrow.id, undefined, seller.id)
    const transition = (await prisma.escrowEvent.findFirst({ where: { escrowId: escrow.id, toStatus: 'COMPLETED' } }))!
    await waitFor(projected(transition.id))
    const durable = (await prisma.durableEventRecord.findFirst({ where: { correlationId: trade.id, eventName: 'settlement.escrow.released' } }))!
    return { escrow, transitionId: transition.id, eventId: durable.id }
  }

  // ─── attribution ──────────────────────────────────────────────────────────────────────────────────────

  it('T1/T6/T7/T16: a clean SELL-offer trade bound to account A counts once on A — never on the seller\'s account B or the buyer\'s', async () => {
    pg.requirePostgres('T1/T16')
    const seller = await user('seller-1'); const buyer = await user('buyer-1')
    const a = await account(seller.id); const b = await account(seller.id); const buyers = await account(buyer.id)
    const trade = await sellTrade(seller, buyer, a)
    await releaseCleanly(trade, seller, buyer)
    expect([await count(a.id), await count(b.id), await count(buyers.id)]).toEqual([1, 0, 0])
    expect(await claims(trade.id)).toBe(1)
    // A caller cannot redirect progression: any extra account argument is ignored, the binding decides.
    await (paymentAccountService as any).recordCleanBoundCompletion(trade.id, b.id)
    await (paymentAccountService as any).recordCleanBoundCompletion(trade.id, { accountHash: b.accountHash })
    expect([await count(a.id), await count(b.id)]).toEqual([1, 0])
  })

  it('T15: on a BUY offer the taker is the seller; their bound account counts, the buyer-maker\'s does not', async () => {
    pg.requirePostgres('T15')
    const buyer = await user('buyer-maker'); const seller = await user('seller-taker')
    const sellers = await account(seller.id); const buyers = await account(buyer.id)
    const o = await liquidityRouter.createOffer({ userId: buyer.id, asset: 'BTC', side: 'BUY', priceUsd: '65000', minAmount: '0.0001', maxAmount: '1', paymentMethod: 'PIX' })
    const trade = await tradeService.createTrade({ offerId: o.id, counterpartyId: seller.id, amount: '0.0005', paymentAccountHash: sellers.accountHash })
    await releaseCleanly(trade, seller, buyer)
    expect([await count(sellers.id), await count(buyers.id)]).toEqual([1, 0])
  })

  it('T8: a clean but UNBOUND trade counts nothing — no account is inferred from the seller\'s accounts', async () => {
    pg.requirePostgres('T8')
    const seller = await user('seller-8'); const buyer = await user('buyer-8')
    const only = await account(seller.id) // the seller's only PIX account
    const trade = await sellTrade(seller, buyer) // declared none
    await releaseCleanly(trade, seller, buyer)
    expect(await count(only.id)).toBe(0)
    expect(await claims(trade.id)).toBe(0)
    expect(await paymentAccountService.recordCleanBoundCompletion(trade.id)).toBe(false)
  })

  // ─── only clean completions ───────────────────────────────────────────────────────────────────────────

  it('T9/T13/T17: incomplete and CANCELLED trades count nothing, and asking leaves no claim behind', async () => {
    pg.requirePostgres('T9/T13')
    const seller = await user('seller-9'); const buyer = await user('buyer-9')
    const acct = await account(seller.id)
    const pending = await sellTrade(seller, buyer, acct)
    expect(await paymentAccountService.recordCleanBoundCompletion(pending.id)).toBe(false) // PENDING, no escrow
    const active = await sellTrade(seller, buyer, acct)
    await paymentPending(active, seller, buyer)
    expect(await paymentAccountService.recordCleanBoundCompletion(active.id)).toBe(false) // PAYMENT_PENDING
    const cancelled = await sellTrade(seller, buyer, acct)
    await tradeService.updateStatus(cancelled.id, 'CANCELLED', seller.id)
    expect(await paymentAccountService.recordCleanBoundCompletion(cancelled.id)).toBe(false)
    expect(await count(acct.id)).toBe(0)
    expect((await claims(pending.id)) + (await claims(active.id)) + (await claims(cancelled.id))).toBe(0)
  })

  it('T10: a real REFUNDED escrow counts nothing', async () => {
    pg.requirePostgres('T10')
    const seller = await user('seller-10'); const buyer = await user('buyer-10')
    const acct = await account(seller.id)
    const trade = await sellTrade(seller, buyer, acct)
    const escrow = await escrowService.createEscrow({ tradeId: trade.id, type: 'MOCK', lockedAmount: '0.0005', asset: 'BTC' }, trade.sellerId)
    await escrowService.lockFunds(escrow.id, seller.id)
    await escrowService.refundFunds(escrow.id, seller.id)
    const transition = (await prisma.escrowEvent.findFirst({ where: { escrowId: escrow.id, toStatus: 'REFUNDED' } }))!
    await waitFor(projected(transition.id))
    expect(await paymentAccountService.recordCleanBoundCompletion(trade.id)).toBe(false)
    expect([await count(acct.id), await claims(trade.id)]).toEqual([0, 0])
  })

  it('T11: a SPLIT escrow (Trade projects COMPLETED) counts nothing', async () => {
    pg.requirePostgres('T11')
    const seller = await user('seller-11'); const buyer = await user('buyer-11')
    const acct = await account(seller.id)
    const trade = await sellTrade(seller, buyer, acct)
    const escrow = await paymentPending(trade, seller, buyer)
    // State fixture: the split outcome written directly (the ruling path is proven elsewhere).
    await prisma.dispute.create({ data: { tradeId: trade.id, escrowId: escrow.id, openedBy: buyer.id, reason: 'r7d fixture' } })
    await prisma.escrow.update({ where: { id: escrow.id }, data: { status: 'SPLIT' } })
    await prisma.trade.update({ where: { id: trade.id }, data: { status: 'COMPLETED' } })
    expect(await paymentAccountService.recordCleanBoundCompletion(trade.id)).toBe(false)
    expect([await count(acct.id), await claims(trade.id)]).toEqual([0, 0])
  })

  it('T12: a real release of a trade that had a dispute (Trade + escrow COMPLETED) is not a clean completion', async () => {
    pg.requirePostgres('T12')
    const seller = await user('seller-12'); const buyer = await user('buyer-12')
    const acct = await account(seller.id)
    const trade = await sellTrade(seller, buyer, acct)
    const escrow = await paymentPending(trade, seller, buyer)
    await prisma.dispute.create({ data: { tradeId: trade.id, escrowId: escrow.id, openedBy: buyer.id, reason: 'r7d fixture' } })
    await escrowService.releaseFunds(escrow.id, undefined, seller.id) // cooperative release; the dispute goes MOOT
    const transition = (await prisma.escrowEvent.findFirst({ where: { escrowId: escrow.id, toStatus: 'COMPLETED' } }))!
    await waitFor(projected(transition.id))
    expect((await prisma.trade.findUniqueOrThrow({ where: { id: trade.id } })).status).toBe('COMPLETED')
    expect([await count(acct.id), await claims(trade.id)]).toEqual([0, 0])
  })

  // ─── exactly once ─────────────────────────────────────────────────────────────────────────────────────

  it('T2/T3/T14/T18: serial replay, 10 concurrent redeliveries and 10 direct service calls still leave exactly one', async () => {
    pg.requirePostgres('T2/T3')
    const seller = await user('seller-2'); const buyer = await user('buyer-2')
    const acct = await account(seller.id)
    const trade = await sellTrade(seller, buyer, acct)
    const { eventId } = await releaseCleanly(trade, seller, buyer)
    expect(await count(acct.id)).toBe(1)

    await eventBus.redeliver(eventId) // serial replay of the same terminal event
    await sleep(300)
    await Promise.all([
      ...Array.from({ length: 10 }, () => eventBus.redeliver(eventId)),
      ...Array.from({ length: 10 }, () => paymentAccountService.recordCleanBoundCompletion(trade.id)),
    ])
    await sleep(800)
    expect([await count(acct.id), await claims(trade.id)]).toEqual([1, 1])
  })

  it('T4: two nodes redelivering and calling concurrently converge on one increment', async () => {
    pg.requirePostgres('T4')
    const seller = await user('seller-4'); const buyer = await user('buyer-4')
    const acct = await account(seller.id)
    const trade = await sellTrade(seller, buyer, acct)
    const { eventId } = await releaseCleanly(trade, seller, buyer)
    await Promise.all([
      eventBus.redeliver(eventId), nodeB.eventBus.redeliver(eventId),
      paymentAccountService.recordCleanBoundCompletion(trade.id), nodeB.accounts.recordCleanBoundCompletion(trade.id),
    ])
    await sleep(800)
    expect([await count(acct.id), await claims(trade.id)]).toEqual([1, 1])
  })

  it('T3/T4/T9: the FIRST processing raced by both nodes, redeliveries and a caller naming another account — one increment, on the bound account', async () => {
    pg.requirePostgres('T3 first processing')
    const seller = await user('seller-3f'); const buyer = await user('buyer-3f')
    const a = await account(seller.id); const b = await account(seller.id)
    const trade = await sellTrade(seller, buyer, a)
    const escrow = await paymentPending(trade, seller, buyer)
    await crashed.escrowService.releaseFunds(escrow.id, undefined, seller.id) // committed, nothing projected yet
    const eventId = (await prisma.durableEventRecord.findFirst({ where: { correlationId: trade.id, eventName: 'settlement.escrow.released' } }))!.id
    expect([await count(a.id), await claims(trade.id)]).toEqual([0, 0])

    await Promise.all([
      ...Array.from({ length: 6 }, () => paymentAccountService.recordCleanBoundCompletion(trade.id)),
      ...Array.from({ length: 6 }, () => nodeB.accounts.recordCleanBoundCompletion(trade.id)),
      (paymentAccountService as any).recordCleanBoundCompletion(trade.id, b.id),
      eventBus.redeliver(eventId), nodeB.eventBus.redeliver(eventId),
    ])
    await sleep(800)
    expect([await count(a.id), await count(b.id), await claims(trade.id)]).toEqual([1, 0, 1])
  })

  it('T6/T7/T14: the very first processing, by a caller naming another account of the seller, still counts only the bound account', async () => {
    pg.requirePostgres('T14 first-call substitution')
    const seller = await user('seller-14'); const buyer = await user('buyer-14')
    const a = await account(seller.id); const b = await account(seller.id)
    const trade = await sellTrade(seller, buyer, a)
    const escrow = await paymentPending(trade, seller, buyer)
    await crashed.escrowService.releaseFunds(escrow.id, undefined, seller.id) // committed, nothing projected yet
    expect(await (paymentAccountService as any).recordCleanBoundCompletion(trade.id, b.id)).toBe(true)
    expect([await count(a.id), await count(b.id)]).toEqual([1, 0])
  })

  it('T5: crash after the release committed but before any projection — PASS 3 converges to exactly one, and stays there', async () => {
    pg.requirePostgres('T5')
    const seller = await user('seller-5'); const buyer = await user('buyer-5')
    const acct = await account(seller.id)
    const trade = await sellTrade(seller, buyer, acct)
    const escrow = await paymentPending(trade, seller, buyer)
    await crashed.escrowService.releaseFunds(escrow.id, undefined, seller.id) // committed; no handler ever ran
    const transition = (await prisma.escrowEvent.findFirst({ where: { escrowId: escrow.id, toStatus: 'COMPLETED' } }))!
    await sleep(300)
    expect([await count(acct.id), await claims(trade.id)]).toEqual([0, 0])

    await prisma.eventProjectionClaim.updateMany({ where: { eventId: transition.id, projectionKey: 'transition.claimed' }, data: { appliedAt: QUEUE_HEAD } })
    const report = { requiresManualReview: [], failed: [], projectionsRecovered: [] } as any
    await reconcileIncompleteProjections(report, 0)
    expect(report.failed).toEqual([])
    await waitFor(projected(transition.id))
    expect(await count(acct.id)).toBe(1)

    // Crash after progression but before the projected marker: PASS 3 re-drives, nothing double-counts.
    await prisma.eventProjectionClaim.deleteMany({ where: { projectionKey: 'transition.projected', subjectId: transition.id } })
    await prisma.eventProjectionClaim.updateMany({ where: { eventId: transition.id, projectionKey: 'transition.claimed' }, data: { appliedAt: QUEUE_HEAD, transitionProjectedAt: null, projectionRecoveryAttemptedAt: null } })
    const again = { requiresManualReview: [], failed: [], projectionsRecovered: [] } as any
    await reconcileIncompleteProjections(again, 0)
    await waitFor(projected(transition.id))
    expect([await count(acct.id), await claims(trade.id)]).toEqual([1, 1])
  })

  it('T19: the exactly-once guard is the database unique index on (eventId, projectionKey, subjectId)', async () => {
    pg.requirePostgres('T19')
    const rows = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'event_projection_claims' AND indexdef ILIKE '%UNIQUE%'`
    expect(rows.some((r) => /"eventId".*"projectionKey".*"subjectId"/.test(r.indexdef))).toBe(true)
  })

  // CTO policy (Day-0): no canonical fiat-reversal authority → no chargeback write. Two proofs.
  it('chargebacks, structural: no production source writes PaymentAccount.chargebacks', () => {
    const { readdirSync, readFileSync, statSync } = require('fs')
    const { join } = require('path')
    const root = join(__dirname, '..', '..')
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.(ts|js|sql)$/.test(name)) files.push(path)
      }
    }
    for (const dir of ['src', 'scripts', join('prisma', 'migrations')]) walk(join(root, dir))
    // A write is an assignment in a Prisma `data` object (`chargebacks: {…}` / `chargebacks: <number>`) or in SQL
    // (`SET … "chargebacks" =`). Reads (`account.chargebacks`, `chargebacks: account.chargebacks`, the column
    // definition in the init migration) are not.
    const writes = /chargebacks\s*:\s*(\{|\d|-)|"?chargebacks"?\s*=(?!=)/
    const offenders = files.filter((f) => readFileSync(f, 'utf8').split('\n').some((line: string) => writes.test(line)))
    expect(offenders).toEqual([])
    expect(typeof (paymentAccountService as any).recordChargeback).toBe('undefined')
    expect(typeof (paymentAccountService as any).recordCompletedTrade).toBe('undefined')
  })

  it('chargebacks, behavioural: every account this suite drove through clean completion, release after a dispute (MOOT), refund, cancellation, SPLIT, replay, concurrent nodes and PASS 3 recovery still has 0', async () => {
    pg.requirePostgres('chargebacks')
    const accounts = await prisma.paymentAccount.findMany({ where: { ownerId: { in: ownedUserIds } }, select: { chargebacks: true, completedTrades: true } })
    expect(accounts.length).toBeGreaterThan(10)
    expect(accounts.filter((a) => a.completedTrades > 0).length).toBeGreaterThan(0) // the ramp did advance here
    expect(accounts.filter((a) => a.chargebacks !== 0)).toEqual([])
  })
})
