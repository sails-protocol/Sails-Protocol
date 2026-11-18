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
import { spawn } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import os from 'os'
import path from 'path'
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
  let marketArbitrationProvider: typeof import('../../src/modules/open-settlement/market-arbitration.provider').marketArbitrationProvider

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
    ;({ marketArbitrationProvider } = require('../../src/modules/open-settlement/market-arbitration.provider'))
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
      await prisma.arbiterProfile.deleteMany({ where: { participantId: { in: createdUserIds } } })
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
      // Scoped to this database: an advisory waiter of another database on the same server (a parallel test run) must
      // not end the wait before submitTransactionSignature() has loaded the row (the cause of the PE-M9R-R1 flake).
      while ((await observer.query(`SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)).rowCount === 0) {
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

  // #341 requirement 3: a real OS process finalizes and dies by SIGKILL at a deterministic point after the external
  // effect; the dispute is then appealed (its live row no longer says RESOLVED/<ruling>); a FRESH process recovers
  // through the production reconciler. The recovered settlement event and its projection keep the frozen provenance.
  const WORKER = path.join(__dirname, 'signatureCollectionRestart.worker.ts')
  function runWorker(env: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
    const child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', WORKER], {
      cwd: path.join(__dirname, '..', '..'),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-20_000) })
    child.stdout.resume()
    return new Promise((resolve) => child.on('exit', (code) => resolve({ code, stderr })))
  }

  const killPoints = ['after-effect', 'before-publish'] as const
  const restartCases = cases.flatMap((c) => killPoints.map((k) => [...c, k] as const))

  it.each(restartCases)('%s %s (%s), SIGKILL %s: a fresh process recovers the same frozen provenance after an appeal', async (type, kind, ruling, killAt) => {
    pg.requirePostgres(`${type} ${kind} restart ${killAt}`)
    const { f, pending, bundle } = await resolveThroughProductionPath(type, kind, ruling)
    const panelist = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
    createdUserIds.push(panelist.id)
    await prisma.arbiterProfile.create({ data: { participantId: panelist.id, monetaryCollateral: '10', collateralAsset: 'BTC', arbiterReputation: 50 } })
    const sync = mkdtempSync(path.join(os.tmpdir(), 'r341-'))
    const toStatus = kind === 'release' ? 'COMPLETED' : 'REFUNDED'
    const eventName = kind === 'release' ? 'settlement.escrow.released' : 'settlement.escrow.refunded'
    const common = { SYNC_DIR: sync, ESCROW_ID: f.escrow.id, FAKE_TX_ID: `0x${randomUUID().replace(/-/g, '')}`, MOCK_ESCROW: 'true' }
    const effects = () => existsSync(path.join(sync, 'effects.log')) ? readFileSync(path.join(sync, 'effects.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []
    try {
      const first = await runWorker({ ...common, ROLE: 'finalize', KILL_AT: killAt, SIGNER_ID: f.buyer.id })
      expect(first.stderr).toContain('SIGKILL_MARKER')
      expect(first.code).not.toBe(0)
      expect(JSON.parse(readFileSync(path.join(sync, 'finalize.killed.json'), 'utf8')).point).toBe(killAt)

      // State at the moment of death: the effect ran once and its authorization is committed; nothing is published.
      expect(effects()).toEqual([expect.objectContaining({ role: 'finalize', unsigned: bundle })])
      const authorization = (await prisma.economicDispositionAuthorization.findUnique({ where: { pendingOperationId: pending.id } }))!
      expect(authorization).toMatchObject({ disputeId: f.dispute.id, appealRound: 0, arbiterId: f.arbiter.id, ruling, operationDigest: economicDispositionOperationDigest(pending as any) })
      expect(await prisma.escrowEvent.count({ where: { escrowId: f.escrow.id, toStatus } })).toBe(killAt === 'after-effect' ? 0 : 1)
      expect(await prisma.durableEventRecord.count({ where: { correlationId: f.trade.id, eventName } })).toBe(0)

      // The live dispute moves on before recovery.
      await new DisputeService(marketArbitrationProvider).appeal(f.dispute.id, ruling === 'RELEASE' ? f.seller.id : f.buyer.id)
      expect((await prisma.dispute.findUnique({ where: { id: f.dispute.id } }))).toMatchObject({ status: 'APPEALED', ruling: null, appealRound: 1 })

      const recovery = await runWorker({ ...common, ROLE: 'recover', TO_STATUS: toStatus })
      expect(recovery.stderr).not.toContain('SIGKILL_MARKER')
      expect(recovery.code).toBe(0)

      // No second external effect; one settlement event carrying the frozen dispute; the disputed outcome projected once.
      expect(effects()).toHaveLength(1)
      const durable = await prisma.durableEventRecord.findMany({ where: { correlationId: f.trade.id, eventName } })
      expect(durable).toHaveLength(1)
      const transition = (await prisma.escrowEvent.findFirst({ where: { escrowId: f.escrow.id, toStatus } }))!
      // A recovered publication carries no payload.disputeId (settlement-provenance.ts documents this). The frozen
      // identity survives in durable rows instead: the transition's dispute-provenance row, written with the claim
      // by the killed process (before-publish), and the ADR-005 authorization, in both cases. PASS 2 (after-effect)
      // re-claims the transition without a disputeId, so there only the authorization carries it.
      expect((durable[0].payload as any).disputeId).toBeUndefined()
      const provenanceRows = await prisma.eventProjectionClaim.findMany({ where: { eventId: transition.id, projectionKey: 'transition.dispute-provenance' } })
      expect(provenanceRows.map((r) => r.subjectId)).toEqual(killAt === 'before-publish' ? [f.dispute.id] : [])
      expect(await prisma.eventProjectionClaim.count({ where: { eventId: transition.id, projectionKey: 'reputation.outcome' } })).toBe(2)
      const [buyer, seller] = await Promise.all([prisma.user.findUnique({ where: { id: f.buyer.id } }), prisma.user.findUnique({ where: { id: f.seller.id } })])
      expect(buyer!.reputationScore).toBe(ruling === 'RELEASE' ? 2 : -5)
      expect(seller!.reputationScore).toBe(ruling === 'RELEASE' ? -5 : 2)
      expect(await prisma.economicDispositionAuthorization.findMany({ where: { escrowId: f.escrow.id } })).toEqual([authorization])
    } finally {
      rmSync(sync, { recursive: true, force: true })
    }
  })
})
