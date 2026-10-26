// Lab format v1 (portable/SPEC.md): verifier cases with hand-written expectations, cross-implementation agreement,
// canonical-form properties and privacy of the public record. scripts/red-green-portable.mjs points PORTABLE_SRC at broken copies.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '../portable')
const SRC = process.env.PORTABLE_SRC ? path.resolve(process.env.PORTABLE_SRC) : path.join(ROOT, 'src')
const V = await import(pathToFileURL(path.join(SRC, 'verify.mjs')).href)
const I = await import(pathToFileURL(path.join(ROOT, 'src/issue.mjs')).href)
const vec = JSON.parse(fs.readFileSync(path.join(ROOT, 'vectors/portable-v1.json'), 'utf8'))

function run (c) {
  const o = c.opts ?? {}
  const args = { now: o.now ?? vec.now, audience: o.audience ?? vec.audience }
  return c.type === 'binding' ? V.verifyBinding(c.input, { ...args, requireLevel: o.requireLevel ?? 'root-consented' }) : V.verifyPortable(c.input, { ...args, pinnedHead: o.pinnedHead, expectedPubky: o.expectedPubky })
}
const matches = (res, exp) => Object.entries(exp).every(([k, v]) => (k === 'reputation' ? JSON.stringify(res.reputation) === JSON.stringify(v) : res[k] === v))

for (const c of vec.cases) {
  test(`case: ${c.name}`, () => {
    const res = run(c)
    assert.ok(matches(res, c.expect), `expected ${JSON.stringify(c.expect)} got ${JSON.stringify(res)}`)
  })
}

test('cross-implementation: the standard-library Python verifier agrees on every case (skipped if python is absent)', (t) => {
  const py = ['python', 'python3', 'py'].map((cmd) => spawnSync(cmd, ['-I', '--version'])).find((r) => r.status === 0)
  if (!py) return t.skip('python not installed here')
  const cmd = spawnSync('python', ['-I', '--version']).status === 0 ? 'python' : 'python3'
  const r = spawnSync(cmd, ['-I', path.join(ROOT, 'verifier-py/verify.py'), path.join(ROOT, 'vectors/portable-v1.json')], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /29\/29 cases match|\d+\/\d+ cases match/)
})

test('canonical form: issuer encoder and verifier encoder produce the same bytes (fuzz) and the published example', () => {
  let seed = 12345
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  const gen = (d = 0) => {
    const r = rnd()
    if (d > 3 || r < 0.3) return [Math.floor(rnd() * 1e6) - 5e5, 'a"b\\c\n\u0007é€', true, false, null, ''][Math.floor(rnd() * 6)]
    if (r < 0.6) return Array.from({ length: Math.floor(rnd() * 4) }, () => gen(d + 1))
    const o = {}
    for (let i = 0; i < Math.floor(rnd() * 4); i++) o['k' + Math.floor(rnd() * 20) + 'Z'.repeat(Math.floor(rnd() * 3))] = gen(d + 1)
    return o
  }
  for (let i = 0; i < 300; i++) { const v = gen(); assert.equal(I.cf1(v), V.canonical(v)) }
  assert.equal(I.cf1(vec.canonical[0].value), vec.canonical[0].text)
  assert.equal(Buffer.from(V.canonical(vec.canonical[0].value)).toString('hex'), vec.canonical[0].bytesHex)
  assert.equal(V.signingInput('fact', vec.signingInputExample.body).toString('hex'), vec.signingInputExample.inputHex)
  assert.equal(V.objectId('fact', vec.signingInputExample.body), vec.signingInputExample.id)
})

test('canonical form rejects what it must: floats, -0, undefined, non-ASCII keys, lone surrogates', () => {
  for (const bad of [1.5, -0, undefined, { 'é': 1 }, '\ud800', { a: NaN }]) {
    assert.throws(() => V.canonical(bad), /CF1/)
    assert.throws(() => I.cf1(bad), /CF1/)
  }
})

test('domain separation: a signature made for one purpose never verifies for another', () => {
  const body = { v: 1, kind: 'x', n: 1 }
  const k = I.keyFromSeed(new Uint8Array(32).fill(3))
  const sig = k.sign(I.input('fact', body))
  assert.notEqual(V.signingInput('fact', body).toString('hex'), V.signingInput('head', body).toString('hex'))
  // the same bytes under another purpose are a different message: verify via the verifier's own check path
  const head = { body: { v: 1, kind: 'head', participant: k.pk, seq: 0, hash: '0'.repeat(64), iat: 1 }, sig: k.sign(I.input('fact', { v: 1, kind: 'head', participant: k.pk, seq: 0, hash: '0'.repeat(64), iat: 1 })) }
  const fact = { body: { v: 1, kind: 'trade-outcome', participant: k.pk, seq: 0, prev: '0'.repeat(64), tradeCommit: 'a'.repeat(64), counterpartyCommit: 'b'.repeat(64), outcome: 'completed', iat: 1 } }
  fact.sig = k.sign(I.input('fact', fact.body))
  const r = V.verifyChain([fact], head, { participants: new Set([k.pk]) })
  assert.equal(r.reason, 'head-signature', 'a head signed with the "fact" purpose is refused')
  assert.ok(sig.length === 128)
})

test('privacy: the public record (bindings, facts, heads) carries no counterparty key, trade reference, amount or conversation', () => {
  const pub = JSON.stringify({ bindings: vec.package.bindings, chains: vec.package.chains })
  for (const q of vec.keys.counterparties) assert.equal(pub.includes(q), false, 'counterparty key leaked')
  assert.equal(/trade-ref|amount|address|message|chat/i.test(pub), false)
  // an opening exposes exactly one trade to one verifier; commitments do not reveal it
  const tc = vec.package.chains[0].facts[0].body.tradeCommit
  assert.ok(vec.package.openings[tc].tradeRef.startsWith('trade-ref'))
  assert.equal(pub.includes(vec.package.openings[tc].tradeRef), false)
})

test('the verifier module imports nothing but node:crypto (independence)', () => {
  const text = fs.readFileSync(path.join(SRC, 'verify.mjs'), 'utf8')
  const imports = [...text.matchAll(/^import .* from '(.+)'$/gm)].map((m) => m[1])
  assert.deepEqual(imports, ['node:crypto'])
})
