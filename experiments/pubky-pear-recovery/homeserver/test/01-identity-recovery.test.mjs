// Pubky identity creation, native recovery on a "new device" (fresh process, nothing but the
// recovery file and the passphrase), and negative recovery cases, against the REAL homeserver.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { STATE_DIR, spawnRole, testnet } from '../lib.mjs'

const PASS = 'test-only-passphrase-do-not-reuse'
const PROFILE = '/pub/sails.market/profile.json'
const state = { pk: null }

test('R1 identity creation: sign up on the real homeserver, sign in with root, write, public read by a stranger', async () => {
  const signer = spawnRole('role-signer.mjs', { PPR_SIGNER_PASSPHRASE: PASS })
  try {
    const { pk } = await signer.ok('create')
    state.pk = pk
    fs.writeFileSync(`${STATE_DIR}/identity.json`, JSON.stringify({ pk }))
    await signer.ok('rootPut', { path: PROFILE, json: { name: 'lab user', n: 1 } })
    const stranger = testnet() // no key, no session
    const seen = await stranger.publicStorage.getJson(`pubky${pk}${PROFILE}`)
    assert.deepEqual(seen, { name: 'lab user', n: 1 })
    assert.ok(fs.statSync(`${STATE_DIR}/recovery.bin`).size > 50)
  } finally { signer.close() }
})

test('R2 native recovery on a new device: only recovery file + passphrase -> same identity, login works, old data visible', async () => {
  const signer = spawnRole('role-signer.mjs', { PPR_SIGNER_PASSPHRASE: PASS }) // brand-new process
  try {
    const { pk } = await signer.ok('load')
    assert.equal(pk, state.pk, 'same Pubky identity after recovery')
    assert.deepEqual(await signer.ok('rootGet', { path: PROFILE }), { name: 'lab user', n: 1 })
    await signer.ok('rootPut', { path: PROFILE, json: { name: 'lab user', n: 2 } })
    const seen = await testnet().publicStorage.getJson(`pubky${pk}${PROFILE}`)
    assert.equal(seen.n, 2)
  } finally { signer.close() }
})

test('R3 negative recovery: wrong passphrase, flipped byte, truncated file are all rejected; none yields another identity', async () => {
  const good = fs.readFileSync(`${STATE_DIR}/recovery.bin`)
  const flipped = Buffer.from(good); flipped[flipped.length - 5] ^= 0x01
  fs.writeFileSync(`${STATE_DIR}/recovery-flipped.bin`, flipped)
  fs.writeFileSync(`${STATE_DIR}/recovery-truncated.bin`, good.subarray(0, good.length - 20))
  const cases = [
    ['wrong passphrase', 'recovery.bin', 'not-the-passphrase'],
    ['flipped byte', 'recovery-flipped.bin', PASS],
    ['truncated', 'recovery-truncated.bin', PASS]
  ]
  for (const [label, file, pass] of cases) {
    const signer = spawnRole('role-signer.mjs', { PPR_SIGNER_PASSPHRASE: pass })
    try {
      const e = await signer.fails('load', { file: `${STATE_DIR}/${file}` })
      assert.ok(e.message.length > 0, label)
    } finally { signer.close() }
  }
})

test('R4 a random key is a different identity: an unrelated recovery file never restores the original', async () => {
  const stranger = spawnRole('role-signer.mjs', { PPR_SIGNER_PASSPHRASE: 'other' })
  try {
    const other = await stranger.ok('create', { file: `${STATE_DIR}/stranger.bin` })
    assert.notEqual(other.pk, state.pk)
  } finally { stranger.close() }
})