// ROLE: integrator app (Satsails Wallet, Sails Market, ...). It holds NO Pubky secret: it asks a
// signer for a grant and then acts only within the granted capabilities. It also owns a Pear
// (HyperDHT) device key, generated here and never derived from anything.
import b4a from 'b4a'
import sodium from 'sodium-universal'
import DHT from 'hyperdht'
import { RELAY, sdk, serve, testnet } from './lib.mjs'
import { signingInput } from './policy.mjs'

const pubky = testnet()
let flow
let session
const pear = new Map()

serve({
  async start ({ caps, clientId }) {
    flow = await pubky.startGrantAuthFlow(caps, sdk.AuthFlowKind.signin(), { clientId, relay: RELAY })
    return { url: String(flow.authorizationUrl) }
  },
  async await () {
    session = await flow.awaitApproval()
    const info = await session.grant.sessionInfo()
    return { pk: session.info.publicKey.z32(), caps: session.info.capabilities, grantId: info.grantId, clientId: info.clientId, iat: info.createdAt, exp: info.grantExpiresAt }
  },
  async put ({ path, json }) { await session.storage.putJson(path, json) },
  async get ({ path }) { return session.storage.getJson(path) },
  async del ({ path }) { await session.storage.delete(path) },
  async bearerExport () { return session.grant.exportLocalSecret() },
  async newPearKey ({ name }) {
    const kp = DHT.keyPair() // fresh random: B model, nothing derived
    pear.set(name, kp)
    return { publicKey: b4a.toString(kp.publicKey, 'hex') }
  },
  // The Pubky grant (root-signed) + this client's proof-of-possession key sign the statement ...
  async customPop ({ data }) { return session.grant.createCustomPop(data) },
  // ... and the Pear key signs a binding over that proof, so the Pear holder consents too.
  async pearSign ({ name, grantJti, nonce, pear: pearHex, extra }) {
    const sig = b4a.alloc(64)
    sodium.crypto_sign_detached(sig, signingInput({ grantJti, nonce, pear: pearHex, extra }), pear.get(name).secretKey)
    return { sig: b4a.toString(sig, 'hex') }
  },
  async pearSignRaw ({ name, inputHex }) {
    const sig = b4a.alloc(64)
    sodium.crypto_sign_detached(sig, b4a.from(inputHex, 'hex'), pear.get(name).secretKey)
    return { sig: b4a.toString(sig, 'hex') }
  },
  async restore ({ secret }) { session = await pubky.restoreSession(secret); return { ok: true } },
  async hasEnvSecret () { return Object.keys(process.env).filter((k) => /PASS|SECRET|SEED|KEY/i.test(k)) }
})
