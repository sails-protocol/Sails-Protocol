// P2P recovery root -> Pubky identity secret + Pear device seeds.
//
// The root is 32 random bytes generated for this purpose. It is NOT the WDK
// (financial) seed and nothing here reads WDK configuration.
//
// Pubky's Keypair.fromSecret() and HyperDHT's DHT.keyPair(seed) both take a raw
// Ed25519 seed, so the SAME 32 bytes give the SAME public key in both. Using the
// root (or one derived value) for both would silently collapse the two identities.
// Every key therefore comes from a distinct HKDF info label.
import { hkdfSync, randomBytes } from 'node:crypto'
import b4a from 'b4a'
import sodium from 'sodium-universal'
import DHT from 'hyperdht'
import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { pubky } from './pubkyid.mjs'

const SALT = b4a.from('sails-p2p-recovery-root-v1', 'utf8')
export const INFO = Object.freeze({
  pubkyIdentity: 'sails/p2p/v1/pubky/identity',
  pearDevicePrefix: 'sails/p2p/v1/pear/device'
})
const DEVICE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/

export function newRoot () {
  return new Uint8Array(randomBytes(32))
}

function assertRoot (root) {
  if (!(root instanceof Uint8Array) || root.length !== 32) throw new Error('root must be 32 bytes')
}

export function hkdf32 (root, info) {
  assertRoot(root)
  return new Uint8Array(hkdfSync('sha256', root, SALT, b4a.from(info, 'utf8'), 32))
}

// 24-word BIP-39 *encoding* of the root. It is a valid BIP-39 phrase, which is a UX
// hazard (a wallet would accept it and derive an unrelated, empty wallet); see ADR.
export function rootToMnemonic (root) {
  assertRoot(root)
  return entropyToMnemonic(root, wordlist)
}

export function mnemonicToRoot (mnemonic) {
  const m = mnemonic.trim().split(/\s+/).join(' ')
  if (!validateMnemonic(m, wordlist)) throw new Error('invalid mnemonic')
  return mnemonicToEntropy(m, wordlist)
}

export function pubkySecretFromRoot (root) {
  return hkdf32(root, INFO.pubkyIdentity)
}

export function pearDeviceSeedFromRoot (root, deviceId, epoch = 0) {
  if (!DEVICE_ID.test(deviceId)) throw new Error('invalid deviceId')
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('invalid epoch')
  return hkdf32(root, `${INFO.pearDevicePrefix}/${deviceId}/epoch/${epoch}`)
}

// Identity as seen through the real Pubky SDK. The Ed25519 public key is also
// computed with libsodium and compared: if a future SDK changes how a 32-byte
// secret maps to a key, restore fails closed instead of producing another identity.
export function restorePubkyIdentity (secret) {
  const kp = pubky.Keypair.fromSecret(secret)
  const sdkPk = b4a.from(kp.publicKey.toUint8Array())
  const pk = b4a.alloc(32)
  const sk = b4a.alloc(64)
  sodium.crypto_sign_seed_keypair(pk, sk, b4a.from(secret))
  if (!b4a.equals(pk, sdkPk)) throw new Error('Pubky SDK key does not match the Ed25519 seed contract')
  const z32 = kp.publicKey.z32()
  kp.free()
  return {
    z32,
    publicKey: new Uint8Array(pk),
    sign (message) {
      const sig = b4a.alloc(64)
      sodium.crypto_sign_detached(sig, message, sk)
      return new Uint8Array(sig)
    },
    zeroize () { sodium.sodium_memzero(sk) }
  }
}

export function pearKeyPairFromSeed (seed) {
  const kp = DHT.keyPair(b4a.from(seed))
  return {
    publicKey: new Uint8Array(kp.publicKey),
    keyPair: kp,
    sign (message) {
      const sig = b4a.alloc(64)
      sodium.crypto_sign_detached(sig, message, kp.secretKey)
      return new Uint8Array(sig)
    }
  }
}

export function hex (bytes) { return b4a.toString(b4a.from(bytes), 'hex') }
export function unhex (s) { return new Uint8Array(b4a.from(s, 'hex')) }
