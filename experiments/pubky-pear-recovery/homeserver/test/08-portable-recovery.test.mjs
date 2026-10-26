// Portable identity, facts and reputation with REAL Pubky artifacts (SDK grants + custom PoP) on the real homeserver:
// identity recovered in a second app, an independent verifier (no SDK, no Sails code besides node:crypto verification)
// reads only public storage. Also shows what recovery does NOT bring back: private openings and confirmations.
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { STATE_DIR, closeAll, spawnRole } from '../lib.mjs'
import { confirmation, keyFromSeed } from '../../portable/src/issue.mjs'

const PASS = 'test-only-passphrase-do-not-reuse'
const AUD = 'sails.market'
const now = () => Math.floor(Date.now() / 1000)
const rk = () => keyFromSeed(new Uint8Array(globalThis.crypto.getRandomValues(new Uint8Array(32))))
let identity
let signerA
let verifier
const A = {}; const B = {}

async function appWithGrant (signer, capsFor) {
  const app = spawnRole('role-integrator.mjs')
  const { participant } = await app.ok('portableInit')
  const { url } = await app.ok('start', { caps: capsFor(participant), clientId: 'wallet.example' })
  const waiting = app.ok('await')
  await signer.ok('approve', { url })
  const info = await waiting
  return { app, participant, info }
}
const consentCaps = (p) => `/pub/sails.market/bindings/${p}/:rw,/pub/sails.market/facts/${p}/:rw`

before(async () => {
  identity = JSON.parse(fs.readFileSync(`${STATE_DIR}/identity.json`, 'utf8')).pk
  signerA = spawnRole('role-signer.mjs', { PPR_SIGNER_PASSPHRASE: PASS })
  assert.equal((await signerA.ok('load')).pk, identity)
  verifier = spawnRole('role-portable-verifier.mjs') // plain HTTP + node:crypto
})
after(() => closeAll())

test('X1 app A (wallet): binds a Participant key to the Pubky identity with root consent in the grant, publishes the binding and a trade chain', async () => {
  Object.assign(A, await appWithGrant(signerA, consentCaps))
  const bundle = await A.app.ok('portableBinding', { audience: AUD, iat: now(), ttl: 86400 })
  await A.app.ok('put', { path: `/pub/sails.market/bindings/${A.participant}/binding.json`, json: bundle })
  // the real SDK grant must be read by the independent verifier at the root-consented level
  const r = await verifier.ok('verifyBinding', { bundle, now: now(), audience: AUD, requireLevel: 'root-consented' })
  assert.deepEqual([r.ok, r.level, r.pubky], [true, 'root-consented', identity])

  A.Q = [rk(), rk(), rk()]
  A.confirmations = []; A.openings = {}
  const trades = [[0, 'completed'], [0, 'completed'], [0, 'completed'], [1, 'completed'], [2, 'disputed-lost']]
  for (const [i, [qi, outcome]] of trades.entries()) {
    const t = await A.app.ok('portableTrade', { tradeRef: `ref-${i}-${Math.random()}`, counterparty: A.Q[qi].pk, outcome, iat: now() })
    await A.app.ok('put', { path: `/pub/sails.market/facts/${A.participant}/${i}.json`, json: t.fact })
    A.openings[t.tradeCommit] = t.opening
    if (outcome === 'completed') A.confirmations.push(confirmation(A.Q[qi], A.participant, { tradeCommit: t.tradeCommit, outcome, iat: now() }))
  }
  A.head = await A.app.ok('portableHead', { iat: now() })
  await A.app.ok('put', { path: `/pub/sails.market/facts/${A.participant}/head.json`, json: A.head })
})

test('X2 recovery in ANOTHER app (market): same Pubky identity from the recovery file, own Participant key, own root-consented binding', async () => {
  const signerB = spawnRole('role-signer.mjs', { PPR_SIGNER_PASSPHRASE: PASS }) // a different device / app
  assert.equal((await signerB.ok('load')).pk, identity)
  Object.assign(B, await appWithGrant(signerB, consentCaps))
  assert.notEqual(B.participant, A.participant, 'a new Participant key: the economic key is NOT recovered by the Pubky identity')
  const bundle = await B.app.ok('portableBinding', { audience: AUD, iat: now(), ttl: 86400 })
  await B.app.ok('put', { path: `/pub/sails.market/bindings/${B.participant}/binding.json`, json: bundle })
  B.signer = signerB
})

