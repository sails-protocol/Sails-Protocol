// P51: FIDELITY of the 7 Esplora routes (through the front proxy) against the real bitcoind regtest. BLOCKING (GK P51 §2/(b)).
// The proxy invents nothing, so every answer must equal what bitcoind itself says. This test proves it, route by route,
// and proves the fixed fee rate is accepted by the real node (>= minrelaytxfee) by a REAL broadcast through POST /tx.
//
// Needs a running stack (bitcoind regtest + electrs + proxy). Env (all set by tests/regtest/scripts/run-once.sh):
//   RPC_URL (http://127.0.0.1:18443), RPC_USER, RPC_PASS (ephemeral, generated in the job), PROXY_URL (http://127.0.0.1:3003),
//   FIXED_FEE_SAT_PER_VB, OUT_DIR (evidence/runN).
// Writes OUT_DIR/fidelity.json (audit: includes txids) and OUT_DIR/structure-fidelity.json (STRUCTURE only: no txid,
// no height, no time: this is the file compared across the two runs).
// Exit code 1 if any check fails; every check runs before the verdict.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const need = (k) => {
  const v = process.env[k]
  if (!v) { console.error(`missing env ${k}`); process.exit(2) }
  return v
}
const RPC_URL = need('RPC_URL')
const RPC_AUTH = 'Basic ' + Buffer.from(`${need('RPC_USER')}:${need('RPC_PASS')}`).toString('base64')
const PROXY = need('PROXY_URL')
const FEE = Number(need('FIXED_FEE_SAT_PER_VB'))
const OUT_DIR = need('OUT_DIR')
mkdirSync(OUT_DIR, { recursive: true })

