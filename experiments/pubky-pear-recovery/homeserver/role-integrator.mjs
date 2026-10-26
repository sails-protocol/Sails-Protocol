// ROLE: integrator app (Satsails Wallet, Sails Market, ...). It holds NO Pubky secret: it asks a
// signer for a grant and then acts only within the granted capabilities. It also owns a Pear
// (HyperDHT) device key, generated here and never derived from anything.
import b4a from 'b4a'
import sodium from 'sodium-universal'
import DHT from 'hyperdht'
import { RELAY, sdk, serve, testnet } from './lib.mjs'
import { signingInput } from './policy.mjs'

import { Chain, bindingRevocation, commitParty, commitTrade, input as sailsInput, keyFromSeed } from '../portable/src/issue.mjs'

const pubky = testnet()
let flow
let session
let participant
let chain
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
  // ---- portable identity lab (portable/SPEC.md): the Participant key lives HERE, the Pubky secret never does ----
  async portableInit () {
    participant = keyFromSeed(new Uint8Array(globalThis.crypto.getRandomValues(new Uint8Array(32))))
    chain = new Chain(participant)
    return { participant: participant.pk }
  },
  // Pubky side = the SDK's own grant session + custom PoP (real JWS). Sails side = the participant signature.
  async portableBinding ({ audience, iat, ttl }) {
    const info = await session.grant.sessionInfo()
    const statement = { v: 1, kind: 'binding', pubky: session.info.publicKey.z32(), participant: participant.pk, audience, nonce: b4a.toString(b4a.from(globalThis.crypto.getRandomValues(new Uint8Array(16))), 'hex'), iat, exp: iat + ttl }
    const pop = await session.grant.createCustomPop(statement)
    return { statement, participantSig: participant.sign(sailsInput('binding-participant', statement)), grant: pop.grant, delegatePop: pop.pop, grantId: info.grantId }
  },
  async portableTrade ({ tradeRef, counterparty, outcome, iat }) {
    const tradeSalt = b4a.toString(b4a.from(globalThis.crypto.getRandomValues(new Uint8Array(32))), 'hex')
    const partySalt = b4a.toString(b4a.from(globalThis.crypto.getRandomValues(new Uint8Array(32))), 'hex')
    const tradeCommit = commitTrade(tradeSalt, tradeRef)
    const fact = chain.append({ tradeCommit, counterpartyCommit: commitParty(partySalt, counterparty), outcome, iat })
    return { fact, opening: { tradeRef, tradeSalt, counterparty, partySalt }, tradeCommit }
  },
  async portableHead ({ iat }) { return chain.head(iat) },
  async portableRevoke ({ pubky, iat }) { return bindingRevocation(participant, pubky, iat) },
  async hasEnvSecret () { return Object.keys(process.env).filter((k) => /PASS|SECRET|SEED|KEY/i.test(k)) }
})
