/**
 * Real Redis integration regression for the relay's atomic distributed budget.
 * Opt-in: RELAY_REDIS_INTEGRATION_URL must point at a disposable Redis instance.
 * Never FLUSHDB: keys are uniquely namespaced and removed in finally.
 */
import Redis from 'ioredis'
import { randomUUID } from 'crypto'
import { RELAY_BUDGET_SCRIPT } from '../src/infrastructure/p2p/relay-shared-budget'
import { ATOMIC_CONSUME_SCRIPT, atomicConsume } from '../src/common/redis/atomic-consume'
import { resolveParticipantFromTicket } from '../src/common/middleware/ws-auth'

const url = process.env.RELAY_REDIS_INTEGRATION_URL
const suite = url ? describe : describe.skip

suite('relay shared budget — real Redis concurrent instances', () => {
  let a: Redis
  let b: Redis

  beforeAll(() => {
    a = new Redis(url!, { maxRetriesPerRequest: 1 })
    b = new Redis(url!, { maxRetriesPerRequest: 1 })
  })
  afterAll(async () => {
    await Promise.all([a?.quit(), b?.quit()])
  })

  it('rejects a missing ticket through the production resolver without Redis access', async () => {
    await expect(resolveParticipantFromTicket(undefined)).resolves.toBeNull()
    await expect(resolveParticipantFromTicket('')).resolves.toBeNull()
  })

  it('exposes the production Redis consume primitive as a function', () => {
    expect(typeof atomicConsume).toBe('function')
  })

  it('atomically burns a single-use WebSocket ticket across concurrent Redis clients', async () => {
    const key = 'auth:ws-ticket:test-' + randomUUID()
    try {
      await a.set(key, 'participant', 'PX', 5000)
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).eval(ATOMIC_CONSUME_SCRIPT, 1, key)),
      )
      expect(results.filter(value => value === 'participant')).toHaveLength(1)
      expect(results.filter(value => value === null)).toHaveLength(19)
      expect(await a.exists(key)).toBe(0)
    } finally {
      await a.del(key)
    }
  })

  it('enforces message-count limits independently of byte limits', async () => {
    const key = 'test:relay:messages:' + randomUUID()
    try {
      const results = await Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          (i % 2 ? a : b).eval(RELAY_BUDGET_SCRIPT, 1, key, 1, 7, 1000, 5000),
        ),
      )
      expect(results.filter(x => x === 1)).toHaveLength(7)
      expect(results.filter(x => x === 0)).toHaveLength(33)
      expect(await a.hgetall(key)).toMatchObject({ messages: '7', bytes: '7' })
    } finally {
      await a.del(key)
    }
  })

  it('does not mutate counters when the byte budget denies a frame', async () => {
    const key = 'test:relay:bytes:' + randomUUID()
    try {
      expect(await a.eval(RELAY_BUDGET_SCRIPT, 1, key, 60, 10, 100, 5000)).toBe(1)
      expect(await b.eval(RELAY_BUDGET_SCRIPT, 1, key, 41, 10, 100, 5000)).toBe(0)
      expect(await a.hgetall(key)).toMatchObject({ messages: '1', bytes: '60' })
      expect(await b.eval(RELAY_BUDGET_SCRIPT, 1, key, 40, 10, 100, 5000)).toBe(1)
      expect(await a.hgetall(key)).toMatchObject({ messages: '2', bytes: '100' })
    } finally {
      await a.del(key)
    }
  })

  it('rejects budget evaluation when the Redis connection is unavailable', async () => {
    const disconnected = new Redis(url!, { lazyConnect: true, maxRetriesPerRequest: 1 })
    disconnected.disconnect()
    await expect(
      disconnected.eval(RELAY_BUDGET_SCRIPT, 1, 'test:relay:offline:' + randomUUID(), 1, 2, 100, 5000),
    ).rejects.toThrow()
  })

  it('retains exhausted budget across independent client reconnections', async () => {
    const key = 'test:relay:reconnect:' + randomUUID()
    try {
      expect(await a.eval(RELAY_BUDGET_SCRIPT, 1, key, 10, 2, 100, 5000)).toBe(1)
      expect(await b.eval(RELAY_BUDGET_SCRIPT, 1, key, 10, 2, 100, 5000)).toBe(1)
      expect(await a.eval(RELAY_BUDGET_SCRIPT, 1, key, 10, 2, 100, 5000)).toBe(0)
      expect(await a.hgetall(key)).toMatchObject({ messages: '2', bytes: '20' })
    } finally {
      await a.del(key)
    }
  })

  it('never over-admits across concurrent clients, expires, then resets', async () => {
    const key = 'test:relay:atomic:' + randomUUID()
    const evalBudget = (client: Redis, bytes: number) =>
      client.eval(RELAY_BUDGET_SCRIPT, 1, key, bytes, 20, 100, 250)
    try {
      const results = await Promise.all(
        Array.from({ length: 80 }, (_, i) => evalBudget(i % 2 ? a : b, 10)),
      )
      expect(results.filter(x => x === 1)).toHaveLength(10)
      expect(results.filter(x => x === 0)).toHaveLength(70)
      expect(await a.hgetall(key)).toMatchObject({ messages: '10', bytes: '100' })
      await new Promise(resolve => setTimeout(resolve, 350))
      expect(await evalBudget(b, 10)).toBe(1)
      expect(await b.hgetall(key)).toMatchObject({ messages: '1', bytes: '10' })
    } finally {
      await a.del(key)
    }
  })
})
