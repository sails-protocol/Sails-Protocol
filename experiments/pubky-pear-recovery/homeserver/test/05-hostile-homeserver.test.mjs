// Adversarial scenarios: hostile or stale homeserver (a proxy in front of the real one), tampered or substituted
// directory records, stolen Pear device, stolen integrator device, revoked grant, reuse of authorizations.
// Expected-FAIL rows are the point: they mark what a hostile homeserver CAN do. They are asserted as such.
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { HOMESERVER_HTTP, PEAR_DIR, STATE_DIR, closeAll, sdk, spawnRole } from '../lib.mjs'
import { KIND, SCOPES, capsFor } from '../policy.mjs'

const PASS = 'test-only-passphrase-do-not-reuse'
const CAPS = capsFor(SCOPES)
const REAL = HOMESERVER_HTTP
const HOSTILE = 'http://127.0.0.1:6290'
const now = () => Math.floor(Date.now() / 1000)
let signer
let proxy
let verifier
let identity

before(async () => {
  identity = JSON.parse(fs.readFileSync(`${STATE_DIR}/identity.json`, 'utf8')).pk
  signer = spawnRole('role-signer.mjs', { PPR_SIGNER_PASSPHRASE: PASS })
  await signer.ok('load')
  proxy = spawnRole('role-proxy.mjs')
  await proxy.ok('listen')
  verifier = spawnRole('role-verifier.mjs')
})
after(() => closeAll())

async function integrator (clientId = 'wallet.example') {
  const app = spawnRole('role-integrator.mjs')
  const { url } = await app.ok('start', { caps: CAPS, clientId })
  const waiting = app.ok('await')
  await signer.ok('approve', { url })
  return { app, info: await waiting }
}

async function publish (a, { dev, seq = 1, pear, scope = ['pear:connect'] }) {
  const publicKey = pear ?? (await a.app.ok('newPearKey', { name: dev })).publicKey
  const iat = now()
  const cp = await a.app.ok('customPop', { data: { v: 1, kind: KIND, pear: publicKey, dev, scope, aud: '*', iat, exp: iat + 3000, seq } })
  const claims = JSON.parse(Buffer.from(cp.grant.split('.')[1], 'base64url').toString('utf8'))
  const { sig } = await a.app.ok('pearSign', { name: dev, grantJti: claims.jti, nonce: sdk.verifyCustomGrantPop(cp).nonce, pear: publicKey })
  const record = { v: 1, cp, pearSig: sig }
  await a.app.ok('put', { path: `${PEAR_DIR}/devices/${publicKey}.json`, json: record })
  return { pear: publicKey, record, claims }
}

const check = async (base, pear, { maxAgeSec = 900, online = false, id = identity, v = verifier } = {}) => {
  const read = await v.ok('readRecord', { base, identity: id, pear })
  return v.ok('verifyStrict', { read, identity: id, audience: 'market.example', now: now(), maxAgeSec, online })
}

test('S0 baseline: honest path through the proxy is accepted (provenance + freshness + sequence)', async () => {
  const a = await integrator()
  try {
    await proxy.ok('mode', { name: 'pass' })
    const p = await publish(a, { dev: 's0' })
    assert.equal((await check(HOSTILE, p.pear)).ok, true)
  } finally { a.app.close() }
})

test('S1 tampered directory record is rejected (every outer field is covered by a signature or binding)', async () => {
  const a = await integrator()
  try {
    const p = await publish(a, { dev: 's1' })
    for (const tamper of ['binding', 'signature', 'grant']) {
      await proxy.ok('mode', { name: 'tamper', config: { tamper } })
      const r = await check(HOSTILE, p.pear, { v: spawnRole('role-verifier.mjs') })
      assert.equal(r.ok, false, tamper)
    }
  } finally { a.app.close(); await proxy.ok('mode', { name: 'pass' }) }
})

test('S2 withheld record: refused (fail closed). Availability is lost; that is the cost and it is stated', async () => {
  const a = await integrator()
  try {
    const p = await publish(a, { dev: 's2' })
    await proxy.ok('mode', { name: 'withhold' })
    assert.equal((await check(HOSTILE, p.pear)).reason, 'record-unavailable')
  } finally { a.app.close(); await proxy.ok('mode', { name: 'pass' }) }
})

