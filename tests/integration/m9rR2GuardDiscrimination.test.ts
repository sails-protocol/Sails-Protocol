// tests/integration/m9rR2GuardDiscrimination.test.ts
//
// CTO 25 R-2 (GK VERIFY #615, mutants MA4 and MA11) - discriminating tests for two parts of the R2 guard
// (escrow-pending-tx.ts assertDisputedRoundMatchesOutcome) that no other test isolates:
//   - the authoritySignature binding: the live dispute keeps the same economic content (RESOLVED, same appeal round,
//     same ruling) but carries another authority signature than the one this round's provenance was built from;
//   - the declared miner fee: the fee the translator declares must be the fee its PSBT actually implies; a fee that is
//     internally consistent is accepted up to the execution-cost ceiling and refused past it (characterization).
// Real PostgreSQL, real 2-of-3 P2WSH PSBTs, real services; only the explorer is simulated. Each case starts from a
// committed RELEASE Outcome whose dispatch never persisted (C4 state) and drives the assigned arbiter's route.
import nacl from 'tweetnacl'
import * as bitcoin from 'bitcoinjs-lib'
import { createHash } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { registerTestParticipant, closeTestRedis } from './identityTestHelpers'
import { MULTISIG_CAPABILITY_PROFILE_V1 } from '@satsails/p2p-schemas'
import * as H from './pendingRoundLifecycleHarness'

