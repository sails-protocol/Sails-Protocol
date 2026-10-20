/**
 * app.ts's real startServer() — proves the production boot path starts the settlement / M9-R C4 recovery
 * schedule, follows the same on-by-default policy outside production, honours the explicit opt-out, and
 * stops the schedule on graceful shutdown. startServer() is the only place the recovery tick is started
 * (buildApp() never schedules anything), so it is booted for real here: real buildApp(), real config
 * gates, a real listen() on an ephemeral port. Only external connections (Postgres, Redis, P2P, wallet
 * SDKs) and the schedule module itself are replaced, so the assertion is about wiring, not about what a
 * tick does (tests/settlementRecoverySchedule.test.ts and the real-PostgreSQL integration tests cover that).
 */
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

const PROD_ENV = {
  NODE_ENV: 'production',
  MOCK_ESCROW: 'false',
  MOCK_SETTLEMENT: 'false',
  ENFORCE_CAPABILITIES: 'true',
  DATABASE_URL: 'postgresql://real-host/sails_protocol',
  REDIS_URL: 'redis://real-host:6379',
  MULTISIG_NETWORK: 'testnet',
  EVIDENCE_PROVIDER: 's3',
  EVIDENCE_S3_BUCKET: 'real-evidence-bucket',
  EVIDENCE_S3_ACCESS_KEY_ID: 'real-access-key',
  EVIDENCE_S3_SECRET_ACCESS_KEY: 'real-secret-key',
  // Master Backlog R5 — DEFAULT_TIMELOCK_HOURS is now required in production
  // (an unset value no longer falls back to the dev default there).
  DEFAULT_TIMELOCK_HOURS: '24',
}

