// Pear session authorization expressed as a NATIVE Pubky grant + custom proof-of-possession, published
// to the identity's public directory, discovered and verified by a SECOND integrator, then revoked.
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { PEAR_DIR, STATE_DIR, sdk, spawnRole } from '../lib.mjs'
import { KIND, SCOPES, capsFor } from '../policy.mjs'

const PASS = 'test-only-passphrase-do-not-reuse'
const CAPS = capsFor(SCOPES) // directory write + one capability per transport scope
const now = () => Math.floor(Date.now() / 1000)
let signer
let verifier
let identity

before(async () => {
  identity = JSON.parse(fs.readFileSync(`${STATE_DIR}/identity.json`, 'utf8')).pk
  signer = spawnRole('role-signer.mjs', { PPR_SIGNER_PASSPHRASE: PASS })
  await signer.ok('load')
  verifier = spawnRole('role-verifier.mjs') // no grant, no secret, no link to the issuing integrator
})
after(() => { signer.close(); verifier.close() })

async function integrator (clientId, caps = CAPS, approveCaps) {
  const app = spawnRole('role-integrator.mjs')
  const { url } = await app.ok('start', { caps, clientId })
  const waiting = app.ok('await')
  await signer.ok('approve', { url, caps: approveCaps })
  return { app, info: await waiting }
}

// An integrator creates a fresh Pear key and publishes an authorization for it.
async function authorizePear (a, { dev, scope = ['pear:connect', 'chat:send'], aud = '*', ttl = 600, publish = true, ttlOverride } = {}) {
  const { publicKey } = await a.app.ok('newPearKey', { name: dev })
  const iat = now()
  const data = { v: 1, kind: KIND, pear: publicKey, dev, scope, aud, iat, exp: iat + (ttlOverride ?? ttl) }
  const cp = await a.app.ok('customPop', { data })
  const claims = JSON.parse(Buffer.from(cp.grant.split('.')[1], 'base64url').toString('utf8'))
  const nonce = sdk.verifyCustomGrantPop(cp).nonce
  const { sig } = await a.app.ok('pearSign', { name: dev, grantJti: claims.jti, nonce, pear: publicKey })
  const record = { v: 1, cp, pearSig: sig }
  if (publish) await a.app.ok('put', { path: `${PEAR_DIR}/devices/${publicKey}.json`, json: record })
  return { record, pear: publicKey, name: `${publicKey}.json`, claims }
}

const verify = (record, extra = {}) => verifier.ok('verify', { record, identity, audience: 'market.example', now: now(), online: true, ...extra })

test('P1 publish + discover + verify: a second integrator finds the Pear session in the public directory and verifies the whole chain', async () => {
  const a = await integrator('wallet.example')
  try {
    const p = await authorizePear(a, { dev: 'phone-1' })
    const listed = await verifier.ok('discover', { identity })
    assert.ok(listed.some((e) => e.includes(p.pear)), 'device visible in the directory')
    const fetched = await verifier.ok('fetchRecord', { identity, name: p.name })
    const r = await verify(fetched, { allowedClients: ['wallet.example'] })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.pear, p.pear)
    assert.equal(r.identity, identity)
    assert.deepEqual(r.scope, ['pear:connect', 'chat:send'])
  } finally { a.app.close() }
})

test('P2 live challenge: the Pear key proves possession now, once, for one audience', async () => {
  const a = await integrator('wallet.example')
  try {
    const p = await authorizePear(a, { dev: 'phone-2' })
    const ch = await verifier.ok('challenge', { audience: 'market.example', pear: p.pear })
    const { sig } = await a.app.ok('pearSignRaw', { name: 'phone-2', inputHex: ch.input })
    assert.deepEqual(await verifier.ok('verifyChallenge', { pear: p.pear, nonce: ch.nonce, audience: 'market.example', sigHex: sig }), { ok: true })
    assert.equal((await verifier.ok('verifyChallenge', { pear: p.pear, nonce: ch.nonce, audience: 'market.example', sigHex: sig })).reason, 'challenge-unknown-or-reused', 'replay')
    const ch2 = await verifier.ok('challenge', { audience: 'market.example', pear: p.pear })
    const wrong = await a.app.ok('pearSignRaw', { name: 'phone-2', inputHex: ch2.input })
    assert.equal((await verifier.ok('verifyChallenge', { pear: p.pear, nonce: ch2.nonce, audience: 'other.example', sigHex: wrong.sig })).ok, false, 'audience-bound')
  } finally { a.app.close() }
})

