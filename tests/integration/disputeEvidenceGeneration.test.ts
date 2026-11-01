// #309 — real-Postgres evidence-generation binding (restacked from PR #357 onto #367's atomic append).
// Every accepted evidence append increments evidenceGeneration in the same UPDATE, the durable
// dispute.evidence_submitted event carries the generation that append committed, and a QVAC
// recommendation can only propose an automated resolution for the exact generation it assessed.
import { PrismaClient } from '@prisma/client'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { boundOfferInput, sellerPixAccount } from './economicFixtures'
import { registerTestParticipant, closeTestRedis } from './identityTestHelpers'

describe('#309 dispute evidence generation — real Postgres', () => {
  jest.setTimeout(60_000)
  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let escrowService: import('../../src/modules/open-settlement/escrow.service').EscrowService
  let identityService: typeof import('../../src/modules/open-identity/identity.service').identityService
  let liquidityRouter: typeof import('../../src/modules/open-liquidity/liquidity.service').liquidityRouter
  let tradeService: typeof import('../../src/modules/open-p2p/trade.service').tradeService
  let getDisputeService: typeof import('../../src/modules/open-settlement/dispute.service').getDisputeService

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'true'
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ escrowService } = require('../../src/modules/open-settlement/escrow.service'))
    ;({ identityService } = require('../../src/modules/open-identity/identity.service'))
    ;({ liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service'))
    ;({ tradeService } = require('../../src/modules/open-p2p/trade.service'))
    ;({ getDisputeService } = require('../../src/modules/open-settlement/dispute.service'))
    const { intentEngine } = require('../../src/core/intent-engine')
    const { OpenP2PTradeIntentHandler } = require('../../src/modules/open-p2p/intent-handler')
    intentEngine.registerHandler(OpenP2PTradeIntentHandler)
  })

  afterAll(async () => {
    if (dbAvailable) {
      await prisma.$disconnect()
      await closeTestRedis()
    }
  })

  async function fixture(suffix: string) {
    const seller = await registerTestParticipant(identityService, 'Seller')
    const buyer = await registerTestParticipant(identityService, 'Buyer')
    const offer = await liquidityRouter.createOffer({
      userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', ...boundOfferInput(await sellerPixAccount(prisma, seller.id)),
    })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    const escrow = await escrowService.createEscrow({ tradeId: trade.id, type: 'MOCK', lockedAmount: '0.001', asset: 'BTC' }, seller.id)
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id } })
    const dispute = await prisma.dispute.create({
      data: { tradeId: trade.id, escrowId: escrow.id, openedBy: buyer.id, reason: `#309-${suffix}`, arbiterId: seller.id, status: 'OPENED' },
    })
    return { dispute, buyer, seller, tradeId: trade.id }
  }

  const eventGenerations = async (disputeId: string) => (await prisma.$queryRaw<Array<{ g: number | null }>>`
    SELECT (payload->>'evidenceGeneration')::int AS g FROM durable_events
    WHERE "eventName" = 'dispute.evidence_submitted' AND payload->>'disputeId' = ${disputeId}`).map((r) => r.g)

  it('ten concurrent submissions: every entry survives, the generation reaches 10, and each event carries the distinct generation its append committed', async () => {
    pg.requirePostgres('concurrent evidence generations')
    const { dispute, buyer, seller } = await fixture('ten')
    await Promise.all(Array.from({ length: 10 }, (_, i) =>
      getDisputeService().submitEvidence(dispute.id, i % 2 === 0 ? buyer.id : seller.id, { type: 'chat_log', note: `concurrent-evidence-${i}` })))

    const row = await prisma.dispute.findUniqueOrThrow({ where: { id: dispute.id } })
    const evidence = Array.isArray(row.evidence) ? row.evidence as Array<{ note?: string }> : []
    expect(row.evidenceGeneration).toBe(10)
    expect(new Set(evidence.map((e) => e.note))).toEqual(new Set(Array.from({ length: 10 }, (_, i) => `concurrent-evidence-${i}`)))
    expect((await eventGenerations(dispute.id)).sort((a, b) => a! - b!)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('a recommendation for a stale evidence generation proposes nothing; the current generation can be proposed', async () => {
    pg.requirePostgres('stale assessment')
    const { dispute, buyer } = await fixture('stale-assessment')
    await getDisputeService().submitEvidence(dispute.id, buyer.id, { type: 'chat_log', note: 'first' })
    await getDisputeService().submitEvidence(dispute.id, buyer.id, { type: 'chat_log', note: 'second' })
    expect((await prisma.dispute.findUniqueOrThrow({ where: { id: dispute.id } })).evidenceGeneration).toBe(2)

    // QVAC assessed generation 1; generation 2 arrived meanwhile
    expect(await getDisputeService().proposeAutoResolution(dispute.id, 'RELEASE', 0.95, 'assessed the first snapshot', 1)).toBeNull()
    const untouched = await prisma.dispute.findUniqueOrThrow({ where: { id: dispute.id } })
    expect(untouched.status).toBe('EVIDENCE_SUBMITTED')
    expect(untouched.autoResolutionRecommendation).toBeNull()

    const proposed = await getDisputeService().proposeAutoResolution(dispute.id, 'RELEASE', 0.95, 'assessed the current snapshot', 2)
    expect(proposed!.status).toBe('AUTO_PROPOSED')
  })

  it('evidence submitted after the dispute left evidence gathering changes nothing, generation included', async () => {
    pg.requirePostgres('closed dispute')
    const { dispute, buyer } = await fixture('closed')
    await prisma.dispute.update({ where: { id: dispute.id }, data: { status: 'RESOLVED', ruling: 'REFUND', resolvedAt: new Date() } })
    await expect(getDisputeService().submitEvidence(dispute.id, buyer.id, { type: 'chat_log', note: 'late' })).rejects.toThrow(/cannot accept new evidence/)
    const row = await prisma.dispute.findUniqueOrThrow({ where: { id: dispute.id } })
    expect([row.status, row.evidenceGeneration]).toEqual(['RESOLVED', 0])
  })
})