test('S3 stale replay after revoke + delete: accepted inside the freshness window (bounded), refused after it', async () => {
  const a = await integrator()
  try {
    await proxy.ok('mode', { name: 'pass' })
    await proxy.ok('clear'); await proxy.ok('record', { on: true })
    const p = await publish(a, { dev: 's3' })
    assert.equal((await check(HOSTILE, p.pear)).ok, true) // proxy records the answers
    await proxy.ok('record', { on: false })
    await signer.ok('revoke', { id: p.claims.jti })
    await signer.ok('rootDelete', { path: `${PEAR_DIR}/devices/${p.pear}.json` })
    assert.equal((await check(REAL, p.pear, { v: spawnRole('role-verifier.mjs') })).reason, 'record-unavailable', 'honest homeserver: gone at once')
    await proxy.ok('mode', { name: 'replay' })
    const inside = await check(HOSTILE, p.pear, { maxAgeSec: 3, v: spawnRole('role-verifier.mjs') })
    assert.equal(inside.ok, true, 'KNOWN LIMIT: a hostile homeserver can replay for up to maxAgeSec')
    await new Promise((r) => setTimeout(r, 4200))
    const after = await check(HOSTILE, p.pear, { maxAgeSec: 3, v: spawnRole('role-verifier.mjs') })
    assert.equal(after.reason, 'statement-stale')
  } finally { a.app.close(); await proxy.ok('mode', { name: 'pass' }) }
})

test('S4 forged freshness headers cannot extend an old record: the signed statement age decides', async () => {
  const a = await integrator()
  try {
    await proxy.ok('mode', { name: 'pass' })
    const p = await publish(a, { dev: 's4' })
    await new Promise((r) => setTimeout(r, 3500))
    await proxy.ok('mode', { name: 'fresh-headers' })
    assert.equal((await check(HOSTILE, p.pear, { maxAgeSec: 3, v: spawnRole('role-verifier.mjs') })).reason, 'statement-stale')
  } finally { a.app.close(); await proxy.ok('mode', { name: 'pass' }) }
})

test('S5 anti-rollback: after seq 2 was seen, replaying seq 1 is refused', async () => {
  const a = await integrator()
  try {
    await proxy.ok('mode', { name: 'pass' })
    await proxy.ok('clear'); await proxy.ok('record', { on: true })
    const v1 = await publish(a, { dev: 's5', seq: 1 })
    const guardVerifier = spawnRole('role-verifier.mjs')
    assert.equal((await check(HOSTILE, v1.pear, { v: guardVerifier })).ok, true)
    await proxy.ok('record', { on: false })
    await publish(a, { dev: 's5', seq: 2, pear: v1.pear })
    assert.equal((await check(REAL, v1.pear, { v: guardVerifier })).ok, true)
    await proxy.ok('mode', { name: 'replay' })
    assert.equal((await check(HOSTILE, v1.pear, { v: guardVerifier })).reason, 'rollback-or-replay')
  } finally { a.app.close(); await proxy.ok('mode', { name: 'pass' }) }
})

test('S6 another account\'s perfectly valid record served under the victim\'s name is refused (identity pinned)', async () => {
  const attackerSigner = spawnRole('role-signer.mjs', { PPR_SIGNER_PASSPHRASE: 'x' })
  const app = spawnRole('role-integrator.mjs')
  try {
    const atk = await attackerSigner.ok('create', { file: `${STATE_DIR}/attacker2.bin` })
    const { url } = await app.ok('start', { caps: CAPS, clientId: 'evil.example' })
    const waiting = app.ok('await'); await attackerSigner.ok('approve', { url }); await waiting
    const p = await publish({ app }, { dev: 's6' })
    await proxy.ok('mode', { name: 'pass', config: { mapHost: { [identity]: atk.pk } } })
    assert.equal((await check(HOSTILE, p.pear)).reason, 'wrong-identity')
  } finally { app.close(); attackerSigner.close(); await proxy.ok('mode', { name: 'pass' }) }
})