test('P3 negative policy cases: tampering, wrong identity, foreign Pear binding, audience, expiry, ttl, scope, client allowlist', async () => {
  const a = await integrator('wallet.example')
  try {
    const p = await authorizePear(a, { dev: 'phone-3', aud: 'market.example' })
    const base = p.record
    const reason = async (record, extra) => (await verify(record, extra)).reason
    // tampering with the signed proof: change the data inside the PoP payload, keep the signature
    const parts = base.cp.pop.split('.')
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString())
    payload.data = { ...payload.data, scope: ['offer:negotiate'] }
    const tampered = { ...base, cp: { ...base.cp, pop: [parts[0], Buffer.from(JSON.stringify(payload)).toString('base64url'), parts[2]].join('.') } }
    assert.match(await reason(tampered), /^grant-or-pop-invalid/)
    assert.equal(await reason(base, { identity: 'a'.repeat(52) }), 'wrong-identity')
    assert.equal(await reason({ ...base, pearSig: '00'.repeat(64) }), 'pear-binding-invalid')
    assert.equal(await reason(base, { audience: 'wallet.example' }), 'audience-mismatch')
    assert.equal(await reason(base, { now: now() + 601 }), 'statement-expired')
    assert.equal(await reason(base, { allowedClients: ['market.example'] }), 'client-not-allowed')
    const longLived = await authorizePear(a, { dev: 'phone-4', ttlOverride: 7200, publish: false })
    assert.equal(await reason(longLived.record), 'statement-ttl-too-long')
    const badScope = await authorizePear(a, { dev: 'phone-5', scope: ['funds:spend'], publish: false })
    assert.equal(await reason(badScope.record), 'scope-invalid')
  } finally { a.app.close() }
})

test('P4 delegation chain: a read-only grant cannot back a Pear authorization, and an attacker cannot plant records under the victim', async () => {
  const ro = await integrator('reader.example', `${PEAR_DIR}/devices/:r`)
  try {
    const p = await authorizePear(ro, { dev: 'ro-1', publish: false }) // createCustomPop needs no write capability ...
    assert.equal((await verify(p.record)).reason, 'capability-missing') // ... but the policy requires the write capability
    const e = await ro.app.fails('put', { path: `${PEAR_DIR}/devices/${p.pear}.json`, json: p.record })
    assert.match(e.message, /40[13]/)
  } finally { ro.app.close() }
  // Another user (attacker) with a perfectly valid grant of their OWN.
  const attacker = spawnRole('role-signer.mjs', { PPR_SIGNER_PASSPHRASE: 'x' })
  try {
    const atk = await attacker.ok('create', { file: `${STATE_DIR}/attacker.bin` })
    const app = spawnRole('role-integrator.mjs')
    try {
      const { url } = await app.ok('start', { caps: CAPS, clientId: 'evil.example' })
      const waiting = app.ok('await')
      await attacker.ok('approve', { url })
      await waiting
      const p = await authorizePear({ app }, { dev: 'evil-1' }) // valid chain, but for the ATTACKER identity
      const fetched = await verifier.ok('fetchRecord', { identity: atk.pk, name: p.name })
      assert.equal((await verify(fetched, { identity: atk.pk })).ok, true, 'valid for the attacker identity')
      assert.equal((await verify(fetched)).reason, 'wrong-identity', 'never valid for the victim')
      const victimList = await verifier.ok('discover', { identity })
      assert.equal(victimList.some((x) => x.includes(p.pear)), false, 'victim directory untouched')
    } finally { app.close() }
  } finally { attacker.close() }
})

