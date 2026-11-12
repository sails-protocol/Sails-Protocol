/**
 * AUX-M9R-C0 - characterization of the settlement reconciler tick exactly as it runs TODAY (src/app.ts:
 * runSettlementReconcilerTick() and the interval startServer() wraps around it). These tests document
 * behavior; they do not endorse it. Nothing here changes production code, and nothing connects the M9-R
 * recovery routines (reconcileMissingDispatch, reconcileStalePendingDisputeTranslations) to the tick: when a
 * later change touches the tick, a failing test below is the review checklist of what it altered.
 *
 * Only the two routines the tick calls are replaced (recoverUnpublishedIntentEvents,
 * reconcilePendingSettlements). Their own behavior is proven elsewhere (escrowSettlementReconciliation.test.ts,
 * settlementReconcilerMultiInstance, reconcilerOsProcess*, rulingFinalizationEligibility D12). No database.
 *
 *  Part A - one tick, called directly: order, logging, a failing step that does not hide or block the other,
 *           a slow step that holds back the next one.
 *  Part B - the real startServer() with a short interval: no tick at boot, the process-local overlap guard,
 *           a step that never settles, shutdown with a tick in flight, the opt-out flag, restart.
 */
// A module, not a global script: otherwise its top-level names (ORIGINAL_ENV, sleep, until, ...) collide with
// the same names in other import-less test files when TypeScript checks them together (TS2451 in CI).
export {}

jest.mock('dotenv/config', () => ({}))

jest.mock('../src/common/events/event-bus', () => ({
  eventBus: {
    emit: jest.fn().mockResolvedValue(undefined), on: jest.fn(), onDurable: jest.fn(),
    enableCrossInstanceFanout: jest.fn(), disableCrossInstanceFanout: jest.fn().mockResolvedValue(undefined),
  },
}))
jest.mock('../src/infrastructure/p2p/pear.service', () => ({
  pearNodeRegistry: { start: jest.fn(), stop: jest.fn(), get: jest.fn(), getStatus: jest.fn() },
}))
jest.mock('@tetherto/wdk-wallet-evm', () => ({ __esModule: true, default: class FakeWalletManagerEvm {} }))
jest.mock('@arkade-os/sdk', () => ({
  SeedIdentity: { fromSeed: jest.fn() },
  MultisigTapscript: { encode: jest.fn() },
  CSVMultisigTapscript: { encode: jest.fn() },
  VtxoScript: class FakeVtxoScript {},
  RestArkProvider: class FakeRestArkProvider {},
  RestIndexerProvider: class FakeRestIndexerProvider {},
  buildOffchainTx: jest.fn(),
  combineTapscriptSigs: jest.fn(),
  verifyTapscriptSignatures: jest.fn(),
}))
jest.mock('@scure/btc-signer', () => ({ Transaction: { fromPSBT: jest.fn() } }))

const ORIGINAL_ENV = process.env
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
async function until(condition: () => boolean, what: string, ms = 5000): Promise<void> {
  for (let waited = 0; waited < ms; waited += 10) {
    if (condition()) return
    await sleep(10)
  }
  throw new Error(`timed out waiting for: ${what}`)
}

/** Every list ReconciliationReport carries, empty. */
const emptyReport = () => ({
  recovered: [], completionEffectsRecovered: [], requiresManualReview: [], failed: [],
  resumedUnclaimed: [], alreadyResumedConcurrently: [], projectionsRecovered: [], rulingFinalizationsRecovered: [],
  rulingFinalizationsDeferred: [], disputeArbitersRecovered: [], heldIncompatibleRounds: [], externallyCompleted: [],
  externalSpendUnreadable: [], externalSpendPendingConfirmation: [], externalSpendFundingUncertain: [],
}) as Record<string, any[]>

interface Wiring {
  calls: string[]
  intent: jest.Mock
  settlement: jest.Mock
  prisma: { $queryRaw: jest.Mock; $disconnect: jest.Mock }
  redis: { ping: jest.Mock; quit: jest.Mock }
}

/** Replaces the two routines the tick calls (and the connections startServer() opens); `calls` records their order. */
function wire(behavior: { intent?: () => Promise<unknown>; settlement?: () => Promise<unknown> } = {}): Wiring {
  const calls: string[] = []
  const intent = jest.fn(async () => { calls.push('intent'); return behavior.intent ? behavior.intent() : { republished: [] } })
  const settlement = jest.fn(async () => { calls.push('settlement'); return behavior.settlement ? behavior.settlement() : emptyReport() })
  const prisma = { $queryRaw: jest.fn(), $disconnect: jest.fn().mockResolvedValue(undefined) }
  const redis = { ping: jest.fn(), quit: jest.fn().mockResolvedValue('OK') }
  jest.doMock('../src/common/database', () => ({ prisma, connectDatabase: jest.fn().mockResolvedValue(undefined) }))
  jest.doMock('../src/common/redis', () => ({ redis, connectRedis: jest.fn().mockResolvedValue(undefined) }))
  jest.doMock('../src/core/intent-publication-recovery', () => ({ recoverUnpublishedIntentEvents: intent }))
  jest.doMock('../src/modules/open-settlement/escrow-settlement-reconciliation.service', () => ({
    ...jest.requireActual('../src/modules/open-settlement/escrow-settlement-reconciliation.service'),
    reconcilePendingSettlements: settlement,
  }))
  return { calls, intent, settlement, prisma, redis }
}

