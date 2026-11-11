// tests/integration/multisigBroadcastOutcome.test.ts
//
// Issue #299 (MULTISIG) - UNKNOWN is not FAILED on both paths that claim the escrow before broadcasting: the live final
// signature (submitTransactionSignature) and PASS 0 (reconcileUnclaimedFullySignedPending). Real PostgreSQL, real
// 2-of-3 P2WSH PSBTs; only the explorer (and, for "stale", a second node) is simulated:
//   accept    the network takes the transaction (mempool, the funding outpoint is spent by it)
//   refuse    400 + RPC rejection, nothing anywhere (e.g. a non-standard signature)
//   stale     400 + RPC rejection from a lagging node, while ANOTHER node already has the transaction (invisible here)
//   lost      the network takes it, the answer never arrives (connection reset after acceptance)
//   timeout   no answer; down 503; throttled 429; moved 302; gateway 400 without an RPC body
// Properties (CTO D1-D4): once a transaction is POSTed nothing proves it never propagated, so every error keeps the
// claim (no dispute, no new disposition) and recovery re-sends the SAME transaction; a rejection PASS 1 cannot converge
// goes to structured manual review (code, txid, round); only a round that cannot be built (nothing sent) releases the
// claim, and a failed release is reported, never swallowed. Crash/restart across OS processes:
// multisigBroadcastOutcome.worker.ts.
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
type Mode = 'accept' | 'refuse' | 'flood' | 'stale' | 'lost' | 'timeout' | 'down' | 'throttled' | 'moved' | 'gateway'
const RPC_REJECTION = 'sendrawtransaction RPC error: {"code":-26,"message":"non-mandatory-script-verify-flag (Non-canonical signature: S value is unnecessarily high)"}'

/** What the network answers to POST /tx, every POST attempt (txid), what a second node holds out of sight, and
 *  whether GET /tx/:txid/status is unreadable. */
interface Net { mode: Mode; posts: string[]; onLost: (() => Promise<void>) | null; elsewhere: Map<string, string>; statusDown: boolean }

export function network(chain: Chain, net: Net): typeof fetch {
  const base = explorer(chain)
  const reply = (status: number, body: string) => ({ ok: status < 300, status, text: async () => body, json: async () => JSON.parse(body) }) as unknown as Response
  return (async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input)
    if (init?.method === 'POST' && url.endsWith('/tx')) {
      const hex = init.body as string
      const txid = bitcoin.Transaction.fromHex(hex).getId()
      net.posts.push(txid)
      if (net.mode === 'accept') {
        if (chain.mempool.has(txid)) return reply(400, 'sendrawtransaction RPC error: {"code":-27,"message":"Transaction already in block chain"}')
        accept(chain, hex)
        return reply(200, txid)
      }
      if (net.mode === 'refuse') return reply(400, RPC_REJECTION)
      if (net.mode === 'flood') return reply(400, `${RPC_REJECTION} ${'A'.repeat(2_000_000)}`)
      if (net.mode === 'stale') {
        net.elsewhere.set(txid, hex)
        return reply(400, 'sendrawtransaction RPC error: {"code":-25,"message":"bad-txns-inputs-missingorspent"}')
      }
      if (net.mode === 'lost') {
        accept(chain, hex)
        if (net.onLost) await net.onLost()
        throw new TypeError('fetch failed (socket hang up)')
      }
      if (net.mode === 'timeout') throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
      if (net.mode === 'throttled') return reply(429, 'Too Many Requests')
      if (net.mode === 'moved') return reply(302, '')
      if (net.mode === 'gateway') return reply(400, '<html><body>400 Bad Request</body></html>')
      return reply(503, 'Service Unavailable')
    }
    if (url.includes('/utxo')) {
      const unspent = [...chain.fundings].filter((f) => !chain.spentBy.has(`${f}:0`))
      return reply(200, JSON.stringify((chain.locking ? [chain.locking] : unspent).map((txid) => ({ txid, vout: 0, value: 100_000, status: { confirmed: true } }))))
    }
    if (net.statusDown && /\/tx\/[0-9a-f]{64}\/status$/.test(url)) return reply(503, 'Service Unavailable')
    return base(input as string, init as RequestInit)
  }) as typeof fetch
}

/** The network now holds this transaction: mempool, and the funding outpoint it spends. */
function accept(chain: Chain, hex: string) {
  const tx = bitcoin.Transaction.fromHex(hex)
  const txid = tx.getId()
  chain.mempool.add(txid)
  chain.hex.set(txid, hex)
  chain.broadcasts.push(txid)
  chain.spentBy.set(`${Buffer.from(tx.ins[0].hash).reverse().toString('hex')}:${tx.ins[0].index}`, txid)
}

