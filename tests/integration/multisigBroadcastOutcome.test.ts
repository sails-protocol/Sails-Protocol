// tests/integration/multisigBroadcastOutcome.test.ts
//
// Issue #299 (MULTISIG) - a broadcast that FAILED is told apart from a broadcast whose outcome is UNKNOWN, on both
// paths that claim the escrow before broadcasting: the live final signature (submitTransactionSignature) and PASS 0
// (reconcileUnclaimedFullySignedPending). Real PostgreSQL, real 2-of-3 P2WSH PSBTs; only the explorer is simulated:
//   accept   the network takes the transaction (mempool, the funding outpoint is spent by it)
//   refuse   the node answers 400 and keeps nothing (e.g. a non-standard signature)
//   lost     the network takes it, the answer never arrives (connection reset after acceptance)
//   timeout  no answer, nothing reached the network
//   down     503, nothing reached the network
// Properties: a refusal the chain confirms (txid unknown, outpoint unspent) releases the claim - the escrow is not left
// terminal with no transaction; anything else keeps the claim (UNKNOWN), refuses a dispute, and converges from chain
// truth with ONE distinct transaction. Interleavings use the real escrow advisory lock, observed in pg_locks.
// Crash/restart across OS processes: multisigBroadcastOutcome.worker.ts.
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as bitcoin from 'bitcoinjs-lib'
import nacl from 'tweetnacl'
import { PrismaClient } from '@prisma/client'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'
import { buyerKey, sellerKey, newChain, explorer, signRound, completeOutsideSails, buildCooperative, chainToJson, type Chain } from './pendingRoundLifecycleHarness'

const WORKER = path.join(__dirname, 'multisigBroadcastOutcome.worker.ts')
type Mode = 'accept' | 'refuse' | 'lost' | 'timeout' | 'down'

/** What the network answers to POST /tx, plus every POST attempt (txid) whatever the answer. */
interface Net { mode: Mode; posts: string[]; onLost: (() => Promise<void>) | null; outspendGate: { entered: () => void; release: Promise<void> } | null }

export function network(chain: Chain, net: Net): typeof fetch {
  const base = explorer(chain)
  const reply = (status: number, body: string) => ({ ok: status < 300, status, text: async () => body, json: async () => JSON.parse(body) }) as unknown as Response
  return (async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input)
    if (init?.method === 'POST' && url.endsWith('/tx')) {
      const tx = bitcoin.Transaction.fromHex(init.body as string)
      const txid = tx.getId()
      net.posts.push(txid)
      const accept = () => {
        chain.mempool.add(txid)
        chain.hex.set(txid, init.body as string)
        chain.broadcasts.push(txid)
        chain.spentBy.set(`${Buffer.from(tx.ins[0].hash).reverse().toString('hex')}:${tx.ins[0].index}`, txid)
      }
      if (net.mode === 'accept') {
        if (chain.mempool.has(txid)) return reply(400, 'sendrawtransaction RPC error: {"code":-27,"message":"Transaction already in block chain"}')
        accept()
        return reply(200, txid)
      }
      if (net.mode === 'refuse') return reply(400, 'sendrawtransaction RPC error: {"code":-26,"message":"non-mandatory-script-verify-flag (Non-canonical signature: S value is unnecessarily high)"}')
      if (net.mode === 'lost') {
        accept()
        if (net.onLost) await net.onLost()
        throw new TypeError('fetch failed (socket hang up)')
      }
      if (net.mode === 'timeout') throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
      return reply(503, 'Service Unavailable')
    }
    if (url.includes('/utxo')) {
      const unspent = [...chain.fundings].filter((f) => !chain.spentBy.has(`${f}:0`))
      return reply(200, JSON.stringify((chain.locking ? [chain.locking] : unspent).map((txid) => ({ txid, vout: 0, value: 100_000, status: { confirmed: true } }))))
    }
    if (net.outspendGate && /\/outspend\/\d+$/.test(url)) {
      const gate = net.outspendGate
      const answer = await base(input as string, init as RequestInit) // read now, answered later
      net.outspendGate = null
      gate.entered()
      await gate.release
      return answer
    }
    return base(input as string, init as RequestInit)
  }) as typeof fetch
}

