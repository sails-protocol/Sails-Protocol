// A third-party integrator's verifier. Imports ONLY the public-side module: it has no
// access to any secret and makes no network call. Usage:
//   node scripts/verify-bundle.mjs <bundle.json> <expected-pubky-z32> <now-unix>
import fs from 'node:fs'
import { verifyAuthorization, verifyHistory } from '../src/verify.mjs'

const [file, subject, nowArg] = process.argv.slice(2)
const bundle = JSON.parse(fs.readFileSync(file, 'utf8'))
const now = Number(nowArg)

const history = verifyHistory(bundle.history, { subject, expectedHead: bundle.head })
const sessions = bundle.authorizations.map((c) => verifyAuthorization(c, { expectedSub: subject, now }))
const ok = history.ok && sessions.every((s) => s.ok)
console.log(JSON.stringify({ ok, history, sessions: sessions.map((s) => (s.ok ? 'ok' : s.reason)) }))
process.exit(ok ? 0 : 1)
