// tests/integration/relayDeliveryRealE2E.test.ts
//
// #307 Phase B — participant-to-participant delivery over the relay, proven on
// the real path, nothing mocked:
//
//   SDK Alice (identity.create/authenticate, peers.connectRelay)
//     → HTTP ticket (real requireAuth, Redis session)  → Redis ticket burn
//     → /ws/relay (READY, frame cap, Redis budget)      → envelope validation
//     → authorization against the real Trade row in PostgreSQL
//     → routing (same instance, or Redis pub/sub to another server process)
//     → SDK Bob's socket.
//
// Nothing calls sendToPeer() on the server: every message enters as a frame
// Alice's SDK socket sends. The two-instance test runs two complete servers
// in separate OS processes (tests/helpers/relayServerProcess.ts).
//
// Fixtures written directly with Prisma: the Offer/Trade rows that authorize
// a pair (the authorization reads them; creating them through the HTTP trade
// flow is not what is under test). Requires real Postgres and real Redis;
// fails closed if either is missing.

process.env.RATE_LIMIT_MAX = '1000'
process.env.RATE_LIMIT_AUTH_MAX = '1000'

import WebSocket from 'ws'
import { fork, type ChildProcess } from 'child_process'
import { randomBytes } from 'crypto'
import path from 'path'
import { createPostgresIntegrationHarness } from './postgresTestHarness'

jest.setTimeout(90_000)

type Frame = Record<string, unknown>
type Sdk = InstanceType<typeof import('../../packages/sails-sdk/src/client').SailsClient>
type Party = { sdk: Sdk; id: string }
type Inbox = { frames: Frame[]; next(match: (f: Frame) => boolean, what: string, ms?: number): Promise<Frame> }

