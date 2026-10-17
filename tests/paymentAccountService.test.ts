/**
 * PaymentAccountService — RFC-021 D5
 * (docs/rfcs/RFC-021-market-based-arbitration-and-payment-trust.md).
 *
 * Real math for the trade-limit ramp, real SHA-256 hashing (not mocked
 * — this is the one property that must actually be correct, since
 * @satsails/p2p-trading-sdk's hashPaymentAccount() must produce byte-identical output
 * for the client/server privacy scheme to work at all), mocked Prisma
 * for persistence.
 */
export {} // same forced-module reasoning used throughout this suite

const mockPaymentAccountFindUnique = jest.fn()
const mockPaymentAccountCreate = jest.fn()
const mockPaymentAccountUpdate = jest.fn()
const mockPaymentAccountCount = jest.fn().mockResolvedValue(0)
const mockPaymentAccountUpdateMany = jest.fn()
const mockVouchFindFirst = jest.fn().mockResolvedValue(null)
const mockTradeFindUnique = jest.fn()
const mockDisputeCount = jest.fn().mockResolvedValue(0)
const mockEmit = jest.fn().mockResolvedValue(undefined)

jest.mock('../src/common/database', () => ({
  prisma: {
    paymentAccount: {
      findUnique: (...args: unknown[]) => mockPaymentAccountFindUnique(...args),
      create: (...args: unknown[]) => mockPaymentAccountCreate(...args),
      update: (...args: unknown[]) => mockPaymentAccountUpdate(...args),
      updateMany: (...args: unknown[]) => mockPaymentAccountUpdateMany(...args),
      count: (...args: unknown[]) => mockPaymentAccountCount(...args),
    },
    vouch: {
      findFirst: (...args: unknown[]) => mockVouchFindFirst(...args),
    },
    trade: { findUnique: (...args: unknown[]) => mockTradeFindUnique(...args) },
    dispute: { count: (...args: unknown[]) => mockDisputeCount(...args) },
  },
}))
jest.mock('../src/common/events/event-bus', () => ({ eventBus: { emit: (...args: unknown[]) => mockEmit(...args) } }))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  PaymentAccountService,
  UNSIGNED_TRADE_LIMIT, SIGNED_TRADE_LIMIT, ESTABLISHED_TRADE_LIMIT,
  ESTABLISHED_TRADE_COUNT, TRUSTED_TRADE_COUNT,
} = require('../src/modules/open-settlement/payment-account.service')

describe('PaymentAccountService — hashAccountIdentifier() (RFC-021 D5, real SHA-256)', () => {
  it('is deterministic — same inputs, same hash, every time', () => {
    const service = new PaymentAccountService()
    const h1 = service.hashAccountIdentifier('PIX', 'alan@example.com')
    const h2 = service.hashAccountIdentifier('PIX', 'alan@example.com')
    expect(h1).toBe(h2)
    expect(h1).toMatch(/^[0-9a-f]{64}$/) // real 32-byte SHA-256 digest, hex
  })

  it('different raw identifiers produce different hashes — no collisions on realistic input', () => {
    const service = new PaymentAccountService()
    const h1 = service.hashAccountIdentifier('PIX', 'alan@example.com')
    const h2 = service.hashAccountIdentifier('PIX', 'yuri@example.com')
    expect(h1).not.toBe(h2)
  })

  it('the same raw identifier under a different payment method hashes differently — method is part of the hashed input', () => {
    const service = new PaymentAccountService()
    const h1 = service.hashAccountIdentifier('PIX', '12345678900')
    const h2 = service.hashAccountIdentifier('TED', '12345678900')
    expect(h1).not.toBe(h2)
  })

  // Cross-check against a value computed independently (Node's own
  // crypto.createHash, not this service's own code) — proves the
  // format string (`${paymentMethod}:${rawIdentifier}`) really is what
  // gets hashed, not something this test would miss if the service's
  // own implementation and this test both drifted the same way.
  it('matches an independently-computed SHA-256 of "PIX:test-key"', () => {
    const { createHash } = require('node:crypto')
    const expected = createHash('sha256').update('PIX:test-key').digest('hex')
    const service = new PaymentAccountService()
    expect(service.hashAccountIdentifier('PIX', 'test-key')).toBe(expected)
  })
})

