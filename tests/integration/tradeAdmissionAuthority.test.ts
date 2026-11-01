// tests/integration/tradeAdmissionAuthority.test.ts
//
// #235 R7H-E3C — canonical trade admission, on real PostgreSQL.
//
// A new trade whose canonical escrow route is governed (V1: BTC → MULTISIG) is admitted only if that escrow could be
// authorized: escrow_economic_binding_violation() — the E3 authority — is evaluated on the new trade row inside the
// transaction that inserts it, and any violation rolls the insert back. The canonical route is the production one
// (ADR-002 §11 translation + the single registered implementation); a test-only MOCK escrow never makes an otherwise
// invalid BTC trade admissible, in any environment (CTO D-E3C-1, Option A). Assets with no governed canonical route
// keep their behaviour.
//
// Every refusal is checked through the HTTP route (real session tokens), the public SDK (its real transport over the
// same routes), the service and the repository, and must leave nothing durable behind: no trade, no escrow, no event,
// no exposure reservation, no provider call, no Intent walk, no change to the offer or any PaymentAccount.

import nacl from 'tweetnacl'
import { randomBytes } from 'crypto'
import { Client } from 'pg'
import type { PrismaClient } from '@prisma/client'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { deleteFixtureAccounts, refusedThenHistoricalTrade } from './economicFixtures'
import { closeTestRedis } from './identityTestHelpers'

type Party = { id: string; token: string }

