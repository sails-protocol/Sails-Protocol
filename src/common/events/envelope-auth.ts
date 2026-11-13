/**
 * Authenticated origin envelope for events that cross a process boundary through Redis (Redis Gate 2).
 *
 * Without it, anything able to PUBLISH or XADD can claim any `__originInstanceId` (an unauthenticated uuid carried inside the message),
 * forge an event, or replay a captured one. The envelope adds `{ v, kid, iat, nonce, mac }`:
 *   mac = HMAC-SHA256(key[kid], "sails-envelope-v1" \n context \n kid \n iat \n nonce \n origin \n canonical(event))
 * so the origin id, the whole event, the time and the nonce are bound to a key. A receiver that holds the keyring drops anything that
 * is unsigned, signed with an unknown key id, tampered with, stale, from the future, or whose nonce it has already seen.
 *
 * What this does and does NOT do (stated so nobody over-reads it):
 *   - it proves the sender HOLDS a key of the keyring; it does not prove WHICH instance sent it unless keys are per instance, and it does
 *     not stop an authorized producer that is itself compromised from signing a forged event: that needs least-privilege Redis ACLs
 *     (deploy/redis/sails-acl.conf), key custody and rotation, which are operational;
 *   - replay protection holds within the receiver's memory (a bounded cache) and the accepted clock window; a restarted receiver forgets
 *     nonces but still refuses anything older than the window;
 *   - keys come from the environment (EVENT_ENVELOPE_KEYS): their distribution and rotation are the operator's.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'crypto'

export interface EnvelopeKeyring { activeKid: string; keys: Map<string, Buffer> }
export interface Envelope { v: 1; kid: string; iat: number; nonce: string; mac: string }
export type EnvelopeVerdict =
  | { ok: true }
  | { ok: false; reason: 'MALFORMED' | 'UNKNOWN_KID' | 'BAD_MAC' | 'STALE' | 'FUTURE' | 'REPLAY' }

const LABEL = 'sails-envelope-v1'
const MIN_KEY_BYTES = 32

/** Deterministic JSON: object keys sorted at every level, so the MAC does not depend on key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj).filter((k) => obj[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`
}

/**
 * EVENT_ENVELOPE_KEYS="kid1:<64+ hex chars>,kid2:<...>"; EVENT_ENVELOPE_ACTIVE_KID (default: the first). Returns null when no key is
 * configured. A malformed configuration THROWS: a misconfigured authentication must stop the process, not silently run unauthenticated.
 */
export function parseKeyring(env: NodeJS.ProcessEnv = process.env): EnvelopeKeyring | null {
  const raw = env.EVENT_ENVELOPE_KEYS?.trim()
  if (!raw) return null
  const keys = new Map<string, Buffer>()
  for (const part of raw.split(',')) {
    const [kid, hex, ...rest] = part.trim().split(':')
    if (!kid || !hex || rest.length || !/^[A-Za-z0-9_-]{1,32}$/.test(kid) || !/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
      throw new Error('EVENT_ENVELOPE_KEYS must be "kid:hexsecret[,kid:hexsecret...]" (kid 1-32 of [A-Za-z0-9_-], secret in hex)')
    }
    const secret = Buffer.from(hex, 'hex')
    if (secret.length < MIN_KEY_BYTES) throw new Error(`EVENT_ENVELOPE_KEYS: key "${kid}" is shorter than ${MIN_KEY_BYTES} bytes`)
    if (keys.has(kid)) throw new Error(`EVENT_ENVELOPE_KEYS: duplicate key id "${kid}"`)
    keys.set(kid, secret)
  }
  const activeKid = env.EVENT_ENVELOPE_ACTIVE_KID?.trim() || keys.keys().next().value!
  if (!keys.has(activeKid)) throw new Error(`EVENT_ENVELOPE_ACTIVE_KID "${activeKid}" is not in EVENT_ENVELOPE_KEYS`)
  return { activeKid, keys }
}

/** True when the environment demands authenticated envelopes (fail-closed): enabling a channel without a keyring then throws. */
export function envelopeRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.EVENT_ENVELOPE_REQUIRED === '1'
}

const macOf = (secret: Buffer, e: { kid: string; iat: number; nonce: string }, context: string, origin: string, event: unknown): string =>
  createHmac('sha256', secret).update([LABEL, context, e.kid, String(e.iat), e.nonce, origin, canonicalJson(event)].join('\n')).digest('hex')

export function signEnvelope(keyring: EnvelopeKeyring, context: string, origin: string, event: unknown, now = Date.now()): Envelope {
  const base = { kid: keyring.activeKid, iat: now, nonce: randomBytes(16).toString('hex') }
  return { v: 1, ...base, mac: macOf(keyring.keys.get(keyring.activeKid)!, base, context, origin, event) }
}

/** Bounded in-memory record of nonces seen (the pub/sub channel: messages are consumed immediately, so memory plus the age window is enough). */
export class ReplayCache {
  private readonly seen = new Map<string, number>()
  constructor(readonly ttlMs = 5 * 60_000, private readonly maxEntries = 50_000) {}
  /** True if this nonce was already seen (a replay); records it otherwise. */
  isReplay(nonce: string, now = Date.now()): boolean {
    for (const [n, expires] of this.seen) { if (expires > now) break; this.seen.delete(n) } // oldest first: Map keeps insertion order
    if (this.seen.has(nonce)) return true
    this.seen.set(nonce, now + this.ttlMs)
    while (this.seen.size > this.maxEntries) this.seen.delete(this.seen.keys().next().value!)
    return false
  }
  get size(): number { return this.seen.size }
}

/**
 * Checks form, key id, MAC and the clock window. It does NOT check replay: the caller does (ReplayCache for the channel, a Redis
 * SET NX for streams, whose entries are legitimately consumed long after they were signed and redelivered after a crash).
 * `maxAgeMs`: how old `iat` may be (default 5 min); `null` disables the age check (streams). A reader of the age window must make its
 * replay memory last at least as long (ReplayCache.ttlMs defaults to the same 5 min), or an old capture would slip through both.
 */
export function verifyEnvelope(
  keyring: EnvelopeKeyring, context: string, origin: string, event: unknown, envelope: unknown,
  opts: { now?: number; maxSkewMs?: number; maxAgeMs?: number | null } = {},
): EnvelopeVerdict & { nonce?: string } {
  const e = envelope as Partial<Envelope> | null | undefined
  if (!e || typeof e !== 'object' || e.v !== 1 || typeof e.kid !== 'string' || typeof e.iat !== 'number' || !Number.isFinite(e.iat)
    || typeof e.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(e.nonce) || typeof e.mac !== 'string' || !/^[0-9a-f]{64}$/.test(e.mac)) {
    return { ok: false, reason: 'MALFORMED' }
  }
  const secret = keyring.keys.get(e.kid)
  if (!secret) return { ok: false, reason: 'UNKNOWN_KID' }
  const want = Buffer.from(macOf(secret, { kid: e.kid, iat: e.iat, nonce: e.nonce }, context, origin, event), 'hex')
  const got = Buffer.from(e.mac, 'hex')
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, reason: 'BAD_MAC' }
  const now = opts.now ?? Date.now()
  const maxAge = opts.maxAgeMs === undefined ? 5 * 60_000 : opts.maxAgeMs
  if (maxAge !== null && e.iat < now - maxAge) return { ok: false, reason: 'STALE' }
  if (e.iat > now + (opts.maxSkewMs ?? 60_000)) return { ok: false, reason: 'FUTURE' }
  return { ok: true, nonce: e.nonce }
}