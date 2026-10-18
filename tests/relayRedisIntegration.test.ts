/**
 * Real Redis integration regression for the relay's atomic distributed budget.
 * Opt-in: RELAY_REDIS_INTEGRATION_URL must point at a disposable Redis instance.
 * Never FLUSHDB: keys are uniquely namespaced and removed in finally.
 */
import Redis from 'ioredis'
import { randomUUID } from 'crypto'

const url = process.env.RELAY_REDIS_INTEGRATION_URL
const suite = url ? describe : describe.skip

suite('relay shared budget — real Redis concurrent instances', () => {
  let a: Redis
  let b: Redis

  const SCRIPT = `
local key = KEYS[1]
local bytes = tonumber(ARGV[1])
local maxMessages = tonumber(ARGV[2])
local maxBytes = tonumber(ARGV[3])
local windowMs = tonumber(ARGV[4])
local count = tonumber(redis.call('HGET', key, 'messages') or '0')
local used = tonumber(redis.call('HGET', key, 'bytes') or '0')
if count >= maxMessages or used + bytes > maxBytes then return 0 end
redis.call('HINCRBY', key, 'messages', 1)
redis.call('HINCRBY', key, 'bytes', bytes)
if redis.call('PTTL', key) < 0 then redis.call('PEXPIRE', key, windowMs) end
return 1
`

  beforeAll(() => {
    a = new Redis(url!, { maxRetriesPerRequest: 1 })
    b = new Redis(url!, { maxRetriesPerRequest: 1 })
  })
  afterAll(async () => {
    await Promise.all([a?.quit(), b?.quit()])
  })

  it('never over-admits across concurrent clients, expires, then resets', async () => {
    const key = 'test:relay:atomic:' + randomUUID()
    const evalBudget = (client: Redis, bytes: number) =>
      client.eval(SCRIPT, 1, key, bytes, 20, 100, 250)
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
