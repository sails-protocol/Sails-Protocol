/**
 * Security headers (@fastify/helmet) — CTO_DUE_DILIGENCE_REPORT.md
 * B-SEC-04, closed 2026-08-08. Real HTTP round-trips via `app.inject()`,
 * checking the actual response headers, not that the plugin is merely
 * registered.
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

// Missão 06.5 — ENFORCE_CAPABILITIES/DATABASE_URL/REDIS_URL added
// explicitly alongside NODE_ENV=production, same reasoning as
// tests/cors.test.ts's identical comment: config/index.ts now refuses to
// boot in production with any of these left to a fallback/unset, and
// this test's outcome must not depend on a local, gitignored .env file.
const ENV_BASE = {
  MOCK_ESCROW: 'false',
  // Missão 11 Fase 8.1 LB-04/LB-01 — same reasoning as tests/cors.test.ts's
  // identical ENV_BASE addition: config/index.ts now hard-stops on these
  // two if left unset alongside MOCK_ESCROW=false/NODE_ENV=production.
  MOCK_SETTLEMENT: 'false',
  MULTISIG_NETWORK: 'testnet',
  ENFORCE_CAPABILITIES: 'true',
  DATABASE_URL: 'postgresql://postgres:password@localhost:5432/sails_protocol',
  REDIS_URL: 'redis://localhost:6379',
  // Issue #265 — same reasoning as tests/cors.test.ts's identical
  // ENV_BASE addition: config/index.ts now hard-stops in production if
  // EVIDENCE_PROVIDER is left unset/'local-fs'.
  EVIDENCE_PROVIDER: 's3',
  EVIDENCE_S3_BUCKET: 'test-evidence-bucket',
  EVIDENCE_S3_ACCESS_KEY_ID: 'test-access-key',
  EVIDENCE_S3_SECRET_ACCESS_KEY: 'test-secret-key',
  TRUSTED_ARBITRATORS: 'arbiter-1',
}

async function buildAppWithEnv(envOverrides: Record<string, string>): Promise<FastifyInstance> {
  jest.resetModules()
  const previousEnv = { ...process.env }
  Object.assign(process.env, ENV_BASE, envOverrides)
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildApp } = require('../src/app')
    // Technical Debt #57 bounded remediation — this suite exercises
    // security headers only, never /docs; registerSwaggerUi: false skips
    // Swagger-UI's real asynchronous bootstrap work without changing
    // the CSP-outside-production behavior this file actually asserts
    // (helmet's CSP config is keyed on config.isProduction, not on
    // whether swagger-ui itself is registered).
    const app = await buildApp({ registerSwaggerUi: false })
    await app.ready()
    return app
  } finally {
    process.env = previousEnv
  }
}

describe('Security headers (@fastify/helmet)', () => {
  jest.setTimeout(30_000) // defensive margin retained; this suite no longer registers @fastify/swagger-ui (Technical Debt #57 bounded remediation)

  it('always sends the baseline hardening headers (X-Frame-Options, X-Content-Type-Options, HSTS), dev or production', async () => {
    const app = await buildAppWithEnv({ NODE_ENV: 'test' })
    try {
      const res = await app.inject({ method: 'GET', url: '/health' })
      expect(res.headers['x-frame-options']).toBe('SAMEORIGIN')
      expect(res.headers['x-content-type-options']).toBe('nosniff')
      expect(res.headers['strict-transport-security']).toBeDefined()
    } finally {
      await app.close()
    }
  })

  it('does not send a CSP header outside production — /docs (swagger-ui) needs inline scripts/styles a strict CSP would block', async () => {
    const app = await buildAppWithEnv({ NODE_ENV: 'test' })
    try {
      const res = await app.inject({ method: 'GET', url: '/health' })
      expect(res.headers['content-security-policy']).toBeUndefined()
    } finally {
      await app.close()
    }
  })

  it('sends a real, restrictive CSP in production', async () => {
    const app = await buildAppWithEnv({ NODE_ENV: 'production', CORS_ALLOWED_ORIGINS: 'https://sails.app' })
    try {
      const res = await app.inject({ method: 'GET', url: '/health' })
      expect(res.headers['content-security-policy']).toMatch(/default-src 'none'/)
    } finally {
      await app.close()
    }
  })
})
