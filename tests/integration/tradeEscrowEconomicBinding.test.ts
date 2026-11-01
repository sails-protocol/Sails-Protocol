// tests/integration/tradeEscrowEconomicBinding.test.ts
//
// #235 R7F-B — TRADE_ESCROW_ECONOMIC_BINDING_V1, on real PostgreSQL.
//
// A trade-backed escrow commits exactly the trade's economic intent: Escrow.asset = Trade.asset and
// Escrow.lockedAmount = Trade.amount (T, the principal; the protocol fee reserve R = T + Fmax is separate),
// compared as exact Decimals, refused before anything is written when the caller asserts anything else. A
// trade whose AssetType has no authorized settlement translation (ADR-002 §11) cannot be escrowed on any
// rail, and SAFE_GUARD_EVM (native ETH) never backs a trade. Escrow.tradeId @unique is the one-escrow-per-
// trade authority under races.
//
// Real services (escrowService.createEscrow — what POST /v1/settlement/escrow calls), real PostgreSQL. A
// "node" is an independent module graph (jest.isolateModules) on the same database.

import { PrismaClient, Prisma } from '@prisma/client'
import { randomBytes } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { boundOfferInput, boundOfferRow, boundTradeRow, deleteFixtureAccounts, sellerPixAccount } from './economicFixtures'
import { closeTestRedis } from './identityTestHelpers'

const UNTRANSLATED = ['LN_BTC', 'USDT_LIGHTNING', 'SPARK', 'STACKS', 'RSK_BTC'] as const
const RAILS = ['MULTISIG', 'LIGHTNING_HODL', 'WDK_USDT_EVM', 'SAFE_GUARD_EVM', 'MOCK', undefined] as const

