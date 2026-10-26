// Phase C: the homeserver is back. State and grants survived the outage.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { STATE_DIR, spawnRole } from '../lib.mjs'

const PASS = 'test-only-passphrase-do-not-reuse'
const s = JSON.parse(fs.readFileSync(`${STATE_DIR}/p04.json`, 'utf8'))

test('O4 after the outage: the same record verifies online, the saved integrator bearer still works, the signer signs in again', async () => {
  const verifier = spawnRole('role-verifier.mjs')
  const app = spawnRole('role-integrator.mjs')
  const signer = spawnRole('role-signer.mjs', { PPR_SIGNER_PASSPHRASE: PASS })
  try {
    const r = await verifier.ok('verify', { record: s.record, identity: s.identity, audience: 'market.example', now: Math.floor(Date.now() / 1000), online: true })
    assert.equal(r.ok, true, JSON.stringify(r))
    await app.ok('restore', { secret: s.bearer })
    await app.ok('put', { path: '/pub/sails.market/pear/devices/after-outage.json', json: { ok: 1 } })
    assert.equal((await signer.ok('load')).pk, s.identity)
  } finally { verifier.close(); app.close(); signer.close() }
})
