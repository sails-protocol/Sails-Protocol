/**
 * Redis-backed relay presence lease primitives.
 *
 * These are NOT a delivery backplane. Presence is only a hint: a separate
 * instance must still acknowledge an actual socket send before the caller
 * may report success. Never use this key to infer delivery.
 *
 * An unpredictable per-connection token is required so a stale disconnect
 * cannot delete a replacement connection's lease.
 */
import { redis } from '../../common/redis'

export const RELAY_PRESENCE_TTL_MS = 30_000

export const RELAY_PRESENCE_CLAIM_SCRIPT = `
local now = redis.call('TIME')
local nowMs = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
local deadlineMs = tonumber(ARGV[3])
if not deadlineMs or nowMs > deadlineMs then
  return 0
end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
return 1
`

export const RELAY_PRESENCE_RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`

export const RELAY_PRESENCE_RENEW_SCRIPT = `
local now = redis.call('TIME')
local nowMs = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
local deadlineMs = tonumber(ARGV[3])
if not deadlineMs or nowMs > deadlineMs then
  return 0
end
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`

function presenceKey(participantId: string): string {
  if (!participantId) throw new Error('Relay presence requires participant ID')
  return 'ws-relay:presence:' + participantId
}

function validateLeaseToken(token: string): void {
  if (!token || token.length > 256) throw new Error('Invalid relay presence token')
}

/** Register the most recently authenticated connection as a routing hint. */
export async function claimRelayPresence(participantId: string, token: string, deadlineMs = Date.now() + 5000): Promise<void> {
  validateLeaseToken(token)
  // Redis checks its own clock before writing: a command delayed in the queue
  // past the caller's deadline must never resurrect a timed-out connection.
  const claimed = await redis.eval(RELAY_PRESENCE_CLAIM_SCRIPT, 1,
    presenceKey(participantId), token, RELAY_PRESENCE_TTL_MS, deadlineMs)
  if (claimed !== 1) throw new Error('Relay presence claim expired')
}

/** Only the current connection may extend its lease. */
export async function renewRelayPresence(participantId: string, token: string, deadlineMs = Date.now() + 5000): Promise<boolean> {
  validateLeaseToken(token)
  return await redis.eval(RELAY_PRESENCE_RENEW_SCRIPT, 1,
    presenceKey(participantId), token, RELAY_PRESENCE_TTL_MS, deadlineMs) === 1
}

/** A delayed close from an old connection must not evict a newer owner. */
export async function releaseRelayPresence(participantId: string, token: string): Promise<boolean> {
  validateLeaseToken(token)
  return await redis.eval(RELAY_PRESENCE_RELEASE_SCRIPT, 1,
    presenceKey(participantId), token) === 1
}

/** A null result is normal after expiry; Redis failures propagate (fail closed). */
export async function lookupRelayPresence(participantId: string): Promise<string | null> {
  return redis.get(presenceKey(participantId))
}

/**
 * Read a routing lease with its remaining TTL in one Redis operation.
 * This is still only a hint, never proof of remote socket delivery.
 * The Lua script avoids pairing a token from one lease with the TTL of
 * a replacement lease read in a separate round trip.
 */
export const RELAY_PRESENCE_SNAPSHOT_SCRIPT = `
local token = redis.call('GET', KEYS[1])
if not token then return { false, -2 } end
local ttl = redis.call('PTTL', KEYS[1])
if ttl <= 0 then return { false, ttl } end
return { token, ttl }
`

export async function snapshotRelayPresence(participantId: string): Promise<{ token: string; ttlMs: number } | null> {
  const result = await redis.eval(RELAY_PRESENCE_SNAPSHOT_SCRIPT, 1, presenceKey(participantId))
  if (!Array.isArray(result) || result.length !== 2) throw new Error('Invalid relay presence snapshot')
  const [token, ttlMs] = result
  if (token === null || token === false) {
    if (typeof ttlMs !== 'number' || !Number.isSafeInteger(ttlMs) || ttlMs > 0) {
      throw new Error('Invalid relay presence snapshot')
    }
    return null
  }
  if (typeof token !== 'string' || token.length === 0 || typeof ttlMs !== 'number' || !Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error('Invalid relay presence snapshot')
  }
  return { token, ttlMs }
}
