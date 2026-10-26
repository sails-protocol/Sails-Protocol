// ROLE: external signer (stands for a Pubky signer app/device such as Ring). It is the ONLY
// process that holds the Pubky secret. It restores it from the recovery file, signs the user
// in with root capability, and approves/narrows/revokes grants requested by integrators.
import fs from 'node:fs'
import b4a from 'b4a'
import sodium from 'sodium-universal'
import { HOMESERVER_PK, STATE_DIR, sdk, serve, testnet } from './lib.mjs'

let signer
let root
let manager
let rootKp

const b64u = (b) => Buffer.from(b).toString('base64url')
// Compact JWS exactly as pubky-common/src/auth/jws.rs: header {"alg":"EdDSA","typ":T}, Ed25519 over b64(header).b64(payload)
function jws (typ, claims, seed) {
  const input = `${b64u(JSON.stringify({ alg: 'EdDSA', typ }))}.${b64u(JSON.stringify(claims))}`
  const pk = b4a.alloc(32)
  const sk = b4a.alloc(64)
  sodium.crypto_sign_seed_keypair(pk, sk, b4a.from(seed))
  const sig = b4a.alloc(64)
  sodium.crypto_sign_detached(sig, b4a.from(input), sk)
  return `${input}.${b64u(sig)}`
}

async function open (kp) {
  rootKp = kp
  signer = testnet().signer(kp)
  root = await signer.signin('signer.local')
  manager = new sdk.GrantManager(root)
  return { pk: kp.publicKey.z32() }
}

serve({
  // First run on a new account: create the identity, sign up, save an encrypted recovery file.
  async create ({ file = `${STATE_DIR}/recovery.bin` } = {}) {
    const kp = sdk.Keypair.random()
    signer = testnet().signer(kp)
    await signer.signup(sdk.PublicKey.from(HOMESERVER_PK), null)
    fs.writeFileSync(file, kp.createRecoveryFile(process.env.PPR_SIGNER_PASSPHRASE))
    return open(kp)
  },
  // Any later run (reinstall, new device): only the recovery file and the passphrase exist.
  async load ({ file = `${STATE_DIR}/recovery.bin` } = {}) {
    const bytes = fs.readFileSync(file)
    return open(sdk.Keypair.fromRecoveryFile(new Uint8Array(bytes), process.env.PPR_SIGNER_PASSPHRASE))
  },
  async approve ({ url, caps }) {
    if (caps) await signer.approveAuthWithCapabilities(url, caps)
    else await signer.approveAuthRequest(url)
  },
  async grants () {
    return (await manager.list()).map((g) => ({ id: g.grantId, clientId: g.clientId, caps: g.capabilities, iat: g.issuedAt, exp: g.expiresAt }))
  },
  async revoke ({ id }) { await manager.revoke(id) },
  // LAB ONLY: what a signer implementation could do at protocol level. The official SDK signer hard-codes 2 years;
  // the protocol carries `exp` as a signed claim, so a signer may issue a short-lived grant. Used to test whether the
  // homeserver and the offline verifier honour a short `exp`.
  async issueGrant ({ clientPk, caps, clientId, ttl }) {
    const iat = Math.floor(Date.now() / 1000)
    const jti = b64u(globalThis.crypto.getRandomValues(new Uint8Array(16)))
    const claims = { iss: rootKp.publicKey.z32(), client_id: clientId, caps, cnf: clientPk, jti, iat, exp: iat + ttl }
    return { grant: jws('pubky-grant', claims, rootKp.secret()), claims }
  },
  // Root-session storage operations (the user, acting through their own signer).
  async rootPut ({ path, json }) { await root.storage.putJson(path, json) },
  async rootGet ({ path }) { return root.storage.getJson(path) },
  async rootDelete ({ path }) { await root.storage.delete(path) }
})
