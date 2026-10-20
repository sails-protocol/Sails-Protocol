// tests/integration/paymentAccountBindingAuthority.test.ts
//
// #235 R7C — payment-account ↔ trade binding and peer-attestation authority, on real PostgreSQL.
//
// Frozen rules under test: a PaymentAccount is the seller's (fiat receiver's) rail; the seller binds it
// to a trade when the trade is created (on the Offer for a SELL offer, at createTrade() for a BUY offer),
// checked for ownership and payment method; only the BUYER of a clean COMPLETED trade (escrow released,
// no dispute ever) may attest that trade's bound account, once, atomically; provenance distinguishes PEER
// from VOUCHER (RFC-021 D7) and LEGACY. Every authority fact is read from durable state.
//
// Real services and the real HTTP route (sessions from the real challenge-response login). A "node" is
// an independent module graph (jest.isolateModules) on the same database, as in timelockAuthority.test.ts.

import nacl from 'tweetnacl'
import { PrismaClient } from '@prisma/client'
import { randomBytes } from 'crypto'
import type { FastifyInstance } from 'fastify'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { refusedThenHistoricalTrade } from './economicFixtures'
import { closeTestRedis } from './identityTestHelpers'

const ATTESTED = 'settlement.payment_account.attested'

describe('#235 R7C — payment-account binding + peer attestation authority (real PostgreSQL)', () => {
  jest.setTimeout(180_000)

  const pg = createPostgresIntegrationHarness()
  let prisma: PrismaClient
  let app: FastifyInstance
  let liquidityRouter: any
  let tradeService: any
  let escrowService: any
  let paymentAccountService: any
  const ownedUserIds: string[] = []

  beforeAll(async () => {
    await pg.probe()
    if (!pg.isAvailable()) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service'))
    ;({ tradeService } = require('../../src/modules/open-p2p/trade.service'))
    ;({ escrowService } = require('../../src/modules/open-settlement/escrow.service'))
    ;({ paymentAccountService } = require('../../src/modules/open-settlement/payment-account.service'))
    const { buildApp } = require('../../src/app')
    app = await buildApp({ registerSwaggerUi: false })
    await app.ready()
  })

  afterAll(async () => {
    if (!pg.isAvailable()) return
    try {
      await cleanupOwnedRows()
    } finally {
      await app.close()
      await prisma.$disconnect()
      await closeTestRedis()
    }
  })

  // Only rows this suite created. A PEER-attested account and the trade that authorized it reference
  // each other (both RESTRICT) and the attestation is write-once, so the guard is disabled inside one
  // transaction just long enough to reset the suite's own accounts (same precedent as
  // legacyFeeDistributionWriteFreeze.test.ts's seedBypassingFreeze()). The rest runs as independent
  // statements: every table pointing at an owned trade/escrow, discovered from the catalog, is cleared
  // first, in a few passes so FK order never matters.
  async function cleanupOwnedRows() {
    // This suite's participants are all named 'r7c-…', so a run that died before cleaning up is swept too.
    const named = await prisma.user.findMany({ where: { displayName: { startsWith: 'r7c-' } }, select: { id: true } })
    const users = [...new Set([...ownedUserIds, ...named.map((u) => u.id)])]
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE "payment_accounts" DISABLE TRIGGER payment_accounts_attestation_write_once_guard')
      await tx.$executeRaw`UPDATE payment_accounts SET signed = false, "signedBy" = NULL, "signedAt" = NULL, "attestationSource" = NULL, "attestedTradeId" = NULL WHERE "ownerId" = ANY(${users})`
      await tx.$executeRawUnsafe('ALTER TABLE "payment_accounts" ENABLE TRIGGER payment_accounts_attestation_write_once_guard')
    })
    const tradeIds = (await prisma.trade.findMany({ where: { OR: [{ buyerId: { in: users } }, { sellerId: { in: users } }] }, select: { id: true } })).map((t) => t.id)
    const escrowIds = (await prisma.escrow.findMany({ where: { tradeId: { in: tradeIds } }, select: { id: true } })).map((e) => e.id)
    const refs = await prisma.$queryRaw<Array<{ table_name: string; column_name: string }>>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name IN ('tradeId', 'escrowId', 'interactionId') AND table_name NOT IN ('trades', 'escrows')`
    for (let pass = 0; pass < 4; pass++) {
      for (const { table_name, column_name } of refs) {
        const ids = column_name === 'tradeId' ? tradeIds : escrowIds
        await prisma.$executeRawUnsafe(`DELETE FROM "${table_name}" WHERE "${column_name}" = ANY($1)`, ids).catch(() => undefined)
      }
    }
    await prisma.$executeRaw`UPDATE trades SET "escrowId" = NULL WHERE id = ANY(${tradeIds})`
    await prisma.$executeRaw`DELETE FROM escrows WHERE id = ANY(${escrowIds})`
    await prisma.$executeRaw`DELETE FROM trades WHERE id = ANY(${tradeIds})`
    await prisma.$executeRaw`DELETE FROM offers WHERE "userId" = ANY(${users})`
    await prisma.$executeRaw`DELETE FROM payment_accounts WHERE "ownerId" = ANY(${users})`
    await prisma.$executeRaw`DELETE FROM vouches WHERE "voucherId" = ANY(${users}) OR "voucheeId" = ANY(${users})`
    await prisma.$executeRaw`DELETE FROM payout_addresses WHERE "participantId" = ANY(${users})`
    // Intent events hash-chain per intent, so removing all of an owned intent's events breaks no other chain.
    await prisma.$executeRaw`DELETE FROM intent_events WHERE "intentId" IN (SELECT id FROM intents WHERE "participantId" = ANY(${users}))`
    await prisma.$executeRaw`DELETE FROM intents WHERE "participantId" = ANY(${users})`
    await prisma.$executeRaw`DELETE FROM users WHERE id = ANY(${users})`
  }

  // ─── fixtures ─────────────────────────────────────────────────────────────────────────────────────────

  /** A real participant: registered with proof of possession, logged in through the real challenge flow. */
  async function participant(label: string): Promise<{ id: string; token: string }> {
    const { identityService } = require('../../src/modules/open-identity/identity.service')
    const auth = require('../../src/common/middleware/auth')
    const keypair = nacl.sign.keyPair()
    const publicKey = Buffer.from(keypair.publicKey).toString('hex')
    const { challenge: regChallenge } = await auth.issueRegistrationChallenge(publicKey)
    const regSig = Buffer.from(nacl.sign.detached(auth.registrationProofMessage(regChallenge, label), keypair.secretKey)).toString('hex')
    const user = await identityService.register({ publicKey, signature: regSig, displayName: label })
    ownedUserIds.push(user.id)
    const { challenge } = await auth.issueChallenge(publicKey)
    const sig = Buffer.from(nacl.sign.detached(Buffer.from(challenge), keypair.secretKey)).toString('hex')
    const verdict = await auth.verifySignedChallenge(publicKey, sig)
    return { id: user.id, token: verdict.sessionToken }
  }

  const account = (ownerId: string, method = 'PIX') =>
    paymentAccountService.getOrCreate(ownerId, `r7c-${randomBytes(10).toString('hex')}`, method)

  const offer = (userId: string, side: 'SELL' | 'BUY', extra: Record<string, unknown> = {}) =>
    liquidityRouter.createOffer({ userId, asset: 'BTC', side, priceUsd: '65000', minAmount: '0.0001', maxAmount: '1', paymentMethod: 'PIX', ...extra })

  /** Seller publishes a SELL offer declaring `acct`; buyer takes it. */
  async function boundTrade(seller: { id: string }, buyer: { id: string }, acct: { accountHash: string }) {
    const o = await offer(seller.id, 'SELL', { paymentAccountHash: acct.accountHash })
    return tradeService.createTrade({ offerId: o.id, counterpartyId: buyer.id, amount: '0.0005' })
  }

  /** The real clean path on the MOCK rail: escrow, lock, payment sent, release — no dispute. */
  async function completeCleanly(trade: { id: string; sellerId: string }, seller: { id: string }, buyer: { id: string }) {
    // A release pays the buyer's registered payout address (escrow-lifecycle.ts resolvePayoutAddress()).
    await prisma.payoutAddress.upsert({
      where: { participantId_asset: { participantId: buyer.id, asset: 'BTC' } },
      create: { participantId: buyer.id, asset: 'BTC', address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx' },
      update: {},
    })
    const escrow = await escrowService.createEscrow({ tradeId: trade.id, type: 'MOCK', lockedAmount: '0.0005', asset: 'BTC' }, trade.sellerId)
    await escrowService.lockFunds(escrow.id, seller.id)
    await escrowService.markPaymentSent(escrow.id, buyer.id)
    await escrowService.releaseFunds(escrow.id, undefined, seller.id)
    for (let i = 0; i < 50; i++) {
      if ((await prisma.trade.findUniqueOrThrow({ where: { id: trade.id } })).status === 'COMPLETED') return escrow
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error('trade never projected COMPLETED')
  }

  /** A trade forced into an end state by writing the durable rows directly (state fixtures only). */
  async function tradeInState(trade: { id: string; sellerId: string }, buyer: { id: string }, tradeStatus: string, escrowStatus: string | null, disputed: boolean) {
    if (escrowStatus) {
      const escrow = await escrowService.createEscrow({ tradeId: trade.id, type: 'MOCK', lockedAmount: '0.0005', asset: 'BTC' }, trade.sellerId)
      await prisma.escrow.update({ where: { id: escrow.id }, data: { status: escrowStatus as any } })
      if (disputed) await prisma.dispute.create({ data: { tradeId: trade.id, escrowId: escrow.id, openedBy: buyer.id, reason: 'r7c fixture' } })
    }
    await prisma.trade.update({ where: { id: trade.id }, data: { status: tradeStatus as any } })
  }

  const attestHttp = (accountHash: string, token: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/v1/settlement/payment-accounts/${accountHash}/sign`, headers: { authorization: `Bearer ${token}` }, payload })

  const row = (accountHash: string) => prisma.paymentAccount.findUniqueOrThrow({ where: { accountHash } })
  const events = (tradeId: string) => prisma.durableEventRecord.count({ where: { eventName: ATTESTED, correlationId: tradeId } })
  const snapshot = async (accountHash: string, tradeId?: string) => ({
    account: await row(accountHash),
    trade: tradeId ? await prisma.trade.findUniqueOrThrow({ where: { id: tradeId } }) : null,
    events: tradeId ? await events(tradeId) : null,
  })

  // ─── binding ──────────────────────────────────────────────────────────────────────────────────────────

  it('T1/T4: a SELL offer declares the seller\'s own account and every trade taken from it binds exactly that account', async () => {
    pg.requirePostgres('T1/T4')
    const seller = await participant('r7c-seller-1'); const buyer = await participant('r7c-buyer-1')
    const acct = await account(seller.id)
    const o = await offer(seller.id, 'SELL', { paymentAccountHash: acct.accountHash })
    expect(o.paymentAccountId).toBe(acct.id)
    const trade = await tradeService.createTrade({ offerId: o.id, counterpartyId: buyer.id, amount: '0.0005' })
    expect((await prisma.trade.findUniqueOrThrow({ where: { id: trade.id } })).sellerPaymentAccountId).toBe(acct.id)
  })

  it('T1/T4: on a BUY offer the taker is the seller and binds their own account at createTrade()', async () => {
    pg.requirePostgres('T1 BUY')
    const buyer = await participant('r7c-buyer-maker'); const seller = await participant('r7c-seller-taker')
    const acct = await account(seller.id)
    const o = await offer(buyer.id, 'BUY')
    const trade = await tradeService.createTrade({ offerId: o.id, counterpartyId: seller.id, amount: '0.0005', paymentAccountHash: acct.accountHash })
    expect([trade.sellerId, trade.sellerPaymentAccountId]).toEqual([seller.id, acct.id])
  })

  it('T2/T17: nobody binds another participant\'s account — offer and trade paths refuse (403) and write nothing', async () => {
    pg.requirePostgres('T2')
    const seller = await participant('r7c-seller-2'); const other = await participant('r7c-other-2'); const buyer = await participant('r7c-buyer-2')
    const othersAccount = await account(other.id)
    const offersBefore = await prisma.offer.count({ where: { userId: seller.id } })
    const intentsBefore = await prisma.intent.count({ where: { participantId: seller.id } })
    // A forged ownerId naming the account's real owner changes nothing: ownership is checked against the session's participant.
    await expect(offer(seller.id, 'SELL', { paymentAccountHash: othersAccount.accountHash, ownerId: other.id })).rejects.toMatchObject({ statusCode: 403 })
    expect(await prisma.offer.count({ where: { userId: seller.id } })).toBe(offersBefore)
    expect(await prisma.intent.count({ where: { participantId: seller.id } })).toBe(intentsBefore)

    const buyOffer = await offer(buyer.id, 'BUY')
    await expect(tradeService.createTrade({ offerId: buyOffer.id, counterpartyId: seller.id, amount: '0.0005', paymentAccountHash: othersAccount.accountHash })).rejects.toMatchObject({ statusCode: 403 })
    expect(await prisma.trade.count({ where: { offerId: buyOffer.id } })).toBe(0)
  })

  it('T3: a payment-method mismatch is refused (400) on both paths — the old PIX-trade → TED-account substitution', async () => {
    pg.requirePostgres('T3')
    const seller = await participant('r7c-seller-3'); const buyer = await participant('r7c-buyer-3')
    const ted = await account(seller.id, 'TED')
    await expect(offer(seller.id, 'SELL', { paymentAccountHash: ted.accountHash })).rejects.toMatchObject({ statusCode: 400 })
    const buyOffer = await offer(buyer.id, 'BUY')
    await expect(tradeService.createTrade({ offerId: buyOffer.id, counterpartyId: seller.id, amount: '0.0005', paymentAccountHash: ted.accountHash })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('wrong declarer: a BUY offer cannot declare an account, and the buyer cannot choose one on a SELL offer', async () => {
    pg.requirePostgres('declarer')
    const seller = await participant('r7c-seller-d'); const buyer = await participant('r7c-buyer-d')
    const buyersAccount = await account(buyer.id)
    await expect(offer(buyer.id, 'BUY', { paymentAccountHash: buyersAccount.accountHash })).rejects.toMatchObject({ statusCode: 400 })
    const sellersAccount = await account(seller.id)
    const sellOffer = await offer(seller.id, 'SELL', { paymentAccountHash: sellersAccount.accountHash })
    await expect(tradeService.createTrade({ offerId: sellOffer.id, counterpartyId: buyer.id, amount: '0.0005', paymentAccountHash: buyersAccount.accountHash })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('T5: the binding cannot be substituted after creation — no write path, and the database refuses a direct UPDATE', async () => {
    pg.requirePostgres('T5')
    const seller = await participant('r7c-seller-5'); const buyer = await participant('r7c-buyer-5')
    const acct = await account(seller.id); const other = await account(seller.id)
    const trade = await boundTrade(seller, buyer, acct)
    await expect(prisma.trade.update({ where: { id: trade.id }, data: { sellerPaymentAccountId: other.id } })).rejects.toThrow(/sellerPaymentAccountId is fixed at creation/)
    await expect(prisma.trade.update({ where: { id: trade.id }, data: { sellerPaymentAccountId: null } })).rejects.toThrow(/fixed at creation/)
    expect((await prisma.trade.findUniqueOrThrow({ where: { id: trade.id } })).sellerPaymentAccountId).toBe(acct.id)
  })

  // ─── attestation authority ────────────────────────────────────────────────────────────────────────────

  it('T6/T16/T25: the buyer of a clean COMPLETED trade attests its bound account over HTTP — PEER, server-derived signer, one event', async () => {
    pg.requirePostgres('T6')
    const seller = await participant('r7c-seller-6'); const buyer = await participant('r7c-buyer-6')
    const acct = await account(seller.id)
    const trade = await boundTrade(seller, buyer, acct)
    await completeCleanly(trade, seller, buyer)
    expect(await paymentAccountService.getTradeLimit(acct.accountHash)).toBe('0.001')
    // The clean completion itself counted once (#235 R7D); the attestation below must not touch the counters.
    const counters = await row(acct.accountHash)
    expect([counters.completedTrades, counters.chargebacks]).toEqual([1, 0])

    const res = await attestHttp(acct.accountHash, buyer.token, { tradeId: trade.id, signedBy: 'forged', attestationSource: 'VOUCHER', ownerId: 'forged' })

    expect(res.statusCode).toBe(200)
    const after = await row(acct.accountHash)
    expect([after.signed, after.signedBy, after.attestationSource, after.attestedTradeId, after.completedTrades, after.chargebacks])
      .toEqual([true, buyer.id, 'PEER', trade.id, counters.completedTrades, counters.chargebacks])
    expect(await paymentAccountService.getTradeLimit(acct.accountHash)).toBe('0.01')
    expect(await events(trade.id)).toBe(1)
  })

  describe('T7-T10/T26/T27: refused attestations change nothing', () => {
    let seller: any, buyer: any, stranger: any, acct: any, otherAcct: any, trade: any

    beforeAll(async () => {
      if (!pg.isAvailable()) return
      seller = await participant('r7c-seller-7'); buyer = await participant('r7c-buyer-7'); stranger = await participant('r7c-stranger-7')
      acct = await account(seller.id); otherAcct = await account(seller.id)
      trade = await boundTrade(seller, buyer, acct)
      await completeCleanly(trade, seller, buyer)
    })

    async function refused(accountHash: string, token: string, tradeId: string, status: number) {
      const before = await snapshot(accountHash, tradeId)
      const res = await attestHttp(accountHash, token, { tradeId })
      expect(res.statusCode).toBe(status)
      expect(await snapshot(accountHash, tradeId)).toEqual(before)
    }

    it('T7: the seller cannot attest their own account (403)', async () => {
      pg.requirePostgres('T7'); await refused(acct.accountHash, seller.token, trade.id, 403)
    })
    it('T8: an unrelated authenticated user cannot attest (403) — nor can the seller\'s second keypair, which is not this trade\'s buyer', async () => {
      pg.requirePostgres('T8'); await refused(acct.accountHash, stranger.token, trade.id, 403)
    })
    it('T9: the buyer of a different clean trade cannot use it to attest this account', async () => {
      pg.requirePostgres('T9')
      const otherSeller = await participant('r7c-seller-9'); const otherAcct9 = await account(otherSeller.id)
      const otherTrade = await boundTrade(otherSeller, stranger, otherAcct9)
      await completeCleanly(otherTrade, otherSeller, stranger)
      await refused(acct.accountHash, stranger.token, trade.id, 403) // not the buyer of `trade`
      await refused(acct.accountHash, stranger.token, otherTrade.id, 400) // their trade is bound to a different account
    })
    it('T10: the buyer cannot attest the seller\'s OTHER account through this trade (400)', async () => {
      pg.requirePostgres('T10'); await refused(otherAcct.accountHash, buyer.token, trade.id, 400)
    })
    it('missing tradeId (400) and unknown trade (404)', async () => {
      pg.requirePostgres('selector')
      const before = await row(acct.accountHash)
      expect((await attestHttp(acct.accountHash, buyer.token, {})).statusCode).toBe(400)
      expect((await attestHttp(acct.accountHash, buyer.token, { tradeId: '00000000-0000-0000-0000-000000000000' })).statusCode).toBe(404)
      expect(await row(acct.accountHash)).toEqual(before)
    })
  })

  describe('T11-T15: only a CLEAN completion authorizes attestation', () => {
    it.each([
      ['T11 pending (no escrow)', 'PENDING', null, false],
      ['T11 active (funds locked)', 'ACTIVE', 'FUNDS_LOCKED', false],
      ['T12/T13 cancelled after refund', 'CANCELLED', 'REFUNDED', false],
      ['T14 split (Trade COMPLETED, escrow SPLIT)', 'COMPLETED', 'SPLIT', true],
      ['T15 released after a dispute (Trade + escrow COMPLETED)', 'COMPLETED', 'COMPLETED', true],
      ['T15 currently disputed', 'DISPUTED', 'DISPUTED', true],
    ])('%s → 400, account untouched', async (_label, tradeStatus, escrowStatus, disputed) => {
      pg.requirePostgres('T11-T15')
      const seller = await participant('r7c-seller-s'); const buyer = await participant('r7c-buyer-s')
      const acct = await account(seller.id)
      const trade = await boundTrade(seller, buyer, acct)
      await tradeInState(trade, buyer, tradeStatus, escrowStatus, disputed)
      const before = await snapshot(acct.accountHash, trade.id)
      expect((await attestHttp(acct.accountHash, buyer.token, { tradeId: trade.id })).statusCode).toBe(400)
      expect(await snapshot(acct.accountHash, trade.id)).toEqual(before)
    })
  })

  it('T26: a clean but UNBOUND trade (legacy shape) cannot attest — no account is inferred from the seller\'s accounts', async () => {
    pg.requirePostgres('T26')
    const seller = await participant('r7c-seller-26'); const buyer = await participant('r7c-buyer-26')
    const acct = await account(seller.id) // the seller DOES own a matching PIX account
    const o = await offer(seller.id, 'SELL') // but declared none
    // #235 R7H-E3C — such a trade is no longer admitted; attestation is checked on the historical (pre-E3C) row.
    const trade = await refusedThenHistoricalTrade(prisma, tradeService, () => tradeService.createTrade({ offerId: o.id, counterpartyId: buyer.id, amount: '0.0005' }), 'UNBOUND_ACCOUNT', o, buyer.id, '0.0005')
    expect(trade.sellerPaymentAccountId).toBeNull()
    await completeCleanly(trade, seller, buyer)
    const before = await snapshot(acct.accountHash, trade.id)
    expect((await attestHttp(acct.accountHash, buyer.token, { tradeId: trade.id })).statusCode).toBe(400)
    expect(await snapshot(acct.accountHash, trade.id)).toEqual(before)
  })

  // ─── races, idempotency ───────────────────────────────────────────────────────────────────────────────

  it('T18/T19: the legitimate buyer racing the seller and a stranger — only the buyer can ever win', async () => {
    pg.requirePostgres('T18/T19')
    const seller = await participant('r7c-seller-18'); const buyer = await participant('r7c-buyer-18'); const stranger = await participant('r7c-stranger-18')
    const acct = await account(seller.id)
    const trade = await boundTrade(seller, buyer, acct)
    await completeCleanly(trade, seller, buyer)
    const results = await Promise.allSettled([
      paymentAccountService.attestFromTrade(trade.id, acct.accountHash, stranger.id),
      paymentAccountService.attestFromTrade(trade.id, acct.accountHash, seller.id),
      paymentAccountService.attestFromTrade(trade.id, acct.accountHash, buyer.id),
      paymentAccountService.attestFromTrade(trade.id, acct.accountHash, stranger.id),
    ])
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected', 'fulfilled', 'rejected'])
    expect((await row(acct.accountHash)).signedBy).toBe(buyer.id)
  })

  it('T20: duplicate concurrent requests by the legitimate buyer — all succeed, exactly one write, one event', async () => {
    pg.requirePostgres('T20')
    const seller = await participant('r7c-seller-20'); const buyer = await participant('r7c-buyer-20')
    const acct = await account(seller.id)
    const trade = await boundTrade(seller, buyer, acct)
    await completeCleanly(trade, seller, buyer)
    const results = await Promise.all(Array.from({ length: 6 }, () => paymentAccountService.attestFromTrade(trade.id, acct.accountHash, buyer.id)))
    const signedAts = new Set(results.map((r: any) => r.signedAt.getTime()))
    expect(signedAts.size).toBe(1)
    expect(await events(trade.id)).toBe(1)
  })

  it('T13/T18: two DIFFERENT legitimate buyers (two clean trades on one account) racing — exactly one canonical attestation, never overwritten', async () => {
    pg.requirePostgres('two buyers')
    const seller = await participant('r7c-seller-2b'); const b1 = await participant('r7c-buyer-2b1'); const b2 = await participant('r7c-buyer-2b2')
    const acct = await account(seller.id)
    // One offer is taken once (its Intent moves on), so two SELL offers declare the same account.
    const t1 = await boundTrade(seller, b1, acct)
    const t2 = await boundTrade(seller, b2, acct)
    await completeCleanly(t1, seller, b1); await completeCleanly(t2, seller, b2)
    await Promise.all([
      paymentAccountService.attestFromTrade(t1.id, acct.accountHash, b1.id),
      paymentAccountService.attestFromTrade(t2.id, acct.accountHash, b2.id),
    ])
    const final = await row(acct.accountHash)
    expect([[b1.id, t1.id], [b2.id, t2.id]]).toContainEqual([final.signedBy, final.attestedTradeId])
    expect((await events(t1.id)) + (await events(t2.id))).toBe(1)
    // A later authorized attestation is a no-op; the database refuses any direct rewrite.
    await paymentAccountService.attestFromTrade(t1.id, acct.accountHash, b1.id)
    expect(await row(acct.accountHash)).toEqual(final)
    await expect(prisma.paymentAccount.update({ where: { id: acct.id }, data: { signedBy: 'someone-else' } })).rejects.toThrow(/attestation is write-once/)
  })

  // ─── restart / second node ────────────────────────────────────────────────────────────────────────────

  it('T21/T22: node A binds and completes; node B — a fresh module graph, as after a restart — attests from the database alone', async () => {
    pg.requirePostgres('T21/T22')
    const seller = await participant('r7c-seller-21'); const buyer = await participant('r7c-buyer-21')
    const acct = await account(seller.id)
    // Node A: this suite's booted graph binds the account and completes the trade.
    const trade = await boundTrade(seller, buyer, acct)
    await completeCleanly(trade, seller, buyer)

    // Node B: nothing about the seller's selection exists in its memory.
    const freshGraph = () => {
      let g: any
      jest.isolateModules(() => {
        g = {
          accounts: require('../../src/modules/open-settlement/payment-account.service').paymentAccountService,
          redis: require('../../src/common/redis').redis,
        }
      })
      return g
    }
    const nodeB = freshGraph()
    const nodeC = freshGraph()
    try {
      // Node B must still refuse everyone but the bound trade's buyer, and the wrong account.
      await expect(nodeB.accounts.attestFromTrade(trade.id, acct.accountHash, seller.id)).rejects.toMatchObject({ statusCode: 403 })
      const attested = await nodeB.accounts.attestFromTrade(trade.id, acct.accountHash, buyer.id)
      expect([attested.attestationSource, attested.attestedTradeId, attested.signedBy]).toEqual(['PEER', trade.id, buyer.id])
      // A third graph sees the same durable truth and cannot add a second attestation.
      const again = await nodeC.accounts.attestFromTrade(trade.id, acct.accountHash, buyer.id)
      expect(again.signedAt.getTime()).toBe(attested.signedAt.getTime())
      expect(await events(trade.id)).toBe(1)
    } finally {
      await nodeB.redis.quit().catch(() => undefined)
      await nodeC.redis.quit().catch(() => undefined)
    }
  })

  // ─── voucher provenance ───────────────────────────────────────────────────────────────────────────────

  it('T23/T24: voucher onboarding still signs a newcomer\'s first account — provenance VOUCHER, no trade', async () => {
    pg.requirePostgres('T23/T24')
    const voucher = await participant('r7c-voucher'); const newcomer = await participant('r7c-newcomer')
    await prisma.vouch.create({ data: { voucherId: voucher.id, voucheeId: newcomer.id } })
    const acct = await account(newcomer.id)
    expect([acct.signed, acct.signedBy, acct.attestationSource, acct.attestedTradeId]).toEqual([true, voucher.id, 'VOUCHER', null])
  })

  it('voucher then peer: a vouched account bound to a clean trade keeps its VOUCHER provenance — the first canonical attestation stands', async () => {
    pg.requirePostgres('voucher-then-peer')
    const voucher = await participant('r7c-voucher-2'); const seller = await participant('r7c-seller-v'); const buyer = await participant('r7c-buyer-v')
    await prisma.vouch.create({ data: { voucherId: voucher.id, voucheeId: seller.id } })
    const acct = await account(seller.id)
    const trade = await boundTrade(seller, buyer, acct)
    await completeCleanly(trade, seller, buyer)
    const res = await attestHttp(acct.accountHash, buyer.token, { tradeId: trade.id })
    expect(res.statusCode).toBe(200)
    expect((await row(acct.accountHash)).attestationSource).toBe('VOUCHER')
    expect(await events(trade.id)).toBe(0)
  })

  it('the database refuses provenance that does not add up: PEER without a trade, VOUCHER with one, unsigned with a source', async () => {
    pg.requirePostgres('CHECK')
    const owner = await participant('r7c-owner-chk')
    const acct = await account(owner.id)
    await expect(prisma.paymentAccount.update({ where: { id: acct.id }, data: { signed: true, signedBy: owner.id, signedAt: new Date(), attestationSource: 'PEER' } })).rejects.toThrow(/payment_accounts_attestation_check/)
    await expect(prisma.paymentAccount.update({ where: { id: acct.id }, data: { attestationSource: 'VOUCHER' } })).rejects.toThrow(/payment_accounts_attestation_check/)
    expect((await row(acct.accountHash)).signed).toBe(false)
  })
})
