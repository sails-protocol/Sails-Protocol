// tests/integration/settlementResultIntegrity.test.ts
//
// Issue #291 - real PostgreSQL proof that the settlement result (provider
// evidence: Escrow.txReleaseId / releasedAt) is mechanically write-once:
//   null -> A allowed; A -> A idempotent (original releasedAt preserved);
//   A -> B fails closed as an integrity conflict - never overwritten, never
//   silently ignored - both through the shared application primitive and
//   against a direct database write that bypasses it.
// Also: the external-success / local-failure boundary no longer reverts the
// escrow when the provider already succeeded.

import { PrismaClient } from '@prisma/client'
import { randomBytes, randomUUID } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'

describe('Issue #291 - settlement result write-once integrity (real PostgreSQL)', () => {
  jest.setTimeout(60_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let escrowRepository: typeof import('../../src/modules/open-settlement/escrow-repository').escrowRepository
  let SettlementResultConflictError: typeof import('../../src/common/errors').SettlementResultConflictError
  let withEscrowFundingLock: typeof import('../../src/modules/open-settlement/escrow-lifecycle').withEscrowFundingLock
  let liquidityRouter: typeof import('../../src/modules/open-liquidity/liquidity.service').liquidityRouter
  let tradeService: typeof import('../../src/modules/open-p2p/trade.service').tradeService
  let escrowService: import('../../src/modules/open-settlement/escrow.service').EscrowService
  let intentEngine: typeof import('../../src/core/intent-engine').intentEngine
  let payoutAddressService: typeof import('../../src/modules/open-settlement/payout-address.service').payoutAddressService
  let eventBus: typeof import('../../src/common/events/event-bus').eventBus

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'true'
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ escrowRepository } = require('../../src/modules/open-settlement/escrow-repository'))
    ;({ SettlementResultConflictError } = require('../../src/common/errors'))
    ;({ withEscrowFundingLock } = require('../../src/modules/open-settlement/escrow-lifecycle'))
    ;({ liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service'))
    ;({ tradeService } = require('../../src/modules/open-p2p/trade.service'))
    ;({ escrowService } = require('../../src/modules/open-settlement/escrow.service'))
    ;({ intentEngine } = require('../../src/core/intent-engine'))
    ;({ payoutAddressService } = require('../../src/modules/open-settlement/payout-address.service'))
    ;({ eventBus } = require('../../src/common/events/event-bus'))
    const { OpenP2PTradeIntentHandler } = require('../../src/modules/open-p2p/intent-handler')
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

  async function newUser() {
    return prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
  }

  async function makeEscrow(status: 'COMPLETED' | 'PAYMENT_PENDING' | 'SPLIT' | 'REFUNDED' = 'COMPLETED') {
    const seller = await newUser()
    const buyer = await newUser()
    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER' })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    const escrow = await prisma.escrow.create({ data: { tradeId: trade.id, type: 'MOCK', status, lockedAmount: '0.001', asset: 'BTC' } })
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id } })
    return { escrowId: escrow.id, tradeId: trade.id, sellerId: seller.id, buyerId: buyer.id }
  }

  const txidA = () => `a${randomUUID().replace(/-/g, '')}`.padEnd(64, 'a')
  const txidB = () => `b${randomUUID().replace(/-/g, '')}`.padEnd(64, 'b')

  it('10 concurrent writers of the SAME result: one persisted result, all converge idempotently, the ORIGINAL releasedAt is preserved', async () => {
    requirePostgres('x10 same result')
    const { escrowId } = await makeEscrow()
    const A = txidA()

    const rows = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        escrowRepository.persistSettlementResult(escrowId, { txReleaseId: A, releasedAt: new Date(Date.now() + i * 1000) })
      )
    )

    expect(new Set(rows.map((r) => r.txReleaseId))).toEqual(new Set([A]))
    const final = (await prisma.escrow.findUnique({ where: { id: escrowId } }))!
    expect(final.txReleaseId).toBe(A)
    const original = final.releasedAt!.getTime()
    // every caller observed the same authoritative timestamp
    expect(new Set(rows.map((r) => r.releasedAt!.getTime()))).toEqual(new Set([original]))

    // a later replay proposing a fresh timestamp changes nothing
    await escrowRepository.persistSettlementResult(escrowId, { txReleaseId: A, releasedAt: new Date(Date.now() + 999_000) })
    expect((await prisma.escrow.findUnique({ where: { id: escrowId } }))!.releasedAt!.getTime()).toBe(original)
  })

  it('concurrent CONFLICTING results A vs B: exactly one value becomes authoritative and every loser receives an explicit integrity conflict', async () => {
    requirePostgres('A vs B race')
    const { escrowId } = await makeEscrow()
    const A = txidA()
    const B = txidB()

    const results = await Promise.allSettled([
      ...Array.from({ length: 5 }, () => escrowRepository.persistSettlementResult(escrowId, { txReleaseId: A, releasedAt: new Date() })),
      ...Array.from({ length: 5 }, () => escrowRepository.persistSettlementResult(escrowId, { txReleaseId: B, releasedAt: new Date() })),
    ])

    const final = (await prisma.escrow.findUnique({ where: { id: escrowId } }))!
    expect([A, B]).toContain(final.txReleaseId)
    const winner = final.txReleaseId!
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
    expect(rejected).toHaveLength(5) // exactly the 5 callers of the losing value
    for (const r of rejected) expect(r.reason).toBeInstanceOf(SettlementResultConflictError)
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5) // the 5 callers of the winning value
    expect(final.txReleaseId).toBe(winner)
  })

  it('DATABASE BYPASS: a direct UPDATE txReleaseId A -> B is rejected by the trigger; so is clearing it, and so is altering a populated releasedAt', async () => {
    requirePostgres('db write-once trigger')
    const { escrowId } = await makeEscrow()
    const A = txidA()
    const stamp = new Date('2026-01-01T00:00:00.000Z')
    await escrowRepository.persistSettlementResult(escrowId, { txReleaseId: A, releasedAt: stamp })

    await expect(prisma.$executeRaw`UPDATE escrows SET "txReleaseId" = ${txidB()} WHERE id = ${escrowId}`).rejects.toThrow(/write-once/)
    await expect(prisma.$executeRaw`UPDATE escrows SET "txReleaseId" = NULL WHERE id = ${escrowId}`).rejects.toThrow(/write-once/)
    await expect(prisma.$executeRaw`UPDATE escrows SET "releasedAt" = NOW() WHERE id = ${escrowId}`).rejects.toThrow(/write-once/)
    await expect(prisma.escrow.update({ where: { id: escrowId }, data: { txReleaseId: txidB() } })).rejects.toThrow(/write-once/)

    // A no-op rewrite of the same value is still allowed, and other columns stay updatable.
    await prisma.$executeRaw`UPDATE escrows SET "txReleaseId" = ${A}, network = 'testnet' WHERE id = ${escrowId}`
    const final = (await prisma.escrow.findUnique({ where: { id: escrowId } }))!
    expect(final.txReleaseId).toBe(A)
    expect(final.releasedAt!.getTime()).toBe(stamp.getTime())
    expect(final.network).toBe('testnet')
  })

  it('a REFUND-style result (no releasedAt) can later be re-recorded idempotently; releasedAt stays unset unless a proposer provides one for an empty slot', async () => {
    requirePostgres('refund shape')
    const { escrowId } = await makeEscrow('REFUNDED')
    const A = txidA()
    const first = await escrowRepository.updateRefundResult(escrowId, A)
    const again = await escrowRepository.updateRefundResult(escrowId, A)
    expect(first.txReleaseId).toBe(A)
    expect(again.txReleaseId).toBe(A)
    expect(again.releasedAt).toBeNull()
    await expect(escrowRepository.updateRefundResult(escrowId, txidB())).rejects.toBeInstanceOf(SettlementResultConflictError)
  })

  it('SPLIT: the joined multi-result representation is unchanged and is compared as-is - same joined value idempotent, a different value or order is a conflict', async () => {
    requirePostgres('split representation')
    const { escrowId } = await makeEscrow('SPLIT')
    const t1 = txidA()
    const t2 = txidB()
    const joined = [t1, t2].join(',')
    await escrowRepository.updateSplitResult(escrowId, { txReleaseId: joined, releasedAt: new Date() })
    await escrowRepository.updateSplitResult(escrowId, { txReleaseId: joined, releasedAt: new Date() }) // idempotent
    await expect(
      escrowRepository.updateSplitResult(escrowId, { txReleaseId: [t2, t1].join(','), releasedAt: new Date() })
    ).rejects.toBeInstanceOf(SettlementResultConflictError)
    expect((await prisma.escrow.findUnique({ where: { id: escrowId } }))!.txReleaseId).toBe(joined)
  })

  it('RECOVERY equivalent: a reconciler-style write under the escrow lock of the SAME result is idempotent; a DIFFERENT one is a conflict, never an overwrite', async () => {
    requirePostgres('recovery writer')
    const { escrowId } = await makeEscrow()
    const A = txidA()
    await escrowRepository.persistSettlementResult(escrowId, { txReleaseId: A, releasedAt: new Date() })

    await withEscrowFundingLock(escrowId, (tx) => escrowRepository.updateSignatureCollectionResult(escrowId, { txReleaseId: A, releasedAt: new Date() }, { tx }))
    await expect(
      withEscrowFundingLock(escrowId, (tx) => escrowRepository.updateSignatureCollectionResult(escrowId, { txReleaseId: txidB(), releasedAt: new Date() }, { tx }))
    ).rejects.toBeInstanceOf(SettlementResultConflictError)
    expect((await prisma.escrow.findUnique({ where: { id: escrowId } }))!.txReleaseId).toBe(A)
  })

  it('OPERATION BINDING: provider evidence is only recorded for the escrow\'s live Sails operation (pending operation id) - a stale/unknown operation id is refused', async () => {
    requirePostgres('operation binding')
    const { escrowId } = await makeEscrow('PAYMENT_PENDING')
    const pending = await prisma.escrowPendingTransaction.create({
      data: { escrowId, kind: 'release', toAddress: 'tb1qexample', unsignedPsbtBase64: 'AAAA', requiredSigners: [], triggeredBy: 'someone' },
    })
    const A = txidA()

    await expect(
      escrowRepository.persistSettlementResult(escrowId, { txReleaseId: A }, { operation: { pendingOperationId: randomUUID() } })
    ).rejects.toBeInstanceOf(SettlementResultConflictError)
    expect((await prisma.escrow.findUnique({ where: { id: escrowId } }))!.txReleaseId).toBeNull()

    await escrowRepository.persistSettlementResult(escrowId, { txReleaseId: A }, { operation: { pendingOperationId: pending.id } })
    expect((await prisma.escrow.findUnique({ where: { id: escrowId } }))!.txReleaseId).toBe(A)
  })

  it('EXTERNAL SUCCESS / LOCAL FAILURE: when the provider already succeeded and a later local step fails, the escrow is NOT reverted (it stays COMPLETED with its result recorded) and reconciliation owns convergence', async () => {
    requirePostgres('no revert after external success')
    const { escrowId, sellerId, buyerId } = await makeEscrow('PAYMENT_PENDING')
    await payoutAddressService.setPayoutAddress(buyerId, 'BTC', 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')

    const emit = jest.spyOn(eventBus, 'emit').mockRejectedValueOnce(new Error('event store unavailable'))
    try {
      await expect(escrowService.releaseFunds(escrowId, undefined, sellerId)).rejects.toThrow(/executed externally .* NOT reverted/)
    } finally {
      emit.mockRestore()
    }

    const after = (await prisma.escrow.findUnique({ where: { id: escrowId } }))!
    expect(after.status).toBe('COMPLETED') // not reverted to PAYMENT_PENDING
    expect(after.txReleaseId).not.toBeNull() // the provider evidence is durably recorded
  })

  it('a provider that FAILS still reverts the claim exactly as before (nothing external happened)', async () => {
    requirePostgres('provider failure still reverts')
    const { escrowId, sellerId, buyerId } = await makeEscrow('PAYMENT_PENDING')
    await payoutAddressService.setPayoutAddress(buyerId, 'BTC', 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')
    const providers = require('../../src/modules/open-settlement/escrow-providers')
    const spy = jest.spyOn(providers, 'getSettlementProvider').mockReturnValueOnce({
      releaseFunds: async () => { throw new Error('rpc down') },
    } as any)
    try {
      await expect(escrowService.releaseFunds(escrowId, undefined, sellerId)).rejects.toThrow(/rpc down/)
    } finally {
      spy.mockRestore()
    }
    const after = (await prisma.escrow.findUnique({ where: { id: escrowId } }))!
    expect(after.status).toBe('PAYMENT_PENDING')
    expect(after.txReleaseId).toBeNull()
  })

  // ── Hardening (PR #320 adversarial pass) ────────────────────────────────────────────────────────

  it('STATUS FREEZE: once the result exists the disposition cannot be converted (COMPLETED -> REFUNDED / SPLIT / back to a live state), even by a direct UPDATE; before a result, the claim is still revertible', async () => {
    requirePostgres('status freeze')
    const { escrowId } = await makeEscrow('COMPLETED')
    // terminal claim WITHOUT a result is a transient claim: reverting it is legitimate
    await prisma.escrow.update({ where: { id: escrowId }, data: { status: 'PAYMENT_PENDING' } })
    await prisma.escrow.update({ where: { id: escrowId }, data: { status: 'COMPLETED' } })
    await escrowRepository.persistSettlementResult(escrowId, { txReleaseId: txidA(), releasedAt: new Date() })

    for (const target of ['REFUNDED', 'SPLIT', 'PAYMENT_PENDING', 'FUNDS_LOCKED', 'DISPUTED']) {
      await expect(prisma.$executeRawUnsafe(`UPDATE escrows SET status = '${target}' WHERE id = '${escrowId}'`)).rejects.toThrow(/status is frozen/)
      await expect(prisma.escrow.updateMany({ where: { id: escrowId }, data: { status: target as any } })).rejects.toThrow(/status is frozen/)
    }
    expect((await prisma.escrow.findUnique({ where: { id: escrowId } }))!.status).toBe('COMPLETED')
    // the repository CAS-revert path cannot undo a persisted result either (it is a status-conditioned updateMany)
    await expect(escrowRepository.revertStatus(escrowId, 'COMPLETED', 'PAYMENT_PENDING')).rejects.toThrow(/status is frozen/)
  })

  it('INDEPENDENT CONNECTIONS: two separate database connections writing DIFFERENT results by raw UPDATE at the same time - exactly one is authoritative, the loser fails without corrupting it', async () => {
    requirePostgres('independent connections')
    const { escrowId } = await makeEscrow('COMPLETED')
    const { PrismaPg } = require('@prisma/adapter-pg')
    const other = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) })
    try {
      const A = txidA(), B = txidB()
      const results = await Promise.allSettled([
        prisma.$executeRaw`UPDATE escrows SET "txReleaseId" = ${A} WHERE id = ${escrowId} AND "txReleaseId" IS NULL`,
        other.$executeRaw`UPDATE escrows SET "txReleaseId" = ${B} WHERE id = ${escrowId} AND "txReleaseId" IS NULL`,
      ])
      // The IS NULL predicate makes the loser a 0-row no-op under READ COMMITTED; a predicate-less writer is
      // rejected by the trigger. Either way exactly one value is authoritative afterwards.
      const stored = (await prisma.escrow.findUnique({ where: { id: escrowId } }))!.txReleaseId
      expect([A, B]).toContain(stored)
      expect(results.filter((r) => r.status === 'fulfilled' && r.value === 1)).toHaveLength(1)
      const loser = stored === A ? B : A
      const loserClient = stored === A ? other : prisma
      await expect(loserClient.$executeRaw`UPDATE escrows SET "txReleaseId" = ${loser} WHERE id = ${escrowId}`).rejects.toThrow(/write-once/)
      expect((await prisma.escrow.findUnique({ where: { id: escrowId } }))!.txReleaseId).toBe(stored)
    } finally {
      await other.$disconnect()
    }
  })

  it('RESTART: a fresh module graph (new process context) sees the durable result and still refuses to overwrite it', async () => {
    requirePostgres('restart write-once')
    const { escrowId } = await makeEscrow('COMPLETED')
    const A = txidA()
    await escrowRepository.persistSettlementResult(escrowId, { txReleaseId: A, releasedAt: new Date() })
    let freshRepo: typeof escrowRepository | undefined
    let freshPrisma: PrismaClient | undefined
    jest.isolateModules(() => {
      freshRepo = require('../../src/modules/open-settlement/escrow-repository').escrowRepository
      freshPrisma = require('../../src/common/database').prisma
    })
    try {
      await expect(freshRepo!.persistSettlementResult(escrowId, { txReleaseId: txidB(), releasedAt: new Date() })).rejects.toThrow()
      await freshRepo!.persistSettlementResult(escrowId, { txReleaseId: A, releasedAt: new Date() }) // same value: idempotent
      expect((await prisma.escrow.findUnique({ where: { id: escrowId } }))!.txReleaseId).toBe(A)
    } finally {
      await freshPrisma!.$disconnect()
    }
  })
})