describe('#235 R7F-B — trade ↔ escrow economic binding (real PostgreSQL)', () => {
  jest.setTimeout(180_000)

  const pg = createPostgresIntegrationHarness()
  let prisma: PrismaClient
  let escrowService: any
  let liquidityRouter: any
  let tradeService: any
  let getSettlementProvider: (type: string) => any
  const ownedUserIds: string[] = []

  beforeAll(async () => {
    await pg.probe()
    if (!pg.isAvailable()) return
    ;({ prisma } = require('../../src/common/database'))
    require('../../src/common/events/handlers').registerEventHandlers()
    ;({ escrowService } = require('../../src/modules/open-settlement/escrow.service'))
    ;({ getSettlementProvider } = require('../../src/modules/open-settlement/escrow-providers'))
    ;({ liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service'))
    ;({ tradeService } = require('../../src/modules/open-p2p/trade.service'))
  })

  afterAll(async () => {
    if (!pg.isAvailable()) return
    try {
      const named = await prisma.user.findMany({ where: { displayName: { startsWith: 'r7fb-' } }, select: { id: true } })
      const users = [...new Set([...ownedUserIds, ...named.map((u) => u.id)])]
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
      await deleteFixtureAccounts(prisma, users)
      await prisma.$executeRaw`DELETE FROM payout_addresses WHERE "participantId" = ANY(${users})`
      await prisma.$executeRaw`DELETE FROM intent_events WHERE "intentId" IN (SELECT id FROM intents WHERE "participantId" = ANY(${users}))`
      await prisma.$executeRaw`DELETE FROM intents WHERE "participantId" = ANY(${users})`
      await prisma.$executeRaw`DELETE FROM users WHERE id = ANY(${users})`
    } finally {
      await prisma.$disconnect()
      await closeTestRedis()
    }
  })

  // ─── fixtures ─────────────────────────────────────────────────────────────────────────────────────────

  async function parties(label: string) {
    const tag = randomBytes(5).toString('hex')
    const seller = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex'), displayName: `r7fb-${label}-s-${tag}` } })
    const buyer = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex'), displayName: `r7fb-${label}-b-${tag}` } })
    ownedUserIds.push(seller.id, buyer.id)
    return { seller, buyer }
  }

  /** A Trade row with the given economic intent (state fixture; the creation path itself is covered by T9/T10). */
  async function trade(asset: string, amount: string, label = 'x') {
    const { seller, buyer } = await parties(label)
    const acct = await sellerPixAccount(prisma, seller.id)
    const offer = await prisma.offer.create({ data: { userId: seller.id, asset: asset as any, side: 'SELL', priceUsd: '1', minAmount: '0.00000001', maxAmount: '100000000', ...boundOfferRow(acct) } })
    const t = await prisma.trade.create({ data: { ...boundTradeRow(acct), offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, asset: asset as any, amount, priceUsd: '1', totalUsd: amount } })
    return { trade: t, seller, buyer }
  }

  const escrowsOf = (tradeId: string) => prisma.escrow.findMany({ where: { tradeId } })
  const createdEvents = (tradeId: string) => prisma.durableEventRecord.count({ where: { correlationId: tradeId, eventName: 'settlement.escrow.created' } })
  const create = (svc: any, t: { id: string }, actor: { id: string }, input: Record<string, unknown>) =>
    svc.createEscrow({ tradeId: t.id, ...input }, actor.id)
  /** #235 R7H-E3 — the escrow is created by the trade's seller. */
  const sellerOf = (t: { sellerId: string }) => ({ id: t.sellerId })

  /** Every function on every provider instance, spied, so "zero provider side effect" is asserted, not assumed. */
  function spyProviders() {
    const spies: jest.SpyInstance[] = []
    for (const type of ['MULTISIG', 'LIGHTNING_HODL', 'WDK_USDT_EVM', 'SAFE_GUARD_EVM', 'MOCK']) {
      const provider = getSettlementProvider(type)
      let proto = Object.getPrototypeOf(provider)
      const names = new Set<string>()
      while (proto && proto !== Object.prototype) {
        for (const n of Object.getOwnPropertyNames(proto)) if (n !== 'constructor' && typeof provider[n] === 'function') names.add(n)
        proto = Object.getPrototypeOf(proto)
      }
      for (const n of names) spies.push(jest.spyOn(provider, n))
    }
    return { calls: () => spies.reduce((sum, s) => sum + s.mock.calls.length, 0), restore: () => spies.forEach((s) => s.mockRestore()) }
  }

  /** Asserts a refusal left no escrow, no creation event and no provider call. */
  async function expectRefusedClean(t: { id: string }, attempt: () => Promise<unknown>, message: RegExp) {
    const providers = spyProviders()
    try {
      await expect(attempt()).rejects.toThrow(message)
      expect(await escrowsOf(t.id)).toEqual([])
      expect(await createdEvents(t.id)).toBe(0)
      expect(providers.calls()).toBe(0)
    } finally {
      providers.restore()
    }
  }

  // ─── canonical success ────────────────────────────────────────────────────────────────────────────────

  it('T1/T4: a BTC trade escrows on MULTISIG with exactly the trade\'s asset and principal', async () => {
    pg.requirePostgres('T1')
    const { trade: t, buyer } = await trade('BTC', '0.00123456', 'btc')
    const e = await create(escrowService, t, sellerOf(t), { type: 'MULTISIG', asset: 'BTC', lockedAmount: '0.00123456' })
    expect([e.type, e.asset, e.lockedAmount.toString()]).toEqual(['MULTISIG', 'BTC', '0.00123456'])
  })

  it('T5: an equivalent decimal representation ("0.0010" for 0.001) is accepted — the trade\'s canonical value is what is stored', async () => {
    pg.requirePostgres('T5')
    const { trade: t, buyer } = await trade('BTC', '0.001', 'repr')
    const e = await create(escrowService, t, sellerOf(t), { type: 'MULTISIG', asset: 'BTC', lockedAmount: '0.0010' })
    expect(new Prisma.Decimal(e.lockedAmount).equals(t.amount)).toBe(true)
  })

  it('T15: a USDT_ERC20 trade escrows on WDK_USDT_EVM (the registered {USDT, ETHEREUM} rail)', async () => {
    pg.requirePostgres('T15')
    const { trade: t, buyer } = await trade('USDT_ERC20', '250.5', 'usdt')
    const e = await create(escrowService, t, sellerOf(t), { asset: 'USDT_ERC20', lockedAmount: '250.500000', type: 'WDK_USDT_EVM' })
    expect([e.type, e.asset, e.lockedAmount.toString()]).toEqual(['WDK_USDT_EVM', 'USDT_ERC20', '250.5'])
  })

  it('T9/T10/T13: SELL-offer and BUY-offer trades both bind to their own immutable asset and amount', async () => {
    pg.requirePostgres('T9/T10')
    const { intentEngine } = require('../../src/core/intent-engine')
    const { OpenP2PTradeIntentHandler } = require('../../src/modules/open-p2p/intent-handler')
    intentEngine.registerHandler(OpenP2PTradeIntentHandler)
    const s = await parties('sell')
    const sellOffer = await liquidityRouter.createOffer({ userId: s.seller.id, asset: 'BTC', side: 'SELL', priceUsd: '65000', minAmount: '0.0001', maxAmount: '1', ...boundOfferInput(await sellerPixAccount(prisma, s.seller.id)) })
    const sellTrade = await tradeService.createTrade({ offerId: sellOffer.id, counterpartyId: s.buyer.id, amount: '0.0007' })
    const b = await parties('buy')
    const buyOffer = await liquidityRouter.createOffer({ userId: b.buyer.id, asset: 'BTC', side: 'BUY', priceUsd: '65000', minAmount: '0.0001', maxAmount: '1', paymentMethod: 'PIX' })
    const buyTrade = await tradeService.createTrade({ offerId: buyOffer.id, counterpartyId: b.seller.id, amount: '0.0009', paymentAccountHash: (await sellerPixAccount(prisma, b.seller.id)).accountHash })

    await expect(create(escrowService, sellTrade, s.seller, { asset: 'BTC', lockedAmount: '1' })).rejects.toThrow(/does not equal trade/) // the offer's max is not the trade
    const es = await create(escrowService, sellTrade, s.seller, { type: 'MULTISIG', asset: 'BTC', lockedAmount: '0.0007' })
    const eb = await create(escrowService, buyTrade, b.seller, { type: 'MULTISIG', asset: 'BTC', lockedAmount: '0.0009' })
    expect([es.lockedAmount.toString(), eb.lockedAmount.toString()]).toEqual(['0.0007', '0.0009'])
  })

  // ─── refusals, before any write or provider call ──────────────────────────────────────────────────────

  it('T2/T12/T17/T20/T23: a different asset is refused (also another trade\'s asset) — no escrow, no event, no provider call', async () => {
    pg.requirePostgres('T2')
    const { trade: t, buyer } = await trade('BTC', '0.001', 'asset')
    await expectRefusedClean(t, () => create(escrowService, t, sellerOf(t), { asset: 'USDT_ERC20', lockedAmount: '0.001', type: 'MOCK' }), /does not match trade/)
    await expectRefusedClean(t, () => create(escrowService, t, sellerOf(t), { asset: 'LIQUID_BTC', lockedAmount: '0.001' }), /does not match trade/)
  })

  it('T3/T6/T7/T11/T18/T21/T23: any other amount is refused, down to one Decimal(24,8) unit either side, and another trade\'s amount', async () => {
    pg.requirePostgres('T3/T6/T7')
    const { trade: t, buyer } = await trade('BTC', '0.001', 'amount')
    const other = await trade('BTC', '0.5', 'other')
    for (const lockedAmount of ['0.00099999', '0.00100001', '0.002', '500', other.trade.amount.toString(), '0.001000001']) {
      await expectRefusedClean(t, () => create(escrowService, t, sellerOf(t), { type: 'MULTISIG', asset: 'BTC', lockedAmount }), /does not equal trade/)
    }
    // Far inside Decimal(24,8), where binary floating point would collapse the two values.
    const big = await trade('BTC', '9999999999999999.99999999', 'big')
    await expectRefusedClean(big.trade, () => create(escrowService, big.trade, sellerOf(big.trade), { type: 'MOCK', asset: 'BTC', lockedAmount: '9999999999999999.99999998' }), /does not equal trade/)
    expect(Number('9999999999999999.99999999')).toBe(Number('9999999999999999.99999998')) // the collapse the Decimal check avoids
  })

  it('T8/T19/T22: a caller-selected rail other than the trade asset\'s registered one is refused', async () => {
    pg.requirePostgres('T8')
    const { trade: t, buyer } = await trade('BTC', '0.001', 'rail')
    for (const type of ['WDK_USDT_EVM', 'LIGHTNING_HODL', 'SAFE_GUARD_EVM']) {
      await expectRefusedClean(t, () => create(escrowService, t, sellerOf(t), { type, asset: 'BTC', lockedAmount: '0.001' }), /does not match/)
    }
  })

  it.each(UNTRANSLATED)('T9-T14: a %s trade cannot be escrowed on any rail, MOCK and SAFE_GUARD_EVM included', async (asset) => {
    pg.requirePostgres('untranslated')
    const { trade: t, buyer } = await trade(asset, '1', asset)
    for (const type of RAILS) {
      await expectRefusedClean(t, () => create(escrowService, t, sellerOf(t), { ...(type ? { type } : {}), asset, lockedAmount: '1' }), /no authorized settlement translation/)
    }
  })

  // ─── retries, races, nodes ────────────────────────────────────────────────────────────────────────────

  it('T24/T25/T26: after an escrow exists, a retry changing asset, amount or rail cannot alter it', async () => {
    pg.requirePostgres('T24-T26')
    const { trade: t, buyer } = await trade('BTC', '0.003', 'retry')
    const first = await create(escrowService, t, sellerOf(t), { type: 'MULTISIG', asset: 'BTC', lockedAmount: '0.003' })
    for (const input of [
      { type: 'MULTISIG', asset: 'USDT_ERC20', lockedAmount: '0.003' },
      { type: 'MULTISIG', asset: 'BTC', lockedAmount: '0.004' },
      { type: 'WDK_USDT_EVM', asset: 'BTC', lockedAmount: '0.003' },
      { type: 'MULTISIG', asset: 'BTC', lockedAmount: '0.003' }, // even the identical request cannot create a second escrow
    ]) {
      await expect(create(escrowService, t, sellerOf(t), input)).rejects.toThrow()
    }
    const rows = await escrowsOf(t.id)
    expect(rows.map((r) => [r.id, r.type, r.asset, r.lockedAmount.toString()])).toEqual([[first.id, 'MULTISIG', 'BTC', '0.003']])
  })

  it.each([
    ['T27 wrong amount', { type: 'MULTISIG', asset: 'BTC', lockedAmount: '0.0051' }],
    ['T28 wrong asset', { type: 'MULTISIG', asset: 'USDT_ERC20', lockedAmount: '0.005' }],
    ['T29 wrong rail', { type: 'WDK_USDT_EVM', asset: 'BTC', lockedAmount: '0.005' }],
  ])('%s raced against the canonical request: only canonical truth can be persisted', async (_label, wrong) => {
    pg.requirePostgres('T27-T29')
    const { trade: t, buyer, seller } = await trade('BTC', '0.005', 'race')
    const attempts = await Promise.allSettled([
      ...Array.from({ length: 4 }, () => create(escrowService, t, sellerOf(t), wrong)),
      create(escrowService, t, seller, { type: 'MULTISIG', asset: 'BTC', lockedAmount: '0.005' }),
      ...Array.from({ length: 4 }, () => create(escrowService, t, seller, wrong)),
    ])
    const rows = await escrowsOf(t.id)
    expect(rows.map((r) => [r.type, r.asset, r.lockedAmount.toString()])).toEqual([['MULTISIG', 'BTC', '0.005']])
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1)
  })

  it('T30: several canonical requests at once leave exactly one escrow — the database uniqueness on tradeId decides', async () => {
    pg.requirePostgres('T30')
    const { trade: t, buyer, seller } = await trade('BTC', '0.006', 'dup')
    const attempts = await Promise.allSettled(Array.from({ length: 6 }, (_, i) =>
      create(escrowService, t, seller, { type: 'MULTISIG', asset: 'BTC', lockedAmount: '0.006' })))
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1)
    // The losers are refused (by the async trade.escrowId pre-check or, under a real race, the unique index) —
    // not replayed as success; that is today's documented semantics.
    expect(await escrowsOf(t.id)).toHaveLength(1)
  })

  it('T31/T32: node A creates; node B (a fresh module graph, as after a restart) sees the same binding and cannot create, change or race it', async () => {
    pg.requirePostgres('T31/T32')
    const { trade: t, buyer, seller } = await trade('BTC', '0.007', 'nodes')
    const nodeB = (() => {
      let g: any
      jest.isolateModules(() => {
        g = { escrowService: require('../../src/modules/open-settlement/escrow.service').escrowService, redis: require('../../src/common/redis').redis }
      })
      return g
    })()
    try {
      const raced = await Promise.allSettled([
        create(escrowService, t, sellerOf(t), { type: 'MULTISIG', asset: 'BTC', lockedAmount: '0.007' }),
        create(nodeB.escrowService, t, seller, { type: 'MULTISIG', asset: 'BTC', lockedAmount: '0.007' }),
        create(nodeB.escrowService, t, seller, { type: 'MULTISIG', asset: 'BTC', lockedAmount: '0.0071' }),
      ])
      expect(raced.filter((a) => a.status === 'fulfilled')).toHaveLength(1)
      await expect(create(nodeB.escrowService, t, seller, { type: 'MULTISIG', asset: 'BTC', lockedAmount: '0.007' })).rejects.toThrow()
      const rows = await escrowsOf(t.id)
      expect(rows.map((r) => [r.tradeId, r.type, r.asset, r.lockedAmount.toString()])).toEqual([[t.id, 'MULTISIG', 'BTC', '0.007']])
    } finally {
      await nodeB.redis.quit().catch(() => undefined)
    }
  })

  // ─── immutability, legacy, provider parameters ────────────────────────────────────────────────────────

  it('T33/T34: the trade\'s asset and amount are unchanged after the escrow is created, locked and released', async () => {
    pg.requirePostgres('T33/T34')
    const { trade: t, buyer, seller } = await trade('BTC', '0.008', 'immut')
    await prisma.payoutAddress.create({ data: { participantId: buyer.id, asset: 'BTC', address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx' } })
    const e = await create(escrowService, t, sellerOf(t), { type: 'MOCK', asset: 'BTC', lockedAmount: '0.008' })
    await escrowService.lockFunds(e.id, seller.id)
    await escrowService.markPaymentSent(e.id, buyer.id)
    await escrowService.releaseFunds(e.id, undefined, seller.id)
    const after = await prisma.trade.findUniqueOrThrow({ where: { id: t.id } })
    expect([after.asset, after.amount.toString()]).toEqual(['BTC', '0.008'])
  })

  it('T35: a pre-existing (legacy) escrow whose amount differs from its trade is left exactly as it is', async () => {
    pg.requirePostgres('T35')
    const { trade: t, buyer } = await trade('BTC', '0.009', 'legacy')
    // A row as pre-R7F-B code could write it: amount unrelated to the trade.
    const legacy = await prisma.escrow.create({ data: { tradeId: t.id, type: 'MOCK', asset: 'BTC', lockedAmount: '5', timelockHours: 24 } })
    await expect(create(escrowService, t, sellerOf(t), { type: 'MOCK', asset: 'BTC', lockedAmount: '0.009' })).rejects.toThrow()
    const row = await prisma.escrow.findUniqueOrThrow({ where: { id: legacy.id } })
    expect([row.lockedAmount.toString(), row.asset, row.status]).toEqual(['5', 'BTC', 'CREATED'])
  })

  it('provider parameters: MULTISIG funds exactly Trade.amount in sats; WDK transfers exactly Trade.amount in 6-decimal base units', async () => {
    pg.requirePostgres('provider')
    const { trade: t, buyer } = await trade('BTC', '0.12345678', 'prov-btc')
    const e = await create(escrowService, t, sellerOf(t), { type: 'MULTISIG', asset: 'BTC', lockedAmount: '0.12345678' })
    const row = await prisma.escrow.findUniqueOrThrow({ where: { id: e.id } })
    const multisig = getSettlementProvider('MULTISIG') as any
    expect(multisig.requiredFundingSats({ ...row, lockedAmount: row.lockedAmount.toString() })).toBe(12_345_678) // no fee policy: R = T

    const u = await trade('USDT_ERC20', '1234.567891', 'prov-usdt')
    const ue = await create(escrowService, u.trade, sellerOf(u.trade), { type: 'WDK_USDT_EVM', asset: 'USDT_ERC20', lockedAmount: '1234.567891' })
    const { toBaseUnits } = require('../../src/modules/open-settlement/wdk-settlement.provider')
    expect(toBaseUnits(ue.lockedAmount.toString(), 6)).toBe(1_234_567_891n)
  })
})
