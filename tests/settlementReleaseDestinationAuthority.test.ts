/**
 * Sails Core Implementation Program M8-R2 (Destination Authority
 * Conformance, cooperative path, 2026-09-11) — proves the ROUTE-LEVEL
 * half of the F1 fix directly: POST /v1/settlement/escrow/:id/release
 * and /initiate-release must never forward a caller-supplied `toAddress`
 * to escrow.service.ts, regardless of what the request body contains.
 * Before this mission, the seller (who triggers these routes — see
 * EscrowActions.tsx's own gating) could supply ANY address as the
 * buyer's payout destination and it would unconditionally win
 * (escrow-lifecycle.ts's `resolvePayoutAddress()` "explicit wins" rule).
 * That rule itself is UNCHANGED here (see tests/payoutAddress.test.ts —
 * still a legitimate trusted-internal-caller contract, still exercised
 * verbatim by dispute.service.ts's own authorized-snapshot callers) —
 * what changed is that these two ROUTES now always pass `undefined`,
 * so a cooperative release can only ever resolve the beneficiary's own
 * registered PayoutAddress.
 *
 * Isolated at the route-file level (not the full app) — escrow.service.ts
 * itself is mocked away entirely, since what this file needs to prove is
 * a fact about settlement.routes.ts's own request-to-call-argument
 * translation, not escrow.service.ts's internal behavior (already
 * covered by tests/payoutAddress.test.ts and tests/escrowReleaseControls.test.ts).
 * Every other collaborator settlementRoutes() imports is a bare,
 * import-safe stand-in — none of it is exercised by the two routes this
 * file targets, but the module needs to load without throwing.
 */
export {} // same forced-module-scope reasoning used throughout this suite

const mockReleaseFunds = jest.fn().mockResolvedValue({ id: 'escrow-1', status: 'COMPLETED' })
const mockInitiateRelease = jest.fn().mockResolvedValue({ id: 'pending-1', requiredSigners: ['buyer-1'] })
const mockInitiateRefund = jest.fn()

jest.mock('../src/modules/open-settlement/escrow.service', () => ({
  escrowService: {
    releaseFunds: (...args: unknown[]) => mockReleaseFunds(...args),
    initiateRelease: (...args: unknown[]) => mockInitiateRelease(...args),
    initiateRefund: (...args: unknown[]) => mockInitiateRefund(...args),
  },
}))

// Bare, import-safe stand-ins — settlement.routes.ts imports these at
// module scope for its OTHER routes; none is called by /release or
// /initiate-release, so a bare object/jest.fn() is sufficient.
jest.mock('../src/modules/open-settlement/dispute.service', () => ({ getDisputeService: jest.fn() }))
jest.mock('../src/modules/open-settlement/dispute-outcome', () => ({ loadDisputeRulingRecord: jest.fn() }))
jest.mock('../src/modules/open-settlement/market-arbitration.provider', () => ({ marketArbitrationProvider: {} }))
jest.mock('../src/modules/open-settlement/payment-account.service', () => ({ paymentAccountService: {} }))
jest.mock('../src/modules/open-settlement/payout-address.service', () => ({ payoutAddressService: {} }))
jest.mock('../src/modules/open-p2p/trade.service', () => ({ tradeService: {} }))

// requireAuth's own real session/Redis machinery is irrelevant to what
// this file proves — a minimal preHandler that trusts a test-only header
// is the same "mock the boundary, not the thing under test" idiom
// tests/payoutAddress.test.ts already uses for its own collaborators.
jest.mock('../src/common/middleware/auth', () => ({
  requireAuth: async (req: any) => {
    req.participantId = req.headers['x-test-participant-id'] ?? 'seller-1'
  },
}))

// createSharedRateLimit (redis-rate-limit.ts) imports this at module
// scope for the criticalRateLimit preHandler declared once, unconditionally,
// near the top of settlement.routes.ts — neither route this file targets
// uses that preHandler, but the module must still load without a live Redis.
jest.mock('../src/common/redis', () => ({
  redis: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    incr: jest.fn().mockResolvedValue(1),
    pexpire: jest.fn().mockResolvedValue(1),
    pttl: jest.fn().mockResolvedValue(60000),
  },
}))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const fastify = require('fastify')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { settlementRoutes } = require('../src/modules/open-settlement/settlement.routes')

async function buildTestApp() {
  const app = fastify()
  await app.register(settlementRoutes)
  return app
}

