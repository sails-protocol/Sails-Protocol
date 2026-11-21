// Negative tests. Each must FAIL when the matching check is removed from the verifier:
// scripts/red-green.mjs proves that by running this file against broken copies.
import test from 'node:test'
import assert from 'node:assert/strict'
import { NOW, downSource, fixedSource, load, session, world } from './_helpers.mjs'

const SCOPE = ['pear:connect', 'chat:send']
const TTL = 3600

async function fixture (overrides = {}) {
  const w = await world()
  const device = w.mkDevice('phone-1')
  const cert = w.issue.issueAuthorization(w.identity, { pearPublicKey: device.publicKey, deviceId: 'phone-1', scope: SCOPE, now: NOW, ttlSec: TTL })
  const mk = (source = fixedSource(), maxStaleSec = 0) => new w.verify.RevocationChecker({ source, maxStaleSec })
  return { w, device, cert, mk, challenges: new w.verify.ChallengeStore(), ...overrides }
}

const reason = (r) => (r.ok ? 'ok' : r.reason)

test('wrong Pubky key: authorization signed by another identity is rejected', async () => {
  const { w, device, mk, challenges } = await fixture()
  const other = await world(new Uint8Array(32).fill(9))
  const forged = other.issue.issueAuthorization(other.identity, { pearPublicKey: device.publicKey, deviceId: 'phone-1', scope: SCOPE, now: NOW, ttlSec: TTL })
  const r = await session(w, { device, cert: forged, revocations: mk(), challenges, expectedSub: w.identity.z32 })
  assert.equal(reason(r), 'wrong-subject')
})

test('wrong Pubky key: claiming the victim as subject with the attacker signature fails the signature check', async () => {
  const { w, device, cert, mk, challenges } = await fixture()
  const other = await world(new Uint8Array(32).fill(9))
  const body = { ...cert.body, sub: w.identity.z32 }
  const attackerSig = other.issue.issueAuthorization(other.identity, { pearPublicKey: device.publicKey, deviceId: 'phone-1', scope: SCOPE, now: NOW, ttlSec: TTL }).sig
  const r = await session(w, { device, cert: { body, sig: attackerSig }, revocations: mk(), challenges })
  assert.equal(reason(r), 'bad-signature')
})

test('tampering: widening scope or extending expiry invalidates the signature', async () => {
  const { w, device, cert, mk, challenges } = await fixture()
  const widened = { ...cert, body: { ...cert.body, scope: ['chat:read', 'chat:send', 'pear:connect'] } }
  assert.equal(reason(await session(w, { device, cert: widened, revocations: mk(), challenges })), 'bad-signature')
  const extended = { ...cert, body: { ...cert.body, exp: cert.body.exp + 86400 } }
  assert.equal(reason(await session(w, { device, cert: extended, revocations: mk(), challenges })), 'bad-signature')
})

test('expired authorization is rejected, and one issued for the future is not yet valid', async () => {
  const { w, device, cert, mk, challenges } = await fixture()
  assert.equal(reason(await session(w, { device, cert, now: NOW + TTL, revocations: mk(), challenges })), 'expired')
  assert.equal(reason(await session(w, { device, cert, now: NOW - 3600, revocations: mk(), challenges })), 'not-yet-valid')
})

test('lifetime above the cap is rejected even when correctly signed', async () => {
  const { w, device, mk, challenges } = await fixture()
  const long = w.issue.issueAuthorization(w.identity, { pearPublicKey: device.publicKey, deviceId: 'phone-1', scope: SCOPE, now: NOW, ttlSec: 31 * 24 * 3600 })
  assert.equal(reason(await session(w, { device, cert: long, revocations: mk(), challenges })), 'ttl-invalid')
})

test('scope: a session lacking the required scope is rejected', async () => {
  const { w, device, cert, mk, challenges } = await fixture()
  assert.equal(reason(await session(w, { device, cert, requiredScope: 'offer:negotiate', revocations: mk(), challenges })), 'scope-missing')
})

test('replay: the same challenge cannot be used twice', async () => {
  const { w, device, cert, mk, challenges } = await fixture()
  const revocations = mk()
  const ch = challenges.issue('market.example', NOW)
  const pop = w.issue.makePop(device, cert, ch)
  const args = { cert, pop, challenge: ch, audience: 'market.example', now: NOW, revocations, challenges }
  assert.equal((await w.verify.verifySession(args)).ok, true)
  assert.equal(reason(await w.verify.verifySession(args)), 'challenge-invalid')
})