describe('Issue #299 - MULTISIG broadcast outcome: UNKNOWN is never FAILED (real PostgreSQL, real PSBTs)', () => {
  jest.setTimeout(180_000)
  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let deps: Parameters<typeof buildCooperative>[0]
  let getDisputeService: typeof import('../../src/modules/open-settlement/dispute.service').getDisputeService
  let reconcile: typeof import('../../src/modules/open-settlement/escrow-settlement-reconciliation.service')
  let revertUnsettledClaim: typeof import('../../src/modules/open-settlement/escrow-lifecycle').revertUnsettledClaim

  const ARBITER_ID = 'i299-test-arbiter'
  const arbiterKeypair = nacl.sign.keyPair()
  let chain: Chain
  let net: Net
  let realFetch: typeof fetch
  let mine: string[] = []
  let inflight: Array<Promise<unknown>> = []
  let held: Array<() => Promise<void>> = []
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
    ;({ revertUnsettledClaim } = require('../../src/modules/open-settlement/escrow-lifecycle'))
    reconcile = require('../../src/modules/open-settlement/escrow-settlement-reconciliation.service')
    const { intentEngine } = require('../../src/core/intent-engine')
    intentEngine.registerHandler(require('../../src/modules/open-p2p/intent-handler').OpenP2PTradeIntentHandler)
    const publicKey = Buffer.from(arbiterKeypair.publicKey).toString('hex')
    await prisma.user.upsert({ where: { id: ARBITER_ID }, update: { publicKey }, create: { id: ARBITER_ID, publicKey, displayName: 'i299 arbiter' } })
  })

  beforeEach(() => {
    chain = newChain()
    net = { mode: 'accept', posts: [], onLost: null, elsewhere: new Map(), statusDown: false }
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
  const review = (r: Awaited<ReturnType<typeof tick>>, c: Coop) => r.requiresManualReview.find((x) => x.escrowId === c.escrow.id)?.reason
  const refundEvents = (c: Coop) => prisma.escrowEvent.count({ where: { escrowId: c.escrow.id, toStatus: 'REFUNDED' } })
  /** Fail loud (GK S3): without the database every test fails, none passes without its assertions. */
  const requireDb = () => pg.requirePostgres(expect.getState().currentTestName ?? 'multisigBroadcastOutcome')

  /** UNKNOWN kept: claimed terminal, no transaction recorded, round intact, a dispute refused. */
  async function expectUnknownKept(c: Coop) {
    expect(await escrowOf(c)).toMatchObject({ status: 'REFUNDED', txReleaseId: null })
    expect((await roundOf(c))?.signatures).toHaveLength(2)
    await expect(raiseDispute(c)).rejects.toThrow(/REFUNDED/)
  }
  async function expectConverged(c: Coop) {
    expect(await escrowOf(c)).toMatchObject({ status: 'REFUNDED', txReleaseId: roundTxid(c) })
    expect(new Set(net.posts)).toEqual(new Set([roundTxid(c)]))
    expect(chain.broadcasts).toEqual([roundTxid(c)])
  }
  /** The structured manual-review entry: code, state, round and txid. */
  function expectRejectedReview(reason: string | undefined, c: Coop) {
    expect(reason).toMatch(new RegExp(`^BROADCAST_REJECTED: escrow is REFUNDED with no txReleaseId, round ${c.round.id}\\. .*broadcast of ${roundTxid(c)} rejected with 400`))
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
  it('P0-1 the reproduction: PASS 0 claims and the node rejects - the claim stays (UNKNOWN), a dispute is refused, PASS 1 routes it to structured manual review; once accepted, the same transaction converges', async () => {
    requireDb()
    const c = await refundRound('p0-refuse')
    await persistAllSignatures(c)
    net.mode = 'refuse'
    const first = await tick()
    await expectUnknownKept(c)
    expectRejectedReview(review(first, c), c)
    expect(first.failed.some((x) => x.escrowId === c.escrow.id)).toBe(true) // PASS 0's own attempt
    expect(net.posts).toEqual([roundTxid(c), roundTxid(c)]) // PASS 0, then PASS 1 - the same transaction

    net.mode = 'accept'
    const second = await tick()
    expect(second.recovered.find((x) => x.escrowId === c.escrow.id)).toMatchObject({ txId: roundTxid(c), outcome: 'NEWLY_BROADCAST' })
    expect(review(second, c)).toBeUndefined()
    await expectConverged(c)
  })

  it('P0-2 the answer is lost after the network accepted: the claim is never released; PASS 1, in the same tick, finds the transaction and converges without sending again', async () => {
    requireDb()
    const c = await refundRound('p0-lost')
    await persistAllSignatures(c)
    net.mode = 'lost'
    const report = await tick()
    expect(report.recovered.find((x) => x.escrowId === c.escrow.id)).toMatchObject({ txId: roundTxid(c), outcome: 'ALREADY_BROADCAST' })
    await expectConverged(c)
    expect(net.posts).toHaveLength(1)
    await expect(raiseDispute(c)).rejects.toThrow(/REFUNDED/)
  })

  it.each([['timeout'], ['down'], ['throttled'], ['moved'], ['gateway']] as Array<[Mode]>)('P0-3 %s: UNKNOWN is kept and stays an ordinary failure (not manual review); the next tick re-sends the same transaction and converges', async (mode) => {
    requireDb()
    const c = await refundRound(`p0-${mode}`)
    await persistAllSignatures(c)
    net.mode = mode
    const first = await tick()
    await expectUnknownKept(c)
    expect(review(first, c)).toBeUndefined()
    expect(first.failed.filter((x) => x.escrowId === c.escrow.id).map((x) => x.error)).toEqual([
      expect.stringMatching(/broadcast outcome unknown/), expect.stringMatching(/broadcast outcome unknown/),
    ])
    net.mode = 'accept'
    const next = await tick()
    expect(next.recovered.find((x) => x.escrowId === c.escrow.id)).toMatchObject({ txId: roundTxid(c), outcome: 'NEWLY_BROADCAST' })
    await expectConverged(c)
    expect(net.posts).toEqual([roundTxid(c), roundTxid(c), roundTxid(c)])
  })

  it('P0-4 a lagging node rejects while ANOTHER node already has the transaction: no rollback, no dispute; when the explorer catches up PASS 1 converges with no new transaction', async () => {
    requireDb()
    const c = await refundRound('p0-stale')
    await persistAllSignatures(c)
    net.mode = 'stale'
    const first = await tick()
    await expectUnknownKept(c)
    expectRejectedReview(review(first, c), c)
    expect(chain.broadcasts).toEqual([])
    accept(chain, net.elsewhere.get(roundTxid(c))!) // propagation reaches the explorer
    const next = await tick()
    expect(next.recovered.find((x) => x.escrowId === c.escrow.id)).toMatchObject({ txId: roundTxid(c), outcome: 'ALREADY_BROADCAST' })
    await expectConverged(c)
    expect(net.posts).toEqual([roundTxid(c), roundTxid(c)]) // nothing sent after the catch-up
  })

  // ─── live final signature ───────────────────────────────────────────────────
  it('L-1 live, the answer is lost after the network accepted: the claim is KEPT (UNKNOWN), a dispute is refused, PASS 1 converges without sending again', async () => {
    requireDb()
    const c = await refundRound('live-lost')
    await sign(c, c.seller.id)
    net.mode = 'lost'
    await expect(sign(c, c.buyer.id)).rejects.toThrow(/broadcast outcome unknown, no answer/)
    await expectUnknownKept(c)
    net.mode = 'accept'
    const next = await tick()
    expect(next.recovered.find((x) => x.escrowId === c.escrow.id)).toMatchObject({ txId: roundTxid(c), outcome: 'ALREADY_BROADCAST' })
    await expectConverged(c)
    expect(net.posts).toHaveLength(1)
  })

  it.each([['timeout'], ['down'], ['throttled'], ['moved'], ['gateway']] as Array<[Mode]>)('L-2 live %s: the claim is kept (UNKNOWN); PASS 1 sends the same transaction once and converges', async (mode) => {
    requireDb()
    const c = await refundRound(`live-${mode}`)
    await sign(c, c.seller.id)
    net.mode = mode
    await expect(sign(c, c.buyer.id)).rejects.toThrow(/broadcast outcome unknown/)
    await expectUnknownKept(c)
    net.mode = 'accept'
    await tick()
    await expectConverged(c)
    expect(net.posts).toEqual([roundTxid(c), roundTxid(c)])
  })

  it('L-3 live, the node rejects (400 + RPC error, nothing on this explorer): the claim is KEPT, a dispute is refused; PASS 1 routes it to manual review until the network accepts the same transaction', async () => {
    requireDb()
    const c = await refundRound('live-refuse')
    await sign(c, c.seller.id)
    net.mode = 'refuse'
    await expect(sign(c, c.buyer.id)).rejects.toThrow(/rejected with 400.*Non-canonical signature.*outcome unknown/)
    await expectUnknownKept(c)
    const first = await tick()
    expectRejectedReview(review(first, c), c)
    expect(first.failed.some((x) => x.escrowId === c.escrow.id)).toBe(false) // manual review, not a silent retry loop
    net.mode = 'accept'
    await tick()
    await expectConverged(c)
  })

  it('L-4 live, a lagging node rejects while another node already has the transaction: no rollback, no dispute; converged once the explorer sees it', async () => {
    requireDb()
    const c = await refundRound('live-stale')
    await sign(c, c.seller.id)
    net.mode = 'stale'
    await expect(sign(c, c.buyer.id)).rejects.toThrow(/rejected with 400.*outcome unknown/)
    await expectUnknownKept(c)
    accept(chain, net.elsewhere.get(roundTxid(c))!)
    const next = await tick()
    expect(next.recovered.find((x) => x.escrowId === c.escrow.id)).toMatchObject({ txId: roundTxid(c), outcome: 'ALREADY_BROADCAST' })
    await expectConverged(c)
    expect(net.posts).toEqual([roundTxid(c)])
  })

  it('L-5 live, the node answers 400 because it ALREADY has the transaction (a signer broadcast it): converged in place', async () => {
    requireDb()
    const c = await refundRound('live-known')
    await sign(c, c.seller.id)
    const spend = completeOutsideSails(c.round.unsignedPsbtBase64, c.round.requiredSigners.map((id) => signRound(c.round.unsignedPsbtBase64, keyOf(c, id))))
    accept(chain, spend.hex)
    const result = await sign(c, c.buyer.id)
    expect(result.complete).toBe(true)
    expect(await escrowOf(c)).toMatchObject({ status: 'REFUNDED', txReleaseId: spend.txid })
    expect(net.posts).toEqual([spend.txid])
  })

  it('L-6 live, the round cannot be built after the claim (a stored signature is unusable): nothing was sent - the claim is released, a dispute is allowed', async () => {
    requireDb()
    const c = await refundRound('live-unbuildable')
    await sign(c, c.seller.id)
    // Out-of-band corruption of the stored copy: the seller's row no longer carries its partial signature.
    await prisma.escrowTransactionSignature.updateMany({ where: { pendingTxId: c.round.id, participantId: c.seller.id }, data: { signedPsbtBase64: c.round.unsignedPsbtBase64 } })
    await expect(sign(c, c.buyer.id)).rejects.toThrow(/failed to combine\/finalize/)
    expect(await escrowOf(c)).toMatchObject({ status: 'FUNDS_LOCKED', txReleaseId: null })
    expect(net.posts).toEqual([])
    await raiseDispute(c)
    expect((await escrowOf(c)).status).toBe('DISPUTED')
  })

  it('L-7 live, the round cannot be built AND the database refuses the rollback: the failure is reported (not swallowed), the claim stays, PASS 1 routes it to manual review', async () => {
    requireDb()
    const c = await refundRound('live-rollback-down')
    await sign(c, c.seller.id)
    await prisma.escrowTransactionSignature.updateMany({ where: { pendingTxId: c.round.id, participantId: c.seller.id }, data: { signedPsbtBase64: c.round.unsignedPsbtBase64 } })
    jest.spyOn(require('../../src/modules/open-settlement/escrow-lifecycle'), 'revertUnsettledClaim').mockRejectedValue(new Error('connection to the database lost'))
    await expect(sign(c, c.buyer.id)).rejects.toThrow(/failed to combine\/finalize.*the claim could not be released \(connection to the database lost\) - escrow .* stays REFUNDED pending manual review/)
    jest.restoreAllMocks()
    await expectUnknownKept(c)
    const findMany = prisma.escrow.findMany.bind(prisma.escrow)
    jest.spyOn(prisma.escrow, 'findMany').mockImplementation(((args: any) =>
      findMany(args?.where?.OR?.[0]?.pendingTransaction ? { ...args, where: { ...args.where, AND: [{ id: { in: mine } }] } } : args)) as never)
    const report = await tick()
    expect(review(report, c)).toMatch(new RegExp(`^ROUND_UNBUILDABLE: escrow is REFUNDED with no txReleaseId, round ${c.round.id}\\. .*failed to combine/finalize`))
    expect(net.posts).toEqual([])
  })

  it('L-8 the release is conditional: with a settlement result recorded, it reverts nothing and raises nothing (the status-frozen trigger is never reached)', async () => {
    requireDb()
    const c = await refundRound('release-after-result')
    await sign(c, c.seller.id)
    await sign(c, c.buyer.id) // accepted: REFUNDED with txReleaseId
    expect(await escrowOf(c)).toMatchObject({ status: 'REFUNDED', txReleaseId: roundTxid(c) })
    await expect(revertUnsettledClaim(c.escrow.id, 'REFUNDED', 'FUNDS_LOCKED')).resolves.toBe(0)
    expect(await escrowOf(c)).toMatchObject({ status: 'REFUNDED', txReleaseId: roundTxid(c) })
  })

  it('L-9 live, the node rejects AND the status read-back fails: still UNKNOWN - the claim is kept, nothing reverted, a dispute is refused; PASS 1 keeps it an ordinary failure until the explorer answers, then converges with the same transaction', async () => {
    requireDb()
    const c = await refundRound('live-refuse-unreadable')
    await sign(c, c.seller.id)
    net.mode = 'refuse'
    net.statusDown = true
    await expect(sign(c, c.buyer.id)).rejects.toThrow(/rejected with 400.*could not be read back - outcome unknown/)
    await expectUnknownKept(c)
    const first = await tick()
    await expectUnknownKept(c)
    expect(review(first, c)).toBeUndefined()
    expect(first.failed.some((x) => x.escrowId === c.escrow.id)).toBe(true)
    // GK S2: an ordinary persistent failure is named per escrow in the reconciler's own findings warning.
    const log = { warn: jest.fn(), error: jest.fn() }
    await require('../../src/app').runSettlementReconcilerTick(log)
    const findings = log.warn.mock.calls.map((x: any[]) => x[0]).find((e: any) => e.msg === 'Settlement reconciliation completed with findings')
    expect(findings.failedEscrowIds).toContain(c.escrow.id)
    await expectUnknownKept(c)
    net.statusDown = false
    net.mode = 'accept'
    await tick()
    await expectConverged(c)
  })

  it('L-10 a 2 MB rejection body is bounded in the error and the manual-review reason; status, txid and reason code survive', async () => {
    requireDb()
    const c = await refundRound('live-flood')
    await sign(c, c.seller.id)
    net.mode = 'flood'
    const err = await sign(c, c.buyer.id).then(() => null, (e: Error) => e)
    expect(err?.message).toMatch(new RegExp(`broadcast of ${roundTxid(c)} rejected with 400: sendrawtransaction RPC error.*\\.\\.\\. \\[\\d+ more chars\\]`))
    expect(err!.message.length).toBeLessThan(1_000)
    await expectUnknownKept(c)
    const report = await tick()
    expectRejectedReview(review(report, c), c)
    expect(review(report, c)!.length).toBeLessThan(1_500)
    net.mode = 'accept' // converged, so no other suite sharing this database inherits a claimed escrow
    await tick()
    await expectConverged(c)
  })

  // ─── concurrency: live UNKNOWN x PASS 1 (the #520 interleaving) ─────────────
  it('C-1 live answer lost while PASS 1 has already read the chain and waits on the escrow lock: no rollback, PASS 1 records the result - never a non-terminal escrow with a transaction', async () => {
    requireDb()
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

  // GK S1: the live round could not be built, and before its rollback a signer re-submits a usable signature, so PASS 1
  // rebuilds the round, sends it and waits on the lock. Injection point: the live caller pauses right before the rollback.
  it.each([['rollback'], ['PASS 1']] as Array<['rollback' | 'PASS 1']>)('C-2 rollback x PASS 1 that already sent the rebuilt round, %s takes the escrow lock first: never a non-terminal escrow with a transaction or a completion event; converged once, a dispute refused', async (first) => {
    requireDb()
    const c = await refundRound(`race-rollback-${first === 'rollback' ? 'first' : 'second'}`)
    await sign(c, c.seller.id)
    const corrupt = c.round.unsignedPsbtBase64
    await prisma.escrowTransactionSignature.updateMany({ where: { pendingTxId: c.round.id, participantId: c.seller.id }, data: { signedPsbtBase64: corrupt } })
    const lifecycle = require('../../src/modules/open-settlement/escrow-lifecycle')
    let reached!: () => void
    const atRollback = new Promise<void>((r) => { reached = r })
    let proceed!: () => void
    const go = new Promise<void>((r) => { proceed = r })
    jest.spyOn(lifecycle, 'revertUnsettledClaim').mockImplementation((async (...args: [string, string, string]) => {
      reached()
      await go
      return revertUnsettledClaim(...args)
    }) as never)
    let liveSettled = false
    const live = track(sign(c, c.buyer.id).finally(() => { liveSettled = true }))
    await within(atRollback, 30_000, 'the live rollback')
    expect(await escrowOf(c)).toMatchObject({ status: 'REFUNDED', txReleaseId: null })
    await prisma.escrowTransactionSignature.updateMany({ where: { pendingTxId: c.round.id, participantId: c.seller.id }, data: { signedPsbtBase64: signRound(c.round.unsignedPsbtBase64, sellerKey) } })

    // A rollback that does not take the lock finishes at once instead of waiting: the run then reaches the end state.
    const rollbackWaitsOrEnds = async (n: number) => {
      for (let i = 0; i < 1000 && !liveSettled && (await waiters()) !== n; i++) await new Promise((r) => setTimeout(r, 10))
    }
    const unlock = await holdEscrowLock(c.escrow.id)
    let pass: Promise<Awaited<ReturnType<typeof tick>>>
    if (first === 'rollback') {
      proceed()
      await rollbackWaitsOrEnds(1)
      const before = await waiters()
      pass = track(tick())
      await untilWaiting(before + 1)
    } else {
      pass = track(tick())
      await untilWaiting(1)
      proceed()
      await rollbackWaitsOrEnds(2)
    }
    expect(chain.broadcasts).toEqual([roundTxid(c)]) // PASS 1 sent the rebuilt round before waiting
    await unlock()
    await expect(live).rejects.toThrow(/failed to combine\/finalize/)
    const report = await pass

    if (first === 'rollback') {
      // The rollback won: PASS 1 records nothing, emits nothing; the round is still fully signed.
      expect(await escrowOf(c)).toMatchObject({ status: 'FUNDS_LOCKED', txReleaseId: null })
      expect(report.recovered.find((x) => x.escrowId === c.escrow.id)).toBeUndefined()
      expect(report.failed.find((x) => x.escrowId === c.escrow.id)?.error).toMatch(/is FUNDS_LOCKED, no longer REFUNDED; result \w+ not recorded, PASS 0 converges/)
      expect(await refundEvents(c)).toBe(0)
      const next = await tick() // PASS 0 re-claims from the chain: already broadcast, nothing sent again
      expect(next.failed.find((x) => x.escrowId === c.escrow.id)).toBeUndefined()
    } else {
      // PASS 1 won: result recorded; the rollback then finds a settled escrow and reverts nothing.
      expect(report.recovered.find((x) => x.escrowId === c.escrow.id)).toMatchObject({ txId: roundTxid(c), outcome: 'NEWLY_BROADCAST' })
    }
    await expectConverged(c)
    expect(await refundEvents(c)).toBe(1)
    await expect(raiseDispute(c)).rejects.toThrow(/REFUNDED/)
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
    requireDb()
    const c = await refundRound(`crash-${when}`)
    await sign(c, c.seller.id)
    const accepted = path.join(os.tmpdir(), `i299-${c.escrow.id}.json`)
    const crashed = await worker({ OP: 'sign', CRASH: when, ACCEPTED_FILE: accepted, ESCROW_ID: c.escrow.id, ACTOR: c.buyer.id, SIGNED_PSBT: signRound(c.round.unsignedPsbtBase64, buyerKey) })
    expect(crashed.code).toBe(137)
    expect(await escrowOf(c)).toMatchObject({ status: 'REFUNDED', txReleaseId: null }) // claimed before the broadcast
    if (when === 'after') {
      accept(chain, JSON.parse(fs.readFileSync(accepted, 'utf8')).hex)
      fs.unlinkSync(accepted)
    }
    const restarted = await worker({ OP: 'reconcile', ESCROW_ID: c.escrow.id })
    expect(restarted).toMatchObject({ ok: true, code: 0 })
    expect(restarted.value.recovered).toEqual([{ txId: roundTxid(c), outcome: when === 'after' ? 'ALREADY_BROADCAST' : 'NEWLY_BROADCAST' }])
    expect(await escrowOf(c)).toMatchObject({ status: 'REFUNDED', txReleaseId: roundTxid(c) })
  })
})
