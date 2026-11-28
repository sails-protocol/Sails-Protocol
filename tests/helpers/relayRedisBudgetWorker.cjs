'use strict'
// Independent Node process: exercise the production Redis Lua budget against
// the same participant key as another worker, without shared JS state.
const Redis = require('ioredis')
const redis = new Redis(process.env.RELAY_REDIS_INTEGRATION_URL, { maxRetriesPerRequest: 1 })
process.on('message', async message => {
  if (message !== 'go') return
  try {
    const accepted = await redis.eval(
      process.env.RELAY_BUDGET_SCRIPT, 1, process.env.RELAY_BUDGET_KEY,
      10, Number(process.env.RELAY_BUDGET_MAX_MESSAGES || 100),
      Number(process.env.RELAY_BUDGET_MAX_BYTES || 100), 5000,
    )
    if (process.send) process.send({ accepted })
  } catch (error) {
    if (process.send) process.send({ error: String(error) })
  } finally {
    redis.disconnect()
  }
})