test('replay: a proof made for one integrator is rejected by another audience', async () => {
  const { w, device, cert, mk, challenges } = await fixture()
  const ch = challenges.issue('market.example', NOW)
  const pop = w.issue.makePop(device, cert, ch)
  const r = await w.verify.verifySession({ cert, pop, challenge: ch, audience: 'wallet.example', now: NOW, revocations: mk(), challenges })
  assert.equal(reason(r), 'challenge-invalid')
})

test('replay: a presenter cannot relabel the audience of a challenge the verifier issued for someone else', async () => {
  const { w, device, cert, mk, challenges } = await fixture()
  const issuedForWallet = challenges.issue('wallet.example', NOW)
  const relabeled = { ...issuedForWallet, audience: 'market.example' }
  const pop = w.issue.makePop(device, cert, relabeled)
  const r = await w.verify.verifySession({ cert, pop, challenge: relabeled, audience: 'market.example', now: NOW, revocations: mk(), challenges })
  assert.equal(reason(r), 'challenge-invalid')
})

test('SDK drift guard: if Pubky ever maps a 32-byte secret to a different key, restore fails closed', async () => {
  const { w } = await fixture()
  const { pubky } = await load('pubkyid.mjs')
  const original = pubky.Keypair.fromSecret
  pubky.Keypair.fromSecret = () => ({ publicKey: { toUint8Array: () => new Uint8Array(32).fill(1), z32: () => 'x' }, free () {} })
  try {
    assert.throws(() => w.kdf.restorePubkyIdentity(new Uint8Array(32).fill(3)), /Ed25519 seed contract/)
  } finally {
    pubky.Keypair.fromSecret = original
  }
})

test('replay: a challenge the verifier never issued, or an expired one, is rejected', async () => {
  const { w, device, cert, mk, challenges } = await fixture()
  const fake = { nonce: '00'.repeat(16), audience: 'market.example', exp: NOW + 60 }
  assert.equal(reason(await w.verify.verifySession({ cert, pop: w.issue.makePop(device, cert, fake), challenge: fake, audience: 'market.example', now: NOW, revocations: mk(), challenges })), 'challenge-invalid')
  const ch = challenges.issue('market.example', NOW, 60)
  assert.equal(reason(await w.verify.verifySession({ cert, pop: w.issue.makePop(device, cert, ch), challenge: ch, audience: 'market.example', now: NOW + 61, revocations: mk(), challenges })), 'challenge-invalid')
})

test('stolen certificate without the Pear key cannot open a session (no proof of possession)', async () => {
  const { w, cert, mk, challenges } = await fixture()
  const thief = w.mkDevice('thief-device')
  const r = await session(w, { device: thief, cert, revocations: mk(), challenges })
  assert.equal(reason(r), 'pop-invalid')
})

test('revoked device is rejected, by authorization id, by device id and by Pear key', async () => {
  const { w, device, cert, mk, challenges } = await fixture()
  for (const targets of [{ auth: cert.body.id }, { dev: 'phone-1' }, { pear: cert.body.pear }]) {
    const rev = w.issue.issueRevocation(w.identity, { targets, now: NOW + 5 })
    const r = await session(w, { device, cert, now: NOW + 10, revocations: mk(fixedSource([rev])), challenges })
    assert.equal(reason(r), 'revoked', JSON.stringify(targets))
  }
})

test('device revocation does not block a later re-enrolment of the same device id on a new epoch', async () => {
  const { w, mk, challenges } = await fixture()
  const rev = w.issue.issueRevocation(w.identity, { targets: { dev: 'phone-1' }, now: NOW + 5 })
  const fresh = w.mkDevice('phone-1', 1)
  const cert2 = w.issue.issueAuthorization(w.identity, { pearPublicKey: fresh.publicKey, deviceId: 'phone-1', scope: SCOPE, now: NOW + 20, ttlSec: TTL })
  const r = await session(w, { device: fresh, cert: cert2, now: NOW + 30, revocations: mk(fixedSource([rev])), challenges })
  assert.equal(reason(r), 'ok')
})

test('forged revocation (bad signature) is ignored: it cannot be used to knock out a valid session', async () => {
  const { w, device, cert, mk, challenges } = await fixture()
  const rev = w.issue.issueRevocation(w.identity, { targets: { auth: cert.body.id }, now: NOW + 5 })
  const forged = { body: rev.body, sig: '00'.repeat(64) }
  const r = await session(w, { device, cert, now: NOW + 10, revocations: mk(fixedSource([forged])), challenges })
  assert.equal(reason(r), 'ok')
})

