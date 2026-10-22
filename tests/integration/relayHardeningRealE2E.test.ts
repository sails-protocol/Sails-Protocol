// tests/integration/relayHardeningRealE2E.test.ts
//
// #307 Phase B.1 — adversarial evidence for relay delivery hardening, on real
// PostgreSQL, real Redis and real server processes:
//   - ownership: abrupt process death, TTL expiry, recovery, cross-instance
//     reconnect revocation, concurrent claims across two processes;
//   - the internal Redis channel: malformed, forged, replayed and expired
//     frames, forged ACKs, pending-ACK exhaustion — and an explicit test of
//     the trust model (Redis write access == relay authority);
//   - delivery semantics: late ACK, missing ACK, NACK, and what a retry may do;
//   - privacy: identical answers, and latency measured, for unknown trade /
//     non-party / offline / online.
//
// Some tests stand in for a relay instance with a plain Redis subscriber on
// that instance's channel ("fake instance"): the only way to forge, delay or
// withhold an ACK on the real channel. The servers under test are real.

process.env.RATE_LIMIT_MAX = '1000'
process.env.RATE_LIMIT_AUTH_MAX = '1000'

import WebSocket from 'ws'
import Redis from 'ioredis'
import { fork, type ChildProcess } from 'child_process'
import { randomBytes, randomUUID } from 'crypto'
import path from 'path'
import { createPostgresIntegrationHarness } from './postgresTestHarness'

jest.setTimeout(120_000)

type Frame = Record<string, unknown>
type Sdk = InstanceType<typeof import('../../packages/sails-sdk/src/client').SailsClient>
type Party = { sdk: Sdk; id: string }
type Inbox = { frames: Frame[]; arrivedAt: WeakMap<Frame, bigint>; next(match: (f: Frame) => boolean, what: string, ms?: number): Promise<Frame> }
type Server = { child: ChildProcess; base: string }

