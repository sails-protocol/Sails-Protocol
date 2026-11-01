// tests/integration/escrowSellerPaymentBinding.test.ts
//
// #235 R7H-E3 — seller authorization, PaymentAccount binding and payment-method reconciliation of escrow creation,
// on real PostgreSQL, on the governed rail (MULTISIG/BTC under R7_TRADE_AUTHORIZATION_POLICY_V1).
//
// Every unauthorized attempt is made through each production-reachable entrypoint — the HTTP route (real session
// tokens), the public TypeScript SDK (its real transport, bridged onto the same routes), the service, and a direct
// database write — and must leave zero economic effects: no escrow row, no settlement.escrow.created event, no
// provider call, the trade still unescrowed. Participants authenticate through the real challenge flow.

import nacl from 'tweetnacl'
import { randomBytes } from 'crypto'
import { Client } from 'pg'
import type { PrismaClient } from '@prisma/client'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { refusedThenHistoricalTrade } from './economicFixtures'
import { closeTestRedis } from './identityTestHelpers'

type Party = { id: string; token: string }

describe('#235 R7H-E3 — seller / PaymentAccount / payment-method binding of escrow creation (real PostgreSQL)', () => {
  jest.setTimeout(240_000)

  const pg = createPostgresIntegrationHarness()
  let prisma: PrismaClient
  let app: any
  let escrowService: any
  let tradeService: any
  let liquidityRouter: any
  let paymentAccountService: any
  let getSettlementProvider: (type: string) => any
  let SailsSettlementModule: any
  let SailsLiquidityModule: any
  let SailsTransport: any
  let admin: Client
  const ownedUserIds: string[] = []

  beforeAll(async () => {
    await pg.probe()
    if (!pg.isAvailable()) return
    ;({ prisma } = require('../../src/common/database'))
    require('../../src/common/events/handlers').registerEventHandlers()
    ;({ escrowService } = require('../../src/modules/open-settlement/escrow.service'))
    ;({ tradeService } = require('../../src/modules/open-p2p/trade.service'))
    ;({ liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service'))
    ;({ paymentAccountService } = require('../../src/modules/open-settlement/payment-account.service'))
    ;({ getSettlementProvider } = require('../../src/modules/open-settlement/escrow-providers'))
    ;({ SailsSettlementModule } = require('../../packages/sails-sdk/src/modules/settlement'))
    ;({ SailsLiquidityModule } = require('../../packages/sails-sdk/src/modules/liquidity'))
    ;({ SailsTransport } = require('../../packages/sails-sdk/src/transport'))
    const { buildApp } = require('../../src/app')
    app = await buildApp({ registerSwaggerUi: false })
    await app.ready()
    admin = new Client({ connectionString: process.env.DATABASE_URL })
    await admin.connect()
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
      await prisma.$executeRaw`DELETE FROM payment_accounts WHERE "ownerId" = ANY(${users})`
      await prisma.$executeRaw`DELETE FROM intent_events WHERE "intentId" IN (SELECT id FROM intents WHERE "participantId" = ANY(${users}))`
      await prisma.$executeRaw`DELETE FROM intents WHERE "participantId" = ANY(${users})`
      await prisma.$executeRaw`DELETE FROM users WHERE id = ANY(${users})`
    } finally {
      await admin.end()
      await app.close()
      await prisma.$disconnect()
      await closeTestRedis()
    }
  })

  // ─── fixtures ─────────────────────────────────────────────────────────────────────────────────────────

  /** A real participant: registered with proof of possession, logged in through the real challenge flow. */
  async function participant(label: string): Promise<Party> {
    const { identityService } = require('../../src/modules/open-identity/identity.service')
    const auth = require('../../src/common/middleware/auth')
    const keypair = nacl.sign.keyPair()
    const publicKey = Buffer.from(keypair.publicKey).toString('hex')
    const { challenge: regChallenge } = await auth.issueRegistrationChallenge(publicKey)
    const displayName = `r7he3-${label}`
    const regSig = Buffer.from(nacl.sign.detached(auth.registrationProofMessage(regChallenge, displayName), keypair.secretKey)).toString('hex')
    const user = await identityService.register({ publicKey, signature: regSig, displayName })
    ownedUserIds.push(user.id)
    const { challenge } = await auth.issueChallenge(publicKey)
    const sig = Buffer.from(nacl.sign.detached(Buffer.from(challenge), keypair.secretKey)).toString('hex')
    return { id: user.id, token: (await auth.verifySignedChallenge(publicKey, sig)).sessionToken }
  }

  const account = (ownerId: string, method = 'PIX') => paymentAccountService.getOrCreate(ownerId, `r7he3-${randomBytes(10).toString('hex')}`, method)

  /** Seller publishes a SELL offer (declaring `acct` unless null); the buyer takes it. */
  async function sellTrade(method = 'PIX', bind = true) {
    const [seller, buyer, stranger] = [await participant('seller'), await participant('buyer'), await participant('stranger')]
    const acct = bind ? await account(seller.id, method) : null
    const offer = await liquidityRouter.createOffer({ userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '65000', minAmount: '0.0001', maxAmount: '1', paymentMethod: method, ...(acct ? { paymentAccountHash: acct.accountHash } : {}) })
    const admit = () => tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.0005' })
    // #235 R7H-E3C — an unbound or ineligible-method trade is no longer admitted; the escrow guard is exercised on the
    // historical row a pre-E3C service committed, after proving the new admission is refused.
    const trade = bind && method === 'PIX' ? await admit()
      : await refusedThenHistoricalTrade(prisma, tradeService, admit, bind ? 'METHOD_NOT_ELIGIBLE' : 'UNBOUND_ACCOUNT', offer, buyer.id, '0.0005', acct?.id ?? null)
    return { seller, buyer, stranger, acct, offer, trade }
  }

  const ESCROW = (tradeId: string) => ({ tradeId, type: 'MULTISIG', asset: 'BTC', lockedAmount: '0.0005' })
  const http = (who: Party, body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/v1/settlement/escrow', headers: { authorization: `Bearer ${who.token}` }, payload: body })
  /** The public SDK, its real transport, carried over the same Fastify routes. */
  function sdk(who: Party) {
    const fetchImpl = async (url: string, init: any) => {
      const u = new URL(url)
      const res = await app.inject({ method: init?.method ?? 'GET', url: u.pathname + u.search, headers: init?.headers, payload: init?.body })
      return new Response(res.body, { status: res.statusCode, headers: { 'content-type': 'application/json' } })
    }
    const transport = new SailsTransport({ baseUrl: 'http://sails.test', fetchImpl: fetchImpl as unknown as typeof fetch })
    transport.setSessionToken(who.token)
    return { settlement: new SailsSettlementModule(transport), liquidity: new SailsLiquidityModule(transport) }
  }

  const escrowsOf = (tradeId: string) => prisma.escrow.findMany({ where: { tradeId } })
  const createdEvents = (tradeId: string) => prisma.durableEventRecord.count({ where: { correlationId: tradeId, eventName: 'settlement.escrow.created' } })

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

  /** The attempt is refused and leaves no escrow, no creation event, no provider call, no trade.escrowId. */
  async function refusedWithoutEffects(tradeId: string, attempt: () => Promise<unknown>, expectRefusal: (outcome: unknown) => void) {
    const providers = spyProviders()
    try {
      let outcome: unknown
      try { outcome = await attempt() } catch (err) { outcome = err }
      expectRefusal(outcome)
      expect(await escrowsOf(tradeId)).toEqual([])
      expect(await createdEvents(tradeId)).toBe(0)
      expect(providers.calls()).toBe(0)
      expect((await prisma.trade.findUniqueOrThrow({ where: { id: tradeId } })).escrowId).toBeNull()
    } finally {
      providers.restore()
    }
  }
  const httpStatus = (code: number, pattern?: RegExp) => (r: any) => {
    expect(r.statusCode).toBe(code)
    if (pattern) expect(r.body).toMatch(pattern)
  }
  const thrown = (code: number, pattern?: RegExp) => (e: any) => {
    expect(e).toBeInstanceOf(Error)
    expect(e.statusCode ?? e.status).toBe(code)
    if (pattern) expect(e.message).toMatch(pattern)
  }
  /** Every production-reachable entrypoint for one caller and body. */
  async function allEntrypoints(tradeId: string, who: Party, code: number, pattern: RegExp, extra: Record<string, unknown> = {}) {
    await refusedWithoutEffects(tradeId, () => http(who, { ...ESCROW(tradeId), ...extra }), httpStatus(code, pattern))
    await refusedWithoutEffects(tradeId, () => sdk(who).settlement.create({ ...ESCROW(tradeId), ...extra } as any), thrown(code, pattern))
    await refusedWithoutEffects(tradeId, () => escrowService.createEscrow({ ...ESCROW(tradeId), ...extra }, who.id), thrown(code, pattern))
  }
  /** A direct database write (the owner's credential) of an escrow on the governed rail. */
  const directInsert = (tradeId: string, type = 'MULTISIG') =>
    admin.query(`INSERT INTO escrows (id, "tradeId", type, status, "lockedAmount", asset, "updatedAt") VALUES (gen_random_uuid(), $1, $2, 'CREATED', 0.0005, 'BTC', now())`, [tradeId, type])

  // ─── E3-A: seller-only ────────────────────────────────────────────────────────────────────────────────

  it('SELLER: the trade\'s seller creates the escrow through HTTP, the SDK and the service — one escrow each, binding unchanged', async () => {
    pg.requirePostgres('E3-seller')
    for (const via of ['http', 'sdk', 'service'] as const) {
      const f = await sellTrade()
      const out = via === 'http' ? JSON.parse((await http(f.seller, ESCROW(f.trade.id))).body).data
        : via === 'sdk' ? await sdk(f.seller).settlement.create(ESCROW(f.trade.id))
          : await escrowService.createEscrow(ESCROW(f.trade.id), f.seller.id)
      expect([via, out.type, out.asset, String(out.lockedAmount)]).toEqual([via, 'MULTISIG', 'BTC', '0.0005'])
      expect(await escrowsOf(f.trade.id)).toHaveLength(1)
      expect((await prisma.trade.findUniqueOrThrow({ where: { id: f.trade.id } })).sellerPaymentAccountId).toBe(f.acct.id)
    }
  })

  it('BUYER / STRANGER / FORGED IDENTITY: refused at every entrypoint with zero effects; a payload naming the seller changes nothing', async () => {
    pg.requirePostgres('E3-buyer')
    const f = await sellTrade()
    await allEntrypoints(f.trade.id, f.buyer, 403, /Only the seller/)
    await allEntrypoints(f.trade.id, f.stranger, 403, /is not the seller/)
    // Forged identity fields in the body: identity comes only from the session.
    const forged = { sellerId: f.seller.id, participantId: f.seller.id, triggeredBy: f.seller.id, callerId: f.seller.id }
    await refusedWithoutEffects(f.trade.id, () => http(f.buyer, { ...ESCROW(f.trade.id), ...forged }), httpStatus(403, /Only the seller/))
    await refusedWithoutEffects(f.trade.id, () => sdk(f.stranger).settlement.create({ ...ESCROW(f.trade.id), ...forged } as any), thrown(403))
    await refusedWithoutEffects(f.trade.id, () => app.inject({ method: 'POST', url: '/v1/settlement/escrow', payload: ESCROW(f.trade.id) }), httpStatus(401))
    // The seller still can, afterwards: refusals consumed nothing.
    expect((await escrowService.createEscrow(ESCROW(f.trade.id), f.seller.id)).tradeId).toBe(f.trade.id)
  })

  // ─── E3-B / E3-C: PaymentAccount binding and payment method ──────────────────────────────────────────

  it('UNBOUND: a trade without a seller payment account cannot be escrowed on the governed rail, by any entrypoint or a direct write', async () => {
    pg.requirePostgres('E3-unbound')
    const f = await sellTrade('PIX', false)
    expect(f.trade.sellerPaymentAccountId).toBeNull()
    await allEntrypoints(f.trade.id, f.seller, 409, /UNBOUND_ACCOUNT/)
    await refusedWithoutEffects(f.trade.id, () => directInsert(f.trade.id), (e: any) => expect([e.code, e.message]).toEqual(['23000', expect.stringMatching(/UNBOUND_ACCOUNT/)]))
  })

  it('FOREIGN ACCOUNT / SELLER NOT COMMITTED: a trade bound (by a direct write) to another participant\'s account, or naming a seller its offer did not commit, is refused', async () => {
    pg.requirePostgres('E3-foreign')
    const f = await sellTrade('PIX', false)
    const other = await participant('other')
    const foreign = await account(other.id, 'PIX')
    // The service never binds a foreign account (bindableAccountId); simulate the row a direct writer could make.
    const t = randomBytes(6).toString('hex')
    await admin.query(`INSERT INTO trades (id, "offerId", "buyerId", "sellerId", asset, amount, "priceUsd", "totalUsd", status, "sellerPaymentAccountId", "updatedAt") VALUES ($1, $2, $3, $4, 'BTC', 0.0005, 65000, 32.5, 'ACTIVE', $5, now())`, [`r7he3-ft-${t}`, f.offer.id, f.buyer.id, f.seller.id, foreign.id])
    await allEntrypoints(`r7he3-ft-${t}`, f.seller, 409, /FOREIGN_ACCOUNT/)
    await refusedWithoutEffects(`r7he3-ft-${t}`, () => directInsert(`r7he3-ft-${t}`), (e: any) => expect(e.message).toMatch(/FOREIGN_ACCOUNT/))
    // A trade whose seller is not the offer's owner (SELL offer): the "seller" was never committed.
    const own = await account(other.id, 'PIX')
    await admin.query(`INSERT INTO trades (id, "offerId", "buyerId", "sellerId", asset, amount, "priceUsd", "totalUsd", status, "sellerPaymentAccountId", "updatedAt") VALUES ($1, $2, $3, $4, 'BTC', 0.0005, 65000, 32.5, 'ACTIVE', $5, now())`, [`r7he3-nc-${t}`, f.offer.id, f.buyer.id, other.id, own.id])
    await allEntrypoints(`r7he3-nc-${t}`, other, 409, /SELLER_NOT_COMMITTED/)
    await refusedWithoutEffects(`r7he3-nc-${t}`, () => directInsert(`r7he3-nc-${t}`), (e: any) => expect(e.message).toMatch(/SELLER_NOT_COMMITTED/))
  })

  it('METHOD MISMATCH: offer PIX over a TED account (bound by a direct write) is refused; the service refuses to bind it in the first place', async () => {
    pg.requirePostgres('E3-mismatch')
    const f = await sellTrade('PIX', false)
    const ted = await account(f.seller.id, 'TED')
    await expect(liquidityRouter.createOffer({ userId: f.seller.id, asset: 'BTC', side: 'SELL', priceUsd: '65000', minAmount: '0.0001', maxAmount: '1', paymentMethod: 'PIX', paymentAccountHash: ted.accountHash }))
      .rejects.toThrow(/is for TED, but this offer is paid by PIX/)
    const t = randomBytes(6).toString('hex')
    await admin.query(`INSERT INTO trades (id, "offerId", "buyerId", "sellerId", asset, amount, "priceUsd", "totalUsd", status, "sellerPaymentAccountId", "updatedAt") VALUES ($1, $2, $3, $4, 'BTC', 0.0005, 65000, 32.5, 'ACTIVE', $5, now())`, [`r7he3-mm-${t}`, f.offer.id, f.buyer.id, f.seller.id, ted.id])
    await allEntrypoints(`r7he3-mm-${t}`, f.seller, 409, /METHOD_MISMATCH/)
    await refusedWithoutEffects(`r7he3-mm-${t}`, () => directInsert(`r7he3-mm-${t}`), (e: any) => expect(e.message).toMatch(/METHOD_MISMATCH/))
  })

  it.each(['TED', 'BANK_TRANSFER', 'OTHER', 'CASH'])('POLICY: a consistently bound %s trade is refused — the method is not eligible under the version in force', async (method) => {
    pg.requirePostgres(`E3-policy-${method}`)
    const f = await sellTrade(method)
    expect(f.trade.sellerPaymentAccountId).toBe(f.acct.id)
    await allEntrypoints(f.trade.id, f.seller, 409, /METHOD_NOT_ELIGIBLE/)
    await refusedWithoutEffects(f.trade.id, () => directInsert(f.trade.id), (e: any) => expect(e.message).toMatch(/METHOD_NOT_ELIGIBLE/))
  })

  it('DISPLAY-ONLY METHODS: the UI filter catalog\'s methods are refused by the offer API and SDK before reaching the database', async () => {
    pg.requirePostgres('E3-display')
    const seller = await participant('display')
    const before = await prisma.offer.count({ where: { userId: seller.id } })
    for (const method of ['PAYPAL', 'ZELLE', 'MERCADO_PAGO', 'BOLETO', 'pix', '']) {
      const res = await app.inject({ method: 'POST', url: '/v1/liquidity/offers', headers: { authorization: `Bearer ${seller.token}` }, payload: { asset: 'BTC', side: 'SELL', priceUsd: '65000', minAmount: '0.0001', maxAmount: '1', paymentMethod: method } })
      expect([method, res.statusCode]).toEqual([method, 400])
      await expect(sdk(seller).liquidity.publish({ asset: 'BTC', side: 'SELL', priceUsd: '65000', minAmount: '0.0001', maxAmount: '1', paymentMethod: method } as any)).rejects.toMatchObject({ statusCode: 400 })
    }
    expect(await prisma.offer.count({ where: { userId: seller.id } })).toBe(before)
  })

  it('REVOCATION: the schema has no disabled / revoked PaymentAccount state to reject (decision requested from the CTO; a future column must extend this guard)', async () => {
    pg.requirePostgres('E3-revocation')
    const cols = (await admin.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'payment_accounts' ORDER BY 1`)).rows.map((r) => r.column_name)
    expect(cols.filter((c: string) => /revok|disabl|suspend|status|active|enabled|blocked/i.test(c))).toEqual([])
  })

  // ─── E3-D: commitment, concurrency, retries, crashes, versioned policy ────────────────────────────────

  it('COMMITTED TERMS: account owner/hash/method, the traded offer\'s terms and the escrowed trade\'s parties/amount cannot change', async () => {
    pg.requirePostgres('E3-terms')
    const f = await sellTrade()
    const other = await participant('terms-other')
    for (const [sql, id] of [
      [`UPDATE payment_accounts SET "paymentMethod" = 'TED' WHERE id = $1`, f.acct.id],
      [`UPDATE payment_accounts SET "ownerId" = '${other.id}' WHERE id = $1`, f.acct.id],
      [`UPDATE payment_accounts SET "accountHash" = 'x' WHERE id = $1`, f.acct.id],
      [`UPDATE offers SET "paymentMethod" = 'TED' WHERE id = $1`, f.offer.id],
      [`UPDATE offers SET "paymentAccountId" = NULL WHERE id = $1`, f.offer.id],
      [`UPDATE offers SET "userId" = '${other.id}' WHERE id = $1`, f.offer.id],
      [`UPDATE trades SET "sellerPaymentAccountId" = NULL WHERE id = $1`, f.trade.id],
    ] as const) {
      await expect(admin.query(sql, [id])).rejects.toMatchObject({ code: '23000' })
    }
    await escrowService.createEscrow(ESCROW(f.trade.id), f.seller.id)
    for (const sql of [`UPDATE trades SET "sellerId" = '${other.id}' WHERE id = $1`, `UPDATE trades SET amount = amount * 2 WHERE id = $1`, `UPDATE trades SET "buyerId" = '${other.id}' WHERE id = $1`]) {
      await expect(admin.query(sql, [f.trade.id])).rejects.toMatchObject({ code: '23000' })
    }
    const e = (await escrowsOf(f.trade.id))[0]
    for (const sql of [`UPDATE escrows SET type = 'MOCK' WHERE id = $1`, `UPDATE escrows SET asset = 'LIQUID_BTC' WHERE id = $1`]) {
      await expect(admin.query(sql, [e.id])).rejects.toMatchObject({ code: '23000' })
    }
    // Lifecycle stays writable.
    await admin.query(`UPDATE trades SET status = 'ACTIVE' WHERE id = $1`, [f.trade.id])
    await admin.query(`UPDATE payment_accounts SET "completedTrades" = "completedTrades" + 1 WHERE id = $1`, [f.acct.id])
  })

  it('TOCTOU: a concurrent change of the trade\'s seller waits on the authorization\'s row lock, then is refused because the escrow now exists', async () => {
    pg.requirePostgres('E3-toctou')
    const f = await sellTrade()
    const other = await participant('toctou-other')
    const [a, b] = [new Client({ connectionString: process.env.DATABASE_URL }), new Client({ connectionString: process.env.DATABASE_URL })]
    await a.connect(); await b.connect()
    try {
      await a.query('BEGIN')
      expect((await a.query(`SELECT escrow_economic_binding_violation($1, 'MULTISIG', 'BTC') AS v`, [f.trade.id])).rows[0].v).toBeNull()
      const swap = b.query(`UPDATE trades SET "sellerId" = $2 WHERE id = $1`, [f.trade.id, other.id]).then(() => 'UPDATED', (err) => err.code)
      await new Promise((r) => setTimeout(r, 300))
      await a.query(`INSERT INTO escrows (id, "tradeId", type, status, "lockedAmount", asset, "updatedAt") VALUES (gen_random_uuid(), $1, 'MULTISIG', 'CREATED', 0.0005, 'BTC', now())`, [f.trade.id])
      await a.query('COMMIT')
      expect(await swap).toBe('23000')
      expect((await prisma.trade.findUniqueOrThrow({ where: { id: f.trade.id } })).sellerId).toBe(f.seller.id)
    } finally {
      await a.end(); await b.end()
    }
  })

  it('CONCURRENCY: five nodes and the buyer/stranger racing one trade produce exactly one escrow, created by the seller', async () => {
    pg.requirePostgres('E3-concurrency')
    const f = await sellTrade()
    const nodes = Array.from({ length: 5 }, () => {
      let svc: any
      jest.isolateModules(() => { svc = require('../../src/modules/open-settlement/escrow.service').escrowService })
      return svc
    })
    const attempts = [
      ...nodes.map((svc) => svc.createEscrow(ESCROW(f.trade.id), f.seller.id)),
      escrowService.createEscrow(ESCROW(f.trade.id), f.buyer.id),
      escrowService.createEscrow(ESCROW(f.trade.id), f.stranger.id),
      http(f.seller, ESCROW(f.trade.id)),
    ]
    const results = await Promise.allSettled(attempts)
    const created = results.filter((r) => r.status === 'fulfilled' && ((r.value as any)?.id || (r.value as any)?.statusCode === 201))
    expect(created).toHaveLength(1)
    expect(await escrowsOf(f.trade.id)).toHaveLength(1)
    expect(await createdEvents(f.trade.id)).toBe(1)
    expect((results[5] as PromiseRejectedResult).reason?.statusCode).toBe(403)
    expect((results[6] as PromiseRejectedResult).reason?.statusCode).toBe(403)
  })

  it('RETRY after an ambiguous response: the repeat is refused, the original escrow and its committed account and method stand', async () => {
    pg.requirePostgres('E3-retry')
    const f = await sellTrade()
    const first = JSON.parse((await http(f.seller, ESCROW(f.trade.id))).body).data
    const retry = await http(f.seller, ESCROW(f.trade.id))
    expect(retry.statusCode).toBe(409)
    expect(await escrowsOf(f.trade.id)).toEqual([expect.objectContaining({ id: first.id })])
    const t = await prisma.trade.findUniqueOrThrow({ where: { id: f.trade.id }, include: { offer: true, sellerPaymentAccount: true } })
    expect([t.sellerPaymentAccountId, t.offer.paymentMethod, t.sellerPaymentAccount?.paymentMethod]).toEqual([f.acct.id, 'PIX', 'PIX'])
  })

  it('CRASH / RESTART: a creation killed before commit leaves nothing; a restarted node creates it once, with the same binding', async () => {
    pg.requirePostgres('E3-crash')
    const f = await sellTrade()
    const victim = new Client({ connectionString: process.env.DATABASE_URL })
    await victim.connect()
    victim.on('error', () => undefined)
    try {
      await victim.query('BEGIN')
      await victim.query(`INSERT INTO escrows (id, "tradeId", type, status, "lockedAmount", asset, "updatedAt") VALUES (gen_random_uuid(), $1, 'MULTISIG', 'CREATED', 0.0005, 'BTC', now())`, [f.trade.id])
      await admin.query('SELECT pg_terminate_backend($1)', [(victim as any).processID])
      await expect(victim.query('COMMIT')).rejects.toBeDefined()
    } finally {
      await victim.end().catch(() => undefined)
    }
    expect(await escrowsOf(f.trade.id)).toEqual([])
    let restarted: any
    jest.isolateModules(() => { restarted = require('../../src/modules/open-settlement/escrow.service').escrowService })
    const e = await restarted.createEscrow(ESCROW(f.trade.id), f.seller.id)
    await expect(restarted.createEscrow(ESCROW(f.trade.id), f.seller.id)).rejects.toThrow(/already has an escrow|first escrow/)
    expect(await escrowsOf(f.trade.id)).toEqual([expect.objectContaining({ id: e.id })])
    expect((await prisma.trade.findUniqueOrThrow({ where: { id: f.trade.id } })).sellerPaymentAccountId).toBe(f.acct.id)
  })

  it('POLICY VERSION: the decision is the version in force at the insert — a newer version (here: PIX ineligible) refuses inside its own transaction; V1 still authorizes', async () => {
    pg.requirePostgres('E3-version')
    const f = await sellTrade()
    const c = new Client({ connectionString: process.env.DATABASE_URL })
    await c.connect()
    try {
      await c.query('BEGIN')
      await c.query(`INSERT INTO trade_limit_policy_versions (id, version, label, "activatedAt", "openSettlementCapUsd", "rollingFiatCapUsd", "quoteMaxAgeSeconds", "quoteWindowSeconds", "quotePublicationMaxSeconds", "maxSourceDisagreementBps", "minAgreeingOperators", "sourceMaxAgeSeconds", "sourceFutureSkewSeconds")
                     VALUES ('r7he3-v2', 2, 'test', now() AT TIME ZONE 'UTC', 250, 750, 120, 30, 10, 100, 2, 60, 15)`)
      await c.query(`INSERT INTO trade_limit_rail_policies VALUES ('r7he3-v2', 'MULTISIG', 'BTC')`)
      await c.query(`INSERT INTO trade_limit_method_policies ("policyVersionId", "paymentMethod", eligible, "fiatWindowDays", "evidenceClass", confidence) VALUES ('r7he3-v2', 'PIX', false, NULL, 'REGULATORY', 'MEDIUM')`)
      await expect(c.query(`INSERT INTO escrows (id, "tradeId", type, status, "lockedAmount", asset, "updatedAt") VALUES (gen_random_uuid(), $1, 'MULTISIG', 'CREATED', 0.0005, 'BTC', now())`, [f.trade.id]))
        .rejects.toMatchObject({ message: expect.stringMatching(/METHOD_NOT_ELIGIBLE/) })
      // A version without the rail makes it ineligible — never ungoverned.
      await c.query('ROLLBACK')
      await c.query('BEGIN')
      await c.query(`INSERT INTO trade_limit_policy_versions (id, version, label, "activatedAt", "openSettlementCapUsd", "rollingFiatCapUsd", "quoteMaxAgeSeconds", "quoteWindowSeconds", "quotePublicationMaxSeconds", "maxSourceDisagreementBps", "minAgreeingOperators", "sourceMaxAgeSeconds", "sourceFutureSkewSeconds")
                     VALUES ('r7he3-v2', 2, 'test', now() AT TIME ZONE 'UTC', 250, 750, 120, 30, 10, 100, 2, 60, 15)`)
      await expect(c.query(`INSERT INTO escrows (id, "tradeId", type, status, "lockedAmount", asset, "updatedAt") VALUES (gen_random_uuid(), $1, 'MULTISIG', 'CREATED', 0.0005, 'BTC', now())`, [f.trade.id]))
        .rejects.toMatchObject({ message: expect.stringMatching(/RAIL_NOT_ELIGIBLE/) })
    } finally {
      await c.query('ROLLBACK').catch(() => undefined)
      await c.end()
    }
    expect((await escrowService.createEscrow(ESCROW(f.trade.id), f.seller.id)).tradeId).toBe(f.trade.id)
  })

  it('DIRECT DATABASE: an ungoverned escrow cannot be moved onto the governed rail, nor a governed escrow onto another trade', async () => {
    pg.requirePostgres('E3-direct')
    const f = await sellTrade('PIX', false)
    const mock = (await admin.query(`INSERT INTO escrows (id, "tradeId", type, status, "lockedAmount", asset, "updatedAt") VALUES (gen_random_uuid(), $1, 'MOCK', 'CREATED', 0.0005, 'BTC', now()) RETURNING id`, [f.trade.id])).rows[0].id
    await expect(admin.query(`UPDATE escrows SET type = 'MULTISIG' WHERE id = $1`, [mock])).rejects.toMatchObject({ message: expect.stringMatching(/UNBOUND_ACCOUNT/) })
    const g = await sellTrade()
    const e = await escrowService.createEscrow(ESCROW(g.trade.id), g.seller.id)
    await expect(admin.query(`UPDATE escrows SET "tradeId" = $2 WHERE id = $1`, [e.id, f.trade.id])).rejects.toMatchObject({ code: '23000' })
    await admin.query(`DELETE FROM escrows WHERE id = $1`, [mock])
  })

  it('NO REGRESSION: an existing (pre-E3) unbound MULTISIG escrow keeps its lifecycle — the guard checks only creation and rail changes', async () => {
    pg.requirePostgres('E3-legacy')
    const f = await sellTrade('PIX', false)
    const c = new Client({ connectionString: process.env.DATABASE_URL })
    await c.connect()
    let id = ''
    try {
      await c.query('BEGIN')
      await c.query('ALTER TABLE escrows DISABLE TRIGGER escrows_trade_economic_binding_guard') // a row that predates this migration
      id = (await c.query(`INSERT INTO escrows (id, "tradeId", type, status, "lockedAmount", asset, "updatedAt") VALUES (gen_random_uuid(), $1, 'MULTISIG', 'CREATED', 0.0005, 'BTC', now()) RETURNING id`, [f.trade.id])).rows[0].id
      await c.query('ALTER TABLE escrows ENABLE TRIGGER escrows_trade_economic_binding_guard')
      await c.query('COMMIT')
    } finally {
      await c.end()
    }
    await admin.query(`UPDATE escrows SET status = 'FUNDS_LOCKED', "txLockId" = $2, "txLockVout" = 0 WHERE id = $1`, [id, 'ab'.repeat(32)])
    await admin.query(`UPDATE escrows SET status = 'REFUNDED', "txReleaseId" = $2 WHERE id = $1`, [id, 'cd'.repeat(32)])
    expect((await admin.query(`SELECT status::text FROM escrows WHERE id = $1`, [id])).rows[0].status).toBe('REFUNDED')
  })
})