describe('PaymentAccountService — getOrCreate() (RFC-021 D5)', () => {
  beforeEach(() => jest.clearAllMocks())

  it('creates a new PaymentAccount for a never-seen hash', async () => {
    mockPaymentAccountFindUnique.mockResolvedValue(null)
    mockPaymentAccountCreate.mockResolvedValue({ accountHash: 'hash-1', ownerId: 'user-1', paymentMethod: 'PIX', signed: false })

    const service = new PaymentAccountService()
    const result = await service.getOrCreate('user-1', 'hash-1', 'PIX')

    expect(mockPaymentAccountCreate).toHaveBeenCalledWith({
      data: { ownerId: 'user-1', accountHash: 'hash-1', paymentMethod: 'PIX' },
    })
    expect(result.accountHash).toBe('hash-1')
  })

  it('is idempotent — returns the existing row for an already-known hash, does not create a duplicate', async () => {
    mockPaymentAccountFindUnique.mockResolvedValue({ accountHash: 'hash-1', ownerId: 'user-1', paymentMethod: 'PIX', signed: true })

    const service = new PaymentAccountService()
    const result = await service.getOrCreate('user-1', 'hash-1', 'PIX')

    expect(mockPaymentAccountCreate).not.toHaveBeenCalled()
    expect(result.signed).toBe(true)
  })
})

describe('PaymentAccountService — getOrCreate() vouch-based pre-signing (RFC-021 D7)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockPaymentAccountCount.mockResolvedValue(0)
    mockVouchFindFirst.mockResolvedValue(null)
  })

  it('creates a brand-new owner\'s first account already signed, when an active vouch exists', async () => {
    mockPaymentAccountFindUnique.mockResolvedValue(null)
    mockPaymentAccountCount.mockResolvedValue(0) // genuinely the owner's first account
    mockVouchFindFirst.mockResolvedValue({ id: 'vouch-1', voucherId: 'voucher-1', voucheeId: 'user-1', burnedAt: null })
    mockPaymentAccountCreate.mockResolvedValue({ accountHash: 'hash-1', signed: true, signedBy: 'voucher-1' })

    const service = new PaymentAccountService()
    const result = await service.getOrCreate('user-1', 'hash-1', 'PIX')

    expect(mockVouchFindFirst).toHaveBeenCalledWith({ where: { voucheeId: 'user-1', burnedAt: null } })
    expect(mockPaymentAccountCreate).toHaveBeenCalledWith({
      data: { ownerId: 'user-1', accountHash: 'hash-1', paymentMethod: 'PIX', signed: true, signedBy: 'voucher-1', signedAt: expect.any(Date), attestationSource: 'VOUCHER' },
    })
    expect(result.signed).toBe(true)
  })

  it('does NOT check for a vouch, or pre-sign, when the owner already has an existing account — only the genuine first one qualifies', async () => {
    mockPaymentAccountFindUnique.mockResolvedValue(null)
    mockPaymentAccountCount.mockResolvedValue(1) // owner already has at least one account
    mockPaymentAccountCreate.mockResolvedValue({ accountHash: 'hash-2', signed: false })

    const service = new PaymentAccountService()
    await service.getOrCreate('user-1', 'hash-2', 'TED')

    expect(mockVouchFindFirst).not.toHaveBeenCalled()
    expect(mockPaymentAccountCreate).toHaveBeenCalledWith({
      data: { ownerId: 'user-1', accountHash: 'hash-2', paymentMethod: 'TED' },
    })
  })

  it('creates an unsigned account normally when no active vouch exists, even for a genuine first account', async () => {
    mockPaymentAccountFindUnique.mockResolvedValue(null)
    mockPaymentAccountCount.mockResolvedValue(0)
    mockVouchFindFirst.mockResolvedValue(null)
    mockPaymentAccountCreate.mockResolvedValue({ accountHash: 'hash-1', signed: false })

    const service = new PaymentAccountService()
    const result = await service.getOrCreate('user-1', 'hash-1', 'PIX')

    expect(mockPaymentAccountCreate).toHaveBeenCalledWith({
      data: { ownerId: 'user-1', accountHash: 'hash-1', paymentMethod: 'PIX' },
    })
    expect(result.signed).toBe(false)
  })

  it('ignores a burned vouch — burnedAt: null is required, matching the query itself', async () => {
    // The query filters burnedAt: null server-side; this test documents
    // that a burned vouch (mocked as "not found" by the same filter) is
    // correctly treated as no vouch at all, not a stale/expired one.
    mockPaymentAccountFindUnique.mockResolvedValue(null)
    mockPaymentAccountCount.mockResolvedValue(0)
    mockVouchFindFirst.mockResolvedValue(null) // a burned vouch never matches burnedAt: null
    mockPaymentAccountCreate.mockResolvedValue({ accountHash: 'hash-1', signed: false })

    const service = new PaymentAccountService()
    const result = await service.getOrCreate('user-1', 'hash-1', 'PIX')

    expect(result.signed).toBe(false)
  })
})

