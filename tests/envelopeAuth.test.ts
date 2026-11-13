// Unit tests of the authenticated origin envelope (src/common/events/envelope-auth.ts): no Redis, no database.
import { canonicalJson, parseKeyring, signEnvelope, verifyEnvelope, ReplayCache, type EnvelopeKeyring } from '../src/common/events/envelope-auth'

const secret = (n: number) => String(n).repeat(64).slice(0, 64)
const ring = (kids: Array<[string, string]>, active?: string): EnvelopeKeyring => ({ activeKid: active ?? kids[0][0], keys: new Map(kids.map(([k, v]) => [k, Buffer.from(v, 'hex')])) })
const K1 = ring([['k1', secret(1)]])
const event = { eventId: 'e1', eventName: 'x', correlationId: 'c1', payload: { a: 1, b: [2, 3], c: { z: 1, y: 2 } }, publishedAt: '2026-10-26T00:00:00.000Z', entryHash: 'h', prevHash: 'p' }

describe('canonicalJson', () => {
  it('does not depend on key order, at any depth, and ignores undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: 1, c: 2 } })).toBe(canonicalJson({ a: { c: 2, d: 1 }, b: 1, u: undefined }))
    expect(canonicalJson([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]')
  })
})

describe('parseKeyring', () => {
  it('returns null when nothing is configured', () => expect(parseKeyring({})).toBeNull())
  it('parses kid:hex pairs, defaults the active key to the first and honours EVENT_ENVELOPE_ACTIVE_KID', () => {
    const r = parseKeyring({ EVENT_ENVELOPE_KEYS: `a:${secret(1)},b:${secret(2)}`, EVENT_ENVELOPE_ACTIVE_KID: 'b' })!
    expect([...r.keys.keys()]).toEqual(['a', 'b'])
    expect(r.activeKid).toBe('b')
    expect(parseKeyring({ EVENT_ENVELOPE_KEYS: `a:${secret(1)}` })!.activeKid).toBe('a')
  })
  it('THROWS on a malformed configuration instead of running unauthenticated', () => {
    for (const bad of ['nokid', 'a:zz', 'a:abc', `a:${secret(1)}:extra`, `a:${'11'.repeat(16)}`, `a:${secret(1)},a:${secret(2)}`, `bad kid:${secret(1)}`]) {
      expect(() => parseKeyring({ EVENT_ENVELOPE_KEYS: bad })).toThrow()
    }
    expect(() => parseKeyring({ EVENT_ENVELOPE_KEYS: `a:${secret(1)}`, EVENT_ENVELOPE_ACTIVE_KID: 'missing' })).toThrow(/not in EVENT_ENVELOPE_KEYS/)
  })
})

describe('signEnvelope / verifyEnvelope', () => {
  const now = 1_800_000_000_000
  const signed = () => signEnvelope(K1, 'xinstance', 'origin-1', event, now)
  const verify = (over: Partial<{ ring: EnvelopeKeyring; ctx: string; origin: string; ev: unknown; env: unknown; now: number; maxAgeMs: number | null }> = {}) =>
    verifyEnvelope(over.ring ?? K1, over.ctx ?? 'xinstance', over.origin ?? 'origin-1', over.ev ?? event, 'env' in over ? over.env : signed(), { now: over.now ?? now, maxAgeMs: over.maxAgeMs })

  it('accepts what was signed', () => expect(verify().ok).toBe(true))
  it('rejects a changed payload, event name, origin instance id, or context (every bound field)', () => {
    expect(verify({ ev: { ...event, payload: { a: 2 } } })).toMatchObject({ ok: false, reason: 'BAD_MAC' })
    expect(verify({ ev: { ...event, eventName: 'y' } })).toMatchObject({ ok: false, reason: 'BAD_MAC' })
    expect(verify({ origin: 'victim-instance' })).toMatchObject({ ok: false, reason: 'BAD_MAC' })
    expect(verify({ ctx: 'stream' })).toMatchObject({ ok: false, reason: 'BAD_MAC' })
  })
  it('rejects a changed kid, iat, nonce or mac, and a missing or malformed envelope', () => {
    const e = signed()
    expect(verify({ env: { ...e, iat: e.iat + 1 } })).toMatchObject({ ok: false, reason: 'BAD_MAC' })
    expect(verify({ env: { ...e, nonce: 'f'.repeat(32) } })).toMatchObject({ ok: false, reason: 'BAD_MAC' })
    expect(verify({ env: { ...e, mac: '0'.repeat(64) } })).toMatchObject({ ok: false, reason: 'BAD_MAC' })
    expect(verify({ env: { ...e, kid: 'nope' } })).toMatchObject({ ok: false, reason: 'UNKNOWN_KID' })
    for (const bad of [undefined, null, {}, 'x', { ...e, v: 2 }, { ...e, mac: 'short' }, { ...e, iat: 'now' }]) expect(verify({ env: bad })).toMatchObject({ ok: false, reason: 'MALFORMED' })
  })
  it('rejects a MAC made with another key of the same kid (an attacker without the secret)', () => {
    const attacker = ring([['k1', secret(9)]])
    expect(verify({ env: signEnvelope(attacker, 'xinstance', 'origin-1', event, now) })).toMatchObject({ ok: false, reason: 'BAD_MAC' })
  })
  it('enforces the clock window: stale and future are refused, an age limit of null (streams) accepts the old', () => {
    expect(verify({ now: now + 5 * 60_000 + 1 })).toMatchObject({ ok: false, reason: 'STALE' })
    expect(verify({ now: now - 61_000 })).toMatchObject({ ok: false, reason: 'FUTURE' })
    expect(verify({ now: now + 24 * 3600_000, maxAgeMs: null }).ok).toBe(true)
  })
  it('supports rotation: a receiver holding old and new keys accepts both, one holding only the new one refuses the old', () => {
    const oldRing = ring([['old', secret(1)]]); const both = ring([['old', secret(1)], ['new', secret(2)]], 'new'); const onlyNew = ring([['new', secret(2)]])
    const fromOld = signEnvelope(oldRing, 'xinstance', 'o', event, now); const fromNew = signEnvelope(both, 'xinstance', 'o', event, now)
    expect(fromNew.kid).toBe('new')
    expect(verify({ ring: both, origin: 'o', env: fromOld }).ok).toBe(true)
    expect(verify({ ring: both, origin: 'o', env: fromNew }).ok).toBe(true)
    expect(verify({ ring: onlyNew, origin: 'o', env: fromOld })).toMatchObject({ ok: false, reason: 'UNKNOWN_KID' })
  })
})

describe('ReplayCache', () => {
  it('flags the second use of a nonce, forgets after its ttl and stays bounded', () => {
    const c = new ReplayCache(1000, 3)
    expect(c.isReplay('a', 0)).toBe(false)
    expect(c.isReplay('a', 10)).toBe(true)
    expect(c.isReplay('a', 2000)).toBe(false) // expired: the age window (same ttl) refuses the old message anyway
    for (const n of ['b', 'c', 'd', 'e']) c.isReplay(n, 2001)
    expect(c.size).toBeLessThanOrEqual(3)
  })
})
