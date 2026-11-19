/**
 * Observability disclosure (CTO 429): real app.inject() round-trips for
 * GET /metrics, /health, /health/live and /health/ready, in production and
 * outside it. The config module is replaced with the real one plus explicit
 * isProduction / observability overrides, so each case exercises the real
 * routes in src/app.ts rather than asserting on config shape.
 */
jest.mock('../src/common/events/event-bus', () => ({
  eventBus: { emit: jest.fn().mockResolvedValue(undefined), on: jest.fn(), onDurable: jest.fn() },
}))

jest.mock('../src/infrastructure/p2p/pear.service', () => ({
  pearNodeRegistry: { start: jest.fn(), stop: jest.fn(), get: jest.fn(), getStatus: jest.fn() },
}))

jest.mock('@tetherto/wdk-wallet-evm', () => ({
  __esModule: true,
  default: class FakeWalletManagerEvm {},
}))

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

const SECRET = 'postgres://internal-db.example/private-db?password=should-not-leak'

async function boot(opts: { production: boolean; metricsEnabled: boolean; postgresDown?: boolean }) {
  jest.resetModules()
  jest.doMock('../src/common/database', () => ({
    prisma: {
      $queryRaw: opts.postgresDown ? jest.fn().mockRejectedValue(new Error(SECRET)) : jest.fn().mockResolvedValue([{ '?column?': 1 }]),
      user: { findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
    },
  }))
  jest.doMock('../src/common/redis', () => ({
    redis: { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK'), del: jest.fn(), ping: jest.fn().mockResolvedValue('PONG') },
  }))
  const real = jest.requireActual('../src/config')
  jest.doMock('../src/config', () => ({
    ...real,
    config: { ...real.config, isProduction: opts.production, observability: { metricsEnabled: opts.metricsEnabled } },
  }))
  const { buildApp } = require('../src/app')
  const app = await buildApp({ registerSwaggerUi: false })
  await app.ready()
  return app
}

describe('observability disclosure (CTO 429)', () => {
  jest.setTimeout(30_000)

  describe('production, METRICS_ENABLED off (the default)', () => {
    it('does not serve /metrics', async () => {
      const app = await boot({ production: true, metricsEnabled: false })
      try {
        expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(404)
      } finally {
        await app.close()
      }
    })

    it('/health stays public and ok but discloses no internal features', async () => {
      const app = await boot({ production: true, metricsEnabled: false })
      try {
        const res = await app.inject({ method: 'GET', url: '/health' })
        expect(res.statusCode).toBe(200)
        const body = JSON.parse(res.body)
        expect(body.status).toBe('ok')
        expect(body).not.toHaveProperty('features')
        expect(res.body).not.toMatch(/mockEscrow|mockSettlement/)
      } finally {
        await app.close()
      }
    })

    it('/health/live keeps its liveness contract', async () => {
      const app = await boot({ production: true, metricsEnabled: false })
      try {
        const res = await app.inject({ method: 'GET', url: '/health/live' })
        expect(res.statusCode).toBe(200)
        expect(JSON.parse(res.body)).toMatchObject({ status: 'ok', protocol: 'Sails Protocol' })
      } finally {
        await app.close()
      }
    })

    it('/health/ready keeps 503 not_ready but leaks no dependency error detail', async () => {
      const app = await boot({ production: true, metricsEnabled: false, postgresDown: true })
      try {
        const res = await app.inject({ method: 'GET', url: '/health/ready' })
        expect(res.statusCode).toBe(503)
        const body = JSON.parse(res.body)
        expect(body.status).toBe('not_ready')
        expect(body.checks.postgres.ok).toBe(false)
        expect(body.checks.redis.ok).toBe(true)
        expect(res.body).not.toContain('should-not-leak')
        expect(res.body).not.toContain('internal-db.example')
      } finally {
        await app.close()
      }
    })
  })

  describe('production, METRICS_ENABLED explicitly on', () => {
    it('serves /metrics (explicit opt-in; protection stays an infrastructure concern)', async () => {
      const app = await boot({ production: true, metricsEnabled: true })
      try {
        const res = await app.inject({ method: 'GET', url: '/metrics' })
        expect(res.statusCode).toBe(200)
        expect(res.headers['content-type']).toMatch(/text\/plain/)
      } finally {
        await app.close()
      }
    })

    it('still hides /health features', async () => {
      const app = await boot({ production: true, metricsEnabled: true })
      try {
        expect(JSON.parse((await app.inject({ method: 'GET', url: '/health' })).body)).not.toHaveProperty('features')
      } finally {
        await app.close()
      }
    })
  })

  describe('outside production (unchanged behavior)', () => {
    it('serves /metrics and the /health features', async () => {
      const app = await boot({ production: false, metricsEnabled: true })
      try {
        expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(200)
        const body = JSON.parse((await app.inject({ method: 'GET', url: '/health' })).body)
        expect(body.features).toEqual({ mockEscrow: expect.any(Boolean), mockSettlement: expect.any(Boolean) })
      } finally {
        await app.close()
      }
    })

    it('METRICS_ENABLED=false turns /metrics off here too', async () => {
      const app = await boot({ production: false, metricsEnabled: false })
      try {
        expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(404)
      } finally {
        await app.close()
      }
    })
  })
})
