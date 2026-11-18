/**
 * Issue #301 — one-time-credential atomic consumption. The security
 * invariant "exactly one concurrent caller may consume this value" was
 * previously implemented in every caller (auth.ts's challenge,
 * ws-auth.ts's ticket, proof.service.ts's verification nonce) as two
 * separate Redis round-trips: `GET` then `DEL`. Two concurrent callers
 * can both complete `GET` before either `DEL` runs — the invariant was
 * never actually mechanical, only true under sequential access.
 * `Sequential one-time behavior != concurrent single-consumption`: a
 * one-winner guarantee must live in the storage mutation primitive
 * itself, not be assembled client-side from separately-awaited commands.
 *
 * Both primitives below are implemented as a single Lua script
 * (`redis.eval()`), not the native `GETDEL` command — deliberately, for
 * two reasons: (1) `atomicCompareAndConsume()` has no single-command
 * Redis equivalent at all (there is no native "delete this key only if
 * its current value equals X"); a Lua script is required regardless.
 * (2) `EVAL` has been available since Redis 2.6 — using it for BOTH
 * primitives means neither depends on `GETDEL` (Redis 6.2+) being
 * present on whatever Redis-protocol-compatible server a given
 * deployment runs (this repo's own local Windows dev harness uses
 * Memurai, a separate reimplementation — its exact `GETDEL` support is
 * not asserted anywhere in this repository, so this avoids needing to
 * prove it). Each script is a single round trip and a single Redis
 * command from the server's own perspective — genuinely atomic, not
 * "atomic assuming nothing else runs between two calls."
 *
 * Deliberately NOT a generic distributed-lock framework: two narrow,
 * named functions, each doing exactly one storage mutation. No lock
 * acquisition/renewal/expiry semantics, no cross-key coordination — the
 * value being consumed already lives in Redis with its own TTL, set by
 * the caller before this is ever invoked.
 */
import { redis } from './index'

// local Redis client is a shared module singleton (`./index`) — this
// helper is safe across every process/instance that shares it, and
// (this being the actual point) across every OTHER Sails server
// instance connected to the same Redis, since the atomicity guarantee
// is enforced by the Redis server itself, not by anything in this
// process's own memory.

export const ATOMIC_CONSUME_SCRIPT = `
local v = redis.call('GET', KEYS[1])
if v then
  redis.call('DEL', KEYS[1])
end
return v
`

const ATOMIC_COMPARE_AND_CONSUME_SCRIPT = `
local v = redis.call('GET', KEYS[1])
if v == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`

/**
 * GETDEL-equivalent: atomically returns the current value of `key` and
 * deletes it in the same server-side operation, or returns `null` if
 * the key did not exist (already consumed, expired, or never set).
 * Under N concurrent callers racing the same key, exactly one receives
 * the real value; every other caller receives `null` — Redis's own
 * single-threaded command execution is what enforces this, not
 * anything client-side.
 *
 * Use for a one-time value where "the first caller to observe it is
 * the legitimate consumer" is the whole rule (WS ticket, OpenProof
 * verification nonce) — there is no separate validation step that must
 * run before consumption is allowed to happen.
 */
export async function atomicConsume(key: string): Promise<string | null> {
  const result = await redis.eval(ATOMIC_CONSUME_SCRIPT, 1, key)
  return result === null ? null : String(result)
}

/**
 * Compare-and-delete: atomically deletes `key` ONLY IF its current
 * value still equals `expectedValue`, returning `true` on success
 * (meaning this call performed the delete) or `false` otherwise (the
 * key is missing, expired, or its value has since changed — e.g. a
 * fresh replacement value was issued after this caller last read it).
 *
 * Use where a value must be VALIDATED against caller-supplied proof
 * (a signature) before it is safe to consume — auth.ts's challenge is
 * the concrete case: the plain `GET` that reads the challenge for
 * signature verification is only an OBSERVATION, never the consuming
 * operation. Only after the caller's cryptographic proof verifies
 * against the observed value does this get called, atomically claiming
 * that EXACT observed value. This is what makes both required
 * properties hold simultaneously: (1) two concurrent replays of the
 * same captured (challenge, signature) pair both observe the same
 * challenge and both verify successfully, but only one wins the
 * compare-and-delete — the other's claim attempt finds the key already
 * gone and fails closed; (2) an invalid signature never reaches this
 * call at all (verification happens first), so it can never burn a
 * legitimate holder's still-valid challenge; (3) a stale caller holding
 * an old, already-replaced value fails the comparison (the key's
 * current value is the NEW one, not what this caller observed), so it
 * can never delete a challenge it never actually proved possession of.
 */
export async function atomicCompareAndConsume(key: string, expectedValue: string): Promise<boolean> {
  const result = await redis.eval(ATOMIC_COMPARE_AND_CONSUME_SCRIPT, 1, key, expectedValue)
  return result === 1
}
