// Writes vectors/test-vectors.json from the public TEST root 00..1f.
// Every value is derived from that public root: none is a secret.
import fs from 'node:fs'
import path from 'node:path'
import { PREFIX, signingBytes } from '../src/canonical.mjs'
import { hex, pearDeviceSeedFromRoot, pearKeyPairFromSeed, pubkySecretFromRoot, restorePubkyIdentity, rootToMnemonic } from '../src/kdf.mjs'
import { issueAuthorization, issueRevocation, makePop } from '../src/issue.mjs'

const NOW = 1_800_000_000
const root = new Uint8Array(32).map((_, i) => i)
const identity = restorePubkyIdentity(pubkySecretFromRoot(root))
const devices = [['phone-1', 0], ['laptop-1', 0], ['phone-1', 1]]
const pear = devices.map(([deviceId, epoch]) => {
  const seed = pearDeviceSeedFromRoot(root, deviceId, epoch)
  return { deviceId, epoch, seed: hex(seed), publicKey: hex(pearKeyPairFromSeed(seed).publicKey) }
})
const phone = pearKeyPairFromSeed(pearDeviceSeedFromRoot(root, 'phone-1', 0))
const cert = issueAuthorization(identity, {
  pearPublicKey: phone.publicKey, deviceId: 'phone-1', scope: ['chat:send', 'chat:read', 'pear:connect'],
  now: NOW, ttlSec: 86400, id: '00112233445566778899aabbccddeeff'
})
const challenge = { nonce: 'ffeeddccbbaa99887766554433221100', audience: 'market.example', exp: NOW + 60 }
const pop = makePop(phone, cert, challenge)
const revocation = issueRevocation(identity, { targets: { dev: 'phone-1' }, now: NOW + 100 })

const out = {
  _warning: 'TEST VECTORS. Derived from the public test root 00..1f. Never use this root or any value here for real identities.',
  root: hex(root),
  mnemonic: rootToMnemonic(root),
  pubky: { secret: hex(pubkySecretFromRoot(root)), z32: identity.z32, publicKey: hex(identity.publicKey) },
  pear,
  authorization: { cert, signingInputPrefix: PREFIX.authorization, signingInputHex: hex(signingBytes(PREFIX.authorization, cert.body)) },
  challenge,
  pop,
  revocation
}
const file = path.resolve(import.meta.dirname, '../vectors/test-vectors.json')
fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n')
console.log('wrote', file)
