// Confronts the lab receipt format with the REAL Sails hashing contracts. The two formulas below are
// copied literally from the repo (not imported: this experiment imports nothing from src/). They document
// gaps; they do not change any production contract.
//   OpenProof evidence hash : src/modules/open-proof/proof.service.ts:161-170
//   Timeline / event chain  : src/common/events/event-store.ts:92-104
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { load, world, NOW } from './_helpers.mjs'

function sailsCanonicalize (value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(sailsCanonicalize).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${sailsCanonicalize(value[k])}`).join(',')}}`
}
const sailsHashEvidence = (e) => createHash('sha256').update(sailsCanonicalize(e)).digest('hex')
const sailsEntryHash = (eventName, publishedAt, payload, prevHash) =>
  createHash('sha256').update(`${eventName}:${publishedAt}:${JSON.stringify(payload)}:${prevHash}`).digest('hex')

test('C1 compatible: for plain objects the lab canonical JSON and OpenProof canonicalize produce the same bytes', async () => {
  const { canonicalize } = await load('canonical.mjs')
  const evidence = { b: [1, 'x', null, { z: true, a: 'k' }], a: 'text', n: 42 }
  assert.equal(canonicalize(evidence), sailsCanonicalize(evidence))
  assert.equal(createHash('sha256').update(canonicalize(evidence)).digest('hex'), sailsHashEvidence(evidence))
})

test('C2 gap: they diverge on non-integers and undefined (lab throws, OpenProof silently encodes)', async () => {
  const { canonicalize } = await load('canonical.mjs')
  assert.throws(() => canonicalize({ price: 1.5 }))
  assert.equal(sailsCanonicalize({ price: 1.5 }), '{"price":1.5}')
  assert.throws(() => canonicalize({ a: undefined }))
  assert.equal(sailsCanonicalize({ a: undefined }), '{"a":undefined}', 'OpenProof canonicalize emits invalid JSON for undefined members')
})

test('C3 gap: the Timeline entry hash is NOT canonical (key order changes the hash) and has no domain separation or signature', () => {
  const p1 = { tradeId: 't1', amount: '10' }
  const p2 = { amount: '10', tradeId: 't1' } // same logical payload, other insertion order
  assert.notEqual(sailsEntryHash('trade.settled', '2026-10-26T00:00:00.000Z', p1, 'genesis'), sailsEntryHash('trade.settled', '2026-10-26T00:00:00.000Z', p2, 'genesis'))
})

test('C4 gap: genesis marker and chain input differ from the lab chain (lab: 64 zeros, signed body + signature; Sails: "genesis", unsigned)', async () => {
  const w = await world()
  assert.equal(w.verify.GENESIS, '0'.repeat(64))
  assert.notEqual(w.verify.GENESIS, 'genesis')
  const e = w.issue.appendReceipt(w.identity, [], { ref: 'r', amountSats: 1, asset: 'BTC', counterparty: w.identity.z32, outcome: 'completed' }, NOW)
  assert.ok(e.sig, 'lab entries are signed; Timeline/Verification/ReputationEvent rows carry no signature field')
})

test('C5 gap: a lab receipt cannot be expressed as Claim + Proof + Verification without server-assigned fields', async () => {
  const w = await world()
  const e = w.issue.appendReceipt(w.identity, [], { ref: 'r', amountSats: 1, asset: 'BTC', counterparty: w.identity.z32, outcome: 'completed' }, NOW)
  // Fields the real contracts require that a portable signed receipt does not (and should not) invent client-side:
  const serverAssigned = ['Claim.id (uuid)', 'Claim.tradeId (Trade row)', 'Proof.id', 'Proof.evidenceHash recomputed server-side', 'Verification.verifiedBy', 'Verification.nonce', 'Participant ids (User.id), not Pubky keys']
  assert.ok(serverAssigned.length >= 7)
  assert.equal('claimId' in e.body, false)
  assert.equal('verifiedBy' in e.body, false)
})
