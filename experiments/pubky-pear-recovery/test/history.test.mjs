import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { NOW, world } from './_helpers.mjs'

async function chain (n = 3) {
  const a = await world()
  const b = await world(new Uint8Array(32).fill(5))
  const entries = []
  for (let i = 0; i < n; i++) {
    const trade = { ref: `trade-${i}`, amountSats: 10_000 + i, asset: 'BTC', counterparty: b.identity.z32, outcome: 'completed' }
    entries.push(a.issue.cosignReceipt(b.identity, a.issue.appendReceipt(a.identity, entries, trade, NOW + i)))
  }
  return { a, b, entries }
}

test('portable history: a mutually signed, hash-chained history verifies with public keys only', async () => {
  const { a, entries } = await chain()
  const r = a.verify.verifyHistory(entries, { subject: a.identity.z32 })
  assert.equal(r.ok, true)
  assert.equal(r.count, 3)
})

test('tampering with an amount, reordering, or removing a middle entry is detected', async () => {
  const { a, entries } = await chain()
  const tampered = structuredClone(entries)
  tampered[1].body.trade.amountSats = 1
  assert.equal(a.verify.verifyHistory(tampered, { subject: a.identity.z32 }).reason, 'bad-signature')
  assert.equal(a.verify.verifyHistory([entries[1], entries[0], entries[2]], { subject: a.identity.z32 }).reason, 'seq-gap')
  assert.equal(a.verify.verifyHistory([entries[0], entries[2]], { subject: a.identity.z32 }).reason, 'seq-gap')
})

test('chain link: an entry with a wrong prev hash is rejected even if freshly signed', async () => {
  const { a, entries } = await chain()
  const bad = a.issue.appendReceipt(a.identity, entries.slice(0, 1), entries[1].body.trade, NOW + 9)
  bad.body.prev = '1'.repeat(64)
  const resigned = { body: bad.body, sig: a.kdf.hex(a.identity.sign((await import('../src/canonical.mjs')).signingBytes('SAILS-P2P-HISTORY-ENTRY-V1', bad.body))) }
  const withCosign = a.issue.cosignReceipt((await world(new Uint8Array(32).fill(5))).identity, resigned)
  assert.equal(a.verify.verifyHistory([entries[0], withCosign], { subject: a.identity.z32 }).reason, 'chain-broken')
})

test('counterparty co-signature is required, and a self co-signature is rejected', async () => {
  const { a, entries } = await chain()
  const noCosign = structuredClone(entries)
  delete noCosign[2].cosig
  assert.equal(a.verify.verifyHistory(noCosign, { subject: a.identity.z32 }).reason, 'cosign-invalid')
  const self = structuredClone(entries)
  self[0] = a.issue.cosignReceipt(a.identity, { body: self[0].body, sig: self[0].sig })
  assert.equal(a.verify.verifyHistory(self, { subject: a.identity.z32 }).reason, 'cosign-invalid')
})

test('history of identity A is not accepted as history of identity B', async () => {
  const { a, b, entries } = await chain()
  assert.equal(a.verify.verifyHistory(entries, { subject: b.identity.z32 }).reason, 'malformed')
})

test('data loss: a truncated tail is invisible without a pinned head, and detected with one', async () => {
  const { a, entries } = await chain(3)
  const head = a.verify.verifyHistory(entries, { subject: a.identity.z32 }).head
  const truncated = entries.slice(0, 2)
  assert.equal(a.verify.verifyHistory(truncated, { subject: a.identity.z32 }).ok, true, 'known limitation: no anchor, no detection')
  assert.equal(a.verify.verifyHistory(truncated, { subject: a.identity.z32, expectedHead: head }).reason, 'head-mismatch')
  assert.equal(a.verify.verifyHistory([], { subject: a.identity.z32, expectedHead: head }).reason, 'head-mismatch')
})

test('cross-integrator: a separate process with only public data verifies identity authorizations and history', async () => {
  const { a, entries } = await chain()
  const device = a.mkDevice('phone-1')
  const cert = a.issue.issueAuthorization(a.identity, { pearPublicKey: device.publicKey, deviceId: 'phone-1', scope: ['pear:connect', 'proof:present'], now: NOW, ttlSec: 3600 })
  const head = a.verify.verifyHistory(entries, { subject: a.identity.z32 }).head
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppr-'))
  const file = path.join(dir, 'bundle.json')
  fs.writeFileSync(file, JSON.stringify({ history: entries, head, authorizations: [cert] }))
  const script = path.resolve(import.meta.dirname, '../scripts/verify-bundle.mjs')
  assert.doesNotMatch(fs.readFileSync(script, 'utf8'), /issue\.mjs|kdf\.mjs/, 'verifier script must not import secret-side modules')
  const run = (sub, now) => spawnSync(process.execPath, [script, file, sub, String(now)], { encoding: 'utf8', env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } })
  const ok = run(a.identity.z32, NOW + 10)
  assert.equal(ok.status, 0, ok.stdout + ok.stderr)
  assert.equal(JSON.parse(ok.stdout).ok, true)
  const wrongSub = run((await world(new Uint8Array(32).fill(5))).identity.z32, NOW + 10)
  assert.equal(wrongSub.status, 1)
  const expired = run(a.identity.z32, NOW + 7200)
  assert.equal(expired.status, 1)
  assert.deepEqual(JSON.parse(expired.stdout).sessions, ['expired'])
  fs.rmSync(dir, { recursive: true, force: true })
})
