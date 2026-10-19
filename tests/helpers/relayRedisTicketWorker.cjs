'use strict'
const Redis = require('ioredis')
const SCRIPT = "local value = redis.call('GET', KEYS[1]); if not value then return nil end; redis.call('DEL', KEYS[1]); return value"
const redis = new Redis(process.env.RELAY_REDIS_INTEGRATION_URL, { maxRetriesPerRequest: 1 })
process.once('message', async () => {
  try {
    const result = await redis.eval(SCRIPT, 1, process.env.RELAY_TICKET_KEY)
    if (process.send) process.send(result ? 'claimed' : 'rejected')
  } catch (error) {
    if (process.send) process.send('error: ' + String(error))
  } finally {
    await redis.quit().catch(() => redis.disconnect())
  }
})
