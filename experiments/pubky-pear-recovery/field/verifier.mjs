// FIELD KIT - second integrator (verifier). Polls the identity's public directory and prints, for each poll, whether a NEW
// authorization would be accepted under the experimental window N (default 300 s). Run it on another machine/network than the
// integrator; note the time the user revokes in Ring and read the first refusal: that is the measured exposure.
//   node field/verifier.mjs --identity <z32> --pear <hex> [--testnet-host localhost] [--window 300] [--every 15] [--guard guard.json]
import { createRequire } from 'node:module'
import { PersistentRollbackGuard, verifyFreshRecord } from '../homeserver/policy.mjs'

const require = createRequire(import.meta.url)
const sdk = require('@synonymdev/pubky')
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d }
const identity = arg('identity'); const pear = arg('pear')
if (!identity || !pear) throw new Error('--identity and --pear are required')
const host = arg('testnet-host'); const windowSec = Number(arg('window', 300)); const every = Number(arg('every', 15)); const duration = Number(arg('duration', 3600))
const guard = new PersistentRollbackGuard(arg('guard', 'field-guard.json'))
const pubky = host ? sdk.Pubky.testnet(host) : new sdk.Pubky()
const address = `pubky${identity}/pub/sails.market/pear/devices/${pear}.json`
const out = (o) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }))
out({ event: 'start', identity, pear, windowSec })

const t0 = Date.now()
async function poll () {
  const now = Math.floor(Date.now() / 1000)
  let record; let stats
  try {
    const deadline = (p) => Promise.race([p, new Promise((_r, rej) => setTimeout(() => rej(new Error('deadline 10s')), 10000))])
    record = await deadline(pubky.publicStorage.getJson(address))
    stats = await deadline(pubky.publicStorage.stats(address))
  } catch (e) { return out({ event: 'decision', accept: false, reason: 'record-unavailable', detail: String(e.message).slice(0, 80) }) }
  const r = verifyFreshRecord(record, { identity, audience: '*', now, requiredPath: '/pub/sails.market/pear/devices/' }, { stats: { lastModifiedMs: stats?.lastModifiedMs }, now, maxAgeSec: windowSec, guard })
  out({ event: 'decision', accept: !!r.ok, reason: r.ok ? 'ok' : r.reason, seq: r.seq, statementAgeSec: r.ok ? now - r.iat : undefined })
}
await poll()
const timer = setInterval(async () => { if ((Date.now() - t0) / 1000 > duration) { clearInterval(timer); process.exit(0) } await poll() }, every * 1000)
