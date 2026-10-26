// Adversarial matrix with the experimental freshness window N = 300 s (CTO decision on #545: lab only, NOT a Day 0 policy).
// Goal: state, for each attack, the FALSE-ACCEPT WINDOW (how long something revoked or stale can still be accepted), and keep
// "immediate revocation" and "revocation with limited exposure" apart. The HTTP error order of the homeserver is NOT used anywhere here.
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { HOMESERVER_HTTP, PEAR_DIR, STATE_DIR, closeAll, sdk, spawnRole } from '../lib.mjs'
import { KIND, LAB_WINDOW_SEC, SCOPES, capsFor } from '../policy.mjs'

const N = LAB_WINDOW_SEC
const PASS = 'test-only-passphrase-do-not-reuse'
const CAPS = capsFor(SCOPES)
const REAL = HOMESERVER_HTTP
const HOSTILE = 'http://127.0.0.1:6290'
const now = () => Math.floor(Date.now() / 1000)
let signer
let proxy
let identity

before(async () => {
  identity = JSON.parse(fs.readFileSync(`${STATE_DIR}/identity.json`, 'utf8')).pk
  signer = spawnRole('role-signer.mjs', { PPR_SIGNER_PASSPHRASE: PASS })
  await signer.ok('load')
  proxy = spawnRole('role-proxy.mjs')
  await proxy.ok('listen')
})
after(() => closeAll())

async function integrator () {
  const app = spawnRole('role-integrator.mjs')
  const { url } = await app.ok('start', { caps: CAPS, clientId: 'wallet.example' })
  const waiting = app.ok('await')
  await signer.ok('approve', { url })
  return { app, info: await waiting }
}

async function publish (a, { dev, seq = 1, pear, iatOffset = 0 }) {
  const publicKey = pear ?? (await a.app.ok('newPearKey', { name: dev })).publicKey
  const iat = now() + iatOffset
  const cp = await a.app.ok('customPop', { data: { v: 1, kind: KIND, pear: publicKey, dev, scope: ['pear:connect'], aud: '*', iat, exp: iat + 3000, seq } })
  const claims = JSON.parse(Buffer.from(cp.grant.split('.')[1], 'base64url').toString('utf8'))
  const { sig } = await a.app.ok('pearSign', { name: dev, grantJti: claims.jti, nonce: sdk.verifyCustomGrantPop(cp).nonce, pear: publicKey })
  await a.app.ok('put', { path: `${PEAR_DIR}/devices/${publicKey}.json`, json: { v: 1, cp, pearSig: sig } })
  return { pear: publicKey, claims }
}

const check = async (v, base, pear, { clock = 0 } = {}) => {
  const read = await v.ok('readRecord', { base, identity, pear })
  return v.ok('verifyStrict', { read, identity, audience: 'market.example', now: now() + clock, maxAgeSec: N, online: false })
}

test('W1 MEASURED exposure after revocation (honest homeserver, real time, N=300): revoked grant, record still inside the window', { timeout: 420000 }, async () => {
  const a = await integrator()
  try {
    const p = await publish(a, { dev: 'w1' })
    const v = spawnRole('role-verifier.mjs')
    const t0 = Date.now()
    assert.equal((await check(v, REAL, p.pear)).ok, true)
    await signer.ok('revoke', { id: p.claims.jti })
    const revokedAt = Date.now()
    assert.match((await a.app.fails('put', { path: `${PEAR_DIR}/devices/${p.pear}.json`, json: { x: 1 } })).message, /401|403/, 'the revoked integrator cannot refresh')
    let lastAccepted = revokedAt
    let firstRefused = null
    while (!firstRefused) {
      await new Promise((r) => setTimeout(r, 10000))
      const r = await check(v, REAL, p.pear)
      if (r.ok) lastAccepted = Date.now(); else firstRefused = { at: Date.now(), reason: r.reason }
      assert.ok(Date.now() - t0 < 400000, 'bounded')
    }
    const exposure = Math.round((firstRefused.at - revokedAt) / 1000)
    console.log(JSON.stringify({ W1: { N, acceptedAfterRevocationForSec: Math.round((lastAccepted - revokedAt) / 1000), firstRefusedAfterRevocationSec: exposure, reason: firstRefused.reason } }))
    assert.ok(lastAccepted > revokedAt + 5000, 'FALSE-ACCEPT WINDOW exists: a revoked grant was still accepted after revocation')
    assert.ok(exposure <= N + 15, 'and it is bounded by N')
    assert.match(firstRefused.reason, /stale/)
  } finally { a.app.close() }
})

test('W2 immediate revocation exists ONLY with a cooperating signer + honest homeserver: signer-side delete is refused at once', async () => {
  const a = await integrator()
  try {
    const p = await publish(a, { dev: 'w2' })
    const v = spawnRole('role-verifier.mjs')
    assert.equal((await check(v, REAL, p.pear)).ok, true)
    await signer.ok('revoke', { id: p.claims.jti })
    await signer.ok('rootDelete', { path: `${PEAR_DIR}/devices/${p.pear}.json` })
    assert.equal((await check(v, REAL, p.pear)).reason, 'record-unavailable')
  } finally { a.app.close() }
})

