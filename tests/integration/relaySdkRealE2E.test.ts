// tests/integration/relaySdkRealE2E.test.ts
//
// #307 / PR #490 — SDK-to-relay end-to-end over the REAL stack. The suites
// relayLiveWebSocket / relayProviderLiveDelivery / relayReconnectTcp mock the
// ticket resolver and the Redis budget; relayRedisIntegration exercises Redis
// primitives without the SDK or the HTTP ticket route. This file closes that
// seam: nothing on the path below is mocked.
//
//   SDK identity.create + authenticate (real HTTP, real Postgres User row,
//   real Redis session)  ->  SDK peers.connectRelay  ->  POST
//   /v1/identity/ws-ticket (real requireAuth, real Redis ticket)  ->  real TCP
//   upgrade on /ws/relay (real ws-auth atomicConsume, real Redis budget Lua)
//   ->  the real WebSocketRelayTransportProvider singleton buildApp() wires.
//
// Observation seams (not test doubles): the Redis keys the production code
// writes, the provider's ownership/connection state, close codes on the wire,
// and the URLs the SDK actually opened (RecordingWebSocket subclasses `ws`
// only to record its constructor argument).
//
// Requires real Postgres AND real Redis; fails closed if either is missing,
// the same convention as postgresTestHarness.requirePostgres().

// HTTP rate limiting is not under test here and every participant below comes
// from 127.0.0.1; the auth tier (10/min default) would otherwise throttle setup.
process.env.RATE_LIMIT_MAX = '1000'
process.env.RATE_LIMIT_AUTH_MAX = '1000'

import WebSocket from 'ws'
import { createPostgresIntegrationHarness } from './postgresTestHarness'

jest.setTimeout(60_000)

const openedUrls: string[] = []
class RecordingWebSocket extends WebSocket {
  constructor(url: string) {
    openedUrls.push(url)
    super(url)
  }
}

type Closed = { code: number; reason: string }
type Sdk = InstanceType<typeof import('../../packages/sails-sdk/src/client').SailsClient>

