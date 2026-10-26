// tests/integration/redisGate2Adversarial.test.ts
//
// Redis Gate 2, adversarial tests against a REAL Redis (REDIS_URL, default redis://localhost:6379; skipped when unreachable).
//   A. deploy/redis/sails-acl.conf, applied to throwaway users: what each role can and cannot run.
//   B. The authenticated origin envelope on the cross-instance channel (PostgresEventStore.enableCrossInstanceFanout) and on Redis
//      Streams (RedisStreamsEventStore): forged, tampered, replayed, stale and unknown-key messages are dropped; rotation works.
//   C. Redelivery and fencing: an entry processed twice (a slow owner and its reclaimer) has ONE effect when the handler is idempotent;
//      the transport is at-least-once and the test shows what a non-idempotent handler would suffer.
// None of this declares Redis Gate 2 GO. A producer that holds the envelope key can still sign what it likes (see envelope-auth.ts).

import Redis from 'ioredis'
import { readFileSync } from 'fs'
import { join } from 'path'
import { PostgresEventStore, RedisStreamsEventStore, type DurableEvent } from '../../src/common/events/event-store'
import { signEnvelope, type EnvelopeKeyring } from '../../src/common/events/envelope-auth'

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await cond()) return; await sleep(25) }
  throw new Error('timed out waiting for condition')
}
const ring = (kids: Array<[string, string]>, active?: string): EnvelopeKeyring => ({ activeKid: active ?? kids[0][0], keys: new Map(kids.map(([k, v]) => [k, Buffer.from(v, 'hex')])) })
const secret = (c: string) => c.repeat(64)
const CHANNEL = 'sails:cross-instance-events'

