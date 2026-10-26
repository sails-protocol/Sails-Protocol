// FIELD KIT - offline delivery across networks with Hypercore: write (sender), seed (always-on third party), read (recipient).
// Messages are sealed to the recipient's Pear key; the seeder only sees ciphertext. Throwaway keys; public DHT unless --bootstrap.
//   sender : node field/mailbox.mjs write --dir ./mb-sender --to <recipient pear pk hex> --text "hello" [--hold 120]
//   seeder : node field/mailbox.mjs seed  --dir ./mb-seed   --key <mailbox key hex>
//   reader : node field/mailbox.mjs read  --dir ./mb-read   --key <mailbox key hex> --seed <recipient seed hex> [--timeout 120]
//   recipient identity: node field/mailbox.mjs identity       -> prints a throwaway seed and its Pear public key
import Hypercore from 'hypercore'
import Hyperswarm from 'hyperswarm'
import DHT from 'hyperdht'
import b4a from 'b4a'
import sodium from 'sodium-universal'

const cmd = process.argv[2]
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d }
const out = (o) => console.log(JSON.stringify({ t: new Date().toISOString(), cmd, ...o }))
const bootstrap = arg('bootstrap')?.split(',')
const swarm = () => new Hyperswarm(bootstrap ? { bootstrap } : {})
const toX = (pk, sk) => { const xpk = b4a.alloc(32); sodium.crypto_sign_ed25519_pk_to_curve25519(xpk, pk); let xsk = null; if (sk) { xsk = b4a.alloc(32); sodium.crypto_sign_ed25519_sk_to_curve25519(xsk, sk) } return { xpk, xsk } }

if (cmd === 'identity') {
  const seed = b4a.alloc(32); sodium.randombytes_buf(seed)
  out({ seed: b4a.toString(seed, 'hex'), pear: b4a.toString(DHT.keyPair(seed).publicKey, 'hex') })
} else if (cmd === 'write') {
  const core = new Hypercore(arg('dir')); await core.ready()
  const { xpk } = toX(b4a.from(arg('to'), 'hex'))
  const msg = b4a.from(JSON.stringify({ text: arg('text', 'hello') }))
  const sealed = b4a.alloc(msg.length + sodium.crypto_box_SEALBYTES); sodium.crypto_box_seal(sealed, msg, xpk)
  await core.append(sealed)
  const s = swarm(); s.on('connection', (c) => core.replicate(c)); s.join(core.discoveryKey)
  out({ event: 'written', mailboxKey: b4a.toString(core.key, 'hex'), length: core.length, holdingSec: Number(arg('hold', 120)) })
  setTimeout(async () => { await s.destroy(); await core.close(); out({ event: 'sender-offline' }); process.exit(0) }, Number(arg('hold', 120)) * 1000)
} else if (cmd === 'seed') {
  const core = new Hypercore(arg('dir'), b4a.from(arg('key'), 'hex')); await core.ready()
  const s = swarm(); s.on('connection', (c) => { out({ event: 'peer' }); core.replicate(c) }); s.join(core.discoveryKey)
  out({ event: 'seeding', length: core.length })
  // fetch every block in order, waiting for new ones (an explicit get() is what triggers the download)
  ;(async () => { for (let i = 0; ; i++) { await core.get(i); out({ event: 'replicated', length: core.length }) } })().catch((e) => out({ event: 'seed-error', error: String(e.message) }))
  setInterval(() => {}, 1 << 30)
} else if (cmd === 'read') {
  const core = new Hypercore(arg('dir'), b4a.from(arg('key'), 'hex')); await core.ready()
  const s = swarm(); s.on('connection', (c) => core.replicate(c)); s.join(core.discoveryKey)
  const t0 = Date.now()
  const kp = DHT.keyPair(b4a.from(arg('seed'), 'hex'))
  const block = await core.get(0, { timeout: Number(arg('timeout', 120)) * 1000 }).catch(() => null)
  if (!block) { out({ event: 'not-delivered', ms: Date.now() - t0 }); process.exit(1) }
  const { xpk, xsk } = toX(kp.publicKey, kp.secretKey)
  const plain = b4a.alloc(block.length - sodium.crypto_box_SEALBYTES)
  out({ event: sodium.crypto_box_seal_open(plain, block, xpk, xsk) ? 'delivered' : 'cannot-open', ms: Date.now() - t0, text: JSON.parse(b4a.toString(plain) || '{}').text })
  await s.destroy(); await core.close(); process.exit(0)
}
