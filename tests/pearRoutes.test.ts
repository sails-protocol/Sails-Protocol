/**
 * P2P transport routes — `src/infrastructure/p2p/pear.routes.ts` and
 * `src/infrastructure/p2p/relay.routes.ts`. Pre-existing tests/routes.test.ts
 * covers /v1/peers/start at the level of "auth required + happy path",
 * but every other route in those files — stop, status, join-topic,
 * broadcast-offer — had no test coverage at all until this pass.
 *
 * POST /v1/peers/join-trade moved to modules/open-p2p/trade.routes.ts
 * (Missão 06.10) — no longer registered by pear.routes.ts at all, so its
 * coverage moved with it, to tests/joinTradeAuthorization.test.ts (that
 * file also covers the domain-authorization behavior this one never
 * could, since it registers only pear.routes.ts in isolation with no
 * Trade/tradeService available to check against).
 *
 * This file's approach is intentionally narrower than tests/routes.test.ts:
 * it imports pear.routes DIRECTLY (no buildApp()) and registers it on a
 * tiny Fastify instance with just the mocked services. That sidesteps
 * the whole-app boot (no prisma, no redis, no event-bus, no intent
 * engine) which would otherwise pull in dozens of unrelated files and
 * make this file's failures un-attributable.
 *
 * Gap findings this file targets (tests/TEST_AUDIT_REPORT.md P2P
 * Transport row): /v1/peers/{stop,status,join-topic,broadcast-offer},
 * plus the 409-on-missing-node contract those routes' only meaningful
 * business rule actually enforces.
 *
 * /ws/relay is exercised in tests/routes.test.ts's existing routes
 * block (the websocket-relay.transport-provider mock there is the same
 * shape), so this file deliberately skips it to avoid two files
 * claiming the same coverage.
 */
import Fastify, { type FastifyInstance } from 'fastify'

jest.mock('@tetherto/wdk-wallet-evm', () => ({
  __esModule: true,
  default: class FakeWalletManagerEvm {},
}))
jest.mock('@arkade-os/sdk', () => ({
  SeedIdentity: { fromSeed: jest.fn() },
  MultisigTapscript: { encode: jest.fn() },
  CSVMultisigTapscript: { encode: jest.fn() },
  VtxoScript: class FakeVtxoScript {},
  RestArkProvider: class FakeRestArkProvider {},
  RestIndexerProvider: class FakeRestIndexerProvider {},
  buildOffchainTx: jest.fn(),
  combineTapscriptSignatures: jest.fn(),
  verifyTapscriptSignatures: jest.fn(),
}))
jest.mock('@scure/btc-signer', () => ({ Transaction: { fromPSBT: jest.fn() } }))

// pearNodeRegistry-level mocks (called directly on the registry):
//   stop, getStatus — both handlers reach the registry, not the node.
// Node-level mocks (called on the object returned by registry.get):
//   joinTopic, broadcast — pear.routes.ts calls these on the resolved
//   PearNode instance, not the registry.
const mockPearNodeStop = jest.fn().mockResolvedValue(undefined)
const mockPearNodeGetStatus = jest.fn().mockReturnValue({
  userId: 'u', started: true, peerId: 'fake-peer-id', connectedPeers: 0, activeTopics: [], peers: [],
})
const mockPearNodeGet = jest.fn()

jest.mock('../src/infrastructure/p2p/pear.service', () => ({
  pearNodeRegistry: {
    start: jest.fn().mockResolvedValue('fake-peer-id'),
    stop: (...args: unknown[]) => mockPearNodeStop(...args),
    get: (...args: unknown[]) => mockPearNodeGet(...args),
    getStatus: (...args: unknown[]) => mockPearNodeGetStatus(...args),
    // The next two are never called by pear.routes.ts itself (it calls
    // them on the node, see above) — they're stubbed here so a future
    // route addition that does call them directly doesn't NPE the
    // shared registry mock.
    joinTopic: jest.fn(),
    broadcastOffer: jest.fn(),
  },
}))

// pear.routes.ts imports `fallbackTransportProvider` and calls its
// .start()/.activeTransportName() inside the /v1/peers/start handler.
// /v1/peers/start is already covered by routes.test.ts; this file's
// narrower scope doesn't need it. The mock just needs to exist so
// pear.routes.ts can be required without the real (hyperdht-bound)
// one being constructed.
jest.mock('../src/infrastructure/p2p/transport-provider', () => ({
  fallbackTransportProvider: {
    start: jest.fn().mockResolvedValue({ peerId: 'fake-peer-id' }),
    activeTransportName: jest.fn().mockReturnValue('pears'),
    isConnected: jest.fn().mockReturnValue(false),
    stop: jest.fn().mockResolvedValue(undefined),
  },
  pearsTransportProvider: {},
}))