// #235 R7C — the authority branches, against mocked persistence. The real-PostgreSQL proof (binding,
// races, restart, second node, DB guards) is tests/integration/paymentAccountBindingAuthority.test.ts.
describe('PaymentAccountService — attestFromTrade() (#235 R7C peer attestation authority)', () => {
  const CLEAN_TRADE = { id: 'trade-1', buyerId: 'buyer-1', sellerId: 'seller-1', status: 'COMPLETED', sellerPaymentAccountId: 'acct-1', escrow: { status: 'COMPLETED' } }
  const BOUND_ACCOUNT = { id: 'acct-1', accountHash: 'hash-1', ownerId: 'seller-1', paymentMethod: 'PIX', signed: false }

  beforeEach(() => {
    jest.clearAllMocks()
    mockTradeFindUnique.mockResolvedValue(CLEAN_TRADE)
    mockDisputeCount.mockResolvedValue(0)
    mockPaymentAccountFindUnique.mockResolvedValue(BOUND_ACCOUNT)
    mockPaymentAccountUpdateMany.mockResolvedValue({ count: 1 })
  })

  it('the buyer of a clean COMPLETED trade attests its bound account: one conditional write (signed = false), PEER provenance, one event', async () => {
    await new PaymentAccountService().attestFromTrade('trade-1', 'hash-1', 'buyer-1')

    expect(mockPaymentAccountUpdateMany).toHaveBeenCalledWith({
      where: { id: 'acct-1', signed: false },
      data: { signed: true, signedBy: 'buyer-1', signedAt: expect.any(Date), attestationSource: 'PEER', attestedTradeId: 'trade-1' },
    })
    expect(mockEmit).toHaveBeenCalledWith('settlement.payment_account.attested',
      { accountHash: 'hash-1', tradeId: 'trade-1', attesterId: 'buyer-1', attestationSource: 'PEER' }, 'trade-1')
  })

  it('an already-signed account is a no-op for an authorized buyer: no event, nothing overwritten', async () => {
    mockPaymentAccountUpdateMany.mockResolvedValue({ count: 0 })
    await new PaymentAccountService().attestFromTrade('trade-1', 'hash-1', 'buyer-1')
    expect(mockEmit).not.toHaveBeenCalled()
  })

  it.each([
    ['the seller (owner)', 'seller-1'],
    ['an unrelated participant', 'stranger-1'],
  ])('%s is refused (403) before anything is written', async (_label, caller) => {
    await expect(new PaymentAccountService().attestFromTrade('trade-1', 'hash-1', caller)).rejects.toMatchObject({ statusCode: 403 })
    expect(mockPaymentAccountUpdateMany).not.toHaveBeenCalled()
  })

  it.each([
    ['an unbound trade', { ...CLEAN_TRADE, sellerPaymentAccountId: null }, 0],
    ['an incomplete trade', { ...CLEAN_TRADE, status: 'ACTIVE', escrow: { status: 'FUNDS_LOCKED' } }, 0],
    ['a SPLIT (Trade COMPLETED, escrow SPLIT)', { ...CLEAN_TRADE, escrow: { status: 'SPLIT' } }, 1],
    ['a released trade that was disputed', CLEAN_TRADE, 1],
    ['a COMPLETED trade with no escrow', { ...CLEAN_TRADE, escrow: null }, 0],
  ])('%s cannot attest (400), nothing written', async (_label, trade, disputes) => {
    mockTradeFindUnique.mockResolvedValue(trade)
    mockDisputeCount.mockResolvedValue(disputes)
    await expect(new PaymentAccountService().attestFromTrade('trade-1', 'hash-1', 'buyer-1')).rejects.toMatchObject({ statusCode: 400 })
    expect(mockPaymentAccountUpdateMany).not.toHaveBeenCalled()
  })

  it("a hash other than the trade's bound account is refused — the caller cannot pick the account", async () => {
    await expect(new PaymentAccountService().attestFromTrade('trade-1', 'hash-OTHER', 'buyer-1')).rejects.toMatchObject({ statusCode: 400 })
    expect(mockPaymentAccountUpdateMany).not.toHaveBeenCalled()
  })

  it('an unknown trade is 404', async () => {
    mockTradeFindUnique.mockResolvedValue(null)
    await expect(new PaymentAccountService().attestFromTrade('nope', 'hash-1', 'buyer-1')).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('PaymentAccountService — bindableAccountId() (#235 R7C binding check)', () => {
  beforeEach(() => jest.clearAllMocks())

  it("returns the id of the seller's own account on the offer's payment method", async () => {
    mockPaymentAccountFindUnique.mockResolvedValue({ id: 'acct-1', ownerId: 'seller-1', paymentMethod: 'PIX' })
    expect(await new PaymentAccountService().bindableAccountId({ accountHash: 'hash-1' }, 'seller-1', 'PIX')).toBe('acct-1')
  })

  it.each([
    ["someone else's account", { id: 'acct-1', ownerId: 'other', paymentMethod: 'PIX' }, 403],
    ['a different payment method', { id: 'acct-1', ownerId: 'seller-1', paymentMethod: 'TED' }, 400],
    ['an unknown account', null, 404],
  ])('refuses %s', async (_label, row, status) => {
    mockPaymentAccountFindUnique.mockResolvedValue(row)
    await expect(new PaymentAccountService().bindableAccountId({ accountHash: 'hash-1' }, 'seller-1', 'PIX')).rejects.toMatchObject({ statusCode: status })
  })
})

describe('PaymentAccountService — getTradeLimit() (RFC-021 D5, the real ramp)', () => {
  beforeEach(() => jest.clearAllMocks())

  it('an unsigned account gets the floor limit, regardless of anything else', async () => {
    mockPaymentAccountFindUnique.mockResolvedValue({ signed: false, completedTrades: 999, chargebacks: 0 })
    const service = new PaymentAccountService()
    expect(await service.getTradeLimit('hash-1')).toBe(UNSIGNED_TRADE_LIMIT)
  })

  it('a freshly-signed account with few trades gets SIGNED_TRADE_LIMIT', async () => {
    mockPaymentAccountFindUnique.mockResolvedValue({ signed: true, completedTrades: 1, chargebacks: 0 })
    const service = new PaymentAccountService()
    expect(await service.getTradeLimit('hash-1')).toBe(SIGNED_TRADE_LIMIT)
  })

  it(`clears to ESTABLISHED_TRADE_LIMIT at exactly ${ESTABLISHED_TRADE_COUNT} completed trades`, async () => {
    mockPaymentAccountFindUnique.mockResolvedValue({ signed: true, completedTrades: ESTABLISHED_TRADE_COUNT, chargebacks: 0 })
    const service = new PaymentAccountService()
    expect(await service.getTradeLimit('hash-1')).toBe(ESTABLISHED_TRADE_LIMIT)
  })

  it(`clears to unlimited at exactly ${TRUSTED_TRADE_COUNT} completed trades with zero chargebacks`, async () => {
    mockPaymentAccountFindUnique.mockResolvedValue({ signed: true, completedTrades: TRUSTED_TRADE_COUNT, chargebacks: 0 })
    const service = new PaymentAccountService()
    expect(await service.getTradeLimit('hash-1')).toBe('unlimited')
  })

  it('a single real chargeback permanently caps the account at SIGNED_TRADE_LIMIT, even with many completed trades — RFC-021 D5\'s own stated rule', async () => {
    mockPaymentAccountFindUnique.mockResolvedValue({ signed: true, completedTrades: 50, chargebacks: 1 })
    const service = new PaymentAccountService()
    expect(await service.getTradeLimit('hash-1')).toBe(SIGNED_TRADE_LIMIT)
  })
})

// Missão 11 Fase 9.3.1 — CTO-mandated privacy/verifiability boundary
// review of GET /v1/settlement/payment-accounts/:accountHash. This
// endpoint stays deliberately public (no requireAuth — matches RFC-021
// D5's own age-witness design and the SDK's documented "no session
// required" contract), but the ROW previously returned verbatim
// (`{ ...account, tradeLimit }`) included `ownerId`/`signedBy` (platform
// User ids) and internal bookkeeping (`id`/`moduleId`/`protocolVersion`/
// `updatedAt`) — none of which RFC-021 D5's stated purpose ("verify a
// payment account has been used before... without revealing the
// account's real details") ever required. getPublicView() is now the
// ONLY method the public route may call; these tests prove its exact
// field boundary directly against the service, independent of HTTP
// wiring (tests/routes.test.ts covers the wire-level proof).
describe('PaymentAccountService — getPublicView() (Missão 11 Fase 9.3.1 privacy boundary)', () => {
  beforeEach(() => jest.clearAllMocks())

  const fullRow = {
    id: 'internal-row-id-should-never-leak',
    ownerId: 'user-owner-should-never-leak',
    accountHash: 'hash-1',
    paymentMethod: 'PIX',
    signed: true,
    signedBy: 'user-signer-should-never-leak',
    signedAt: new Date('2026-01-01T00:00:00.000Z'),
    firstUsedAt: new Date('2025-06-01T00:00:00.000Z'),
    completedTrades: 7,
    chargebacks: 0,
    moduleId: 'opensettlement',
    protocolVersion: '0.1',
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  }

  it('never includes ownerId — the platform identity of the account owner does not leak through the public verification surface', async () => {
    mockPaymentAccountFindUnique.mockResolvedValue(fullRow)
    const service = new PaymentAccountService()
    const view = await service.getPublicView('hash-1')
    expect(view).not.toHaveProperty('ownerId')
    expect(JSON.stringify(view)).not.toContain('user-owner-should-never-leak')
  })

  it('never includes signedBy — the platform identity of whoever attested the account does not leak', async () => {
    mockPaymentAccountFindUnique.mockResolvedValue(fullRow)
    const service = new PaymentAccountService()
    const view = await service.getPublicView('hash-1')
    expect(view).not.toHaveProperty('signedBy')
    expect(JSON.stringify(view)).not.toContain('user-signer-should-never-leak')
  })

  it('never includes the internal row id or operator-internal bookkeeping (moduleId/protocolVersion/updatedAt)', async () => {
    mockPaymentAccountFindUnique.mockResolvedValue(fullRow)
    const service = new PaymentAccountService()
    const view = await service.getPublicView('hash-1')
    expect(view).not.toHaveProperty('id')
    expect(view).not.toHaveProperty('moduleId')
    expect(view).not.toHaveProperty('protocolVersion')
    expect(view).not.toHaveProperty('updatedAt')
    expect(JSON.stringify(view)).not.toContain('internal-row-id-should-never-leak')
  })

  it('every field required for real counterparty verification remains present and correct', async () => {
    mockPaymentAccountFindUnique.mockResolvedValue(fullRow)
    const service = new PaymentAccountService()
    const view = await service.getPublicView('hash-1')
    expect(view).toEqual({
      accountHash: 'hash-1',
      paymentMethod: 'PIX',
      signed: true,
      signedAt: fullRow.signedAt,
      firstUsedAt: fullRow.firstUsedAt,
      completedTrades: 7,
      chargebacks: 0,
      tradeLimit: ESTABLISHED_TRADE_LIMIT, // completedTrades=7 >= ESTABLISHED_TRADE_COUNT(5), < TRUSTED_TRADE_COUNT(20)
    })
  })

  it('the exact same projection shape is returned regardless of how much history the caller already knows — no hidden extra fields unlocked by "being in the know"', async () => {
    mockPaymentAccountFindUnique.mockResolvedValue(fullRow)
    const service = new PaymentAccountService()
    const viewA = await service.getPublicView('hash-1')
    const viewB = await service.getPublicView('hash-1') // a second, independent caller
    expect(viewA).toEqual(viewB)
    expect(Object.keys(viewA).sort()).toEqual([
      'accountHash', 'chargebacks', 'completedTrades', 'firstUsedAt', 'paymentMethod', 'signed', 'signedAt', 'tradeLimit',
    ])
  })

  it('an unknown accountHash throws NotFoundError — existence is disclosed by design (that IS the age-witness verification), but nothing beyond exists/does-not-exist leaks', async () => {
    mockPaymentAccountFindUnique.mockResolvedValue(null)
    const service = new PaymentAccountService()
    await expect(service.getPublicView('never-registered-hash')).rejects.toThrow('PaymentAccount')
  })

  it('the computed tradeLimit matches getTradeLimit() exactly — one shared ramp implementation, not a second one that could silently drift', async () => {
    mockPaymentAccountFindUnique.mockResolvedValue(fullRow)
    const service = new PaymentAccountService()
    const [view, limit] = await Promise.all([service.getPublicView('hash-1'), service.getTradeLimit('hash-1')])
    expect(view.tradeLimit).toBe(limit)
  })

  // Missão 11 Fase 9.6 — toPublicView() is getPublicView()'s pure
  // projection half, split out so settlement.routes.ts's POST routes
  // (create, sign) can apply the identical privacy boundary to a row
  // they already have in hand, without a redundant fetch. Same field
  // contract as getPublicView() itself — proven here directly, once,
  // rather than duplicated per call site.
  it('toPublicView() applied directly to a row produces the exact same projection getPublicView() computes from a fetch', () => {
    const service = new PaymentAccountService()
    const view = service.toPublicView(fullRow)
    expect(view).not.toHaveProperty('ownerId')
    expect(view).not.toHaveProperty('signedBy')
    expect(view).not.toHaveProperty('id')
    expect(view).not.toHaveProperty('moduleId')
    expect(view).not.toHaveProperty('protocolVersion')
    expect(view).not.toHaveProperty('updatedAt')
    expect(Object.keys(view).sort()).toEqual([
      'accountHash', 'chargebacks', 'completedTrades', 'firstUsedAt', 'paymentMethod', 'signed', 'signedAt', 'tradeLimit',
    ])
    expect(view.tradeLimit).toBe(ESTABLISHED_TRADE_LIMIT)
  })
})
