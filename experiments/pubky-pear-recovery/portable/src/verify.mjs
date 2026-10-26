// INDEPENDENT public verifier for the lab format v1 (see ../SPEC.md). Uses node:crypto only: it imports nothing from
// the issuer, the Pubky SDK, HyperDHT or any Sails code, and needs no database or network.
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto'

const SPKI = Buffer.from('302a300506032b6570032100', 'hex')
const Z32 = 'ybndrfg8ejkmcpqxot1uwisza345h769'
const SKEW = 30
const ZERO = '0'.repeat(64)

export const hex = (b) => Buffer.from(b).toString('hex')
export const sha256hex = (b) => createHash('sha256').update(b).digest('hex')

// ---- CF1 canonical form -----------------------------------------------------------------------
export function canonical (v) {
  if (v === null) return 'null'
  if (v === true) return 'true'
  if (v === false) return 'false'
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v) || Object.is(v, -0)) throw new Error('CF1: integers only')
    return String(v)
  }
  if (typeof v === 'string') {
    let out = '"'
    for (const ch of v) {
      const c = ch.codePointAt(0)
      if (c >= 0xd800 && c <= 0xdfff) throw new Error('CF1: lone surrogate')
      if (ch === '"') out += '\\"'
      else if (ch === '\\') out += '\\\\'
      else if (c < 0x20) out += '\\u' + c.toString(16).padStart(4, '0')
      else out += ch
    }
    return out + '"'
  }
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']'
  if (typeof v === 'object') {
    const keys = Object.keys(v)
    for (const k of keys) if (!/^[\x20-\x7e]+$/.test(k)) throw new Error('CF1: keys must be ASCII')
    keys.sort()
    return '{' + keys.map((k) => canonical(k) + ':' + canonical(v[k])).join(',') + '}'
  }
  throw new Error('CF1: unsupported type')
}

export const signingInput = (purpose, body) => Buffer.from(`SAILS-PORTABLE/1/${purpose}\n${canonical(body)}`, 'utf8')
export const objectId = (purpose, body) => sha256hex(signingInput(purpose, body))

// ---- primitives --------------------------------------------------------------------------------
function verifyEd (raw32, msg, sigHex) {
  try {
    if (!/^[0-9a-f]{128}$/.test(sigHex ?? '') || raw32.length !== 32) return false
    return edVerify(null, msg, createPublicKey({ key: Buffer.concat([SPKI, raw32]), format: 'der', type: 'spki' }), Buffer.from(sigHex, 'hex'))
  } catch { return false }
}

export function z32decode (s) {
  if (typeof s !== 'string' || s.length !== 52) throw new Error('z32: length')
  let bits = 0; let acc = 0; const out = []
  for (const ch of s) {
    const i = Z32.indexOf(ch)
    if (i < 0) throw new Error('z32: alphabet')
    acc = (acc << 5) | i; bits += 5
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); acc &= (1 << bits) - 1 }
  }
  if (out.length !== 32) throw new Error('z32: size')
  return Buffer.from(out)
}