describe('POST /v1/settlement/escrow/:id/release — M8-R2 destination authority conformance', () => {
  let app: any
  beforeEach(async () => {
    jest.clearAllMocks()
    mockReleaseFunds.mockResolvedValue({ id: 'escrow-1', status: 'COMPLETED' })
    app = await buildTestApp()
  })
  afterEach(async () => { await app.close() })

  it('never forwards a caller-supplied toAddress — the seller cannot substitute the buyer\'s payout destination', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/settlement/escrow/escrow-1/release',
      headers: { 'x-test-participant-id': 'seller-1' },
      payload: { toAddress: 'attacker-controlled-address' },
    })
    expect(res.statusCode).toBe(200)
    expect(mockReleaseFunds).toHaveBeenCalledWith('escrow-1', undefined, 'seller-1')
  })

  it('a hardcoded demo-style address in the request body has no effect either — no path exists for a demo constant to reach escrowService', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/settlement/escrow/escrow-1/release',
      headers: { 'x-test-participant-id': 'seller-1' },
      payload: { toAddress: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx' }, // the former DEMO_RELEASE_ADDRESS_MULTISIG value
    })
    expect(res.statusCode).toBe(200)
    expect(mockReleaseFunds).toHaveBeenCalledWith('escrow-1', undefined, 'seller-1')
  })

  it('legacy caller sending no toAddress at all still succeeds — backward compatible, toAddress is optional', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/settlement/escrow/escrow-1/release',
      headers: { 'x-test-participant-id': 'seller-1' },
      payload: {},
    })
    expect(res.statusCode).toBe(200)
    expect(mockReleaseFunds).toHaveBeenCalledWith('escrow-1', undefined, 'seller-1')
  })

  it('still validates request shape — a non-string toAddress is rejected before ever reaching escrowService, not silently coerced', async () => {
    // This bare `fastify()` instance (no buildApp()) has no global
    // ZodError -> 400 mapping — that translation is app.ts's own concern
    // (proved for other routes in tests/routes.test.ts, which uses the
    // real buildApp()). What THIS test proves is narrower and still real:
    // releaseSchema.parse() still throws for a malformed body instead of
    // silently accepting/coercing it, so escrowService is never reached.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/settlement/escrow/escrow-1/release',
      headers: { 'x-test-participant-id': 'seller-1' },
      payload: { toAddress: 12345 },
    })
    expect(res.statusCode).not.toBe(200)
    expect(mockReleaseFunds).not.toHaveBeenCalled()
  })

  it('propagates the fail-closed error when the buyer has no registered PayoutAddress (escrowService itself already fails closed — see tests/payoutAddress.test.ts)', async () => {
    mockReleaseFunds.mockRejectedValueOnce(
      new Error('No payout address provided for participant buyer-1 (asset BTC), and none is registered — register one via POST /v1/settlement/payout-addresses first, or pass an explicit address to this call.')
    )
    const res = await app.inject({
      method: 'POST',
      url: '/v1/settlement/escrow/escrow-1/release',
      headers: { 'x-test-participant-id': 'seller-1' },
      payload: {},
    })
    expect(res.statusCode).toBe(500)
    expect(JSON.parse(res.body).message ?? res.body).toEqual(expect.stringContaining('none is registered'))
  })
})

describe('POST /v1/settlement/escrow/:id/initiate-release — M8-R2 destination authority conformance', () => {
  let app: any
  beforeEach(async () => {
    jest.clearAllMocks()
    mockInitiateRelease.mockResolvedValue({ id: 'pending-1', requiredSigners: ['buyer-1'] })
    app = await buildTestApp()
  })
  afterEach(async () => { await app.close() })

  it('never forwards a caller-supplied toAddress for the signature-collection flow (MULTISIG/LIGHTNING_HODL/SAFE_GUARD_EVM)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/settlement/escrow/escrow-1/initiate-release',
      headers: { 'x-test-participant-id': 'seller-1' },
      payload: { toAddress: 'attacker-controlled-script-hex' },
    })
    expect(res.statusCode).toBe(201)
    expect(mockInitiateRelease).toHaveBeenCalledWith('escrow-1', undefined, 'seller-1')
  })

  it('legacy caller sending no toAddress at all still succeeds', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/settlement/escrow/escrow-1/initiate-release',
      headers: { 'x-test-participant-id': 'seller-1' },
      payload: {},
    })
    expect(res.statusCode).toBe(201)
    expect(mockInitiateRelease).toHaveBeenCalledWith('escrow-1', undefined, 'seller-1')
  })
})

// GK-M9R-D R2 (CTO 25 item 1) - the arbiter's own routes surface an expected refusal as a classified 409, never a
// generic 500, and an unexpected fault is still a 500. The real errors escrowService throws are used, not look-alikes.
describe('initiate-release / initiate-refund - R2 refusals keep a safe, verifiable classification', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { TranslationGuardError } = require('../src/modules/open-settlement/dispatch-translation-guard')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { EscrowError } = jest.requireActual('../src/common/errors')
  let app: any
  beforeEach(async () => { jest.clearAllMocks(); app = await buildTestApp() })
  afterEach(async () => { await app.close() })

  const post = (route: string) => app.inject({ method: 'POST', url: `/v1/settlement/escrow/escrow-1/${route}`, headers: { 'x-test-participant-id': 'arbiter-1' }, payload: {} })

  it.each(['initiate-release', 'initiate-refund'])('%s: a translation that differs from the Outcome is 409 TRANSLATION_GUARD_MISMATCH', async (route) => {
    const fail = route === 'initiate-release' ? mockInitiateRelease : mockInitiateRefund
    fail.mockRejectedValueOnce(new TranslationGuardError(['output 0 pays 8500 sats, expected 7000']))
    const res = await post(route)
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'TRANSLATION_GUARD_MISMATCH' })
  })

  it.each(['initiate-release', 'initiate-refund'])('%s: no durable Outcome is a 409 ESCROW_ERROR refusal', async (route) => {
    const fail = route === 'initiate-release' ? mockInitiateRelease : mockInitiateRefund
    fail.mockRejectedValueOnce(new EscrowError('Escrow escrow-1 has no durable authoritative Outcome for dispute round 0 (GK-M9R-D R2).'))
    const res = await post(route)
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'ESCROW_ERROR' })
  })

  it('an unexpected fault is still a 500, not disguised as a refusal', async () => {
    mockInitiateRelease.mockRejectedValueOnce(new Error('psbt decode crashed'))
    expect((await post('initiate-release')).statusCode).toBe(500)
  })
})
