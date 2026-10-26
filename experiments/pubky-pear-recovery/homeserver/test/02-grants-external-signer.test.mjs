// Native Pubky grants with an EXTERNAL signer: the integrator never receives the Pubky secret.
// Roles are separate OS processes; only the signer process can read the recovery file's passphrase.
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { STATE_DIR, sdk, spawnRole } from '../lib.mjs'

const PASS = 'test-only-passphrase-do-not-reuse'
const CAPS = '/pub/sails.market/pear/:rw'
let signer
let identity

before(async () => {
  identity = JSON.parse(fs.readFileSync(`${STATE_DIR}/identity.json`, 'utf8')).pk
  signer = spawnRole('role-signer.mjs', { PPR_SIGNER_PASSPHRASE: PASS })
  assert.equal((await signer.ok('load')).pk, identity)
})
after(() => signer.close())

async function grant (clientId, caps, approveCaps) {
  const app = spawnRole('role-integrator.mjs') // minimal env: no passphrase, no secret
  const { url } = await app.ok('start', { caps, clientId })
  const waiting = app.ok('await')
  await signer.ok('approve', { url, caps: approveCaps })
  return { app, info: await waiting }
}

test('G1 grant with an external signer: integrator gets a session for the user without ever holding the secret', async () => {
  const { app, info } = await grant('wallet.example', CAPS)
  try {
    assert.equal(info.pk, identity)
    assert.deepEqual(info.caps, [CAPS])
    assert.equal(info.clientId, 'wallet.example')
    assert.deepEqual(await app.ok('hasEnvSecret'), [], 'integrator process has no secret-like environment')
    // The bearer-equivalent export must not contain the Pubky secret in any common encoding. The test
    // (not the integrator) decrypts the recovery file only to know what bytes to look for.
    const secret = Buffer.from(sdk.Keypair.fromRecoveryFile(new Uint8Array(fs.readFileSync(`${STATE_DIR}/recovery.bin`)), PASS).secret())
    const forms = [secret.toString('hex'), secret.toString('base64'), secret.toString('base64url'), secret.toString('base64').replace(/=+$/, '')]
    const exported = await app.ok('bearerExport')
    assert.ok(typeof exported === 'string' && exported.length > 20)
    for (const form of forms) assert.equal(exported.includes(form), false, 'secret leaked in export')
    // The root-signed grant names the user as issuer but binds a DIFFERENT key (cnf) for the client.
    const cp = await app.ok('customPop', { data: { probe: 1 } })
    const claims = JSON.parse(Buffer.from(cp.grant.split('.')[1], 'base64url').toString('utf8'))
    assert.equal(claims.iss, identity)
    assert.notEqual(claims.cnf, identity, 'client proof-of-possession key is not the identity key')
    for (const form of forms) assert.equal(JSON.stringify(cp).includes(form), false)
  } finally { app.close() }
})

test('G2 capability scope is enforced by the homeserver: inside ok, outside and sibling paths denied', async () => {
  const { app } = await grant('wallet.example', CAPS)
  try {
    await app.ok('put', { path: '/pub/sails.market/pear/devices/x.json', json: { x: 1 } })
    for (const path of ['/pub/sails.market/profile.json', '/pub/other/y.json', '/priv/z.json']) {
      const e = await app.fails('put', { path, json: { y: 1 } })
      assert.match(e.message, /40[13]/, path)
    }
  } finally { app.close() }
})

test('G3 the signer can narrow what the integrator asked for (read-only): writes are then denied', async () => {
  const { app, info } = await grant('market.example', '/pub/sails.market/pear/:rw,/pub/sails.market/contacts/:rw', '/pub/sails.market/pear/:r')
  try {
    assert.deepEqual(info.caps, ['/pub/sails.market/pear/:r'])
    const e = await app.fails('put', { path: '/pub/sails.market/pear/devices/n.json', json: { n: 1 } })
    assert.match(e.message, /40[13]/)
  } finally { app.close() }
})

test('G4 the signer sees every grant (client, caps, lifetime); observation: default lifetime is 2 years and the signer API cannot shorten it', async () => {
  const list = await signer.ok('grants')
  const wallet = list.filter((g) => g.clientId === 'wallet.example')
  assert.ok(wallet.length >= 1)
  const lifetimes = new Set(list.filter((g) => g.clientId !== 'signer.local').map((g) => g.exp - g.iat))
  console.log('grant lifetimes (s):', [...lifetimes].join(','))
  assert.deepEqual([...lifetimes], [63072000])
})

test('G5 revocation by the signer: that integrator is cut off at the homeserver, another one is untouched', async () => {
  const a = await grant('wallet.example', CAPS)
  const b = await grant('market.example', CAPS)
  try {
    await a.app.ok('put', { path: '/pub/sails.market/pear/devices/a.json', json: { a: 1 } })
    await signer.ok('revoke', { id: a.info.grantId })
    const e = await a.app.fails('put', { path: '/pub/sails.market/pear/devices/a2.json', json: { a: 2 } })
    assert.match(e.message, /401|403/)
    await b.app.ok('put', { path: '/pub/sails.market/pear/devices/b.json', json: { b: 1 } })
    const ids = (await signer.ok('grants')).map((g) => g.id)
    assert.equal(ids.includes(a.info.grantId), false)
    assert.equal(ids.includes(b.info.grantId), true)
  } finally { a.app.close(); b.app.close() }
})