describe('#235 R7H-E3C — canonical trade admission (real PostgreSQL)', () => {
  jest.setTimeout(240_000)

  const pg = createPostgresIntegrationHarness()
  let prisma: PrismaClient
  let app: any
  let tradeService: any
  let tradeRepository: any
  let escrowService: any
  let liquidityRouter: any
  let paymentAccountService: any
  let getSettlementProvider: (type: string) => any
  let SailsOpenP2PModule: any
  let SailsTransport: any
  let admin: Client
  const ownedUserIds: string[] = []

  beforeAll(async () => {
    await pg.probe()
    if (!pg.isAvailable()) return
    ;({ prisma } = require('../../src/common/database'))
    require('../../src/common/events/handlers').registerEventHandlers()
    ;({ tradeService } = require('../../src/modules/open-p2p/trade.service'))
    ;({ tradeRepository } = require('../../src/modules/open-p2p/trade-repository'))
    ;({ escrowService } = require('../../src/modules/open-settlement/escrow.service'))
    ;({ liquidityRouter } = require('../../src/modules/open-liquidity/liquidity.service'))
    ;({ paymentAccountService } = require('../../src/modules/open-settlement/payment-account.service'))
    ;({ getSettlementProvider } = require('../../src/modules/open-settlement/escrow-providers'))
    ;({ SailsOpenP2PModule } = require('../../packages/sails-sdk/src/modules/openp2p'))
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
      await deleteFixtureAccounts(prisma, users)
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
    const displayName = `r7he3c-${label}`
    const regSig = Buffer.from(nacl.sign.detached(auth.registrationProofMessage(regChallenge, displayName), keypair.secretKey)).toString('hex')
    const user = await identityService.register({ publicKey, signature: regSig, displayName })
    ownedUserIds.push(user.id)
    const { challenge } = await auth.issueChallenge(publicKey)
    const sig = Buffer.from(nacl.sign.detached(Buffer.from(challenge), keypair.secretKey)).toString('hex')
    return { id: user.id, token: (await auth.verifySignedChallenge(publicKey, sig)).sessionToken }
  }

  const account = (ownerId: string, method = 'PIX') => paymentAccountService.getOrCreate(ownerId, `r7he3c-${randomBytes(10).toString('hex')}`, method)
  const offer = (userId: string, side: 'SELL' | 'BUY', extra: Record<string, unknown> = {}, asset = 'BTC') =>
    liquidityRouter.createOffer({ userId, asset, side, priceUsd: asset === 'BTC' ? '65000' : '1', minAmount: '0.0001', maxAmount: '1', paymentMethod: 'PIX', ...extra })
  const idem = () => randomBytes(16).toString('hex')

  const http = (who: Party, body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/v1/openp2p/trades', headers: { authorization: `Bearer ${who.token}` }, payload: body })
  /** The public SDK, its real transport, carried over the same Fastify routes. */
  function sdk(who: Party) {
    const fetchImpl = async (url: string, init: any) => {
      const u = new URL(url)
      const res = await app.inject({ method: init?.method ?? 'GET', url: u.pathname + u.search, headers: init?.headers, payload: init?.body })
      return new Response(res.body, { status: res.statusCode, headers: { 'content-type': 'application/json' } })
    }
    const transport = new SailsTransport({ baseUrl: 'http://sails.test', fetchImpl: fetchImpl as unknown as typeof fetch })
    transport.setSessionToken(who.token)
    return new SailsOpenP2PModule(transport)
  }

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

  /** Everything durable a trade admission could leave behind for this offer and these participants. */
  async function footprint(offerId: string, participantIds: string[]) {
    const [offerRow] = await prisma.$queryRaw<any[]>`SELECT * FROM offers WHERE id = ${offerId}`
    const [{ events }] = await prisma.$queryRaw<Array<{ events: bigint }>>`SELECT count(*) AS events FROM durable_events WHERE payload::text LIKE ${'%' + offerId + '%'}`
    return {
      trades: await prisma.trade.count({ where: { offerId } }),
      escrows: await prisma.escrow.count({ where: { trade: { offerId } } }),
      events: Number(events),
      reservations: await prisma.$queryRaw<any[]>`SELECT id FROM exposure_reservations WHERE "sellerId" = ANY(${participantIds})`,
      intent: offerRow.intentId ? (await prisma.intent.findUniqueOrThrow({ where: { id: offerRow.intentId } })).status : null,
      offer: offerRow,
      accounts: await prisma.paymentAccount.findMany({ where: { ownerId: { in: participantIds } }, orderBy: { id: 'asc' } }),
    }
  }

  /**
   * The attempt is refused with the admission code and changes nothing durable. Returns the error. The refused trade
   * row existed only inside the rolled-back transaction: its id (named in the error) has no row, escrow or event.
   */
  async function refusedWithoutEffects(offerId: string, participantIds: string[], attempt: () => Promise<any>, code: string) {
    const before = await footprint(offerId, participantIds)
    const providers = spyProviders()
    let outcome: any
    try { outcome = await attempt() } catch (err) { outcome = err } finally { providers.restore() }
    const status = outcome?.statusCode ?? outcome?.status
    const message: string = outcome?.message ?? (typeof outcome?.body === 'string' ? JSON.parse(outcome.body).message : '')
    expect([status, message.match(/economic authorization binding — ([A-Z_]+):/)?.[1]]).toEqual([409, code])
    if (outcome?.body) expect(JSON.parse(outcome.body).error).toBe('TRADE_ADMISSION_REFUSED')
    expect(providers.calls()).toBe(0)
    expect(await footprint(offerId, participantIds)).toEqual(before)
    const phantom = /trade ([0-9a-f-]{36})/.exec(message)?.[1]
    if (phantom) {
      expect(await prisma.trade.count({ where: { id: phantom } })).toBe(0)
      expect(await prisma.durableEventRecord.count({ where: { correlationId: phantom } })).toBe(0)
    }
    return outcome
  }

  /** Each production-reachable admission entrypoint, for one taker. */
  const viaHttp = (who: Party, body: Record<string, unknown>) => () => http(who, { idempotencyKey: idem(), ...body })
  const viaSdk = (who: Party, offerId: string, hash?: string) => () => sdk(who).trade(offerId, '0.0005', idem(), hash)
  const viaService = (who: Party, offerId: string, hash?: string) => () =>
    tradeService.createTrade({ offerId, counterpartyId: who.id, amount: '0.0005', idempotencyKey: idem(), ...(hash ? { paymentAccountHash: hash } : {}) })

  async function allEntrypointsRefused(offerId: string, taker: Party, others: string[], code: string, hash?: string) {
    const body = { offerId, amount: '0.0005', ...(hash ? { paymentAccountHash: hash } : {}) }
    await refusedWithoutEffects(offerId, [taker.id, ...others], viaHttp(taker, body), code)
    await refusedWithoutEffects(offerId, [taker.id, ...others], viaSdk(taker, offerId, hash), code)
    await refusedWithoutEffects(offerId, [taker.id, ...others], viaService(taker, offerId, hash), code)
  }

  const MULTISIG_ESCROW = (trade: { id: string; amount: unknown }) => ({ tradeId: trade.id, type: 'MULTISIG', asset: 'BTC', lockedAmount: String(trade.amount) })

  // ─── admission matrix ─────────────────────────────────────────────────────────────────────────────────

  it('SELL UNBOUND: a governed (BTC) SELL offer without its seller\'s account admits no trade — HTTP, SDK, service — and nothing durable remains', async () => {
    pg.requirePostgres('E3C-sell-unbound')
    const [seller, buyer] = [await participant('su-s'), await participant('su-b')]
    await account(seller.id) // the seller owns a PIX account — but the offer never declared it
    const o = await offer(seller.id, 'SELL')
    // The public offer view says so up front — a binding exists or not, never which account (no PIX control implied).
    const publicView = JSON.parse((await app.inject({ method: 'GET', url: `/v1/liquidity/offers/${o.id}` })).body).data
    expect([publicView.paymentAccountBound, JSON.stringify(publicView).includes('paymentAccountId')]).toEqual([false, false])
    await allEntrypointsRefused(o.id, buyer, [seller.id], 'UNBOUND_ACCOUNT')
    expect((await footprint(o.id, [seller.id])).intent).toBe('COORDINATED') // no Intent walk (MF-E3C-2)
  })

  it('SELL BOUND: the same shape with the seller\'s committed PIX account is admitted, bound, and its protected escrow is authorized', async () => {
    pg.requirePostgres('E3C-sell-bound')
    const [seller, buyer] = [await participant('sb-s'), await participant('sb-b')]
    const acct = await account(seller.id)
    const o = await offer(seller.id, 'SELL', { paymentAccountHash: acct.accountHash })
    const publicView = JSON.parse((await app.inject({ method: 'GET', url: `/v1/liquidity/offers/${o.id}` })).body).data
    expect([publicView.paymentAccountBound, JSON.stringify(publicView).includes(acct.id), JSON.stringify(publicView).includes(acct.accountHash)]).toEqual([true, false, false])
    const res = await viaHttp(buyer, { offerId: o.id, amount: '0.0005' })()
    expect(res.statusCode).toBe(201)
    const trade = JSON.parse(res.body).data
    expect([trade.sellerId, trade.sellerPaymentAccountId]).toEqual([seller.id, acct.id])
    // #235 R7H-NF-E3C-5 — RFC-018 Amendment A1 (CTO-approved retarget): the trade is NEGOTIATING through its OWN
    // Intent; the offer's Intent is the advertisement's and is never transitioned by a trade.
    expect((await prisma.intent.findUniqueOrThrow({ where: { id: trade.tradeIntentId } })).status).toBe('NEGOTIATING')
    expect((await prisma.intent.findUniqueOrThrow({ where: { id: o.intentId } })).status).toBe('COORDINATED')
    expect((await escrowService.createEscrow(MULTISIG_ESCROW(trade), seller.id)).type).toBe('MULTISIG')
  })

  it('BUY: the taker (the seller) is admitted only with their own eligible account — unbound, foreign and mismatched are refused', async () => {
    pg.requirePostgres('E3C-buy')
    const [maker, taker, stranger] = [await participant('b-maker'), await participant('b-taker'), await participant('b-stranger')]
    const o = await offer(maker.id, 'BUY')
    await allEntrypointsRefused(o.id, taker, [maker.id], 'UNBOUND_ACCOUNT')
    // Foreign / mismatched hashes are refused before the transaction by the binding check (403 / 400), with no trade.
    const foreign = await account(stranger.id)
    const ted = await account(taker.id, 'TED')
    expect((await viaHttp(taker, { offerId: o.id, amount: '0.0005', paymentAccountHash: foreign.accountHash })()).statusCode).toBe(403)
    expect((await viaHttp(taker, { offerId: o.id, amount: '0.0005', paymentAccountHash: ted.accountHash })()).statusCode).toBe(400)
    expect(await prisma.trade.count({ where: { offerId: o.id } })).toBe(0)
    // The taker's own PIX account: admitted, bound to the taker — never to the maker.
    const own = await account(taker.id)
    const trade = await viaService(taker, o.id, own.accountHash)()
    expect([trade.buyerId, trade.sellerId, trade.sellerPaymentAccountId]).toEqual([maker.id, taker.id, own.id])
    expect((await escrowService.createEscrow(MULTISIG_ESCROW(trade), taker.id)).type).toBe('MULTISIG')
  })

  it('INELIGIBLE METHOD: a consistently bound TED / BANK_TRANSFER / OTHER / CASH offer admits no trade (V1 makes only PIX eligible)', async () => {
    pg.requirePostgres('E3C-ineligible')
    for (const method of ['TED', 'BANK_TRANSFER', 'OTHER', 'CASH']) {
      const [seller, buyer] = [await participant(`ie-${method}-s`), await participant(`ie-${method}-b`)]
      const acct = await account(seller.id, method)
      const o = await offer(seller.id, 'SELL', { paymentMethod: method, paymentAccountHash: acct.accountHash })
      await allEntrypointsRefused(o.id, buyer, [seller.id], 'METHOD_NOT_ELIGIBLE')
    }
  })

  it('MOCK NEVER LEGITIMIZES: outside production a MOCK escrow is still creatable, yet an unbound BTC trade is not admitted for it', async () => {
    pg.requirePostgres('E3C-mock')
    const { config } = require('../../src/config')
    expect(config.isProduction).toBe(false)
    const [seller, buyer] = [await participant('m-s'), await participant('m-b')]
    const o = await offer(seller.id, 'SELL', { paymentMethod: 'OTHER' }) // the shape the pre-E3C settlement suites used
    await refusedWithoutEffects(o.id, [seller.id, buyer.id], viaService(buyer, o.id), 'UNBOUND_ACCOUNT')
    // The MOCK rail itself is untouched: a historical unbound BTC trade still gets a MOCK escrow outside production.
    const historical = await refusedThenHistoricalTrade(prisma, tradeService, viaService(buyer, o.id), 'UNBOUND_ACCOUNT', o, buyer.id, '0.0005')
    expect((await escrowService.createEscrow({ tradeId: historical.id, type: 'MOCK', asset: 'BTC', lockedAmount: '0.0005' }, seller.id)).type).toBe('MOCK')
  })

  it('UNGOVERNED CANONICAL ROUTES: USDT_ERC20 (WDK, ungoverned), LIQUID_BTC (no implementation) and LN_BTC (no translation) keep admitting unbound trades', async () => {
    pg.requirePostgres('E3C-ungoverned')
    for (const asset of ['USDT_ERC20', 'LIQUID_BTC', 'LN_BTC']) {
      const [seller, buyer] = [await participant(`u-${asset}-s`), await participant(`u-${asset}-b`)]
      const o = await offer(seller.id, 'SELL', { paymentMethod: 'OTHER' }, asset)
      const trade = await viaService(buyer, o.id)()
      expect([asset, trade.asset, trade.sellerPaymentAccountId]).toEqual([asset, asset, null])
    }
  })

  it('REPOSITORY BACKSTOP: a caller that skips the service\'s checks (foreign, mismatched, uncommitted seller) is refused inside the insert transaction', async () => {
    pg.requirePostgres('E3C-repo')
    const [seller, buyer, stranger] = [await participant('r-s'), await participant('r-b'), await participant('r-x')]
    const acct = await account(seller.id)
    const o = await offer(seller.id, 'SELL', { paymentAccountHash: acct.accountHash })
    const rail = { type: 'MULTISIG', asset: 'BTC' }
    const row = (over: Record<string, unknown>) => ({
      offerId: o.id, buyerId: buyer.id, sellerId: seller.id, asset: 'BTC', amount: '0.0005', priceUsd: '65000', totalUsd: '32.5',
      network: null, intentId: null, sellerPaymentAccountId: acct.id, escrowRail: rail, ...over,
    })
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ sellerPaymentAccountId: (await account(stranger.id)).id }, 'FOREIGN_ACCOUNT'],
      [{ sellerPaymentAccountId: (await account(seller.id, 'TED')).id }, 'METHOD_MISMATCH'],
      [{ sellerId: stranger.id, buyerId: buyer.id }, 'SELLER_NOT_COMMITTED'],
      [{ sellerPaymentAccountId: null }, 'UNBOUND_ACCOUNT'],
    ]
    for (const [over, code] of cases) {
      await refusedWithoutEffects(o.id, [seller.id, buyer.id, stranger.id], () => tradeRepository.create(row(over)), code)
    }
    expect((await tradeRepository.create(row({}))).sellerPaymentAccountId).toBe(acct.id)
  })

  it('FORGED IDENTITY: a body naming another counterparty / seller changes nothing — admission is decided for the session\'s caller', async () => {
    pg.requirePostgres('E3C-forged')
    const [seller, buyer, victim] = [await participant('f-s'), await participant('f-b'), await participant('f-v')]
    const o = await offer(seller.id, 'SELL') // unbound
    await refusedWithoutEffects(o.id, [seller.id, buyer.id, victim.id], viaHttp(buyer, { offerId: o.id, amount: '0.0005', counterpartyId: victim.id, sellerId: victim.id }), 'UNBOUND_ACCOUNT')
    // A SELL offer's buyer can never choose the account, whatever they claim.
    const own = await account(buyer.id)
    expect((await viaHttp(buyer, { offerId: o.id, amount: '0.0005', paymentAccountHash: own.accountHash })()).statusCode).toBe(400)
    expect(await prisma.trade.count({ where: { offerId: o.id } })).toBe(0)
  })

  // ─── concurrency, replay, idempotency ─────────────────────────────────────────────────────────────────

  it('CONCURRENCY: eight takers racing an unbound offer admit nothing; eight racing a bound offer are all admitted, each bound to the offer\'s account', async () => {
    pg.requirePostgres('E3C-race')
    const seller = await participant('c-s')
    const takers = await Promise.all(Array.from({ length: 8 }, (_, i) => participant(`c-t${i}`)))
    const unbound = await offer(seller.id, 'SELL')
    const refused = await Promise.allSettled(takers.map((t) => viaService(t, unbound.id)()))
    expect(refused.map((r) => r.status === 'rejected' && /UNBOUND_ACCOUNT/.test(String(r.reason?.message)))).toEqual(Array(8).fill(true))
    expect(await prisma.trade.count({ where: { offerId: unbound.id } })).toBe(0)
    const acct = await account(seller.id)
    const bound = await offer(seller.id, 'SELL', { paymentAccountHash: acct.accountHash })
    const outcomes = await Promise.allSettled(takers.map((t) => viaService(t, bound.id)()))
    const committed = await prisma.trade.findMany({ where: { offerId: bound.id } })
    expect(committed.length).toBe(8)
    expect(new Set(committed.map((t) => t.sellerPaymentAccountId))).toEqual(new Set([acct.id]))
    // Pre-existing, unchanged by E3C: every trade commits, but only one taker can walk the offer's single Intent in
    // postPersistTrade() — after the commit — and the others fail there ("already transitioned" or, depending on the
    // interleaving, "DISCOVERING → DISCOVERING"). The same race on an UNGOVERNED offer (plain insert, no admission
    // transaction) gives the same distribution, so it is not an artefact of the admission check.
    const shape = (rs: PromiseSettledResult<unknown>[]) =>
      rs.map((r) => {
        if (r.status === 'fulfilled') return 'ok'
        const reason = (r as PromiseRejectedResult).reason
        return /Intent/.test(String(reason?.message)) && /postPersistTrade/.test(String(reason?.stack)) ? 'intent-race' : 'other'
      }).sort()
    const usdt = await offer(seller.id, 'SELL', { paymentMethod: 'OTHER' }, 'USDT_ERC20')
    const baseline = await Promise.allSettled(takers.map((t) => viaService(t, usdt.id)()))
    expect(await prisma.trade.count({ where: { offerId: usdt.id } })).toBe(8)
    expect(shape(outcomes)).toEqual(shape(baseline))
    expect(shape(outcomes).filter((x) => x === 'other')).toEqual([])
  })

  it('IDEMPOTENCY: one key raced five times is one trade; a refused key stays refused and creates nothing; a key reused with another binding is refused', async () => {
    pg.requirePostgres('E3C-idem')
    const [maker, taker] = [await participant('i-maker'), await participant('i-taker')]
    const o = await offer(maker.id, 'BUY')
    const own = await account(taker.id)
    const key = idem()
    const take = () => tradeService.createTrade({ offerId: o.id, counterpartyId: taker.id, amount: '0.0005', idempotencyKey: key, paymentAccountHash: own.accountHash })
    const raced = await Promise.allSettled(Array.from({ length: 5 }, take))
    // In-flight duplicates are answered "already being processed" (idempotency.ts, by design); none creates a trade.
    for (const r of raced) if (r.status === 'rejected') expect(String(r.reason?.message)).toMatch(/already being processed/)
    expect(await prisma.trade.count({ where: { offerId: o.id } })).toBe(1)
    const [only] = await prisma.trade.findMany({ where: { offerId: o.id } })
    expect(new Set(raced.flatMap((r) => (r.status === 'fulfilled' ? [(r.value as any).id] : [])))).toEqual(new Set([only.id]))
    expect((await take()).id).toBe(only.id) // the settled key replays the same trade
    expect(only.sellerPaymentAccountId).toBe(own.id)
    // A different binding under the same key is a different request: refused, never silently rebound.
    const other = await account(taker.id)
    await expect(tradeService.createTrade({ offerId: o.id, counterpartyId: taker.id, amount: '0.0005', idempotencyKey: key, paymentAccountHash: other.accountHash }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/already used for a different request/) })
    // A refused admission's key: its retry is refused again, and — #235 R7H-NF-E3C-5 / D12 (CTO-approved: the claim now
    // commits WITH the trade or not at all) — the refusal leaves NO claim row of any kind, not even a FAILED one.
    const refusedKey = idem()
    for (let i = 0; i < 2; i++) {
      await refusedWithoutEffects(o.id, [maker.id, taker.id], () => tradeService.createTrade({ offerId: o.id, counterpartyId: taker.id, amount: '0.0005', idempotencyKey: refusedKey }), 'UNBOUND_ACCOUNT')
    }
    expect(await prisma.$queryRaw<any[]>`SELECT status FROM idempotency_keys WHERE key = ${refusedKey}`).toEqual([])
    expect(await prisma.trade.count({ where: { offerId: o.id } })).toBe(1)
  })

  it('OFFER RACE: a concurrent change to the offer\'s committed terms is either seen by the admission (refused) or refused itself once the trade exists', async () => {
    pg.requirePostgres('E3C-offer-race')
    const [seller, buyer] = [await participant('o-s'), await participant('o-b')]
    const acct = await account(seller.id)
    // (a) The writer holds the offer row first and switches its method: the admission waits on it, then sees the
    //     change and refuses — the trade it had built from the earlier read is rolled back.
    const o1 = await offer(seller.id, 'SELL', { paymentAccountHash: acct.accountHash })
    const writer = new Client({ connectionString: process.env.DATABASE_URL })
    await writer.connect()
    try {
      await writer.query('BEGIN')
      await writer.query('SELECT 1 FROM offers WHERE id = $1 FOR UPDATE', [o1.id])
      const admission = viaService(buyer, o1.id)().then(() => null, (e: any) => e)
      await new Promise((r) => setTimeout(r, 300))
      const [{ waiting }] = (await admin.query(`SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`)).rows
      expect(waiting).toBeGreaterThanOrEqual(1) // the admission is blocked on the offer row, not racing past it
      await writer.query(`UPDATE offers SET "paymentMethod" = 'TED' WHERE id = $1`, [o1.id])
      await writer.query('COMMIT')
      const err = await admission
      expect([err?.statusCode, /METHOD_MISMATCH/.test(err?.message)]).toEqual([409, true])
      expect(await prisma.trade.count({ where: { offerId: o1.id } })).toBe(0)
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined)
      await writer.end()
    }
    // (b) The admission commits first: the offer's terms are now committed and a direct write cannot change them.
    const o2 = await offer(seller.id, 'SELL', { paymentAccountHash: acct.accountHash })
    const trade = await viaService(buyer, o2.id)()
    await expect(admin.query(`UPDATE offers SET "paymentMethod" = 'TED' WHERE id = $1`, [o2.id])).rejects.toMatchObject({ message: expect.stringMatching(/committed economic terms/) })
    await expect(admin.query(`UPDATE offers SET "paymentAccountId" = NULL WHERE id = $1`, [o2.id])).rejects.toMatchObject({ message: expect.stringMatching(/committed economic terms/) })
    await expect(admin.query(`UPDATE trades SET "sellerPaymentAccountId" = NULL WHERE id = $1`, [trade.id])).rejects.toThrow()
    await expect(admin.query(`UPDATE payment_accounts SET "ownerId" = $1 WHERE id = $2`, [buyer.id, acct.id])).rejects.toMatchObject({ message: expect.stringMatching(/committed economic terms/) })
  })

  it('POLICY VERSION: admission is decided by the version in force at its statement — an uncommitted newer version is invisible to it, and the same check under that version refuses', async () => {
    pg.requirePostgres('E3C-policy')
    const [seller, buyer] = [await participant('p-s'), await participant('p-b')]
    const acct = await account(seller.id)
    const o = await offer(seller.id, 'SELL', { paymentAccountHash: acct.accountHash })
    const c = new Client({ connectionString: process.env.DATABASE_URL })
    await c.connect()
    try {
      await c.query('BEGIN')
      await c.query(`INSERT INTO trade_limit_policy_versions (id, version, label, "activatedAt", "openSettlementCapUsd", "rollingFiatCapUsd", "quoteMaxAgeSeconds", "quoteWindowSeconds", "quotePublicationMaxSeconds", "maxSourceDisagreementBps", "minAgreeingOperators", "sourceMaxAgeSeconds", "sourceFutureSkewSeconds")
                     VALUES ('r7he3c-v2', 2, 'test', now() AT TIME ZONE 'UTC', 250, 750, 120, 30, 10, 100, 2, 60, 15)`)
      await c.query(`INSERT INTO trade_limit_rail_policies VALUES ('r7he3c-v2', 'MULTISIG', 'BTC')`)
      await c.query(`INSERT INTO trade_limit_method_policies ("policyVersionId", "paymentMethod", eligible, "fiatWindowDays", "evidenceClass", confidence) VALUES ('r7he3c-v2', 'PIX', false, NULL, 'REGULATORY', 'MEDIUM')`)
      // The repository's exact admission statements, inside the transaction that sees v2: refused.
      const [{ id }] = (await c.query(`INSERT INTO trades (id, "offerId", "buyerId", "sellerId", asset, amount, "priceUsd", "totalUsd", "sellerPaymentAccountId", "updatedAt")
                     VALUES (gen_random_uuid(), $1, $2, $3, 'BTC', 0.0005, 65000, 32.5, $4, now()) RETURNING id`, [o.id, buyer.id, seller.id, acct.id])).rows
      const [{ violation }] = (await c.query(`SELECT escrow_economic_binding_violation($1, 'MULTISIG', 'BTC') AS violation`, [id])).rows
      expect(violation).toMatch(/^METHOD_NOT_ELIGIBLE:/)
      // Concurrently, the application's admission reads the committed V1 and admits (v2 is not yet in force for it).
      const trade = await viaService(buyer, o.id)()
      expect(trade.sellerPaymentAccountId).toBe(acct.id)
    } finally {
      await c.query('ROLLBACK').catch(() => undefined)
      await c.end()
    }
  })

  // ─── historical trades ────────────────────────────────────────────────────────────────────────────────

  it('HISTORICAL: an unbound trade from before E3C keeps its lifecycle — its protected escrow stays refused, and it can still be cancelled', async () => {
    pg.requirePostgres('E3C-historical')
    const [seller, buyer] = [await participant('h-s'), await participant('h-b')]
    const o = await offer(seller.id, 'SELL')
    const historical = await refusedThenHistoricalTrade(prisma, tradeService, viaService(buyer, o.id), 'UNBOUND_ACCOUNT', o, buyer.id, '0.0005')
    await expect(escrowService.createEscrow(MULTISIG_ESCROW(historical), seller.id)).rejects.toMatchObject({ message: expect.stringMatching(/UNBOUND_ACCOUNT/) })
    expect(await prisma.escrow.count({ where: { tradeId: historical.id } })).toBe(0)
    expect((await prisma.trade.findUniqueOrThrow({ where: { id: historical.id } })).sellerPaymentAccountId).toBeNull() // never back-filled
    const cancelled = await tradeService.updateStatus(historical.id, 'CANCELLED', buyer.id)
    expect(cancelled.status).toBe('CANCELLED')
  })
})
