// tests/integration/sellerPaymentAccountJourney.test.ts
//
// #235 R7H-E3B — the seller's PaymentAccount binding as the UI performs it, end to end on real PostgreSQL.
//
// The code under test is the UI's own (packages/sails-ui/src/lib/paymentAccountBinding.ts, exactly what
// PublishOffer.tsx, OfferDetail.tsx and Trade.tsx call) driving the real SailsClient the UI ships with, whose
// transport is carried over the real Fastify routes (app.inject) — real session tokens from the real challenge
// flow, the real register / publish / trade / escrow routes, the real E3 database guard. Nothing is mocked.
//
// A — the legitimate journeys reach a protected (MULTISIG/BTC) escrow: SELL (maker = seller), BUY (taker =
// seller), reuse of an already-registered account, and retries (double submit, a lost response) without
// duplicates. B — every refusal leaves zero downstream effects: no offer, no trade, no escrow, no creation
// event, no provider call.

import nacl from 'tweetnacl'
import { randomBytes } from 'crypto'
import { Client } from 'pg'
import type { PrismaClient } from '@prisma/client'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { deleteFixtureAccounts, refusedThenHistoricalTrade } from './economicFixtures'
import { closeTestRedis } from './identityTestHelpers'

type Party = { id: string; token: string; client: any }

