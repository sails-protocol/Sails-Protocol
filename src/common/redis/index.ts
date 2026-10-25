/**
 * Redis — cache/pub-sub client.
 * DATABASE.md §4 lists the key patterns this backs: trade:room:<id>,
 * users:online, offers:<asset>:<side>, reputation:<userId>,
 * escrow:state:<escrowId>. None of this is protocol-mandated — it's a
 * reference-implementation performance choice.
 */
import Redis from 'ioredis'
import { config } from '../../config'
import { childLogger } from '../logger'

const log = childLogger('redis')

// #307 B.3. Every command on this shared client is bounded (it also bounds
// commands queued while disconnected). A timeout rejects the caller only: the
// command may still run on Redis afterwards, so a timeout is never treated as
// "did not happen". autoResendUnfulfilledCommands is off: a command that was
// sent but not answered when the connection dropped is rejected, not re-sent
// on reconnect — INCR, ticket consumption, budget and message-id claims are
// not idempotent. Blocking reads (XREADGROUP BLOCK, BLPOP…) cannot run here:
// use a dedicated client without commandTimeout (RedisStreamsEventStore
// enforces this).
export const redis = new Redis(config.redis.url, {
  maxRetriesPerRequest: 3,
  retryStrategy: (attempts: number) => Math.min(attempts * 200, 2000),
  commandTimeout: config.redis.commandTimeoutMs,
  autoResendUnfulfilledCommands: false,
})

export { isRedisUnavailableError } from './unavailable'

redis.on('error', (err) => {
  log.error({ msg: 'Connection error', err: err.message })
})

export async function connectRedis(): Promise<void> {
  if (redis.status === 'ready') return
  await new Promise<void>((resolve, reject) => {
    redis.once('ready', () => resolve())
    redis.once('error', reject)
  })
  log.info({ msg: 'Connected' })
}
