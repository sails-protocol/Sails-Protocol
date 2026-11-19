// P51: structural equality of run 1 and run 2 (GK P51 §(d).3: "igualdade estrutural definida por escrito").
//
// Usage: node structural-compare.mjs <evidence/run1> <evidence/run2>
//
// WHAT IS COMPARED (every structure-*.json written by the check scripts, same file names in both runs):
//   states, refusal codes, values in sats, number of outputs, output (address) types, number of broadcasts,
//   which checks passed, response field names. Deep equality, key by key.
// WHAT IS EXCLUDED (and enforced: the compare FAILS if any structure file contains one of these):
//   txids and any 64-hex value, block hashes, heights, block times, timestamps, wallet addresses.
//   They differ on every regtest run (random keys, fresh chain), so they can never be part of the verdict.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const [a, b] = process.argv.slice(2)
if (!a || !b) { console.error('usage: structural-compare.mjs <run1-dir> <run2-dir>'); process.exit(2) }

const FORBIDDEN_KEYS = new Set(['txid', 'hash', 'blockhash', 'block_hash', 'height', 'block_height', 'time', 'block_time', 'timestamp', 'ts', 'address'])
const HEX64 = /^[0-9a-fA-F]{64}$/

function violations(node, path = '$') {
  const out = []
  if (Array.isArray(node)) node.forEach((v, i) => out.push(...violations(v, `${path}[${i}]`)))
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (FORBIDDEN_KEYS.has(k.toLowerCase())) out.push(`${path}.${k}: key is excluded from the structure`)
      out.push(...violations(v, `${path}.${k}`))
    }
  } else if (typeof node === 'string' && HEX64.test(node)) out.push(`${path}: 64-hex value (txid/hash) is excluded from the structure`)
  return out
}
const structureFiles = (dir) => readdirSync(dir).filter((f) => /^structure-.*\.json$/.test(f)).sort()

const fa = structureFiles(a)
const fb = structureFiles(b)
const problems = []
if (fa.length === 0) problems.push(`no structure-*.json in ${a}`)
if (JSON.stringify(fa) !== JSON.stringify(fb)) problems.push(`different structure files: run1=${JSON.stringify(fa)} run2=${JSON.stringify(fb)}`)
for (const f of fa.filter((x) => fb.includes(x))) {
  const ja = JSON.parse(readFileSync(join(a, f), 'utf8'))
  const jb = JSON.parse(readFileSync(join(b, f), 'utf8'))
  for (const v of violations(ja)) problems.push(`${f} (run1) ${v}`)
  for (const v of violations(jb)) problems.push(`${f} (run2) ${v}`)
  if (JSON.stringify(ja) !== JSON.stringify(jb)) problems.push(`${f}: run1 and run2 differ structurally`)
}
if (problems.length) {
  console.error('STRUCTURAL COMPARISON: DIFFERENT / INVALID')
  for (const p of problems) console.error(' - ' + p)
  process.exit(1)
}
console.log(`STRUCTURAL COMPARISON: IDENTICAL across ${fa.length} structure file(s): ${fa.join(', ')}`)
