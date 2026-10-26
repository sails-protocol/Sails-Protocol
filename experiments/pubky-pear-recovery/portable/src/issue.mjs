// Issuer side of the lab format v1 (see ../SPEC.md): holds secret keys, signs with libsodium.
// Its own CF1 encoder is deliberately separate from the verifier's (two implementations must agree on the vectors).
import b4a from 'b4a'
import sodium from 'sodium-universal'
import { createHash } from 'node:crypto'

// ---- CF1 encoder (issuer's own) ---------------------------------------------------------------
function esc (s) {
  const out = []
  for (const ch of s) {
    const c = ch.codePointAt(0)
    if (c >= 0xd800 && c <= 0xdfff) throw new Error('CF1: lone surrogate')
    out.push(ch === '"' ? '\\"' : ch === '\\' ? '\\\\' : c < 32 ? '\\u' + ('0000' + c.toString(16)).slice(-4) : ch)
  }
  return '"' + out.join('') + '"'
}
export function cf1 (v) {
  switch (typeof v) {
    case 'string': return esc(v)
    case 'boolean': return v ? 'true' : 'false'
    case 'number':
      if (!Number.isSafeInteger(v) || Object.is(v, -0)) throw new Error('CF1: integers only')
      return '' + v
    case 'object': {
      if (v === null) return 'null'
      if (Array.isArray(v)) return '[' + v.map(cf1).join(',') + ']'
      const ks = Object.keys(v).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      for (const k of ks) if (!/^[ -~]+$/.test(k)) throw new Error('CF1: keys must be ASCII')
      return '{' + ks.map((k) => esc(k) + ':' + cf1(v[k])).join(',') + '}'
    }
    default: throw new Error('CF1: unsupported type')
  }
}
export const input = (purpose, body) => b4a.from('SAILS-PORTABLE/1/' + purpose + '\n' + cf1(body), 'utf8')
export const idOf = (purpose, body) => createHash('sha256').update(input(purpose, body)).digest('hex')

// ---- keys ---------------------------------------------------------------------------------------
export function keyFromSeed (seed32) {
  const pk = b4a.alloc(32); const sk = b4a.alloc(64)
  sodium.crypto_sign_seed_keypair(pk, sk, b4a.from(seed32))
  const sign = (msg) => { const s = b4a.alloc(64); sodium.crypto_sign_detached(s, msg, sk); return b4a.toString(s, 'hex') }
  return { seed: b4a.toString(b4a.from(seed32), 'hex'), pk: b4a.toString(pk, 'hex'), pkBytes: pk, sign }
}

const Z32 = 'ybndrfg8ejkmcpqxot1uwisza345h769'
export function z32encode (bytes32) {
  let bits = 0; let acc = 0; let out = ''
  for (const byte of bytes32) { acc = (acc << 8) | byte; bits += 8; while (bits >= 5) { bits -= 5; out += Z32[(acc >> bits) & 31]; acc &= (1 << bits) - 1 } }
  if (bits > 0) out += Z32[(acc << (5 - bits)) & 31]
  return out
}

const b64u = (b) => Buffer.from(b).toString('base64url')
export function jws (typ, claims, key) {
  const signingInput = `${b64u(JSON.stringify({ alg: 'EdDSA', typ }))}.${b64u(JSON.stringify(claims))}`
  return `${signingInput}.${b64u(Buffer.from(key.sign(b4a.from(signingInput)), 'hex'))}`
}

// ---- Pubky side (what a signer and a grant client produce; mirrors pubky-common jws.rs) --------
export function pubkyGrant (root, delegate, { caps, clientId, jti, iat, exp }) {
  return jws('pubky-grant', { iss: z32encode(root.pkBytes), client_id: clientId, caps, cnf: z32encode(delegate.pkBytes), jti, iat, exp }, root)
}
export function delegatePop (delegate, { jti, iat, nonce, data }) {
  return jws('pubky-custom-pop-v1', { gid: jti, iat, nonce, data }, delegate)
}

// ---- Sails side ---------------------------------------------------------------------------------
export function bindingStatement (root, participant, { audience, nonce, iat, exp }) {
  return { v: 1, kind: 'binding', pubky: z32encode(root.pkBytes), participant: participant.pk, audience, nonce, iat, exp }
}
export function bindingBundle ({ statement, participant, grant, pop }) {
  return { statement, participantSig: participant.sign(input('binding-participant', statement)), grant, delegatePop: pop }
}
export function bindingRevocation (participant, pubky, iat) {
  const body = { v: 1, kind: 'binding-revocation', participant: participant.pk, pubky, iat }
  return { body, sig: participant.sign(input('binding-revocation', body)) }
}

export const commitTrade = (tradeSalt, tradeRef) => createHash('sha256').update(`SAILS-COMMIT/1/trade\0${tradeSalt}\0${tradeRef}`).digest('hex')
export const commitParty = (partySalt, counterpartyHex) => createHash('sha256').update(`SAILS-COMMIT/1/party\0${partySalt}\0${counterpartyHex}`).digest('hex')

export class Chain {
  constructor (participant) { this.p = participant; this.facts = []; this.prev = '0'.repeat(64) }
  append ({ tradeCommit, counterpartyCommit, outcome, iat }) {
    const body = { v: 1, kind: 'trade-outcome', participant: this.p.pk, seq: this.facts.length, prev: this.prev, tradeCommit, counterpartyCommit, outcome, iat }
    const fact = { body, sig: this.p.sign(input('fact', body)) }
    this.facts.push(fact); this.prev = idOf('fact', body)
    return fact
  }
  head (iat) {
    const body = { v: 1, kind: 'head', participant: this.p.pk, seq: this.facts.length - 1, hash: this.prev, iat }
    return { body, sig: this.p.sign(input('head', body)) }
  }
}
export function confirmation (confirmer, issuerHex, { tradeCommit, outcome, iat }) {
  const body = { v: 1, kind: 'confirmation', confirmer: confirmer.pk, issuer: issuerHex, tradeCommit, outcome, iat }
  return { body, sig: confirmer.sign(input('confirmation', body)) }
}
export function disputeClaim (claimant, subjectHex, { tradeCommit, iat }) {
  const body = { v: 1, kind: 'dispute-claim', claimant: claimant.pk, subject: subjectHex, tradeCommit, iat }
  return { body, sig: claimant.sign(input('dispute-claim', body)) }
}