describe('Issue #299 - MULTISIG broadcast outcome: definite failure vs UNKNOWN (real PostgreSQL, real PSBTs)', () => {
  jest.setTimeout(180_000)
  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let deps: Parameters<typeof buildCooperative>[0]
  let getDisputeService: typeof import('../../src/modules/open-settlement/dispute.service').getDisputeService
  let reconcile: typeof import('../../src/modules/open-settlement/escrow-settlement-reconciliation.service')

  const ARBITER_ID = 'i299-test-arbiter'
  const arbiterKeypair = nacl.sign.keyPair()
  let chain: Chain
  let net: Net
  let realFetch: typeof fetch
  let mine: string[] = []
  let held: Array<() => Promise<void>> = []
  let inflight: Array<Promise<unknown>> = []
  const track = <T>(p: Promise<T>): Promise<T> => { inflight.push(p.catch(() => undefined)); return p }

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'false'
    process.env.MULTISIG_SEED = process.env.MULTISIG_SEED || 'i239-test-seed'
    process.env.TRUSTED_ARBITRATORS = ARBITER_ID
    await pg.probe()
    dbAvailable = pg.isAvailable()
    if (!dbAvailable) return
    ;({ prisma } = require('../../src/common/database'))
    deps = {
      prisma,
      escrowService: require('../../src/modules/open-settlement/escrow.service').escrowService,
      identityService: require('../../src/modules/open-identity/identity.service').identityService,
      liquidityRouter: require('../../src/modules/open-liquidity/liquidity.service').liquidityRouter,
      tradeService: require('../../src/modules/open-p2p/trade.service').tradeService,
      payoutAddressService: require('../../src/modules/open-settlement/payout-address.service').payoutAddressService,
    }
    ;({ getDisputeService } = require('../../src/modules/open-settlement/dispute.service'))
    reconcile = require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service')
    const { intentEngine } = require('../../src/core/intent-engine')
    intentEngine.registerHandler(require('../../src/modules/open-p2p/intent-handler').OpenP2PTradeIntentHandler)
    const publicKey = Buffer.from(arbiterKeypair.publicKey).toString('hex')
    await prisma.user.upsert({ where: { id: ARBITER_ID }, update: { publicKey }, create: { id: ARBITER_ID, publicKey, displayName: 'i299 arbiter' } })
  })

  beforeEach(() => {
    chain = newChain()
    net = { mode: 'accept', posts: [], onLost: null, outspendGate: null }
    realFetch = global.fetch
    global.fetch = network(chain, net)
    mine = []
    if (!dbAvailable) return
    // The external-spend watch pages every MULTISIG escrow of the shared database; narrowed to this test's escrows.
    const findMany = prisma.escrow.findMany.bind(prisma.escrow)
    jest.spyOn(prisma.escrow, 'findMany').mockImplementation(((args: any) =>
      findMany(args?.where?.OR?.[0]?.pendingTransaction ? { ...args, where: { ...args.where, AND: [{ id: { in: mine } }] } } : args)) as never)
  })

  afterEach(async () => {
    for (const release of held) await release().catch(() => undefined)
    await Promise.all(inflight)
    held = []
    inflight = []
    global.fetch = realFetch
    jest.restoreAllMocks()
    reconcile?.resetExternalSpendCursor()
  })

  afterAll(async () => {
    if (dbAvailable) {
      await prisma.$disconnect()
      await closeTestRedis()
    }
  })

  // ─── fixtures ───────────────────────────────────────────────────────────────
  async function refundRound(label: string) {
    const c = await buildCooperative(deps, chain, label, 'refund')
    mine.push(c.escrow.id)
    return c
  }
  type Coop = Awaited<ReturnType<typeof refundRound>>
  const keyOf = (c: Coop, id: string) => (id === c.buyer.id ? buyerKey : sellerKey)
  const sign = (c: Coop, id: string) => deps.escrowService.submitTransactionSignature(c.escrow.id, id, signRound(c.round.unsignedPsbtBase64, keyOf(c, id)))
  /** Every required signature persisted, no finalize: PASS 0's "fully signed, never claimed" state. */
  async function persistAllSignatures(c: Coop) {
    for (const id of c.round.requiredSigners) {
      await prisma.escrowTransactionSignature.create({ data: { pendingTxId: c.round.id, participantId: id, signedPsbtBase64: signRound(c.round.unsignedPsbtBase64, keyOf(c, id)) } })
    }
  }
  /** The one transaction this round's signatures can produce. */
  const roundTxid = (c: Coop) => completeOutsideSails(c.round.unsignedPsbtBase64, c.round.requiredSigners.map((id) => signRound(c.round.unsignedPsbtBase64, keyOf(c, id)))).txid
  const escrowOf = (c: Coop) => prisma.escrow.findUniqueOrThrow({ where: { id: c.escrow.id } })
  const roundOf = (c: Coop) => prisma.escrowPendingTransaction.findUnique({ where: { escrowId: c.escrow.id }, include: { signatures: true } })
  const tick = () => reconcile.reconcilePendingSettlements({ externalSpendMinIntervalMs: Number.POSITIVE_INFINITY })
  const raiseDispute = (c: Coop) => getDisputeService().raiseDispute(c.trade.id, c.buyer.id, 'i299')

  /** The state a claim leaves when nothing was proven: claimed terminal, no transaction recorded, round intact. */
  async function expectUnknownKept(c: Coop) {
    expect(await escrowOf(c)).toMatchObject({ status: 'REFUNDED', txReleaseId: null })
    expect((await roundOf(c))?.signatures).toHaveLength(2)
    await expect(raiseDispute(c)).rejects.toThrow(/REFUNDED/)
  }
  /** The state a proven refusal leaves: the claim released, nothing recorded, the round and its signatures intact. */
  async function expectReleased(c: Coop) {
    expect(await escrowOf(c)).toMatchObject({ status: 'FUNDS_LOCKED', txReleaseId: null })
    expect((await roundOf(c))?.signatures).toHaveLength(2)
    expect(chain.broadcasts).toEqual([])
  }
  async function expectConverged(c: Coop) {
    expect(await escrowOf(c)).toMatchObject({ status: 'REFUNDED', txReleaseId: roundTxid(c) })
    expect(new Set(net.posts)).toEqual(new Set([roundTxid(c)]))
    expect(chain.broadcasts).toEqual([roundTxid(c)])
  }

  // ─── lock interleaving helpers ──────────────────────────────────────────────
  const waiters = async () => (await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)[0].n
  async function untilWaiting(n: number) {
    for (let i = 0; i < 1000; i++) {
      if ((await waiters()) === n) return
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error(`expected ${n} advisory-lock waiter(s), saw ${await waiters()}`)
  }
  async function holdEscrowLock(escrowId: string) {
    let release!: () => void
    const released = new Promise<void>((r) => { release = r })
    let acquired!: () => void
    const isHeld = new Promise<void>((r) => { acquired = r })
    const done = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${escrowId})::bigint)`
      acquired()
      await released
    }, { timeout: 60_000 })
    await isHeld
    let once = false
    const releaseOnce = async () => { if (once) return; once = true; release(); await done }
    held.push(releaseOnce)
    return releaseOnce
  }
  function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
    return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms))])
  }

  // ─── PASS 0 (fully signed, never claimed) ───────────────────────────────────
  it('P0-1 the reproduction: PASS 0 claims, the node refuses, nothing reaches the network - the claim is released, the round kept; once accepted, one broadcast converges', async () => {
    if (!dbAvailable) return
    const c = await refundRound('p0-refuse')
    await persistAllSignatures(c)
    net.mode = 'refuse'
    const first = await tick()
    await expectReleased(c)
    expect(net.posts).toEqual([roundTxid(c)])
    expect(first.failed.find((x) => x.escrowId === c.escrow.id)?.error).toMatch(/refused.*Non-canonical signature/)
    expect(first.resumedUnclaimed.some((x) => x.escrowId === c.escrow.id)).toBe(false)

    net.mode = 'accept'
    const second = await tick()
    expect(second.resumedUnclaimed.find((x) => x.escrowId === c.escrow.id)).toMatchObject({ txId: roundTxid(c), outcome: 'NEWLY_BROADCAST' })
    await expectConverged(c)
  })

  it('P0-2 a dispute opened after a proven refusal is allowed, and the cooperative round is then held - never broadcast', async () => {
    if (!dbAvailable) return
    const c = await refundRound('p0-refuse-dispute')
    await persistAllSignatures(c)
    net.mode = 'refuse'
    await tick()
    await expectReleased(c)
    await raiseDispute(c)
    expect((await escrowOf(c)).status).toBe('DISPUTED')

    net.mode = 'accept'
    const after = await tick()
    expect(after.heldIncompatibleRounds.find((x) => x.escrowId === c.escrow.id)).toBeTruthy()
    expect(net.posts).toEqual([roundTxid(c)]) // only the refused attempt
    expect(chain.broadcasts).toEqual([])
    expect(await escrowOf(c)).toMatchObject({ status: 'DISPUTED', txReleaseId: null })
  })

  it('P0-3 the answer is lost after the network accepted: the claim is never released; PASS 1, in the same tick, finds the transaction and converges without sending again', async () => {
    if (!dbAvailable) return
    const c = await refundRound('p0-lost')
    await persistAllSignatures(c)
    net.mode = 'lost'
    const report = await tick()
    expect(report.recovered.find((x) => x.escrowId === c.escrow.id)).toMatchObject({ txId: roundTxid(c), outcome: 'ALREADY_BROADCAST' })
    await expectConverged(c)
    expect(net.posts).toHaveLength(1)
    await expect(raiseDispute(c)).rejects.toThrow(/REFUNDED/)
  })

  it.each([['timeout'], ['down']] as Array<[Mode]>)('P0-4 %s, nothing reached the network: UNKNOWN is kept (PASS 1 retries the same transaction in the same tick); the next tick sends it once more and converges', async (mode) => {
    if (!dbAvailable) return
    const c = await refundRound(`p0-${mode}`)
    await persistAllSignatures(c)
    net.mode = mode
    await tick()
    await expectUnknownKept(c)
    expect(net.posts).toEqual([roundTxid(c), roundTxid(c)]) // PASS 0's attempt, then PASS 1's - the same transaction
    net.mode = 'accept'
    const next = await tick()
    expect(next.recovered.find((x) => x.escrowId === c.escrow.id)).toMatchObject({ txId: roundTxid(c), outcome: 'NEWLY_BROADCAST' })
    await expectConverged(c)
    expect(net.posts).toEqual([roundTxid(c), roundTxid(c), roundTxid(c)])
  })

  // ─── live final signature ───────────────────────────────────────────────────
  it('L-1 live, the answer is lost after the network accepted: the claim is KEPT (UNKNOWN), a dispute is refused, PASS 1 converges without sending again', async () => {
    if (!dbAvailable) return
    const c = await refundRound('live-lost')
    await sign(c, c.seller.id)
    net.mode = 'lost'
    await expect(sign(c, c.buyer.id)).rejects.toThrow()
    await expectUnknownKept(c)
    net.mode = 'accept'
    const next = await tick()
    expect(next.recovered.find((x) => x.escrowId === c.escrow.id)).toMatchObject({ txId: roundTxid(c), outcome: 'ALREADY_BROADCAST' })
    await expectConverged(c)
    expect(net.posts).toHaveLength(1)
  })

  it.each([['timeout'], ['down']] as Array<[Mode]>)('L-2 live %s: the claim is kept (UNKNOWN); PASS 1 sends the same transaction once and converges', async (mode) => {
    if (!dbAvailable) return
    const c = await refundRound(`live-${mode}`)
    await sign(c, c.seller.id)
    net.mode = mode
    await expect(sign(c, c.buyer.id)).rejects.toThrow()
    await expectUnknownKept(c)
    net.mode = 'accept'
    await tick()
    await expectConverged(c)
    expect(net.posts).toEqual([roundTxid(c), roundTxid(c)])
  })

  it('L-3 live, the node refuses and the chain confirms nothing happened: the claim is released; a dispute is allowed', async () => {
    if (!dbAvailable) return
    const c = await refundRound('live-refuse')
    await sign(c, c.seller.id)
    net.mode = 'refuse'
    await expect(sign(c, c.buyer.id)).rejects.toThrow(/refused.*Non-canonical signature/)
    await expectReleased(c)
    expect(net.posts).toEqual([roundTxid(c)])
    await raiseDispute(c)
    expect((await escrowOf(c)).status).toBe('DISPUTED')
  })

  it('L-3b live, the node refuses but the chain cannot be read: no proof of failure, the claim is kept (UNKNOWN)', async () => {
    if (!dbAvailable) return
    const c = await refundRound('live-refuse-blind')
    await sign(c, c.seller.id)
    net.mode = 'refuse'
    chain.outspendUnreadable = true
    await expect(sign(c, c.buyer.id)).rejects.toThrow(/refused.*could not be read/)
    await expectUnknownKept(c)
  })

  it('L-3c live, the node refuses and the funding outpoint is spent by ANOTHER transaction: the claim is kept; PASS 1 sends nothing and routes it to manual review', async () => {
    if (!dbAvailable) return
    const c = await refundRound('live-refuse-foreign')
    await sign(c, c.seller.id)
    net.mode = 'refuse'
    chain.spentBy.set(`${c.funding}:0`, 'f'.repeat(64))
    await expect(sign(c, c.buyer.id)).rejects.toThrow(/refused.*not proven unspent/)
    await expectUnknownKept(c)
    net.mode = 'accept'
    const next = await tick()
    expect(next.requiresManualReview.find((x) => x.escrowId === c.escrow.id)?.reason).toMatch(/no longer unspent/)
    expect(net.posts).toEqual([roundTxid(c)])
    expect(await escrowOf(c)).toMatchObject({ status: 'REFUNDED', txReleaseId: null })
  })

  it('L-5 live, the round cannot be built after the claim (a stored signature is unusable): nothing was sent, a definite failure - the claim is released', async () => {
    if (!dbAvailable) return
    const c = await refundRound('live-unbuildable')
    await sign(c, c.seller.id)
    // Out-of-band corruption of the stored copy: the seller's row no longer carries its partial signature.
    await prisma.escrowTransactionSignature.updateMany({ where: { pendingTxId: c.round.id, participantId: c.seller.id }, data: { signedPsbtBase64: c.round.unsignedPsbtBase64 } })
    await expect(sign(c, c.buyer.id)).rejects.toThrow(/failed to combine\/finalize/)
    expect(await escrowOf(c)).toMatchObject({ status: 'FUNDS_LOCKED', txReleaseId: null })
    expect(net.posts).toEqual([])
  })

  it('L-4 live, the node answers 400 because it ALREADY has the transaction (a signer broadcast it): converged in place, never released', async () => {
    if (!dbAvailable) return
    const c = await refundRound('live-known')
    await sign(c, c.seller.id)
    const spend = completeOutsideSails(c.round.unsignedPsbtBase64, c.round.requiredSigners.map((id) => signRound(c.round.unsignedPsbtBase64, keyOf(c, id))))
    chain.mempool.add(spend.txid)
    chain.hex.set(spend.txid, spend.hex)
    chain.spentBy.set(`${c.funding}:0`, spend.txid)
    const result = await sign(c, c.buyer.id)
    expect(result.complete).toBe(true)
    expect(await escrowOf(c)).toMatchObject({ status: 'REFUNDED', txReleaseId: spend.txid })
    expect(net.posts).toEqual([spend.txid])
  })

  // ─── concurrency: rollback x PASS 1 (the #520 interleaving, through the production paths) ─────────────────
  it('C-1 live answer lost while PASS 1 has already read the chain and waits on the escrow lock: no rollback, PASS 1 records the result - never a non-terminal escrow with a transaction', async () => {
    if (!dbAvailable) return
    const c = await refundRound('race-lost')
    await sign(c, c.seller.id)
    let releaseLost!: () => void
    const lostReleased = new Promise<void>((r) => { releaseLost = r })
    let lostEntered!: () => void
    const entered = new Promise<void>((r) => { lostEntered = r })
    net.mode = 'lost'
    net.onLost = async () => { lostEntered(); await lostReleased }
    const live = track(sign(c, c.buyer.id))
    await within(entered, 30_000, 'the live broadcast')
    net.mode = 'accept'
    net.onLost = null
    const unlock = await holdEscrowLock(c.escrow.id)
    const pass = track(tick())
    await untilWaiting(1) // PASS 1 read ALREADY_BROADCAST and waits to record it
    releaseLost()
    await expect(live).rejects.toThrow()
    await unlock()
    const report = await pass
    expect(report.recovered.find((x) => x.escrowId === c.escrow.id)).toMatchObject({ txId: roundTxid(c), outcome: 'ALREADY_BROADCAST' })
    await expectConverged(c)
  })

  it('C-2 a proven refusal rolls back while PASS 1 broadcasts the same round: the rollback holds the lock first, PASS 1 sees the released claim and records nothing; PASS 0 then converges to the chain', async () => {
    if (!dbAvailable) return
    const c = await refundRound('race-refuse')
    await sign(c, c.seller.id)
    let releaseGate!: () => void
    const gateReleased = new Promise<void>((r) => { releaseGate = r })
    let gateEntered!: () => void
    const entered = new Promise<void>((r) => { gateEntered = r })
    net.mode = 'refuse'
    net.outspendGate = { entered: gateEntered, release: gateReleased }
    const live = track(sign(c, c.buyer.id))
    await within(entered, 30_000, 'the live refusal check') // refused, txid unknown, outpoint read unspent - answer held
    const unlock = await holdEscrowLock(c.escrow.id)
    releaseGate()
    await untilWaiting(1) // the rollback waits on the escrow lock
    net.mode = 'accept'
    const pass = track(tick()) // PASS 1: claimed, no txReleaseId, outpoint unspent -> broadcasts, then waits
    await untilWaiting(2)
    await unlock()
    await expect(live).rejects.toThrow(/refused/)
    const report = await pass
    expect(report.recovered.some((x) => x.escrowId === c.escrow.id)).toBe(false)
    expect(await escrowOf(c)).toMatchObject({ status: 'FUNDS_LOCKED', txReleaseId: null })
    expect(chain.broadcasts).toEqual([roundTxid(c)])

    const next = await tick()
    expect(next.resumedUnclaimed.find((x) => x.escrowId === c.escrow.id)).toMatchObject({ txId: roundTxid(c), outcome: 'ALREADY_BROADCAST' })
    await expectConverged(c)
  })

  // ─── crash / restart across OS processes ────────────────────────────────────
  interface Result { ok: boolean; value?: any; error?: string; code: number | null }
  function worker(env: Record<string, string>): Promise<Result> {
    const child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', WORKER], {
      env: { ...process.env, ...env, CHAIN: chainToJson(chain) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    return new Promise((resolve) => child.on('exit', (code) => {
      const last = out.trim().split('\n').reverse().find((l) => l.startsWith('{"ok"'))
      resolve(last ? { ...JSON.parse(last), code } : { ok: false, error: `no result (exit ${code}): ${err.slice(-400)}`, code })
    }))
  }

  it.each([['before'], ['after']] as Array<['before' | 'after']>)('R-1 the signing process dies %s the network takes the transaction; a fresh process converges with one distinct transaction', async (when) => {
    if (!dbAvailable) return
    const c = await refundRound(`crash-${when}`)
    await sign(c, c.seller.id)
    const accepted = path.join(os.tmpdir(), `i299-${c.escrow.id}.json`)
    const crashed = await worker({ OP: 'sign', CRASH: when, ACCEPTED_FILE: accepted, ESCROW_ID: c.escrow.id, ACTOR: c.buyer.id, SIGNED_PSBT: signRound(c.round.unsignedPsbtBase64, buyerKey) })
    expect(crashed.code).toBe(137)
    expect(await escrowOf(c)).toMatchObject({ status: 'REFUNDED', txReleaseId: null }) // claimed before the broadcast
    if (when === 'after') {
      const { txid, hex } = JSON.parse(fs.readFileSync(accepted, 'utf8'))
      chain.mempool.add(txid)
      chain.hex.set(txid, hex)
      chain.broadcasts.push(txid)
      chain.spentBy.set(`${c.funding}:0`, txid)
      fs.unlinkSync(accepted)
    }
    const restarted = await worker({ OP: 'reconcile', ESCROW_ID: c.escrow.id })
    expect(restarted).toMatchObject({ ok: true, code: 0 })
    expect(restarted.value.recovered).toEqual([{ txId: roundTxid(c), outcome: when === 'after' ? 'ALREADY_BROADCAST' : 'NEWLY_BROADCAST' }])
    expect(await escrowOf(c)).toMatchObject({ status: 'REFUNDED', txReleaseId: roundTxid(c) })
  })
})