// pear.routes.ts reaches `requireAuth` (../common/middleware/auth).
// That module's real implementation needs Redis and a cryptographic
// verifier — neither is needed for the auth-presence check this file
// exercises, so the whole module is mocked. The single `attached`
// participantId is the same shape every route handler reads off the
// request object.
let authedParticipantId: string | null = null
jest.mock('../src/common/middleware/auth', () => ({
  requireAuth: jest.fn(async (request: any) => {
    if (!authedParticipantId) {
      const err: any = new Error('unauthenticated')
      err.statusCode = 401
      err.code = 'AUTH_ERROR'
      throw err
    }
    request.participantId = authedParticipantId
  }),
}))

jest.mock('../src/common/events/event-bus', () => ({
  eventBus: {
    emit: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    onDurable: jest.fn(),
  },
}))

// pear.routes.ts itself is a factory that registers routes on a
// passed-in FastifyInstance — same shape as every other *.routes.ts in
// this codebase. Importing it here runs the factory's body but doesn't
// actually open any sockets (the handlers only run when a request
// arrives), so this is safe even without the rest of buildApp().
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { peerRoutes } = require('../src/infrastructure/p2p/pear.routes')

function mockActiveNode(overrides: {
  joinTopic?: jest.Mock
  broadcast?: jest.Mock
} = {}): any {
  // pear.routes.ts calls these on the resolved PearNode instance. Each
  // test picks which ones it cares about and asserts on its own spy.
  return {
    start: jest.fn(),
    joinTopic: overrides.joinTopic ?? jest.fn().mockResolvedValue(undefined),
    broadcast: overrides.broadcast ?? jest.fn().mockReturnValue(3),
  }
}