describe('#307 Phase B: Alice → relay → Bob over the real stack', () => {
  const pg = createPostgresIntegrationHarness()
  let app: import('fastify').FastifyInstance
  let base: string
  let redis: import('ioredis').default
  let prisma: import('@prisma/client').PrismaClient
  let SailsClient: typeof import('../../packages/sails-sdk/src/client').SailsClient
  const sockets: WebSocket[] = []
  const cleanupKeys = new Set<string>()
  const children: ChildProcess[] = []

  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  const newId = () => randomBytes(16).toString('base64url')

  const party = async (baseUrl = base): Promise<Party> => {
    const sdk = new SailsClient({ baseUrl, webSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket })
    const { keypair } = await sdk.identity.create()
    const { participantId } = await sdk.identity.authenticate(keypair)
    cleanupKeys.add('ratelimit:ws-relay:' + participantId)
    cleanupKeys.add('relay:owner:' + participantId)
    return { sdk, id: participantId }
  }

  const inboxOf = (ws: WebSocket): Inbox => {
    const frames: Frame[] = []
    const waiters: Array<() => void> = []
    ws.on('message', data => {
      frames.push(JSON.parse(data.toString()) as Frame)
      for (const wake of waiters.splice(0)) wake()
    })
    return {
      frames,
      async next(match, what, ms = 5000) {
        const deadline = Date.now() + ms
        for (;;) {
          const found = frames.find(match)
          if (found) return found
          if (Date.now() > deadline) throw new Error('Timed out waiting for ' + what + '; got ' + JSON.stringify(frames))
          await new Promise<void>(resolve => {
            waiters.push(resolve)
            setTimeout(resolve, 50)
          })
        }
      },
    }
  }

  const connect = async (p: Party): Promise<{ ws: WebSocket; inbox: Inbox }> => {
    const ws = await p.sdk.peers.connectRelay() as unknown as WebSocket
    sockets.push(ws)
    return { ws, inbox: inboxOf(ws) }
  }

  const closedOf = (ws: WebSocket) => new Promise<{ code: number; reason: string }>(resolve => {
    if (ws.readyState === WebSocket.CLOSED) return resolve({ code: -1, reason: 'already closed' })
    ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
  })

  const trade = async (buyerId: string, sellerId: string, status = 'ACTIVE'): Promise<string> => {
    const offer = await prisma.offer.create({ data: {
      userId: sellerId, asset: 'BTC', side: 'SELL', priceUsd: '1', minAmount: '1', maxAmount: '1', paymentMethod: 'PIX',
    } })
    const row = await prisma.trade.create({ data: {
      offerId: offer.id, buyerId, sellerId, asset: 'BTC', amount: '1', priceUsd: '1', totalUsd: '1',
      status: status as 'ACTIVE',
    } })
    return row.id
  }

  const send = (ws: WebSocket, fields: Record<string, unknown>) => ws.send(JSON.stringify(fields))
  const envelope = (to: string, tradeId: string, body: string, id = newId()) =>
    ({ v: 1, type: 'SEND', id, to, trade: tradeId, body })

  const quiet = async (inbox: Inbox, ms = 300): Promise<Frame[]> => {
    const before = inbox.frames.length
    await sleep(ms)
    return inbox.frames.slice(before)
  }

  beforeAll(async () => {
    await pg.probe()
    pg.requirePostgres('#307 Phase B relay delivery')
    ;({ redis } = require('../../src/common/redis'))
    try {
      await redis.ping()
    } catch (err) {
      throw new Error('#307 Phase B relay delivery requires a real Redis (npm run redis:local:start): ' + String(err))
    }
    ;({ prisma } = require('../../src/common/database'))
    ;({ SailsClient } = require('../../packages/sails-sdk/src/client'))
    const { buildApp } = require('../../src/app')
    app = await buildApp({ registerSwaggerUi: false })
    await app.listen({ port: 0, host: '127.0.0.1' })
    base = 'http://127.0.0.1:' + (app.server.address() as { port: number }).port
  })

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate()
    if (redis.status !== 'ready') await redis.connect().catch(() => undefined)
    await sleep(50)
    if (cleanupKeys.size) await redis.del(...cleanupKeys)
    cleanupKeys.clear()
  })

  afterAll(async () => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL')
    await app?.close()
    await prisma?.$disconnect()
    await redis?.quit()
  })

  it('delivers Alice → Bob on an authorized trade, with the sender taken from the session; Carol sees nothing', async () => {
    const [alice, bob, carol] = [await party(), await party(), await party()]
    const tradeId = await trade(alice.id, bob.id)
    const [a, b, c] = [await connect(alice), await connect(bob), await connect(carol)]

    const out = envelope(bob.id, tradeId, 'hello bob')
    send(a.ws, out)
    const got = await b.inbox.next(f => f.type === 'MESSAGE', 'Bob MESSAGE')
    expect(got).toEqual({ type: 'MESSAGE', v: 1, id: out.id, from: alice.id, trade: tradeId, body: 'hello bob' })
    expect(await a.inbox.next(f => f.id === out.id, 'Alice ack')).toEqual({ type: 'SENT', id: out.id })
    expect(await quiet(c.inbox)).toEqual([])

    // And back: Bob → Alice on the same trade.
    const reply = envelope(alice.id, tradeId, 'hello alice')
    send(b.ws, reply)
    expect(await a.inbox.next(f => f.type === 'MESSAGE', 'Alice MESSAGE')).toMatchObject({ from: bob.id, body: 'hello alice' })
    expect(await b.inbox.next(f => f.id === reply.id, 'Bob ack')).toEqual({ type: 'SENT', id: reply.id })
  })

  it('refuses a sender who is not a party, and an unknown trade, with the same UNDELIVERED as an offline recipient', async () => {
    const [alice, bob, carol] = [await party(), await party(), await party()]
    const tradeId = await trade(alice.id, bob.id)
    const [b, c] = [await connect(bob), await connect(carol)]

    const intruder = envelope(bob.id, tradeId, 'from carol')
    send(c.ws, intruder)
    const refused = await c.inbox.next(f => f.id === intruder.id, 'Carol ack')
    const unknown = envelope(bob.id, '00000000-0000-0000-0000-000000000000', 'no such trade')
    send(c.ws, unknown)
    const unknownTrade = await c.inbox.next(f => f.id === unknown.id, 'unknown-trade ack')

    // Alice is authorized but not connected: indistinguishable from the refusals.
    const a = await connect(alice)
    a.ws.close()
    await closedOf(a.ws)
    await sleep(100)
    const toOffline = envelope(alice.id, tradeId, 'alice is offline')
    send(b.ws, toOffline)
    const offline = await b.inbox.next(f => f.id === toOffline.id, 'offline ack')

    expect([refused, unknownTrade, offline].map(({ id: _id, ...rest }) => rest))
      .toEqual([{ type: 'UNDELIVERED' }, { type: 'UNDELIVERED' }, { type: 'UNDELIVERED' }])
    expect(b.inbox.frames.filter(f => f.type === 'MESSAGE')).toEqual([])
  })

  it('refuses a party who addresses a non-party through their own valid trade', async () => {
    const [alice, bob, carol] = [await party(), await party(), await party()]
    const tradeId = await trade(alice.id, bob.id)
    const [a, c] = [await connect(alice), await connect(carol)]
    const out = envelope(carol.id, tradeId, 'alice tries carol')
    send(a.ws, out)
    expect(await a.inbox.next(f => f.id === out.id, 'ack')).toEqual({ type: 'UNDELIVERED', id: out.id })
    expect(await quiet(c.inbox)).toEqual([])
  })

  it('rejects a client-supplied "from" and never forwards it', async () => {
    const [alice, bob, carol] = [await party(), await party(), await party()]
    const tradeId = await trade(alice.id, bob.id)
    const [b, c] = [await connect(bob), await connect(carol)]

    // Carol claims to be Alice, Bob's real counterparty.
    const spoof = { ...envelope(bob.id, tradeId, 'i am alice'), from: alice.id }
    send(c.ws, spoof)
    expect(await c.inbox.next(f => f.type === 'REJECTED', 'spoof rejection')).toEqual({ type: 'REJECTED', id: null, reason: 'MALFORMED' })
    expect(await quiet(b.inbox)).toEqual([])
  })

  it('rejects malformed envelopes without forwarding and keeps the socket open', async () => {
    const [alice, bob] = [await party(), await party()]
    const tradeId = await trade(alice.id, bob.id)
    const [a, b] = [await connect(alice), await connect(bob)]
    const good = envelope(bob.id, tradeId, 'x')
    const malformed: unknown[] = [
      'not json',
      [good],
      { ...good, v: 2 },
      { ...good, type: 'BROADCAST' },
      { ...good, id: 'short' },
      { ...good, id: 'bad id with spaces!!!!' },
      { ...good, to: '' },
      { ...good, trade: 'x'.repeat(65) },
      { ...good, body: '' },
      { ...good, body: { nested: true } },
      { v: 1, type: 'SEND', id: good.id, to: good.to, trade: good.trade },
      { ...good, extra: 1 },
    ]
    for (const frame of malformed) a.ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame))
    const deadline = Date.now() + 5000
    while (a.inbox.frames.length < malformed.length && Date.now() < deadline) await sleep(20)
    expect(a.inbox.frames).toEqual(malformed.map(() => ({ type: 'REJECTED', id: null, reason: 'MALFORMED' })))
    expect(a.ws.readyState).toBe(WebSocket.OPEN)
    expect(await quiet(b.inbox)).toEqual([])
  })

  it('delivers a message id once (replay → DUPLICATE), but lets an UNDELIVERED id be retried', async () => {
    const [alice, bob] = [await party(), await party()]
    const tradeId = await trade(alice.id, bob.id)
    const a = await connect(alice)

    // Bob offline: UNDELIVERED, and the id stays usable.
    const first = envelope(bob.id, tradeId, 'retry me')
    send(a.ws, first)
    expect(await a.inbox.next(f => f.id === first.id, 'first ack')).toEqual({ type: 'UNDELIVERED', id: first.id })

    const b = await connect(bob)
    send(a.ws, first)
    await a.inbox.next(f => f.id === first.id && f.type === 'SENT', 'retry SENT')
    send(a.ws, first)
    expect(await a.inbox.next(f => f.id === first.id && f.type === 'REJECTED', 'replay rejection'))
      .toEqual({ type: 'REJECTED', id: first.id, reason: 'DUPLICATE' })
    await sleep(200)
    expect(b.inbox.frames.filter(f => f.type === 'MESSAGE' && f.id === first.id)).toHaveLength(1)

    // Replay from a fresh connection (after reconnect) is still a duplicate.
    a.ws.close()
    await closedOf(a.ws)
    const again = await connect(alice)
    send(again.ws, first)
    expect(await again.inbox.next(f => f.id === first.id, 'replay after reconnect'))
      .toEqual({ type: 'REJECTED', id: first.id, reason: 'DUPLICATE' })
    cleanupKeys.add(`relay:msg:${alice.id}:${first.id}`)
  })

  it.each(['COMPLETED', 'CANCELLED', 'DISPUTED'])('refuses delivery on a %s trade (status policy pending CTO decision)', async status => {
    const [alice, bob] = [await party(), await party()]
    const tradeId = await trade(alice.id, bob.id, status)
    const [a, b] = [await connect(alice), await connect(bob)]
    const out = envelope(bob.id, tradeId, 'late message')
    send(a.ws, out)
    expect(await a.inbox.next(f => f.id === out.id, 'ack')).toEqual({ type: 'UNDELIVERED', id: out.id })
    expect(await quiet(b.inbox)).toEqual([])
  })

  it('fails closed (1011) when Redis is lost, delivers nothing, and recovers', async () => {
    const [alice, bob] = [await party(), await party()]
    const tradeId = await trade(alice.id, bob.id)
    const [a, b] = [await connect(alice), await connect(bob)]
    const closed = closedOf(a.ws)
    redis.disconnect()
    send(a.ws, envelope(bob.id, tradeId, 'during outage'))
    expect(await closed).toEqual({ code: 1011, reason: 'Relay unavailable' })
    expect(b.inbox.frames).toEqual([])
    await redis.connect()

    const recovered = await connect(alice)
    const out = envelope(bob.id, tradeId, 'after recovery')
    send(recovered.ws, out)
    expect(await b.inbox.next(f => f.type === 'MESSAGE', 'MESSAGE after recovery')).toMatchObject({ id: out.id, from: alice.id })
  })

  it('a reconnect does not reset the budget: the 61st frame closes 1008 before and after reconnecting', async () => {
    const [alice, bob] = [await party(), await party()]
    const tradeId = await trade(alice.id, bob.id)
    const [a, b] = [await connect(alice), await connect(bob)]
    for (let i = 0; i < 60; i++) send(a.ws, envelope(bob.id, tradeId, 'm' + i))
    const deadline = Date.now() + 15000
    while (b.inbox.frames.length < 60 && Date.now() < deadline) await sleep(20)
    expect(b.inbox.frames).toHaveLength(60)
    const closed = closedOf(a.ws)
    send(a.ws, envelope(bob.id, tradeId, 'over budget'))
    expect(await closed).toEqual({ code: 1008, reason: 'Relay resource budget exceeded' })

    const again = await connect(alice)
    const againClosed = closedOf(again.ws)
    send(again.ws, envelope(bob.id, tradeId, 'still over budget'))
    expect(await againClosed).toEqual({ code: 1008, reason: 'Relay resource budget exceeded' })
    expect(await quiet(b.inbox)).toEqual([])
    for (const f of b.inbox.frames) cleanupKeys.add(`relay:msg:${alice.id}:${f.id}`)
  })

  it('delivers between two independent server processes, and reports UNDELIVERED once the recipient process dies', async () => {
    const spawnServer = () => new Promise<{ child: ChildProcess; base: string }>((resolve, reject) => {
      const child = fork(path.join(__dirname, '..', 'helpers', 'relayServerProcess.ts'), [], {
        execArgv: ['-r', 'ts-node/register/transpile-only'],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      })
      children.push(child)
      let stderr = ''
      child.stderr?.on('data', d => { stderr += d })
      child.once('message', (m: { port?: number; error?: string }) =>
        m.port ? resolve({ child, base: 'http://127.0.0.1:' + m.port }) : reject(new Error(m.error ?? stderr)))
      child.once('exit', code => reject(new Error(`server process exited ${code}: ${stderr.slice(-800)}`)))
    })
    const [p1, p2] = await Promise.all([spawnServer(), spawnServer()])

    const alice = await party(p1.base)
    const bob = await party(p2.base)
    const carol = await party(p2.base)
    const tradeId = await trade(alice.id, bob.id)
    const [a, b, c] = [await connect(alice), await connect(bob), await connect(carol)]

    const out = envelope(bob.id, tradeId, 'across processes')
    send(a.ws, out)
    expect(await b.inbox.next(f => f.type === 'MESSAGE', 'Bob MESSAGE via process 2'))
      .toEqual({ type: 'MESSAGE', v: 1, id: out.id, from: alice.id, trade: tradeId, body: 'across processes' })
    expect(await a.inbox.next(f => f.id === out.id, 'Alice ack via process 1')).toEqual({ type: 'SENT', id: out.id })
    expect(await quiet(c.inbox)).toEqual([])

    const back = envelope(alice.id, tradeId, 'back across')
    send(b.ws, back)
    expect(await a.inbox.next(f => f.type === 'MESSAGE', 'Alice MESSAGE via process 1')).toMatchObject({ from: bob.id, id: back.id })

    // Bob reconnects through process 1 while his process-2 socket is still
    // open. The late close of the old socket must not erase the new owner.
    const bobOnP1 = new SailsClient({ baseUrl: p1.base, webSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket })
    bobOnP1.setSessionToken(bob.sdk.getSessionToken())
    const b1 = await connect({ sdk: bobOnP1, id: bob.id })
    b.ws.close()
    await closedOf(b.ws)
    await sleep(200)
    // The sender must sit on process 2, so delivery needs Bob's owner key
    // (now process 1) rather than a local socket lookup.
    const carolBobTrade = await trade(carol.id, bob.id)
    const afterMove = envelope(bob.id, carolBobTrade, 'to the new socket')
    send(c.ws, afterMove)
    expect(await b1.inbox.next(f => f.type === 'MESSAGE', 'MESSAGE on Bob new socket')).toMatchObject({ id: afterMove.id, from: carol.id })
    expect(await c.inbox.next(f => f.id === afterMove.id, 'ack after move')).toEqual({ type: 'SENT', id: afterMove.id })
    b1.ws.close()
    await closedOf(b1.ws)
    await connect(bob) // back on process 2, which then dies

    // The recipient's process dies without cleanup: its owner key is stale.
    p2.child.kill('SIGKILL')
    await new Promise(resolve => p2.child.once('exit', resolve))
    const lost = envelope(bob.id, tradeId, 'nobody home')
    send(a.ws, lost)
    expect(await a.inbox.next(f => f.id === lost.id, 'ack after process death')).toEqual({ type: 'UNDELIVERED', id: lost.id })

    p1.child.send('stop')
    await new Promise(resolve => p1.child.once('exit', resolve))
  })
})
