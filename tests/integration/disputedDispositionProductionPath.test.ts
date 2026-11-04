// tests/integration/disputedDispositionProductionPath.test.ts
//
// #341 requirement 1: on LIGHTNING_HODL and SAFE_GUARD_EVM, a disputed ruling reaches the provider's external
// effect only after its provenance is durably committed, proven on real PostgreSQL through the production path:
//   raiseDispute() -> resolveDispute() (real Ed25519 authority signature) -> applyRuling()
//   -> initiateRelease()/initiateRefund() -> submitTransactionSignature() -> ADR-005 gate -> finalize*().
// Nothing on the pending row or the authorization is written by this test.
//
// Provider boundary only: buildUnsigned*() (needs Ark/bundler infrastructure) returns a fixed bundle, and
// finalize*() is the external effect. Inside finalize*(), a SEPARATE PostgreSQL connection checks what is
// committed at that instant: the pending row's frozen ruling generation and its EconomicDispositionAuthorization.

import { PrismaClient } from '@prisma/client'
import { Client } from 'pg'
import nacl from 'tweetnacl'
import { randomBytes, randomUUID } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'

type Rail = 'LIGHTNING_HODL' | 'SAFE_GUARD_EVM'

describe('#341 requirement 1: disputed LIGHTNING_HODL/SAFE_GUARD_EVM provenance is committed before the external effect (real PostgreSQL, production path)', () => {
  jest.setTimeout(120_000)

  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let observer: Client
  let liquidityRouter: typeof import('../../src/modules/open-liquidity/liquidity.service').liquidityRouter
  let tradeService: typeof import('../../src/modules/open-p2p/trade.service').tradeService
  let escrowService: typeof import('../../src/modules/open-settlement/escrow.service').escrowService
  let DisputeService: typeof import('../../src/modules/open-settlement/dispute.service').DisputeService
  let TrustedArbitratorProvider: typeof import('../../src/modules/open-settlement/arbitration-provider').TrustedArbitratorProvider
  let signAuthorityDecision: typeof import('../../src/modules/open-settlement/arbitration-authority').signAuthorityDecision
  let economicDispositionOperationDigest: typeof import('../../src/modules/open-settlement/economic-disposition-authority').economicDispositionOperationDigest
  let lightningHodlProvider: typeof import('../../src/modules/open-settlement/lightning-hodl.provider').lightningHodlProvider
  let safeGuardEvmProvider: typeof import('../../src/modules/open-settlement/safe-guard-evm.provider').safeGuardEvmProvider

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'true'
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service'))
    ;({ tradeService } = require('../../src/modules/open-p2p/trade.service'))
    ;({ escrowService } = require('../../src/modules/open-settlement/escrow.service'))
    ;({ DisputeService } = require('../../src/modules/open-settlement/dispute.service'))
    ;({ TrustedArbitratorProvider } = require('../../src/modules/open-settlement/arbitration-provider'))
    ;({ signAuthorityDecision } = require('../../src/modules/open-settlement/arbitration-authority'))
    ;({ economicDispositionOperationDigest } = require('../../src/modules/open-settlement/economic-disposition-authority'))
    ;({ lightningHodlProvider } = require('../../src/modules/open-settlement/lightning-hodl.provider'))
    ;({ safeGuardEvmProvider } = require('../../src/modules/open-settlement/safe-guard-evm.provider'))
    const { intentEngine } = require('../../src/core/intent-engine')
    const { OpenP2PTradeIntentHandler } = require('../../src/modules/open-p2p/intent-handler')
    intentEngine.registerHandler(OpenP2PTradeIntentHandler)
    observer = new Client({ connectionString: process.env.DATABASE_URL })
    await observer.connect()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  afterAll(async () => {
    if (dbAvailable) {
      await observer.end()
      await prisma.$disconnect()
      await closeTestRedis()
    }
  })

  let createdEscrowIds: string[] = []
  let createdTradeIds: string[] = []
  let createdUserIds: string[] = []
  beforeEach(() => {
    createdEscrowIds = []
    createdTradeIds = []
    createdUserIds = []
  })

  afterEach(async () => {
    if (!dbAvailable) return
    if (createdEscrowIds.length) {
      const pendingIds = (await prisma.escrowPendingTransaction.findMany({ where: { escrowId: { in: createdEscrowIds } }, select: { id: true } })).map((p) => p.id)
      await prisma.escrowTransactionSignature.deleteMany({ where: { pendingTxId: { in: pendingIds } } })
      await prisma.escrowPendingTransaction.deleteMany({ where: { escrowId: { in: createdEscrowIds } } })
      await prisma.economicDispositionAuthorization.deleteMany({ where: { escrowId: { in: createdEscrowIds } } })
      await prisma.capabilityExecutionAuthorization.deleteMany({ where: { escrowId: { in: createdEscrowIds } } })
      const disputeIds = (await prisma.dispute.findMany({ where: { escrowId: { in: createdEscrowIds } }, select: { id: true } })).map((d) => d.id)
      if (disputeIds.length) await prisma.disputeAppealFee.deleteMany({ where: { disputeId: { in: disputeIds } } })
      await prisma.dispute.deleteMany({ where: { escrowId: { in: createdEscrowIds } } })
      const transitions = await prisma.escrowEvent.findMany({ where: { escrowId: { in: createdEscrowIds } }, select: { id: true } })
      if (transitions.length) await prisma.eventProjectionClaim.deleteMany({ where: { subjectId: { in: transitions.map((t) => t.id) } } })
      await prisma.escrowEvent.deleteMany({ where: { escrowId: { in: createdEscrowIds } } })
    }
    if (createdTradeIds.length) {
      await prisma.eventProjectionClaim.deleteMany({ where: { subjectId: { in: createdTradeIds } } })
      await prisma.durableEventRecord.deleteMany({ where: { correlationId: { in: createdTradeIds } } })
      await prisma.trade.updateMany({ where: { id: { in: createdTradeIds } }, data: { escrowId: null } })
    }
    if (createdEscrowIds.length) await prisma.escrow.deleteMany({ where: { id: { in: createdEscrowIds } } })
    if (createdTradeIds.length) await prisma.trade.deleteMany({ where: { id: { in: createdTradeIds } } })
    if (createdUserIds.length) {
      await prisma.payoutAddress.deleteMany({ where: { participantId: { in: createdUserIds } } })
      await prisma.offer.deleteMany({ where: { userId: { in: createdUserIds } } })
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
    }
  })

  async function makeDisputedTrade(type: Rail) {
    const arbiterKeys = nacl.sign.keyPair()
    const arbiter = await prisma.user.create({ data: { publicKey: Buffer.from(arbiterKeys.publicKey).toString('hex') } })
    const buyer = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
    const seller = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
    createdUserIds.push(arbiter.id, buyer.id, seller.id)
    for (const participantId of [buyer.id, seller.id]) {
      await prisma.payoutAddress.create({ data: { participantId, asset: 'BTC', address: `bc1q${randomUUID().replace(/-/g, '')}`.slice(0, 42) } })
    }
    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER' })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    createdTradeIds.push(trade.id)
    const escrow = await prisma.escrow.create({ data: { tradeId: trade.id, type, status: 'PAYMENT_PENDING', lockedAmount: '0.001', asset: 'BTC' } })
    createdEscrowIds.push(escrow.id)
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id } })

    const disputeService = new DisputeService(new TrustedArbitratorProvider([arbiter.id]))
    const dispute = await disputeService.raiseDispute(trade.id, buyer.id, `#341 requirement 1 ${type}`)
    expect(dispute.arbiterId).toBe(arbiter.id)
    expect((await prisma.escrow.findUnique({ where: { id: escrow.id } }))!.status).toBe('DISPUTED')
    return { arbiter, arbiterKeys, buyer, seller, trade, escrow, dispute, disputeService }
  }

  const cases = [
    ['LIGHTNING_HODL', 'release', 'RELEASE'],
    ['LIGHTNING_HODL', 'refund', 'REFUND'],
    ['SAFE_GUARD_EVM', 'release', 'RELEASE'],
    ['SAFE_GUARD_EVM', 'refund', 'REFUND'],
  ] as const

  // raiseDispute() -> signed resolveDispute() -> applyRuling() -> initiateRelease()/initiateRefund().
  async function resolveThroughProductionPath(type: Rail, kind: 'release' | 'refund', ruling: 'RELEASE' | 'REFUND') {
    const f = await makeDisputedTrade(type)
    const provider: any = type === 'LIGHTNING_HODL' ? lightningHodlProvider : safeGuardEvmProvider

    // Provider boundary: the unsigned bundle the provider would build, signed by the buyer only.
    const bundle = `unsigned-${type}-${kind}-${randomUUID()}`
    const build = kind === 'release' ? 'buildUnsignedRelease' : 'buildUnsignedRefund'
    jest.spyOn(provider, build).mockImplementation(async (_record: any, toAddress: any) => ({ psbtBase64: bundle, requiredSigners: [f.buyer.id], toAddress }))

    const issuedAt = new Date().toISOString()
    const payload = { disputeId: f.dispute.id, escrowId: f.escrow.id, appealRound: 0, authorityId: f.arbiter.id, outcome: ruling, buyerBps: null, issuedAt }
    const signature = signAuthorityDecision(payload as any, f.arbiterKeys.secretKey)
    await f.disputeService.resolveDispute(f.dispute.id, f.arbiter.id, ruling, undefined, undefined, undefined, signature, issuedAt)

    const pending = (await prisma.escrowPendingTransaction.findUnique({ where: { escrowId: f.escrow.id } }))!
    expect(pending).toMatchObject({ kind, unsignedPsbtBase64: bundle, disputeId: f.dispute.id, rulingAppealRound: 0, rulingArbiterId: f.arbiter.id, rulingOutcome: ruling, rulingAuthoritySignature: signature })
    expect(pending.rulingAuthorityIssuedAt!.toISOString()).toBe(issuedAt)
    expect(await prisma.economicDispositionAuthorization.count({ where: { escrowId: f.escrow.id } })).toBe(0)
    return { f, provider, pending, signature, bundle, finalize: kind === 'release' ? 'finalizeRelease' : 'finalizeRefund' }
  }

  it.each(cases)('%s %s: the frozen ruling generation and its authorization are committed before finalize runs', async (type, kind, ruling) => {
    pg.requirePostgres(`${type} ${kind} production-path provenance`)
    const { f, provider, pending, signature, finalize } = await resolveThroughProductionPath(type, kind, ruling)

    // External effect. What a separate connection sees here is what was committed before the effect.
    const seen: any = {}
    const fakeTxId = `0x${randomUUID().replace(/-/g, '')}`
    const spy = jest.spyOn(provider, finalize).mockImplementation(async () => {
      seen.pending = (await observer.query('SELECT * FROM escrow_pending_transactions WHERE "escrowId" = $1', [f.escrow.id])).rows
      seen.authorizations = (await observer.query('SELECT * FROM economic_disposition_authorizations WHERE "escrowId" = $1', [f.escrow.id])).rows
      seen.escrow = (await observer.query('SELECT status FROM escrows WHERE id = $1', [f.escrow.id])).rows[0]
      return { txId: fakeTxId }
    })

    const submitted = await escrowService.submitTransactionSignature(f.escrow.id, f.buyer.id, 'signed-bundle')
    expect(submitted.complete).toBe(true)
    expect(spy).toHaveBeenCalledTimes(1)

    expect(seen.pending).toHaveLength(1)
    expect(seen.pending[0]).toMatchObject({ id: pending.id, disputeId: f.dispute.id, rulingAppealRound: 0, rulingArbiterId: f.arbiter.id, rulingOutcome: ruling, rulingAuthoritySignature: signature })
    expect(seen.authorizations).toHaveLength(1)
    expect(seen.authorizations[0]).toMatchObject({
      pendingOperationId: pending.id,
      disputeId: f.dispute.id,
      appealRound: 0,
      arbiterId: f.arbiter.id,
      ruling,
      operationDigest: economicDispositionOperationDigest(pending as any),
    })
    expect(seen.escrow.status).toBe(kind === 'release' ? 'COMPLETED' : 'REFUNDED')

    // The authorization outlives the pending row it authorized.
    expect(await prisma.escrowPendingTransaction.count({ where: { escrowId: f.escrow.id } })).toBe(0)
    expect(await prisma.economicDispositionAuthorization.count({ where: { escrowId: f.escrow.id, pendingOperationId: pending.id } })).toBe(1)
  })

  // #341 requirement 5: a raw UPDATE of the pending row, landing while the first authorization is being committed,
  // never makes the authorized operation differ from the executed one, and a retry on the overwritten row is
  // refused before the provider. Deterministic interleaving: this test holds the gate's own advisory lock, waits
  // until submitTransactionSignature() is blocked on it (it has already loaded the pending row), overwrites the
  // row, then releases the lock.
  it.each(cases)('%s %s: a concurrent overwrite of the pending row during the first authorization neither changes what executes nor survives a retry', async (type, kind, ruling) => {
    pg.requirePostgres(`${type} ${kind} concurrent overwrite`)
    const { f, provider, pending, bundle, finalize } = await resolveThroughProductionPath(type, kind, ruling)
    const original = economicDispositionOperationDigest(pending as any)
    const lockKey = `economic-disposition:${f.dispute.id}`

    const calls: string[] = []
    const spy = jest.spyOn(provider, finalize).mockImplementation(async (_escrow: any, unsigned: any) => {
      calls.push(unsigned)
      throw new Error('provider unavailable') // keeps the pending row so the retry below runs against it
    })

    await observer.query('SELECT pg_advisory_lock(hashtext($1)::bigint)', [lockKey])
    let submit: Promise<unknown>
    try {
      submit = escrowService.submitTransactionSignature(f.escrow.id, f.buyer.id, 'signed-bundle').catch((e: Error) => e)
      const end = Date.now() + 15_000
      while ((await observer.query(`SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`)).rowCount === 0) {
        if (Date.now() > end) throw new Error('submitTransactionSignature never reached the economic-disposition lock')
        await new Promise((r) => setTimeout(r, 20))
      }
      expect(await prisma.economicDispositionAuthorization.count({ where: { escrowId: f.escrow.id } })).toBe(0)
      const overwritten = await observer.query(
        `UPDATE escrow_pending_transactions SET "unsignedPsbtBase64" = $2, "toAddress" = $3, "rulingOutcome" = $4::"DisputeRuling" WHERE id = $1`,
        [pending.id, `attacker-${bundle}`, 'attacker-destination', ruling === 'RELEASE' ? 'REFUND' : 'RELEASE'],
      )
      expect(overwritten.rowCount).toBe(1)
    } finally {
      await observer.query('SELECT pg_advisory_unlock(hashtext($1)::bigint)', [lockKey])
    }
    const first = await submit!
    expect((first as Error).message).toBe('provider unavailable')

    // What was authorized is what executed: the row as loaded before the overwrite.
    expect(calls).toEqual([bundle])
    const authorization = (await prisma.economicDispositionAuthorization.findUnique({ where: { pendingOperationId: pending.id } }))!
    expect(authorization.operationDigest).toBe(original)
    const live = (await prisma.escrowPendingTransaction.findUnique({ where: { id: pending.id } }))!
    expect(live.unsignedPsbtBase64).toBe(`attacker-${bundle}`)
    expect(economicDispositionOperationDigest(live as any)).not.toBe(original)
    expect((await prisma.escrow.findUnique({ where: { id: f.escrow.id } }))!.status).toBe('DISPUTED')

    // Retry on the overwritten row: refused by the committed digest, before the provider.
    spy.mockClear()
    await expect(escrowService.submitTransactionSignature(f.escrow.id, f.buyer.id, 'signed-bundle'))
      .rejects.toThrow(`Pending operation ${pending.id} no longer matches its committed economic disposition authorization`)
    expect(spy).not.toHaveBeenCalled()
    expect((await prisma.escrow.findUnique({ where: { id: f.escrow.id } }))!.status).toBe('DISPUTED')
    expect(await prisma.economicDispositionAuthorization.count({ where: { escrowId: f.escrow.id } })).toBe(1)
  })
})
