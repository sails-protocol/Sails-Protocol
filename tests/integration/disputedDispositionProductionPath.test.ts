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
  let dispositionCommitment: typeof import('../../src/modules/open-settlement/economic-disposition-authority').dispositionCommitment
  let lightningHodlProvider: typeof import('../../src/modules/open-settlement/lightning-hodl.provider').lightningHodlProvider
  let safeGuardEvmProvider: typeof import('../../src/modules/open-settlement/safe-guard-evm.provider').safeGuardEvmProvider
  let marketArbitrationProvider: typeof import('../../src/modules/open-settlement/market-arbitration.provider').marketArbitrationProvider
  let provenance: typeof import('../../src/common/events/settlement-provenance')
  let listHeldSettlementProvenance: typeof import('../../src/common/events/event-projection').listHeldSettlementProvenance

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
    ;({ economicDispositionOperationDigest, dispositionCommitment } = require('../../src/modules/open-settlement/economic-disposition-authority'))
    ;({ lightningHodlProvider } = require('../../src/modules/open-settlement/lightning-hodl.provider'))
    ;({ safeGuardEvmProvider } = require('../../src/modules/open-settlement/safe-guard-evm.provider'))
    ;({ marketArbitrationProvider } = require('../../src/modules/open-settlement/market-arbitration.provider'))
    provenance = require('../../src/common/events/settlement-provenance')
    ;({ listHeldSettlementProvenance } = require('../../src/common/events/event-projection'))
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
      if (transitions.length) {
        await prisma.eventProjectionClaim.deleteMany({ where: { subjectId: { in: transitions.map((t) => t.id) } } })
        await prisma.eventProjectionClaim.deleteMany({ where: { eventId: { in: transitions.map((t) => t.id) } } })
      }
      await prisma.eventProjectionClaim.deleteMany({ where: { subjectId: { in: createdEscrowIds } } })
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

  // The provenance markers written with the claim of the escrow's settlement transition (into toStatus).
  async function transitionMarkers(escrowId: string, toStatus: 'COMPLETED' | 'REFUNDED') {
    const transition = (await prisma.escrowEvent.findFirst({ where: { escrowId, toStatus } }))!
    const rows = await prisma.eventProjectionClaim.findMany({ where: { eventId: transition.id, projectionKey: { in: ['transition.dispute-provenance', 'transition.disposition-authorization'] } } })
    return {
      disputes: rows.filter((r) => r.projectionKey === 'transition.dispute-provenance').map((r) => r.subjectId),
      authorizations: rows.filter((r) => r.projectionKey === 'transition.disposition-authorization').map((r) => r.subjectId),
    }
  }

  // The commitment written with that claim, and the one its authorization's CURRENT content would produce.
  async function commitmentOf(escrowId: string, toStatus: 'COMPLETED' | 'REFUNDED', authorizationId: string) {
    const transition = (await prisma.escrowEvent.findFirst({ where: { escrowId, toStatus } }))!
    const written = (await prisma.eventProjectionClaim.findMany({ where: { eventId: transition.id, projectionKey: 'transition.disposition-commitment' } })).map((r) => r.subjectId)
    const authorization = (await prisma.economicDispositionAuthorization.findUnique({ where: { id: authorizationId } }))!
    return { written, expected: dispositionCommitment(authorization, transition) }
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

    // #341 PASS 2 provenance (CTO 22 D1): the settlement transition is bound to that exact authorization.
    const authorization = (await prisma.economicDispositionAuthorization.findUnique({ where: { pendingOperationId: pending.id } }))!
    expect(await transitionMarkers(f.escrow.id, kind === 'release' ? 'COMPLETED' : 'REFUNDED')).toEqual({ disputes: [f.dispute.id], authorizations: [authorization.id] })
    const commitment = await commitmentOf(f.escrow.id, kind === 'release' ? 'COMPLETED' : 'REFUNDED', authorization.id)
    expect(commitment.written).toEqual([commitment.expected])
    expect(commitment.expected).toMatch(/^v1:[0-9a-f]{64}$/)
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
      // #341 PASS 2 provenance (CTO 22 D1/D3): whichever process claims the transition binds it to the exact
      // authorization of its pending operation, with the dispute. after-effect: PASS 2 claims it and publishes the
      // disputeId too. before-publish: the killed process claimed it; PASS 3 republishes without a payload
      // disputeId, so the bound rows alone carry the provenance.
      expect((durable[0].payload as any).disputeId).toBe(killAt === 'after-effect' ? f.dispute.id : undefined)
      expect(await transitionMarkers(f.escrow.id, toStatus)).toEqual({ disputes: [f.dispute.id], authorizations: [authorization.id] })
      // The appeal after the claim is legitimate: the commitment still matches and the settlement stays DISPUTED.
      const commitment = await commitmentOf(f.escrow.id, toStatus, authorization.id)
      expect(commitment.written).toEqual([commitment.expected])
      expect(await provenance.classifySettlementProvenance(transition.id, f.escrow.id, undefined)).toBe('DISPUTED')
      expect(await prisma.eventProjectionClaim.count({ where: { eventId: transition.id, projectionKey: 'reputation.outcome' } })).toBe(2)
      const [buyer, seller] = await Promise.all([prisma.user.findUnique({ where: { id: f.buyer.id } }), prisma.user.findUnique({ where: { id: f.seller.id } })])
      expect(buyer!.reputationScore).toBe(ruling === 'RELEASE' ? 2 : -5)
      expect(seller!.reputationScore).toBe(ruling === 'RELEASE' ? -5 : 2)
      expect(await prisma.economicDispositionAuthorization.findMany({ where: { escrowId: f.escrow.id } })).toEqual([authorization])
    } finally {
      rmSync(sync, { recursive: true, force: true })
    }
  })

  // ── #341 PASS 2 provenance (CTO 22 D1-D4): the recovered settlement is bound to its exact authorization ──────────
  //
  // Same production path and OS processes as above. `beforeRecover` runs after the SIGKILL and the appeal, before
  // the fresh process recovers: it is where a test damages or adds durable evidence.
  const syncDirs: string[] = []
  afterEach(() => { for (const d of syncDirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

  type RecoverContext = { escrowId: string; pendingId: string; authorization: { id: string; escrowId: string; disputeId: string; arbiterId: string } }
  async function killThenRecover(type: Rail, kind: 'release' | 'refund', ruling: 'RELEASE' | 'REFUND', killAt: 'after-effect' | 'before-publish', beforeRecover?: (ctx: RecoverContext) => Promise<void>) {
    const { f, pending } = await resolveThroughProductionPath(type, kind, ruling)
    const panelist = await prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
    createdUserIds.push(panelist.id)
    await prisma.arbiterProfile.create({ data: { participantId: panelist.id, monetaryCollateral: '10', collateralAsset: 'BTC', arbiterReputation: 50 } })
    const sync = mkdtempSync(path.join(os.tmpdir(), 'r341p2-'))
    syncDirs.push(sync)
    const toStatus = kind === 'release' ? 'COMPLETED' as const : 'REFUNDED' as const
    const eventName = kind === 'release' ? 'settlement.escrow.released' : 'settlement.escrow.refunded'
    const common = { SYNC_DIR: sync, ESCROW_ID: f.escrow.id, FAKE_TX_ID: `0x${randomUUID().replace(/-/g, '')}`, MOCK_ESCROW: 'true', TO_STATUS: toStatus }
    const effects = () => existsSync(path.join(sync, 'effects.log')) ? readFileSync(path.join(sync, 'effects.log'), 'utf8').trim().split('\n') : []

    const first = await runWorker({ ...common, ROLE: 'finalize', KILL_AT: killAt, SIGNER_ID: f.buyer.id })
    expect(first.stderr).toContain('SIGKILL_MARKER')
    const authorization = (await prisma.economicDispositionAuthorization.findUnique({ where: { pendingOperationId: pending.id } }))!
    await new DisputeService(marketArbitrationProvider).appeal(f.dispute.id, ruling === 'RELEASE' ? f.seller.id : f.buyer.id)
    await beforeRecover?.({ escrowId: f.escrow.id, pendingId: pending.id, authorization })
    const recover = () => runWorker({ ...common, ROLE: 'recover' })
    const recovery = await recover()
    expect(recovery.code).toBe(0)
    const transition = (await prisma.escrowEvent.findFirst({ where: { escrowId: f.escrow.id, toStatus } }))!
    const outcomes = () => prisma.eventProjectionClaim.count({ where: { eventId: transition.id, projectionKey: 'reputation.outcome' } })
    const scores = async () => (await Promise.all([f.buyer.id, f.seller.id].map((id) => prisma.user.findUnique({ where: { id } })))).map((u) => u!.reputationScore)
    const durable = () => prisma.durableEventRecord.findMany({ where: { correlationId: f.trade.id, eventName } })
    return { f, pending, authorization, toStatus, transition, effects, outcomes, scores, durable, recover }
  }

  it.each([
    ['LIGHTNING_HODL', 'release', 'RELEASE'],
    ['SAFE_GUARD_EVM', 'refund', 'REFUND'],
  ] as const)('%s %s: with two authorizations of different generations on the escrow, the recovered settlement binds its own', async (type, kind, ruling) => {
    pg.requirePostgres(`${type} ${kind} two generations`)
    let other: { id: string } | undefined
    const r = await killThenRecover(type, kind, ruling, 'after-effect', async ({ authorization: mine }) => {
      // A second, later-generation authorization of the same dispute and escrow, for another pending operation
      // (seeded row: it stands for an authorized attempt of round 1 that never settled).
      other = await prisma.economicDispositionAuthorization.create({
        data: { pendingOperationId: randomUUID(), escrowId: mine.escrowId, disputeId: mine.disputeId, appealRound: 1, arbiterId: mine.arbiterId, ruling: ruling === 'RELEASE' ? 'REFUND' : 'RELEASE', operationDigest: 'later-generation' },
      })
    })
    const escrowId = r.f.escrow.id
    expect(await prisma.economicDispositionAuthorization.count({ where: { escrowId } })).toBe(2)
    expect(await transitionMarkers(escrowId, r.toStatus)).toEqual({ disputes: [r.f.dispute.id], authorizations: [r.authorization.id] })
    expect(r.authorization.id).not.toBe(other!.id)
    expect(await provenance.classifySettlementProvenance(r.transition.id, escrowId, undefined)).toBe('DISPUTED')
    expect(await r.outcomes()).toBe(2)
  })

  it.each(cases)('%s %s: PASS 3 with the pending row already gone recovers from the markers bound to the same transition', async (type, kind, ruling) => {
    pg.requirePostgres(`${type} ${kind} PASS 3 without pending`)
    let pendingDeleted = 0
    const r = await killThenRecover(type, kind, ruling, 'before-publish', async ({ pendingId }) => {
      pendingDeleted = (await prisma.escrowPendingTransaction.deleteMany({ where: { id: pendingId } })).count
    })
    expect(pendingDeleted).toBe(1)
    expect(await prisma.escrowPendingTransaction.count({ where: { escrowId: r.f.escrow.id } })).toBe(0)
    expect(r.effects()).toHaveLength(1)
    expect((await r.durable()).map((e) => (e.payload as any).disputeId)).toEqual([undefined])
    expect(await transitionMarkers(r.f.escrow.id, r.toStatus)).toEqual({ disputes: [r.f.dispute.id], authorizations: [r.authorization.id] })
    expect(await r.outcomes()).toBe(2)
    expect(await r.scores()).toEqual(ruling === 'RELEASE' ? [2, -5] : [-5, 2])
  })

  it.each([
    ['LIGHTNING_HODL', 'refund', 'REFUND', 'after-effect'],
    ['SAFE_GUARD_EVM', 'release', 'RELEASE', 'before-publish'],
  ] as const)('%s %s (%s), SIGKILL %s: serial and concurrent redelivery after recovery change nothing', async (type, kind, ruling, killAt) => {
    pg.requirePostgres(`${type} ${kind} redelivery`)
    const r = await killThenRecover(type, kind, ruling, killAt)
    const before = { outcomes: await r.outcomes(), scores: await r.scores(), markers: await transitionMarkers(r.f.escrow.id, r.toStatus), durable: (await r.durable()).length }
    expect(before).toEqual({ outcomes: 2, scores: ruling === 'RELEASE' ? [2, -5] : [-5, 2], markers: { disputes: [r.f.dispute.id], authorizations: [r.authorization.id] }, durable: 1 })

    // Forget the completion marker so PASS 3 redelivers the settlement: twice concurrently, then once more.
    const forget = () => prisma.eventProjectionClaim.deleteMany({ where: { eventId: r.transition.id, projectionKey: 'transition.projected' } })
    await forget()
    const concurrent = await Promise.all([r.recover(), r.recover()])
    expect(concurrent.map((c) => c.code)).toEqual([0, 0])
    await forget()
    expect((await r.recover()).code).toBe(0)

    expect({ outcomes: await r.outcomes(), scores: await r.scores(), markers: await transitionMarkers(r.f.escrow.id, r.toStatus), durable: (await r.durable()).length }).toEqual(before)
    expect(r.effects()).toHaveLength(1)
    expect(await prisma.escrowEvent.count({ where: { escrowId: r.f.escrow.id, toStatus: r.toStatus } })).toBe(1)
  })

  // vetoed: an authorization still exists on the escrow, so a human COOPERATIVE decision must be refused (D2). With
  // the authorization gone nothing durable vetoes it, and the existing human-review rule applies unchanged.
  const divergences = [
    ['the authorization is missing', false, (id: string) => prisma.economicDispositionAuthorization.deleteMany({ where: { pendingOperationId: id } })],
    ['the authorization names another appeal round', true, (id: string) => prisma.economicDispositionAuthorization.update({ where: { pendingOperationId: id }, data: { appealRound: 7 } })],
    ['the authorization digest differs from the operation', true, (id: string) => prisma.economicDispositionAuthorization.update({ where: { pendingOperationId: id }, data: { operationDigest: 'tampered' } })],
  ] as const

  it.each(divergences)('PASS 2 after an appeal when %s: the settlement is recorded, no provenance is invented and its outcomes are held (COOPERATIVE vetoed: %s)', async (label, vetoed, damage) => {
    pg.requirePostgres(`PASS 2 divergence ${label}`)
    const r = await killThenRecover('SAFE_GUARD_EVM', 'release', 'RELEASE', 'after-effect', async ({ pendingId }) => { await damage(pendingId) })

    // Funds: the settlement already happened once and is recorded as such; nothing is reverted or re-sent.
    expect(r.effects()).toHaveLength(1)
    expect((await prisma.escrow.findUnique({ where: { id: r.f.escrow.id } }))!.status).toBe('COMPLETED')
    expect(await prisma.escrowEvent.count({ where: { escrowId: r.f.escrow.id, toStatus: 'COMPLETED' } })).toBe(1)
    // Provenance: none invented. Attribution: held, with no reward or penalty.
    expect((await r.durable()).map((e) => (e.payload as any).disputeId)).toEqual([undefined])
    expect(await transitionMarkers(r.f.escrow.id, 'COMPLETED')).toEqual({ disputes: [], authorizations: [] })
    expect(await provenance.classifySettlementProvenance(r.transition.id, r.f.escrow.id, undefined)).toBe('UNPROVEN')
    expect(await r.outcomes()).toBe(0)
    expect(await r.scores()).toEqual([0, 0])
    expect(await listHeldSettlementProvenance()).toEqual(expect.arrayContaining([{ effectId: r.transition.id, escrowId: r.f.escrow.id }]))

    // Never reinterpreted as COOPERATIVE automatically; a human decision of DISPUTED applies the outcomes once.
    const decision = (d: 'DISPUTED' | 'COOPERATIVE') => ({ effectId: r.transition.id, decision: d, decidedBy: 'reviewer-341', evidence: `ruling RELEASE on dispute ${r.f.dispute.id}` })
    if (vetoed) {
      await expect(provenance.resolveHeldSettlementProvenance(decision('COOPERATIVE'))).rejects.toThrow(/contradicts durable evidence/)
      expect(await r.outcomes()).toBe(0)
    }
    await provenance.resolveHeldSettlementProvenance(decision('DISPUTED'))
    expect(await r.outcomes()).toBe(2)
    expect(await r.scores()).toEqual([2, -5])
  })

  // Contradictory, cross-escrow or unanchored evidence on a settlement the live path bound correctly.
  async function boundSettlement() {
    const { f, provider, pending, finalize } = await resolveThroughProductionPath('LIGHTNING_HODL', 'release', 'RELEASE')
    jest.spyOn(provider, finalize).mockResolvedValue({ txId: `0x${randomUUID().replace(/-/g, '')}` })
    await escrowService.submitTransactionSignature(f.escrow.id, f.buyer.id, 'signed-bundle')
    const transition = (await prisma.escrowEvent.findFirst({ where: { escrowId: f.escrow.id, toStatus: 'COMPLETED' } }))!
    const authorization = (await prisma.economicDispositionAuthorization.findUnique({ where: { pendingOperationId: pending.id } }))!
    const classify = (eventDisputeId?: string) => provenance.classifySettlementProvenance(transition.id, f.escrow.id, eventDisputeId)
    const mark = (projectionKey: string, subjectId: string) => prisma.eventProjectionClaim.create({ data: { eventId: transition.id, projectionKey, subjectId } })
    const unmark = (projectionKey: string) => prisma.eventProjectionClaim.deleteMany({ where: { eventId: transition.id, projectionKey } })
    return { f, transition, authorization, classify, mark, unmark }
  }

  it('the bound evidence classifies DISPUTED; each contradiction, cross-escrow or unanchored variant classifies UNPROVEN', async () => {
    pg.requirePostgres('contradictory evidence')
    const s = await boundSettlement()
    const foreignEscrowId = randomUUID()
    try {
      expect(await s.classify()).toBe('DISPUTED')
      expect(await s.classify(s.f.dispute.id)).toBe('DISPUTED')

      // The commitment: missing, doubled, or of an unknown version, each UNPROVEN; restored, DISPUTED again.
      const [commitment] = (await prisma.eventProjectionClaim.findMany({ where: { eventId: s.transition.id, projectionKey: 'transition.disposition-commitment' } })).map((c) => c.subjectId)
      expect(commitment).toMatch(/^v1:/)
      await s.unmark('transition.disposition-commitment')
      expect(await s.classify()).toBe('UNPROVEN')
      await s.mark('transition.disposition-commitment', commitment)
      await s.mark('transition.disposition-commitment', commitment.replace(/^v1:/, 'v1:0'))
      expect(await s.classify()).toBe('UNPROVEN')
      await s.unmark('transition.disposition-commitment')
      await s.mark('transition.disposition-commitment', commitment.replace(/^v1:/, 'v2:'))
      expect(await s.classify()).toBe('UNPROVEN')
      await s.unmark('transition.disposition-commitment')
      await s.mark('transition.disposition-commitment', commitment)
      expect(await s.classify()).toBe('DISPUTED')

      // The event names another dispute than the bound authorization.
      expect(await s.classify(randomUUID())).toBe('UNPROVEN')

      // A second dispute-provenance row on the transition.
      await s.mark('transition.dispute-provenance', randomUUID())
      expect(await s.classify()).toBe('UNPROVEN')
      await s.unmark('transition.dispute-provenance')
      await s.mark('transition.dispute-provenance', s.f.dispute.id)
      expect(await s.classify()).toBe('DISPUTED')

      // A second bound authorization.
      await s.mark('transition.disposition-authorization', randomUUID())
      expect(await s.classify()).toBe('UNPROVEN')
      await s.unmark('transition.disposition-authorization')

      // The bound authorization belongs to another escrow.
      const foreign = await prisma.economicDispositionAuthorization.create({
        data: { pendingOperationId: randomUUID(), escrowId: foreignEscrowId, disputeId: s.f.dispute.id, appealRound: 0, arbiterId: s.f.arbiter.id, ruling: 'RELEASE', operationDigest: 'foreign' },
      })
      await s.mark('transition.disposition-authorization', foreign.id)
      expect(await s.classify()).toBe('UNPROVEN')
      await s.unmark('transition.disposition-authorization')

      // The bound authorization no longer exists.
      await s.mark('transition.disposition-authorization', randomUUID())
      expect(await s.classify()).toBe('UNPROVEN')
      await s.unmark('transition.disposition-authorization')

      // Authorization marker missing, dispute-provenance kept: it names the dispute but not the operation or
      // generation, and ADR-005 governs this escrow (GK NO-GO on #584): UNPROVEN, also with the event's disputeId.
      expect(await s.classify()).toBe('UNPROVEN')
      expect(await s.classify(s.f.dispute.id)).toBe('UNPROVEN')
      // Both markers missing: the escrow's authorization alone proves nothing (D2), and is not read as COOPERATIVE.
      await s.unmark('transition.dispute-provenance')
      expect(await s.classify()).toBe('UNPROVEN')
      // A disputeId alone never outweighs an authorization of this escrow for another dispute.
      await prisma.economicDispositionAuthorization.update({ where: { id: s.authorization.id }, data: { disputeId: randomUUID() } })
      expect(await s.classify(s.f.dispute.id)).toBe('UNPROVEN')
    } finally {
      await prisma.economicDispositionAuthorization.deleteMany({ where: { escrowId: foreignEscrowId } })
    }
  })

  // ── Gatekeeper NO-GO on #584 (issuecomment-6658291755): adversarial groups 1-4 ─────────────────────────────────
  //
  // `held` checks the outcome side only: the settlement, its funds and its events are compared before and after.
  async function settlementSnapshot(escrowId: string, tradeId: string) {
    const escrow = (await prisma.escrow.findUnique({ where: { id: escrowId } }))!
    return {
      status: escrow.status, txReleaseId: escrow.txReleaseId,
      transitions: await prisma.escrowEvent.count({ where: { escrowId } }),
      durable: await prisma.durableEventRecord.count({ where: { correlationId: tradeId } }),
    }
  }

  // Group 1: a dispute marker alone, with two authorizations of the same escrow and dispute from different appeal
  // rounds and rulings: no generation is inferred.
  it('GK group 1: a dispute-provenance marker alone, with two generations authorized on the escrow, is UNPROVEN and its outcomes are held', async () => {
    pg.requirePostgres('GK group 1')
    const s = await boundSettlement()
    await prisma.economicDispositionAuthorization.create({
      data: { pendingOperationId: randomUUID(), escrowId: s.f.escrow.id, disputeId: s.f.dispute.id, appealRound: 1, arbiterId: s.f.arbiter.id, ruling: 'REFUND', operationDigest: 'round-1' },
    })
    await s.unmark('transition.disposition-authorization')
    expect(await transitionMarkers(s.f.escrow.id, 'COMPLETED')).toEqual({ disputes: [s.f.dispute.id], authorizations: [] })
    expect(await prisma.economicDispositionAuthorization.count({ where: { escrowId: s.f.escrow.id } })).toBe(2)

    expect(await s.classify()).toBe('UNPROVEN')
    expect(await s.classify(s.f.dispute.id)).toBe('UNPROVEN')
    const before = await settlementSnapshot(s.f.escrow.id, s.f.trade.id)
    expect(await provenance.projectSettlementOutcomes(s.transition.id, 'RELEASE', s.f.trade.id, s.f.buyer.id, s.f.seller.id, s.f.escrow.id, s.f.dispute.id)).toBe(false)
    expect(await prisma.eventProjectionClaim.count({ where: { eventId: s.transition.id, projectionKey: 'reputation.outcome' } })).toBe(0)
    expect(await listHeldSettlementProvenance()).toEqual(expect.arrayContaining([{ effectId: s.transition.id, escrowId: s.f.escrow.id }]))
    expect(await settlementSnapshot(s.f.escrow.id, s.f.trade.id)).toEqual(before)
  })

  // Group 2: the bound authorization is altered AFTER the claim; then appeal, pending removed, PASS 3 and redelivery.
  const postClaim = [
    ['its ruling now authorizes the other operation', (id: string) => prisma.economicDispositionAuthorization.update({ where: { id }, data: { ruling: 'REFUND' } })],
    ['its appeal round is one the dispute never reached', (id: string) => prisma.economicDispositionAuthorization.update({ where: { id }, data: { appealRound: 7 } })],
  ] as const

  it.each(postClaim)('GK group 2: bound authorization altered after the claim (%s), then appeal, pending removed, PASS 3 and redelivery: UNPROVEN, nothing duplicated', async (_label, alter) => {
    pg.requirePostgres(`GK group 2 ${_label}`)
    const r = await killThenRecover('SAFE_GUARD_EVM', 'release', 'RELEASE', 'before-publish', async ({ authorization, pendingId }) => {
      await alter(authorization.id)
      expect((await prisma.escrowPendingTransaction.deleteMany({ where: { id: pendingId } })).count).toBe(1)
    })
    expect(await transitionMarkers(r.f.escrow.id, 'COMPLETED')).toEqual({ disputes: [r.f.dispute.id], authorizations: [r.authorization.id] })
    expect(await provenance.classifySettlementProvenance(r.transition.id, r.f.escrow.id, undefined)).toBe('UNPROVEN')
    expect(await r.outcomes()).toBe(0)
    expect(await listHeldSettlementProvenance()).toEqual(expect.arrayContaining([{ effectId: r.transition.id, escrowId: r.f.escrow.id }]))
    const settled = await settlementSnapshot(r.f.escrow.id, r.f.trade.id)
    expect(settled).toMatchObject({ status: 'COMPLETED' })

    // Redelivery: forget the completion marker, recover again.
    await prisma.eventProjectionClaim.deleteMany({ where: { eventId: r.transition.id, projectionKey: 'transition.projected' } })
    expect((await r.recover()).code).toBe(0)
    expect(await r.outcomes()).toBe(0)
    expect(r.effects()).toHaveLength(1)
    expect((await r.durable())).toHaveLength(1)
    expect(await settlementSnapshot(r.f.escrow.id, r.f.trade.id)).toEqual(settled)
  })

  // Group 2, pending still present: the full frozen provenance and digest are checked, so any post-claim change of
  // the authorization or of the operation it authorized (here its digest, and the pending row's destination) is caught.
  const postClaimWithPending = [
    ['the authorization digest is altered', (ctx: RecoverContext) => prisma.economicDispositionAuthorization.update({ where: { id: ctx.authorization.id }, data: { operationDigest: 'altered-after-claim' } })],
    ['the authorization arbiter is altered', (ctx: RecoverContext) => prisma.economicDispositionAuthorization.update({ where: { id: ctx.authorization.id }, data: { arbiterId: randomUUID() } })],
    ['the pending destination is altered', (ctx: RecoverContext) => prisma.escrowPendingTransaction.update({ where: { id: ctx.pendingId }, data: { toAddress: 'altered-destination' } })],
  ] as const

  it.each(postClaimWithPending)('GK groups 2/3: with the pending operation still present, %s after the claim: UNPROVEN on PASS 3, funds untouched', async (_label, alter) => {
    pg.requirePostgres(`GK group 2/3 ${_label}`)
    const r = await killThenRecover('LIGHTNING_HODL', 'release', 'RELEASE', 'before-publish', async (ctx) => { await alter(ctx) })
    expect(await prisma.escrowPendingTransaction.count({ where: { id: r.pending.id } })).toBe(1)
    expect(await provenance.classifySettlementProvenance(r.transition.id, r.f.escrow.id, undefined)).toBe('UNPROVEN')
    expect(await r.outcomes()).toBe(0)
    expect(r.effects()).toHaveLength(1)
    expect(await settlementSnapshot(r.f.escrow.id, r.f.trade.id)).toMatchObject({ status: 'COMPLETED' })
  })

  // Group 2 without the pending row (formerly it.todo, CTO 22 complementary authorization): once the pending row is
  // gone, only the commitment written with the claim can tell that the authorization row changed. Each value below
  // is plausible on its own: round 1 is a round the dispute really reached through the appeal.
  const postClaimWithoutPending = [
    ['its appeal round, set to the round the appeal really opened', (id: string) => prisma.economicDispositionAuthorization.update({ where: { id }, data: { appealRound: 1 } })],
    ['its arbiter', (id: string) => prisma.economicDispositionAuthorization.update({ where: { id }, data: { arbiterId: randomUUID() } })],
    ['its operation digest', (id: string) => prisma.economicDispositionAuthorization.update({ where: { id }, data: { operationDigest: 'altered-after-claim' } })],
  ] as const

  it.each(postClaimWithoutPending)('GK group 2: bound authorization altered after the claim (%s), then appeal, pending removed, PASS 3 and redelivery: UNPROVEN, nothing duplicated', async (_label, alter) => {
    pg.requirePostgres(`GK group 2 without pending ${_label}`)
    const r = await killThenRecover('LIGHTNING_HODL', 'refund', 'REFUND', 'before-publish', async ({ authorization, pendingId }) => {
      await alter(authorization.id)
      expect((await prisma.escrowPendingTransaction.deleteMany({ where: { id: pendingId } })).count).toBe(1)
    })
    expect((await prisma.dispute.findUnique({ where: { id: r.f.dispute.id } }))!.appealRound).toBe(1)
    const commitment = await commitmentOf(r.f.escrow.id, 'REFUNDED', r.authorization.id)
    expect(commitment.written).toHaveLength(1)
    expect(commitment.written[0]).not.toBe(commitment.expected)
    expect(await provenance.classifySettlementProvenance(r.transition.id, r.f.escrow.id, undefined)).toBe('UNPROVEN')
    expect(await r.outcomes()).toBe(0)
    expect(await r.scores()).toEqual([0, 0])
    expect(await listHeldSettlementProvenance()).toEqual(expect.arrayContaining([{ effectId: r.transition.id, escrowId: r.f.escrow.id }]))
    const settled = await settlementSnapshot(r.f.escrow.id, r.f.trade.id)
    expect(settled).toMatchObject({ status: 'REFUNDED' })

    await prisma.eventProjectionClaim.deleteMany({ where: { eventId: r.transition.id, projectionKey: 'transition.projected' } })
    const again = await Promise.all([r.recover(), r.recover()])
    expect(again.map((a) => a.code)).toEqual([0, 0])
    expect(await r.outcomes()).toBe(0)
    expect(r.effects()).toHaveLength(1)
    expect(await r.durable()).toHaveLength(1)
    expect(await settlementSnapshot(r.f.escrow.id, r.f.trade.id)).toEqual(settled)
  })

  // Group 3: cross-escrow dispute and operation conflicts behind a locally consistent authorization.
  it('GK group 3: an authorization of this escrow naming a Dispute of another escrow, or another operation, is UNPROVEN; funds untouched', async () => {
    pg.requirePostgres('GK group 3')
    const s = await boundSettlement()
    const elsewhere = await makeDisputedTrade('SAFE_GUARD_EVM')
    expect(elsewhere.escrow.id).not.toBe(s.f.escrow.id)
    const before = await settlementSnapshot(s.f.escrow.id, s.f.trade.id)

    // authorization.escrowId stays local; its dispute, and the transition's dispute marker, are the other escrow's.
    await prisma.economicDispositionAuthorization.update({ where: { id: s.authorization.id }, data: { disputeId: elsewhere.dispute.id } })
    await s.unmark('transition.dispute-provenance')
    await s.mark('transition.dispute-provenance', elsewhere.dispute.id)
    expect(await s.classify()).toBe('UNPROVEN')
    expect(await s.classify(elsewhere.dispute.id)).toBe('UNPROVEN')
    // Also when the commitment is rewritten consistently with the altered row: the Dispute's own escrow decides.
    const recommit = async () => {
      await s.unmark('transition.disposition-commitment')
      await s.mark('transition.disposition-commitment', dispositionCommitment((await prisma.economicDispositionAuthorization.findUnique({ where: { id: s.authorization.id } }))!, s.transition))
    }
    await recommit()
    expect(await s.classify()).toBe('UNPROVEN')

    // Back to its own dispute, but authorizing the other operation (REFUND) for this release.
    await prisma.economicDispositionAuthorization.update({ where: { id: s.authorization.id }, data: { disputeId: s.f.dispute.id, ruling: 'REFUND' } })
    await s.unmark('transition.dispute-provenance')
    await s.mark('transition.dispute-provenance', s.f.dispute.id)
    expect(await s.classify()).toBe('UNPROVEN')
    // Also with a consistently rewritten commitment: the transition's own target decides.
    await recommit()
    expect(await s.classify()).toBe('UNPROVEN')

    expect(await provenance.projectSettlementOutcomes(s.transition.id, 'RELEASE', s.f.trade.id, s.f.buyer.id, s.f.seller.id, s.f.escrow.id, undefined)).toBe(false)
    expect(await prisma.eventProjectionClaim.count({ where: { eventId: s.transition.id, projectionKey: 'reputation.outcome' } })).toBe(0)
    expect(await settlementSnapshot(s.f.escrow.id, s.f.trade.id)).toEqual(before)

    // Restored to what the gate authorized: DISPUTED again (group 4, positive control on the same rows).
    await prisma.economicDispositionAuthorization.update({ where: { id: s.authorization.id }, data: { ruling: 'RELEASE' } })
    await recommit()
    expect((await commitmentOf(s.f.escrow.id, 'COMPLETED', s.authorization.id)).written).toEqual([dispositionCommitment(s.authorization, s.transition)])
    expect(await s.classify()).toBe('DISPUTED')
  })
})