describe('#307 Phase B.1: relay delivery hardening (real Redis, real processes)', () => {
  const pg = createPostgresIntegrationHarness()
  let redis: import('ioredis').default
  let prisma: import('@prisma/client').PrismaClient
  let SailsClient: typeof import('../../packages/sails-sdk/src/client').SailsClient
  const sockets: WebSocket[] = []
  const children: ChildProcess[] = []
  const extraClients: Redis[] = []
  const cleanupKeys = new Set<string>()

  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  const newId = () => randomBytes(16).toString('base64url')

  const spawnServer = (env: Record<string, string> = {}) => new Promise<Server>((resolve, reject) => {
    const child = fork(path.join(__dirname, '..', 'helpers', 'relayServerProcess.ts'), [], {
      execArgv: ['-r', 'ts-node/register/transpile-only'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env, ...env },
    })
    children.push(child)
    let stderr = ''
    child.stderr?.on('data', d => { stderr += d })
    child.once('message', (m: { port?: number; error?: string }) =>
      m.port ? resolve({ child, base: 'http://127.0.0.1:' + m.port }) : reject(new Error(m.error ?? stderr)))
    child.once('exit', code => reject(new Error(`server process exited ${code}: ${stderr.slice(-800)}`)))
  })
  const kill = async (s: Server) => {
    s.child.kill('SIGKILL')
    if (s.child.exitCode === null && s.child.signalCode === null) await new Promise(resolve => s.child.once('exit', resolve))
  }

  const party = async (base: string): Promise<Party> => {
    const sdk = new SailsClient({ baseUrl: base, webSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket })
    const { keypair } = await sdk.identity.create()
    const { participantId } = await sdk.identity.authenticate(keypair)
    cleanupKeys.add('ratelimit:ws-relay:' + participantId)
    cleanupKeys.add('relay:owner:' + participantId)
    return { sdk, id: participantId }
  }
  const on = (p: Party, base: string): Party => {
    const sdk = new SailsClient({ baseUrl: base, webSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket })
    sdk.setSessionToken(p.sdk.getSessionToken())
    return { sdk, id: p.id }
  }

  const inboxOf = (ws: WebSocket): Inbox => {
    const frames: Frame[] = []
    const arrivedAt = new WeakMap<Frame, bigint>()
    ws.on('message', data => {
      const frame = JSON.parse(data.toString()) as Frame
      arrivedAt.set(frame, process.hrtime.bigint())
      frames.push(frame)
    })
    return {
      frames,
      arrivedAt,
      async next(match, what, ms = 8000) {
        const deadline = Date.now() + ms
        for (;;) {
          const found = frames.find(match)
          if (found) return found
          if (Date.now() > deadline) throw new Error('Timed out waiting for ' + what + '; got ' + JSON.stringify(frames))
          await sleep(20)
        }
      },
    }
  }
  const connect = async (p: Party) => {
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
      offerId: offer.id, buyerId, sellerId, asset: 'BTC', amount: '1', priceUsd: '1', totalUsd: '1', status: status as 'ACTIVE',
    } })
    return row.id
  }
  const envelope = (to: string, tradeId: string, body: string, id = newId()) => ({ v: 1, type: 'SEND', id, to, trade: tradeId, body })
  const send = (ws: WebSocket, fields: Record<string, unknown>) => ws.send(JSON.stringify(fields))
  const messagesIn = (inbox: Inbox, id?: string) => inbox.frames.filter(f => f.type === 'MESSAGE' && (id === undefined || f.id === id))
  const ackFor = (inbox: Inbox, id: string, ms?: number) => inbox.next(f => f.id === id && f.type !== 'MESSAGE', 'ack for ' + id, ms)

  const ownerOf = async (participantId: string) => {
    const value = await redis.get('relay:owner:' + participantId)
    if (!value) return null
    const [instanceId, token] = value.split('|')
    return { instanceId, token, value }
  }
  // A plain subscriber standing in for a relay instance on the real channel.
  const fakeInstance = async () => {
    const id = 'fake-' + randomUUID()
    const sub = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', { maxRetriesPerRequest: 1 })
    extraClients.push(sub)
    const frames: Frame[] = []
    sub.on('message', (_c: string, m: string) => frames.push(JSON.parse(m) as Frame))
    await sub.subscribe('relay:instance:' + id)
    return { id, frames, token: randomBytes(16).toString('base64url') }
  }
  const publish = (instanceId: string, frame: unknown) =>
    redis.publish('relay:instance:' + instanceId, typeof frame === 'string' ? frame : JSON.stringify(frame))

  beforeAll(async () => {
    await pg.probe()
    pg.requirePostgres('#307 Phase B.1 relay hardening')
    ;({ redis } = require('../../src/common/redis'))
    try {
      await redis.ping()
    } catch (err) {
      throw new Error('#307 Phase B.1 relay hardening requires a real Redis: ' + String(err))
    }
    ;({ prisma } = require('../../src/common/database'))
    ;({ SailsClient } = require('../../packages/sails-sdk/src/client'))
  })

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate()
    for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    for (const c of extraClients.splice(0)) c.disconnect()
    await sleep(50)
    if (cleanupKeys.size) await redis.del(...cleanupKeys)
    cleanupKeys.clear()
  })

  afterAll(async () => {
    await prisma?.$disconnect()
    await redis?.quit()
  })

  // ── Ownership ────────────────────────────────────────────────────────────

  it('abrupt process death: UNDELIVERED (retryable), stale ownership expires by TTL, and delivery recovers', async () => {
    const env = { RELAY_OWNER_TTL_MS: '1500' }
    const [p1, p2] = await Promise.all([spawnServer(env), spawnServer(env)])
    const alice = await party(p1.base)
    const bob = await party(p2.base)
    const tradeId = await trade(alice.id, bob.id)
    const a = await connect(alice)
    await connect(bob)
    const before = await ownerOf(bob.id)
    expect(before).not.toBeNull()

    await kill(p2)
    const out = envelope(bob.id, tradeId, 'while bob is down')
    send(a.ws, out)
    expect(await ackFor(a.inbox, out.id)).toEqual({ type: 'UNDELIVERED', id: out.id })
    // The dead process's key is still there right after the crash...
    expect((await ownerOf(bob.id))?.value).toBe(before!.value)
    // ...and expires on its own: no heartbeat refreshes it any more.
    const deadline = Date.now() + 5000
    while (await ownerOf(bob.id) && Date.now() < deadline) await sleep(100)
    expect(await ownerOf(bob.id)).toBeNull()

    // Recovery: Bob reconnects through a brand-new process; the same id is
    // retryable because the first attempt was definitely not delivered.
    const p3 = await spawnServer(env)
    const b3 = await connect(on(bob, p3.base))
    send(a.ws, out)
    expect(await a.inbox.next(f => f.id === out.id && f.type === 'SENT', 'SENT after recovery'))
      .toEqual({ type: 'SENT', id: out.id })
    await sleep(200)
    expect(messagesIn(b3.inbox, out.id)).toHaveLength(1)
    cleanupKeys.add(`relay:msg:${alice.id}:${out.id}`)
  })

  it('a claim whose socket never registers is given up, not refreshed forever (revoke publish failure)', async () => {
    // Fault injection, labelled: the real RelayRouter on real Redis, with only
    // PUBLISH failing — the one step that can fail between the claim's SET and
    // the socket's registration. No socket ever registers for this claim.
    const { RelayRouter } = require('../../src/infrastructure/p2p/relay-delivery')
    const participant = 'orphan-' + randomUUID()
    cleanupKeys.add('relay:owner:' + participant)
    const real = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', { maxRetriesPerRequest: 1 })
    extraClients.push(real)
    const failingPublish = new Proxy(real, {
      get(target, prop) {
        if (prop === 'publish') return async () => { throw new Error('injected publish failure') }
        if (prop === 'duplicate') return () => target.duplicate()
        const value = Reflect.get(target, prop)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const host = { ownsToken: () => false, sendToPeer: async () => false, closeIfToken: () => undefined }
    const router = new RelayRouter({ redis: failingPublish, host, findTrade: async () => null, ownerTtlMs: 600 })
    try {
      // Someone else owns the participant, so the claim must publish a revoke.
      await redis.set('relay:owner:' + participant, 'elsewhere|' + randomBytes(16).toString('base64url'), 'PX', 60_000)
      await router.claim(participant).catch(() => undefined)
      const deadline = Date.now() + 4000
      while (await redis.exists('relay:owner:' + participant) && Date.now() < deadline) await sleep(100)
      expect(await redis.exists('relay:owner:' + participant)).toBe(0)
    } finally {
      await router.stop()
    }
  })

  it('delivers a maximal escape-heavy body across instances (internal frame cap fits double JSON escaping)', async () => {
    // 32 000 double quotes: the client frame stays under the 64 KiB cap, but
    // the body is escaped again in MESSAGE and once more inside the internal
    // deliver frame (~128 KiB). A cap below that drops it silently.
    const [p1, p2] = await Promise.all([spawnServer(), spawnServer()])
    const alice = await party(p1.base)
    const bob = await party(p2.base)
    const tradeId = await trade(alice.id, bob.id)
    const [a, b] = [await connect(alice), await connect(bob)]
    const out = envelope(bob.id, tradeId, '"'.repeat(32_000))
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThan(64 * 1024)
    send(a.ws, out)
    expect(await ackFor(a.inbox, out.id)).toEqual({ type: 'SENT', id: out.id })
    const got = await b.inbox.next(f => f.type === 'MESSAGE', 'escape-heavy MESSAGE')
    expect(got.body).toBe(out.body)
    cleanupKeys.add(`relay:msg:${alice.id}:${out.id}`)
  })

  it('a reconnect on another instance revokes the old socket, which never receives again', async () => {
    const [p1, p2] = await Promise.all([spawnServer(), spawnServer()])
    const alice = await party(p1.base)
    const bob = await party(p2.base)
    const carol = await party(p2.base)
    const t1 = await trade(alice.id, bob.id)
    const t2 = await trade(carol.id, bob.id)
    const [a, c] = [await connect(alice), await connect(carol)]
    const oldBob = await connect(bob)
    const oldClosed = closedOf(oldBob.ws)

    const newBob = await connect(on(bob, p1.base))
    expect(await oldClosed).toEqual({ code: 1008, reason: 'Relay ownership moved' })
    expect((await ownerOf(bob.id))?.instanceId).not.toBe(undefined)

    // Carol shares the old socket's process: delivery must still go to the new one.
    const fromCarol = envelope(bob.id, t2, 'from carol')
    send(c.ws, fromCarol)
    expect(await c.inbox.next(f => f.id === fromCarol.id, 'carol ack')).toEqual({ type: 'SENT', id: fromCarol.id })
    const fromAlice = envelope(bob.id, t1, 'from alice')
    send(a.ws, fromAlice)
    expect(await a.inbox.next(f => f.id === fromAlice.id, 'alice ack')).toEqual({ type: 'SENT', id: fromAlice.id })
    await sleep(200)
    expect(messagesIn(newBob.inbox).map(f => f.id).sort()).toEqual([fromAlice.id, fromCarol.id].sort())
    expect(messagesIn(oldBob.inbox)).toEqual([])
  })

  it('heartbeat closes a socket whose ownership changed without any revoke reaching it', async () => {
    const p1 = await spawnServer({ RELAY_OWNER_TTL_MS: '1500' })
    const bob = await party(p1.base)
    const b = await connect(bob)
    const closed = closedOf(b.ws)
    // Ownership moves in Redis only (e.g. a revoke lost to a Redis blip).
    await redis.set('relay:owner:' + bob.id, 'elsewhere|' + randomBytes(16).toString('base64url'), 'PX', 30_000)
    const started = Date.now()
    expect(await closed).toEqual({ code: 1008, reason: 'Relay ownership moved' })
    expect(Date.now() - started).toBeLessThan(1500) // within one heartbeat (TTL/3) plus slack
  })

  it('an instance that lost ownership never delivers to its old local socket', async () => {
    // Long TTL: the heartbeat cannot close Bob's socket during this test, so
    // only the delivery path's ownership check stands between Alice and it.
    const p1 = await spawnServer({ RELAY_OWNER_TTL_MS: '60000', RELAY_REMOTE_ACK_TIMEOUT_MS: '500' })
    const alice = await party(p1.base)
    const bob = await party(p1.base)
    const tradeId = await trade(alice.id, bob.id)
    const [a, b] = [await connect(alice), await connect(bob)]
    const fake = await fakeInstance()
    // Ownership moves to another instance; Bob's socket here is still open.
    await redis.set('relay:owner:' + bob.id, fake.id + '|' + fake.token, 'PX', 60_000)
    const out = envelope(bob.id, tradeId, 'must follow ownership')
    send(a.ws, out)
    const deadline = Date.now() + 3000
    while (!fake.frames.some(f => f.kind === 'deliver') && Date.now() < deadline) await sleep(20)
    expect(fake.frames.find(f => f.kind === 'deliver')).toMatchObject({ to: bob.id, token: fake.token })
    expect(await ackFor(a.inbox, out.id)).toEqual({ type: 'UNDELIVERED', id: out.id }) // the fake never acks
    expect(b.ws.readyState).toBe(WebSocket.OPEN)
    expect(messagesIn(b.inbox)).toEqual([])
    cleanupKeys.add(`relay:msg:${alice.id}:${out.id}`)
  })

  it('concurrent claims on two instances: one owner survives, the loser is closed and never receives', async () => {
    // Default TTL: the heartbeat (10 s) cannot close the loser inside the 3 s
    // window, so this exercises the immediate paths: revoke, and a revoke that
    // arrived before the loser registered.
    const [p1, p2] = await Promise.all([spawnServer(), spawnServer()])
    const bob = await party(p1.base)
    let alice = await party(p1.base)
    let tradeId = await trade(alice.id, bob.id)
    let a = await connect(alice)
    // RELAY_STRESS_ROUNDS raises this for local stress runs; CI keeps 25.
    const rounds = Number(process.env.RELAY_STRESS_ROUNDS ?? 25)
    for (let round = 0; round < rounds; round++) {
      if (round > 0 && round % 50 === 0) {
        // Stay inside Alice's 60-messages-per-minute relay budget.
        alice = await party(p1.base)
        tradeId = await trade(alice.id, bob.id)
        a = await connect(alice)
      }
      // A loser revoked before its READY makes connectRelay() reject: legal.
      const settled = await Promise.allSettled([connect(on(bob, p1.base)), connect(on(bob, p2.base))])
      const connected = settled.flatMap(r => (r.status === 'fulfilled' ? [r.value] : []))
      const reasons = settled.flatMap(r => (r.status === 'rejected' ? [String(r.reason)] : []))
      expect({ round, connected: connected.length, reasons }).toEqual({ round, connected: expect.any(Number), reasons: expect.any(Array) })
      if (connected.length === 0) throw new Error(`round ${round}: both connections rejected: ${reasons.join(' | ')}`)
      // The loser is closed by revocation or, if the revocation raced its
      // registration, by the next heartbeat (≤ TTL/3).
      const deadline = Date.now() + 3000
      while (connected.filter(s => s.ws.readyState === WebSocket.OPEN).length > 1 && Date.now() < deadline) await sleep(25)
      const open = connected.filter(s => s.ws.readyState === WebSocket.OPEN)
      expect(open).toHaveLength(1)
      const out = envelope(bob.id, tradeId, 'round ' + round)
      send(a.ws, out)
      expect(await a.inbox.next(f => f.id === out.id, 'ack round ' + round)).toEqual({ type: 'SENT', id: out.id })
      await sleep(100)
      expect(messagesIn(open[0].inbox, out.id)).toHaveLength(1)
      for (const loser of connected.filter(s => s !== open[0])) expect(messagesIn(loser.inbox)).toEqual([])
      cleanupKeys.add(`relay:msg:${alice.id}:${out.id}`)
    }
  })

  // ── Internal channel (trust model) ───────────────────────────────────────

  it('ignores malformed, wrong-token, replayed, expired and implausible internal frames', async () => {
    const p1 = await spawnServer()
    const bob = await party(p1.base)
    const b = await connect(bob)
    const owner = (await ownerOf(bob.id))!
    const reply = await fakeInstance()
    const payload = JSON.stringify({ type: 'MESSAGE', v: 1, id: newId(), from: 'x', trade: 'y', body: 'forged' })
    const deliver = (over: Record<string, unknown> = {}) => ({
      kind: 'deliver', reqId: randomUUID(), replyTo: reply.id, to: bob.id, token: owner.token, payload,
      deadline: Date.now() + 2000, ...over,
    })
    for (const junk of ['not json', '[]', '{}', JSON.stringify({ kind: 'deliver' }), JSON.stringify({ ...deliver(), extra: 1 }),
      JSON.stringify(deliver({ token: 'short' })), 'x'.repeat(200_000)]) await publish(owner.instanceId, junk)
    await publish(owner.instanceId, deliver({ token: randomBytes(16).toString('base64url') })) // wrong token
    await publish(owner.instanceId, deliver({ deadline: Date.now() - 1 })) // expired
    await publish(owner.instanceId, deliver({ deadline: Date.now() + 3_600_000 })) // implausible
    await sleep(400)
    expect(messagesIn(b.inbox)).toEqual([])
    // Each refused well-formed deliver is answered ok:false; junk is not answered.
    expect(reply.frames.filter(f => f.kind === 'ack').map(f => f.ok)).toEqual([false, false, false])

    // Replay: the same request id delivers once.
    const once = deliver()
    await publish(owner.instanceId, once)
    await publish(owner.instanceId, once)
    await sleep(300)
    expect(messagesIn(b.inbox)).toHaveLength(1)
  })

  it('trust model: whoever can write to Redis can forge a delivery (documented dependency, not a defence)', async () => {
    const p1 = await spawnServer()
    const bob = await party(p1.base)
    const b = await connect(bob)
    const owner = (await ownerOf(bob.id))!
    const forged = JSON.stringify({ type: 'MESSAGE', v: 1, id: newId(), from: 'not-a-real-sender', trade: 't', body: 'forged' })
    await publish(owner.instanceId, {
      kind: 'deliver', reqId: randomUUID(), replyTo: 'nobody', to: bob.id, token: owner.token, payload: forged, deadline: Date.now() + 2000,
    })
    // Redis is inside the relay's trust boundary, exactly as for auth:session:*
    // and auth:ws-ticket:*. This test pins that fact so it cannot be mistaken
    // for an authenticated channel.
    expect(await b.inbox.next(f => f.type === 'MESSAGE', 'forged MESSAGE')).toMatchObject({ from: 'not-a-real-sender' })
  })

  it('accepts an ACK only from the instance the request went to, and only for its request id', async () => {
    const p1 = await spawnServer({ RELAY_REMOTE_ACK_TIMEOUT_MS: '4000' })
    const alice = await party(p1.base)
    const bob = await party(p1.base)
    const tradeId = await trade(alice.id, bob.id)
    const a = await connect(alice)
    const fake = await fakeInstance()
    // Bob "lives" on the fake instance.
    await redis.set('relay:owner:' + bob.id, fake.id + '|' + fake.token, 'PX', 30_000)
    const out = envelope(bob.id, tradeId, 'via fake')
    send(a.ws, out)
    const deadline = Date.now() + 3000
    while (!fake.frames.some(f => f.kind === 'deliver') && Date.now() < deadline) await sleep(20)
    const request = fake.frames.find(f => f.kind === 'deliver')!
    expect(request).toMatchObject({ to: bob.id, token: fake.token })
    const replyTo = request.replyTo as string
    await publish(replyTo, { kind: 'ack', reqId: randomUUID(), from: fake.id, ok: true }) // unknown request
    await publish(replyTo, { kind: 'ack', reqId: request.reqId, from: 'someone-else', ok: true }) // wrong instance
    await publish(replyTo, { kind: 'ack', reqId: request.reqId, from: fake.id, ok: true, extra: 1 }) // malformed
    await sleep(300)
    expect(a.inbox.frames.filter(f => f.id === out.id)).toEqual([])
    await publish(replyTo, { kind: 'ack', reqId: request.reqId, from: fake.id, ok: true })
    expect(await ackFor(a.inbox, out.id)).toEqual({ type: 'SENT', id: out.id })
    cleanupKeys.add(`relay:msg:${alice.id}:${out.id}`)
  })

  it('bounds pending ACKs: past the limit a delivery is refused at once, not queued', async () => {
    const p1 = await spawnServer({ RELAY_MAX_PENDING_REMOTE: '1', RELAY_REMOTE_ACK_TIMEOUT_MS: '3000' })
    const [alice, carol, bob] = [await party(p1.base), await party(p1.base), await party(p1.base)]
    const [t1, t2] = [await trade(alice.id, bob.id), await trade(carol.id, bob.id)]
    const [a, c] = [await connect(alice), await connect(carol)]
    const fake = await fakeInstance() // never answers
    await redis.set('relay:owner:' + bob.id, fake.id + '|' + fake.token, 'PX', 30_000)
    const first = envelope(bob.id, t1, 'occupies the only slot')
    send(a.ws, first)
    while (!fake.frames.some(f => f.kind === 'deliver')) await sleep(20)
    const second = envelope(bob.id, t2, 'over the limit')
    const started = Date.now()
    send(c.ws, second)
    expect(await ackFor(c.inbox, second.id)).toEqual({ type: 'UNDELIVERED', id: second.id })
    expect(Date.now() - started).toBeLessThan(1500) // not waiting for the 3 s timeout
    expect(await ackFor(a.inbox, first.id)).toEqual({ type: 'UNDELIVERED', id: first.id }) // timed out
    cleanupKeys.add(`relay:msg:${alice.id}:${first.id}`)
  })

  // ── Delivery semantics ───────────────────────────────────────────────────

  it('ambiguous outcomes keep the id consumed (late ACK, no ACK); a NACK frees it', async () => {
    const p1 = await spawnServer({ RELAY_REMOTE_ACK_TIMEOUT_MS: '300' })
    const alice = await party(p1.base)
    const bob = await party(p1.base)
    const tradeId = await trade(alice.id, bob.id)
    const a = await connect(alice)
    const fake = await fakeInstance()
    await redis.set('relay:owner:' + bob.id, fake.id + '|' + fake.token, 'PX', 30_000)
    const deliverFor = async (id: string) => {
      const deadline = Date.now() + 3000
      for (;;) {
        const f = fake.frames.find(x => x.kind === 'deliver' && String(x.payload).includes(id))
        if (f) return f
        if (Date.now() > deadline) throw new Error('no deliver frame for ' + id)
        await sleep(10)
      }
    }

    // Late ACK: delivered (ok:true) only after the sender's timeout.
    const late = envelope(bob.id, tradeId, 'late')
    send(a.ws, late)
    const lateReq = await deliverFor(late.id)
    expect(await ackFor(a.inbox, late.id)).toEqual({ type: 'UNDELIVERED', id: late.id })
    await publish(lateReq.replyTo as string, { kind: 'ack', reqId: lateReq.reqId, from: fake.id, ok: true })
    await sleep(200)
    expect(a.inbox.frames.filter(f => f.id === late.id)).toHaveLength(1) // the late ACK changes nothing
    send(a.ws, late)
    expect(await a.inbox.next(f => f.id === late.id && f.type === 'REJECTED', 'retry after late ack'))
      .toEqual({ type: 'REJECTED', id: late.id, reason: 'DUPLICATE' })

    // No ACK at all: also ambiguous, also consumed.
    const silent = envelope(bob.id, tradeId, 'silent')
    send(a.ws, silent)
    await deliverFor(silent.id)
    expect(await ackFor(a.inbox, silent.id)).toEqual({ type: 'UNDELIVERED', id: silent.id })
    send(a.ws, silent)
    expect(await a.inbox.next(f => f.id === silent.id && f.type === 'REJECTED', 'retry after silence'))
      .toEqual({ type: 'REJECTED', id: silent.id, reason: 'DUPLICATE' })

    // NACK: definitely not delivered, so the same id may be retried.
    const nacked = envelope(bob.id, tradeId, 'nacked')
    send(a.ws, nacked)
    const nackReq = await deliverFor(nacked.id)
    await publish(nackReq.replyTo as string, { kind: 'ack', reqId: nackReq.reqId, from: fake.id, ok: false })
    expect(await ackFor(a.inbox, nacked.id)).toEqual({ type: 'UNDELIVERED', id: nacked.id })
    fake.frames.length = 0
    send(a.ws, nacked)
    await deliverFor(nacked.id) // the retry is attempted again, not refused as DUPLICATE
    for (const id of [late.id, silent.id, nacked.id]) cleanupKeys.add(`relay:msg:${alice.id}:${id}`)
  })

  // ── Privacy ──────────────────────────────────────────────────────────────

  it('answers unknown trade, non-party and offline identically; records latencies for review', async () => {
    const p1 = await spawnServer()
    const [alice, bob, carol, dave] = [await party(p1.base), await party(p1.base), await party(p1.base), await party(p1.base)]
    const tradeAB = await trade(alice.id, bob.id)
    const tradeAD = await trade(alice.id, dave.id)
    const [a, c] = [await connect(alice), await connect(carol)]
    await connect(bob) // Bob online, Dave offline
    const sample = async (ws: WebSocket, inbox: Inbox, to: string, tradeId: string) => {
      const out = envelope(to, tradeId, 'probe')
      const t0 = process.hrtime.bigint()
      send(ws, out)
      const ack = await ackFor(inbox, out.id)
      // Arrival time from the socket event, not from the polling loop.
      return { ack: { type: ack.type }, ms: Number(inbox.arrivedAt.get(ack)! - t0) / 1e6, id: out.id }
    }
    const cases: Array<[string, WebSocket, Inbox, string, string]> = [
      ['unknown trade', c.ws, c.inbox, bob.id, randomUUID()],
      ['non-party', c.ws, c.inbox, bob.id, tradeAB],
      ['offline counterparty', a.ws, a.inbox, dave.id, tradeAD],
    ]
    const report: Record<string, number> = {}
    for (const [name, ws, inbox, to, tradeId] of cases) {
      const runs = []
      for (let i = 0; i < 12; i++) runs.push(await sample(ws, inbox, to, tradeId))
      expect(new Set(runs.map(r => JSON.stringify(r.ack)))).toEqual(new Set([JSON.stringify({ type: 'UNDELIVERED' })]))
      const sorted = runs.map(r => r.ms).sort((x, y) => x - y)
      report[name] = sorted[Math.floor(sorted.length / 2)]
    }
    const online = []
    for (let i = 0; i < 12; i++) {
      const r = await sample(a.ws, a.inbox, bob.id, tradeAB)
      expect(r.ack).toEqual({ type: 'SENT' })
      online.push(r.ms)
      cleanupKeys.add(`relay:msg:${alice.id}:${r.id}`)
    }
    report['online counterparty (SENT)'] = online.sort((x, y) => x - y)[6]
    // Evidence for the report, not a timing assertion (CI timing is noisy).
    console.log('[#307 B.1] median ack latency ms: ' + JSON.stringify(report))
  })
})
