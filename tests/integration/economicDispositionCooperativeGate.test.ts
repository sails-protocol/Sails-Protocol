// tests/integration/economicDispositionCooperativeGate.test.ts
//
// ADR-005 - a pending operation with no recorded ruling generation may execute only when it is provably
// cooperative. "No Dispute row exists" is not that proof on its own: openDispute() moves the escrow to DISPUTED
// before raiseDispute() writes the Dispute row, and a row can be deleted. A seller-initiated release whose last
// signature arrives in that state would move funds out of a disputed escrow.

import { PrismaClient } from '@prisma/client'
import { randomBytes, randomUUID } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'

describe('ADR-005 gate: a cooperative pending operation never executes on a disputed escrow (real PostgreSQL)', () => {
  jest.setTimeout(120_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let liquidityRouter: typeof import('../../src/modules/open-liquidity/liquidity.service').liquidityRouter
  let tradeService: typeof import('../../src/modules/open-p2p/trade.service').tradeService
  let escrowService: typeof import('../../src/modules/open-settlement/escrow.service').escrowService
  let lightningHodlProvider: typeof import('../../src/modules/open-settlement/lightning-hodl.provider').lightningHodlProvider
  let emitEscrowTransition: typeof import('../../src/modules/open-settlement/escrow-lifecycle').emitEscrowTransition

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'true'
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service'))
    ;({ tradeService } = require('../../src/modules/open-p2p/trade.service'))
    ;({ escrowService } = require('../../src/modules/open-settlement/escrow.service'))
    ;({ lightningHodlProvider } = require('../../src/modules/open-settlement/lightning-hodl.provider'))
    ;({ emitEscrowTransition } = require('../../src/modules/open-settlement/escrow-lifecycle'))
    const { intentEngine } = require('../../src/core/intent-engine')
    const { OpenP2PTradeIntentHandler } = require('../../src/modules/open-p2p/intent-handler')
    intentEngine.registerHandler(OpenP2PTradeIntentHandler)
  })

  afterEach(() => jest.restoreAllMocks())

  afterAll(async () => {
    if (dbAvailable) {
      await prisma.$disconnect()
      await closeTestRedis()
    }
  })

  // A seller-initiated release, pending its buyer signature, on an escrow that was PAYMENT_PENDING when it began.
  async function makeCooperativePending() {
    const buyer = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
    const seller = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER' })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    const escrow = await prisma.escrow.create({ data: { tradeId: trade.id, type: 'LIGHTNING_HODL', status: 'PAYMENT_PENDING', lockedAmount: '0.001', asset: 'BTC' } })
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id, status: 'ACTIVE' } })
    await prisma.escrowPendingTransaction.create({
      data: { escrowId: escrow.id, kind: 'release', toAddress: 'dest-address', requiredSigners: ['buyer-signer'], triggeredBy: seller.id, unsignedPsbtBase64: 'unsigned-bundle-b64' },
    })
    const finalize = jest.spyOn(lightningHodlProvider as any, 'finalizeRelease').mockResolvedValue({ txId: `0x${randomUUID().replace(/-/g, '')}` })
    return { buyer, seller, trade, escrow, finalize }
  }

  // What openDispute() does: the escrow becomes DISPUTED through a recorded transition.
  async function openDispute(fixture: Awaited<ReturnType<typeof makeCooperativePending>>) {
    await prisma.escrow.update({ where: { id: fixture.escrow.id }, data: { status: 'DISPUTED' } })
    await emitEscrowTransition(fixture.escrow.id, fixture.trade.id, 'PAYMENT_PENDING', 'DISPUTED', fixture.buyer.id, 'settlement.escrow.disputed' as never, {})
  }

  async function expectRefusedBeforeTheProvider(fixture: Awaited<ReturnType<typeof makeCooperativePending>>) {
    await expect(escrowService.submitTransactionSignature(fixture.escrow.id, 'buyer-signer', 'signed-bundle')).rejects.toThrow(/ADR-005/)
    expect(fixture.finalize).not.toHaveBeenCalled()
    expect((await prisma.escrow.findUniqueOrThrow({ where: { id: fixture.escrow.id } })).status).toBe('DISPUTED')
    expect(await prisma.escrowPendingTransaction.count({ where: { escrowId: fixture.escrow.id } })).toBe(1)
  }

  it('refuses when the escrow is DISPUTED but raiseDispute() has not written the Dispute row yet', async () => {
    pg.requirePostgres('dispute opened, row not yet written')
    const fixture = await makeCooperativePending()
    await openDispute(fixture)

    await expectRefusedBeforeTheProvider(fixture)
  })

  it('refuses when the Dispute row of a disputed escrow was deleted', async () => {
    pg.requirePostgres('dispute row deleted')
    const fixture = await makeCooperativePending()
    await openDispute(fixture)
    await prisma.dispute.create({ data: { tradeId: fixture.trade.id, escrowId: fixture.escrow.id, openedBy: fixture.buyer.id, reason: 'payment not received' } })
    await prisma.dispute.deleteMany({ where: { escrowId: fixture.escrow.id } })

    await expectRefusedBeforeTheProvider(fixture)
  })

  it('still executes a cooperative release on an escrow that was never disputed', async () => {
    pg.requirePostgres('cooperative release')
    const fixture = await makeCooperativePending()

    const result = await escrowService.submitTransactionSignature(fixture.escrow.id, 'buyer-signer', 'signed-bundle')

    expect(result.complete).toBe(true)
    expect(fixture.finalize).toHaveBeenCalledTimes(1)
    expect((await prisma.escrow.findUniqueOrThrow({ where: { id: fixture.escrow.id } })).status).toBe('COMPLETED')
  })
})
