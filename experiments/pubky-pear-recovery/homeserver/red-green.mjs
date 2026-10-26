// RED/GREEN for the homeserver policy: each mutant is a copy of homeserver/ with ONE check removed;
// the matching suite, run against the REAL homeserver, must fail. Needs `orchestrate.mjs up` first.
//   node homeserver/red-green.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const here = import.meta.dirname
const orch = path.join(here, 'orchestrate.mjs')
const S03 = 'homeserver/test/03-pear-directory-revocation.test.mjs'

const MUTANTS = [
  ['H1 identity not pinned', 'policy.mjs', "if (v.identity !== identity) return deny('wrong-identity')", '', 'p03'],
  ['H2 write capability not required', 'policy.mjs', "if (!claims.caps.some((c) => capCovers(c, requiredPath, 'w'))) return deny('capability-missing')", '', 'p03'],
  ['H3 transport scopes not tied to approved capabilities', 'policy.mjs', "if (!claims.caps.some((c) => capCovers(c, scopePath(s), 'w'))) return deny('scope-not-granted:' + s)", '', 'p03'],
  ['H4 audience ignored', 'policy.mjs', "if (d.aud !== '*' && d.aud !== audience) return deny('audience-mismatch')", '', 'p03'],
  ['H5 statement expiry ignored', 'policy.mjs', "if (now >= d.exp) return deny('statement-expired')", '', 'p03'],
  ['H6 statement lifetime cap removed', 'policy.mjs', "if (d.exp - d.iat > maxStatementTtl) return deny('statement-ttl-too-long')", '', 'p03'],
  ['H7 Pear key binding not checked', 'policy.mjs', "if (!ok) return deny('pear-binding-invalid')", '', 'p03'],
  ['H8 client allowlist ignored', 'policy.mjs', "if (allowedClients && !allowedClients.includes(claims.client_id)) return deny('client-not-allowed')", '', 'p03'],
  ['H9 revocation probe blind (always active)', 'policy.mjs', "if (/revoked/i.test(text)) return 'revoked'", '', 'p03'],
  ['H10 grant+PoP signatures not verified', 'policy.mjs', 'try { v = verifyCustomGrantPop(record.cp, { clockSkewSeconds: 30 }) }', 'try { v = unsafeDecode(record.cp) }', 'p03'],
  ['H11 challenge reusable', 'role-verifier.mjs', 'if (!seenChallenges.delete(nonce))', 'if (!seenChallenges.has(nonce))', 'p03'],
  ['H12 revocation fails OPEN when the homeserver is unreachable', 'role-verifier.mjs', "if (status === 'unavailable') return { ok: false, reason: 'revocation-status-unavailable' } // fail closed", '', 'p04']
]

const UNSAFE = `
function unsafeDecode (cp) {
  const b64 = (s) => JSON.parse(Buffer.from(s, 'base64url').toString())
  const claims = b64(cp.grant.split('.')[1]); const pop = b64(cp.pop.split('.')[1])
  return { identity: claims.iss, grantClaims: claims, data: pop.data, nonce: pop.nonce, iat: pop.iat }
}
`

function run (dir, files, extraEnv = {}) {
  const r = spawnSync(process.execPath, [orch, 'run', ...files], { encoding: 'utf8', env: { ...process.env, PPR_HS_DIR: dir, ...extraEnv }, maxBuffer: 64 * 1024 * 1024 })
  const out = r.stdout + r.stderr
  return { status: r.status, fail: Number((out.match(/ℹ fail (\d+)/) ?? [])[1]), pass: Number((out.match(/ℹ pass (\d+)/) ?? [])[1]), failed: [...new Set([...out.matchAll(/^✖ (.+?) \(\d/gm)].map((m) => m[1]))] }
}
const orchCmd = (c) => spawnSync(process.execPath, [orch, c], { encoding: 'utf8' })

const green = run(path.join(here), [S03])
console.log(`GREEN real policy: exit=${green.status} pass=${green.pass} fail=${green.fail}`)
let bad = green.status !== 0
let detected = 0
for (const [name, file, from, to, suite] of MUTANTS) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pprhs-'))
  fs.cpSync(here, tmp, { recursive: true })
  const target = path.join(tmp, file)
  const text = fs.readFileSync(target, 'utf8')
  if (text.split(from).length - 1 !== 1) { console.log(`harness error: ${name}: patch target not found exactly once`); bad = true; continue }
  fs.writeFileSync(target, text.replace(from, () => to) + (to.includes('unsafeDecode') ? UNSAFE : ''))
  let r
  if (suite === 'p03') r = run(tmp, [S03])
  else {
    // outage mutant: prepare state, freeze the homeserver, run the outage suite on the mutant, unfreeze
    run(path.join(here), ['homeserver/test/04a-outage-prepare.test.mjs'])
    orchCmd('pause')
    r = run(tmp, ['homeserver/test/04b-outage-frozen.test.mjs'])
    orchCmd('unpause')
  }
  const hit = r.status !== 0 && r.fail > 0
  if (hit) detected++; else bad = true
  console.log(`RED ${hit ? 'detected ' : 'SURVIVED '} ${name}: fail=${r.fail} [${r.failed.slice(0, 2).join(' | ')}]`)
  fs.rmSync(tmp, { recursive: true, force: true })
}
console.log(`\nmutants: ${detected}/${MUTANTS.length} detected`)
process.exit(bad ? 1 : 0)
