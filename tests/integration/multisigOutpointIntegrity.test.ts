// tests/integration/multisigOutpointIntegrity.test.ts
//
// Missão 10, Fase 3, items 7 and 10 — real-Postgres proof that the
// database itself (not an application-level check-then-write) prevents
// two different escrows from ever claiming the identical Bitcoin
// outpoint.
//
// Missão 11 Fase 6.3B.1 — connectivity, authorization, and the fail-loud
// requirePostgres() contract come from the shared
// tests/integration/postgresTestHarness.ts (this file used to fall back
// to a stale, permanently-unreachable ":5433" connection string and
// silently report "passed" with zero assertions run — closed, not
// merely relocated).

import { PrismaClient } from '@prisma/client'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { registerTestParticipant, closeTestRedis } from './identityTestHelpers'
import { MULTISIG_CAPABILITY_PROFILE_V1 } from '@satsails/p2p-schemas'

describe('MULTISIG outpoint integrity — real Postgres (Missão 10)', () => {
  jest.setTimeout(30_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let escrowService: import('../../src/modules/open-settlement/escrow.service').EscrowService
  let identityService: typeof import('../../src/modules/open-identity/identity.service').identityService
  let liquidityRouter: typeof import('../../src/modules/open-liquidity/liquidity.service').liquidityRouter
  let tradeService: typeof import('../../src/modules/open-p2p/trade.service').tradeService
  let intentEngine: typeof import('../../src/core/intent-engine').intentEngine
  let OpenP2PTradeIntentHandler: any

  const BUYER_PUBKEY_A = '021744d7bd3cd8e7f62e7aa8f7db8292680b745d09f8f40377c4bbbc0136d4e299'
  const SELLER_PUBKEY_A = '038e41e2cb09677fd4bde9f232871533925c4b628c25efdb9d572546293850ddd4'
  const BUYER_PUBKEY_B = '03a8f0fdc9911d8e33f58b1fced67b769189f2188431515e5171462522cb1be87b'
  const SELLER_PUBKEY_B = '022704740d198905f841d3c4a82afd828398130d62190d9142761158eb893c9419'
  // Suffixed with a per-run timestamp, not a fixed literal — this test
  // hits the real, persistent dev Postgres (not a fresh/truncated DB per
  // run), so a fixed txid would collide with the previous run's own row
  // via the very unique constraint this test exists to prove, making the
  // test fail on any second consecutive run rather than on a real
  // regression. Discovered by actually re-running the suite twice in a
  // row, not assumed.
  const RUN_ID = Date.now().toString(36)
  const RACE_TXID = `race${RUN_ID}`.padEnd(64, 'a')

  let realFetch: typeof fetch

  // Missão 11 Fase 8.1 LB-02 — lockFunds() now makes two more explorer
  // calls beyond the UTXO listing (fetchTransactionConfirmationStatus,
  // fetchChainTipHeight) to verify real confirmation depth. This test's
  // fetch mock must route by URL shape (not a single blanket response)
  // so all three calls resolve correctly regardless of which escrow's
  // concurrent lockFunds() call is making them.
  function mockExplorerForUtxo(txid: string, vout: number, valueSats: number): void {
    global.fetch = jest.fn(async (url: string) => {
      if (url.includes('/blocks/tip/height')) return { ok: true, text: async () => '100' } as any
      if (url.includes(`/tx/${txid}/status`)) return { ok: true, json: async () => ({ confirmed: true, block_height: 100 }) } as any
      return { ok: true, json: async () => [{ txid, vout, value: valueSats, status: { confirmed: true } }] } as any
    }) as any
  }

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'false'
    process.env.MULTISIG_SEED = process.env.MULTISIG_SEED || 'outpoint-integrity-test-seed'
    process.env.TRUSTED_ARBITRATORS = process.env.TRUSTED_ARBITRATORS || 'outpoint-test-arbiter'

    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return

    ;({ prisma } = require('../../src/common/database'))
    ;({ escrowService } = require('../../src/modules/open-settlement/escrow.service'))
    ;({ identityService } = require('../../src/modules/open-identity/identity.service'))
    ;({ liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service'))
    ;({ tradeService } = require('../../src/modules/open-p2p/trade.service'))
    ;({ intentEngine } = require('../../src/core/intent-engine'))
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

  beforeEach(() => {
    realFetch = global.fetch
  })
  afterEach(() => {
    global.fetch = realFetch
  })

  async function makeMultisigEscrow(suffix: string, buyerPubkey: string, sellerPubkey: string) {
    const seller = await registerTestParticipant(identityService, 'Seller')
    const buyer = await registerTestParticipant(identityService, 'Buyer')
    const offer = await liquidityRouter.createOffer({
      userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER',
    })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    const escrow = await escrowService.createEscrow({ tradeId: trade.id, type: 'MULTISIG', lockedAmount: '0.001', asset: 'BTC' }, seller.id)
    // Missão 11 Fase 9.1.1 — fail-closed capability declaration required.
    await escrowService.submitParticipantKey(escrow.id, buyer.id, buyerPubkey, MULTISIG_CAPABILITY_PROFILE_V1)
    await escrowService.submitParticipantKey(escrow.id, seller.id, sellerPubkey, MULTISIG_CAPABILITY_PROFILE_V1)
    return { escrowId: escrow.id, sellerId: seller.id }
  }

  // Item 10 — two different escrows racing to lock funds against the
  // SAME funding outpoint (mocked explorer returns the identical
  // txid:vout for both). This is the exact scenario a shared multisig
  // address (however unlikely) or explorer-response confusion would
  // produce — proving the database itself, not request ordering, is
  // what decides the outcome.
  it('item 10: concurrent lockFunds() on two different escrows for the identical outpoint — exactly one wins', async () => {
    requirePostgres('concurrent double-claim')

    const a = await makeMultisigEscrow('race-a', BUYER_PUBKEY_A, SELLER_PUBKEY_A)
    const b = await makeMultisigEscrow('race-b', BUYER_PUBKEY_B, SELLER_PUBKEY_B)

    // Both escrows' lockFunds() will independently query the explorer for
    // THEIR OWN derived address, but both mocked responses report the
    // same outpoint — modeling the case a persisted-outpoint check exists
    // specifically to guard against.
    mockExplorerForUtxo(RACE_TXID, 7, 100_000)

    const results = await Promise.allSettled([
      escrowService.lockFunds(a.escrowId, a.sellerId),
      escrowService.lockFunds(b.escrowId, b.sellerId),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/already claimed/)

    // The losing escrow must NOT be left half-claiming FUNDS_LOCKED with
    // no real lock behind it (lockFunds()'s existing revert-on-failure
    // path, exercised here for a NEW failure mode it didn't previously
    // need to handle).
    const loserEscrowId = fulfilled[0].status === 'fulfilled' && (fulfilled[0].value as any).id === a.escrowId ? b.escrowId : a.escrowId
    const loserRow = await prisma.escrow.findUnique({ where: { id: loserEscrowId } })
    expect(loserRow!.status).toBe('CREATED')
    expect(loserRow!.txLockId).toBeNull()

    const winnerEscrowId = loserEscrowId === a.escrowId ? b.escrowId : a.escrowId
    const winnerRow = await prisma.escrow.findUnique({ where: { id: winnerEscrowId } })
    expect(winnerRow!.status).toBe('FUNDS_LOCKED')
    expect(winnerRow!.txLockId).toBe(RACE_TXID)
    expect(winnerRow!.txLockVout).toBe(7)
  })

  // Item 7 — sequential (not concurrent) double-claim: a second, later
  // escrow explicitly tries to lock funds against an outpoint the first
  // one already holds. Proves the protection isn't only a race-timing
  // artifact — it holds even when the second attempt is fully
  // sequential and could see the first row already committed.
  it('item 7: a second escrow cannot claim an outpoint already locked by a completed first escrow', async () => {
    requirePostgres('sequential double-claim')

    const a = await makeMultisigEscrow('seq-a', BUYER_PUBKEY_A, SELLER_PUBKEY_A)
    const sequentialTxid = `seq${RUN_ID}`.padEnd(64, 'b')
    mockExplorerForUtxo(sequentialTxid, 1, 100_000)
    await escrowService.lockFunds(a.escrowId, a.sellerId)

    const b = await makeMultisigEscrow('seq-b', BUYER_PUBKEY_B, SELLER_PUBKEY_B)
    await expect(escrowService.lockFunds(b.escrowId, b.sellerId)).rejects.toThrow(/already claimed/)

    const bRow = await prisma.escrow.findUnique({ where: { id: b.escrowId } })
    expect(bRow!.status).toBe('CREATED') // reverted, not stuck claiming FUNDS_LOCKED
  })
})