function jwsParse (compact, typ) {
  const parts = String(compact).split('.')
  if (parts.length !== 3) throw new Error('jws: shape')
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
  if (header.alg !== 'EdDSA' || header.typ !== typ) throw new Error('jws: header')
  return { input: Buffer.from(`${parts[0]}.${parts[1]}`), payload: JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')), sig: Buffer.from(parts[2], 'base64url').toString('hex') }
}

const fail = (reason) => ({ ok: false, reason })

// ---- binding (SPEC section 2) ------------------------------------------------------------------
export function verifyBinding (bundle, { now, audience, basePath = '/pub/sails.market', requireLevel = 'root-consented', maxStatementTtl = 30 * 24 * 3600 }) {
  try {
    const S = bundle.statement
    if (!S || S.v !== 1 || S.kind !== 'binding' || !/^[0-9a-f]{64}$/.test(S.participant ?? '')) return fail('malformed')
    const grant = jwsParse(bundle.grant, 'pubky-grant')
    const c = grant.payload
    if (!verifyEd(z32decode(c.iss), grant.input, grant.sig)) return fail('grant-signature')
    if (!(now < c.exp) || now < c.iat - SKEW) return fail('grant-not-valid-now')
    if (S.pubky !== c.iss) return fail('pubky-mismatch')
    const pop = jwsParse(bundle.delegatePop, 'pubky-custom-pop-v1')
    if (!verifyEd(z32decode(c.cnf), pop.input, pop.sig)) return fail('delegate-signature')
    if (pop.payload.gid !== c.jti) return fail('delegate-grant-mismatch')
    if (canonical(pop.payload.data) !== canonical(S)) return fail('delegate-statement-mismatch')
    if (!verifyEd(Buffer.from(S.participant, 'hex'), signingInput('binding-participant', S), bundle.participantSig)) return fail('participant-signature')
    if (S.audience !== audience) return fail('audience')
    if (S.iat > now + SKEW) return fail('statement-from-the-future')
    if (!(now < S.exp) || S.exp > c.exp || S.exp - S.iat > maxStatementTtl) return fail('statement-validity')
    const consent = `${basePath}/bindings/${S.participant}/`
    const level = c.caps.some((cap) => { const i = cap.lastIndexOf(':'); return cap.slice(0, i) === consent && cap.slice(i + 1).includes('w') }) ? 'root-consented' : 'delegated-only'
    if (requireLevel === 'root-consented' && level !== 'root-consented') return { ok: false, reason: 'not-root-consented', level }
    return { ok: true, level, pubky: S.pubky, participant: S.participant, grantId: c.jti, clientId: c.client_id, expires: Math.min(S.exp, c.exp), statementId: objectId('binding-participant', S) }
  } catch (e) { return fail('malformed:' + String(e.message).slice(0, 40)) }
}

export function verifyBindingRevocation (rev, binding) {
  const b = rev?.body
  if (!b || b.v !== 1 || b.kind !== 'binding-revocation' || b.participant !== binding.participant || b.pubky !== binding.pubky) return false
  return verifyEd(Buffer.from(b.participant, 'hex'), signingInput('binding-revocation', b), rev.sig)
}

// ---- facts and chain (SPEC section 3) ----------------------------------------------------------
export function verifyChain (chain, head, { participants, pinnedHead }) {
  let prev = ZERO
  for (let i = 0; i < chain.length; i++) {
    const f = chain[i]; const b = f?.body
    if (!b || b.v !== 1 || b.kind !== 'trade-outcome') return fail('malformed:' + i)
    if (!participants.has(b.participant)) return { ok: false, reason: 'participant-not-bound', index: i }
    if (b.seq !== i) return { ok: false, reason: 'seq-gap', index: i }
    if (b.prev !== prev) return { ok: false, reason: 'chain-broken', index: i }
    if (!verifyEd(Buffer.from(b.participant, 'hex'), signingInput('fact', b), f.sig)) return { ok: false, reason: 'fact-signature', index: i }
    prev = objectId('fact', b)
  }
  const h = head?.body
  if (!h || h.v !== 1 || h.kind !== 'head' || !participants.has(h.participant)) return fail('head-malformed')
  if (!verifyEd(Buffer.from(h.participant, 'hex'), signingInput('head', h), head.sig)) return fail('head-signature')
  if (h.seq !== chain.length - 1 || h.hash !== prev) return fail('head-mismatch')
  if (pinnedHead && h.seq < pinnedHead.seq) return fail('head-older-than-pinned')
  if (pinnedHead && h.seq === pinnedHead.seq && h.hash !== pinnedHead.hash) return fail('head-fork')
  return { ok: true, head: { seq: h.seq, hash: h.hash } }
}

const tradeCommit = (o) => sha256hex(Buffer.from(`SAILS-COMMIT/1/trade\0${o.tradeSalt}\0${o.tradeRef}`, 'utf8'))
const partyCommit = (o) => sha256hex(Buffer.from(`SAILS-COMMIT/1/party\0${o.partySalt}\0${o.counterparty}`, 'utf8'))

// ---- reputation projection (SPEC section 4) ----------------------------------------------------
export function reputation ({ chain, confirmations = [], openings = {}, disputeClaims = [], participants }) {
  const last = new Map() // tradeCommit -> last fact (corrections win)
  for (const f of chain) last.set(f.body.tradeCommit, f.body)
  const cap = new Map(); const parties = new Set()
  let completedConfirmed = 0; let oneSided = 0; let capped = 0; let lost = 0
  for (const [tc, b] of last) {
    if (b.outcome === 'disputed-lost') { lost++; continue }
    if (b.outcome !== 'completed') continue
    const o = openings[tc]
    const conf = o && tradeCommit(o) === tc && partyCommit(o) === b.counterpartyCommit
      ? confirmations.find((c) => c.body?.kind === 'confirmation' && c.body.tradeCommit === tc && c.body.outcome === 'completed' && c.body.issuer === b.participant && c.body.confirmer === o.counterparty && c.body.confirmer !== b.participant &&
          verifyEd(Buffer.from(c.body.confirmer, 'hex'), signingInput('confirmation', c.body), c.sig))
      : null
    if (!conf) { oneSided++; continue }
    const n = (cap.get(o.counterparty) ?? 0) + 1
    cap.set(o.counterparty, n); parties.add(o.counterparty)
    if (n > 3) capped++; else completedConfirmed++
  }
  const claimants = new Set()
  for (const d of disputeClaims) {
    const b = d.body
    if (b?.kind === 'dispute-claim' && participants.has(b.subject) && b.claimant !== b.subject && verifyEd(Buffer.from(b.claimant, 'hex'), signingInput('dispute-claim', b), d.sig)) claimants.add(`${b.claimant}:${b.tradeCommit}`)
  }
  return { score: completedConfirmed - 3 * lost - claimants.size, trades: last.size, completedConfirmed, oneSided, distinctCounterparties: parties.size, capped, lost, disputeClaims: claimants.size }
}

// ---- everything at once ------------------------------------------------------------------------
export function verifyPortable (pkg, { now, audience, pinnedHead, expectedPubky }) {
  const bound = new Map()
  let pubky = null
  for (const b of pkg.bindings) {
    const r = verifyBinding(b, { now, audience })
    if (!r.ok) return { ok: false, reason: 'binding:' + r.reason }
    if (pubky && pubky !== r.pubky) return fail('bindings-for-different-identities')
    pubky = r.pubky
    if ((pkg.bindingRevocations ?? []).some((rv) => verifyBindingRevocation(rv, r))) continue
    bound.set(r.participant, r)
  }
  if (expectedPubky && pubky !== expectedPubky) return fail('wrong-identity')
  if (!bound.size) return fail('no-active-binding')
  const participants = new Set(bound.keys())
  const chains = pkg.chains.map((c) => verifyChain(c.facts, c.head, { participants: new Set([c.participant]), pinnedHead: pinnedHead?.[c.participant] }))
  const bad = chains.find((c) => !c.ok)
  if (bad) return { ok: false, reason: 'chain:' + bad.reason }
  for (const c of pkg.chains) if (!participants.has(c.participant)) return fail('chain-participant-not-bound')
  const rep = reputation({ chain: pkg.chains.flatMap((c) => c.facts), confirmations: pkg.confirmations, openings: pkg.openings, disputeClaims: pkg.disputeClaims, participants })
  return { ok: true, pubky: [...bound.values()][0].pubky, participants: [...participants].sort(), levels: [...bound.values()].map((b) => b.level), reputation: rep }
}