describe('startServer() — settlement / C4 recovery wiring', () => {
  jest.setTimeout(60_000)
  const ORIGINAL_ENV = process.env
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
  })

  async function boot(env: Record<string, string | undefined>) {
    process.env = { PORT: '0', HOST: '127.0.0.1' }
    for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v
    // stop() drains an in-flight tick; this one takes a moment, and records when it finished.
    const events: string[] = []
    const stop = jest.fn(() => new Promise<void>((resolve) => setTimeout(() => { events.push('recovery drained'); resolve() }, 50)))
    const startSettlementRecoverySchedule = jest.fn(() => ({ stop }))
    jest.doMock('../src/modules/open-settlement/settlement-recovery-schedule', () => ({ startSettlementRecoverySchedule }))
    // The guarded background sweepers (timelock, dispute auto-resolution, fee confirmation/reorg,
    // funding/release reorg): record each scheduled run and interval; each stop() takes a moment to
    // drain, like a real run in flight.
    const sweeperStops: jest.Mock[] = []
    const startGuardedInterval = jest.fn((_run: () => Promise<void>, _intervalMs: number) => {
      const index = sweeperStops.length
      const sweeperStop = jest.fn(() => new Promise<void>((resolve) => setTimeout(() => { events.push(`sweeper ${index} drained`); resolve() }, 30)))
      sweeperStops.push(sweeperStop)
      return { stop: sweeperStop }
    })
    jest.doMock('../src/common/guarded-interval', () => ({ startGuardedInterval }))
    const prisma = { $queryRaw: jest.fn(), $disconnect: jest.fn(async () => { events.push('postgres disconnected') }) }
    const redis = { ping: jest.fn(), quit: jest.fn().mockResolvedValue('OK') }
    jest.doMock('../src/common/database', () => ({ prisma, connectDatabase: jest.fn().mockResolvedValue(undefined) }))
    jest.doMock('../src/common/redis', () => ({ redis, connectRedis: jest.fn().mockResolvedValue(undefined) }))
    const { config } = require('../src/config')
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined) // boot banner
    try {
      await require('../src/app').startServer()
    } finally {
      logSpy.mockRestore()
    }
    return { config, startSettlementRecoverySchedule, stop, prisma, redis, events, startGuardedInterval, sweeperStops }
  }

  async function shutdown(): Promise<void> {
    process.emit('SIGTERM' as any)
    for (let i = 0; i < 200 && exitSpy.mock.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
    expect(exitSpy).toHaveBeenCalledWith(0)
  }

  // Each boot is a full cold require of the app graph, so this file keeps to three boots; the opt-out case
  // rides on the sweepers boot. Default interval values are covered by tests/configProductionGates.test.ts.
  it('PRODUCTION: startup schedules the recovery tick once, at the configured interval, with the app logger; SIGTERM stops it and drains a running tick before disconnecting Postgres/Redis', async () => {
    const { config, startSettlementRecoverySchedule, stop, redis, events } = await boot({ ...PROD_ENV, ESCROW_SETTLEMENT_RECONCILE_INTERVAL_MS: '15000' })
    try {
      expect(config.isProduction).toBe(true)
      expect(startSettlementRecoverySchedule).toHaveBeenCalledTimes(1)
      const [log, intervalMs] = (startSettlementRecoverySchedule.mock.calls[0] as unknown) as [any, number]
      expect(intervalMs).toBe(15000)
      expect(typeof log.warn).toBe('function')
      expect(typeof log.error).toBe('function')
      expect(stop).not.toHaveBeenCalled()
    } finally {
      await shutdown()
    }
    expect(stop).toHaveBeenCalledTimes(1)
    expect(events).toEqual(['recovery drained', 'postgres disconnected']) // the drain is awaited, not just started
    expect(redis.quit).toHaveBeenCalled()
  })

  it('PRODUCTION, sweepers enabled: the escrow-timelock, dispute auto-resolution, fee-confirmation, fee-reorg, funding-reorg and release-reorg sweepers are scheduled through the guarded interval at their configured intervals, each run contains its own failure, and SIGTERM drains every one of them before Postgres disconnects', async () => {
    const { startGuardedInterval, sweeperStops, events, startSettlementRecoverySchedule } = await boot({
      ...PROD_ENV,
      ESCROW_SETTLEMENT_RECONCILER: 'false', // also the opt-out case: no recovery tick is scheduled at all
      ESCROW_TIMELOCK_SWEEPER: 'true', ESCROW_TIMELOCK_SWEEP_INTERVAL_MS: '111000',
      MULTISIG_FEE_CONFIRMATION_SWEEPER: 'true', MULTISIG_FEE_CONFIRMATION_SWEEP_INTERVAL_MS: '222000',
      MULTISIG_FUNDING_REORG_SWEEPER: 'true', MULTISIG_FUNDING_REORG_SWEEP_INTERVAL_MS: '333000',
      DISPUTE_AUTO_RESOLUTION_SWEEPER: 'true', DISPUTE_AUTO_RESOLUTION_SWEEP_INTERVAL_MS: '444000',
      MULTISIG_FEE_REORG_SWEEPER: 'true', MULTISIG_FEE_REORG_SWEEP_INTERVAL_MS: '555000',
      MULTISIG_RELEASE_REORG_SWEEPER: 'true', MULTISIG_RELEASE_REORG_SWEEP_INTERVAL_MS: '666000',
    })
    try {
      expect(startSettlementRecoverySchedule).not.toHaveBeenCalled() // ESCROW_SETTLEMENT_RECONCILER=false is the only way to not schedule it
      expect(startGuardedInterval).toHaveBeenCalledTimes(6)
      // startServer() order: escrow timelock, dispute auto-resolution, fee confirmation, fee reorg, funding reorg, release reorg.
      expect(startGuardedInterval.mock.calls.map((call) => call[1])).toEqual([111000, 444000, 222000, 555000, 333000, 666000])
      // Run each scheduled sweep for real against this test's stub database (no real Postgres here, so
      // every sweep fails inside): the run must contain that failure and resolve, never reject.
      for (const [run] of startGuardedInterval.mock.calls) await expect(run()).resolves.toBeUndefined()
      for (const sweeperStop of sweeperStops) expect(sweeperStop).not.toHaveBeenCalled()
    } finally {
      await shutdown()
    }
    for (const sweeperStop of sweeperStops) expect(sweeperStop).toHaveBeenCalledTimes(1)
    expect(events).toEqual(['sweeper 0 drained', 'sweeper 1 drained', 'sweeper 2 drained', 'sweeper 3 drained', 'sweeper 4 drained', 'sweeper 5 drained', 'postgres disconnected'])
  })

  it('NON-PRODUCTION: the same on-by-default policy applies to the recovery tick (the flag is not production-only), and disabled sweepers (their default) are never scheduled', async () => {
    const { config, startSettlementRecoverySchedule, startGuardedInterval } = await boot({ NODE_ENV: 'development' })
    try {
      expect(config.isProduction).toBe(false)
      expect(startSettlementRecoverySchedule).toHaveBeenCalledTimes(1)
      expect(startGuardedInterval).not.toHaveBeenCalled()
    } finally {
      await shutdown()
    }
  })


})
