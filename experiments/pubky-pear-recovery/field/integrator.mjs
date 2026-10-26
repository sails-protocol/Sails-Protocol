// FIELD KIT - integrator side. Run it on a laptop; approve the printed pubkyauth:// URL in Pubky Ring (paste it or scan it).
// It never sees the Pubky secret. Disposable identities only. Mainnet mode contacts the default Pubky relay and PKARR network:
// only run it with the operator's authorization (CTO decision on #545, point 4).
//   node field/integrator.mjs --testnet-host localhost            (lab)
//   node field/integrator.mjs                                      (mainnet defaults)
//   options: --client-id wallet.example  --refresh 60  --duration 1800  --scopes pear:connect,chat:send
import { createRequire } from 'node:module'
import b4a from 'b4a'
import sodium from 'sodium-universal'
import DHT from 'hyperdht'
import { KIND, SCOPES, capsFor, signingInput } from '../homeserver/policy.mjs'

const require = createRequire(import.meta.url)
const sdk = require('@synonymdev/pubky')
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d }
const host = arg('testnet-host')
const clientId = arg('client-id', 'wallet.example')
const refresh = Number(arg('refresh', 60))
const duration = Number(arg('duration', 1800))
const scopes = arg('scopes', 'pear:connect,chat:send').split(',')
const out = (o) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }))
if (scopes.some((s) => !SCOPES.includes(s))) throw new Error('unknown scope')

const pubky = host ? sdk.Pubky.testnet(host) : new sdk.Pubky()
const pear = DHT.keyPair() // fresh, random, never derived (model B)
const caps = capsFor(scopes)
const flow = await pubky.startGrantAuthFlow(caps, sdk.AuthFlowKind.signin(), { clientId, ...(host ? { relay: `http://${host}:15412/link/` } : {}) })
out({ event: 'auth-url', url: String(flow.authorizationUrl), caps, clientId, sdk: '@synonymdev/pubky 0.16.2' })
const session = await flow.awaitApproval()
const info = await session.grant.sessionInfo()
const identity = session.info.publicKey.z32()
out({ event: 'granted', identity, caps: session.info.capabilities, grantId: info.grantId, grantExpiresAt: info.grantExpiresAt, pear: b4a.toString(pear.publicKey, 'hex') })

let seq = 0
const t0 = Date.now()
async function publish () {
  const iat = Math.floor(Date.now() / 1000)
  const cp = await session.grant.createCustomPop({ v: 1, kind: KIND, pear: b4a.toString(pear.publicKey, 'hex'), dev: 'field-1', scope: scopes, aud: '*', iat, exp: iat + 600, seq: ++seq })
  const claims = JSON.parse(Buffer.from(cp.grant.split('.')[1], 'base64url').toString('utf8'))
  const nonce = sdk.verifyCustomGrantPop(cp).nonce
  const sig = b4a.alloc(64)
  sodium.crypto_sign_detached(sig, signingInput({ grantJti: claims.jti, nonce, pear: b4a.toString(pear.publicKey, 'hex') }), pear.secretKey)
  const record = { v: 1, cp, pearSig: b4a.toString(sig, 'hex') }
  try {
    await session.storage.putJson(`/pub/sails.market/pear/devices/${b4a.toString(pear.publicKey, 'hex')}.json`, record)
    out({ event: 'published', seq })
  } catch (e) {
    // After the user revokes the grant in Ring this is where it shows: the homeserver refuses the write.
    out({ event: 'refused-by-homeserver', seq, error: String(e.message).slice(0, 120) })
  }
}
await publish()
const timer = setInterval(async () => {
  if ((Date.now() - t0) / 1000 > duration) { clearInterval(timer); out({ event: 'done' }); process.exit(0) }
  await publish()
}, refresh * 1000)
