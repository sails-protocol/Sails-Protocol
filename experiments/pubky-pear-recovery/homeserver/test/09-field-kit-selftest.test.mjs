// Self-test of the field kit against the lab, with the SDK signer standing in for Pubky Ring. This proves the KIT works;
// it is NOT a Ring test. A real Ring run is a separate, authorized activity (REAL-DEVICE-TESTS.md).
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { STATE_DIR, closeAll, spawnRole } from '../lib.mjs'

const PASS = 'test-only-passphrase-do-not-reuse'
after(() => closeAll())
const FIELD = '/w/field'

function runKit (script, args, onLine) {
  const child = spawn(process.execPath, [path.join(FIELD, script), ...args], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'inherit'] })
  const lines = []
  readline.createInterface({ input: child.stdout }).on('line', (l) => { try { const o = JSON.parse(l); lines.push(o); onLine?.(o) } catch {} })
  return { child, lines }
}
const until = async (pred, ms = 40000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = pred(); if (v) return v; await new Promise((r) => setTimeout(r, 200)) } throw new Error('timeout waiting') }

test('F1 the integrator kit prints an auth URL, a signer approves it, records are published; the verifier kit accepts; after revocation the homeserver refuses the integrator', async () => {
  const identity = JSON.parse(fs.readFileSync(`${STATE_DIR}/identity.json`, 'utf8')).pk
  const signer = spawnRole('role-signer.mjs', { PPR_SIGNER_PASSPHRASE: PASS })
  await signer.ok('load')
  let approved = false
  const integ = runKit('integrator.mjs', ['--testnet-host', 'localhost', '--refresh', '2', '--duration', '120'], async (o) => { if (o.event === 'auth-url' && !approved) { approved = true; await signer.ok('approve', { url: o.url }) } })
  const granted = await until(() => integ.lines.find((l) => l.event === 'granted'))
  assert.equal(granted.identity, identity)
  await until(() => integ.lines.find((l) => l.event === 'published'))
  const ver = runKit('verifier.mjs', ['--identity', identity, '--pear', granted.pear, '--testnet-host', 'localhost', '--window', '300', '--every', '2', '--guard', `${STATE_DIR}/field-guard.json`])
  const ok = await until(() => ver.lines.find((l) => l.event === 'decision' && l.accept === true))
  assert.equal(ok.reason, 'ok')
  await signer.ok('revoke', { id: granted.grantId })
  const refused = await until(() => integ.lines.find((l) => l.event === 'refused-by-homeserver'))
  assert.match(refused.error, /401|403|Unauthorized|Forbidden/i)
  integ.child.kill(); ver.child.kill()
})

test('F2 the Pear echo probe passes its own loopback self-test', async () => {
  const k = runKit('pear-echo.mjs', ['--local-testnet', '--pings', '3', '--interval', '300'])
  const summary = await until(() => k.lines.find((l) => l.event === 'summary'), 60000)
  assert.equal(summary.pings, 3)
  k.child.kill()
})
