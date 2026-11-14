// tests/integration/pendingRoundLifecycleProcesses.test.ts
//
// Issue #239 (T12) - the single-winner properties across TWO INDEPENDENT OS PROCESSES (pendingRoundLifecycle.worker.ts)
// sharing only PostgreSQL. Concurrency is proven, not assumed: this test holds the escrow's advisory lock and lets the
// processes go only after pg_locks + pg_stat_activity show a backend of EACH process waiting on it. Real PSBTs; the
// explorer is the deterministic stub, handed to each process as JSON.
import { spawn } from 'child_process'
import path from 'path'
import { PrismaClient } from '@prisma/client'
import { createPostgresIntegrationHarness } from './postgresTestHarness'
import { closeTestRedis } from './identityTestHelpers'
import { buildCooperative, newChain, explorer, signRound, completeOutsideSails, chainToJson, buyerKey, sellerKey, type Chain } from './pendingRoundLifecycleHarness'

const WORKER = path.join(__dirname, 'pendingRoundLifecycle.worker.ts')

describe('Issue #239 (T12) - two independent OS processes, one winner (real PostgreSQL)', () => {
  jest.setTimeout(300_000)
  const pg = createPostgresIntegrationHarness()
  let dbAvailable = false
  let prisma: PrismaClient
  let deps: Parameters<typeof buildCooperative>[0]
  let chain: Chain
  let realFetch: typeof fetch

  beforeAll(async () => {
    process.env.MOCK_ESCROW = 'false'
    process.env.MULTISIG_SEED = process.env.MULTISIG_SEED || 'i239-test-seed'
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
    const { intentEngine } = require('../../src/core/intent-engine')
    intentEngine.registerHandler(require('../../src/modules/open-p2p/intent-handler').OpenP2PTradeIntentHandler)
  })
  beforeEach(() => {
    chain = newChain()
    realFetch = global.fetch
    global.fetch = explorer(chain)
  })
  afterEach(() => { global.fetch = realFetch })
  afterAll(async () => {
    if (dbAvailable) {
      await prisma.$disconnect()
      await closeTestRedis()
    }
  })

  interface Result { label: string; ok: boolean; value?: any; error?: string }
  function worker(label: string, env: Record<string, string>): Promise<Result> {
    const child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', WORKER], {
      env: { ...process.env, ...env, CHAIN: chainToJson(chain), PGAPPNAME: `p239-${label}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    return new Promise((resolve) => child.on('exit', (code) => {
      const last = out.trim().split('\n').reverse().find((l) => l.startsWith('{"ok"'))
      resolve(last ? { label, ...JSON.parse(last) } : { label, ok: false, error: `no result (exit ${code}): ${err.slice(-600)}` })
    }))
  }

  /** Backends of distinct worker processes currently waiting on an advisory lock. */
  const waitingWorkers = async () => (await prisma.$queryRaw<Array<{ app: string; pid: number }>>`
    SELECT a.application_name::text AS app, a.pid FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
    WHERE l.locktype = 'advisory' AND NOT l.granted AND a.application_name LIKE 'p239-%'`)
  async function untilBothWaiting(labels: string[]) {
    for (let i = 0; i < 6000; i++) {
      const rows = await waitingWorkers()
      if (labels.every((l) => rows.some((r) => r.app === `p239-${l}`)) && new Set(rows.map((r) => r.pid)).size >= labels.length) return rows
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error(`workers ${labels.join(', ')} never both waited on the escrow lock`)
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
    }, { timeout: 240_000 })
    await isHeld
    return async () => { release(); await done }
  }

  it('T12a: cancellation (process A) against the last signature (process B): exactly one wins', async () => {
    pg.requirePostgres('T12a')
    const c = await buildCooperative(deps, chain, 't12a')
    await deps.escrowService.submitTransactionSignature(c.escrow.id, c.buyer.id, signRound(c.round.unsignedPsbtBase64, buyerKey))
    const release = await holdEscrowLock(c.escrow.id)
    const a = worker('cancel', { OP: 'cancel', ESCROW_ID: c.escrow.id, PENDING_ID: c.round.id, ACTOR: c.seller.id })
    const b = worker('sign', { OP: 'sign', ESCROW_ID: c.escrow.id, ACTOR: c.seller.id, SIGNED_PSBT: signRound(c.round.unsignedPsbtBase64, sellerKey) })
    const waiting = await untilBothWaiting(['cancel', 'sign'])
    expect(new Set(waiting.map((w) => w.pid)).size).toBe(2)
    await release()
    const [cancel, sign] = await Promise.all([a, b])
    const cancelled = cancel.ok && cancel.value.outcome === 'CANCELLED'
    const signed = sign.ok
    expect([cancelled, signed].filter(Boolean)).toHaveLength(1)
    const retired = await prisma.escrowPendingRoundRetirement.count({ where: { escrowId: c.escrow.id } })
    if (cancelled) {
      expect(sign.error).toMatch(/has no pending transaction/)
      expect(retired).toBe(1)
    } else {
      expect(cancel.error).toMatch(/fully signed|COMPLETED|non-terminal/)
      expect(retired).toBe(0)
    }
  })

  it('T12b: two reconcilers in two processes converge the same external completion exactly once', async () => {
    pg.requirePostgres('T12b')
    const c = await buildCooperative(deps, chain, 't12b')
    await deps.escrowService.submitTransactionSignature(c.escrow.id, c.seller.id, signRound(c.round.unsignedPsbtBase64, sellerKey))
    const stored = (await prisma.escrowTransactionSignature.findFirstOrThrow({ where: { pendingTxId: c.round.id } })).signedPsbtBase64
    const spend = completeOutsideSails(c.round.unsignedPsbtBase64, [stored, signRound(c.round.unsignedPsbtBase64, buyerKey)])
    chain.spentBy.set(`${c.funding}:0`, spend.txid)
    chain.confirmed.add(spend.txid)
    chain.hex.set(spend.txid, spend.hex)
    const release = await holdEscrowLock(c.escrow.id)
    const a = worker('rec-a', { OP: 'reconcile', ESCROW_ID: c.escrow.id })
    const b = worker('rec-b', { OP: 'reconcile', ESCROW_ID: c.escrow.id })
    await untilBothWaiting(['rec-a', 'rec-b'])
    await release()
    const results = await Promise.all([a, b])
    for (const r of results) expect(r).toMatchObject({ ok: true, value: { failed: [] } })
    expect(results.reduce((n, r) => n + r.value.externallyCompleted, 0)).toBe(1)
    expect(await prisma.escrow.findUniqueOrThrow({ where: { id: c.escrow.id } })).toMatchObject({ status: 'COMPLETED', txReleaseId: spend.txid })
    expect(await prisma.escrowEvent.count({ where: { escrowId: c.escrow.id, toStatus: 'COMPLETED' } })).toBe(1)
  })
})
