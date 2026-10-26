// RED/GREEN for the independent portable verifier: each mutant is portable/src with ONE check removed;
// test/portable.test.mjs (hand-written expectations) must fail on it. Usage: node scripts/red-green-portable.mjs
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const src = path.join(root, 'portable/src')
const M = [
  ['P1 grant signature not verified', "if (!verifyEd(z32decode(c.iss), grant.input, grant.sig)) return fail('grant-signature')", ''],
  ['P2 delegate (grant client key) signature not verified', "if (!verifyEd(z32decode(c.cnf), pop.input, pop.sig)) return fail('delegate-signature')", ''],
  ['P3 delegate statement not compared with the signed statement', "if (canonical(pop.payload.data) !== canonical(S)) return fail('delegate-statement-mismatch')", ''],
  ['P4 participant signature not verified', "return fail('participant-signature')", 'void 0'],
  ['P5 delegated-only treated as root-consented', "if (requireLevel === 'root-consented' && level !== 'root-consented') return { ok: false, reason: 'not-root-consented', level }", ''],
  ['P6 audience not checked', "if (S.audience !== audience) return fail('audience')", ''],
  ['P7 grant expiry not checked', "if (!(now < c.exp) || now < c.iat - SKEW) return fail('grant-not-valid-now')", ''],
  ['P8 statement validity (expiry/ttl) not checked', "if (!(now < S.exp) || S.exp > c.exp || S.exp - S.iat > maxStatementTtl) return fail('statement-validity')", ''],
  ['P9 pubky/grant issuer mismatch not checked', "if (S.pubky !== c.iss) return fail('pubky-mismatch')", ''],
  ['P10 sequence gaps allowed (cherry-picking)', "if (b.seq !== i) return { ok: false, reason: 'seq-gap', index: i }", ''],
  ['P11 chain links not checked', "if (b.prev !== prev) return { ok: false, reason: 'chain-broken', index: i }", ''],
  ['P12 fact signature not verified', "return { ok: false, reason: 'fact-signature', index: i }", 'void 0'],
  ['P13 head must match the chain: not checked', "if (h.seq !== chain.length - 1 || h.hash !== prev) return fail('head-mismatch')", ''],
  ['P14 pinned head ignored (truncation)', "if (pinnedHead && h.seq < pinnedHead.seq) return fail('head-older-than-pinned')", ''],
  ['P15 participant of a fact need not be bound', "return { ok: false, reason: 'participant-not-bound', index: i }", 'void 0'],
  ['P16 self-confirmation accepted', ' && c.body.confirmer !== b.participant', ''],
  ['P17 confirmation signature not verified', "verifyEd(Buffer.from(c.body.confirmer, 'hex'), signingInput('confirmation', c.body), c.sig))", 'true)'],
  ['P18 per-counterparty cap removed (wash trading)', 'if (n > 3) capped++; else completedConfirmed++', 'completedConfirmed++'],
  ['P19 commitment opening not checked', 'const conf = o && tradeCommit(o) === tc && partyCommit(o) === b.counterpartyCommit', 'const conf = o'],
  ['P20 binding revocation ignored', "if ((pkg.bindingRevocations ?? []).some((rv) => verifyBindingRevocation(rv, r))) continue", ''],
  ['P21 dispute claim signature not verified', "verifyEd(Buffer.from(b.claimant, 'hex'), signingInput('dispute-claim', b), d.sig)", 'true'],
  ['P22 same dispute claim counted repeatedly', 'claimants.add(`${b.claimant}:${b.tradeCommit}`)', 'claimants.add(Math.random())'],
  ['P23 correction rule: first fact wins instead of last', 'for (const f of chain) last.set(f.body.tradeCommit, f.body)', 'for (const f of chain) if (!last.has(f.body.tradeCommit)) last.set(f.body.tradeCommit, f.body)']
]

function run (dir) {
  const r = spawnSync(process.execPath, ['--test', '--test-force-exit', 'test/portable.test.mjs'], { cwd: root, encoding: 'utf8', env: { ...process.env, PORTABLE_SRC: dir } })
  const out = r.stdout + r.stderr
  return { status: r.status, fail: Number((out.match(/ℹ fail (\d+)/) ?? [])[1]), pass: Number((out.match(/ℹ pass (\d+)/) ?? [])[1]), failed: [...new Set([...out.matchAll(/^✖ (.+?) \(\d/gm)].map((m) => m[1]))] }
}
const green = run(src)
console.log(`GREEN real verifier: exit=${green.status} pass=${green.pass} fail=${green.fail}`)
let bad = green.status !== 0; let hit = 0
for (const [name, from, to] of M) {
  const dir = path.join(root, '.mutants', name.split(' ')[0].toLowerCase(), 'src')
  fs.rmSync(path.dirname(dir), { recursive: true, force: true })
  fs.cpSync(src, dir, { recursive: true })
  const f = path.join(dir, 'verify.mjs'); const text = fs.readFileSync(f, 'utf8')
  if (text.split(from).length - 1 !== 1) { console.log(`harness error: ${name}: target found ${text.split(from).length - 1} times`); bad = true; continue }
  fs.writeFileSync(f, text.replace(from, () => to))
  const r = run(dir)
  const d = r.status !== 0 && r.fail > 0
  if (d) hit++; else bad = true
  console.log(`RED ${d ? 'detected ' : 'SURVIVED '} ${name}: fail=${r.fail} [${r.failed.slice(0, 2).join(' | ')}]`)
}
fs.rmSync(path.join(root, '.mutants'), { recursive: true, force: true })
console.log(`\nmutants: ${hit}/${M.length} detected`)
process.exit(bad ? 1 : 0)
