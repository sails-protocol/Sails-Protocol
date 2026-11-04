import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { SRC, TEST_ROOT, load, world } from './_helpers.mjs'

const vectors = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../vectors/test-vectors.json'), 'utf8'))

test('vectors: root -> mnemonic -> Pubky identity -> Pear device keys are reproduced exactly', async () => {
  const { kdf, identity, mkDevice } = await world()
  assert.equal(kdf.hex(TEST_ROOT), vectors.root)
  assert.equal(kdf.rootToMnemonic(TEST_ROOT), vectors.mnemonic)
  assert.equal(kdf.hex(kdf.pubkySecretFromRoot(TEST_ROOT)), vectors.pubky.secret)
  assert.equal(identity.z32, vectors.pubky.z32)
  for (const d of vectors.pear) {
    const seed = kdf.pearDeviceSeedFromRoot(TEST_ROOT, d.deviceId, d.epoch)
    assert.equal(kdf.hex(seed), d.seed)
    assert.equal(kdf.hex(mkDevice(d.deviceId, d.epoch).publicKey), d.publicKey)
  }
})

test('restore: mnemonic alone reproduces the same Pubky identity in a fresh object graph', async () => {
  const { kdf, identity } = await world()
  const restored = kdf.restorePubkyIdentity(kdf.pubkySecretFromRoot(kdf.mnemonicToRoot(vectors.mnemonic)))
  assert.equal(restored.z32, identity.z32)
  assert.equal(restored.z32, vectors.pubky.z32)
})

test('Pubky native recovery file also restores the same identity (alternative path)', async () => {
  const { kdf, identity } = await world()
  const { pubky } = await load('pubkyid.mjs')
  const kp = pubky.Keypair.fromSecret(kdf.pubkySecretFromRoot(TEST_ROOT))
  const file = kp.createRecoveryFile('test-only-passphrase')
  const back = pubky.Keypair.fromRecoveryFile(file, 'test-only-passphrase')
  assert.equal(back.publicKey.z32(), identity.z32)
  assert.throws(() => pubky.Keypair.fromRecoveryFile(file, 'wrong-passphrase'))
  assert.notDeepEqual(file, kp.createRecoveryFile('test-only-passphrase'), 'recovery files are salted, not byte-deterministic')
})

test('domain separation: Pubky identity and every Pear device key are pairwise distinct', async () => {
  const { kdf, identity, mkDevice } = await world()
  const keys = [kdf.hex(identity.publicKey), kdf.hex(mkDevice('phone-1').publicKey), kdf.hex(mkDevice('laptop-1').publicKey), kdf.hex(mkDevice('phone-1', 1).publicKey)]
  assert.equal(new Set(keys).size, keys.length)
  assert.notEqual(kdf.hex(kdf.pubkySecretFromRoot(TEST_ROOT)), kdf.hex(kdf.pearDeviceSeedFromRoot(TEST_ROOT, 'phone-1')))
})

test('anti-pattern, documented: one raw seed fed to both Pubky and HyperDHT yields the SAME public key', async () => {
  const { kdf, identity } = await world()
  const pear = kdf.pearKeyPairFromSeed(TEST_ROOT)
  const pubkyFromRaw = kdf.restorePubkyIdentity(TEST_ROOT)
  assert.equal(kdf.hex(pear.publicKey), kdf.hex(pubkyFromRaw.publicKey))
  assert.notEqual(kdf.hex(pear.publicKey), kdf.hex(identity.publicKey), 'derived identity differs from the raw-seed one')
})

test('input validation: root length, device id, epoch, mnemonic checksum', async () => {
  const { kdf } = await world()
  assert.throws(() => kdf.pubkySecretFromRoot(new Uint8Array(31)))
  assert.throws(() => kdf.pearDeviceSeedFromRoot(TEST_ROOT, 'Bad/Id'))
  assert.throws(() => kdf.pearDeviceSeedFromRoot(TEST_ROOT, 'a'.repeat(33)))
  assert.throws(() => kdf.pearDeviceSeedFromRoot(TEST_ROOT, 'ok', -1))
  const words = kdf.rootToMnemonic(TEST_ROOT).split(' ')
  words[0] = words[0] === 'abandon' ? 'ability' : 'abandon'
  assert.throws(() => kdf.mnemonicToRoot(words.join(' ')), /invalid mnemonic/)
})

test('different roots give different identities', async () => {
  const a = await world()
  const b = await world(new Uint8Array(32).fill(7))
  assert.notEqual(a.identity.z32, b.identity.z32)
})

test('independence from the WDK seed: no env access, no import outside the experiment', () => {
  const dir = path.resolve(import.meta.dirname, '../src')
  for (const f of fs.readdirSync(dir)) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8')
    assert.doesNotMatch(text, /process\.env|WDK_SEED|config\.wdk|from '\.\.\/\.\./, f)
  }
  assert.ok(SRC.length > 0)
})

test('hazard, documented: the 24-word encoding of the root is a VALID BIP-39 phrase', async () => {
  const { kdf } = await world()
  const { validateMnemonic } = await import('@scure/bip39')
  const { wordlist } = await import('@scure/bip39/wordlists/english.js')
  assert.equal(validateMnemonic(kdf.rootToMnemonic(TEST_ROOT), wordlist), true)
})