const fakeLog = () => ({ warn: jest.fn(), error: jest.fn() })
const tickOf = () => (require('../src/app') as typeof import('../src/app')).runSettlementReconcilerTick

describe('settlement reconciler tick - Part A: one tick, called directly (runSettlementReconcilerTick)', () => {
  jest.setTimeout(60_000)
  beforeEach(() => { jest.resetModules() })
  afterEach(() => { jest.resetModules() })

  it('runs Intent publication recovery first, then settlement reconciliation, once each, and resolves', async () => {
    const w = wire()
    await expect(tickOf()(fakeLog())).resolves.toBeUndefined()
    expect(w.calls).toEqual(['intent', 'settlement'])
  })

  it('a clean tick (empty report) logs nothing', async () => {
    wire()
    const log = fakeLog()
    await tickOf()(log)
    expect(log.warn).not.toHaveBeenCalled()
    expect(log.error).not.toHaveBeenCalled()
  })

  it('findings are reported in three separate warnings (findings, deferred rulings, attention), keeping the existing shapes; a reason is logged as a code only', async () => {
    wire({
      settlement: async () => ({
        ...emptyReport(),
        failed: [{ escrowId: 'e1', error: 'first' }, { escrowId: 'e1', error: 'second' }],
        projectionsRecovered: ['p1'],
        rulingFinalizationsDeferred: [{ disputeId: 'd1', reason: 'can still be rolled back' }],
        requiresManualReview: [
          { escrowId: 'e2', reason: 'BROADCAST_REJECTED: node said a-secret-provider-detail' },
          { escrowId: 'e3', reason: 'free text without a code' },
        ],
        heldIncompatibleRounds: ['h1'],
        externalSpendUnreadable: ['x1'],
      }),
    })
    const log = fakeLog()
    await tickOf()(log)

    const warnings = log.warn.mock.calls.map(([payload]) => payload)
    expect(warnings.map((w) => w.msg)).toEqual([
      'Settlement reconciliation completed with findings',
      'Ruling finalizations deferred: not finalized while they can still be rolled back, retried every tick',
      'Settlement reconciliation: held rounds, manual review or external-spend watch findings',
    ])
    expect(warnings[0]).toMatchObject({ module: 'settlement-reconciler', failed: 2, failedEscrowIds: ['e1'], requiresManualReview: 2, projectionsRecovered: ['p1'] })
    expect(warnings[1].rulingFinalizationsDeferred).toEqual([{ disputeId: 'd1', reason: 'can still be rolled back' }])
    expect(warnings[2]).toMatchObject({
      heldIncompatibleRounds: ['h1'],
      externalSpendUnreadable: ['x1'],
      requiresManualReview: [{ escrowId: 'e2', code: 'BROADCAST_REJECTED' }, { escrowId: 'e3', code: 'UNCODED' }],
    })
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('a-secret-provider-detail')
    expect(log.error).not.toHaveBeenCalled()
  })

  it('Intent recovery failing is logged as an error, never thrown, and does not stop settlement reconciliation', async () => {
    const w = wire({ intent: async () => { throw new Error('intent store down') } })
    const log = fakeLog()
    await expect(tickOf()(log)).resolves.toBeUndefined()
    expect(w.calls).toEqual(['intent', 'settlement'])
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ msg: 'Intent publication recovery failed', module: 'settlement-reconciler', err: 'intent store down' }))
  })

  it('settlement reconciliation failing is logged as an error, never thrown, after Intent recovery already ran', async () => {
    const w = wire({ settlement: async () => { throw new Error('PASS 0 blew up') } })
    const log = fakeLog()
    await expect(tickOf()(log)).resolves.toBeUndefined()
    expect(w.calls).toEqual(['intent', 'settlement'])
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ msg: 'Settlement reconciliation failed', module: 'settlement-reconciler', err: 'PASS 0 blew up' }))
  })

  it('both failing: two distinct errors, neither hides the other', async () => {
    wire({ intent: async () => { throw new Error('A') }, settlement: async () => { throw new Error('B') } })
    const log = fakeLog()
    await tickOf()(log)
    expect(log.error.mock.calls.map(([p]) => [p.msg, p.err])).toEqual([
      ['Intent publication recovery failed', 'A'],
      ['Settlement reconciliation failed', 'B'],
    ])
  })

  it('steps are sequential and share one time budget: a slow Intent recovery holds settlement reconciliation back, and a slow step has no timeout of its own', async () => {
    let finishIntent!: () => void
    const w = wire({ intent: () => new Promise<void>((resolve) => { finishIntent = resolve }) })
    const tick = tickOf()(fakeLog())
    await until(() => w.intent.mock.calls.length === 1, 'intent recovery to start')
    await sleep(200)
    expect(w.settlement).not.toHaveBeenCalled() // still waiting behind the slow step, nothing cut it off
    finishIntent()
    await tick
    expect(w.calls).toEqual(['intent', 'settlement'])
  })
})