test('compromised Pear session key cannot mint authorizations for itself or other keys', async () => {
  const { w, device, cert, mk, challenges } = await fixture()
  // The attacker holds the device key and the cert, and signs a new cert with the DEVICE key.
  const evilIdentity = { z32: w.identity.z32, sign: (m) => device.sign(m) }
  const evil = w.issue.issueAuthorization(evilIdentity, { pearPublicKey: device.publicKey, deviceId: 'phone-1', scope: ['pear:connect', 'chat:read', 'chat:send', 'offer:negotiate'], now: NOW, ttlSec: TTL })
  const r = await session(w, { device, cert: evil, revocations: mk(), challenges })
  assert.equal(reason(r), 'bad-signature')
  // Damage window of a stolen session is bounded by scope and expiry.
  assert.deepEqual(cert.body.scope, ['chat:send', 'pear:connect'])
  assert.ok(cert.body.exp - cert.body.iat <= 30 * 24 * 3600)
})

test('infrastructure down: revocation source unreachable => deny (fail closed) by default', async () => {
  const { w, device, cert, mk, challenges } = await fixture()
  const r = await session(w, { device, cert, revocations: mk(downSource()), challenges })
  assert.equal(reason(r), 'revocation-unavailable')
})

test('infrastructure down: last-known-good is honoured only inside the configured staleness window', async () => {
  const { w, device, cert, mk } = await fixture()
  let up = true
  const flaky = { list: async () => { if (!up) throw new Error('down'); return [] } }
  const revocations = mk(flaky, 300)
  const challenges = new w.verify.ChallengeStore()
  assert.equal(reason(await session(w, { device, cert, now: NOW, revocations, challenges })), 'ok')
  up = false
  const within = await session(w, { device, cert, now: NOW + 200, revocations, challenges })
  assert.equal(within.ok, true)
  assert.equal(within.revocationStale, true)
  assert.equal(reason(await session(w, { device, cert, now: NOW + 400, revocations, challenges })), 'revocation-unavailable')
})

test('data loss: without the root nothing can be re-derived; with only the Pubky recovery file, Pear keys differ', async () => {
  const { w } = await fixture()
  const wrong = await world(new Uint8Array(32).fill(1))
  assert.notEqual(wrong.identity.z32, w.identity.z32)
  assert.notEqual(w.kdf.hex(wrong.mkDevice('phone-1').publicKey), w.kdf.hex(w.mkDevice('phone-1').publicKey))
})

test('key recovery is not message recovery: ciphertext is recoverable only if the bytes survived', async () => {
  const { w } = await fixture()
  const sodium = (await import('sodium-universal')).default
  const b4a = (await import('b4a')).default
  const pear = w.mkDevice('phone-1')
  const toX = (sk64, pk32) => {
    const xpk = b4a.alloc(sodium.crypto_scalarmult_BYTES)
    sodium.crypto_sign_ed25519_pk_to_curve25519(xpk, pk32)
    const xsk = b4a.alloc(sodium.crypto_scalarmult_SCALARBYTES)
    if (sk64) sodium.crypto_sign_ed25519_sk_to_curve25519(xsk, sk64)
    return { xpk, xsk }
  }
  const { xpk } = toX(null, pear.publicKey)
  const msg = b4a.from('private message body')
  const ct = b4a.alloc(msg.length + sodium.crypto_box_SEALBYTES)
  sodium.crypto_box_seal(ct, msg, xpk)
  const open = (device, blob) => {
    const x = toX(device.keyPair.secretKey, device.publicKey)
    const out = b4a.alloc(blob.length - sodium.crypto_box_SEALBYTES)
    return sodium.crypto_box_seal_open(out, blob, x.xpk, x.xsk) ? out : null
  }
  assert.equal(b4a.toString(open(w.mkDevice('phone-1'), ct)), 'private message body', 'blob kept + same epoch key => readable')
  assert.equal(open(w.mkDevice('phone-1', 1), ct), null, 'blob kept + rotated epoch => unreadable')
  assert.equal(open(w.mkDevice('laptop-1'), ct), null, 'another device key => unreadable')
  // If the blob was lost with the device, the root contains no copy of it: there is nothing to open.
})
