// Public-side policy for a Pear session authorization expressed as a native Pubky grant plus a
// custom proof-of-possession. Needs only public data. This is what a second integrator runs.
//
// Chain: Pubky root key --signs--> grant (caps, client_id, exp, cnf = integrator PoP key)
//        integrator PoP key --signs--> statement {kind, pear key, scope, aud, exp}   (createCustomPop)
//        Pear key --signs--> binding over (grant id, nonce, pear key)               (pearSign)
import b4a from 'b4a'
import sodium from 'sodium-universal'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { verifyCustomGrantPop } = require('@synonymdev/pubky')

export const KIND = 'sails.pear-session.v1'
export const MAX_STATEMENT_TTL = 3600
export const SCOPES = ['pear:connect', 'chat:read', 'chat:send', 'offer:negotiate', 'proof:present']

// Each transport scope is expressed as a storage capability so that the signer's consent screen and its
// narrowing (approveAuthWithCapabilities) decide the scopes. Example: chat:send -> /pub/sails.market/pear/scopes/chat-send/
export const scopePath = (scope) => `/pub/sails.market/pear/scopes/${scope.replace(':', '-')}/`
export const capsFor = (scopes) => ['/pub/sails.market/pear/devices/:rw', ...scopes.map((s) => `${scopePath(s)}:rw`)].join(',')

export function signingInput ({ grantJti, nonce, pear, extra = '' }) {
  return b4a.from(`SAILS-PEAR-GRANT-BINDING-V1\0${grantJti}\0${nonce}\0${pear}\0${extra}`, 'utf8')
}

// A capability string is "<path>:<actions>", e.g. "/pub/sails.market/pear/:rw".
export function capCovers (cap, path, action) {
  const i = cap.lastIndexOf(':')
  const capPath = cap.slice(0, i)
  const actions = cap.slice(i + 1)
  return path.startsWith(capPath) && actions.includes(action)
}

const deny = (reason) => ({ ok: false, reason })

export function verifyPearAuthorization (record, { identity, audience, now, allowedClients, requiredPath, maxStatementTtl = MAX_STATEMENT_TTL }) {
  let v
  try { v = verifyCustomGrantPop(record.cp, { clockSkewSeconds: 30 }) } catch (e) { return deny('grant-or-pop-invalid:' + String(e?.message ?? e).slice(0, 60)) }
  if (v.identity !== identity) return deny('wrong-identity')
  const claims = v.grantClaims
  if (allowedClients && !allowedClients.includes(claims.client_id)) return deny('client-not-allowed')
  if (!claims.caps.some((c) => capCovers(c, requiredPath, 'w'))) return deny('capability-missing')
  const d = v.data
  if (!d || d.kind !== KIND || d.v !== 1 || !/^[0-9a-f]{64}$/.test(d.pear ?? '')) return deny('statement-malformed')
  if (!Array.isArray(d.scope) || d.scope.length === 0 || d.scope.some((s) => !SCOPES.includes(s))) return deny('scope-invalid')
  // The user only ever approves STORAGE capabilities (the JS signer cannot sign a service-specific claim),
  // so every transport scope the statement declares must be backed by a write capability the user approved.
  // Otherwise the integrator would be choosing the transport scope by itself.
  for (const s of d.scope) {
    if (!claims.caps.some((c) => capCovers(c, scopePath(s), 'w'))) return deny('scope-not-granted:' + s)
  }
  if (d.aud !== '*' && d.aud !== audience) return deny('audience-mismatch')
  if (!Number.isSafeInteger(d.exp) || !Number.isSafeInteger(d.iat)) return deny('statement-malformed')
  if (now >= d.exp) return deny('statement-expired')
  if (d.exp - d.iat > maxStatementTtl) return deny('statement-ttl-too-long')
  if (now >= claims.exp) return deny('grant-expired')
  const ok = sodium.crypto_sign_verify_detached(b4a.from(record.pearSig ?? '', 'hex'), signingInput({ grantJti: claims.jti, nonce: v.nonce, pear: d.pear }), b4a.from(d.pear, 'hex'))
  if (!ok) return deny('pear-binding-invalid')
  return { ok: true, identity: v.identity, grantId: claims.jti, clientId: claims.client_id, pear: d.pear, scope: d.scope, nonce: v.nonce, expires: Math.min(d.exp, claims.exp), iat: d.iat, seq: d.seq }
}

// ---- Freshness, provenance and anti-rollback (CTO decision 5: do not trust an unsigned mutable directory) ----

// Remembers the highest statement sequence seen per (identity, Pear key). A lower number is a rollback.
export class RollbackGuard {
  #seen = new Map()
  accept (key, seq) {
    const last = this.#seen.get(key) ?? -1
    if (seq < last) return false
    this.#seen.set(key, seq)
    return true
  }
}

export const DEFAULT_MAX_AGE_SEC = 900

// A record only authorizes something NEW if (1) the signed chain verifies, (2) it was fetched from the identity's
// directory (the caller passes the homeserver's stats; a record handed over out of band has none), (3) the SIGNED
// statement is younger than maxAgeSec, (4) the homeserver's own last-modified is too, and (5) it is not older than
// one already seen. The homeserver is trusted for revocation and freshness, NOT for authenticity: it cannot forge
// (3) or (5) but it can lie about (4) and about whether a grant was revoked.
export function verifyFreshRecord (record, opts, { stats, now, maxAgeSec = DEFAULT_MAX_AGE_SEC, guard }) {
  const r = verifyPearAuthorization(record, opts)
  if (!r.ok) return r
  if (!Number.isSafeInteger(r.seq)) return deny('seq-missing')
  if (!stats || !Number.isFinite(stats.lastModifiedMs)) return deny('freshness-unavailable')
  if (r.iat > now + 30) return deny('statement-from-the-future')
  if (now - r.iat > maxAgeSec) return deny('statement-stale')
  if (now * 1000 - stats.lastModifiedMs > maxAgeSec * 1000) return deny('directory-stale')
  if (guard && !guard.accept(`${r.identity}:${r.pear}`, r.seq)) return deny('rollback-or-replay')
  return r
}

// Live proof that the Pear key is held right now: verifier-chosen challenge, audience-bound.
export function challengeInput ({ nonce, audience, pear }) {
  return b4a.from(`SAILS-PEAR-CHALLENGE-V1\0${nonce}\0${audience}\0${pear}`, 'utf8')
}

export function verifyChallenge ({ pear, nonce, audience, sigHex }) {
  return sodium.crypto_sign_verify_detached(b4a.from(sigHex ?? '', 'hex'), challengeInput({ nonce, audience, pear }), b4a.from(pear, 'hex'))
}

// Revocation status of the grant behind a record. There is NO documented API for a third party to
// ask this: the homeserver checks revocation BEFORE the proof-of-possession on POST /auth/grant/session,
// so presenting the public grant JWS with a deliberately wrong PoP reveals the status in the error text.
// Behavioural, undocumented: treat as an observation, not a contract.
export async function grantStatus (homeserverHttp, grantJws, { timeoutMs = 8000 } = {}) {
  let res
  try {
    res = await fetch(`${homeserverHttp}/auth/grant/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant: grantJws, pop: grantJws }), // grant JWS is not a valid PoP
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch { return 'unavailable' }
  const text = await res.text()
  if (/revoked/i.test(text)) return 'revoked'
  if (res.status === 401 || res.status === 400 || res.status === 403) return 'active-or-unknown'
  return 'unexpected:' + res.status
}