describe('settlement reconciler tick - Part B: the interval startServer() runs it on (real startServer, short interval)', () => {
  jest.setTimeout(60_000)
  let exitSpy: jest.SpyInstance

  beforeEach(() => {
    jest.resetModules()
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  })
  afterEach(() => {
    process.removeAllListeners('SIGTERM')
    process.removeAllListeners('SIGINT')
    exitSpy.mockRestore()
    process.env = ORIGINAL_ENV
    jest.resetModules()
  })

  async function boot(env: Record<string, string> = {}): Promise<void> {
    process.env = { PORT: '0', HOST: '127.0.0.1', NODE_ENV: 'development', ESCROW_SETTLEMENT_RECONCILE_INTERVAL_MS: '40', ...env }
    const banner = jest.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      await require('../src/app').startServer()
    } finally {
      banner.mockRestore()
    }
  }
  async function terminate(): Promise<void> {
    exitSpy.mockClear()
    process.emit('SIGTERM' as any)
    await until(() => exitSpy.mock.calls.length > 0, 'shutdown to call process.exit')
  }

  it('no tick runs at boot: the first one comes one interval later; afterwards each tick is Intent recovery then settlement reconciliation', async () => {
    const w = wire()
    await boot()
    try {
      expect(w.calls).toEqual([])
      await until(() => w.settlement.mock.calls.length >= 2, 'two ticks')
      expect(w.calls.slice(0, 4)).toEqual(['intent', 'settlement', 'intent', 'settlement'])
    } finally {
      await terminate()
    }
  })

  it('a tick never overlaps the previous one in this process: while one runs, later intervals start nothing; the next starts after it ends', async () => {
    let release!: () => void
    let first = true
    const w = wire({
      settlement: () => {
        if (!first) return Promise.resolve(emptyReport())
        first = false
        return new Promise((resolve) => { release = () => resolve(emptyReport()) })
      },
    })
    await boot()
    try {
      await until(() => w.settlement.mock.calls.length === 1, 'the first tick to reach settlement')
      await sleep(300) // about seven intervals
      expect(w.calls).toEqual(['intent', 'settlement']) // no second tick, and no second Intent recovery either
      release()
      await until(() => w.settlement.mock.calls.length >= 2, 'the next tick after the first ended')
      expect(w.calls.slice(0, 4)).toEqual(['intent', 'settlement', 'intent', 'settlement'])
    } finally {
      await terminate()
    }
  })

  it('a step that never settles stops recovery in this process for good (no per-tick timeout); shutdown does not wait for it; a restart schedules ticks again', async () => {
    const stuck = wire({ settlement: () => new Promise(() => undefined) })
    await boot()
    try {
      await until(() => stuck.settlement.mock.calls.length === 1, 'the first tick to get stuck')
      await sleep(300)
      expect(stuck.calls).toEqual(['intent', 'settlement']) // seven intervals later: still the one tick, nothing else runs
    } finally {
      await terminate()
    }
    expect(exitSpy).toHaveBeenCalledWith(0) // the process exits with the tick still in flight: nothing drains it
    expect(stuck.prisma.$disconnect).toHaveBeenCalledTimes(1) // and Postgres is closed under it

    // Restart: a new process has none of that process-local state.
    process.removeAllListeners('SIGTERM')
    process.removeAllListeners('SIGINT')
    jest.resetModules()
    const restarted = wire()
    await boot()
    try {
      await until(() => restarted.settlement.mock.calls.length >= 1, 'a tick after the restart')
      expect(restarted.calls.slice(0, 2)).toEqual(['intent', 'settlement'])
    } finally {
      await terminate()
    }
  })

  it('ESCROW_SETTLEMENT_RECONCILER=false is the only way to switch the tick off: nothing is scheduled', async () => {
    const w = wire()
    await boot({ ESCROW_SETTLEMENT_RECONCILER: 'false' })
    try {
      await sleep(300)
      expect(w.calls).toEqual([])
    } finally {
      await terminate()
    }
  })
})
