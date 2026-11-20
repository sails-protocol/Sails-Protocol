/**
 * E21 R1 (CTO 28 Despacho 029) on real PostgreSQL: trades."acceptedEnvelopeId" names the exact offer_envelopes
 * revision a trade accepted. Database guard: migration 20261121120000 (trades_accepted_envelope_guard).
 * Envelope rows are inserted directly: the guard checks ownership, resolution, liveness and terms, not signatures
 * (those are verified on ingest by offerEnvelopeRepository; offer_envelopes is append-only).
 */
import { randomBytes, randomUUID } from 'crypto'
import { createPostgresIntegrationHarness } from './postgresTestHarness'

describe('E21 R1 - a trade binds the exact offer-envelope revision it accepted (real PostgreSQL)', () => {
  jest.setTimeout(180_000)
  const pg = createPostgresIntegrationHarness()
  let prisma: any, tradeService: any, intentEngine: any
  let seller: any, buyer: any, stranger: any, offer: any

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'true'
    await pg.probe()
    if (!pg.isAvailable()) return
    ;({ prisma } = require('../../src/common/database'))
    ;({ tradeService } = require('../../src/modules/open-p2p/trade.service'))
    ;({ intentEngine } = require('../../src/core/intent-engine'))
    intentEngine.registerHandler(require('../../src/modules/open-p2p/intent-handler').OpenP2PTradeIntentHandler)
    const user = () => prisma.user.create({ data: { publicKey: randomBytes(32).toString('hex') } })
    seller = await user(); buyer = await user(); stranger = await user()
    offer = await prisma.offer.create({ data: { userId: seller.id, asset: 'BTC', side: 'SELL', priceUsd: '65000', minAmount: '0.001', maxAmount: '0.01', paymentMethod: 'PIX' } })
  })
  afterAll(async () => { if (prisma) await prisma.$disconnect() })

  const hex64 = () => randomBytes(32).toString('hex')
  /** One offer_envelopes row; defaults are the seller's live revision matching `offer`. */
  async function envelope(o: Record<string, unknown> = {}) {
    const now = Date.now()
    return prisma.offerEnvelope.create({
      data: {
        logicalOfferId: `r1-${randomUUID()}`, ownerPublicKey: seller.publicKey, asset: 'BTC', side: 'SELL', priceUsd: '65000',
        minAmount: '0.001', maxAmount: '0.01', paymentMethod: 'PIX', revision: 1,
        createdAt: new Date(now - 60_000), revisedAt: new Date(now - 30_000), expiresAt: new Date(now + 86_400_000),
        status: 'ACTIVE', signature: randomBytes(64).toString('hex'), contentDigest: hex64(), ...o,
      },
    })
  }
  /** A trade row as the admission writes it, straight at the database (the guard is the structural guarantee). */
  const rawTrade = (acceptedEnvelopeId: string | null, o: Record<string, unknown> = {}) =>
    prisma.trade.create({ data: { offerId: offer.id, buyerId: buyer.id, sellerId: seller.id, asset: 'BTC', amount: '0.005', priceUsd: '65000', totalUsd: '325', acceptedEnvelopeId, ...o } })
  const refused = (p: Promise<unknown>) => expect(p).rejects.toThrow(/acceptedEnvelopeId must be a resolved, active revision/)

  it('the admission writes the accepted revision in its transaction; omitting it keeps the legacy NULL', async () => {
    pg.requirePostgres('R1 admission')
    const e = await envelope()
    const t = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.005', acceptedEnvelopeId: e.id })
    expect((await prisma.trade.findUnique({ where: { id: t.id } })).acceptedEnvelopeId).toBe(e.id)
    const key = randomUUID()
    const legacy = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.005', idempotencyKey: key })
    expect((await prisma.trade.findUnique({ where: { id: legacy.id } })).acceptedEnvelopeId).toBeNull()
    // Callers that omit the field keep the exact request hash they had before R1 (idempotent replays unchanged).
    const { hashIdempotentPayload } = require('../../src/common/idempotency')
    const claim = await prisma.idempotencyKey.findFirst({ where: { key, participantId: buyer.id } })
    expect(claim.requestHash).toBe(hashIdempotentPayload({ offerId: offer.id, amount: '0.005' }))
  })

  it('a refused revision fails the whole admission: no trade, no Intent, a ValidationError (never a raw database error)', async () => {
    pg.requirePostgres('R1 admission refused')
    const before = { trades: await prisma.trade.count(), intents: await prisma.intent.count() }
    const other = await envelope({ ownerPublicKey: stranger.publicKey })
    for (const acceptedEnvelopeId of [other.id, randomUUID()]) {
      await expect(tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: '0.005', acceptedEnvelopeId }))
        .rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    }
    expect({ trades: await prisma.trade.count(), intents: await prisma.intent.count() }).toEqual(before)
  })

  it('write-once: the accepted revision never changes, is never cleared, and a legacy trade never adopts one', async () => {
    pg.requirePostgres('R1 write-once')
    const a = await envelope(), b = await envelope()
    const t = await rawTrade(a.id), legacy = await rawTrade(null)
    const fixed = /acceptedEnvelopeId is fixed at creation/
    await expect(prisma.trade.update({ where: { id: t.id }, data: { acceptedEnvelopeId: b.id } })).rejects.toThrow(fixed)
    await expect(prisma.trade.update({ where: { id: t.id }, data: { acceptedEnvelopeId: null } })).rejects.toThrow(fixed)
    await expect(prisma.trade.update({ where: { id: legacy.id }, data: { acceptedEnvelopeId: a.id } })).rejects.toThrow(fixed)
    await expect(prisma.trade.update({ where: { id: t.id }, data: { status: 'ACTIVE' } })).resolves.toMatchObject({ acceptedEnvelopeId: a.id })
  })

  it('the revision must be the Offer owner’s: another owner’s envelope is refused', async () => {
    pg.requirePostgres('R1 owner')
    await refused(rawTrade((await envelope({ ownerPublicKey: stranger.publicKey })).id))
  })

  it('the revision must be RESOLVED: an equivocated revision (same revision, another digest) and a superseded one are refused', async () => {
    pg.requirePostgres('R1 resolved')
    const eq = await envelope()
    await envelope({ logicalOfferId: eq.logicalOfferId, revision: 1 }) // the owner equivocated at revision 1
    await refused(rawTrade(eq.id))
    const old = await envelope()
    await envelope({ logicalOfferId: old.logicalOfferId, revision: 2 }) // a later revision exists
    await refused(rawTrade(old.id))
  })

  it('the revision must be live on the DATABASE clock: a CANCELLED envelope, or one expired by a millisecond, is refused', async () => {
    pg.requirePostgres('R1 live')
    await refused(rawTrade((await envelope({ status: 'CANCELLED' })).id))
    const [{ now }] = await prisma.$queryRaw`SELECT clock_timestamp() AS now`
    await refused(rawTrade((await envelope({ expiresAt: new Date(now.getTime() - 1) })).id))
    await expect(rawTrade((await envelope({ expiresAt: new Date(now.getTime() + 60_000) })).id)).resolves.toBeTruthy()
  })

  it('amount limits are INCLUSIVE, as in the E21 admission, and compared as numeric: = min and = max accepted, 1e-8 outside refused', async () => {
    pg.requirePostgres('R1 bounds')
    await expect(rawTrade((await envelope()).id, { amount: '0.001' })).resolves.toBeTruthy()
    await expect(rawTrade((await envelope()).id, { amount: '0.01' })).resolves.toBeTruthy()
    await refused(rawTrade((await envelope()).id, { amount: '0.00099999' }))
    await refused(rawTrade((await envelope()).id, { amount: '0.01000001' }))
  })

  it('the revision must carry the trade terms: asset, side, priceUsd (numeric), paymentMethod and an amount within its limits', async () => {
    pg.requirePostgres('R1 terms')
    await refused(rawTrade((await envelope({ asset: 'LIQUID_BTC' })).id))
    await refused(rawTrade((await envelope({ side: 'BUY' })).id))
    await refused(rawTrade((await envelope({ priceUsd: '65000.00000001' })).id))
    await refused(rawTrade((await envelope({ paymentMethod: 'TED' })).id))
    await refused(rawTrade((await envelope({ maxAmount: '0.004' })).id))
    await expect(rawTrade((await envelope({ priceUsd: '65000.00000000' })).id)).resolves.toBeTruthy() // control: same value as numeric
  })
})