test('S7 STOLEN INTEGRATOR DEVICE after revoke: it can still MINT statements offline, but cannot publish them; honest homeserver => refused', async () => {
  const thief = await integrator('wallet.example')
  try {
    await signer.ok('revoke', { id: thief.info.grantId })
    const { publicKey } = await thief.app.ok('newPearKey', { name: 's7' })
    const iat = now()
    const cp = await thief.app.ok('customPop', { data: { v: 1, kind: KIND, pear: publicKey, dev: 's7', scope: ['pear:connect'], aud: '*', iat, exp: iat + 600, seq: 1 } })
    assert.ok(cp.grant && cp.pop, 'GAP: a revoked grant still signs fresh statements offline (the SDK makes no network call)')
    const e = await thief.app.fails('put', { path: `${PEAR_DIR}/devices/${publicKey}.json`, json: { v: 1, cp } })
    assert.match(e.message, /401|403/, 'homeserver refuses the write of a revoked grant')
    assert.equal((await check(REAL, publicKey, { v: spawnRole('role-verifier.mjs') })).reason, 'record-unavailable')
    // out-of-band presentation (not fetched from the directory) is refused for lack of provenance
    const oob = spawnRole('role-verifier.mjs')
    const claims = JSON.parse(Buffer.from(cp.grant.split('.')[1], 'base64url').toString('utf8'))
    const { sig } = await thief.app.ok('pearSign', { name: 's7', grantJti: claims.jti, nonce: sdk.verifyCustomGrantPop(cp).nonce, pear: publicKey })
    const r = await oob.ok('verifyStrict', { read: { found: true, record: { v: 1, cp, pearSig: sig }, stats: undefined }, identity, audience: 'market.example', now: now(), maxAgeSec: 900, online: false })
    assert.equal(r.reason, 'freshness-unavailable')
  } finally { thief.app.close() }
})

test('S8 HOSTILE homeserver + stolen integrator device: the attacker\'s fresh statement IS accepted. This is the trust base: the homeserver is the revocation authority', async () => {
  const thief = await integrator('wallet.example')
  try {
    await signer.ok('revoke', { id: thief.info.grantId })
    const { publicKey } = await thief.app.ok('newPearKey', { name: 's8' })
    const iat = now()
    const cp = await thief.app.ok('customPop', { data: { v: 1, kind: KIND, pear: publicKey, dev: 's8', scope: ['pear:connect'], aud: '*', iat, exp: iat + 600, seq: 1 } })
    const claims = JSON.parse(Buffer.from(cp.grant.split('.')[1], 'base64url').toString('utf8'))
    const { sig } = await thief.app.ok('pearSign', { name: 's8', grantJti: claims.jti, nonce: sdk.verifyCustomGrantPop(cp).nonce, pear: publicKey })
    await proxy.ok('mode', { name: 'inject', config: { inject: { [`${PEAR_DIR}/devices/${publicKey}.json`]: { v: 1, cp, pearSig: sig } } } })
    const r = await check(HOSTILE, publicKey, { v: spawnRole('role-verifier.mjs') })
    assert.equal(r.ok, true, 'EXPECTED-FAIL (defence): a homeserver that ignores revocation defeats revocation')
  } finally { thief.app.close(); await proxy.ok('mode', { name: 'pass' }) }
})

test('S9 STOLEN PEAR DEVICE: accepted until the user revokes AND the record is removed; afterwards refused; the stolen copy alone proves nothing', async () => {
  const a = await integrator()
  try {
    const p = await publish(a, { dev: 's9' })
    const v = spawnRole('role-verifier.mjs')
    const ch = await v.ok('challenge', { audience: 'market.example', pear: p.pear })
    const { sig } = await a.app.ok('pearSignRaw', { name: 's9', inputHex: ch.input }) // the thief holds the Pear key
    assert.equal((await v.ok('verifyChallenge', { pear: p.pear, nonce: ch.nonce, audience: 'market.example', sigHex: sig })).ok, true, 'EXPECTED: inside the window the thief is the device')
    await signer.ok('revoke', { id: p.claims.jti })
    await signer.ok('rootDelete', { path: `${PEAR_DIR}/devices/${p.pear}.json` })
    assert.equal((await check(REAL, p.pear, { online: true, v: spawnRole('role-verifier.mjs') })).reason, 'record-unavailable')
  } finally { a.app.close() }
})

