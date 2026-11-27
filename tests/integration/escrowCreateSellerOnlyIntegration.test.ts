/**
 * D7 against real PostgreSQL: in `enforce`, the buyer's escrow creation is refused with ESCROW_CREATE_SELLER_ONLY and
 * writes nothing (no escrow, no escrow event, no change to the trade); the seller then creates it normally.
 */
import { PrismaClient } from '@prisma/client'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { createBoundTrade } from './helpers/committedPairFixture'

describe("D7: only the seller creates the escrow (real Postgres)", () => {
  jest.setTimeout(60_000)
  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let escrowService: typeof import('../../src/modules/open-settlement/escrow.service').escrowService
  let config: typeof import('../../src/config').config
  let previous: 'warn' | 'enforce'

  beforeAll(async () => {
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ escrowService } = require('../../src/modules/open-settlement/escrow.service'))
    ;({ config } = require('../../src/config'))
    previous = config.features.escrowCreateSellerOnly
  })
  afterEach(() => { if (dbAvailable) config.features.escrowCreateSellerOnly = previous })
  afterAll(async () => { if (dbAvailable) await prisma.$disconnect() })

  it("enforce: the buyer is refused and nothing is written; the seller then creates the escrow", async () => {
    pg.requirePostgres('D7 enforce')
    config.features.escrowCreateSellerOnly = 'enforce'
    const bound = await createBoundTrade(prisma)
    await bound.commit()
    const input = { tradeId: bound.trade.id, type: 'MULTISIG', lockedAmount: bound.trade.amount.toString(), asset: 'BTC' } as any
    const before = { escrows: await prisma.escrow.count(), events: await prisma.escrowEvent.count(), trade: await prisma.trade.findUniqueOrThrow({ where: { id: bound.trade.id } }) }

    await expect(escrowService.createEscrow(input, bound.buyer.id)).rejects.toMatchObject({ statusCode: 403, code: 'ESCROW_CREATE_SELLER_ONLY' })
    expect(await prisma.escrow.count()).toBe(before.escrows)
    expect(await prisma.escrowEvent.count()).toBe(before.events)
    expect(await prisma.trade.findUniqueOrThrow({ where: { id: bound.trade.id } })).toEqual(before.trade)

    const created = await escrowService.createEscrow(input, bound.seller.id)
    expect(created.tradeId).toBe(bound.trade.id)
    expect(await prisma.escrow.count({ where: { tradeId: bound.trade.id } })).toBe(1)
  })

  it("warn: the buyer still creates the escrow (integrators migrating outside production)", async () => {
    pg.requirePostgres('D7 warn')
    config.features.escrowCreateSellerOnly = 'warn'
    const bound = await createBoundTrade(prisma)
    await bound.commit()
    const onBuyerDeprecated = jest.fn()
    await escrowService.createEscrow({ tradeId: bound.trade.id, type: 'MULTISIG', lockedAmount: bound.trade.amount.toString(), asset: 'BTC' } as any, bound.buyer.id, { onBuyerDeprecated })
    expect(onBuyerDeprecated).toHaveBeenCalledTimes(1)
    expect(await prisma.escrow.count({ where: { tradeId: bound.trade.id } })).toBe(1)
  })
})