test('P5 revocation seen by another integrator: offline verification is NOT enough; an online grant-status probe or a directory delete is', async () => {
  const a = await integrator('wallet.example')
  try {
    const p = await authorizePear(a, { dev: 'phone-6' })
    const rec = await verifier.ok('fetchRecord', { identity, name: p.name })
    assert.equal(await verifier.ok('status', { record: rec }), 'active-or-unknown')
    assert.equal((await verify(rec)).ok, true)
    await signer.ok('revoke', { id: p.claims.jti })
    // (a) the integrator can no longer refresh or remove its record
    assert.match((await a.app.fails('put', { path: `${PEAR_DIR}/devices/${p.pear}.json`, json: p.record })).message, /401|403/)
    // (b) offline verification keeps succeeding: documented limitation of the SDK verifier
    assert.equal((await verify(rec, { online: false })).ok, true, 'offline-only verification cannot see revocation')
    // (c) online grant-status probe (undocumented behaviour) sees it
    assert.equal(await verifier.ok('status', { record: rec }), 'revoked')
    assert.equal((await verify(rec)).reason, 'grant-revoked')
    // (d) the directory still lists the stale record until someone with authority removes it
    assert.ok((await verifier.ok('discover', { identity })).some((e) => e.includes(p.pear)))
    await signer.ok('rootDelete', { path: `${PEAR_DIR}/devices/${p.pear}.json` })
    assert.equal((await verifier.ok('discover', { identity })).some((e) => e.includes(p.pear)), false, 'signer-side delete removes it from discovery at once')
  } finally { a.app.close() }
})

test('P6 new device + second integrator: two devices, revoke one, the other keeps working', async () => {
  const phone = await integrator('wallet.example')
  const tablet = await integrator('wallet.example')
  try {
    const p1 = await authorizePear(phone, { dev: 'phone-7' })
    const p2 = await authorizePear(tablet, { dev: 'tablet-1' })
    const names = (await verifier.ok('discover', { identity })).filter((e) => e.includes(p1.pear) || e.includes(p2.pear))
    assert.equal(names.length, 2)
    await signer.ok('revoke', { id: p2.claims.jti })
    assert.equal((await verify(await verifier.ok('fetchRecord', { identity, name: p1.name }))).ok, true)
    assert.equal((await verify(await verifier.ok('fetchRecord', { identity, name: p2.name }))).reason, 'grant-revoked')
  } finally { phone.app.close(); tablet.app.close() }
})

test('P7 expiry: a short statement lapses by itself; the grant itself lives 2 years and offline SDK verification honours the clock', async () => {
  const a = await integrator('wallet.example')
  try {
    const p = await authorizePear(a, { dev: 'phone-8', ttl: 3 })
    assert.equal((await verify(p.record)).ok, true)
    await new Promise((r) => setTimeout(r, 4200))
    assert.equal((await verify(p.record)).reason, 'statement-expired')
    // Grant-level expiry: shift this process clock beyond the grant's exp and ask the SDK verifier.
    const realNow = Date.now
    try {
      Date.now = () => realNow() + (63072000 + 3600) * 1000
      assert.throws(() => sdk.verifyCustomGrantPop(p.record.cp), /expired/i)
    } finally { Date.now = realNow }
  } finally { a.app.close() }
})

test('P8 the user decides the transport scopes: the signer narrows the grant, and a statement claiming more is refused', async () => {
  // The integrator asks for everything; the signer approves only connect + read.
  const narrow = capsFor(['pear:connect', 'chat:read'])
  const a = await integrator('wallet.example', CAPS, narrow)
  try {
    const ok = await authorizePear(a, { dev: 'narrow-1', scope: ['pear:connect', 'chat:read'] })
    assert.equal((await verify(ok.record)).ok, true)
    const greedy = await authorizePear(a, { dev: 'narrow-2', scope: ['pear:connect', 'chat:send'], publish: false })
    assert.equal((await verify(greedy.record)).reason, 'scope-not-granted:chat:send')
  } finally { a.app.close() }
})
