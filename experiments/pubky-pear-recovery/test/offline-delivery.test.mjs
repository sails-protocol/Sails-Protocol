// Offline delivery over the Pear stack: a sealed message appended to a Hypercore mailbox by a sender that then
// goes OFFLINE is fetched later by the recipient from an always-on third-party seeder. Local testnet only.
// What this shows: store-and-forward is feasible with Hypercore; the direct channel (sendToPeer) is not.
// What it does not show: mobile background behaviour, seeder incentives/availability, production DHT.
import test from 'node:test'
import assert from 'node:assert/strict'
import DHT from 'hyperdht'
import createTestnet from 'hyperdht/testnet.js'
import Hyperswarm from 'hyperswarm'
import Hypercore from 'hypercore'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import b4a from 'b4a'
import sodium from 'sodium-universal'

const dirs = []
const cores = []
const store = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pprhc-')); dirs.push(d); return d }
const within = (p, ms, label) => Promise.race([p, new Promise((_resolve, reject) => setTimeout(() => reject(new Error('timeout: ' + label)), ms))])

function curve (pk, sk64) {
  const xpk = b4a.alloc(sodium.crypto_scalarmult_BYTES)
  sodium.crypto_sign_ed25519_pk_to_curve25519(xpk, pk)
  let xsk = null
  if (sk64) { xsk = b4a.alloc(sodium.crypto_scalarmult_SCALARBYTES); sodium.crypto_sign_ed25519_sk_to_curve25519(xsk, sk64) }
  return { xpk, xsk }
}

test('O1 the direct channel fails while the peer is offline (this is what Sails sendToPeer would see)', async (t) => {
  const testnet = await createTestnet(3)
  t.after(() => testnet.destroy())
  const receiverKey = DHT.keyPair(b4a.alloc(32, 0x31)) // never started
  const dht = new DHT({ bootstrap: testnet.bootstrap })
  t.after(() => dht.destroy())
  const socket = dht.connect(receiverKey.publicKey)
  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 8000)
    socket.on('error', () => { clearTimeout(timer); resolve('error') })
    socket.on('open', () => { clearTimeout(timer); resolve('open') })
  })
  assert.notEqual(outcome, 'open')
  socket.destroy()
})

test('O2 store-and-forward: sender appends a sealed message and goes offline; the recipient later reads it through a seeder', async (t) => {
  const testnet = await createTestnet(3)
  t.after(() => testnet.destroy())
  const recipient = DHT.keyPair(b4a.alloc(32, 0x42)) // Pear key of the recipient (seed fixed for the test only)
  const swarms = []
  const mk = () => { const s = new Hyperswarm({ bootstrap: testnet.bootstrap }); swarms.push(s); return s }
  t.after(async () => { for (const s of swarms) await s.destroy().catch(() => {}); for (const c of cores) await c.close().catch(() => {}); for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} } })

  // --- sender: writes the mailbox, seals the message to the recipient's Pear key, then replicates to the seeder
  const senderCore = new Hypercore(store())
  cores.push(senderCore)
  await senderCore.ready()
  const { xpk } = curve(recipient.publicKey)
  const message = b4a.from(JSON.stringify({ kind: 'chat', text: 'offer 0.01 BTC, pix at 14h' }))
  const sealed = b4a.alloc(message.length + sodium.crypto_box_SEALBYTES)
  sodium.crypto_box_seal(sealed, message, xpk)
  await senderCore.append(sealed)
  const senderSwarm = mk()
  senderSwarm.on('connection', (c) => senderCore.replicate(c))
  senderSwarm.join(senderCore.discoveryKey)
  await senderSwarm.flush()

  // --- always-on seeder (a third party that can only see ciphertext)
  const seederCore = new Hypercore(store(), senderCore.key)
  cores.push(seederCore)
  await seederCore.ready()
  const seederSwarm = mk()
  seederSwarm.on('connection', (c) => seederCore.replicate(c))
  seederSwarm.join(seederCore.discoveryKey)
  await within(seederCore.get(0, { timeout: 15000 }), 20000, 'seeder download')
  assert.equal(seederCore.length, 1)

  // --- the sender disappears
  await senderSwarm.destroy()
  await senderCore.close()

  // --- the recipient comes online later and has only the mailbox key
  const readerCore = new Hypercore(store(), senderCore.key)
  cores.push(readerCore)
  await readerCore.ready()
  const readerSwarm = mk()
  readerSwarm.on('connection', (c) => readerCore.replicate(c))
  readerSwarm.join(readerCore.discoveryKey)
  const got = await within(readerCore.get(0, { timeout: 20000 }), 25000, 'recipient read')

  const { xpk: rpk, xsk } = curve(recipient.publicKey, recipient.secretKey)
  const out = b4a.alloc(got.length - sodium.crypto_box_SEALBYTES)
  assert.equal(sodium.crypto_box_seal_open(out, got, rpk, xsk), true)
  assert.equal(JSON.parse(b4a.toString(out)).text, 'offer 0.01 BTC, pix at 14h')

  // the seeder cannot read it
  const other = DHT.keyPair(b4a.alloc(32, 0x77))
  const { xpk: opk, xsk: osk } = curve(other.publicKey, other.secretKey)
  assert.equal(sodium.crypto_box_seal_open(b4a.alloc(got.length - sodium.crypto_box_SEALBYTES), got, opk, osk), false)
})