test('S10 reuse: a captured challenge answer is useless to another verifier or a second time', async () => {
  const a = await integrator()
  try {
    const p = await publish(a, { dev: 's10' })
    const v1 = spawnRole('role-verifier.mjs')
    const v2 = spawnRole('role-verifier.mjs')
    const ch = await v1.ok('challenge', { audience: 'market.example', pear: p.pear })
    const { sig } = await a.app.ok('pearSignRaw', { name: 's10', inputHex: ch.input })
    assert.equal((await v2.ok('verifyChallenge', { pear: p.pear, nonce: ch.nonce, audience: 'market.example', sigHex: sig })).reason, 'challenge-unknown-or-reused')
    assert.equal((await v1.ok('verifyChallenge', { pear: p.pear, nonce: ch.nonce, audience: 'market.example', sigHex: sig })).ok, true)
    assert.equal((await v1.ok('verifyChallenge', { pear: p.pear, nonce: ch.nonce, audience: 'market.example', sigHex: sig })).reason, 'challenge-unknown-or-reused')
  } finally { a.app.close() }
})

test('S11 a record the homeserver reports as old is refused even if its signed statement is fresh', async () => {
  const a = await integrator()
  try {
    const p = await publish(a, { dev: 's11' })
    await proxy.ok('mode', { name: 'old-headers' })
    assert.equal((await check(HOSTILE, p.pear, { maxAgeSec: 900, v: spawnRole('role-verifier.mjs') })).reason, 'directory-stale')
  } finally { a.app.close(); await proxy.ok('mode', { name: 'pass' }) }
})

test('S12 a statement dated in the future (pre-minted by a compromised integrator) is refused', async () => {
  const a = await integrator()
  try {
    const { publicKey } = await a.app.ok('newPearKey', { name: 's12' })
    const iat = now() + 3600
    const cp = await a.app.ok('customPop', { data: { v: 1, kind: KIND, pear: publicKey, dev: 's12', scope: ['pear:connect'], aud: '*', iat, exp: iat + 600, seq: 1 } })
    const claims = JSON.parse(Buffer.from(cp.grant.split('.')[1], 'base64url').toString('utf8'))
    const { sig } = await a.app.ok('pearSign', { name: 's12', grantJti: claims.jti, nonce: sdk.verifyCustomGrantPop(cp).nonce, pear: publicKey })
    await a.app.ok('put', { path: `${PEAR_DIR}/devices/${publicKey}.json`, json: { v: 1, cp, pearSig: sig } })
    const r = await check(REAL, publicKey, { v: spawnRole('role-verifier.mjs') })
    assert.ok(['statement-from-the-future', 'statement-expired', 'not-yet-valid', 'statement-stale'].includes(r.reason) || r.ok === false, JSON.stringify(r))
    assert.equal(r.ok, false)
  } finally { a.app.close() }
})

test('S13 reinstall + re-authorization: the new install gets its own grant and Pear key; the old key is revoked and refused, the new one accepted', async () => {
  const before = await integrator()
  const reinstalled = await integrator() // fresh process, nothing carried over: new grant, new Pear key
  try {
    const oldKey = await publish(before, { dev: 'phone' })
    const newKey = await publish(reinstalled, { dev: 'phone', seq: 1 })
    assert.notEqual(oldKey.pear, newKey.pear, 'Pear key is not recoverable by design (model B)')
    assert.notEqual(oldKey.claims.jti, newKey.claims.jti)
    await signer.ok('revoke', { id: oldKey.claims.jti })
    await signer.ok('rootDelete', { path: `${PEAR_DIR}/devices/${oldKey.pear}.json` })
    assert.equal((await check(REAL, oldKey.pear, { v: spawnRole('role-verifier.mjs') })).reason, 'record-unavailable')
    assert.equal((await check(REAL, newKey.pear, { online: false, v: spawnRole('role-verifier.mjs') })).ok, true)
  } finally { before.app.close(); reinstalled.app.close() }
})