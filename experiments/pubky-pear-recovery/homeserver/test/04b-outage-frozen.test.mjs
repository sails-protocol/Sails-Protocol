// Phase B: the homeserver process is FROZEN (docker pause): connections are accepted by the kernel but
// nothing answers. Every call below is bounded by the caller, because Pubky 0.16.2 sets no deadline.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { STATE_DIR, spawnRole } from '../lib.mjs'

const PASS = 'test-only-passphrase-do-not-reuse'
const s = JSON.parse(fs.readFileSync(`${STATE_DIR}/p04.json`, 'utf8'))
const now = () => Math.floor(Date.now() / 1000)

test('O1 offline pieces keep working without the homeserver: statement + grant signature verify (they prove nothing about revocation)', async () => {
  const verifier = spawnRole('role-verifier.mjs')
  try {
    const r = await verifier.ok('verify', { record: s.record, identity: s.identity, audience: 'market.example', now: now(), online: false })
    assert.equal(r.ok, true)
  } finally { verifier.close() }
})

test('O2 fail closed: with the homeserver unreachable, a NEW authorization is refused because revocation cannot be established', async () => {
  const verifier = spawnRole('role-verifier.mjs')
  try {
    const t0 = Date.now()
    const r = await verifier.ok('verify', { record: s.record, identity: s.identity, audience: 'market.example', now: now(), online: true })
    assert.deepEqual([r.ok, r.reason], [false, 'revocation-status-unavailable'])
    assert.ok(Date.now() - t0 < 15000, 'bounded by the 8s probe deadline')
  } finally { verifier.close() }
})

test('O3 every operation fails during the outage and none returns success; we record WHO bounded it (SDK or caller)', async () => {
  const signer = spawnRole('role-signer.mjs', { PPR_SIGNER_PASSPHRASE: PASS })
  const verifier = spawnRole('role-verifier.mjs')
  const app = spawnRole('role-integrator.mjs')
  const seen = {}
  const probe = async (label, role, cmd, args) => {
    const t0 = Date.now()
    const e = await role.fails(cmd, args, 9000)
    seen[label] = { ms: Date.now() - t0, by: /timeout after/.test(e.message) ? 'caller (SDK had no deadline here)' : 'SDK', error: e.message.slice(0, 70) }
  }
  try {
    await probe('signin (PKARR resolution)', signer, 'load', {})
    await probe('public discovery (list)', verifier, 'discover', { identity: s.identity })
    await probe('restore a saved grant session', app, 'restore', { secret: s.bearer })
    console.log(JSON.stringify(seen, null, 1))
    assert.equal(Object.keys(seen).length, 3)
    assert.ok(Object.values(seen).every((v) => v.ms <= 9500), 'no operation outlived the 9s harness bound')
  } finally { signer.close(); verifier.close(); app.close() }
})