// tests/integration/redisTimeoutRealE2E.test.ts
//
// #307 Phase B.3 — bounded waits for Redis-backed HTTP and relay paths, on
// real Redis and real PostgreSQL, with real fault injection on Redis itself:
//   - CLIENT PAUSE: Redis stops answering without executing anything;
//   - a busy Lua script: Redis executes our command, but only after the
//     client gave up (the "executed without confirmation" case);
//   - CLIENT KILL of a connection with a sent-but-unanswered command.
//
// These pause or block the shared Redis, so they run only with explicit
// authorization: SAILS_REDIS_FAULT_INJECTION_CONFIRMED=yes-isolated-redis
// (CI sets it for its ephemeral Redis service container). Without it the
// suite fails closed rather than silently skipping.
//
// The in-process app reads REDIS_COMMAND_TIMEOUT_MS=500 below; the relay test
// runs two real server processes with the same setting.

process.env.RATE_LIMIT_MAX = '1000'
process.env.RATE_LIMIT_AUTH_MAX = '1000'
process.env.REDIS_COMMAND_TIMEOUT_MS = '500'

import WebSocket from 'ws'
import Redis from 'ioredis'
import { fork, type ChildProcess } from 'child_process'
import { randomBytes } from 'crypto'
import path from 'path'
import { createPostgresIntegrationHarness } from './postgresTestHarness'

jest.setTimeout(120_000)

const TIMEOUT_MS = 500
// One HTTP request may run a few sequential Redis commands; each is bounded.
const HTTP_BOUND_MS = 4 * TIMEOUT_MS + 500

