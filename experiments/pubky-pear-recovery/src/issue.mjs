// Secret-side issuing: runs only on the user's devices.
import b4a from 'b4a'
import sodium from 'sodium-universal'
import { PREFIX, signingBytes } from './canonical.mjs'
import { GENESIS, SCOPES, cosignBytes, entryHash, popBody } from './verify.mjs'
import { hex } from './kdf.mjs'

function randomHex (n) {
  const buf = b4a.alloc(n)
  sodium.randombytes_buf(buf)
  return b4a.toString(buf, 'hex')
}

// The Pubky identity authorizes ONE Pear session key. Scopes are transport-level only;
// there is no scope that can move funds.
export function issueAuthorization (identity, { pearPublicKey, deviceId, scope, now, ttlSec, id = randomHex(16) }) {
  const body = {
    v: 1,
    kind: 'pear-session',
    id,
    sub: identity.z32,
    pear: hex(pearPublicKey),
    dev: deviceId,
    scope: [...new Set(scope)].sort(),
    iat: now,
    exp: now + ttlSec
  }
  if (body.scope.some((s) => !SCOPES.includes(s))) throw new Error('unknown scope')
  return { body, sig: hex(identity.sign(signingBytes(PREFIX.authorization, body))) }
}

export function makePop (pearKey, cert, challenge) {
  return { sig: hex(pearKey.sign(signingBytes(PREFIX.pop, popBody(cert.body, challenge)))) }
}

export function issueRevocation (identity, { targets, now }) {
  const body = { v: 1, kind: 'revocation', sub: identity.z32, targets, iat: now }
  return { body, sig: hex(identity.sign(signingBytes(PREFIX.revocation, body))) }
}

export function appendReceipt (identity, entries, trade, now) {
  const prev = entries.length ? entryHash(entries[entries.length - 1]) : GENESIS
  const body = { v: 1, kind: 'economic-receipt', sub: identity.z32, seq: entries.length, prev, iat: now, trade }
  return { body, sig: hex(identity.sign(signingBytes(PREFIX.history, body))) }
}

export function cosignReceipt (counterparty, entry) {
  return { ...entry, cosig: hex(counterparty.sign(cosignBytes(entry.body))) }
}