describe('P2P Transport — /v1/peers/* routes (pear.routes.ts)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(peerRoutes)
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    jest.clearAllMocks()
    authedParticipantId = null
    mockPearNodeGet.mockReset()
  })

  // ── Auth ────────────────────────────────────────────────────────────────────

  describe('authentication', () => {
    it('every protected route returns 401 when no session is present', async () => {
      const routes = [
        { method: 'POST' as const, url: '/v1/peers/stop' },
        { method: 'GET' as const, url: '/v1/peers/status' },
        { method: 'POST' as const, url: '/v1/peers/join-topic', payload: { topic: 'btc' } },
        { method: 'POST' as const, url: '/v1/peers/broadcast-offer', payload: { offerId: 'o-1', asset: 'BTC', side: 'SELL', priceUsd: '1' } },
      ]
      for (const r of routes) {
        const res = await app.inject(r as any)
        expect(res.statusCode).toBe(401)
      }
    })
  })

  describe('POST /v1/peers/start capabilities', () => {
    it.each([
      ['pears', { directRelay: false, topicDiscovery: true, topicBroadcast: true }],
      ['websocket-relay', { directRelay: true, topicDiscovery: false, topicBroadcast: false }],
    ])('reports supported capabilities for %s', async (transport, capabilities) => {
      authedParticipantId = 'user-1'
      const { fallbackTransportProvider } = require('../src/infrastructure/p2p/transport-provider')
      fallbackTransportProvider.activeTransportName.mockReturnValue(transport)
      const res = await app.inject({ method: 'POST', url: '/v1/peers/start' })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({
        success: true,
        data: { peerId: 'fake-peer-id', transport, capabilities },
      })
      expect(fallbackTransportProvider.start).toHaveBeenCalledWith('user-1')
    })
  })

  // ── /v1/peers/stop ──────────────────────────────────────────────────────────

  describe('POST /v1/peers/stop', () => {
    it('stops the caller\'s node for an authenticated caller and returns 200', async () => {
      authedParticipantId = 'user-1'
      const res = await app.inject({ method: 'POST', url: '/v1/peers/stop' })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ success: true })
      const { fallbackTransportProvider } = require('../src/infrastructure/p2p/transport-provider')
      expect(fallbackTransportProvider.stop).toHaveBeenCalledWith('user-1')
      expect(mockPearNodeStop).not.toHaveBeenCalled()
    })
  })

  // ── /v1/peers/status ───────────────────────────────────────────────────────

  describe('GET /v1/peers/status', () => {
    it('returns the caller\'s peer status for an authenticated caller', async () => {
      authedParticipantId = 'user-1'
      const res = await app.inject({ method: 'GET', url: '/v1/peers/status' })
      expect(res.statusCode).toBe(200)
      const data = JSON.parse(res.body).data
      expect(data.peerId).toBe('fake-peer-id')
      expect(mockPearNodeGetStatus).toHaveBeenCalledWith('user-1')
    })
  })

  describe('GET /v1/peers/status in relay mode', () => {
    it.each([false, true])('reports actual relay connection state %s without querying Pears', async connected => {
      authedParticipantId = 'user-relay'
      const { fallbackTransportProvider } = require('../src/infrastructure/p2p/transport-provider')
      fallbackTransportProvider.activeTransportName.mockReturnValue('websocket-relay')
      fallbackTransportProvider.isConnected.mockReturnValue(connected)
      const res = await app.inject({ method: 'GET', url: '/v1/peers/status' })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body).data).toMatchObject({
        userId: 'user-relay', peerId: 'user-relay', transport: 'websocket-relay',
        started: connected, connected,
        connectedPeers: 0, activeTopics: [],
        capabilities: { directRelay: true, topicDiscovery: false, topicBroadcast: false },
      })
      expect(mockPearNodeGetStatus).not.toHaveBeenCalled()
    })
  })

  // ── /v1/peers/join-topic ───────────────────────────────────────────────────

  describe('POST /v1/peers/join-topic', () => {
    it('returns 409 when the caller has not started a node yet', async () => {
      authedParticipantId = 'user-1'
      mockPearNodeGet.mockReturnValue(undefined) // no node
      const res = await app.inject({
        method: 'POST',
        url: '/v1/peers/join-topic',
        payload: { topic: 'marketplace' },
      })
      expect(res.statusCode).toBe(409)
      // PRODUCTION_READINESS_FIXES.md P1 item 17, closed 2026-08-08 —
      // was 'NOT_FOUND', mismatched with its own 409 status; fixed to 'CONFLICT'.
      expect(JSON.parse(res.body)).toMatchObject({ success: false, error: 'CONFLICT' })
    })

    it('joins the topic when the caller has an active node', async () => {
      authedParticipantId = 'user-1'
      // pear.routes.ts calls `node.joinTopic(body.topic)` on the resolved
      // node — only the topic reaches the node, the participantId stays
      // at the registry level. Capture the call on the node.
      const joinTopicSpy = jest.fn().mockResolvedValue(undefined)
      mockPearNodeGet.mockReturnValue(mockActiveNode({ joinTopic: joinTopicSpy }))
      const res = await app.inject({
        method: 'POST',
        url: '/v1/peers/join-topic',
        payload: { topic: 'btc' },
      })
      expect(res.statusCode).toBe(200)
      expect(joinTopicSpy).toHaveBeenCalledWith('btc')
    })
  })

  // ── /v1/peers/broadcast-offer ──────────────────────────────────────────────

  describe('POST /v1/peers/broadcast-offer', () => {
    it('returns 409 when the caller has not started a node yet', async () => {
      authedParticipantId = 'user-1'
      mockPearNodeGet.mockReturnValue(undefined)
      const res = await app.inject({
        method: 'POST',
        url: '/v1/peers/broadcast-offer',
        payload: { offerId: 'offer-1', asset: 'BTC', side: 'SELL', priceUsd: '65000' },
      })
      expect(res.statusCode).toBe(409)
    })

    it('broadcasts the offer and reports the deliveredTo count', async () => {
      authedParticipantId = 'user-1'
      // pear.routes.ts calls `node.broadcast({ kind: 'offer_announce', ...body })`
      // and returns whatever count the node reported. mockReturnValue(3)
      // surfaces as `deliveredTo: 3` in the response.
      mockPearNodeGet.mockReturnValue(mockActiveNode({ broadcast: jest.fn().mockReturnValue(3) }))
      const res = await app.inject({
        method: 'POST',
        url: '/v1/peers/broadcast-offer',
        payload: { offerId: 'offer-1', asset: 'BTC', side: 'SELL', priceUsd: '65000' },
      })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body).data).toEqual({ deliveredTo: 3 })
    })
  })
})