describe('#307 Phase B.3: bounded Redis waits, failure and recovery (real Redis fault injection)', () => {
  const pg = createPostgresIntegrationHarness()
  let app: import('fastify').FastifyInstance
  let base: string
  let redis: import('ioredis').default
  let admin: Redis
  let prisma: import('@prisma/client').PrismaClient
  let SailsClient: typeof import('../../packages/sails-sdk/src/client').SailsClient
  const children: ChildProcess[] = []
  const sockets: WebSocket[] = []
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  const latencies: Record<string, number[]> = {}
  const record = (name: string, ms: number) => (latencies[name] ??= []).push(Math.round(ms))

  const pause = (ms: number) => admin.call('CLIENT', 'PAUSE', String(ms), 'ALL')
  const unpause = () => admin.call('CLIENT', 'UNPAUSE').catch(() => undefined)

  const party = async (baseUrl = base) => {
    const sdk = new SailsClient({ baseUrl, webSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket })
    const { keypair } = await sdk.identity.create()
    const { participantId, sessionToken } = await sdk.identity.authenticate(keypair)
    return { sdk, id: participantId as string, sessionToken: sessionToken as string }
  }
  const post = async (url: string, token: string) => {
    const t0 = Date.now()
    const res = await fetch(base + url, {
      method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: '{}',
      signal: AbortSignal.timeout(15_000),
    })
    return { status: res.status, ms: Date.now() - t0, body: await res.json().catch(() => null) as Record<string, unknown> | null }
  }
  const get = async (url: string, token: string) => {
    const t0 = Date.now()
    const res = await fetch(base + url, { headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(15_000) })
    return { status: res.status, ms: Date.now() - t0 }
  }
  const ticketsOf = async (participantId: string): Promise<number> => {
    let n = 0
    for (const key of await admin.keys('auth:ws-ticket:*')) if (await admin.get(key) === participantId) n++
    return n
  }

  beforeAll(async () => {
    if (process.env.SAILS_REDIS_FAULT_INJECTION_CONFIRMED !== 'yes-isolated-redis') {
      throw new Error('#307 B.3 pauses and blocks Redis: set SAILS_REDIS_FAULT_INJECTION_CONFIRMED=yes-isolated-redis on an isolated test Redis')
    }
    await pg.probe()
    pg.requirePostgres('#307 Phase B.3 Redis timeouts')
    admin = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379')
    await admin.ping()
    ;({ redis } = require('../../src/common/redis'))
    ;({ prisma } = require('../../src/common/database'))
    ;({ SailsClient } = require('../../packages/sails-sdk/src/client'))
    const { buildApp } = require('../../src/app')
    app = await buildApp({ registerSwaggerUi: false })
    await app.listen({ port: 0, host: '127.0.0.1' })
    base = 'http://127.0.0.1:' + (app.server.address() as { port: number }).port
  })

  afterEach(async () => {
    await unpause()
    for (const ws of sockets.splice(0)) ws.terminate()
    for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL')
  })

  afterAll(async () => {
    await unpause()
    console.log('[#307 B.3] latencies ms: ' + JSON.stringify(latencies))
    await app?.close()
    await prisma?.$disconnect()
    await redis?.quit()
    admin?.disconnect()
  })

  it('normal operation: authenticated read and ws-ticket write answer quickly', async () => {
    const alice = await party()
    for (let i = 0; i < 10; i++) {
      const r = await post('/v1/identity/ws-ticket', alice.sessionToken)
      expect(r.status).toBe(200)
      record('ticket normal', r.ms)
      const me = await get('/v1/identity/me', alice.sessionToken)
      expect(me.status).toBe(200)
      record('read normal', me.ms)
    }
  })

  it('Redis paused longer than the bound: reads and writes fail with 503 within the bound, not the client timeout', async () => {
    const alice = await party()
    await pause(4000)
    const [ticket, me, challenge] = await Promise.all([
      post('/v1/identity/ws-ticket', alice.sessionToken),
      get('/v1/identity/me', alice.sessionToken),
      fetch(base + '/v1/identity/challenge', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ publicKey: randomBytes(32).toString('hex') }), signal: AbortSignal.timeout(15_000),
      }).then(async res => ({ status: res.status })),
    ])
    for (const r of [ticket, me]) {
      expect(r.status).toBe(503)
      expect(r.ms).toBeLessThan(HTTP_BOUND_MS)
    }
    expect(challenge.status).toBe(503)
    expect(ticket.body).toMatchObject({ success: false, error: 'DEPENDENCY_UNAVAILABLE' })
    record('ticket paused', ticket.ms)
    record('read paused', me.ms)
  })

  it('recovers after the pause: requests succeed again and no commands stay queued', async () => {
    const alice = await party()
    await pause(1500)
    const during = await Promise.all(Array.from({ length: 20 }, () => post('/v1/identity/ws-ticket', alice.sessionToken)))
    expect(during.every(r => r.status === 503 && r.ms < HTTP_BOUND_MS)).toBe(true)
    await sleep(1700)
    const after = await post('/v1/identity/ws-ticket', alice.sessionToken)
    expect(after.status).toBe(200)
    record('ticket after recovery', after.ms)
    const queues = redis as unknown as { commandQueue: { length: number }; offlineQueue: { length: number } }
    const deadline = Date.now() + 3000
    while ((queues.commandQueue.length || queues.offlineQueue.length) && Date.now() < deadline) await sleep(50)
    expect({ commandQueue: queues.commandQueue.length, offlineQueue: queues.offlineQueue.length }).toEqual({ commandQueue: 0, offlineQueue: 0 })
  })

  it('a write Redis executes after the client gave up: 503 to the caller, executed once, never re-sent', async () => {
    // CLIENT PAUSE holds commands at the server; they execute when it ends,
    // after the client has already been told they timed out. (A busy Lua
    // script cannot model this: Redis 7 freezes TIME inside scripts, and
    // other clients get BUSY replies instead of waiting.)
    const alice = await party()
    expect(await ticketsOf(alice.id)).toBe(0)
    await pause(1500)
    const r = await post('/v1/identity/ws-ticket', alice.sessionToken)
    // requireAuth's session GET is the command that outlives the bound, so
    // the ticket SET is never issued for this request.
    expect(r.status).toBe(503)
    expect(r.ms).toBeLessThan(HTTP_BOUND_MS)
    await sleep(1700)
    expect(await ticketsOf(alice.id)).toBe(0)

    // Now a WRITE that outlives the bound: rejected to the caller, executed
    // by Redis once the pause ends — exactly once, nothing re-sent.
    const writeOnly = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', { commandTimeout: TIMEOUT_MS, autoResendUnfulfilledCommands: false })
    const key = 'b3:executed-late:' + randomBytes(8).toString('hex')
    try {
      await writeOnly.ping()
      await pause(1500)
      await expect(writeOnly.incr(key)).rejects.toThrow('Command timed out')
      await sleep(1700)
      expect(await admin.get(key)).toBe('1')
    } finally {
      writeOnly.disconnect()
      await admin.del(key)
    }
  })

  it('a sent-but-unanswered command is not re-sent after a reconnect (no automatic retry)', async () => {
    const key = 'b3:no-resend:' + randomBytes(8).toString('hex')
    const client = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
      commandTimeout: 5000, autoResendUnfulfilledCommands: false, maxRetriesPerRequest: 3,
    })
    try {
      const id = await client.call('CLIENT', 'ID') as number
      await admin.call('CLIENT', 'PAUSE', '1500', 'WRITE')
      const pending = client.incr(key) // sent, held by the pause
      await sleep(100)
      await admin.call('CLIENT', 'KILL', 'ID', String(id)) // connection dropped while unanswered
      await expect(pending).rejects.toThrow()
      await unpause()
      await sleep(500)
      expect(await admin.get(key)).toBeNull() // never executed, and not re-sent on reconnect
      expect(await client.ping()).toBe('PONG') // the client itself recovered
    } finally {
      client.disconnect()
      await admin.del(key)
    }
  })

  it('the shared client is bounded and does not auto-resend; blocking consumers must use a dedicated client', async () => {
    const options = (redis as unknown as { options: Record<string, unknown> }).options
    expect(options.commandTimeout).toBe(TIMEOUT_MS)
    expect(options.autoResendUnfulfilledCommands).toBe(false)

    // Why: a bounded client cannot serve a blocking read longer than its bound.
    const stream = 'b3:stream:' + randomBytes(6).toString('hex')
    const bounded = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', { commandTimeout: TIMEOUT_MS })
    const dedicated = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379')
    try {
      await admin.xgroup('CREATE', stream, 'g', '$', 'MKSTREAM')
      await expect(bounded.xreadgroup('GROUP', 'g', 'c1', 'BLOCK', 1000, 'STREAMS', stream, '>')).rejects.toThrow('Command timed out')
      const t0 = Date.now()
      expect(await dedicated.xreadgroup('GROUP', 'g', 'c2', 'BLOCK', 1000, 'STREAMS', stream, '>')).toBeNull()
      expect(Date.now() - t0).toBeGreaterThanOrEqual(900)
      // The streams store refuses a bounded client instead of failing at runtime.
      const { RedisStreamsEventStore } = require('../../src/common/events/event-store')
      expect(() => new RedisStreamsEventStore(bounded)).toThrow(/dedicated Redis client/)
      expect(() => new RedisStreamsEventStore(dedicated)).not.toThrow()
    } finally {
      bounded.disconnect()
      dedicated.disconnect()
      await admin.del(stream)
    }
  })

  it('the cross-instance event subscriber is isolated: subscribing during a pause still completes and receives events', async () => {
    const { PostgresEventStore } = require('../../src/common/events/event-store')
    const store = new PostgresEventStore()
    const bounded = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', { commandTimeout: TIMEOUT_MS })
    const publisher = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379')
    try {
      await bounded.ping()
      const received: string[] = []
      store.subscribe('b3.probe', (e: { eventId: string }) => received.push(e.eventId))
      const sub = () => (store as unknown as { crossInstanceSubscriber: Redis }).crossInstanceSubscriber
      await pause(1500)
      store.enableCrossInstanceFanout(bounded) // SUBSCRIBE is held by the pause, longer than the bound
      expect((sub() as unknown as { options: { commandTimeout?: number } }).options.commandTimeout).toBeUndefined()
      await sleep(2000)
      const eventId = 'b3-' + randomBytes(6).toString('hex')
      await publisher.publish('sails:cross-instance-events', JSON.stringify({ eventName: 'b3.probe', eventId, __originInstanceId: 'elsewhere' }))
      const deadline = Date.now() + 3000
      while (!received.includes(eventId) && Date.now() < deadline) await sleep(50)
      expect(received).toContain(eventId)
    } finally {
      await store.disableCrossInstanceFanout()
      bounded.disconnect()
      publisher.disconnect()
    }
  })

  it('relay across two processes: a pause closes the sender fast (1011), ownership survives a short pause, delivery resumes once', async () => {
    const spawnServer = (env: Record<string, string>) => new Promise<{ child: ChildProcess; base: string }>((resolve, reject) => {
      const child = fork(path.join(__dirname, '..', 'helpers', 'relayServerProcess.ts'), [], {
        execArgv: ['-r', 'ts-node/register/transpile-only'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: { ...process.env, ...env },
      })
      children.push(child)
      let stderr = ''
      child.stderr?.on('data', d => { stderr += d })
      child.once('message', (m: { port?: number; error?: string }) =>
        m.port ? resolve({ child, base: 'http://127.0.0.1:' + m.port }) : reject(new Error(m.error ?? stderr)))
    })
    // TTL above the pause: one heartbeat fails during it, ownership must not.
    const env = { REDIS_COMMAND_TIMEOUT_MS: String(TIMEOUT_MS), RELAY_OWNER_TTL_MS: '6000' }
    const [p1, p2] = await Promise.all([spawnServer(env), spawnServer(env)])
    const alice = await party(p1.base)
    const bob = await party(p2.base)
    const offer = await prisma.offer.create({ data: {
      userId: bob.id, asset: 'BTC', side: 'SELL', priceUsd: '1', minAmount: '1', maxAmount: '1', paymentMethod: 'PIX',
    } })
    const trade = await prisma.trade.create({ data: {
      offerId: offer.id, buyerId: alice.id, sellerId: bob.id, asset: 'BTC', amount: '1', priceUsd: '1', totalUsd: '1', status: 'ACTIVE',
    } })
    const a = await alice.sdk.peers.connectRelay() as unknown as WebSocket
    const b = await bob.sdk.peers.connectRelay() as unknown as WebSocket
    sockets.push(a, b)
    const bobFrames: Record<string, unknown>[] = []
    b.on('message', d => bobFrames.push(JSON.parse(d.toString())))
    const aliceFrames: Record<string, unknown>[] = []
    a.on('message', d => aliceFrames.push(JSON.parse(d.toString())))
    const envelope = (body: string) => ({ v: 1, type: 'SEND', id: randomBytes(16).toString('base64url'), to: bob.id, trade: trade.id, body })

    await pause(2500)
    const closed = new Promise<{ code: number; ms: number }>(resolve => {
      const t0 = Date.now()
      a.once('close', code => resolve({ code, ms: Date.now() - t0 }))
    })
    const lost = envelope('during pause')
    a.send(JSON.stringify(lost))
    const result = await closed
    expect(result.code).toBe(1011)
    expect(result.ms).toBeLessThan(HTTP_BOUND_MS)
    record('relay close under pause', result.ms)
    await sleep(2700) // pause over, plus one heartbeat after it

    expect(b.readyState).toBe(WebSocket.OPEN) // Bob's ownership survived the failed heartbeat
    const a2 = await alice.sdk.peers.connectRelay() as unknown as WebSocket
    sockets.push(a2)
    const a2Frames: Record<string, unknown>[] = []
    a2.on('message', d => a2Frames.push(JSON.parse(d.toString())))
    const after = envelope('after pause')
    a2.send(JSON.stringify(after))
    const deadline = Date.now() + 5000
    while (!a2Frames.some(f => f.id === after.id) && Date.now() < deadline) await sleep(20)
    expect(a2Frames.find(f => f.id === after.id)).toEqual({ type: 'SENT', id: after.id })
    await sleep(300)
    const delivered = bobFrames.filter(f => f.type === 'MESSAGE').map(f => f.id)
    expect(delivered).toEqual([after.id]) // the frame sent during the pause never arrives late
    for (const c of [p1, p2]) c.child.send('stop')
  })
})