describe('Redis Gate 2: ACL profile, authenticated envelope, redelivery (real Redis)', () => {
  jest.setTimeout(180_000)

  let admin: Redis
  let available = false
  const sfx = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const clients: Redis[] = []
  const stores: Array<{ stop?: () => Promise<void>; disableCrossInstanceFanout?: () => Promise<void> }> = []
  const users: string[] = []
  const passwords: Record<string, string> = {}
  const mk = (opts: Record<string, unknown> = {}) => {
    const c = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, retryStrategy: () => null, lazyConnect: true, connectTimeout: 5000, disconnectTimeout: 10, ...opts })
    clients.push(c); return c
  }
  const asRole = (role: 'sails-producer' | 'sails-consumer' | 'sails-ops') => mk({ username: `${role}-${sfx}`, password: passwords[role], enableReadyCheck: false })
  const stream = (n: string) => `sails:events:t${sfx}-${n}`

  beforeAll(async () => {
    admin = mk()
    try { await admin.connect(); await admin.ping(); available = true } catch { available = false; return }
    // Apply the committed ACL profile to throwaway users (never touches `default`, never turns anything off on a shared server).
    const conf = readFileSync(join(__dirname, '..', '..', 'deploy', 'redis', 'sails-acl.conf'), 'utf8')
    for (const line of conf.split(/\r?\n/)) {
      const m = /^user\s+(\S+)\s+(.*)$/.exec(line.trim())
      if (!m || m[1] === 'default') continue
      const pw = `pw-${sfx}-${m[1]}`; passwords[m[1]] = pw
      const rules = (m[2].replace('>CHANGE_ME', `>${pw}`).match(/\([^)]*\)|\S+/g) ?? [])
      const name = `${m[1]}-${sfx}`
      await admin.call('ACL', 'SETUSER', name, 'reset', ...rules)
      users.push(name)
    }
  })

  afterEach(async () => {
    while (stores.length) { const s = stores.pop()!; await s.stop?.().catch(() => undefined); await s.disableCrossInstanceFanout?.().catch(() => undefined) }
  })

  afterAll(async () => {
    if (available) {
      for (const u of users) await admin.call('ACL', 'DELUSER', u).catch(() => undefined)
      const keys = await admin.keys(`sails:*t${sfx}*`); if (keys.length) await admin.del(...keys)
    }
    for (const c of clients) { if (available) await c.quit().catch(() => c.disconnect()); else c.disconnect() }
  })

  const denied = async (p: Promise<unknown>) => { try { await p; return 'ALLOWED' } catch (e: any) { return /NOPERM|NOAUTH|WRONGPASS/.test(String(e?.message)) ? 'DENIED' : `ERROR:${e?.message}` } }

  // ───────────────────────────────────────── A. ACL profile ─────────────────────────────────────────
  it('A1 producer: may XADD/XREVRANGE/PUBLISH; may NOT read groups, ACK, CLAIM, create groups, subscribe, touch other keys or administer', async () => {
    if (!available) return
    const p = asRole('sails-producer'); await p.connect()
    const s = stream('prod')
    expect(await denied(p.xadd(s, '*', 'data', '{}'))).toBe('ALLOWED')
    expect(await denied(p.xrevrange(s, '+', '-', 'COUNT', 1))).toBe('ALLOWED')
    expect(await denied(p.publish(CHANNEL, 'x'))).toBe('ALLOWED')
    const id = (await admin.xadd(s, '*', 'data', 'y')) as string
    await admin.xgroup('CREATE', s, 'g', '0')
    for (const [what, call] of [
      ['XGROUP CREATE', () => p.xgroup('CREATE', s, 'g2', '0')], ['XREADGROUP', () => p.xreadgroup('GROUP', 'g', 'c', 'STREAMS', s, '>')],
      ['XACK', () => p.xack(s, 'g', id)], ['XCLAIM', () => p.xclaim(s, 'g', 'c', 0, id)], ['XPENDING', () => p.xpending(s, 'g')],
      ['SUBSCRIBE', () => p.subscribe(CHANNEL)], ['PUBLISH other channel', () => p.publish('other:channel', 'x')],
      ['SET outside the key space', () => p.set(`foo-${sfx}`, '1')], ['XADD outside the key space', () => p.xadd(`foo-${sfx}`, '*', 'a', 'b')],
      ['KEYS', () => p.keys('*')], ['FLUSHALL', () => p.flushall()], ['CONFIG GET', () => p.config('GET', '*')], ['ACL LIST', () => p.call('ACL', 'LIST')], ['EVAL', () => p.eval('return 1', 0)],
    ] as Array<[string, () => Promise<unknown>]>) {
      expect({ what, verdict: await denied(call()) }).toEqual({ what, verdict: 'DENIED' })
    }
  })

  it('A2 consumer: may read the group, ACK, CLAIM, check pending and run the ownership script; may NOT write events, publish, SET outside the nonce keys or administer', async () => {
    if (!available) return
    const c = asRole('sails-consumer'); await c.connect()
    const s = stream('cons')
    await admin.xadd(s, '*', 'data', 'z')
    expect(await denied(c.xgroup('CREATE', s, 'g', '0'))).toBe('ALLOWED')
    expect(await denied(c.xreadgroup('GROUP', 'g', 'c1', 'STREAMS', s, '>'))).toBe('ALLOWED')
    const pend = (await c.xpending(s, 'g', '-', '+', 10)) as Array<[string]>
    expect(pend).toHaveLength(1)
    expect(await denied(c.xclaim(s, 'g', 'c2', 0, pend[0][0]))).toBe('ALLOWED')
    expect(Number(await c.eval(`local o = redis.call('XPENDING', KEYS[1], ARGV[1], ARGV[2], ARGV[2], 1, ARGV[3]) if #o == 1 then return redis.call('XACK', KEYS[1], ARGV[1], ARGV[2]) end return 0`, 1, s, 'g', pend[0][0], 'c2'))).toBe(1)
    expect(await denied(c.set(`sails:envelope:nonce:t${sfx}`, 'e1', 'EX', 60, 'NX'))).toBe('ALLOWED')
    expect(await denied(c.get(`sails:envelope:nonce:t${sfx}`))).toBe('ALLOWED')
    for (const [what, call] of [
      ['XADD', () => c.xadd(s, '*', 'data', 'forged')], ['PUBLISH', () => c.publish(CHANNEL, 'x')],
      ['SET a key that would shadow a stream', () => c.set(`sails:events:shadow-${sfx}`, '1')], ['SET outside the key space', () => c.set(`foo-${sfx}`, '1')],
      ['KEYS', () => c.keys('*')], ['FLUSHALL', () => c.flushall()], ['CONFIG GET', () => c.config('GET', '*')], ['ACL SETUSER', () => c.call('ACL', 'SETUSER', 'x', 'on')],
      ['XGROUP DESTROY', () => c.xgroup('DESTROY', s, 'g')], ['DEL', () => c.del(s)],
    ] as Array<[string, () => Promise<unknown>]>) {
      expect({ what, verdict: await denied(call()) }).toEqual({ what, verdict: 'DENIED' })
    }
  })

  it('A3 ops: reads streams and server info; may NOT write, ACK or administer', async () => {
    if (!available) return
    const o = asRole('sails-ops'); await o.connect()
    const s = stream('ops'); await admin.xadd(s, '*', 'data', 'a')
    expect(await denied(o.xlen(s))).toBe('ALLOWED')
    expect(await denied(o.xrange(s, '-', '+'))).toBe('ALLOWED')
    expect(await denied(o.info())).toBe('ALLOWED')
    for (const [what, call] of [['XADD', () => o.xadd(s, '*', 'a', 'b')], ['DEL', () => o.del(s)], ['PUBLISH', () => o.publish(CHANNEL, 'x')], ['FLUSHALL', () => o.flushall()], ['ACL LIST', () => o.call('ACL', 'LIST')]] as Array<[string, () => Promise<unknown>]>) {
      expect({ what, verdict: await denied(call()) }).toEqual({ what, verdict: 'DENIED' })
    }
  })

  it('A4 a wrong password is refused, and the committed profile switches the default user off', async () => {
    if (!available) return
    const bad = mk({ username: `sails-producer-${sfx}`, password: 'nope', enableReadyCheck: false })
    const errors: string[] = []; bad.on('error', (e: Error) => errors.push(e.message)) // ioredis reports a failed AUTH as an error event
    await bad.connect().then(() => bad.ping()).catch(() => undefined)
    expect(errors.join(' ')).toMatch(/WRONGPASS/)
    expect(readFileSync(join(__dirname, '..', '..', 'deploy', 'redis', 'sails-acl.conf'), 'utf8')).toMatch(/^user default off$/m)
  })

  // ───────────────────────────── B1. envelope on the cross-instance channel ─────────────────────────────
  const fakeDb = () => ({ $transaction: async (cb: (tx: unknown) => unknown) => cb({ $executeRaw: async () => 0, durableEventRecord: { findFirst: async () => null, create: async () => ({}) } }) }) as never
  const payload = (tradeId: string) => ({ messageId: 'm1', tradeId, senderId: 'u1', content: 'hello', msgType: 'TEXT', timestamp: new Date().toISOString() }) as never

  async function channelPair(keyring: EnvelopeKeyring | null, receiverKeyring: EnvelopeKeyring | null = keyring) {
    const producerA = asRole('sails-producer'); const consumerA = asRole('sails-consumer'); const consumerB = asRole('sails-consumer')
    await Promise.all([producerA.connect(), consumerA.connect(), consumerB.connect()])
    const sender = new PostgresEventStore(fakeDb()); const receiver = new PostgresEventStore(fakeDb())
    sender.enableCrossInstanceFanout(producerA, { keyring, subscriberClient: consumerA })
    receiver.enableCrossInstanceFanout(producerA, { keyring: receiverKeyring, subscriberClient: consumerB })
    stores.push(sender, receiver)
    const received: DurableEvent[] = []
    receiver.subscribe('openp2p.message.sent', (e) => { received.push(e) })
    const capture = mk({ enableReadyCheck: false }); await capture.connect(); await capture.subscribe(CHANNEL)
    const captured: string[] = []; capture.on('message', (_c: string, m: string) => captured.push(m))
    await sleep(300) // both subscriptions are in place
    return { sender, receiver, received, captured, injector: admin }
  }

  it('B1 channel, legitimate: a signed event crosses instances under least-privilege roles and is delivered once', async () => {
    if (!available) return
    const k = ring([['k1', secret('a')]])
    const t = await channelPair(k)
    await t.sender.publish('openp2p.message.sent', payload('c-legit'), 'c-legit')
    await until(() => t.received.length === 1)
    await sleep(300)
    expect(t.received).toHaveLength(1)
    expect(t.receiver.rejectedEnvelopes).toEqual({})
  })

  it('B1 channel, adversarial: forged, tampered, replayed, stale and unknown-key messages are dropped (RED without a keyring, GREEN with one)', async () => {
    if (!available) return
    const k = ring([['k1', secret('a')]])
    const guarded = await channelPair(k)
    const open = await channelPair(null) // the historical, unauthenticated channel, for the RED side
    await guarded.sender.publish('openp2p.message.sent', payload('c-1'), 'c-1')
    await until(() => guarded.captured.length >= 1 && guarded.received.length === 1 && open.received.length >= 0)
    const legit = JSON.parse(guarded.captured[0]) as Record<string, any>
    const victim = legit.__originInstanceId as string
    const { __originInstanceId, __env, ...event } = legit

    const attacks: Array<[string, Record<string, unknown> | string, string]> = [
      ['forged event with the victim\'s origin id and no envelope', { ...event, eventId: 'forged-1', payload: { evil: true }, __originInstanceId: victim }, 'MALFORMED'],
      ['tampered payload under a valid envelope', { ...event, payload: { ...event.payload, content: 'EVIL' }, __originInstanceId: victim, __env }, 'BAD_MAC'],
      ['valid envelope moved to another origin id', { ...event, __originInstanceId: 'someone-else', __env }, 'BAD_MAC'],
      ['unknown key id', { ...event, __originInstanceId: victim, __env: { ...__env, kid: 'k-unknown' } }, 'UNKNOWN_KID'],
      ['signed with the right kid but a key the attacker invented', { ...event, __originInstanceId: victim, __env: signEnvelope(ring([['k1', secret('e')]]), 'xinstance', victim, event) }, 'BAD_MAC'],
      ['stale (signed ten minutes ago, e.g. a captured message replayed later)', { ...event, __originInstanceId: victim, __env: signEnvelope(k, 'xinstance', victim, event, Date.now() - 10 * 60_000) }, 'STALE'],
      ['replay of the captured legitimate message', legit, 'REPLAY'],
    ]
    for (const [, msg] of attacks) await admin.publish(CHANNEL, typeof msg === 'string' ? msg : JSON.stringify(msg))
    await until(() => Object.values(guarded.receiver.rejectedEnvelopes).reduce((a, b) => a + b, 0) >= attacks.length)
    // GREEN: nothing but the one legitimate event reached the guarded receiver; every attack was counted under its own reason.
    expect(guarded.received).toHaveLength(1)
    const expected: Record<string, number> = {}; for (const [, , r] of attacks) expected[r] = (expected[r] ?? 0) + 1
    expect(guarded.receiver.rejectedEnvelopes).toEqual(expected)
    // RED: the same forged message (no envelope, victim's origin id) IS delivered by an unauthenticated receiver.
    await until(() => open.received.some((e) => e.eventId === 'forged-1'))
    expect(open.received.some((e) => e.eventId === 'forged-1')).toBe(true)
  })

  it('B1 channel, rotation: a receiver holding old and new keys accepts both; one holding only the new key refuses the old', async () => {
    if (!available) return
    const oldRing = ring([['old', secret('1')]]); const both = ring([['old', secret('1')], ['new', secret('2')]], 'new'); const onlyNew = ring([['new', secret('2')]])
    const t1 = await channelPair(oldRing, both)
    await t1.sender.publish('openp2p.message.sent', payload('c-rot-1'), 'c-rot-1')
    await until(() => t1.received.length === 1)
    const t2 = await channelPair(oldRing, onlyNew)
    await t2.sender.publish('openp2p.message.sent', payload('c-rot-2'), 'c-rot-2')
    await until(() => (t2.receiver.rejectedEnvelopes.UNKNOWN_KID ?? 0) >= 1)
    expect(t2.received).toHaveLength(0)
  })

  it('B1 fail-closed: EVENT_ENVELOPE_REQUIRED=1 without keys refuses to enable the channel, and a malformed key list throws', async () => {
    if (!available) return
    const store = new PostgresEventStore(fakeDb()); const c = asRole('sails-producer'); await c.connect()
    const saved = { r: process.env.EVENT_ENVELOPE_REQUIRED, k: process.env.EVENT_ENVELOPE_KEYS }
    try {
      process.env.EVENT_ENVELOPE_REQUIRED = '1'; delete process.env.EVENT_ENVELOPE_KEYS
      expect(() => store.enableCrossInstanceFanout(c, { subscriberClient: c })).toThrow(/EVENT_ENVELOPE_REQUIRED/)
      process.env.EVENT_ENVELOPE_KEYS = 'k1:not-hex'
      expect(() => store.enableCrossInstanceFanout(c, { subscriberClient: c })).toThrow(/EVENT_ENVELOPE_KEYS/)
    } finally { for (const [n, v] of [['EVENT_ENVELOPE_REQUIRED', saved.r], ['EVENT_ENVELOPE_KEYS', saved.k]] as const) { if (v === undefined) delete process.env[n]; else process.env[n] = v } }
  })

  // ───────────────────────────────── B2. envelope on Redis Streams ─────────────────────────────────
  async function streamStore(keyring: EnvelopeKeyring | null, name: string, idleMs = 60_000) {
    const group = `g-${sfx}-${name}`
    const producer = asRole('sails-producer'); const consumer = asRole('sails-consumer')
    await Promise.all([producer.connect(), consumer.connect()])
    const store = new RedisStreamsEventStore(consumer, group, idleMs, 100, { keyring, producerClient: producer })
    stores.push(store)
    return { store, group, consumer, producer }
  }
  const evStream = 'sails:events:openp2p.message.sent'
  const hasEntry = async (id: string) => (await admin.xrange(evStream, id, id)).length === 1

  it('B2 streams: a signed entry written by the producer role is consumed by the consumer role; forged, tampered and replayed entries run no handler', async () => {
    if (!available) return
    const k = ring([['k1', secret('a')]])
    const { store, group } = await streamStore(k, 'sig')
    const seen: string[] = []
    store.subscribe('openp2p.message.sent', (e) => { seen.push(e.eventId) })
    await sleep(300)
    const corr = `c-sig-${sfx}`
    await store.publish('openp2p.message.sent', payload(corr), corr)
    await until(() => seen.length === 1)
    const stored = (await admin.xrange(`sails:events:by-correlation:${corr}`, '-', '+'))[0][1]
    const f = (n: string) => stored[stored.indexOf(n) + 1]
    const data = JSON.parse(f('data'))
    const attacks: Array<[string, string[]]> = [
      ['unsigned forged entry', ['data', JSON.stringify({ ...data, eventId: 'forged-s1', payload: { evil: 1 } })]],
      ['tampered payload under a valid envelope', ['data', JSON.stringify({ ...data, eventId: 'forged-s2', payload: { ...data.payload, content: 'EVIL' } }), 'origin', f('origin'), 'env', f('env')]],
      ['a captured entry copied verbatim (replay)', ['data', f('data'), 'origin', f('origin'), 'env', f('env')]],
      ['garbage data', ['data', '{not json']],
    ]
    for (const [, fields] of attacks) await admin.xadd(evStream, '*', ...fields)
    await until(() => Object.values(store.rejectedEntries).reduce((a, b) => a + b, 0) >= attacks.length)
    expect(seen).toEqual([expect.any(String)]) // only the legitimate event ever reached a handler
    expect(store.rejectedEntries).toEqual({ MALFORMED: 2, BAD_MAC: 1, REPLAY: 1 })
    await until(async () => ((await admin.xpending(evStream, group)) as [number])[0] === 0) // the rejected ones are acknowledged, not left pending
    // history: the forged copies live in the event stream only; the correlation stream still holds the one genuine entry
    expect((await store.getEvents(corr)).map((e) => e.eventId)).toEqual([data.eventId])
  })

  it('B2 streams, RED side: an unauthenticated store runs a handler for a forged entry', async () => {
    if (!available) return
    const { store } = await streamStore(null, 'open')
    const seen: string[] = []
    store.subscribe('openp2p.message.sent', (e) => { seen.push(e.eventId) })
    await sleep(300)
    await admin.xadd(evStream, '*', 'data', JSON.stringify({ eventId: 'forged-open', eventName: 'openp2p.message.sent', correlationId: 'x', payload: {}, publishedAt: new Date().toISOString(), entryHash: 'h', prevHash: 'p' }))
    await until(() => seen.includes('forged-open'))
    expect(seen).toContain('forged-open')
  })

  // ───────────────────────────── C. redelivery, idempotency, fencing ─────────────────────────────
  it('C a slow owner and its reclaimer both run the handler (at-least-once); an idempotent handler has ONE effect, a non-idempotent one has two; the stale ACK is refused', async () => {
    if (!available) return
    const k = ring([['k1', secret('a')]])
    const group = `g-${sfx}-fence`
    const mkStore = async (idle: number) => {
      const producer = asRole('sails-producer'); const consumer = asRole('sails-consumer'); await Promise.all([producer.connect(), consumer.connect()])
      const s = new RedisStreamsEventStore(consumer, group, idle, 100, { keyring: k, producerClient: producer }); stores.push(s); return s
    }
    const slow = await mkStore(60_000); const reclaimer = await mkStore(400)
    const effectsIdempotent = new Set<string>(); let effectsNaive = 0
    let releaseSlow!: () => void; const slowGate = new Promise<void>((r) => { releaseSlow = r })
    const started: string[] = []
    const handler = (who: string, gate?: Promise<void>) => async (e: DurableEvent<any>) => {
      started.push(who)
      if (gate) await gate
      effectsNaive += 1
      effectsIdempotent.add(e.eventId) // the idempotency key is the event id
    }
    slow.subscribe('openp2p.message.sent', handler('slow', slowGate))
    await sleep(300)
    const corr = `c-fence-${sfx}`
    await slow.publish('openp2p.message.sent', payload(corr), corr)
    await until(() => started.includes('slow'))
    reclaimer.subscribe('openp2p.message.sent', handler('reclaimer'))
    await until(() => started.includes('reclaimer'))
    releaseSlow() // the stale owner finishes AFTER the reclaimer took the entry
    await until(() => effectsNaive === 2)
    await sleep(500)
    expect(started.sort()).toEqual(['reclaimer', 'slow'])
    expect(effectsNaive).toBe(2) // at-least-once: a handler without an idempotency key would have applied its effect twice
    expect(effectsIdempotent.size).toBe(1) // keyed by event id: one effect
    expect(((await admin.xpending(evStream, group)) as [number])[0]).toBe(0) // the reclaimer acknowledged; the slow owner's late ACK did not break that
  })
})
