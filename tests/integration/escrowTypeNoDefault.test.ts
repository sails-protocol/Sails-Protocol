/**
 * D030 (CTO 28 Despacho 030) on real PostgreSQL: escrows.type has no default (migration 20261122120000).
 * An INSERT that omits the rail is refused (NOT NULL, SQLSTATE 23502) instead of silently becoming MOCK.
 * Runs in the superuser lane and in the CI restricted step as sails_runtime (direct SQL, no Prisma default).
 */
import { randomBytes, randomUUID } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { createCommitmentFixture } from './helpers/committedPairFixture'

describe('D030 - escrows.type has no default: the rail is always explicit (real PostgreSQL)', () => {
  jest.setTimeout(120_000)
  const pg = createPostgresIntegrationHarness()
  let prisma: any

  beforeAll(async () => {
    await pg.probe()
    if (!pg.isAvailable()) return
    ;({ prisma } = require('../../src/common/database'))
  })
  afterAll(async () => { if (prisma) await prisma.$disconnect() })

  async function trade() {
    const user = () => prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
    const seller = await user(), buyer = await user()
    const offer = await prisma.offer.create({ data: { userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '65000', minAmount: '0.001', maxAmount: '0.01', paymentMethod: 'PIX' } })
    return prisma.trade.create({ data: { offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, asset: 'BTC', amount: '0.005', priceUsd: '65000', totalUsd: '325' } })
  }

  it('the column has no default in the catalog (pg_attrdef) and stays NOT NULL', async () => {
    pg.requirePostgres('D030 catalog')
    const rows = await prisma.$queryRawUnsafe(
      `SELECT a.attnotnull AS "notNull", pg_get_expr(d.adbin, d.adrelid) AS "default"
         FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = 'escrows'::regclass AND a.attname = 'type'`)
    expect(rows).toEqual([{ notNull: true, default: null }])
  })

  it('a direct INSERT without type is refused with 23502 and writes nothing; the same INSERT with an explicit type passes', async () => {
    pg.requirePostgres('D030 insert')
    const t = await trade()
    const before = await prisma.escrow.count()
    await expect(prisma.$executeRawUnsafe(
      `INSERT INTO escrows (id, "tradeId", "lockedAmount", asset, "updatedAt") VALUES ($1, $2, 0.005, 'BTC', now())`, randomUUID(), t.id,
    )).rejects.toThrow(/23502/) // not_null_violation, matched by SQLSTATE (locale-independent)
    expect(await prisma.escrow.count()).toBe(before)
    // F4b: a non-MOCK escrow needs the COMMITTED pair of its own trade, so the "explicit type passes" half uses a real committed pair.
    const { tradeId, pairId } = await (await createCommitmentFixture(prisma, { seed: 0x65 })).committedPair()
    await expect(prisma.$executeRawUnsafe(
      `INSERT INTO escrows (id, "tradeId", type, "lockedAmount", asset, "commitmentPairId", "updatedAt") VALUES ($1, $2, 'MULTISIG', 0.005, 'BTC', $3, now())`, randomUUID(), tradeId, pairId,
    )).resolves.toBe(1)
    expect((await prisma.escrow.findUnique({ where: { tradeId } })).type).toBe('MULTISIG')
  })
})
