// RED/GREEN evidence. GREEN: the suite passes on the real source. RED: each mutant is a
// copy of src/ with exactly one check removed; the suite must FAIL on it.
// Usage: node scripts/red-green.mjs   (writes .mutants/, removed at the end)
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const SUITE = ['test/kdf.test.mjs', 'test/authorization.test.mjs', 'test/negative.test.mjs', 'test/history.test.mjs', 'test/modes.test.mjs']

const MUTANTS = [
  ['M1 no authorization signature check', 'verify.mjs', "if (!verifySig(pk, signingBytes(PREFIX.authorization, b), cert.sig)) return fail('bad-signature')", ''],
  ['M2 no expiry check', 'verify.mjs', "if (now >= b.exp) return fail('expired')", ''],
  ['M3 no not-before check', 'verify.mjs', "if (now < b.iat - SKEW_SEC) return fail('not-yet-valid')", ''],
  ['M4 no lifetime cap', 'verify.mjs', "if (b.exp <= b.iat || b.exp - b.iat > maxTtlSec) return fail('ttl-invalid')", ''],
  ['M5 subject not pinned', 'verify.mjs', "if (expectedSub !== undefined && b.sub !== expectedSub) return fail('wrong-subject')", ''],
  ['M6 scope not enforced', 'verify.mjs', "if (requiredScope !== undefined && !b.scope.includes(requiredScope)) return fail('scope-missing')", ''],
  ['M7 challenge reusable (replay)', 'verify.mjs', 'this.#open.delete(nonce)', ''],
  ['M8 challenge not bound to audience', 'verify.mjs', 'c.audience === audience && ', ''],
  ['M9 no proof of possession', 'verify.mjs', "if (!verifySig(b4a.from(a.body.pear, 'hex'), signingBytes(PREFIX.pop, popBody(a.body, challenge)), pop?.sig)) return fail('pop-invalid')", ''],
  ['M10 revocation ignored', 'verify.mjs', "if (isRevoked(a.body, r.statements)) return fail('revoked')", ''],
  ['M11 revocation fails OPEN when source is down', 'verify.mjs', "if (r === null) return fail('revocation-unavailable')", "if (r === null) return { ok: true, body: a.body, revocationStale: true }"],
  ['M12 revocation signature not verified', 'verify.mjs', 'return !!pk && verifySig(pk, signingBytes(PREFIX.revocation, b), rev.sig)', 'return true'],
  ['M13 stale cache never expires', 'verify.mjs', 'now - c.at <= this.#maxStaleSec', 'true'],
  ['M14 same seed for Pubky and Pear (no domain separation)', 'kdf.mjs', "return hkdf32(root, `${INFO.pearDevicePrefix}/${deviceId}/epoch/${epoch}`)", 'return hkdf32(root, INFO.pubkyIdentity)'],
  ['M15 device epoch ignored', 'kdf.mjs', "/epoch/${epoch}`", "`"],
  ['M16 history chain link not checked', 'verify.mjs', "if (b.prev !== prev) return fail('chain-broken', { index: i })", ''],
  ['M17 history signature not checked', 'verify.mjs', "if (!verifySig(pk, signingBytes(PREFIX.history, b), e.sig)) return fail('bad-signature', { index: i })", ''],
  ['M18 history co-signature not required', 'verify.mjs', "if (requireCosign) {", 'if (false) {'],
  ['M19 head anchor ignored', 'verify.mjs', 'if (expectedHead &&', 'if (false &&'],
  ['M20 SDK key/seed contract guard removed', 'kdf.mjs', "if (!b4a.equals(pk, sdkPk)) throw new Error('Pubky SDK key does not match the Ed25519 seed contract')", '']
]

function run (srcDir) {
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...SUITE], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PPR_SRC: srcDir }, maxBuffer: 64 * 1024 * 1024
  })
  const out = r.stdout + r.stderr
  const failed = [...out.matchAll(/^\s*✖ (.+?) \(\d/gm)].map((m) => m[1])
  return { status: r.status, failed: [...new Set(failed)], pass: Number((out.match(/ℹ pass (\d+)/) ?? [])[1]), fail: Number((out.match(/ℹ fail (\d+)/) ?? [])[1]) }
}

const green = run(path.join(root, 'src'))
console.log(`GREEN real source: exit=${green.status} pass=${green.pass} fail=${green.fail}`)
let bad = green.status !== 0
const rows = []
for (const [name, file, from, to] of MUTANTS) {
  const dir = path.join(root, '.mutants', name.split(' ')[0].toLowerCase(), 'src')
  fs.rmSync(path.dirname(dir), { recursive: true, force: true })
  fs.cpSync(path.join(root, 'src'), dir, { recursive: true })
  const target = path.join(dir, file)
  const text = fs.readFileSync(target, 'utf8')
  const count = text.split(from).length - 1
  if (count !== 1) { console.log(`MUTANT ${name}: patch target found ${count} times (expected 1) -> harness error`); bad = true; continue }
  fs.writeFileSync(target, text.replace(from, () => to))
  const r = run(dir)
  const detected = r.status !== 0 && r.fail > 0
  if (!detected) bad = true
  rows.push({ name, detected, fail: r.fail, failed: r.failed })
  console.log(`RED ${detected ? 'detected ' : 'SURVIVED '} ${name}: fail=${r.fail}${r.failed.length ? ' [' + r.failed.slice(0, 3).join(' | ') + (r.failed.length > 3 ? ' | ...' : '') + ']' : ''}`)
}
fs.rmSync(path.join(root, '.mutants'), { recursive: true, force: true })
console.log(`\nmutants: ${rows.filter((r) => r.detected).length}/${MUTANTS.length} detected`)
process.exit(bad ? 1 : 0)
