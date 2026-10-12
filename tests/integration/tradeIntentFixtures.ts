// tests/integration/tradeIntentFixtures.ts
//
// #235 R7H-NF-E3C-5 — shared fixtures for the trade-scoped Intent suites (real PostgreSQL, real routes).
//
// Participants authenticate through the real registration + challenge flow; offers are published through the real
// liquidity service with the seller's committed PIX account (so a BTC trade is admissible under E3/E3C); trades are
// taken through the real HTTP route. Nothing here weakens a guard: a helper that needs a state the product no longer
// admits (a legacy shared-Intent trade) says so and builds it explicitly, once.

import nacl from 'tweetnacl'
import { randomBytes } from 'crypto'
import type { PrismaClient } from '@prisma/client'

export type Party = { id: string; token: string }

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
export const idemKey = () => randomBytes(12).toString('hex')

/** A real participant: registered with proof of possession, logged in through the real challenge flow. */
export async function participant(label: string): Promise<Party> {
  const { identityService } = require('../../src/modules/open-identity/identity.service')
  const auth = require('../../src/common/middleware/auth')
  const kp = nacl.sign.keyPair()
  const publicKey = Buffer.from(kp.publicKey).toString('hex')
  const { challenge: regChallenge } = await auth.issueRegistrationChallenge(publicKey)
  const displayName = `ti-${label}-${randomBytes(3).toString('hex')}`
  const regSig = Buffer.from(nacl.sign.detached(auth.registrationProofMessage(regChallenge, displayName), kp.secretKey)).toString('hex')
  const user = await identityService.register({ publicKey, signature: regSig, displayName })
  const { challenge } = await auth.issueChallenge(publicKey)
  const sig = Buffer.from(nacl.sign.detached(Buffer.from(challenge), kp.secretKey)).toString('hex')
  return { id: user.id, token: (await auth.verifySignedChallenge(publicKey, sig)).sessionToken }
}

export const call = (app: any, who: Party | null, method: string, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: who ? { authorization: `Bearer ${who.token}` } : {}, payload })

/** `status error: message` for a response, for compact assertions and evidence output. */
export const brief = (r: { statusCode: number; body: string }) => {
  if (r.statusCode < 300) return `${r.statusCode} ok`
  const b = JSON.parse(r.body)
  return `${r.statusCode} ${b.error}`
}

/** A BTC/PIX SELL offer whose seller committed a PIX account (admissible under E3/E3C). */
export async function boundSellOffer(seller: Party) {
  const { paymentAccountService } = require('../../src/modules/open-settlement/payment-account.service')
  const { liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service')
  const account = await paymentAccountService.getOrCreate(seller.id, `ti-${randomBytes(10).toString('hex')}`, 'PIX')
  const offer = await liquidityRouter.createOffer({
    userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '65000', minAmount: '0.0001', maxAmount: '1',
    paymentMethod: 'PIX', paymentAccountHash: account.accountHash,
  })
  return { offer, account }
}

/**
 * POST /v1/openp2p/trades through the real route. `key`: omitted → a fresh idempotency key; `null` → NO key at all.
 * (`undefined` would fall back to the default and generate one — hence the explicit `null` for the keyless case.)
 */
export const takeOffer = (app: any, taker: Party, offerId: string, key: string | null = idemKey(), amount = '0.0005') =>
  call(app, taker, 'POST', '/v1/openp2p/trades', { offerId, amount, ...(key ? { idempotencyKey: key } : {}) })

/**
 * Removes everything the fixtures created for `userIds`, children before parents: trade dependents, escrows, trades,
 * offers, accounts, Intents (and their events), idempotency claims and durable events.
 */
export async function cleanupFixtures(prisma: PrismaClient, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return
  const trades = await prisma.trade.findMany({ where: { OR: [{ buyerId: { in: userIds } }, { sellerId: { in: userIds } }] }, select: { id: true } })
  const tradeIds = trades.map((t) => t.id)
  const escrowIds = (await prisma.escrow.findMany({ where: { tradeId: { in: tradeIds } }, select: { id: true } })).map((e) => e.id)
  const offerIds = (await prisma.offer.findMany({ where: { userId: { in: userIds } }, select: { id: true } })).map((o) => o.id)
  const refs = await prisma.$queryRaw<Array<{ table_name: string; column_name: string }>>`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name IN ('tradeId', 'escrowId', 'interactionId') AND table_name NOT IN ('trades', 'escrows')`
  for (let pass = 0; pass < 4; pass++) {
    for (const { table_name, column_name } of refs) {
      await prisma.$executeRawUnsafe(`DELETE FROM "${table_name}" WHERE "${column_name}" = ANY($1)`, column_name === 'tradeId' ? tradeIds : escrowIds).catch(() => undefined)
    }
  }
  const intentIds = (await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM intents WHERE "participantId" = ANY(${userIds})
    UNION SELECT "intentId" FROM offers WHERE id = ANY(${offerIds}) AND "intentId" IS NOT NULL
    UNION SELECT "intentId" FROM trades WHERE id = ANY(${tradeIds}) AND "intentId" IS NOT NULL`).map((r) => r.id)
  await prisma.$executeRaw`DELETE FROM event_projection_claims WHERE "subjectId" = ANY(${tradeIds}) OR "subjectId" = ANY(${escrowIds})`
  await prisma.$executeRaw`DELETE FROM durable_events WHERE "correlationId" = ANY(${[...tradeIds, ...intentIds, ...offerIds, ...escrowIds]})`
  await prisma.$executeRaw`DELETE FROM idempotency_keys WHERE "participantId" = ANY(${userIds})`
  await prisma.$executeRaw`UPDATE trades SET "escrowId" = NULL WHERE id = ANY(${tradeIds})`
  await prisma.$executeRaw`DELETE FROM escrows WHERE id = ANY(${escrowIds})`
  await prisma.$executeRaw`DELETE FROM trades WHERE id = ANY(${tradeIds})`
  await prisma.$executeRaw`DELETE FROM offers WHERE id = ANY(${offerIds})`
  await prisma.$executeRaw`DELETE FROM payment_accounts WHERE "ownerId" = ANY(${userIds})`
  await prisma.$executeRaw`DELETE FROM payout_addresses WHERE "participantId" = ANY(${userIds})`
  await prisma.$executeRaw`DELETE FROM intent_events WHERE "intentId" = ANY(${intentIds})`
  await prisma.$executeRaw`DELETE FROM intents WHERE id = ANY(${intentIds})`
  await prisma.$executeRaw`DELETE FROM users WHERE id = ANY(${userIds})`
}
