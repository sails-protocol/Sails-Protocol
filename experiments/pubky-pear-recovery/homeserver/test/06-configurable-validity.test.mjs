// Is a configurable grant validity supported? The official signer API hard-codes 2 years (checked in source:
// pubky-sdk/src/actors/auth/grant/constants.rs, signer/auth.rs). The PROTOCOL carries `exp` as a signed claim.
// This suite issues a 25 s grant from a lab signer and checks that the REAL homeserver and the SDK's offline
// verifier honour it. It is evidence about the protocol, NOT about what Pubky Ring does today.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import b4a from 'b4a'
import sodium from 'sodium-universal'
import { HOMESERVER_HTTP, HOMESERVER_PK, STATE_DIR, closeAll, sdk, spawnRole } from '../lib.mjs'

const PASS = 'test-only-passphrase-do-not-reuse'
const identity = JSON.parse(fs.readFileSync(`${STATE_DIR}/identity.json`, 'utf8')).pk
const b64u = (b) => Buffer.from(b).toString('base64url')
after(() => closeAll())

function jws (typ, claims, seed) {
  const input = `${b64u(JSON.stringify({ alg: 'EdDSA', typ }))}.${b64u(JSON.stringify(claims))}`
  const pk = b4a.alloc(32); const sk = b4a.alloc(64)
  sodium.crypto_sign_seed_keypair(pk, sk, b4a.from(seed))
  const sig = b4a.alloc(64)
  sodium.crypto_sign_detached(sig, b4a.from(input), sk)
  return `${input}.${b64u(sig)}`
}
const now = () => Math.floor(Date.now() / 1000)

test('V1 a short-lived grant (25 s) is accepted by the real homeserver, the bearer is capped to it, and everything stops at expiry', async () => {
  const signer = spawnRole('role-signer.mjs', { PPR_SIGNER_PASSPHRASE: PASS })
  const client = sdk.Keypair.random()
  const clientSeed = client.secret()
  await signer.ok('load')
  const { grant, claims } = await signer.ok('issueGrant', { clientPk: client.publicKey.z32(), caps: ['/pub/sails.market/pear/:rw'], clientId: 'short.example', ttl: 25 })
  assert.equal(claims.exp - claims.iat, 25)
  const pop = () => jws('pubky-pop', { aud: HOMESERVER_PK, gid: claims.jti, nonce: b64u(crypto.randomBytes(16)), iat: now() }, clientSeed)
  const exchange = async () => fetch(`${HOMESERVER_HTTP}/auth/grant/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant, pop: pop() }) })

  const res = await exchange()
  const text = await res.text()
  assert.equal(res.status, 200, text)
  const body = JSON.parse(text)
  assert.equal(body.session.grant_expires_at, claims.exp)
  assert.ok(body.session.token_expires_at <= claims.exp, 'bearer is capped by the grant expiry')
  const put = (token) => fetch(`${HOMESERVER_HTTP}/pub/sails.market/pear/devices/short.json`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'pubky-host': identity, 'content-type': 'application/json' }, body: '{"short":1}' })
  assert.ok((await put(body.token)).status < 300, 'write works while valid')

  // Offline verification by a third party: a custom PoP signed by the client key, checked by the official SDK verifier.
  const customPop = () => ({ grant, pop: jws('pubky-custom-pop-v1', { gid: claims.jti, iat: now(), nonce: b64u(crypto.randomBytes(16)), data: { hello: 'short' } }, clientSeed) })
  assert.equal(sdk.verifyCustomGrantPop(customPop()).identity, identity)

  await new Promise((r) => setTimeout(r, 27000))
  assert.equal((await put(body.token)).status, 401, 'write refused after the grant expired')
  assert.ok((await exchange()).status >= 400, 'no new bearer after expiry')
  assert.throws(() => sdk.verifyCustomGrantPop(customPop()), /expired/i)
})