describe('R2 guard discrimination - authority signature and declared miner fee (real PostgreSQL)', () => {
  jest.setTimeout(240_000)
  const pg = createPostgresIntegrationHarness()
  let prisma: any, escrowService: any, identityService: any, liquidityRouter: any, tradeService: any, getDisputeService: any
  let payoutAddressService: any, signAuthorityDecision: any, commit: any, loadDisputeRulingRecord: any, MultisigProvider: any, guard: any
  const ARBITER_ID = 'aux2-r2b-arbiter'
  const kp = nacl.sign.keyPair(); const arbPub = Buffer.from(kp.publicKey).toString('hex')
  let chain: H.Chain; let realFetch: typeof fetch; let posts = 0

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'false'; process.env.MULTISIG_SEED = process.env.MULTISIG_SEED || 'aux2-r2b-seed'; process.env.TRUSTED_ARBITRATORS = ARBITER_ID
    await pg.probe()
    if (!pg.isAvailable()) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ escrowService } = require('../../src/modules/open-settlement/escrow.service'))
    ;({ identityService } = require('../../src/modules/open-identity/identity.service'))
    ;({ liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service'))
    ;({ tradeService } = require('../../src/modules/open-p2p/trade.service'))
    ;({ getDisputeService } = require('../../src/modules/open-settlement/dispute.service'))
    ;({ payoutAddressService } = require('../../src/modules/open-settlement/payout-address.service'))
    ;({ signAuthorityDecision } = require('../../src/modules/open-settlement/arbitration-authority'))
    ;({ commitAuthoritativeDisputeRuling: commit, loadDisputeRulingRecord } = require('../../src/modules/open-settlement/dispute-outcome'))
    ;({ MultisigProvider } = require('../../src/modules/open-settlement/multisig.provider'))
    guard = require('../../src/modules/open-settlement/dispatch-translation-guard')
    const { intentEngine } = require('../../src/core/intent-engine'); const { OpenP2PTradeIntentHandler } = require('../../src/modules/open-p2p/intent-handler')
    intentEngine.registerHandler(OpenP2PTradeIntentHandler)
    await prisma.user.upsert({ where: { id: ARBITER_ID }, update: { publicKey: arbPub }, create: { id: ARBITER_ID, publicKey: arbPub, displayName: 'aux2 r2b arbiter' } })
  })
  afterAll(async () => { if (prisma) await prisma.$disconnect(); await closeTestRedis() })

  beforeEach(() => {
    if (!pg.isAvailable()) return
    chain = H.newChain(); realFetch = global.fetch; posts = 0
    const base = H.explorer(chain)
    global.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
      if (init?.method === 'POST' && String(input).endsWith('/tx')) posts++
      return base(input as string, init as RequestInit)
    }) as typeof fetch
  })
  afterEach(() => { jest.restoreAllMocks(); if (realFetch) global.fetch = realFetch })

  async function fixture(label: string) {
    const seller = await registerTestParticipant(identityService, 'Seller'); const buyer = await registerTestParticipant(identityService, 'Buyer')
    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '60000', minAmount: '0.001', maxAmount: '0.001', paymentMethod: 'OTHER' })
    const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.001' })
    const escrow = await escrowService.createEscrow({ tradeId: trade.id, type: 'MULTISIG', lockedAmount: '0.001', asset: 'BTC' }, seller.id)
    await prisma.trade.update({ where: { id: trade.id }, data: { escrowId: escrow.id } })
    const { buyerKey, sellerKey, BUYER_PUBKEY, SELLER_PUBKEY } = H.participantKeys() // one MULTISIG address per escrow (#621)
    await escrowService.submitParticipantKey(escrow.id, buyer.id, BUYER_PUBKEY, MULTISIG_CAPABILITY_PROFILE_V1)
    await escrowService.submitParticipantKey(escrow.id, seller.id, SELLER_PUBKEY, MULTISIG_CAPABILITY_PROFILE_V1)
    const funding = createHash('sha256').update(`aux2-r2b-${label}-${Math.random()}-${Date.now()}`).digest('hex')
    chain.fundings.add(funding); chain.locking = funding
    await escrowService.lockFunds(escrow.id, seller.id); chain.locking = null
    await payoutAddressService.setPayoutAddress(buyer.id, 'BTC', H.testnetAddress(`${label}-b`)); await payoutAddressService.setPayoutAddress(seller.id, 'BTC', H.testnetAddress(`${label}-s`))
    const d = await getDisputeService().raiseDispute(trade.id, buyer.id, `aux2 r2b ${label}`)
    return { escrowId: escrow.id, buyerId: buyer.id, sellerId: seller.id, disputeId: d.id as string, buyerKey, sellerKey }
  }
  type F = Awaited<ReturnType<typeof fixture>>

  /** The arbiter's signed RELEASE through the production Core commit; the dispatch is not run (C4 state). */
  async function commitRelease(f: F) {
    const issuedAt = new Date().toISOString()
    const payload = { disputeId: f.disputeId, escrowId: f.escrowId, appealRound: 0, authorityId: ARBITER_ID, outcome: 'RELEASE' as const, buyerBps: null, issuedAt }
    const d = await prisma.dispute.findUniqueOrThrow({ where: { id: f.disputeId } })
    const c = await commit({ id: f.disputeId, escrowId: f.escrowId, status: d.status, appealRound: 0 }, payload, signAuthorityDecision(payload, kp.secretKey), arbPub, '100000', 'BTC', f.buyerId, f.sellerId)
    expect(c.committed).toBe(true)
  }
  const arbiterRelease = (f: F) => escrowService.initiateRelease(f.escrowId, undefined, ARBITER_ID)
  async function nothingWritten(f: F) {
    const d = await prisma.dispute.findUniqueOrThrow({ where: { id: f.disputeId } })
    expect({ dispute: d.status, ruling: d.ruling, outcome: !!(await loadDisputeRulingRecord(f.escrowId, 0)), rounds: await prisma.escrowPendingTransaction.count({ where: { escrowId: f.escrowId } }), posts })
      .toEqual({ dispute: 'RESOLVED', ruling: 'RELEASE', outcome: true, rounds: 0, posts: 0 })
  }
  const until = async (cond: () => Promise<boolean>) => {
    for (let i = 0; i < 400; i++) { if (await cond()) return; await new Promise((r) => setTimeout(r, 50)) }
    throw new Error('condition not reached')
  }
  const waitingOnRowLock = async () => (await prisma.$queryRaw`
    SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FOR SHARE%'`)[0].n > 0
  /** Fee the PSBT actually implies: input value minus outputs. */
  const impliedFee = (psbtBase64: string) => {
    const p = bitcoin.Psbt.fromBase64(psbtBase64, { network: H.NETWORK })
    return Number(p.data.inputs[0].witnessUtxo!.value) - p.txOutputs.reduce((s, o) => s + Number(o.value), 0)
  }

  it('control: the same route with a faithful translation and the same generation creates the round', async () => {
    pg.requirePostgres('control')
    const f = await fixture('ctl')
    await commitRelease(f)
    const round = await arbiterRelease(f)
    expect(round.kind).toBe('release')
    const row = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: f.escrowId } })
    expect(row.minerFeeSats).toBe(impliedFee(row.unsignedPsbtBase64)) // the declared fee is the PSBT's own
  })

  it('authoritySignature: the live dispute keeps RESOLVED / appeal round / ruling but carries another authority signature while the round is built -> refused, nothing written', async () => {
    pg.requirePostgres('authoritySignature')
    const f = await fixture('sig')
    await commitRelease(f)
    const before = await prisma.dispute.findUniqueOrThrow({ where: { id: f.disputeId } })
    const otherSignature = createHash('sha512').update(`another authority signature ${f.disputeId}`).digest('hex')
    expect(otherSignature).not.toBe(before.authoritySignature)

    // The writer holds the dispute row (same economic content, only the signature changes); the route snapshots the
    // old provenance, parks on FOR SHARE inside the escrow lock, then reads the committed new signature.
    let commitNow!: () => void; const gate = new Promise<void>((r) => { commitNow = r })
    let held = false
    const writer = prisma.$transaction(async (tx: any) => {
      await tx.$executeRawUnsafe(`UPDATE "disputes" SET "authoritySignature" = $2 WHERE "id" = $1`, f.disputeId, otherSignature)
      held = true
      await gate
    }, { timeout: 60_000 })
    await until(async () => held)
    const dispatch = arbiterRelease(f).then(() => null, (e: Error) => e)
    await until(waitingOnRowLock)
    commitNow(); await writer

    const err = await dispatch
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toMatch(/no longer the RESOLVED generation 0 .*GK-M9R-D R2/)
    const after = await prisma.dispute.findUniqueOrThrow({ where: { id: f.disputeId } })
    expect(after).toMatchObject({ status: before.status, appealRound: before.appealRound, ruling: before.ruling, authoritySignature: otherSignature })
    await nothingWritten(f)
  })

  it('minerFeeSats (a): the translator declares a fee its PSBT does not imply -> refused as internally inconsistent, nothing written', async () => {
    pg.requirePostgres('minerFeeSats a')
    const f = await fixture('fee-a')
    await commitRelease(f)
    // The PSBT is the provider's honest one; only the fee it reports (persisted on the round, used downstream) lies.
    const orig = MultisigProvider.prototype.buildUnsignedRelease
    jest.spyOn(MultisigProvider.prototype, 'buildUnsignedRelease').mockImplementation(async function (this: any, ...args: any[]) {
      const r = await orig.apply(this, args)
      return { ...r, minerFeeSats: r.minerFeeSats + 500 }
    } as never)

    const err = await arbiterRelease(f).then(() => null, (e: Error) => e)
    expect(err).toBeInstanceOf(guard.TranslationGuardError)
    expect((err as any).mismatches.join(' ')).toMatch(/declared a miner fee of \d+ sats, but the translated PSBT actually implies \d+ sats/)
    await nothingWritten(f)
  })

  // CTO 25 T10: characterization, not a defense. The guard binds the delivered total to the Outcome only through the
  // deterministic execution-cost ceiling (execution-cost-policy.ts, M8.6), so a fee that is internally consistent is
  // accepted up to that ceiling even though the excess comes out of the beneficiary. Policy unchanged by decision.
  it.each([[0, 'accepted'], [1, 'refused']] as const)('minerFeeSats (b) characterization: an internally consistent fee %i sat(s) past the current ceiling is %s', async (beyond, verdict) => {
    pg.requirePostgres(`minerFeeSats b ${verdict}`)
    const f = await fixture(`fee-b-${verdict}`)
    await commitRelease(f)
    const { maxExecutionCostSats } = require('../../src/modules/open-settlement/execution-cost-policy')
    const GROSS = 100_000; const ceiling = Number(maxExecutionCostSats(1, BigInt(GROSS)))
    const paid = GROSS - ceiling - beyond
    // The single RELEASE output pays `paid`; the reported fee is exactly what the PSBT implies, so the declared-vs-implied
    // consistency check cannot be what decides.
    const spend = MultisigProvider.prototype.buildUnsignedSpend
    jest.spyOn(MultisigProvider.prototype, 'buildUnsignedSpend').mockImplementation(function (this: any, escrow: any, parties: any, n: number, fn: (v: bigint) => Array<{ address: string; value: bigint }>) {
      return spend.call(this, escrow, parties, n, (v: bigint) => fn(v).map((o) => ({ ...o, value: BigInt(paid) })))
    } as never)
    const release = MultisigProvider.prototype.buildUnsignedRelease
    jest.spyOn(MultisigProvider.prototype, 'buildUnsignedRelease').mockImplementation(async function (this: any, ...args: any[]) {
      const r = await release.apply(this, args)
      return { ...r, minerFeeSats: impliedFee(r.psbtBase64) }
    } as never)

    const err = await arbiterRelease(f).then(() => null, (e: Error) => e)
    console.log(`[evidence] ${JSON.stringify({ case: `minerFeeSats b ${verdict}`, ceiling, paid, impliedFee: GROSS - paid, mismatches: (err as any)?.mismatches ?? null })}`)
    expect(ceiling).toBe(20_000) // 20% of a 100 000 sat gross (MULTISIG_MAX_FEE_PROPORTION_BPS default), above the 10 000 floor
    if (verdict === 'accepted') {
      expect(err).toBeNull()
      const row = await prisma.escrowPendingTransaction.findUniqueOrThrow({ where: { escrowId: f.escrowId } })
      expect(row.minerFeeSats).toBe(ceiling)
      expect(bitcoin.Psbt.fromBase64(row.unsignedPsbtBase64, { network: H.NETWORK }).txOutputs.map((o) => Number(o.value))).toEqual([80_000])
      expect(posts).toBe(0)
    } else {
      expect(err).toBeInstanceOf(guard.TranslationGuardError)
      const mismatches = (err as any).mismatches.join(' ')
      expect(mismatches).not.toMatch(/declared a miner fee/)
      expect(mismatches).toMatch(/implied execution cost \(20001 sats.*exceeds the deterministic ceiling .*20000 sats/)
      await nothingWritten(f)
    }
  })
})
