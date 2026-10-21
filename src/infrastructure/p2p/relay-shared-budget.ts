/**
 * Cross-instance atomic relay ingress budget. Redis is the authority for
 * message count and aggregate raw bytes; no message contents are inspected.
 * Redis failures reject the frame (fail closed).
 */
import { redis } from '../../common/redis'
import { RELAY_FRAME_MAX_BYTES, RELAY_WINDOW_MAX_BYTES, RELAY_WINDOW_MAX_MESSAGES, RELAY_WINDOW_MS } from './relay-ingress-budget'

// One atomic script prevents a pair of concurrent sockets (or two app instances)
// from independently passing both limits. A single expiring hash per participant.
export const RELAY_BUDGET_SCRIPT = `
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

export async function consumeSharedRelayBudget(participantId: string, bytes: number): Promise<boolean> {
  if (!participantId || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > RELAY_FRAME_MAX_BYTES) return false
  const result = await redis.eval(
      RELAY_BUDGET_SCRIPT, 1, 'ratelimit:ws-relay:' + participantId,
      bytes, RELAY_WINDOW_MAX_MESSAGES, RELAY_WINDOW_MAX_BYTES, RELAY_WINDOW_MS,
    )
  return result === 1
}