describe('#235 R7H-E3B — seller PaymentAccount UI binding journeys (real routes, real PostgreSQL)', () => {
  jest.setTimeout(240_000)

  const pg = createPostgresIntegrationHarness()
  let prisma: PrismaClient
  let app: any
  let getSettlementProvider: (type: string) => any
  let SailsClient: any
  let hashPaymentAccount: (method: string, raw: string) => string
  let ui: typeof import('../../packages/sails-ui/src/lib/paymentAccountBinding')
  const ownedUserIds: string[] = []
  /** Requests whose response is lost after the server processed them (an ambiguous outcome for the client). */
  const loseResponse: Array<{ method: string; path: RegExp }> = []

  beforeAll(async () => {
    await pg.probe()
    if (!pg.isAvailable()) return
    ;({ prisma } = require('../../src/common/database'))
    require('../../src/common/events/handlers').registerEventHandlers()
    ;({ getSettlementProvider } = require('../../src/modules/open-settlement/escrow-providers'))
    ;({ SailsClient, hashPaymentAccount } = require('../../packages/sails-sdk/src/index'))
    ui = require('../../packages/sails-ui/src/lib/paymentAccountBinding')
    const { buildApp } = require('../../src/app')
    app = await buildApp({ registerSwaggerUi: false })
    await app.ready()
  })

  afterAll(async () => {
    if (!pg.isAvailable()) return
    try {
      const users = ownedUserIds
      const tradeIds = (await prisma.trade.findMany({ where: { OR: [{ buyerId: { in: users } }, { sellerId: { in: users } }] }, select: { id: true } })).map((t) => t.id)
      const escrowIds = (await prisma.escrow.findMany({ where: { tradeId: { in: tradeIds } }, select: { id: true } })).map((e) => e.id)
      const refs = await prisma.$queryRaw<Array<{ table_name: string; column_name: string }>>`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name IN ('tradeId', 'escrowId', 'interactionId') AND table_name NOT IN ('trades', 'escrows')`
      for (let pass = 0; pass < 4; pass++) {
        for (const { table_name, column_name } of refs) {
          await prisma.$executeRawUnsafe(`DELETE FROM "${table_name}" WHERE "${column_name}" = ANY($1)`, column_name === 'tradeId' ? tradeIds : escrowIds).catch(() => undefined)
        }
      }
      await prisma.$executeRaw`DELETE FROM event_projection_claims WHERE "subjectId" = ANY(${tradeIds}) OR "subjectId" = ANY(${escrowIds})`
      await prisma.$executeRaw`UPDATE trades SET "escrowId" = NULL WHERE id = ANY(${tradeIds})`
      await prisma.$executeRaw`DELETE FROM escrows WHERE id = ANY(${escrowIds})`
      await prisma.$executeRaw`DELETE FROM trades WHERE id = ANY(${tradeIds})`
      await prisma.$executeRaw`DELETE FROM offers WHERE "userId" = ANY(${users})`
      await deleteFixtureAccounts(prisma, users)
      await prisma.$executeRaw`DELETE FROM intent_events WHERE "intentId" IN (SELECT id FROM intents WHERE "participantId" = ANY(${users}))`
      await prisma.$executeRaw`DELETE FROM intents WHERE "participantId" = ANY(${users})`
      await prisma.$executeRaw`DELETE FROM users WHERE id = ANY(${users})`
    } finally {
      await app.close()
      await prisma.$disconnect()
      await closeTestRedis()
    }
  })

  // ─── fixtures ─────────────────────────────────────────────────────────────────────────────────────────

  /** The UI's own SailsClient (default options), its transport carried over the real Fastify routes. */
  function uiClient(token: string) {
    const fetchImpl = async (url: string, init: any) => {
      const u = new URL(url)
      const method = init?.method ?? 'GET'
      const res = await app.inject({ method, url: u.pathname + u.search, headers: init?.headers, payload: init?.body })
      const lost = loseResponse.findIndex((l) => l.method === method && l.path.test(u.pathname))
      if (lost >= 0) {
        loseResponse.splice(lost, 1)
        throw new TypeError('network connection lost')
      }
      return new Response(res.body, { status: res.statusCode, headers: { 'content-type': 'application/json' } })
    }
    const client = new SailsClient({ baseUrl: 'http://sails.test', fetchImpl: fetchImpl as unknown as typeof fetch })
    client.setSessionToken(token)
    return client
  }

  /** A real participant: registered with proof of possession, logged in through the real challenge flow. */
  async function participant(label: string): Promise<Party> {
    const { identityService } = require('../../src/modules/open-identity/identity.service')
    const auth = require('../../src/common/middleware/auth')
    const keypair = nacl.sign.keyPair()
    const publicKey = Buffer.from(keypair.publicKey).toString('hex')
    const { challenge: regChallenge } = await auth.issueRegistrationChallenge(publicKey)
    const displayName = `r7he3b-${label}`
    const regSig = Buffer.from(nacl.sign.detached(auth.registrationProofMessage(regChallenge, displayName), keypair.secretKey)).toString('hex')
    const user = await identityService.register({ publicKey, signature: regSig, displayName })
    ownedUserIds.push(user.id)
    const { challenge } = await auth.issueChallenge(publicKey)
    const sig = Buffer.from(nacl.sign.detached(Buffer.from(challenge), keypair.secretKey)).toString('hex')
    const token = (await auth.verifySignedChallenge(publicKey, sig)).sessionToken
    return { id: user.id, token, client: uiClient(token) }
  }

  /** A fresh, never-registered receiving key (a random PIX key — the raw value only the seller knows). */
  const pixKey = () => `r7he3b-pix-${randomBytes(12).toString('hex')}`
  const idem = () => randomBytes(16).toString('hex')

  /** PublishOffer.tsx's publish call, for an offer on the governed rail. */
  const publish = (who: Party, side: 'SELL' | 'BUY', paymentMethod: string, paymentDetails: string, extra: Record<string, unknown> = {}) =>
    who.client.liquidity.publish({
      asset: 'BTC', side, priceUsd: '65000.00000000', minAmount: '0.0001', maxAmount: '0.001',
      paymentMethod, paymentDetails, idempotencyKey: idem(), ...extra,
    })

  /** Trade.tsx's escrow call (no explicit rail: the SDK's recommendedEscrowType picks MULTISIG for BTC). */
  const createEscrow = (who: Party, trade: { id: string; amount: string; asset: string }) =>
    who.client.settlement.create({ tradeId: trade.id, lockedAmount: trade.amount, asset: trade.asset })

  const escrowsOf = (tradeId: string) => prisma.escrow.findMany({ where: { tradeId } })
  const createdEvents = (tradeId: string) => prisma.durableEventRecord.count({ where: { correlationId: tradeId, eventName: 'settlement.escrow.created' } })
  const accountsWithHash = (accountHash: string) => prisma.paymentAccount.findMany({ where: { accountHash } })

  /** Every function on every provider, spied: "no provider side effect" is asserted, not assumed. */
  function spyProviders() {
    const spies: jest.SpyInstance[] = []
    for (const type of ['MULTISIG', 'LIGHTNING_HODL', 'WDK_USDT_EVM', 'SAFE_GUARD_EVM', 'MOCK']) {
      const provider = getSettlementProvider(type)
      let proto = Object.getPrototypeOf(provider)
      const names = new Set<string>()
      while (proto && proto !== Object.prototype) {
        for (const n of Object.getOwnPropertyNames(proto)) if (n !== 'constructor' && typeof provider[n] === 'function') names.add(n)
        proto = Object.getPrototypeOf(proto)
      }
      for (const n of names) spies.push(jest.spyOn(provider, n))
    }
    return { calls: () => spies.reduce((sum, s) => sum + s.mock.calls.length, 0), restore: () => spies.forEach((s) => s.mockRestore()) }
  }

  /** The escrow attempt is refused and leaves no escrow, no creation event, no provider call, no trade.escrowId. */
  async function escrowRefusedClean(tradeId: string, attempt: () => Promise<unknown>): Promise<any> {
    const providers = spyProviders()
    try {
      const err = await attempt().then(() => null, (e) => e)
      expect(err).toBeInstanceOf(Error)
      expect(await escrowsOf(tradeId)).toEqual([])
      expect(await createdEvents(tradeId)).toBe(0)
      expect(providers.calls()).toBe(0)
      expect((await prisma.trade.findUniqueOrThrow({ where: { id: tradeId } })).escrowId).toBeNull()
      return err
    } finally {
      providers.restore()
    }
  }

  /** Counts of what a participant has created, to prove a refusal created nothing. */
  const footprint = async (userId: string) => ({
    offers: await prisma.offer.count({ where: { userId } }),
    trades: await prisma.trade.count({ where: { OR: [{ buyerId: userId }, { sellerId: userId }] } }),
    accounts: await prisma.paymentAccount.count({ where: { ownerId: userId } }),
  })

  /** Every public table whose rows mention `needle` anywhere — what the database persisted of a raw value. */
  async function tablesMentioning(needle: string): Promise<string[]> {
    const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`
    const hits: string[] = []
    for (const { table_name } of tables) {
      const [{ n }] = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM "${table_name}" t WHERE t::text LIKE $1`, `%${needle}%`)
      if (Number(n) > 0) hits.push(table_name)
    }
    return hits
  }

  // ─── the policy the UI reads ──────────────────────────────────────────────────────────────────────────

  it('POLICY: the public read-only endpoint reports the version in force, its governed rails and eligible methods — the database\'s own answer', async () => {
    pg.requirePostgres('E3B-policy')
    const res = await app.inject({ method: 'GET', url: '/v1/settlement/economic-policy' })
    expect(res.statusCode).toBe(200)
    const policy = JSON.parse(res.body).data
    const [db] = await prisma.$queryRaw<Array<{ version: number; label: string }>>`
      SELECT v.version, v.label FROM trade_limit_policy_versions v
      WHERE v.id = trade_limit_effective_policy_version(clock_timestamp() AT TIME ZONE 'UTC')`
    expect([policy.version, policy.label]).toEqual([db.version, db.label])
    expect(policy.rails).toContainEqual({ escrowType: 'MULTISIG', asset: 'BTC', eligible: true })
    expect(policy.paymentMethods).toContainEqual({ paymentMethod: 'PIX', eligible: true })
    // The UI's reading of it agrees with the server's E3 guard (asserted against real escrows in B-UNSUPPORTED).
    expect(ui.protectedEscrowEligibility(policy, 'BTC', 'PIX')).toEqual({ governed: true, eligible: true })
    expect(ui.protectedEscrowEligibility(policy, 'BTC', 'TED')).toEqual({ governed: true, eligible: false, reason: 'METHOD_NOT_ELIGIBLE', eligibleMethods: ['PIX'] })
    expect(ui.protectedEscrowEligibility(policy, 'USDT_ERC20', 'TED')).toEqual({ governed: false })
    // The SDK method the UI calls returns the same document.
    const seller = await participant('policy')
    expect(await seller.client.settlement.economicPolicy()).toEqual(policy)
  })

  it('POLICY VERSION: the view follows the version in force (method or rail no longer eligible) exactly as the E3 guard decides, in the same transaction', async () => {
    pg.requirePostgres('E3B-policy-version')
    const { ECONOMIC_POLICY_QUERY, toEconomicPolicyView } = require('../../src/modules/open-settlement/economic-policy')
    const [seller, buyer] = [await participant('pv-s'), await participant('pv-b')]
    const key = pixKey()
    const { accountHash } = await ui.bindSellerPaymentAccount(seller.client, seller.id, 'PIX', key)
    const offer = await publish(seller, 'SELL', 'PIX', key, { paymentAccountHash: accountHash })
    const trade = await buyer.client.openp2p.trade(offer.id, '0.0005', idem())
    const c = new Client({ connectionString: process.env.DATABASE_URL })
    await c.connect()
    // A version installed inside this transaction only (policy rows are immutable once committed).
    const installV2 = async (withRail: boolean) => {
      await c.query('BEGIN')
      await c.query(`INSERT INTO trade_limit_policy_versions (id, version, label, "activatedAt", "openSettlementCapUsd", "rollingFiatCapUsd", "quoteMaxAgeSeconds", "quoteWindowSeconds", "quotePublicationMaxSeconds", "maxSourceDisagreementBps", "minAgreeingOperators", "sourceMaxAgeSeconds", "sourceFutureSkewSeconds")
                     VALUES ('r7he3b-v2', 2, 'test', now() AT TIME ZONE 'UTC', 250, 750, 120, 30, 10, 100, 2, 60, 15)`)
      if (withRail) {
        await c.query(`INSERT INTO trade_limit_rail_policies VALUES ('r7he3b-v2', 'MULTISIG', 'BTC')`)
        await c.query(`INSERT INTO trade_limit_method_policies ("policyVersionId", "paymentMethod", eligible, "fiatWindowDays", "evidenceClass", confidence) VALUES ('r7he3b-v2', 'PIX', false, NULL, 'REGULATORY', 'MEDIUM')`)
      }
      return toEconomicPolicyView((await c.query(ECONOMIC_POLICY_QUERY.text)).rows[0])
    }
    const guard = () => c.query(`INSERT INTO escrows (id, "tradeId", type, status, "lockedAmount", asset, "updatedAt") VALUES (gen_random_uuid(), $1, 'MULTISIG', 'CREATED', 0.0005, 'BTC', now())`, [trade.id])
    try {
      const methodOff = await installV2(true)
      expect([methodOff.version, methodOff.paymentMethods]).toEqual([2, [{ paymentMethod: 'PIX', eligible: false }]])
      expect(ui.protectedEscrowEligibility(methodOff, 'BTC', 'PIX')).toMatchObject({ governed: true, eligible: false, reason: 'METHOD_NOT_ELIGIBLE' })
      await expect(guard()).rejects.toMatchObject({ message: expect.stringMatching(/METHOD_NOT_ELIGIBLE/) })
      await c.query('ROLLBACK')

      const railOff = await installV2(false)
      expect(railOff.rails).toContainEqual({ escrowType: 'MULTISIG', asset: 'BTC', eligible: false }) // still governed, never dropped
      expect(ui.protectedEscrowEligibility(railOff, 'BTC', 'PIX')).toMatchObject({ governed: true, eligible: false, reason: 'RAIL_NOT_ELIGIBLE' })
      await expect(guard()).rejects.toMatchObject({ message: expect.stringMatching(/RAIL_NOT_ELIGIBLE/) })
    } finally {
      await c.query('ROLLBACK').catch(() => undefined)
      await c.end()
    }
    // Back under V1 (nothing was committed): the UI's view and the server both authorize the bound trade.
    expect(ui.protectedEscrowEligibility(await seller.client.settlement.economicPolicy(), 'BTC', 'PIX')).toEqual({ governed: true, eligible: true })
    expect((await createEscrow(seller, trade)).type).toBe('MULTISIG')
  })

  // ─── A: legitimate journeys ───────────────────────────────────────────────────────────────────────────

  it('A-SELL: the maker registers and proves their PIX account, publishes bound; the buyer takes it; the seller creates the protected escrow', async () => {
    pg.requirePostgres('E3B-A-sell')
    const [seller, buyer] = [await participant('a-sell-s'), await participant('a-sell-b')]
    const key = pixKey()
    const { accountHash } = await ui.bindSellerPaymentAccount(seller.client, seller.id, 'PIX', key)
    expect(accountHash).toBe(hashPaymentAccount('PIX', key))
    const offer = await publish(seller, 'SELL', 'PIX', key, { paymentAccountHash: accountHash })
    const trade = await buyer.client.openp2p.trade(offer.id, '0.0005', idem())
    const escrow = await createEscrow(seller, trade)

    expect([escrow.type, escrow.asset, String(Number(escrow.lockedAmount))]).toEqual(['MULTISIG', 'BTC', '0.0005'])
    const [account] = await accountsWithHash(accountHash)
    expect(account.ownerId).toBe(seller.id)
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } })).paymentAccountId).toBe(account.id)
    const row = await prisma.trade.findUniqueOrThrow({ where: { id: trade.id } })
    expect([row.sellerId, row.sellerPaymentAccountId]).toEqual([seller.id, account.id])
    expect(await escrowsOf(trade.id)).toHaveLength(1)
    // What the Trade page computes for this trade: nothing blocks the seller.
    const policy = await seller.client.settlement.economicPolicy()
    const viewed = await seller.client.openp2p.getTrade(trade.id)
    expect(ui.protectedEscrowBlocker(ui.protectedEscrowEligibility(policy, viewed.asset, viewed.offer.paymentMethod), viewed.sellerPaymentAccountId)).toBeNull()
  })

  it('A-BUY: the taker of a BUY offer is the seller — their own account is bound to the trade, never the publisher\'s', async () => {
    pg.requirePostgres('E3B-A-buy')
    const [maker, taker] = [await participant('a-buy-maker'), await participant('a-buy-taker')]
    // The publisher (the buyer) has a registered PIX account of their own: it must not be the one bound.
    const makerAccount = await ui.bindSellerPaymentAccount(maker.client, maker.id, 'PIX', pixKey())
    const offer = await publish(maker, 'BUY', 'PIX', 'pago via PIX')
    expect(offer.paymentAccountId ?? null).toBeNull()

    const { accountHash } = await ui.bindSellerPaymentAccount(taker.client, taker.id, 'PIX', pixKey())
    const trade = await taker.client.openp2p.trade(offer.id, '0.0005', idem(), accountHash)
    const [takerAccount] = await accountsWithHash(accountHash)
    const row = await prisma.trade.findUniqueOrThrow({ where: { id: trade.id } })
    expect([row.buyerId, row.sellerId, row.sellerPaymentAccountId]).toEqual([maker.id, taker.id, takerAccount.id])
    expect(row.sellerPaymentAccountId).not.toBe((await accountsWithHash(makerAccount.accountHash))[0].id)

    // The publisher is the buyer: their escrow attempt is refused with zero effects; only the seller creates it.
    const err = await escrowRefusedClean(trade.id, () => createEscrow(maker, trade))
    expect(err.statusCode).toBe(403)
    const escrow = await createEscrow(taker, trade)
    expect([escrow.type, escrow.asset]).toEqual(['MULTISIG', 'BTC'])
  })

  it('A-REUSE: binding an already-registered own account again resolves the same row — a second offer and trade reuse it', async () => {
    pg.requirePostgres('E3B-A-reuse')
    const [seller, buyer] = [await participant('a-reuse-s'), await participant('a-reuse-b')]
    const key = pixKey()
    const first = await ui.bindSellerPaymentAccount(seller.client, seller.id, 'PIX', key)
    const again = await ui.bindSellerPaymentAccount(seller.client, seller.id, 'PIX', `  ${key}  `) // the UI trims what was typed
    expect(again).toEqual(first)
    const [account, ...rest] = await accountsWithHash(first.accountHash)
    expect(rest).toEqual([])
    for (let i = 0; i < 2; i++) {
      const offer = await publish(seller, 'SELL', 'PIX', key, { paymentAccountHash: again.accountHash })
      const trade = await buyer.client.openp2p.trade(offer.id, '0.0005', idem())
      expect((await prisma.trade.findUniqueOrThrow({ where: { id: trade.id } })).sellerPaymentAccountId).toBe(account.id)
      await createEscrow(seller, trade)
    }
    expect(await prisma.paymentAccount.count({ where: { ownerId: seller.id } })).toBe(1)
  })

  it('A-RETRY: a double submit binds one account; a lost response on publish or trade is retried with the same key into one offer / one trade', async () => {
    pg.requirePostgres('E3B-A-retry')
    const [seller, buyer, taker] = [await participant('a-retry-s'), await participant('a-retry-b'), await participant('a-retry-t')]
    const key = pixKey()
    // Double submit of the same binding (two clicks): one row, both calls succeed with the same answer.
    const both = await Promise.allSettled([
      ui.bindSellerPaymentAccount(seller.client, seller.id, 'PIX', key),
      ui.bindSellerPaymentAccount(seller.client, seller.id, 'PIX', key),
    ])
    const settled = both.map((s) => (s.status === 'fulfilled' ? s.value : String(s.reason)))
    expect(settled).toEqual([{ accountHash: hashPaymentAccount('PIX', key) }, { accountHash: hashPaymentAccount('PIX', key) }])
    expect(await accountsWithHash(hashPaymentAccount('PIX', key))).toHaveLength(1)

    // SELL publish whose response is lost: the UI keeps its idempotency key for the retry.
    const publishKey = idem()
    const input = { asset: 'BTC', side: 'SELL', priceUsd: '65000.00000000', minAmount: '0.0001', maxAmount: '0.001', paymentMethod: 'PIX', paymentDetails: key, paymentAccountHash: hashPaymentAccount('PIX', key), idempotencyKey: publishKey }
    loseResponse.push({ method: 'POST', path: /^\/v1\/liquidity\/offers$/ })
    await expect(seller.client.liquidity.publish(input)).rejects.toThrow()
    const offer = await seller.client.liquidity.publish(input)
    expect(await prisma.offer.count({ where: { userId: seller.id } })).toBe(1)
    expect(offer.paymentAccountId).toBe((await accountsWithHash(input.paymentAccountHash))[0].id)

    // BUY-taker trade whose response is lost: same idempotency key and binding → the same trade.
    const maker = buyer
    const buyOffer = await publish(maker, 'BUY', 'PIX', 'pago via PIX')
    const { accountHash } = await ui.bindSellerPaymentAccount(taker.client, taker.id, 'PIX', pixKey())
    const tradeKey = idem()
    loseResponse.push({ method: 'POST', path: /^\/v1\/openp2p\/trades$/ })
    await expect(taker.client.openp2p.trade(buyOffer.id, '0.0005', tradeKey, accountHash)).rejects.toThrow()
    const trade = await taker.client.openp2p.trade(buyOffer.id, '0.0005', tradeKey, accountHash)
    expect(await prisma.trade.count({ where: { offerId: buyOffer.id } })).toBe(1)
    expect((await prisma.trade.findUniqueOrThrow({ where: { id: trade.id } })).sellerPaymentAccountId).toBe((await accountsWithHash(accountHash))[0].id)
    // The same key with a different account is a different request — refused, never silently rebound.
    const other = await ui.bindSellerPaymentAccount(taker.client, taker.id, 'PIX', pixKey())
    await expect(taker.client.openp2p.trade(buyOffer.id, '0.0005', tradeKey, other.accountHash)).rejects.toThrow()
    expect(await prisma.trade.count({ where: { offerId: buyOffer.id } })).toBe(1)
  })

  // ─── B: refusals ──────────────────────────────────────────────────────────────────────────────────────

  it('B-FOREIGN: knowing another participant\'s key (or its hash) proves nothing — binding, publishing and trading with it are refused, nothing is created', async () => {
    pg.requirePostgres('E3B-B-foreign')
    const [victim, attacker, maker] = [await participant('b-foreign-v'), await participant('b-foreign-a'), await participant('b-foreign-m')]
    const key = pixKey()
    const { accountHash } = await ui.bindSellerPaymentAccount(victim.client, victim.id, 'PIX', key)
    const before = await footprint(attacker.id)

    await expect(ui.bindSellerPaymentAccount(attacker.client, attacker.id, 'PIX', key)).rejects.toThrow(ui.PaymentAccountBindingError)
    await expect(publish(attacker, 'SELL', 'PIX', key, { paymentAccountHash: accountHash })).rejects.toMatchObject({ statusCode: 403 })
    const buyOffer = await publish(maker, 'BUY', 'PIX', 'pago via PIX')
    await expect(attacker.client.openp2p.trade(buyOffer.id, '0.0005', idem(), accountHash)).rejects.toMatchObject({ statusCode: 403 })

    expect(await footprint(attacker.id)).toEqual(before)
    expect(await prisma.trade.count({ where: { offerId: buyOffer.id } })).toBe(0)
    const [account, ...rest] = await accountsWithHash(accountHash)
    expect([account.ownerId, rest]).toEqual([victim.id, []])
  })

  it('B-MISSING: an unregistered hash is refused at publish and trade; a trade with no binding (a pre-E3B client) is refused at escrow with the legacy message', async () => {
    pg.requirePostgres('E3B-B-missing')
    const [seller, maker] = [await participant('b-missing-s'), await participant('b-missing-m')]
    const unregistered = hashPaymentAccount('PIX', pixKey())
    await expect(publish(seller, 'SELL', 'PIX', 'x', { paymentAccountHash: unregistered })).rejects.toMatchObject({ statusCode: 404 })
    const buyOffer = await publish(maker, 'BUY', 'PIX', 'pago via PIX')
    await expect(seller.client.openp2p.trade(buyOffer.id, '0.0005', idem(), unregistered)).rejects.toMatchObject({ statusCode: 404 })
    expect(await footprint(seller.id)).toEqual({ offers: 0, trades: 0, accounts: 0 })

    // #235 R7H-E3C — a taker whose client sends no binding is refused at admission (nothing is created), and the UI
    // says why. A trade of that shape from before E3C exists only as a historical row: its escrow stays refused by the
    // E3 guard, and the Trade page says why before (its notice) and after (the mapped refusal).
    const attempt = () => seller.client.openp2p.trade(buyOffer.id, '0.0005', idem())
    expect(ui.tradeAdmissionRefusalMessage(await attempt().then(() => null, (e: unknown) => e))).toMatch(/não tem uma conta de recebimento/)
    const unbound = await refusedThenHistoricalTrade(prisma, require('../../src/modules/open-p2p/trade.service').tradeService, attempt, 'UNBOUND_ACCOUNT', buyOffer, seller.id, '0.0005')
    const policy = await seller.client.settlement.economicPolicy()
    const viewed = await seller.client.openp2p.getTrade(unbound.id)
    const notice = ui.protectedEscrowBlocker(ui.protectedEscrowEligibility(policy, viewed.asset, viewed.offer.paymentMethod), viewed.sellerPaymentAccountId)
    const err = await escrowRefusedClean(unbound.id, () => createEscrow(seller, unbound))
    expect(err.message).toMatch(/UNBOUND_ACCOUNT/)
    expect(ui.escrowBindingRefusalMessage(err)).toBe(notice)
    expect(notice).toMatch(/sem uma conta de recebimento do vendedor vinculada/)
  })

  it('B-UNSUPPORTED: a method the policy does not make eligible — the UI\'s answer is the server\'s; display-only methods never reach the database', async () => {
    pg.requirePostgres('E3B-B-unsupported')
    const [seller, buyer] = [await participant('b-unsup-s'), await participant('b-unsup-b')]
    const policy = await seller.client.settlement.economicPolicy()
    expect(ui.protectedEscrowEligibility(policy, 'BTC', 'TED')).toMatchObject({ governed: true, eligible: false, reason: 'METHOD_NOT_ELIGIBLE' })
    // A client that ignores the UI's block anyway: a fully bound TED trade is refused at admission (#235 R7H-E3C), and
    // the historical row of that shape is refused at escrow by the server.
    const { accountHash } = await ui.bindSellerPaymentAccount(seller.client, seller.id, 'TED', pixKey())
    const offer = await publish(seller, 'SELL', 'TED', 'conta TED', { paymentAccountHash: accountHash })
    const attempt = () => buyer.client.openp2p.trade(offer.id, '0.0005', idem())
    expect(ui.tradeAdmissionRefusalMessage(await attempt().then(() => null, (e: unknown) => e))).toMatch(/não é aceito para escrow protegido/)
    const trade = await refusedThenHistoricalTrade(prisma, require('../../src/modules/open-p2p/trade.service').tradeService, attempt, 'METHOD_NOT_ELIGIBLE', offer, buyer.id, '0.0005', (await accountsWithHash(accountHash))[0].id)
    const err = await escrowRefusedClean(trade.id, () => createEscrow(seller, trade))
    expect(err.message).toMatch(/METHOD_NOT_ELIGIBLE/)
    expect(ui.escrowBindingRefusalMessage(err)).toBe(ui.protectedEscrowBlocker(ui.protectedEscrowEligibility(policy, 'BTC', 'TED'), 'bound'))
    // Methods outside the canonical enum are refused by the route before any write.
    const before = await footprint(seller.id)
    for (const method of ['PAYPAL', 'WISE', 'pix']) {
      await expect(publish(seller, 'SELL', method, 'x')).rejects.toMatchObject({ statusCode: 400 })
      await expect(seller.client.paymentAccounts.register(hashPaymentAccount(method, pixKey()), method)).rejects.toMatchObject({ statusCode: 400 })
    }
    expect(await footprint(seller.id)).toEqual(before)
  })

  it('B-FORGED IDENTITY: the claimed seller id is never trusted — the server registers to the session, and the UI refuses an account it does not own', async () => {
    pg.requirePostgres('E3B-B-forged')
    const [seller, attacker] = [await participant('b-forged-s'), await participant('b-forged-a')]
    const key = pixKey()
    // The attacker's session, claiming to be the seller: the row is the attacker's, so the binding is refused.
    await expect(ui.bindSellerPaymentAccount(attacker.client, seller.id, 'PIX', key)).rejects.toThrow(ui.PaymentAccountBindingError)
    const [row] = await accountsWithHash(hashPaymentAccount('PIX', key))
    expect(row.ownerId).toBe(attacker.id)
    expect(await prisma.paymentAccount.count({ where: { ownerId: seller.id } })).toBe(0)
    // A body naming another owner / counterparty changes nothing on the server either.
    const res = await app.inject({
      method: 'POST', url: '/v1/settlement/payment-accounts', headers: { authorization: `Bearer ${attacker.token}` },
      payload: { accountHash: hashPaymentAccount('PIX', pixKey()), paymentMethod: 'PIX', ownerId: seller.id },
    })
    expect([201, 400]).toContain(res.statusCode)
    expect(await prisma.paymentAccount.count({ where: { ownerId: seller.id } })).toBe(0)
  })

  it('B-MISMATCH: an own account of another method cannot back a PIX offer or a PIX trade', async () => {
    pg.requirePostgres('E3B-B-mismatch')
    const [seller, maker] = [await participant('b-mismatch-s'), await participant('b-mismatch-m')]
    const ted = await ui.bindSellerPaymentAccount(seller.client, seller.id, 'TED', pixKey())
    await expect(publish(seller, 'SELL', 'PIX', 'x', { paymentAccountHash: ted.accountHash })).rejects.toMatchObject({ statusCode: 400 })
    const buyOffer = await publish(maker, 'BUY', 'PIX', 'pago via PIX')
    await expect(seller.client.openp2p.trade(buyOffer.id, '0.0005', idem(), ted.accountHash)).rejects.toMatchObject({ statusCode: 400 })
    expect(await footprint(seller.id)).toEqual({ offers: 0, trades: 0, accounts: 1 })
    // A SELL offer's buyer can never choose the account.
    const own = await ui.bindSellerPaymentAccount(maker.client, maker.id, 'PIX', pixKey())
    const sellOffer = await publish(maker, 'SELL', 'PIX', 'k', { paymentAccountHash: own.accountHash })
    await expect(seller.client.openp2p.trade(sellOffer.id, '0.0005', idem(), ted.accountHash)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('B-OWNERSHIP CHALLENGED: whoever registers a key first owns it — the real owner\'s binding then fails closed with an understandable message (residual: no proof of control)', async () => {
    pg.requirePostgres('E3B-B-squat')
    const [owner, squatter] = [await participant('b-squat-o'), await participant('b-squat-x')]
    const key = pixKey() // e.g. a phone-number PIX key, guessable by anyone
    await squatter.client.paymentAccounts.register(hashPaymentAccount('PIX', key), 'PIX')
    const err = await ui.bindSellerPaymentAccount(owner.client, owner.id, 'PIX', key).then(() => null, (e) => e)
    expect(err).toBeInstanceOf(ui.PaymentAccountBindingError)
    expect(err.message).toMatch(/registrada por outro participante/)
    expect(err.message).not.toContain(key)
    expect(await prisma.paymentAccount.count({ where: { ownerId: owner.id } })).toBe(0)
  })

  it('B-CONCURRENT / AMBIGUOUS: two participants racing to register one key — exactly one owner; only that one can bind it', async () => {
    pg.requirePostgres('E3B-B-race')
    const [a, b] = [await participant('b-race-a'), await participant('b-race-b')]
    const key = pixKey()
    const outcomes = await Promise.allSettled([
      ui.bindSellerPaymentAccount(a.client, a.id, 'PIX', key),
      ui.bindSellerPaymentAccount(b.client, b.id, 'PIX', key),
    ])
    const rows = await accountsWithHash(hashPaymentAccount('PIX', key))
    expect(rows).toHaveLength(1)
    const winner = rows[0].ownerId === a.id ? 0 : 1
    expect(outcomes[winner].status).toBe('fulfilled')
    const lost = outcomes[1 - winner]
    expect(lost.status === 'rejected' && lost.reason).toBeInstanceOf(ui.PaymentAccountBindingError) // a clean refusal, never a 500
    // The loser's retry stays refused: the outcome is decided, not re-raced.
    const loser = winner === 0 ? b : a
    await expect(ui.bindSellerPaymentAccount(loser.client, loser.id, 'PIX', key)).rejects.toThrow(ui.PaymentAccountBindingError)
  })

  // ─── privacy ──────────────────────────────────────────────────────────────────────────────────────────

  it('PRIVACY: a BUY-taker\'s raw key never reaches the server; a SELL maker\'s appears only where they chose to publish it', async () => {
    pg.requirePostgres('E3B-privacy')
    const [maker, taker, seller] = [await participant('p-maker'), await participant('p-taker'), await participant('p-seller')]
    const takerKey = pixKey()
    const buyOffer = await publish(maker, 'BUY', 'PIX', 'pago via PIX')
    const { accountHash } = await ui.bindSellerPaymentAccount(taker.client, taker.id, 'PIX', takerKey)
    await taker.client.openp2p.trade(buyOffer.id, '0.0005', idem(), accountHash)
    expect(await tablesMentioning(takerKey)).toEqual([])

    const sellerKey = pixKey()
    const bound = await ui.bindSellerPaymentAccount(seller.client, seller.id, 'PIX', sellerKey)
    await publish(seller, 'SELL', 'PIX', sellerKey, { paymentAccountHash: bound.accountHash })
    // The raw key is persisted only as the offer's own payment details (shown to the buyer by design);
    // payment_accounts holds only its unsalted hash, which anyone knowing the key can recompute.
    expect(await tablesMentioning(sellerKey)).toEqual(['offers'])
    expect((await accountsWithHash(bound.accountHash))[0].accountHash).toBe(hashPaymentAccount('PIX', sellerKey))
  })
})
