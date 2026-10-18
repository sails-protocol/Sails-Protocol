/**
 * Real Redis integration regression for the relay's atomic distributed budget.
 * Opt-in: RELAY_REDIS_INTEGRATION_URL must point at a disposable Redis instance.
 * Never FLUSHDB: keys are uniquely namespaced and removed in finally.
 */
import Redis from 'ioredis'
import { randomUUID } from 'crypto'
import { RELAY_BUDGET_SCRIPT } from '../src/infrastructure/p2p/relay-shared-budget'

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
