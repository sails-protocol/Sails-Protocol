// tests/integration/f32PartyAbsenceCharacterization.test.ts
//
// F32 ("o desaparecimento do nó de uma parte não impede a disputa") - CHARACTERIZATION of the CURRENT behavior of a
// MULTISIG / BITCOIN_L1 dispute when one party stops acting, against real PostgreSQL and real 2-of-3 P2WSH PSBTs.
//
// THIS FILE DESCRIBES REALITY, IT DOES NOT ASSERT A REQUIREMENT. Whether the winning party being absent is a
// requirement or an accepted risk, what "node" means in Day 0 and whether a timelock exit is allowed are open CTO
// decisions (Q1-Q8). Tests named "gap" pin a limitation that exists today so it stays visible and so any future change
// to it is a deliberate, reviewed one. This file does NOT homologate F32.
//
//   A  absent LOSING party   : the dispute concludes with the arbiter + the winning party only.
//   B  absent WINNING party  : the signing round stays pending forever; no sweeper or recovery pass moves it (gap L1/L2).
//   C  timelock expiry       : does not move a DISPUTED escrow.
//   D  absent arbiter        : nothing moves an OPENED dispute; only the script-committed arbiter can rule (gap L3).
//   E  operator process SIGKILL: a ruling committed by an operator process that is then killed stays durable, and the
//      winning party can finish the round afterwards.
// Only the explorer is simulated (pendingRoundLifecycleHarness.ts), as in the #239 suites.
import { spawn } from 'child_process'
import path from 'path'
import { PrismaClient } from '@prisma/client'
import { createHash } from 'crypto'
import nacl from 'tweetnacl'
import { MULTISIG_CAPABILITY_PROFILE_V1 } from '@satsails/p2p-schemas'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { registerTestParticipant, closeTestRedis } from './identityTestHelpers'
import { buyerKey, sellerKey, BUYER_PUBKEY, SELLER_PUBKEY, testnetAddress, newChain, explorer, signRound, chainToJson, type Chain } from './pendingRoundLifecycleHarness'
import type { AuthorityDecisionPayload } from '../../src/modules/open-settlement/arbitration-authority'

const WORKER = path.join(__dirname, 'f32OperatorProcess.worker.ts')
const DAY = 24 * 60 * 60 * 1000

type Outcome = 'RELEASE' | 'REFUND' | 'SPLIT'

