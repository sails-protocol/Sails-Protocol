// ROLE: external signer (stands for a Pubky signer app/device such as Ring). It is the ONLY
// process that holds the Pubky secret. It restores it from the recovery file, signs the user
// in with root capability, and approves/narrows/revokes grants requested by integrators.
import fs from 'node:fs'
import { HOMESERVER_PK, STATE_DIR, sdk, serve, testnet } from './lib.mjs'

let signer
let root
let manager

async function open (kp) {
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
  // Root-session storage operations (the user, acting through their own signer).
  async rootPut ({ path, json }) { await root.storage.putJson(path, json) },
  async rootGet ({ path }) { return root.storage.getJson(path) },
  async rootDelete ({ path }) { await root.storage.delete(path) }
})