describe('#307 SDK -> HTTP ticket -> Redis -> WebSocket relay, real end to end', () => {
  const pg = createPostgresIntegrationHarness()
  let app: import('fastify').FastifyInstance
  let httpBase: string
  let redis: import('ioredis').default
  let relay: typeof import('../../src/infrastructure/p2p/websocket-relay.service').webSocketRelayTransportProvider
  let SailsClient: typeof import('../../packages/sails-sdk/src/client').SailsClient
  let RELAY_FRAME_MAX_BYTES: number
  let RELAY_WINDOW_MAX_MESSAGES: number
  const sockets: WebSocket[] = []
  const budgetKeys = new Set<string>()

  const until = async (predicate: () => boolean | Promise<boolean>, what: string): Promise<void> => {
    for (let i = 0; i < 300; i++) {
      if (await predicate()) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('Timed out waiting for ' + what)
  }

  const closedOf = (ws: WebSocket): Promise<Closed> => new Promise(resolve => {
    if (ws.readyState === WebSocket.CLOSED) return resolve({ code: -1, reason: 'already closed' })
    ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
  })

  const opened = async (ws: WebSocket): Promise<WebSocket> => {
    sockets.push(ws)
    if (ws.readyState !== WebSocket.OPEN) {
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve())
        ws.once('error', reject)
      })
    }
    return ws
  }

  const newParticipant = async (): Promise<{ sdk: Sdk; id: string; sessionToken: string }> => {
    const sdk = new SailsClient({
      baseUrl: httpBase,
      webSocketImpl: RecordingWebSocket as unknown as typeof globalThis.WebSocket,
    })
    const { keypair } = await sdk.identity.create()
    const auth = await sdk.identity.authenticate(keypair)
    const id = auth.participantId
    budgetKeys.add('ratelimit:ws-relay:' + id)
    return { sdk, id, sessionToken: auth.sessionToken }
  }

  const connect = async (sdk: Sdk): Promise<WebSocket> =>
    opened(await sdk.peers.connectRelay() as unknown as WebSocket)

  const ticketOf = (url: string): string => new URL(url).searchParams.get('ticket') ?? ''

  const admitted = async (id: string): Promise<number> =>
    Number(await redis.hget('ratelimit:ws-relay:' + id, 'messages') ?? '0')

  const rawConnect = (query: string): WebSocket =>
    new WebSocket(httpBase.replace(/^http/, 'ws') + '/ws/relay' + query)

  const rejectedRaw = async (query: string): Promise<{ error: string; closed: Closed }> => {
    const ws = rawConnect(query)
    sockets.push(ws)
    const error = new Promise<string>(resolve => ws.once('message', data => resolve(data.toString())))
    const closed = await closedOf(ws)
    return { error: await error, closed }
  }

  beforeAll(async () => {
    await pg.probe()
    pg.requirePostgres('#307 SDK relay real E2E')
    ;({ redis } = require('../../src/common/redis'))
    try {
      await redis.ping()
    } catch (err) {
      throw new Error('#307 SDK relay real E2E requires a real Redis (npm run redis:local:start): ' + String(err))
    }
    ;({ webSocketRelayTransportProvider: relay } = require('../../src/infrastructure/p2p/websocket-relay.service'))
    ;({ RELAY_FRAME_MAX_BYTES, RELAY_WINDOW_MAX_MESSAGES } = require('../../src/infrastructure/p2p/relay-ingress-budget'))
    ;({ SailsClient } = require('../../packages/sails-sdk/src/client'))
    const { buildApp } = require('../../src/app')
    app = await buildApp({ registerSwaggerUi: false })
    await app.listen({ port: 0, host: '127.0.0.1' })
    const address = app.server.address()
    if (!address || typeof address === 'string') throw new Error('Unexpected listener address')
    httpBase = 'http://127.0.0.1:' + address.port
  })

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate()
    if (redis.status !== 'ready') await redis.connect().catch(() => undefined)
    if (budgetKeys.size) await redis.del(...budgetKeys)
    budgetKeys.clear()
    openedUrls.length = 0
  })

  afterAll(async () => {
    // Same order as app.ts's graceful shutdown: server, then pool, then Redis.
    await app?.close()
    await require('../../src/common/database').prisma.$disconnect()
    await redis?.quit()
  })

  it('opens the relay with a single-use ticket from the real HTTP route, never the session token', async () => {
    const alice = await newParticipant()
    const ws = await connect(alice.sdk)
    await until(() => relay.isConnected(alice.id), 'relay registration')

    expect(openedUrls).toHaveLength(1)
    const ticket = ticketOf(openedUrls[0])
    expect(ticket).toMatch(/^[0-9a-f]{64}$/)
    expect(openedUrls[0]).not.toContain(alice.sessionToken)
    // Burned by the upgrade: the ticket key no longer exists in Redis.
    expect(await redis.exists('auth:ws-ticket:' + ticket)).toBe(0)

    ws.send('opaque-1')
    await until(async () => await admitted(alice.id) === 1, 'frame admitted by the real Redis budget')
  })

  it('rejects a replayed ticket and leaves the legitimate connection owned and open', async () => {
    const alice = await newParticipant()
    const ws = await connect(alice.sdk)
    await until(() => relay.isConnected(alice.id), 'relay registration')

    const replay = await rejectedRaw('?ticket=' + ticketOf(openedUrls[0]))
    expect(replay.error).toContain('already-used ticket')
    expect(ws.readyState).toBe(WebSocket.OPEN)
    expect(relay.isConnected(alice.id)).toBe(true)
  })

  it('rejects the session token used as a ticket without consuming the session', async () => {
    const alice = await newParticipant()
    const attempt = await rejectedRaw('?ticket=' + alice.sessionToken)
    expect(attempt.error).toContain('already-used ticket')
    expect(relay.isConnected(alice.id)).toBe(false)
    // The session is untouched: an authenticated call still succeeds.
    await expect(alice.sdk.identity.me()).resolves.toMatchObject({ id: alice.id })
  })

  it('rejects missing and expired tickets', async () => {
    const alice = await newParticipant()
    expect((await rejectedRaw('')).error).toContain('ticket')

    const res = await fetch(httpBase + '/v1/identity/ws-ticket', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + alice.sessionToken, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(200)
    const { data } = await res.json() as { data: { ticket: string } }
    // Stand-in for the TTL elapsing: the real Redis key expiry, not a mock.
    await redis.pexpire('auth:ws-ticket:' + data.ticket, 1)
    await until(async () => await redis.exists('auth:ws-ticket:' + data.ticket) === 0, 'ticket expiry')
    expect((await rejectedRaw('?ticket=' + data.ticket)).error).toContain('already-used ticket')
    expect(relay.isConnected(alice.id)).toBe(false)
  })

  it('reconnects with a fresh ticket, retires the old socket and ignores its frames', async () => {
    const alice = await newParticipant()
    const first = await connect(alice.sdk)
    await until(() => relay.isConnected(alice.id), 'first registration')
    const firstClosed = closedOf(first)

    const second = await connect(alice.sdk)
    expect(ticketOf(openedUrls[1])).not.toBe(ticketOf(openedUrls[0]))
    await firstClosed
    await until(() => relay.isConnected(alice.id), 'second registration')

    second.send('after-reconnect')
    await until(async () => await admitted(alice.id) === 1, 'new socket frame admitted')
    expect(second.readyState).toBe(WebSocket.OPEN)
  })

  it('closes an oversized frame with 1009 before it reaches the Redis budget', async () => {
    const alice = await newParticipant()
    const ws = await connect(alice.sdk)
    await until(() => relay.isConnected(alice.id), 'relay registration')
    const closed = closedOf(ws)
    ws.send(Buffer.alloc(RELAY_FRAME_MAX_BYTES + 1, 1))
    expect(await closed).toEqual({ code: 1009, reason: 'Relay frame exceeds maximum size' })
    expect(await admitted(alice.id)).toBe(0)
  })

  it('closes on budget exhaustion with 1008 and a reconnect does not reset the budget', async () => {
    const alice = await newParticipant()
    const ws = await connect(alice.sdk)
    await until(() => relay.isConnected(alice.id), 'relay registration')
    for (let i = 0; i < RELAY_WINDOW_MAX_MESSAGES; i++) ws.send('m' + i)
    await until(async () => await admitted(alice.id) === RELAY_WINDOW_MAX_MESSAGES, 'full window admitted')
    const closed = closedOf(ws)
    ws.send('one-too-many')
    expect(await closed).toEqual({ code: 1008, reason: 'Relay resource budget exceeded' })

    const again = await connect(alice.sdk)
    await until(() => relay.isConnected(alice.id), 're-registration')
    const againClosed = closedOf(again)
    again.send('still-over-budget')
    expect(await againClosed).toEqual({ code: 1008, reason: 'Relay resource budget exceeded' })
    expect(await admitted(alice.id)).toBe(RELAY_WINDOW_MAX_MESSAGES)
  })

  it('delivers a server-relayed payload only to its addressee', async () => {
    const [alice, bob, carol] = [await newParticipant(), await newParticipant(), await newParticipant()]
    const [aWs, bWs, cWs] = [await connect(alice.sdk), await connect(bob.sdk), await connect(carol.sdk)]
    await until(() => [alice, bob, carol].every(p => relay.isConnected(p.id)), 'three registrations')
    const seen: Record<string, string[]> = { a: [], b: [], c: [] }
    aWs.on('message', d => seen.a.push(d.toString()))
    bWs.on('message', d => seen.b.push(d.toString()))
    cWs.on('message', d => seen.c.push(d.toString()))

    expect(await relay.sendToPeer(alice.id, bob.id, 'ciphertext:opaque')).toBe(true)
    await until(() => seen.b.length === 1, 'delivery to Bob')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(seen).toEqual({ a: [], b: ['ciphertext:opaque'], c: [] })
  })

  it('fails closed on Redis loss for both frames and ticket issuance, then recovers', async () => {
    const alice = await newParticipant()
    const ws = await connect(alice.sdk)
    await until(() => relay.isConnected(alice.id), 'relay registration')
    const closed = closedOf(ws)

    redis.disconnect()
    await until(() => redis.status === 'end', 'Redis client closed')
    ws.send('during-outage')
    expect(await closed).toEqual({ code: 1011, reason: 'Relay unavailable' })
    await expect(alice.sdk.peers.connectRelay()).rejects.toThrow()
    expect(relay.isConnected(alice.id)).toBe(false)

    await redis.connect()
    const recovered = await connect(alice.sdk)
    await until(() => relay.isConnected(alice.id), 'registration after recovery')
    recovered.send('after-recovery')
    await until(async () => await admitted(alice.id) === 1, 'frame admitted after recovery')
  })
})
