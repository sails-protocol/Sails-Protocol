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

  it('reports 503 not_ready when redis is unreachable, without crashing', async () => {
    jest.doMock('../src/common/database', () => ({ prisma: { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) } }))
    jest.doMock('../src/common/redis', () => ({ redis: { ping: jest.fn().mockRejectedValue(new Error('connect redis.internal:6379 password=secret ECONNREFUSED')) } }))
    const { buildApp } = require('../src/app')
    const app = await buildApp({ registerSwaggerUi: false })
    try {
      const res = await app.inject({ method: 'GET', url: '/health/ready' })
      expect(res.statusCode).toBe(503)
      const body = JSON.parse(res.body)
      expect(body.status).toBe('not_ready')
      expect(body.checks.postgres.ok).toBe(true)
      expect(body.checks.redis.ok).toBe(false)
      expect(JSON.stringify(body)).not.toMatch(/redis\.internal|password=secret|ECONNREFUSED/)
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
      expect(body.checks.redis).toEqual({ ok: false, latencyMs: expect.any(Number) })
    } finally {
      await app.close()
    }
  })

  it('reports 503 not_ready when postgres fails without exposing connection details', async () => {
    jest.doMock('../src/common/database', () => ({ prisma: { $queryRaw: jest.fn().mockRejectedValue(new Error('postgres.internal:5432/sails_protocol password=secret socket timeout')) } }))
    jest.doMock('../src/common/redis', () => ({ redis: { ping: jest.fn().mockResolvedValue('PONG') } }))
    const { buildApp } = require('../src/app')
    const app = await buildApp({ registerSwaggerUi: false })
    try {
      const res = await app.inject({ method: 'GET', url: '/health/ready' })
      expect(res.statusCode).toBe(503)
      const body = JSON.parse(res.body)
      expect(body.checks.postgres).toEqual({ ok: false, latencyMs: expect.any(Number) })
      expect(JSON.stringify(body)).not.toMatch(/postgres\.internal|sails_protocol|password=secret|socket timeout/)
    } finally {
      await app.close()
    }
  })

  it('keeps production health public but hides internal posture and metrics by default', async () => {
    const originalEnv = process.env
    process.env = {
      ...process.env,
      NODE_ENV: 'production',
      MOCK_ESCROW: 'false',
      MOCK_SETTLEMENT: 'false',
      ENFORCE_CAPABILITIES: 'true',
      DATABASE_URL: 'postgresql://postgres.internal/sails_protocol',
      REDIS_URL: 'redis://redis.internal:6379',
      MULTISIG_NETWORK: 'testnet',
      EVIDENCE_PROVIDER: 's3',
      EVIDENCE_S3_BUCKET: 'real-evidence-bucket',
      EVIDENCE_S3_ACCESS_KEY_ID: 'real-access-key',
      EVIDENCE_S3_SECRET_ACCESS_KEY: 'real-secret-key',
      METRICS_ENABLED: 'false',
    }
    jest.resetModules()
    jest.doMock('../src/common/database', () => ({ prisma: { $queryRaw: jest.fn(), $disconnect: jest.fn() } }))
    jest.doMock('../src/common/redis', () => ({ redis: { ping: jest.fn(), quit: jest.fn() } }))
    const { buildApp } = require('../src/app')
    const app = await buildApp({ registerSwaggerUi: false })
    try {
      const health = await app.inject({ method: 'GET', url: '/health' })
      const metrics = await app.inject({ method: 'GET', url: '/metrics' })
      expect(health.statusCode).toBe(200)
      expect(JSON.parse(health.body).features).toBeUndefined()
      expect(metrics.statusCode).toBe(404)
    } finally {
      await app.close()
      process.env = originalEnv
    }
  })

  it('serves production metrics only when explicitly enabled', async () => {
    const originalEnv = process.env
    process.env = {
      ...process.env,
      NODE_ENV: 'production',
      MOCK_ESCROW: 'false',
      MOCK_SETTLEMENT: 'false',
      ENFORCE_CAPABILITIES: 'true',
      DATABASE_URL: 'postgresql://postgres.internal/sails_protocol',
      REDIS_URL: 'redis://redis.internal:6379',
      MULTISIG_NETWORK: 'testnet',
      EVIDENCE_PROVIDER: 's3',
      EVIDENCE_S3_BUCKET: 'real-evidence-bucket',
      EVIDENCE_S3_ACCESS_KEY_ID: 'real-access-key',
      EVIDENCE_S3_SECRET_ACCESS_KEY: 'real-secret-key',
      METRICS_ENABLED: 'true',
    }
    jest.resetModules()
    jest.doMock('../src/common/database', () => ({ prisma: { $queryRaw: jest.fn(), $disconnect: jest.fn() } }))
    jest.doMock('../src/common/redis', () => ({ redis: { ping: jest.fn(), quit: jest.fn() } }))
    const { buildApp } = require('../src/app')
    const app = await buildApp({ registerSwaggerUi: false })
    try {
      const metrics = await app.inject({ method: 'GET', url: '/metrics' })
      expect(metrics.statusCode).toBe(200)
      expect(metrics.body).toContain('# HELP sails_http_requests_total')
    } finally {
      await app.close()
      process.env = originalEnv
    }
  })
})