const WALLET = 'p51'
let rpcId = 0
async function rpc(method, params = [], wallet) {
  const res = await fetch(`${RPC_URL}${wallet ? `/wallet/${wallet}` : ''}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: RPC_AUTH },
    body: JSON.stringify({ jsonrpc: '1.0', id: ++rpcId, method, params }),
  })
  const j = await res.json().catch(() => ({}))
  if (j.error) throw new Error(`rpc ${method}: ${JSON.stringify(j.error)}`)
  return j.result
}
const w = (method, params) => rpc(method, params, WALLET)
const sats = (btc) => Math.round(btc * 1e8)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const get = (path) => fetch(PROXY + path)

async function waitSynced(timeoutMs = 90_000) {
  const want = await rpc('getblockcount')
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await get('/blocks/tip/height')
      if (res.status === 200 && Number((await res.text()).trim()) === want) return want
    } catch { /* electrs still starting */ }
    await sleep(500)
  }
  throw new Error(`electrs did not reach height ${want} within ${timeoutMs} ms`)
}
function scriptType(hex) {
  if (/^0014[0-9a-f]{40}$/.test(hex)) return 'p2wpkh'
  if (/^0020[0-9a-f]{64}$/.test(hex)) return 'p2wsh'
  if (/^5120[0-9a-f]{64}$/.test(hex)) return 'p2tr'
  return 'other'
}

const results = []
const structure = {}
async function check(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, pass: true, detail: detail ?? null })
    console.log(`PASS ${name}`)
  } catch (err) {
    results.push({ name, pass: false, detail: String(err && err.message ? err.message : err) })
    console.log(`FAIL ${name}: ${err && err.message ? err.message : err}`)
  }
}
const eq = (a, b, what) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }

// ---- chain setup (from block 0, deterministic procedure; txids/heights differ run to run) ----
const chain = (await rpc('getblockchaininfo'))
if (chain.chain !== 'regtest') { console.error(`REFUSING: chain is ${chain.chain}, not regtest`); process.exit(2) }
await rpc('createwallet', [WALLET])
const minerAddr = await w('getnewaddress', ['', 'bech32'])
await rpc('generatetoaddress', [101, minerAddr])
const targetAddr = await w('getnewaddress', ['', 'bech32']) // the address whose UTXOs we query
const emptyAddr = await w('getnewaddress', ['', 'bech32']) // never funded
const fundTxid = await w('sendtoaddress', [targetAddr, 0.5])
await rpc('generatetoaddress', [1, minerAddr])
await waitSynced()

const fundRaw = await rpc('getrawtransaction', [fundTxid, true])
const fundVout = fundRaw.vout.find((o) => o.scriptPubKey.address === targetAddr)
const fundBlock = await rpc('getblockheader', [fundRaw.blockhash])

await check('route 1/7 GET /blocks/tip/height: plain integer equal to getblockcount', async () => {
  const res = await get('/blocks/tip/height')
  eq(res.status, 200, 'status')
  const body = (await res.text())
  if (!/^[0-9]+$/.test(body.trim())) throw new Error(`not a plain integer: ${JSON.stringify(body)}`)
  eq(Number(body), await rpc('getblockcount'), 'height')
  structure.tipHeight = { plainInteger: true }
})

await check('route 2/7 GET /address/{a}/utxo: set equals scantxoutset; status fields; stable order; empty address => []', async () => {
  const res = await get(`/address/${targetAddr}/utxo`)
  eq(res.status, 200, 'status')
  const list = await res.json()
  if (!Array.isArray(list)) throw new Error('not an array')
  const scan = await rpc('scantxoutset', ['start', [`addr(${targetAddr})`]])
  const want = scan.unspents.map((u) => `${u.txid}:${u.vout}:${sats(u.amount)}`).sort()
  const got = list.map((u) => `${u.txid}:${u.vout}:${u.value}`).sort()
  eq(got, want, 'utxo set (txid:vout:value)')
  const entry = list.find((u) => u.txid === fundTxid && u.vout === fundVout.n)
  if (!entry) throw new Error('funded output missing')
  eq(entry.status.confirmed, true, 'status.confirmed')
  eq(entry.status.block_height, fundBlock.height, 'status.block_height')
  eq(entry.status.block_hash, fundRaw.blockhash, 'status.block_hash')
  eq(entry.value, sats(fundVout.value), 'value (sats)')
  // Order: Esplora does not define one and bitcoind has none to compare with, so we assert only that it is STABLE.
  const again = await (await get(`/address/${targetAddr}/utxo`)).json()
  eq(again.map((u) => `${u.txid}:${u.vout}`), list.map((u) => `${u.txid}:${u.vout}`), 'order stable across two calls')
  const empty = await get(`/address/${emptyAddr}/utxo`)
  eq(empty.status, 200, 'empty status')
  eq(await empty.json(), [], 'empty address body')
  structure.addressUtxo = { setEqualsNode: true, statusFields: ['confirmed', 'block_height', 'block_hash'], orderStable: true, emptyAddress: [] }
  return { utxoCount: list.length }
})

await check('route 3/7 GET /tx/{txid}: fields equal getrawtransaction; 404 for a missing tx', async () => {
  const res = await get(`/tx/${fundTxid}`)
  eq(res.status, 200, 'status')
  const tx = await res.json()
  eq(tx.txid, fundTxid, 'txid')
  eq(tx.vin.length, fundRaw.vin.length, 'vin count')
  eq(tx.vout.length, fundRaw.vout.length, 'vout count')
  for (const [i, o] of fundRaw.vout.entries()) {
    eq(tx.vout[i].scriptpubkey, o.scriptPubKey.hex, `vout[${i}].scriptpubkey`)
    eq(tx.vout[i].value, sats(o.value), `vout[${i}].value`)
    if (o.scriptPubKey.address) eq(tx.vout[i].scriptpubkey_address, o.scriptPubKey.address, `vout[${i}].address`)
  }
  eq(tx.status.confirmed, true, 'status.confirmed')
  const missing = await get(`/tx/${'0'.repeat(64)}`)
  eq(missing.status, 404, 'missing tx status')
  structure.tx = { fieldsEqualNode: true, outputs: fundRaw.vout.length, outputTypes: fundRaw.vout.map((o) => scriptType(o.scriptPubKey.hex)).sort(), missingTx: 404 }
})

await check('route 4/7 GET /tx/{txid}/status: equals node (confirmed, block_height, block_hash, block_time)', async () => {
  const res = await get(`/tx/${fundTxid}/status`)
  eq(res.status, 200, 'status')
  const st = await res.json()
  eq(st, { confirmed: true, block_height: fundBlock.height, block_hash: fundRaw.blockhash, block_time: fundBlock.time }, 'status object')
  structure.txStatus = { confirmed: true, fields: ['confirmed', 'block_height', 'block_hash', 'block_time'] }
})

await check('route 5/7 GET /tx/{txid}/hex: equals getrawtransaction (non-verbose)', async () => {
  const res = await get(`/tx/${fundTxid}/hex`)
  eq(res.status, 200, 'status')
  eq((await res.text()).trim(), await rpc('getrawtransaction', [fundTxid, false]), 'raw hex')
  structure.txHex = { equalsNode: true }
})

// Build a REAL spend of the funded output at the FIXED fee rate, WITHOUT broadcasting it ourselves.
const destAddr = await w('getnewaddress', ['', 'bech32'])
const built = await w('send', [{ [destAddr]: 0.1 }, null, 'unset', null, {
  add_to_wallet: false, inputs: [{ txid: fundTxid, vout: fundVout.n }], add_inputs: false, fee_rate: FEE,
}])
if (!built.complete || !built.hex) throw new Error('could not build the spend')
const spendDecoded = await rpc('decoderawtransaction', [built.hex])
const spendTxid = spendDecoded.txid

await check('route 7/7 POST /tx: the FIXED fee is accepted by the real node (testmempoolaccept), broadcast through the proxy returns the txid, tx lands in the mempool', async () => {
  const accept = await rpc('testmempoolaccept', [[built.hex]])
  if (!accept[0].allowed) throw new Error(`testmempoolaccept rejected at ${FEE} sat/vB: ${JSON.stringify(accept[0])}`)
  const res = await fetch(`${PROXY}/tx`, { method: 'POST', body: built.hex })
  eq(res.status, 200, 'POST status')
  eq((await res.text()).trim(), spendTxid, 'POST returns the txid')
  const entry = await rpc('getmempoolentry', [spendTxid])
  if (!entry || !entry.vsize) throw new Error('not in the mempool')
  structure.postTx = { acceptedAtFixedFee: true, broadcasts: 1 }
  return { feeSatPerVB: FEE, vsize: entry.vsize }
})

await check('route 6/7 GET /tx/{txid}/outspend/{vout}: unspent => {spent:false}; spent (mempool then confirmed) equals the node', async () => {
  // After the POST above, the funded output is spent by spendTxid (unconfirmed). electrs picks the mempool up on its own
  // polling cycle, so wait (bounded) for it to catch up: a delay is not an infidelity, a wrong answer after the wait is.
  let res
  let os
  for (const t0 = Date.now(); Date.now() - t0 < 60_000;) {
    res = await get(`/tx/${fundTxid}/outspend/${fundVout.n}`)
    os = res.status === 200 ? await res.json() : null
    if (os && os.spent === true) break
    await sleep(1000)
  }
  eq(res.status, 200, 'status')
  eq(os.spent, true, 'spent (mempool)')
  eq(os.txid, spendTxid, 'spending txid')
  eq(os.status.confirmed, false, 'spending status (mempool)')
  // The other output of the funding tx (the wallet change) is unspent.
  const otherN = fundRaw.vout.find((o) => o.n !== fundVout.n).n
  res = await get(`/tx/${fundTxid}/outspend/${otherN}`)
  os = await res.json()
  eq(os, { spent: false }, 'unspent output')
  await rpc('generatetoaddress', [1, minerAddr])
  await waitSynced()
  res = await get(`/tx/${fundTxid}/outspend/${fundVout.n}`)
  os = await res.json()
  eq(os.spent, true, 'spent (confirmed)')
  eq(os.status.confirmed, true, 'spending status (confirmed)')
  eq(os.vin, 0, 'spending input index')
  structure.outspend = { unspent: { spent: false }, spentInMempool: { spent: true, confirmed: false }, spentConfirmed: { spent: true, confirmed: true }, spendingInput: 0 }
})

await check('POST /tx error paths: garbage hex and an already-confirmed tx are errors (>= 400), never success', async () => {
  const garbage = await fetch(`${PROXY}/tx`, { method: 'POST', body: 'zz-not-hex' })
  if (garbage.status < 400) throw new Error(`garbage hex answered ${garbage.status}`)
  const dup = await fetch(`${PROXY}/tx`, { method: 'POST', body: built.hex }) // now confirmed: bitcoind refuses
  if (dup.status < 400) throw new Error(`re-broadcast of a confirmed tx answered ${dup.status}`)
  structure.postTxErrors = { garbage: 'error', confirmedRebroadcast: 'error' }
})

await check('route 8 GET /v1/fees/recommended: mempool.space shape, FIXED declared constant, integers', async () => {
  const res = await get('/v1/fees/recommended')
  eq(res.status, 200, 'status')
  const fees = await res.json()
  for (const k of ['fastestFee', 'halfHourFee', 'hourFee', 'economyFee', 'minimumFee']) {
    if (!Number.isInteger(fees[k])) throw new Error(`${k} is not an integer`)
    eq(fees[k], FEE, k)
  }
  structure.fees = { fixed: true, tiers: 5, notMarketData: true }
})

const final = await rpc('getblockchaininfo')
const pass = results.every((r) => r.pass)
writeFileSync(join(OUT_DIR, 'fidelity.json'), JSON.stringify({
  pass, chain: chain.chain, startBlocks: chain.blocks, finalBlocks: final.blocks,
  txids: { funding: fundTxid, spend: spendTxid }, fixedFeeSatPerVB: FEE, results,
  note: 'The fixed fee does NOT reflect the market; economic adequacy of the fee is outside this demonstration.',
}, null, 2))
// STRUCTURE only: no txid, no height, no time, no hash. Compared across run 1 and run 2.
writeFileSync(join(OUT_DIR, 'structure-fidelity.json'), JSON.stringify({ allChecksPass: pass, checks: results.map((r) => ({ name: r.name, pass: r.pass })), ...structure }, null, 2))
console.log(pass ? 'FIDELITY: ALL PASS' : 'FIDELITY: FAILED')
process.exit(pass ? 0 : 1)
