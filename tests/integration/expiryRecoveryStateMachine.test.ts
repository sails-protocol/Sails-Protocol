// tests/integration/expiryRecoveryStateMachine.test.ts
//
// Missão 11 Fase 7.3.3 §B/§D — real-Postgres proof of the Generation-1
// expiry-recovery state machine: the real EscrowStatus.EXPIRED enum
// value, the real claimEscrowTransition() atomic update against it, the
// real VALID_TRANSITIONS wiring (FUNDS_LOCKED -> EXPIRED -> DISPUTED),
// and the real EscrowEvent hash chain remaining coherent across both
// transitions. The arbiter-commitment/script-signing authority logic
// itself is already proven against real crypto elsewhere
// (escrowArbiterCommitmentIntegration.test.ts, multisigProvider.test.ts,
// unaffected by this phase's changes) — this file focuses on the state
// machine and event-chain properties this phase's own mandate named.

import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { boundOfferRow, boundTradeRow, sellerPixAccount } from './economicFixtures'

describe('Generation-1 expiry-recovery state machine (Missão 11 Fase 7.3.3, real Postgres)', () => {
  jest.setTimeout(60_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: import('@prisma/client').PrismaClient
  let escrowService: typeof import('../../src/modules/open-settlement/escrow.service').escrowService
  let getDisputeService: typeof import('../../src/modules/open-settlement/dispute.service').getDisputeService
  let verifyEscrowEventChain: typeof import('../../src/modules/open-settlement/escrow-lifecycle').verifyEscrowEventChain

  beforeAll(async () => {
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ escrowService } = require('../../src/modules/open-settlement/escrow.service'))
    ;({ getDisputeService } = require('../../src/modules/open-settlement/dispute.service'))
    ;({ verifyEscrowEventChain } = require('../../src/modules/open-settlement/escrow-lifecycle'))
  })

  afterAll(async () => {
    if (dbAvailable) await prisma.$disconnect()
  })

  function requirePostgres(name: string): void {
    pg.requirePostgres(name)
  }

  function suffix() { return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }

  async function fixtureExpiredMultisigEscrow() {
    const s = suffix()
    const buyer = await prisma.user.create({ data: { publicKey: `pk-buyer-expiry-${s}` } })
    const seller = await prisma.user.create({ data: { publicKey: `pk-seller-expiry-${s}` } })
    const acct = await sellerPixAccount(prisma, seller.id)
    const offer = await prisma.offer.create({ data: { userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '65000', minAmount: '0.001', maxAmount: '1', ...boundOfferRow(acct) } })
    const trade = await prisma.trade.create({ data: { ...boundTradeRow(acct), offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, asset: 'BTC', amount: '0.001', priceUsd: '65000', totalUsd: '65' } })
    const escrow = await prisma.escrow.create({
      data: {
        tradeId: trade.id, type: 'MULTISIG', status: 'FUNDS_LOCKED', asset: 'BTC', lockedAmount: '0.001',
        timelockHours: 1, expiresAt: new Date(Date.now() - 60_000), // already expired
        txLockId: require('crypto').randomBytes(32).toString('hex'), txLockVout: 0, // #235 R7G F8A: as lockFunds() writes it
      },
    })
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id } })
    return { buyer, seller, trade, escrow }
  }

  it('the real EscrowStatus enum accepts EXPIRED, and claimEscrowTransition() atomically writes it via the real repository', async () => {
    requirePostgres('real EXPIRED enum + transition')
    const { escrow } = await fixtureExpiredMultisigEscrow()

    const result = await escrowService.sweepExpiredEscrows()

    expect(result.requiresManualRecovery).toContain(escrow.id)
    const updated = await prisma.escrow.findUniqueOrThrow({ where: { id: escrow.id } })
    expect(updated.status).toBe('EXPIRED')
  })

  it('a repeated real sweep tick never re-finds an already-EXPIRED escrow — idempotent by query scope against real Postgres', async () => {
    requirePostgres('idempotent repeat sweep')
    const { escrow } = await fixtureExpiredMultisigEscrow()

    await escrowService.sweepExpiredEscrows()
    const second = await escrowService.sweepExpiredEscrows()

    expect(second.requiresManualRecovery).not.toContain(escrow.id)
    expect(second.failed.find((f) => f.escrowId === escrow.id)).toBeUndefined()
  })

  it('the real EscrowEvent hash chain remains coherent across FUNDS_LOCKED -> EXPIRED -> DISPUTED', async () => {
    requirePostgres('event chain coherence')
    const { seller, trade, escrow } = await fixtureExpiredMultisigEscrow()

    await escrowService.sweepExpiredEscrows()
    await getDisputeService().initiateExpiryRecovery(escrow.id, seller.id)

    const finalEscrow = await prisma.escrow.findUniqueOrThrow({ where: { id: escrow.id } })
    expect(finalEscrow.status).toBe('DISPUTED')

    const verification = await verifyEscrowEventChain(escrow.id)
    expect(verification.valid).toBe(true)

    const events = await prisma.escrowEvent.findMany({ where: { escrowId: escrow.id }, orderBy: { createdAt: 'asc' } })
    expect(events.map((e) => `${e.fromStatus}->${e.toStatus}`)).toEqual(['FUNDS_LOCKED->EXPIRED', 'EXPIRED->DISPUTED'])
    // The system's own transition is honestly attributed — never the
    // seller's real id, never a fabricated participant identity.
    expect(events[0].triggeredBy).toBe('system:expiry-sweeper')
    expect(events[1].triggeredBy).toBe(seller.id)
    void trade
  })

  it('the buyer cannot exercise the seller\'s real, authenticated expiry-recovery authority against a real Postgres-backed escrow', async () => {
    requirePostgres('buyer forbidden, real DB')
    const { buyer, escrow } = await fixtureExpiredMultisigEscrow()
    await escrowService.sweepExpiredEscrows()

    await expect(getDisputeService().initiateExpiryRecovery(escrow.id, buyer.id)).rejects.toThrow(/is not the seller of trade/)

    const stillExpired = await prisma.escrow.findUniqueOrThrow({ where: { id: escrow.id } })
    expect(stillExpired.status).toBe('EXPIRED')
  })

  it('existing historical (non-EXPIRED) escrows remain fully interpretable — the additive enum value changes nothing about them', async () => {
    requirePostgres('historical escrow unaffected')
    const s = suffix()
    const buyer = await prisma.user.create({ data: { publicKey: `pk-buyer-hist-${s}` } })
    const seller = await prisma.user.create({ data: { publicKey: `pk-seller-hist-${s}` } })
    const acct = await sellerPixAccount(prisma, seller.id)
    const offer = await prisma.offer.create({ data: { userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '65000', minAmount: '0.001', maxAmount: '1', ...boundOfferRow(acct) } })
    const trade = await prisma.trade.create({ data: { ...boundTradeRow(acct), offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, asset: 'BTC', amount: '0.001', priceUsd: '65000', totalUsd: '65' } })
    const historicalEscrow = await prisma.escrow.create({
      data: { tradeId: trade.id, type: 'MOCK', status: 'COMPLETED', asset: 'BTC', lockedAmount: '0.001' },
    })

    const reread = await prisma.escrow.findUniqueOrThrow({ where: { id: historicalEscrow.id } })
    expect(reread.status).toBe('COMPLETED')
    const result = await escrowService.sweepExpiredEscrows()
    expect(result.refunded).not.toContain(historicalEscrow.id)
    expect(result.requiresManualRecovery).not.toContain(historicalEscrow.id)
  })
})