describe('F32 characterization - a party stops acting during a MULTISIG dispute (real PostgreSQL, real PSBTs)', () => {
  jest.setTimeout(180_000)
  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let escrowService: import('../../src/modules/open-settlement/escrow.service').EscrowService
  let identityService: any
  let liquidityRouter: any
  let tradeService: any
  let payoutAddressService: any
  let getDisputeService: typeof import('../../src/modules/open-settlement/dispute.service').getDisputeService
  let signAuthorityDecision: typeof import('../../src/modules/open-settlement/arbitration-authority').signAuthorityDecision
  let reconcileMissingDispatch: typeof import('../../src/modules/open-settlement/dispute-dispatch-recovery').reconcileMissingDispatch
  let reconcileStalePendingDisputeTranslations: typeof import('../../src/modules/open-settlement/dispute-pending-reconciliation').reconcileStalePendingDisputeTranslations
  let reconcile: typeof import('../../src/modules/open-settlement/escrow-settlement-reconciliation.service')

  const ARBITER_ID = 'f32-test-arbiter'
  const arbiterKeypair = nacl.sign.keyPair()
  let chain: Chain
  let realFetch: typeof fetch
  let mine: string[] = []

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'false'
    process.env.MULTISIG_SEED = process.env.MULTISIG_SEED || 'f32-test-seed'
    process.env.TRUSTED_ARBITRATORS = ARBITER_ID
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ escrowService } = require('../../src/modules/open-settlement/escrow.service'))
    ;({ identityService } = require('../../src/modules/open-identity/identity.service'))
    ;({ liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service'))
    ;({ tradeService } = require('../../src/modules/open-p2p/trade.service'))
    ;({ payoutAddressService } = require('../../src/modules/open-settlement/payout-address.service'))
    ;({ getDisputeService } = require('../../src/modules/open-settlement/dispute.service'))
    ;({ signAuthorityDecision } = require('../../src/modules/open-settlement/arbitration-authority'))
    ;({ reconcileMissingDispatch } = require('../../src/modules/open-settlement/dispute-dispatch-recovery'))
    ;({ reconcileStalePendingDisputeTranslations } = require('../../src/modules/open-settlement/dispute-pending-reconciliation'))
    reconcile = require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service')
    const { intentEngine } = require('../../src/core/intent-engine')
    intentEngine.registerHandler(require('../../src/modules/open-p2p/intent-handler').OpenP2PTradeIntentHandler)
    const publicKey = Buffer.from(arbiterKeypair.publicKey).toString('hex')
    await prisma.user.upsert({ where: { id: ARBITER_ID }, update: { publicKey }, create: { id: ARBITER_ID, publicKey, displayName: 'f32 arbiter' } })
  })

  beforeEach(() => {
    chain = newChain()
    realFetch = global.fetch
    global.fetch = explorer(chain)
    mine = []
    if (!dbAvailable) return
    // The external-spend watch pages every MULTISIG escrow of the shared database; narrowed to this test's escrows so an
    // assertion about one escrow never depends on where its id falls (same technique as pendingRoundLifecycle.test.ts).
    const findMany = prisma.escrow.findMany.bind(prisma.escrow)
    jest.spyOn(prisma.escrow, 'findMany').mockImplementation(((args: any) =>
      findMany(args?.where?.OR?.[0]?.pendingTransaction ? { ...args, where: { ...args.where, AND: [{ id: { in: mine } }] } } : args)) as never)
  })
  afterEach(() => {
    global.fetch = realFetch
    jest.restoreAllMocks()
    reconcile?.resetExternalSpendCursor()
  })
  afterAll(async () => {
    if (dbAvailable) {
      await prisma.$disconnect()
      await closeTestRedis()
    }
  })

  // ─── fixtures ─────────────────────────────────────────────────────────────────────────────────────────────
  /** A funded MULTISIG escrow (controlled buyer/seller keys) with a dispute OPENED by the buyer; nobody has ruled yet. */
  async function openedDispute(label: string) {
    const seller = await registerTestParticipant(identityService, 'Seller')
    const buyer = await registerTestParticipant(identityService, 'Buyer')
    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER' })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    const escrow = await escrowService.createEscrow({ tradeId: trade.id, type: 'MULTISIG', lockedAmount: '0.001', asset: 'BTC' }, seller.id)
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id } })
    await escrowService.submitParticipantKey(escrow.id, buyer.id, BUYER_PUBKEY, MULTISIG_CAPABILITY_PROFILE_V1)
    await escrowService.submitParticipantKey(escrow.id, seller.id, SELLER_PUBKEY, MULTISIG_CAPABILITY_PROFILE_V1)
    const funding = createHash('sha256').update(`f32-${label}-${Math.random()}-${Date.now()}`).digest('hex')
    chain.fundings.add(funding)
    chain.locking = funding
    await escrowService.lockFunds(escrow.id, seller.id)
    chain.locking = null
    await payoutAddressService.setPayoutAddress(buyer.id, 'BTC', testnetAddress(`${label}-buyer`))
    await payoutAddressService.setPayoutAddress(seller.id, 'BTC', testnetAddress(`${label}-seller`))
    const dispute = await getDisputeService().raiseDispute(trade.id, buyer.id, `f32 ${label}`)
    expect(dispute.arbiterId).toBe(ARBITER_ID) // the script-committed arbiter, never assign()
    mine.push(escrow.id)
    return { escrowId: escrow.id, tradeId: trade.id, buyerId: buyer.id, sellerId: seller.id, disputeId: dispute.id, funding }
  }
  type Opened = Awaited<ReturnType<typeof openedDispute>>

  function signedRuling(f: Opened, outcome: Outcome) {
    const issuedAt = new Date().toISOString()
    const buyerBps = outcome === 'SPLIT' ? 6000 : null
    const payload: AuthorityDecisionPayload = { disputeId: f.disputeId, escrowId: f.escrowId, appealRound: 0, authorityId: ARBITER_ID, outcome, buyerBps, issuedAt }
    return { signature: signAuthorityDecision(payload, arbiterKeypair.secretKey), issuedAt, buyerBps }
  }
  async function rule(f: Opened, outcome: Outcome) {
    const r = signedRuling(f, outcome)
    await getDisputeService().resolveDispute(f.disputeId, ARBITER_ID, outcome, undefined, undefined, r.buyerBps ?? undefined, r.signature, r.issuedAt)
  }
  const round = (escrowId: string) => prisma.escrowPendingTransaction.findUnique({ where: { escrowId }, include: { signatures: true } })
  const escrowOf = (escrowId: string) => prisma.escrow.findUniqueOrThrow({ where: { id: escrowId } })
  const disputeOf = (disputeId: string) => prisma.dispute.findUniqueOrThrow({ where: { id: disputeId } })
  const keyOf = (f: Opened, id: string) => (id === f.buyerId ? buyerKey : sellerKey)
  const sign = async (f: Opened, participantId: string) => {
    const r = await round(f.escrowId)
    return escrowService.submitTransactionSignature(f.escrowId, participantId, signRound(r!.unsignedPsbtBase64, keyOf(f, participantId)))
  }
  /** Every recovery/sweeper pass the production process has, run once, with the sweeper clock as it is. */
  async function everyRecoveryPass(f: Opened) {
    const swept = await escrowService.sweepExpiredEscrows()
    const auto = await getDisputeService().sweepExpiredAutoResolutions()
    const dispatch = await reconcileMissingDispatch()
    const stale = await reconcileStalePendingDisputeTranslations()
    const settle = await reconcile.reconcilePendingSettlements({ externalSpendMinIntervalMs: 0 })
    return {
      sweptThisEscrow: [...swept.refunded, ...swept.requiresManualRecovery].includes(f.escrowId) || swept.failed.some((x) => x.escrowId === f.escrowId),
      autoThisDispute: auto.revertedToHuman.includes(f.disputeId) || auto.failed.some((x) => x.disputeId === f.disputeId),
      staleThisEscrow: stale.reconciled.filter((x) => x.escrowId === f.escrowId).map((x) => x.verdict),
      settleCompleted: settle.externallyCompleted.some((x) => x.escrowId === f.escrowId),
    }
  }
  /** Ages everything a time-based recovery could look at by a year. */
  async function ageOneYear(f: Opened) {
    const old = new Date(Date.now() - 365 * DAY)
    await prisma.escrow.update({ where: { id: f.escrowId }, data: { expiresAt: old } })
    await prisma.dispute.update({ where: { id: f.disputeId }, data: { createdAt: old } })
    await prisma.escrowPendingTransaction.updateMany({ where: { escrowId: f.escrowId }, data: { createdAt: old } })
  }

  // ─── A. the LOSING party is absent: the dispute concludes without it ─────────────────────────────────────
  describe('A - absent LOSING party (current behavior: concludes with the arbiter + the winning party only)', () => {
    it('A1 RELEASE (buyer wins, seller absent): only the buyer is a required signer; the buyer signing finalizes and broadcasts', async () => {
      pg.requirePostgres('A1')
      const f = await openedDispute('a1')
      await rule(f, 'RELEASE')
      const r = await round(f.escrowId)
      expect(r!.requiredSigners).toEqual([f.buyerId])
      await expect(sign(f, f.sellerId)).rejects.toThrow(/not one of the required signers/)
      const result = await sign(f, f.buyerId)
      expect(result.complete).toBe(true)
      expect(chain.broadcasts).toHaveLength(1)
      expect((await escrowOf(f.escrowId)).status).toBe('COMPLETED')
      expect(await prisma.escrowTransactionSignature.count({ where: { pendingTxId: r!.id, participantId: f.sellerId } })).toBe(0)
    })

    it('A2 REFUND (seller wins, buyer absent): only the seller is a required signer; the seller signing finalizes and broadcasts', async () => {
      pg.requirePostgres('A2')
      const f = await openedDispute('a2')
      await rule(f, 'REFUND')
      const r = await round(f.escrowId)
      expect(r!.requiredSigners).toEqual([f.sellerId])
      await expect(sign(f, f.buyerId)).rejects.toThrow(/not one of the required signers/)
      expect((await sign(f, f.sellerId)).complete).toBe(true)
      expect(chain.broadcasts).toHaveLength(1)
      expect((await escrowOf(f.escrowId)).status).toBe('REFUNDED')
      expect(await prisma.escrowTransactionSignature.count({ where: { pendingTxId: r!.id, participantId: f.buyerId } })).toBe(0)
    })

    it('A3 SPLIT (seller absent): the buyer is the required signer and completes it without the seller', async () => {
      pg.requirePostgres('A3')
      const f = await openedDispute('a3')
      await rule(f, 'SPLIT')
      expect((await round(f.escrowId))!.requiredSigners).toEqual([f.buyerId])
      expect((await sign(f, f.buyerId)).complete).toBe(true)
      expect(chain.broadcasts).toHaveLength(1)
      expect((await escrowOf(f.escrowId)).status).toBe('SPLIT')
    })
  })

  // ─── B. the WINNING party is absent: gap, documented ─────────────────────────────────────────────────────
  describe('B - absent WINNING party (gap L1/L2: the round stays pending, nothing in the system moves it)', () => {
    async function expectStuck(f: Opened, winnerId: string, otherId: string, roundIdBefore: string) {
      await ageOneYear(f)
      const passes = await everyRecoveryPass(f)
      expect(passes.sweptThisEscrow).toBe(false)
      expect(passes.autoThisDispute).toBe(false)
      expect(passes.settleCompleted).toBe(false)
      expect(passes.staleThisEscrow).not.toContain('DELETED_NO_OUTCOME')
      const after = await round(f.escrowId)
      expect(after!.id).toBe(roundIdBefore)
      expect(after!.signatures).toHaveLength(0)
      expect(after!.requiredSigners).toEqual([winnerId])
      expect(await escrowOf(f.escrowId)).toMatchObject({ status: 'DISPUTED' })
      expect((await disputeOf(f.disputeId)).status).toBe('RESOLVED')
      expect(chain.broadcasts).toHaveLength(0)
      // the other party can not finish it for the absent winner, and a second ruling is refused
      await expect(sign(f, otherId)).rejects.toThrow(/not one of the required signers/)
      const again = signedRuling(f, 'REFUND')
      await expect(getDisputeService().resolveDispute(f.disputeId, ARBITER_ID, 'REFUND', undefined, undefined, undefined, again.signature, again.issuedAt)).rejects.toThrow()
    }

    it('B1 RELEASE, winner (buyer) never signs: a year later the round is untouched, still DISPUTED, nothing broadcast', async () => {
      pg.requirePostgres('B1')
      const f = await openedDispute('b1')
      await rule(f, 'RELEASE')
      const r = await round(f.escrowId)
      await expectStuck(f, f.buyerId, f.sellerId, r!.id)
    })

    it('B2 REFUND, winner (seller) never signs: a year later the round is untouched, still DISPUTED, nothing broadcast', async () => {
      pg.requirePostgres('B2')
      const f = await openedDispute('b2')
      await rule(f, 'REFUND')
      const r = await round(f.escrowId)
      await expectStuck(f, f.sellerId, f.buyerId, r!.id)
    })

    it('B3 SPLIT, the buyer (the fixed signer) never signs although the seller is present: the seller can not complete it (L2)', async () => {
      pg.requirePostgres('B3')
      const f = await openedDispute('b3')
      await rule(f, 'SPLIT')
      const r = await round(f.escrowId)
      await expectStuck(f, f.buyerId, f.sellerId, r!.id)
    })
  })

  // ─── C. timelock expiry does not move a DISPUTED escrow ─────────────────────────────────────────────────
  it('C - an escrow whose timelock expired while DISPUTED is not refunded or otherwise moved by the expiry sweeper', async () => {
    pg.requirePostgres('C')
    const f = await openedDispute('c')
    await prisma.escrow.update({ where: { id: f.escrowId }, data: { expiresAt: new Date(Date.now() - 365 * DAY) } })
    const passes = await everyRecoveryPass(f)
    expect(passes.sweptThisEscrow).toBe(false)
    expect(await escrowOf(f.escrowId)).toMatchObject({ status: 'DISPUTED' })
    expect(await round(f.escrowId)).toBeNull()
    expect(chain.broadcasts).toHaveLength(0)
  })

  // ─── D. the arbiter is absent: gap L3, documented ────────────────────────────────────────────────────────
  it('D - arbiter never rules (gap L3): a year later the dispute is still OPENED, no round exists, and only the committed arbiter can rule', async () => {
    pg.requirePostgres('D')
    const f = await openedDispute('d')
    await ageOneYear(f)
    const passes = await everyRecoveryPass(f)
    expect(passes.sweptThisEscrow).toBe(false)
    expect(passes.autoThisDispute).toBe(false)
    expect(await disputeOf(f.disputeId)).toMatchObject({ status: 'OPENED', arbiterId: ARBITER_ID })
    expect(await escrowOf(f.escrowId)).toMatchObject({ status: 'DISPUTED' })
    expect(await round(f.escrowId)).toBeNull()
    expect(chain.broadcasts).toHaveLength(0)
    // no other identity can rule instead of the script-committed arbiter
    const other = await registerTestParticipant(identityService, 'NotTheArbiter')
    const issuedAt = new Date().toISOString()
    const payload: AuthorityDecisionPayload = { disputeId: f.disputeId, escrowId: f.escrowId, appealRound: 0, authorityId: other.id, outcome: 'REFUND', buyerBps: null, issuedAt }
    const signature = signAuthorityDecision(payload, nacl.sign.keyPair().secretKey)
    await expect(getDisputeService().resolveDispute(f.disputeId, other.id, 'REFUND', undefined, undefined, undefined, signature, issuedAt)).rejects.toThrow()
    expect((await disputeOf(f.disputeId)).status).toBe('OPENED')
  })

  // ─── E. the operator process is SIGKILLed after committing the ruling ─────────────────────────────────────
  it('E - an operator process that committed a ruling and is then SIGKILLed leaves it durable; the winning party finishes the round afterwards', async () => {
    pg.requirePostgres('E')
    const f = await openedDispute('e')
    const r = signedRuling(f, 'RELEASE')
    const child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', WORKER], {
      env: {
        ...process.env, CHAIN: chainToJson(chain), DISPUTE_ID: f.disputeId, ARBITER_ID, OUTCOME: 'RELEASE', SIGNATURE: r.signature, ISSUED_AT: r.issuedAt, PGAPPNAME: 'f32-operator',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
    const started = Date.now()
    while (!out.includes('READY')) {
      if (Date.now() - started > 120_000 || child.exitCode !== null) throw new Error(`operator never became READY: ${out.slice(-400)} ${err.slice(-600)}`)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    child.kill('SIGKILL')
    expect(await exited).toMatchObject({ signal: 'SIGKILL' })

    // the operator is gone; what it committed is durable and the winner can finish without it
    expect((await disputeOf(f.disputeId)).status).toBe('RESOLVED')
    const pending = await round(f.escrowId)
    expect(pending).not.toBeNull()
    expect(pending!.requiredSigners).toEqual([f.buyerId])
    expect(pending!.signatures).toHaveLength(0)
    expect((await sign(f, f.buyerId)).complete).toBe(true)
    expect(chain.broadcasts).toHaveLength(1)
    expect((await escrowOf(f.escrowId)).status).toBe('COMPLETED')
  })
})
