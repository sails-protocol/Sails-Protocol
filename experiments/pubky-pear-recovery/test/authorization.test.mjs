import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { NOW, TEST_ROOT, fixedSource, session, world } from './_helpers.mjs'

const SCOPE = ['pear:connect', 'chat:send']
const TTL = 3600

async function fixture () {
  const w = await world()
  const device = w.mkDevice('phone-1')
  const cert = w.issue.issueAuthorization(w.identity, { pearPublicKey: device.publicKey, deviceId: 'phone-1', scope: SCOPE, now: NOW, ttlSec: TTL })
  const revocations = new w.verify.RevocationChecker({ source: fixedSource() })
  const challenges = new w.verify.ChallengeStore()
  return { w, device, cert, revocations, challenges }
}

test('HKDF output matches an independent RFC 5869 implementation (not circular)', async () => {
  const { w } = await fixture()
  const salt = Buffer.from('sails-p2p-recovery-root-v1')
  const prk = createHmac('sha256', salt).update(Buffer.from(TEST_ROOT)).digest()
  const okm = createHmac('sha256', prk).update(Buffer.concat([Buffer.from('sails/p2p/v1/pubky/identity'), Buffer.from([1])])).digest()
  assert.equal(w.kdf.hex(w.kdf.pubkySecretFromRoot(TEST_ROOT)), okm.toString('hex'))
})

test('a Pear session authorized by the Pubky identity is accepted', async () => {
  const { w, device, cert, revocations, challenges } = await fixture()
  const r = await session(w, { device, cert, revocations, challenges, expectedSub: w.identity.z32, requiredScope: 'chat:send' })
  assert.equal(r.ok, true)
  assert.equal(r.body.dev, 'phone-1')
})

test('authorization carries expiry, scope, device and has no funds scope', async () => {
  const { w, cert } = await fixture()
  assert.deepEqual(cert.body.scope, ['chat:send', 'pear:connect'])
  assert.equal(cert.body.exp - cert.body.iat, TTL)
  assert.equal(cert.body.dev, 'phone-1')
  assert.throws(() => w.issue.issueAuthorization(w.identity, { pearPublicKey: cert.body.pear, deviceId: 'x', scope: ['funds:spend'], now: NOW, ttlSec: 60 }), /unknown scope/)
})

test('reinstall: only the mnemonic is needed to rebuild identity, device key and a verifiable new authorization', async () => {
  const { w, cert } = await fixture()
  const restoredRoot = w.kdf.mnemonicToRoot(w.kdf.rootToMnemonic(TEST_ROOT))
  const w2 = await world(restoredRoot)
  assert.equal(w2.identity.z32, w.identity.z32)
  const device2 = w2.mkDevice('phone-1')
  assert.equal(w2.kdf.hex(device2.publicKey), cert.body.pear, 'unified root: same Pear key after reinstall')
  const cert2 = w2.issue.issueAuthorization(w2.identity, { pearPublicKey: device2.publicKey, deviceId: 'phone-1', scope: SCOPE, now: NOW + 10, ttlSec: TTL })
  const r = await session(w2, {
    device: device2, cert: cert2, now: NOW + 10, expectedSub: w.identity.z32,
    revocations: new w2.verify.RevocationChecker({ source: fixedSource() }), challenges: new w2.verify.ChallengeStore()
  })
  assert.equal(r.ok, true)
})

test('second device derives its own key and gets its own authorization', async () => {
  const { w, revocations, challenges } = await fixture()
  const laptop = w.mkDevice('laptop-1')
  const cert = w.issue.issueAuthorization(w.identity, { pearPublicKey: laptop.publicKey, deviceId: 'laptop-1', scope: SCOPE, now: NOW, ttlSec: TTL })
  const r = await session(w, { device: laptop, cert, revocations, challenges, expectedSub: w.identity.z32 })
  assert.equal(r.ok, true)
  assert.notEqual(cert.body.pear, w.kdf.hex(w.mkDevice('phone-1').publicKey))
})
