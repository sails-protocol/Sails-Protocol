/**
 * /health/live and /health/ready — real k8s/Docker-style probes
 * (src/app.ts). /health/live is process-only (never touches DB/Redis, so
 * a transient DB outage doesn't trigger a container restart);
 * /health/ready does real checks and reports 503 if either dependency
 * is unreachable — this is what docker-compose.yml's own app-level
 * HEALTHCHECK now points at.
 *
 * Each test dynamically mocks common/database and common/redis via
 * jest.doMock() + jest.resetModules() + require('../src/app') (same
 * pattern tests/metricsBusinessCounters.test.ts already establishes)
 * rather than a single static top-level jest.mock(), since the
 * /health/ready tests each need a different resolved/rejected value.
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

afterEach(() => {
  jest.resetModules()
})

describe('/health/live', () => {
  // Each test does a full jest.resetModules() + fresh require('../src/app')
  // (this file's own header comment) — a real cold-start path. Technical
  // Debt #57 bounded remediation: every buildApp() call below now passes
  // registerSwaggerUi: false, since this suite never touches /docs — this
  // removes the single most expensive registration step
  // (docs/TECHNICAL_DEBT_AUDIT.md #57's own evidence). The 30s margin is
  // retained defensively for the remaining cold-require cost (every route
  // + common/openapi.ts's own OpenAPI schema generation, PRODUCTION_READINESS_FIXES.md
  // item 21), not because Swagger-UI is registered here anymore.
  jest.setTimeout(30_000)

  it('always reports ok, without touching postgres or redis', async () => {
    jest.doMock('../src/common/database', () => ({ prisma: { $queryRaw: jest.fn() } }))
    jest.doMock('../src/common/redis', () => ({ redis: { ping: jest.fn() } }))
    const { prisma } = require('../src/common/database')
    const { redis } = require('../src/common/redis')
    const { buildApp } = require('../src/app')
    const app = await buildApp({ registerSwaggerUi: false })
    try {
      const res = await app.inject({ method: 'GET', url: '/health/live' })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body).status).toBe('ok')
      expect(prisma.$queryRaw).not.toHaveBeenCalled()
      expect(redis.ping).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })
})

describe('/health/ready', () => {
  it('reports 200 ready when both postgres and redis are reachable', async () => {
    jest.doMock('../src/common/database', () => ({ prisma: { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) } }))
    jest.doMock('../src/common/redis', () => ({ redis: { ping: jest.fn().mockResolvedValue('PONG') } }))
    const { buildApp } = require('../src/app')
    const app = await buildApp({ registerSwaggerUi: false })
    try {
      const res = await app.inject({ method: 'GET', url: '/health/ready' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.status).toBe('ready')
      expect(body.checks.postgres.ok).toBe(true)
      expect(body.checks.redis.ok).toBe(true)
    } finally {
      await app.close()
    }
  })

  it('sanitizes postgres failure details while preserving redis readiness', async () => {
    const secret = 'postgres://internal-db.example/private-db?password=should-not-leak'
    jest.doMock('../src/common/database', () => ({ prisma: { $queryRaw: jest.fn().mockRejectedValue(new Error(secret)) } }))
    jest.doMock('../src/common/redis', () => ({ redis: { ping: jest.fn().mockResolvedValue('PONG') } }))
    const { buildApp } = require('../src/app')
    const app = await buildApp({ registerSwaggerUi: false })
    try {
      const res = await app.inject({ method: 'GET', url: '/health/ready' })
      expect(res.statusCode).toBe(503)
      const body = JSON.parse(res.body)
      expect(body.status).toBe('not_ready')
      expect(body.checks.postgres).toMatchObject({ ok: false, error: 'Dependency unavailable' })
      expect(body.checks.redis.ok).toBe(true)
      expect(res.body).not.toContain(secret)
      expect(res.body).not.toContain('should-not-leak')
    } finally {
      await app.close()
    }
  })

  it('reports 503 not_ready when redis is unreachable, without crashing', async () => {
    jest.doMock('../src/common/database', () => ({ prisma: { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) } }))
    jest.doMock('../src/common/redis', () => ({ redis: { ping: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) } }))
    const { buildApp } = require('../src/app')
    const app = await buildApp({ registerSwaggerUi: false })
    try {
      const res = await app.inject({ method: 'GET', url: '/health/ready' })
      expect(res.statusCode).toBe(503)
      const body = JSON.parse(res.body)
      expect(body.status).toBe('not_ready')
      expect(body.checks.postgres.ok).toBe(true)
      expect(body.checks.redis.ok).toBe(false)
      expect(body.checks.redis.error).toBe('Dependency unavailable')
      expect(res.body).not.toContain('ECONNREFUSED')
    } finally {
      await app.close()
    }
  })

  it('reports 503 not_ready when redis responds but not with PONG', async () => {
    jest.doMock('../src/common/database', () => ({ prisma: { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) } }))
    jest.doMock('../src/common/redis', () => ({ redis: { ping: jest.fn().mockResolvedValue('WEIRD') } }))
    const { buildApp } = require('../src/app')
    const app = await buildApp({ registerSwaggerUi: false })
    try {
      const res = await app.inject({ method: 'GET', url: '/health/ready' })
      expect(res.statusCode).toBe(503)
      const body = JSON.parse(res.body)
      expect(body.checks.redis.ok).toBe(false)
      expect(body.checks.redis.error).toBe('Dependency unavailable')
      expect(res.body).not.toContain('WEIRD')
    } finally {
      await app.close()
    }
  })
})
