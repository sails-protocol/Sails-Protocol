// Alternative B ("native Pubky recovery, then Pear re-authorization") measured side by side
// with Alternative A ("single P2P root"). A "disk" Map stands for what survives on a device.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { NOW, TEST_ROOT, fixedSource, session, world } from './_helpers.mjs'

const SCOPE = ['pear:connect', 'chat:send']

async function accept (w, { device, cert, now, source }) {
  return session(w, {
    device, cert, now, expectedSub: w.identity.z32,
    revocations: new w.verify.RevocationChecker({ source: source ?? fixedSource() }), challenges: new w.verify.ChallengeStore()
  })
}

test('A (single root): after reinstall the SAME Pear key is re-derived; the old certificate still works', async () => {
  const w = await world()
  const dev = w.mkDevice('phone-1')
  const cert = w.issue.issueAuthorization(w.identity, { pearPublicKey: dev.publicKey, deviceId: 'phone-1', scope: SCOPE, now: NOW, ttlSec: 3600 })
  // Reinstall: disk empty, only the 24 words remain. The certificate was backed up as public data.
  const w2 = await world(w.kdf.mnemonicToRoot(w.kdf.rootToMnemonic(TEST_ROOT)))
  const dev2 = w2.mkDevice('phone-1')
  assert.equal(w2.kdf.hex(dev2.publicKey), cert.body.pear)
  assert.equal((await accept(w2, { device: dev2, cert, now: NOW + 60 })).ok, true)
})

test('B (native recovery + re-authorization): identity survives, the Pear key does not, a new authorization is required', async () => {
  const w = await world()
  const disk = new Map()
  const seed1 = new Uint8Array(randomBytes(32))
  disk.set('pear-seed', seed1)
  const dev1 = w.kdf.pearKeyPairFromSeed(seed1)
  const cert1 = w.issue.issueAuthorization(w.identity, { pearPublicKey: dev1.publicKey, deviceId: 'phone-1', scope: SCOPE, now: NOW, ttlSec: 3600 })

  // Reinstall: disk wiped. Pubky identity restored through ITS OWN recovery file + passphrase.
  disk.clear()
  const { pubky } = await import('../src/pubkyid.mjs')
  const file = pubky.Keypair.fromSecret(w.kdf.pubkySecretFromRoot(TEST_ROOT)).createRecoveryFile('test-only-passphrase')
  const recovered = pubky.Keypair.fromRecoveryFile(file, 'test-only-passphrase')
  const restoredIdentity = w.kdf.restorePubkyIdentity(recovered.secret())
  assert.equal(restoredIdentity.z32, w.identity.z32, 'identity continuity through Pubky-native recovery')

  const seed2 = new Uint8Array(randomBytes(32))
  const dev2 = w.kdf.pearKeyPairFromSeed(seed2)
  assert.notEqual(w.kdf.hex(dev2.publicKey), cert1.body.pear, 'Pear transport key changed')
  // The old certificate cannot be used by the new key (no PoP) ...
  const r = await accept(w, { device: dev2, cert: cert1, now: NOW + 60 })
  assert.equal(r.reason, 'pop-invalid')
  // ... so the new key needs a fresh authorization signed by the recovered Pubky key.
  const cert2 = w.issue.issueAuthorization(restoredIdentity, { pearPublicKey: dev2.publicKey, deviceId: 'phone-1', scope: SCOPE, now: NOW + 30, ttlSec: 3600 })
  assert.equal((await accept(w, { device: dev2, cert: cert2, now: NOW + 60 })).ok, true)

  // The orphaned old authorization stays valid until expiry unless revoked; revoking the
  // device id closes it without touching the newer certificate.
  const rev = restoredIdentity && w.issue.issueRevocation(restoredIdentity, { targets: { dev: 'phone-1' }, now: NOW + 20 })
  const src = fixedSource([rev])
  assert.equal((await accept(w, { device: w.kdf.pearKeyPairFromSeed(seed1), cert: cert1, now: NOW + 60, source: src })).reason, 'revoked')
  assert.equal((await accept(w, { device: dev2, cert: cert2, now: NOW + 60, source: src })).ok, true)
})

test('C (observation, not requested): Pear keys derived from the Pubky secret are recovered by Pubky-native recovery alone', async () => {
  const w = await world()
  const { pubky } = await import('../src/pubkyid.mjs')
  const pubkySecret = w.kdf.pubkySecretFromRoot(TEST_ROOT) // stands for any Pubky secret the integrator holds
  const before = w.kdf.pearKeyPairFromSeed(w.kdf.pearDeviceSeedFromRoot(pubkySecret, 'phone-1'))
  const file = pubky.Keypair.fromSecret(pubkySecret).createRecoveryFile('test-only-passphrase')
  const recoveredSecret = pubky.Keypair.fromRecoveryFile(file, 'test-only-passphrase').secret()
  const after = w.kdf.pearKeyPairFromSeed(w.kdf.pearDeviceSeedFromRoot(recoveredSecret, 'phone-1'))
  assert.equal(w.kdf.hex(after.publicKey), w.kdf.hex(before.publicKey))
  assert.notEqual(w.kdf.hex(after.publicKey), w.kdf.hex(w.identity.publicKey))
})

test('B: peers that saved the old Pear key as a contact cannot find the user without a Pubky-side directory', async () => {
  // Observable fact only: the old peer key no longer corresponds to any live key.
  const seedOld = new Uint8Array(randomBytes(32))
  const seedNew = new Uint8Array(randomBytes(32))
  const w = await world()
  assert.notEqual(w.kdf.hex(w.kdf.pearKeyPairFromSeed(seedOld).publicKey), w.kdf.hex(w.kdf.pearKeyPairFromSeed(seedNew).publicKey))
  // The directory (Pubky identity -> current authorized Pear keys) needs a homeserver: NOT TESTED here.
})
