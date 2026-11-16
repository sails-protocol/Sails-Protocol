/**
 * CORS — CTO_DUE_DILIGENCE_REPORT.md B-SEC-01, closed 2026-08-08.
 * `origin: true` (reflect any Origin header) was a real, live gap: any
 * site could call this API using a logged-in user's own credentials.
 * Real HTTP round-trips via `app.inject()` (not a config-shape assertion)
 * against three real scenarios: permissive dev default, an allowlisted
 * production origin, and production with no allowlist configured (must
 * deny by default, not fail open).
 *
 * Each scenario needs its own `config` module instance — `isProduction`/
 * `cors.allowedOrigins` are computed once at import time from env vars —
 * so this file uses `jest.resetModules()` + a fresh `require('../src/app')`
 * per scenario, same env-vars-before-import discipline
 * tests/rateLimit.test.ts already establishes for its own config values.
 */
import type { FastifyInstance } from 'fastify'

jest.mock('../src/common/database', () => ({
  prisma: {
    user: { findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
  },
}))

jest.mock('../src/common/redis', () => ({
  redis: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    ping: jest.fn().mockResolvedValue('PONG'),
  },
}))

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

const ENV_BASE = {
  MOCK_ESCROW: 'false', // required alongside NODE_ENV=production — RT-001 refuses to boot otherwise
  // Missão 11 Fase 8.1 LB-04 — required alongside MOCK_ESCROW=false in
  // production for the same reason RT-001 exists: config/index.ts now
  // hard-stops (not just warns) if MOCK_SETTLEMENT is left at its
  // default-true while MOCK_ESCROW=false.
  MOCK_SETTLEMENT: 'false',
  // Missão 06.5 — required alongside NODE_ENV=production for the same
  // reason: config/index.ts now refuses to boot in production with
  // ENFORCE_CAPABILITIES unset, and no fallback for DATABASE_URL/REDIS_URL.
  // Explicit here so this test's outcome never depends on whatever a
  // local, gitignored .env file happens to already have in process.env —
  // CI (and any fresh checkout) has none of that.
  ENFORCE_CAPABILITIES: 'true',
  DATABASE_URL: 'postgresql://postgres:password@localhost:5432/sails_protocol',
  REDIS_URL: 'redis://localhost:6379',
  TRUSTED_ARBITRATORS: 'arbiter-1',
  // Missão 11 Fase 8.1 LB-01 — required alongside NODE_ENV=production:
  // config/index.ts now refuses to boot in production with
  // MULTISIG_NETWORK unset (same no-silent-fallback posture as the vars
  // above).
  MULTISIG_NETWORK: 'testnet',
  // Issue #265 — required alongside NODE_ENV=production: config/index.ts
  // now refuses to boot in production with EVIDENCE_PROVIDER unset/
  // 'local-fs' (same no-silent-fallback posture as the vars above).
  EVIDENCE_PROVIDER: 's3',
  EVIDENCE_S3_BUCKET: 'test-evidence-bucket',
  EVIDENCE_S3_ACCESS_KEY_ID: 'test-access-key',
  EVIDENCE_S3_SECRET_ACCESS_KEY: 'test-secret-key',
}

async function buildAppWithEnv(envOverrides: Record<string, string>): Promise<FastifyInstance> {
  jest.resetModules()
  const previousEnv = { ...process.env }
  Object.assign(process.env, ENV_BASE, envOverrides)
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildApp } = require('../src/app')
    // Technical Debt #57 bounded remediation — this suite exercises CORS
    // headers only, never /docs; registerSwaggerUi: false skips
    // Swagger-UI's real asynchronous bootstrap work (fs.readFile +
    // require()) without changing any behavior this suite actually
    // asserts on.
    const app = await buildApp({ registerSwaggerUi: false })
    await app.ready()
    return app
  } finally {
    process.env = previousEnv
  }
}

describe('CORS (@fastify/cors)', () => {
  // Each test builds a real, fresh app (fresh module registry — see
  // buildAppWithEnv()'s own comment on why) via a real buildApp() call,
  // which registers @fastify/swagger-ui — real, non-trivial async plugin
  // registration, slower than the default 5s Jest timeout under load
  // (the same registration this repo's tests/routes.test.ts's own
  // beforeAll has been observed taking longer than expected when the
  // system is busy).
  jest.setTimeout(30_000)

  it('dev/test default (NODE_ENV != production): permissive — reflects any Origin', async () => {
    const app = await buildAppWithEnv({ NODE_ENV: 'test' })
    try {
      const res = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'https://totally-unrelated-site.example' } })
      expect(res.headers['access-control-allow-origin']).toBe('https://totally-unrelated-site.example')
    } finally {
      await app.close()
    }
  })

  it('production with CORS_ALLOWED_ORIGINS set: allows a listed origin', async () => {
    const app = await buildAppWithEnv({ NODE_ENV: 'production', CORS_ALLOWED_ORIGINS: 'https://sails.app,https://staging.sails.app' })
    try {
      const res = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'https://sails.app' } })
      expect(res.headers['access-control-allow-origin']).toBe('https://sails.app')
    } finally {
      await app.close()
    }
  })

  it('production with CORS_ALLOWED_ORIGINS set: denies an origin NOT on the list', async () => {
    const app = await buildAppWithEnv({ NODE_ENV: 'production', CORS_ALLOWED_ORIGINS: 'https://sails.app' })
    try {
      const res = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'https://evil.example' } })
      expect(res.headers['access-control-allow-origin']).toBeUndefined()
    } finally {
      await app.close()
    }
  })

  it('production with NO CORS_ALLOWED_ORIGINS configured: fails closed — denies every origin, not fail-open', async () => {
    const app = await buildAppWithEnv({ NODE_ENV: 'production', CORS_ALLOWED_ORIGINS: '' })
    try {
      const res = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'https://anything.example' } })
      expect(res.headers['access-control-allow-origin']).toBeUndefined()
    } finally {
      await app.close()
    }
  })
})
