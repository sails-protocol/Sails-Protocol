// tests/httpBoundaryCallSites.test.ts
//
// The economic callers of boundedFetch(), through their real code, against a real HTTP server on
// 127.0.0.1 standing in for the explorer / bundler (never the public internet). A stalled, partial or
// malformed response is never an answer: each call fails closed within its bound, with the semantics it
// already had (404 on a status read keeps meaning what it meant; nothing new is inferred from a timeout).

import http from 'http'
import type { AddressInfo } from 'net'

const T = 300
const SLACK = 250

type Reply = (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>

describe('HTTP boundary — economic call sites fail closed on stalled or unreadable responses (real HTTP server)', () => {
  let server: http.Server
  let reply: Reply = (_q, res) => { res.end('{}') }
  let hits = 0
  const sockets = new Set<import('net').Socket>()
  const holds: Array<() => void> = []
  let mod: {
    multisig: typeof import('../src/modules/open-settlement/multisig.provider')
    safeGuard: typeof import('../src/modules/open-settlement/safe-guard-evm.provider')
    BoundedRpcTimeoutError: typeof import('../src/modules/open-settlement/bounded-rpc').BoundedRpcTimeoutError
    BoundedResponseTooLargeError: typeof import('../src/modules/open-settlement/bounded-rpc').BoundedResponseTooLargeError
  }
  const env: Record<string, string | undefined> = {}
  const SET = ['MULTISIG_EXPLORER_API_URL', 'MULTISIG_EXPLORER_TIMEOUT_MS', 'SAFE_GUARD_EVM_BUNDLER_URL', 'SAFE_GUARD_EVM_RPC_TIMEOUT_MS']

  beforeAll(async () => {
    server = http.createServer((req, res) => { hits++; res.setHeader('Connection', 'close'); void reply(req, res) })
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    for (const k of SET) env[k] = process.env[k]
    process.env.MULTISIG_EXPLORER_API_URL = base
    process.env.MULTISIG_EXPLORER_TIMEOUT_MS = String(T)
    process.env.SAFE_GUARD_EVM_BUNDLER_URL = `${base}/bundler`
    process.env.SAFE_GUARD_EVM_RPC_TIMEOUT_MS = String(T)
    jest.isolateModules(() => {
      mod = {
        multisig: require('../src/modules/open-settlement/multisig.provider'),
        safeGuard: require('../src/modules/open-settlement/safe-guard-evm.provider'),
        BoundedRpcTimeoutError: require('../src/modules/open-settlement/bounded-rpc').BoundedRpcTimeoutError,
        BoundedResponseTooLargeError: require('../src/modules/open-settlement/bounded-rpc').BoundedResponseTooLargeError,
      }
    })
  })
  afterEach(async () => {
    for (const h of holds.splice(0)) h()
    await Promise.all([...sockets].map((s) => new Promise<void>((r) => { s.once('close', () => r()); s.destroy() })))
    hits = 0
  })
  afterAll(async () => {
    for (const k of SET) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k] }
    await new Promise<void>((r) => server.close(() => r()))
  })

  /** Headers now, then a body that never completes (until the test's teardown). */
  const stalledBody = (status = 200, partial = ''): Reply => async (_q, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    if (partial) res.write(partial); else res.flushHeaders()
    await new Promise<void>((r) => holds.push(r))
    if (!res.destroyed) res.end()
  }
  async function timed<T>(op: () => Promise<T>): Promise<{ ms: number; value?: T; error?: any }> {
    const t0 = Date.now()
    try { const value = await op(); return { ms: Date.now() - t0, value } } catch (error) { return { ms: Date.now() - t0, error } }
  }
  const txid = 'ab'.repeat(32)

  // ─── MULTISIG explorer reads (PASS 0 / PASS 1 / reorg sweeps) ──────────────────────────────────────────

  it('existence read: a stalled body fails with BoundedRpcTimeoutError within one attempt\'s bound (never "exists" / "absent")', async () => {
    reply = stalledBody(200, '{"confirmed":')
    const r = await timed(() => mod.multisig.fetchTransactionExistence(txid))
    expect(r.error).toBeInstanceOf(mod.BoundedRpcTimeoutError)
    expect(r.value).toBeUndefined()
    expect(hits).toBe(1) // body phase is not re-issued
    expect(r.ms).toBeLessThan(T + SLACK)
  })

  it('existence read keeps its existing semantics: 404 -> exists:false, 5xx -> throws after its bounded retries, malformed JSON -> throws', async () => {
    reply = (_q, res) => { res.writeHead(404); res.end() }
    expect(await mod.multisig.fetchTransactionExistence(txid)).toEqual({ exists: false, confirmed: false })
    hits = 0
    reply = (_q, res) => { res.writeHead(503); res.end() }
    await expect(mod.multisig.fetchTransactionExistence(txid)).rejects.toThrow(/503/)
    expect(hits).toBe(3)
    reply = (_q, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{oops') }
    await expect(mod.multisig.fetchTransactionExistence(txid)).rejects.toBeDefined()
  })

  it('confirmation-status, outputs, outspend and tip-height reads: a stalled body never becomes a value', async () => {
    reply = stalledBody()
    for (const call of <Array<() => Promise<unknown>>>[
      () => mod.multisig.fetchTransactionConfirmationStatus(txid),
      () => mod.multisig.fetchTransactionOutputs(txid),
      () => mod.multisig.fetchOutpointSpendStatus(txid, 0),
      () => mod.multisig.fetchChainTipHeight(),
    ]) {
      const r = await timed(call)
      expect(r.error).toBeInstanceOf(mod.BoundedRpcTimeoutError)
      expect(r.ms).toBeLessThan(T + SLACK)
    }
  })

  it('UTXO read (PASS 0 / PASS 1 outpoint check): a stalled body fails closed, never "unspent" / "spent"', async () => {
    reply = stalledBody(200, '[{"txid":')
    const r = await timed(() => (mod.multisig.multisigProvider as any).fetchUtxos('tb1qexample'))
    expect(r.error).toBeInstanceOf(mod.BoundedRpcTimeoutError)
    expect(r.ms).toBeLessThan(T + SLACK)
  })

  it('MULTISIG broadcast: an accepted response whose body stalls fails (outcome unknown to the caller), within one attempt, never retried', async () => {
    reply = stalledBody(200)
    const r = await timed(() => (mod.multisig.multisigProvider as any).broadcast('00'))
    expect(r.error).toBeInstanceOf(mod.BoundedRpcTimeoutError)
    expect(hits).toBe(1)
    expect(r.ms).toBeLessThan(T + SLACK)
  })

  it('fee-rate read: a stalled body fails; no fee is guessed', async () => {
    reply = stalledBody(200, '{"halfHourFee":')
    const r = await timed(() => (mod.multisig.multisigProvider as any).fetchFeeRateSatsPerVByte())
    expect(r.error).toBeDefined()
    expect(r.value).toBeUndefined()
    expect(r.ms).toBeLessThan(T + SLACK)
  })

  // ─── SAFE_GUARD_EVM bundler submission (economic write) ────────────────────────────────────────────────

  const userOp = { sender: '0x' + '11'.repeat(20), nonce: 1n, initCode: '0x', callData: '0x', accountGasLimits: '0x' + '00'.repeat(32), preVerificationGas: 1n, gasFees: '0x' + '00'.repeat(32), paymasterAndData: '0x' }
  const expectedUserOpHash = 'ab'.repeat(32)
  const submit = () => (mod.safeGuard.safeGuardEvmProvider as any).broadcast(userOp, '0xsig', expectedUserOpHash)

  it('bundler: an accepted (200) response whose body stalls is "outcome unknown" (throws -> SUBMISSION_UNKNOWN), never a txid, never retried', async () => {
    reply = stalledBody(200, '{"jsonrpc":"2.0","result":"0x')
    const r = await timed(submit)
    expect(r.error?.message).toMatch(/could not be read.*submission outcome unknown/)
    expect(r.value).toBeUndefined()
    expect(hits).toBe(1)
    expect(r.ms).toBeLessThan(T + SLACK)
  })

  it('bundler: accepted but malformed, or accepted without a userOpHash -> "outcome unknown", never { txId: undefined }', async () => {
    reply = (_q, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{not json') }
    await expect(submit()).rejects.toThrow(/could not be read.*submission outcome unknown/)
    reply = (_q, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"jsonrpc":"2.0","id":1}') }
    await expect(submit()).rejects.toThrow(/without a userOpHash - submission outcome unknown/)
  })

  it('bundler: rejections keep their existing meaning (JSON-RPC error, or non-2xx with an unreadable body), and a real answer returns its userOpHash', async () => {
    reply = (_q, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"jsonrpc":"2.0","id":1,"error":{"message":"AA21 didn\'t pay prefund"}}') }
    await expect(submit()).rejects.toThrow(/bundler rejected the UserOperation.*AA21/)
    reply = (_q, res) => { res.writeHead(502); res.end('<html>bad gateway</html>') }
    await expect(submit()).rejects.toThrow(/bundler rejected the UserOperation/)
    reply = (_q, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(`{"jsonrpc":"2.0","id":1,"result":"0x${expectedUserOpHash}"}`) }
    await expect(submit()).resolves.toEqual({ txId: `0x${expectedUserOpHash}` })
  })

  // ─── Response size: every caller's byte bound, against its widest legitimate response ──────────────────

  // The widest legitimate response of each kind: every field at its maximum (64-hex ids, u32 heights and
  // indexes, 21M BTC in sats, 62-char bech32m addresses). The provider constants' derivations cite these.
  const h64 = 'f'.repeat(64)
  const u32 = 4294967295
  const maxSats = 2100000000000000
  const widest = (() => {
    const status = { confirmed: true, block_height: u32, block_hash: h64, block_time: u32 }
    const pub = '02' + 'f'.repeat(64)
    const sig = '30' + 'f'.repeat(142)
    const witnessScript = '52' + ('21' + pub).repeat(3) + '53ae'
    const out = () => ({ scriptpubkey: '5120' + h64, scriptpubkey_asm: 'OP_PUSHNUM_1 OP_PUSHBYTES_32 ' + h64, scriptpubkey_type: 'v1_p2tr', scriptpubkey_address: 'bc1p' + 'q'.repeat(58), value: maxSats })
    const vin = {
      txid: h64, vout: u32,
      prevout: { scriptpubkey: '0020' + h64, scriptpubkey_asm: 'OP_0 OP_PUSHBYTES_32 ' + h64, scriptpubkey_type: 'v0_p2wsh', scriptpubkey_address: 'bc1q' + 'q'.repeat(58), value: maxSats },
      scriptsig: '', scriptsig_asm: '', witness: ['', sig, sig, witnessScript], is_coinbase: false, sequence: u32,
      inner_witnessscript_asm: 'OP_PUSHNUM_2 ' + Array(3).fill('OP_PUSHBYTES_33 ' + pub).join(' ') + ' OP_PUSHNUM_3 OP_CHECKMULTISIG',
    }
    return {
      status: JSON.stringify(status),
      outspend: JSON.stringify({ spent: true, txid: h64, vin: u32, status }),
      tip: String(u32),
      fees: JSON.stringify({ fastestFee: 999999.999, halfHourFee: 999999.999, hourFee: 999999.999, economyFee: 999999.999, minimumFee: 999999.999 }),
      broadcast: h64,
      // this provider's own spends: one 2-of-3 P2WSH input, at most 3 outputs
      tx: JSON.stringify({ txid: h64, version: 2, locktime: u32, vin: [vin], vout: [out(), out(), out()], size: 99999, weight: 999999, sigops: 99, fee: maxSats, status }),
      utxoEntry: JSON.stringify({ txid: h64, vout: u32, status, value: maxSats }),
      bundler: JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + h64 }),
    }
  })()

  it('each byte bound is derived from, and well above, its widest legitimate response', () => {
    const { EXPLORER_SMALL_RESPONSE_MAX_BYTES: small, EXPLORER_TRANSACTION_MAX_BYTES: tx, EXPLORER_UTXO_LIST_MAX_BYTES: utxos } = mod.multisig
    const size = (s: string) => Buffer.byteLength(s)
    const largestSmall = Math.max(size(widest.status), size(widest.outspend), size(widest.tip), size(widest.fees), size(widest.broadcast))
    expect(largestSmall).toBe(263) // the outspend answer
    expect(small / largestSmall).toBeGreaterThan(50)
    expect(size(widest.tx)).toBe(2747)
    expect(tx / size(widest.tx)).toBeGreaterThan(20)
    expect(size(widest.utxoEntry) + 1).toBe(277) // per entry, with its separating comma
    expect(Math.floor(utxos / 277)).toBe(3785)
    expect(size(widest.bundler)).toBe(102)
    expect(mod.safeGuard.BUNDLER_RESPONSE_MAX_BYTES / size(widest.bundler)).toBeGreaterThan(150)
  })

  it('every explorer read, the broadcast and the bundler accept their widest legitimate response', async () => {
    const json = (body: string): Reply => (_q, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(body) }
    reply = json(widest.status)
    expect(await mod.multisig.fetchTransactionExistence(txid)).toEqual({ exists: true, confirmed: true })
    expect(await mod.multisig.fetchTransactionConfirmationStatus(txid)).toEqual({ confirmed: true, blockHeight: u32 })
    reply = json(widest.outspend)
    expect(await mod.multisig.fetchOutpointSpendStatus(txid, 0)).toEqual({ spent: true, spendingTxid: h64 })
    reply = json(widest.tip)
    expect(await mod.multisig.fetchChainTipHeight()).toBe(u32)
    reply = json(widest.fees)
    expect(await (mod.multisig.multisigProvider as any).fetchFeeRateSatsPerVByte()).toBe(999999.999)
    reply = json(widest.tx)
    expect(await mod.multisig.fetchTransactionOutputs(txid)).toHaveLength(3)
    // as many widest UTXO entries as the bound tolerates
    const entries = Math.floor((mod.multisig.EXPLORER_UTXO_LIST_MAX_BYTES - 2) / (Buffer.byteLength(widest.utxoEntry) + 1))
    reply = json('[' + Array(entries).fill(widest.utxoEntry).join(',') + ']')
    expect(await (mod.multisig.multisigProvider as any).fetchUtxos('tb1qexample')).toHaveLength(entries)
    reply = (_q, res) => { res.writeHead(200); res.end(widest.broadcast) }
    expect(await (mod.multisig.multisigProvider as any).broadcast('00')).toBe(h64)
    reply = json(widest.bundler)
    expect(await (mod.safeGuard.safeGuardEvmProvider as any).broadcast(userOp, '0xsig', h64)).toEqual({ txId: '0x' + h64 })
  })

  /** A body `bytes` long, sent as fast as the socket takes it. */
  const oversized = (status: number, bytes: number): Reply => (_q, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.on('error', () => undefined)
    const chunk = Buffer.alloc(64 * 1024, 'a')
    let left = bytes
    const pump = () => {
      while (left > 0 && !res.destroyed) { left -= chunk.length; if (!res.write(chunk)) { res.once('drain', pump); return } }
      if (!res.destroyed) res.end()
    }
    pump()
  }
  const BIG = 64 * 1024 * 1024

  it('explorer reads: an oversized answer fails closed with BoundedResponseTooLargeError, in one attempt, never a value', async () => {
    reply = oversized(200, BIG)
    for (const call of <Array<() => Promise<unknown>>>[
      () => mod.multisig.fetchTransactionExistence(txid),
      () => mod.multisig.fetchTransactionConfirmationStatus(txid),
      () => mod.multisig.fetchTransactionOutputs(txid),
      () => mod.multisig.fetchOutpointSpendStatus(txid, 0),
      () => mod.multisig.fetchChainTipHeight(),
      () => (mod.multisig.multisigProvider as any).fetchUtxos('tb1qexample'),
    ]) {
      hits = 0
      const r = await timed(call)
      expect(r.error).toBeInstanceOf(mod.BoundedResponseTooLargeError)
      expect(r.value).toBeUndefined()
      expect(hits).toBe(1) // not re-issued
      expect(r.ms).toBeLessThan(T + SLACK)
    }
    hits = 0
    const fee = await timed(() => (mod.multisig.multisigProvider as any).fetchFeeRateSatsPerVByte())
    expect(fee.error).toBeInstanceOf(mod.BoundedResponseTooLargeError) // no fee is guessed
    expect(hits).toBe(1)
  })

  it('existence read: a status-only 404 keeps meaning exists:false whatever body it carries (the body is never read)', async () => {
    reply = oversized(404, BIG)
    expect(await mod.multisig.fetchTransactionExistence(txid)).toEqual({ exists: false, confirmed: false })
  })

  it('MULTISIG broadcast: an oversized answer, accepted or rejected, fails (outcome unknown to the caller), once, never a txid', async () => {
    for (const status of [200, 400]) {
      hits = 0
      reply = oversized(status, BIG)
      const r = await timed(() => (mod.multisig.multisigProvider as any).broadcast('00'))
      expect(r.error).toBeInstanceOf(mod.BoundedResponseTooLargeError)
      expect(r.value).toBeUndefined()
      expect(hits).toBe(1)
    }
  })

  it('bundler: an oversized accepted (200) answer is "outcome unknown" (-> SUBMISSION_UNKNOWN), once, never { txId }', async () => {
    reply = oversized(200, BIG)
    const r = await timed(submit)
    expect(r.error?.message).toMatch(/could not be read.*exceeded 16384 bytes.*submission outcome unknown/)
    expect(r.value).toBeUndefined()
    expect(hits).toBe(1)
  })
})