test('W3 verifier restart: an in-memory guard forgets (rollback accepted inside N); a persisted guard remembers; a witness value pre-pins a first contact', async () => {
  const a = await integrator()
  const guardFile = `${STATE_DIR}/guard-w3.json`
  const witnessFile = `${STATE_DIR}/guard-w3-witness.json`
  for (const f of [guardFile, witnessFile]) fs.rmSync(f, { force: true })
  try {
    await proxy.ok('mode', { name: 'pass' }); await proxy.ok('clear'); await proxy.ok('record', { on: true })
    const v1rec = await publish(a, { dev: 'w3', seq: 1 })
    const first = spawnRole('role-verifier.mjs', { PPR_GUARD_FILE: guardFile })
    assert.equal((await check(first, HOSTILE, v1rec.pear)).ok, true) // proxy records seq 1
    await proxy.ok('record', { on: false })
    await publish(a, { dev: 'w3', seq: 2, pear: v1rec.pear })
    assert.equal((await check(first, REAL, v1rec.pear)).ok, true) // seq 2 pinned
    first.close() // verifier restarts
    await proxy.ok('mode', { name: 'replay' }) // hostile homeserver now replays seq 1
    const persisted = spawnRole('role-verifier.mjs', { PPR_GUARD_FILE: guardFile })
    assert.equal((await check(persisted, HOSTILE, v1rec.pear)).reason, 'rollback-or-replay', 'persisted guard survives the restart')
    const forgetful = spawnRole('role-verifier.mjs') // default in-memory guard after a restart
    assert.equal((await check(forgetful, HOSTILE, v1rec.pear)).ok, true, 'EXPECTED-FAIL (defence): in-memory guard re-opens rollback until the record ages out (<= N)')
    fs.writeFileSync(witnessFile, JSON.stringify({ [`${identity}:${v1rec.pear}`]: 2 }))
    const witnessed = spawnRole('role-verifier.mjs', { PPR_GUARD_FILE: witnessFile })
    assert.equal((await check(witnessed, HOSTILE, v1rec.pear)).reason, 'rollback-or-replay', 'a value learned from an independent witness protects a first contact')
  } finally { a.app.close(); await proxy.ok('mode', { name: 'pass' }) }
})

test('W4 no connectivity: homeserver unreachable => refused (fail closed); nothing cached is used to authorize', async () => {
  const a = await integrator()
  try {
    const p = await publish(a, { dev: 'w4' })
    const v = spawnRole('role-verifier.mjs')
    assert.equal((await check(v, REAL, p.pear)).ok, true)
    await proxy.ok('mode', { name: 'drop' })
    assert.equal((await check(v, HOSTILE, p.pear)).reason, 'record-unavailable')
  } finally { a.app.close(); await proxy.ok('mode', { name: 'pass' }) }
})

test('W5 hostile homeserver replays a record of a revoked grant: accepted while the SIGNED statement is younger than N, refused after (time moved on the verifier clock)', async () => {
  const a = await integrator()
  try {
    await proxy.ok('mode', { name: 'pass' }); await proxy.ok('clear'); await proxy.ok('record', { on: true })
    const p = await publish(a, { dev: 'w5' })
    const seed = spawnRole('role-verifier.mjs')
    assert.equal((await check(seed, HOSTILE, p.pear)).ok, true)
    await proxy.ok('record', { on: false })
    await signer.ok('revoke', { id: p.claims.jti })
    await signer.ok('rootDelete', { path: `${PEAR_DIR}/devices/${p.pear}.json` })
    await proxy.ok('mode', { name: 'replay' })
    const v = spawnRole('role-verifier.mjs')
    assert.equal((await check(v, HOSTILE, p.pear, { clock: N - 20 })).ok, true, 'FALSE-ACCEPT until the signed statement is N old (forged Last-Modified is irrelevant)')
    assert.equal((await check(spawnRole('role-verifier.mjs'), HOSTILE, p.pear, { clock: N + 20 })).reason, 'statement-stale')
  } finally { a.app.close(); await proxy.ok('mode', { name: 'pass' }) }
})

test('W6 forged metadata and a wrong verifier clock: a clock that runs L seconds behind stretches the window to N + L; forged homeserver headers add nothing', async () => {
  const a = await integrator()
  try {
    const p = await publish(a, { dev: 'w6', iatOffset: -(N + 100) }) // statement already N+100 s old when published
    const honestClock = spawnRole('role-verifier.mjs')
    assert.equal((await check(honestClock, REAL, p.pear)).reason, 'statement-stale')
    const lagging = spawnRole('role-verifier.mjs')
    assert.equal((await check(lagging, REAL, p.pear, { clock: -150 })).ok, true, 'EXPECTED-FAIL (defence): a verifier clock 150 s behind accepts a record that is N+100 s old')
    await proxy.ok('mode', { name: 'fresh-headers' })
    assert.equal((await check(spawnRole('role-verifier.mjs'), HOSTILE, p.pear)).reason, 'statement-stale', 'fresh-looking Last-Modified does not rescue it')
  } finally { a.app.close(); await proxy.ok('mode', { name: 'pass' }) }
})

test('W7 compromised integrator (before revocation) keeps publishing; the accepted state is always <= N old; after revocation it cannot publish', async () => {
  const thief = await integrator()
  try {
    const p = await publish(thief, { dev: 'w7', seq: 1 })
    const p2 = await publish(thief, { dev: 'w7', seq: 2, pear: p.pear })
    const v = spawnRole('role-verifier.mjs')
    assert.equal((await check(v, REAL, p2.pear)).ok, true)
    await signer.ok('revoke', { id: p.claims.jti })
    assert.match((await thief.app.fails('put', { path: `${PEAR_DIR}/devices/${p.pear}.json`, json: { y: 1 } })).message, /401|403/)
    assert.equal((await check(v, REAL, p2.pear, { clock: N + 30 })).reason, 'statement-stale')
  } finally { thief.app.close() }
})
