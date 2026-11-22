// An escrow's terms are its trade's and its committed pair's (ESCROW_TERMS_MISMATCH), against real PostgreSQL:
// one satoshi more than the admitted trade is refused, and nothing is written (no escrow row, no escrow event).
process.env.MOCK_ESCROW = 'false'
process.env.MULTISIG_SEED = process.env.MULTISIG_SEED || 'escrow-terms-binding-test-seed'

import { PrismaClient } from '@prisma/client'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { createBoundTrade } from './helpers/committedPairFixture'

describe('createEscrow(): escrow terms bound to the trade and its committed pair (real PostgreSQL)', () => {
  jest.setTimeout(60_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let escrowService: typeof import('../../src/modules/open-settlement/escrow.service').escrowService

  beforeAll(async () => {
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ escrowService } = require('../../src/modules/open-settlement/escrow.service'))
  })

  afterAll(async () => {
    if (dbAvailable) await prisma.$disconnect()
  })

  const writes = async (tradeId: string) => ({
    escrows: await prisma.escrow.count({ where: { tradeId } }),
    events: await prisma.escrowEvent.count({ where: { escrow: { tradeId } } }),
  })

  it('one satoshi more than the admitted trade is refused with 409 ESCROW_TERMS_MISMATCH and writes nothing', async () => {
    pg.requirePostgres('escrow terms +1 sat')
    const bound = await createBoundTrade(prisma, { amount: '0.00100000' })
    await bound.commit()
    const before = await writes(bound.trade.id)

    await expect(
      escrowService.createEscrow({ tradeId: bound.trade.id, type: 'MULTISIG' as any, lockedAmount: '0.00100001', asset: 'BTC' as any }, bound.buyer.id)
    ).rejects.toMatchObject({ statusCode: 409, code: 'ESCROW_TERMS_MISMATCH' })

    expect(await writes(bound.trade.id)).toEqual(before)
    expect(before.escrows).toBe(0)
  })

  it('the exact admitted amount, written with a different scale, creates the escrow bound to the committed pair', async () => {
    pg.requirePostgres('escrow terms exact')
    const bound = await createBoundTrade(prisma, { amount: '0.00100000' })
    const pairId = await bound.commit()

    const escrow = await escrowService.createEscrow({ tradeId: bound.trade.id, type: 'MULTISIG' as any, lockedAmount: '0.001', asset: 'BTC' as any }, bound.buyer.id)

    const row = await prisma.escrow.findUniqueOrThrow({ where: { id: escrow.id } })
    expect(row.commitmentPairId).toBe(pairId)
    expect(row.lockedAmount.toString()).toBe('0.001')
  })
})
