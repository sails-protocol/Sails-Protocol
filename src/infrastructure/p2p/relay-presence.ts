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

export const RELAY_PRESENCE_RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`

export const RELAY_PRESENCE_RENEW_SCRIPT = `
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
export async function claimRelayPresence(participantId: string, token: string): Promise<void> {
  validateLeaseToken(token)
  await redis.set(presenceKey(participantId), token, 'PX', RELAY_PRESENCE_TTL_MS)
}

/** Only the current connection may extend its lease. */
export async function renewRelayPresence(participantId: string, token: string): Promise<boolean> {
  validateLeaseToken(token)
  return await redis.eval(RELAY_PRESENCE_RENEW_SCRIPT, 1,
    presenceKey(participantId), token, RELAY_PRESENCE_TTL_MS) === 1
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