test('X3 an independent verifier, reading only public storage, accepts the identity, both bindings and the chain; reputation needs the private disclosure', async () => {
  const pub = await verifier.ok('collect', { identity })
  assert.equal(pub.bindings.length >= 2, true)
  const full = { ...pub, confirmations: A.confirmations, openings: A.openings, disputeClaims: [], bindingRevocations: [] }
  const r = await verifier.ok('verify', { pkg: full, now: now(), audience: AUD, expectedPubky: identity })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(r.participants.sort(), [A.participant, B.participant].sort())
  assert.deepEqual(r.reputation, { score: 1, trades: 5, completedConfirmed: 4, oneSided: 0, distinctCounterparties: 2, capped: 0, lost: 1, disputeClaims: 0 })
  // what recovery alone gives app B: the public chain verifies, but WITHOUT the private openings/confirmations nothing is confirmed
  const recovered = await verifier.ok('verify', { pkg: { ...pub, confirmations: [], openings: {}, disputeClaims: [], bindingRevocations: [] }, now: now(), audience: AUD, expectedPubky: identity })
  assert.equal(recovered.ok, true)
  assert.equal(recovered.reputation.completedConfirmed, 0)
  assert.equal(recovered.reputation.oneSided, 4)
  assert.equal(recovered.reputation.score, -3)
})

test('X4 copying the public chain under another identity does not transfer reputation (the chain participant is not bound there)', async () => {
  const attackerSigner = spawnRole('role-signer.mjs', { PPR_SIGNER_PASSPHRASE: 'x' })
  const atk = await attackerSigner.ok('create', { file: `${STATE_DIR}/attacker-portable.bin` })
  const evil = await appWithGrant(attackerSigner, consentCaps)
  const bundle = await evil.app.ok('portableBinding', { audience: AUD, iat: now(), ttl: 86400 })
  const pub = await verifier.ok('collect', { identity })
  const stolen = { bindings: [bundle], chains: pub.chains, confirmations: A.confirmations, openings: A.openings, disputeClaims: [], bindingRevocations: [] }
  assert.equal((await verifier.ok('verify', { pkg: stolen, now: now(), audience: AUD, expectedPubky: atk.pk })).reason, 'chain-participant-not-bound')
  // and a verifier that expects the victim refuses the attacker's binding outright
  assert.equal((await verifier.ok('verify', { pkg: stolen, now: now(), audience: AUD, expectedPubky: identity })).reason, 'wrong-identity')
})

test('X5 cherry-picking in the user\'s own storage: deleting one fact (or the head) is detected', async () => {
  const keep = (await A.app.ok('get', { path: `/pub/sails.market/facts/${A.participant}/4.json` }))
  await signerA.ok('rootDelete', { path: `/pub/sails.market/facts/${A.participant}/4.json` }) // hide the 'disputed-lost' tail
  const pub = await verifier.ok('collect', { identity })
  const r = await verifier.ok('verify', { pkg: { ...pub, confirmations: A.confirmations, openings: A.openings, disputeClaims: [], bindingRevocations: [] }, now: now(), audience: AUD, expectedPubky: identity })
  assert.equal(r.reason, 'chain:head-mismatch')
  // a pinned head (learned earlier or from a witness) is what catches a user who re-signs a shorter head
  assert.equal(A.head.body.seq, 4)
  await signerA.ok('rootPut', { path: `/pub/sails.market/facts/${A.participant}/4.json`, json: keep }) // restore
})

test('X6 a binding made through a grant WITHOUT the consent capability is only "delegated-only" and is refused as a Pubky-to-Participant binding', async () => {
  const app = spawnRole('role-integrator.mjs')
  const { participant } = await app.ok('portableInit')
  const { url } = await app.ok('start', { caps: '/pub/sails.market/pear/devices/:rw', clientId: 'other.example' })
  const waiting = app.ok('await'); await signerA.ok('approve', { url }); await waiting
  const bundle = await app.ok('portableBinding', { audience: AUD, iat: now(), ttl: 86400 })
  assert.equal(bundle.statement.participant, participant)
  assert.equal((await verifier.ok('verifyBinding', { bundle, now: now(), audience: AUD, requireLevel: 'root-consented' })).reason, 'not-root-consented')
  const any = await verifier.ok('verifyBinding', { bundle, now: now(), audience: AUD, requireLevel: 'any' })
  assert.deepEqual([any.ok, any.level], [true, 'delegated-only'])
})

test('X7 revocation: the participant-signed revocation removes app B\'s binding for every verifier at once; a revoked GRANT alone is invisible offline', async () => {
  const pub = await verifier.ok('collect', { identity })
  const base = { ...pub, confirmations: A.confirmations, openings: A.openings, disputeClaims: [] }
  await signerA.ok('revoke', { id: B.info.grantId }) // grant revoked at the homeserver
  const offline = await verifier.ok('verify', { pkg: { ...base, bindingRevocations: [] }, now: now(), audience: AUD, expectedPubky: identity })
  assert.equal(offline.participants.includes(B.participant), true, 'KNOWN LIMIT: offline verification cannot see the grant revocation')
  const rev = await B.app.ok('portableRevoke', { pubky: identity, iat: now() })
  const after = await verifier.ok('verify', { pkg: { ...base, bindingRevocations: [rev] }, now: now(), audience: AUD, expectedPubky: identity })
  assert.equal(after.participants.includes(B.participant), false)
  assert.equal(after.participants.includes(A.participant), true)
})
