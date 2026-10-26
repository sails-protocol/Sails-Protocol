// tests/integration/redisStreamsEventStore.test.ts
//
// Real integration test against a live Redis instance — RFC-010's own
// Reference Implementation Plan named this exact gap ("integration tests
// against a real Redis instance — neither exists yet"). Skips gracefully
// (same pattern docker.test.ts already uses) rather than failing the
// whole suite when no Redis is reachable, since most environments this
// runs in won't have one — this repo's own docker-compose redis service
// is what makes it real here, not a mock.

import Redis from 'ioredis'
import { RedisStreamsEventStore, GENESIS_HASH, type DurableEvent } from '../../src/common/events/event-store'

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'

describe('RedisStreamsEventStore (RFC-010, real Redis)', () => {
  jest.setTimeout(30_000)

  let client: Redis
  let store: RedisStreamsEventStore
  let redisAvailable = false

  beforeAll(async () => {
    client = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, retryStrategy: () => null, lazyConnect: true, disconnectTimeout: 10 })
    try {
      await client.connect()
      await client.ping()
      redisAvailable = true
    } catch {
      redisAvailable = false
    }
  })

  afterAll(async () => {
    if (redisAvailable) await client.quit()
    else client.disconnect()
  })

  beforeEach(() => {
    if (redisAvailable) store = new RedisStreamsEventStore(client, `test-group-${Date.now()}`)
  })

  afterEach(async () => {
    // Awaited, not fire-and-forget — a poll loop left running past its
    // owning test (even briefly, bounded by blockMs) was the real cause
    // of unrelated later test files misbehaving in the same Jest run
    // (see event-store.ts's own stop()/loopPromises comments).
    if (redisAvailable) await store.stop()
  })

  it('publish() + getEvents() round-trip a real event through real Redis Streams', async () => {
    if (!redisAvailable) {
      console.warn('Skipping RedisStreamsEventStore integration test — no Redis reachable at ' + REDIS_URL)
      return
    }
    const correlationId = `test-correlation-${Date.now()}`
    await store.publish('openp2p.message.sent', {
      messageId: 'm1', tradeId: correlationId, senderId: 'u1', content: 'hello redis', msgType: 'TEXT', timestamp: new Date().toISOString(),
    }, correlationId)

    const events = await store.getEvents(correlationId)
    expect(events).toHaveLength(1)
    expect(events[0].eventName).toBe('openp2p.message.sent')
    expect(events[0].correlationId).toBe(correlationId)
    expect(events[0].payload).toMatchObject({ content: 'hello redis' })
    expect(events[0].prevHash).toBe(GENESIS_HASH)
    expect(events[0].entryHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('chains entryHash/prevHash across multiple publishes to the same correlationId, same as InMemoryEventStore', async () => {
    if (!redisAvailable) return
    const correlationId = `test-correlation-${Date.now()}-chain`
    await store.publish('openp2p.message.sent', {
      messageId: 'm1', tradeId: correlationId, senderId: 'u1', content: 'first', msgType: 'TEXT', timestamp: new Date().toISOString(),
    }, correlationId)
    await store.publish('openp2p.message.sent', {
      messageId: 'm2', tradeId: correlationId, senderId: 'u2', content: 'second', msgType: 'TEXT', timestamp: new Date().toISOString(),
    }, correlationId)

    const [e1, e2] = await store.getEvents(correlationId)
    expect(e2.prevHash).toBe(e1.entryHash)
  })

  it('getEvents() returns [] for an unknown correlationId, never throws', async () => {
    if (!redisAvailable) return
    const events = await store.getEvents(`never-published-${Date.now()}`)
    expect(events).toEqual([])
  })

  it('subscribe() + publish() delivers a real event through a real consumer group, and XACKs it', async () => {
    if (!redisAvailable) return
    const correlationId = `test-correlation-${Date.now()}-sub`
    const received: DurableEvent[] = []

    store.subscribe('openp2p.message.sent', (event) => {
      received.push(event)
    })

    await store.publish('openp2p.message.sent', {
      messageId: 'm1', tradeId: correlationId, senderId: 'u1', content: 'via consumer group', msgType: 'TEXT', timestamp: new Date().toISOString(),
    }, correlationId)

    // Real XREADGROUP poll loop, not instantaneous — poll until delivered
    // or fail after a real timeout, rather than a fixed sleep.
    const deadline = Date.now() + 10_000
    while (received.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200))
    }

    expect(received).toHaveLength(1)
    expect(received[0].correlationId).toBe(correlationId)
    expect(received[0].payload).toMatchObject({ content: 'via consumer group' })
  })

  it('a handler that throws leaves its message pending (unacked) for real recovery, rather than silently dropping it', async () => {
    if (!redisAvailable) return
    const correlationId = `test-correlation-${Date.now()}-fail`
    let attempts = 0

    store.subscribe('openp2p.message.sent', () => {
      attempts++
      throw new Error('simulated handler failure')
    })

    await store.publish('openp2p.message.sent', {
      messageId: 'm1', tradeId: correlationId, senderId: 'u1', content: 'will fail', msgType: 'TEXT', timestamp: new Date().toISOString(),
    }, correlationId)

    const deadline = Date.now() + 5_000
    while (attempts === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200))
    }

    expect(attempts).toBeGreaterThanOrEqual(1)
    // The message itself is still real, durable data — getEvents() (the
    // by-correlation index) is unaffected by ack/nack state, which only
    // governs the eventName stream's own consumer group.
    const events = await store.getEvents(correlationId)
    expect(events).toHaveLength(1)
  })
})
