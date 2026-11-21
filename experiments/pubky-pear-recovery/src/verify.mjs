// Public-side verification. Needs only public keys and the signed documents:
// no secret, no network, no Satsails API. This is what a third-party integrator runs.
import { createHash } from 'node:crypto'
import b4a from 'b4a'
import sodium from 'sodium-universal'
import { PREFIX, signingBytes } from './canonical.mjs'
import { pubkyPublicKeyFromZ32 } from './pubkyid.mjs'

export const SCOPES = Object.freeze(['chat:read', 'chat:send', 'offer:negotiate', 'pear:connect', 'proof:present'])
export const MAX_TTL_SEC = 30 * 24 * 3600
export const SKEW_SEC = 60
const HEX = (n) => new RegExp(`^[0-9a-f]{${n}}$`)

const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra })

function verifySig (publicKey, message, sigHex) {
  if (!HEX(128).test(sigHex ?? '')) return false
  return sodium.crypto_sign_verify_detached(b4a.from(sigHex, 'hex'), message, b4a.from(publicKey))
}

function parseZ32 (z32) {
  try { return pubkyPublicKeyFromZ32(z32) } catch { return null }
}

// ---- Pubky -> Pear session authorization -------------------------------------------

export function verifyAuthorization (cert, { expectedSub, now, requiredScope, maxTtlSec = MAX_TTL_SEC } = {}) {
  const b = cert?.body
  if (!b || b.v !== 1 || b.kind !== 'pear-session' || !HEX(32).test(b.id ?? '') || !HEX(64).test(b.pear ?? '') ||
    typeof b.dev !== 'string' || !Number.isSafeInteger(b.iat) || !Number.isSafeInteger(b.exp) || !Array.isArray(b.scope) || b.scope.length === 0) {
    return fail('malformed')
  }
  if (b.scope.some((s) => !SCOPES.includes(s)) || new Set(b.scope).size !== b.scope.length) return fail('unknown-scope')
  const pk = parseZ32(b.sub)
  if (!pk) return fail('malformed')
  if (expectedSub !== undefined && b.sub !== expectedSub) return fail('wrong-subject')
  if (!verifySig(pk, signingBytes(PREFIX.authorization, b), cert.sig)) return fail('bad-signature')
  if (b.exp <= b.iat || b.exp - b.iat > maxTtlSec) return fail('ttl-invalid')
  if (now < b.iat - SKEW_SEC) return fail('not-yet-valid')
  if (now >= b.exp) return fail('expired')
  if (requiredScope !== undefined && !b.scope.includes(requiredScope)) return fail('scope-missing')
  return { ok: true, body: b }
}

// ---- Proof of possession of the Pear session key -----------------------------------

export class ChallengeStore {
  #open = new Map()
  issue (audience, now, ttlSec = 60, nonce = null) {
    const n = nonce ?? b4a.toString(sodium_random(16), 'hex')
    this.#open.set(n, { audience, exp: now + ttlSec })
    return { nonce: n, audience, exp: now + ttlSec }
  }

  // Single use: a successful or failed consume removes the challenge.
  consume (nonce, audience, now) {
    const c = this.#open.get(nonce)
    this.#open.delete(nonce)
    return !!c && c.audience === audience && now < c.exp
  }
}

function sodium_random (n) {
  const buf = b4a.alloc(n)
  sodium.randombytes_buf(buf)
  return buf
}

export function popBody (body, challenge) {
  return { auth: body.id, pear: body.pear, nonce: challenge.nonce, audience: challenge.audience }
}

// ---- Revocation ---------------------------------------------------------------------

export function verifyRevocation (rev, sub) {
  const b = rev?.body
  if (!b || b.v !== 1 || b.kind !== 'revocation' || b.sub !== sub || !Number.isSafeInteger(b.iat) || typeof b.targets !== 'object') return false
  const pk = parseZ32(sub)
  return !!pk && verifySig(pk, signingBytes(PREFIX.revocation, b), rev.sig)
}

export function isRevoked (certBody, statements) {
  return statements.some((r) => {
    const t = r.body.targets
    return t.auth === certBody.id || t.pear === certBody.pear || (t.dev === certBody.dev && certBody.iat <= r.body.iat)
  })
}

// Revocation lookups can fail (homeserver down, offline). Default: fail closed.
// maxStaleSec > 0 allows a last-known-good answer for that long: availability is bought
// with a window in which a fresh revocation is invisible.
export class RevocationChecker {
  #source
  #maxStaleSec
  #cache = new Map()
  constructor ({ source, maxStaleSec = 0 }) {
    this.#source = source
    this.#maxStaleSec = maxStaleSec
  }

  async statementsFor (sub, now) {
    try {
      const list = await this.#source.list(sub)
      const valid = list.filter((r) => verifyRevocation(r, sub))
      this.#cache.set(sub, { at: now, valid })
      return { statements: valid, stale: false, ignored: list.length - valid.length }
    } catch {
      const c = this.#cache.get(sub)
      if (c && now - c.at <= this.#maxStaleSec) return { statements: c.valid, stale: true, ignored: 0 }
      return null
    }
  }
}

// ---- Full session verification ------------------------------------------------------

export async function verifySession ({ cert, pop, challenge, audience, now, expectedSub, requiredScope, revocations, challenges }) {
  const a = verifyAuthorization(cert, { expectedSub, now, requiredScope })
  if (!a.ok) return a
  if (!challenges.consume(challenge?.nonce, audience, now)) return fail('challenge-invalid')
  if (challenge.audience !== audience) return fail('challenge-invalid')
  if (!verifySig(b4a.from(a.body.pear, 'hex'), signingBytes(PREFIX.pop, popBody(a.body, challenge)), pop?.sig)) return fail('pop-invalid')
  const r = await revocations.statementsFor(a.body.sub, now)
  if (r === null) return fail('revocation-unavailable')
  if (isRevoked(a.body, r.statements)) return fail('revoked')
  return { ok: true, body: a.body, revocationStale: r.stale }
}

// ---- Portable economic history ------------------------------------------------------

export const GENESIS = '0'.repeat(64)

export function entryHash (entry) {
  return createHash('sha256').update(signingBytes(PREFIX.history, entry.body)).update(entry.sig, 'utf8').digest('hex')
}

export function cosignBytes (body) {
  return signingBytes(PREFIX.history + '/COSIGN', { sub: body.sub, iat: body.iat, trade: body.trade })
}

// expectedHead = { seq, hash } pinned by the verifier (anchor); without it a truncated
// tail cannot be detected.
export function verifyHistory (entries, { subject, requireCosign = true, expectedHead } = {}) {
  const pk = parseZ32(subject)
  if (!pk) return fail('malformed')
  let prev = GENESIS
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    const b = e?.body
    if (!b || b.v !== 1 || b.kind !== 'economic-receipt' || b.sub !== subject) return fail('malformed', { index: i })
    if (b.seq !== i) return fail('seq-gap', { index: i })
    if (b.prev !== prev) return fail('chain-broken', { index: i })
    if (!verifySig(pk, signingBytes(PREFIX.history, b), e.sig)) return fail('bad-signature', { index: i })
    if (requireCosign) {
      const cpk = parseZ32(b.trade?.counterparty)
      if (!cpk || b.trade.counterparty === subject || !verifySig(cpk, cosignBytes(b), e.cosig)) return fail('cosign-invalid', { index: i })
    }
    prev = entryHash(e)
  }
  if (expectedHead && (entries.length - 1 !== expectedHead.seq || prev !== expectedHead.hash)) return fail('head-mismatch')
  return { ok: true, count: entries.length, head: { seq: entries.length - 1, hash: prev } }
}
