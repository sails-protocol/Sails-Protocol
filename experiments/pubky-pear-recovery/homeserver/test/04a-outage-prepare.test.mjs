// Phase A (homeserver up): create the state that phases B (homeserver frozen) and C (back) will use.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { PEAR_DIR, STATE_DIR, sdk, spawnRole } from '../lib.mjs'
import { KIND, SCOPES, capsFor } from '../policy.mjs'

const PASS = 'test-only-passphrase-do-not-reuse'

test('O0 prepare: an authorized Pear session is published, and the integrator bearer is saved', async () => {
  const identity = JSON.parse(fs.readFileSync(`${STATE_DIR}/identity.json`, 'utf8')).pk
  const signer = spawnRole('role-signer.mjs', { PPR_SIGNER_PASSPHRASE: PASS })
  const app = spawnRole('role-integrator.mjs')
  try {
    await signer.ok('load')
    const { url } = await app.ok('start', { caps: capsFor(SCOPES), clientId: 'wallet.example' })
    const waiting = app.ok('await')
    await signer.ok('approve', { url })
    await waiting
    const { publicKey } = await app.ok('newPearKey', { name: 'outage-1' })
    const iat = Math.floor(Date.now() / 1000)
    const cp = await app.ok('customPop', { data: { v: 1, kind: KIND, pear: publicKey, dev: 'outage-1', scope: ['pear:connect'], aud: '*', iat, exp: iat + 3000 } })
    const claims = JSON.parse(Buffer.from(cp.grant.split('.')[1], 'base64url').toString('utf8'))
    const { sig } = await app.ok('pearSign', { name: 'outage-1', grantJti: claims.jti, nonce: sdk.verifyCustomGrantPop(cp).nonce, pear: publicKey })
    const record = { v: 1, cp, pearSig: sig }
    await app.ok('put', { path: `${PEAR_DIR}/devices/${publicKey}.json`, json: record })
    fs.writeFileSync(`${STATE_DIR}/p04.json`, JSON.stringify({ identity, record, name: `${publicKey}.json`, bearer: await app.ok('bearerExport') }))
    assert.ok(fs.statSync(`${STATE_DIR}/p04.json`).size > 100)
  } finally { signer.close(); app.close() }
})
