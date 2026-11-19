/**
 * config/index.ts — production boot gates (Missão 06.5).
 *
 * Real behavioral tests: each scenario re-requires the actual config
 * module fresh (jest.resetModules() + require('../src/config')), the
 * same env-vars-before-import discipline tests/cors.test.ts/
 * tests/rateLimit.test.ts already establish, since these guards run as
 * real top-level code at module load time — a config-shape assertion
 * would prove nothing about whether the module actually throws.
 *
 * dotenv/config is mocked out entirely so these tests never depend on
 * whatever a local, gitignored .env file happens to contain — a real
 * risk found while writing this file: this repo's own .env already sets
 * ENFORCE_CAPABILITIES=false, which would have silently masked the
 * exact "unset in production" scenario Fase 2's guard exists to catch.
 * CI (and any fresh checkout) has no .env at all, so a test that passed
 * only because of a local .env would be a false negative waiting to
 * happen the first time this ran somewhere else.
 *
 * Covers the pre-existing MOCK_ESCROW guard (RT-001) too — found during
 * Fase 1's audit to have zero test coverage before this file, despite
 * being the exact pattern the two new gates below deliberately mirror.
 */
jest.mock('dotenv/config', () => ({}))

const REQUIRED_PROD_ENV = {
  NODE_ENV: 'production',
  MOCK_ESCROW: 'false',
  // Missão 11 Fase 8.1 LB-04 — MOCK_SETTLEMENT now has the same hard-stop
  // MOCK_ESCROW already had; every production-boot test in this file must
  // satisfy it explicitly or it would trip the new gate below.
  MOCK_SETTLEMENT: 'false',
  ENFORCE_CAPABILITIES: 'true',
  DATABASE_URL: 'postgresql://real-host/sails_protocol',
  REDIS_URL: 'redis://real-host:6379',
  // Missão 11 Fase 8.1 LB-01 — MULTISIG_NETWORK now required in
  // production (same required-in-prod/defaulted-in-dev shape as
  // DATABASE_URL/REDIS_URL above); 'testnet' keeps the default
  // MULTISIG_EXPLORER_API_URL non-contradictory for every test in this
  // file that doesn't specifically exercise the network gate below.
  MULTISIG_NETWORK: 'testnet',
  // Issue #265 — EVIDENCE_PROVIDER now required in production (same
  // required-in-prod/defaulted-in-dev shape as DATABASE_URL/REDIS_URL
  // above); every test in this file that boots a full production
  // configuration but isn't specifically exercising the evidence-storage
  // gate below must satisfy it explicitly.
  EVIDENCE_PROVIDER: 's3',
  EVIDENCE_S3_BUCKET: 'real-evidence-bucket',
  EVIDENCE_S3_ACCESS_KEY_ID: 'real-access-key',
  EVIDENCE_S3_SECRET_ACCESS_KEY: 'real-secret-key',
}

describe('config/index.ts — production boot gates (Missão 06.5)', () => {
  const ORIGINAL_ENV = process.env

  beforeEach(() => {
    jest.resetModules()
    process.env = {}
  })

  afterAll(() => {
    process.env = ORIGINAL_ENV
  })

  function loadConfig(env: Record<string, string | undefined>) {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    return () => require('../src/config').config
  }

  describe('MOCK_ESCROW (RT-001, pre-existing — newly covered here)', () => {
    it('refuses to boot in production when MOCK_ESCROW is unset', () => {
      const load = loadConfig({ ...REQUIRED_PROD_ENV, MOCK_ESCROW: undefined })
      expect(load).toThrow(/MOCK_ESCROW/)
    })

    it('refuses to boot in production when MOCK_ESCROW=true', () => {
      const load = loadConfig({ ...REQUIRED_PROD_ENV, MOCK_ESCROW: 'true' })
      expect(load).toThrow(/MOCK_ESCROW/)
    })

    it('boots in production when MOCK_ESCROW=false explicitly', () => {
      const load = loadConfig(REQUIRED_PROD_ENV)
      expect(load).not.toThrow()
    })

    it('boots in development regardless of MOCK_ESCROW', () => {
      const load = loadConfig({ NODE_ENV: 'development', DATABASE_URL: undefined, REDIS_URL: undefined, ENFORCE_CAPABILITIES: undefined, MOCK_ESCROW: undefined })
      expect(load).not.toThrow()
    })
  })

  // Issue #303 - supersedes Missao 06.5's "explicitly set, true or false"
  // rule: production requires exactly 'true'.
  describe('ENFORCE_CAPABILITIES gate (Issue #303 - production requires exactly true)', () => {
    it('refuses to boot in production when ENFORCE_CAPABILITIES is unset', () => {
      const load = loadConfig({ ...REQUIRED_PROD_ENV, ENFORCE_CAPABILITIES: undefined })
      expect(load).toThrow(/requires ENFORCE_CAPABILITIES=true \(got unset\)/)
    })

    it('refuses to boot in production when ENFORCE_CAPABILITIES=false', () => {
      const load = loadConfig({ ...REQUIRED_PROD_ENV, ENFORCE_CAPABILITIES: 'false' })
      expect(load).toThrow(/requires ENFORCE_CAPABILITIES=true \(got 'false'\)/)
    })

    it.each(['TRUE', '1', 'yes', ''])('refuses to boot in production for the non-exact value %p', (value) => {
      const load = loadConfig({ ...REQUIRED_PROD_ENV, ENFORCE_CAPABILITIES: value })
      expect(load).toThrow(/requires ENFORCE_CAPABILITIES=true/)
    })

    it('boots in production when ENFORCE_CAPABILITIES=true explicitly', () => {
      const load = loadConfig({ ...REQUIRED_PROD_ENV, ENFORCE_CAPABILITIES: 'true' })
      expect(load).not.toThrow()
      expect(load().features.enforceCapabilities).toBe(true)
    })

    it('still boots in development with enforcement disabled explicitly', () => {
      const load = loadConfig({ NODE_ENV: 'development', DATABASE_URL: undefined, REDIS_URL: undefined, ENFORCE_CAPABILITIES: 'false', MOCK_ESCROW: undefined })
      expect(load).not.toThrow()
      expect(load().features.enforceCapabilities).toBe(false)
    })

    it('boots in development with ENFORCE_CAPABILITIES unset — preserves today\'s dev/test ergonomics', () => {
      const load = loadConfig({ NODE_ENV: 'development', DATABASE_URL: undefined, REDIS_URL: undefined, ENFORCE_CAPABILITIES: undefined, MOCK_ESCROW: undefined })
      expect(load).not.toThrow()
      expect(load().features.enforceCapabilities).toBe(false)
    })

    it('boots in test (NODE_ENV=test, Jest\'s own default) with ENFORCE_CAPABILITIES unset', () => {
      const load = loadConfig({ NODE_ENV: 'test', DATABASE_URL: undefined, REDIS_URL: undefined, ENFORCE_CAPABILITIES: undefined, MOCK_ESCROW: undefined })
      expect(load).not.toThrow()
    })
  })

  describe('DATABASE_URL gate (Missão 06.5)', () => {
    it('refuses to boot in production when DATABASE_URL is unset — no silent localhost fallback', () => {
      const load = loadConfig({ ...REQUIRED_PROD_ENV, DATABASE_URL: undefined })
      expect(load).toThrow(/DATABASE_URL/)
    })

    it('boots in production when DATABASE_URL is explicitly set to a real host', () => {
      const load = loadConfig(REQUIRED_PROD_ENV)
      expect(load).not.toThrow()
      expect(load().database.url).toBe('postgresql://real-host/sails_protocol')
    })

    it('an explicit production DATABASE_URL pointing at localhost is still accepted — the gate blocks the silent FALLBACK, not a deliberate operator choice', () => {
      const load = loadConfig({ ...REQUIRED_PROD_ENV, DATABASE_URL: 'postgresql://postgres:password@localhost:5432/sails_protocol' })
      expect(load).not.toThrow()
    })

    it('development preserves the localhost/default-credential fallback when DATABASE_URL is unset', () => {
      const load = loadConfig({ NODE_ENV: 'development', DATABASE_URL: undefined, REDIS_URL: undefined, ENFORCE_CAPABILITIES: undefined, MOCK_ESCROW: undefined })
      expect(load).not.toThrow()
      expect(load().database.url).toBe('postgresql://postgres:password@localhost:5432/sails_protocol')
    })
  })

  describe('REDIS_URL gate (Missão 06.5 — same fallback pattern found alongside DATABASE_URL)', () => {
    it('refuses to boot in production when REDIS_URL is unset', () => {
      const load = loadConfig({ ...REQUIRED_PROD_ENV, REDIS_URL: undefined })
      expect(load).toThrow(/REDIS_URL/)
    })

    it('boots in production when REDIS_URL is explicitly set', () => {
      const load = loadConfig(REQUIRED_PROD_ENV)
      expect(load).not.toThrow()
      expect(load().redis.url).toBe('redis://real-host:6379')
    })

    it('development preserves the localhost fallback when REDIS_URL is unset', () => {
      const load = loadConfig({ NODE_ENV: 'development', DATABASE_URL: undefined, REDIS_URL: undefined, ENFORCE_CAPABILITIES: undefined, MOCK_ESCROW: undefined })
      expect(load).not.toThrow()
      expect(load().redis.url).toBe('redis://localhost:6379')
    })
  })

  describe('NODE_ENV (Missão 11 Fase 8.1 LB-03) — unrecognized values must throw, never silently fall through to the permissive posture', () => {
    it('boots in development when NODE_ENV is unset — preserves the implicit default', () => {
      const load = loadConfig({ NODE_ENV: undefined, DATABASE_URL: undefined, REDIS_URL: undefined, ENFORCE_CAPABILITIES: undefined, MOCK_ESCROW: undefined, MOCK_SETTLEMENT: undefined, MULTISIG_NETWORK: undefined })
      expect(load).not.toThrow()
      expect(load().env).toBe('development')
      expect(load().isProduction).toBe(false)
    })

    it("boots on NODE_ENV='test' (Jest's own default)", () => {
      const load = loadConfig({ NODE_ENV: 'test', DATABASE_URL: undefined, REDIS_URL: undefined, ENFORCE_CAPABILITIES: undefined, MOCK_ESCROW: undefined, MOCK_SETTLEMENT: undefined, MULTISIG_NETWORK: undefined })
      expect(load).not.toThrow()
      expect(load().env).toBe('test')
      expect(load().isProduction).toBe(false)
    })

    it('boots on NODE_ENV=production with every other gate satisfied', () => {
      const load = loadConfig(REQUIRED_PROD_ENV)
      expect(load).not.toThrow()
      expect(load().env).toBe('production')
      expect(load().isProduction).toBe(true)
    })

    it("refuses to boot on a capitalization typo ('Production') — this is the exact failure mode LB-03 exists to close: it must NOT silently boot as non-production", () => {
      const load = loadConfig({ ...REQUIRED_PROD_ENV, NODE_ENV: 'Production' })
      expect(load).toThrow(/NODE_ENV/)
    })

    it("refuses to boot on a shortened/common typo ('prod')", () => {
      const load = loadConfig({ ...REQUIRED_PROD_ENV, NODE_ENV: 'prod' })
      expect(load).toThrow(/NODE_ENV/)
    })

    it('refuses to boot on an entirely unrecognized environment name (e.g. staging) — not part of this codebase\'s accepted set', () => {
      const load = loadConfig({ ...REQUIRED_PROD_ENV, NODE_ENV: 'staging' })
      expect(load).toThrow(/NODE_ENV/)
    })

    it('refuses to boot on a trailing-whitespace value — not silently trimmed and accepted', () => {
      const load = loadConfig({ ...REQUIRED_PROD_ENV, NODE_ENV: 'production ' })
      expect(load).toThrow(/NODE_ENV/)
    })
  })

  describe('MULTISIG_NETWORK (Missão 11 Fase 8.1 LB-01/LB-07) — unknown values must throw, never fall back to any network', () => {
    it('refuses to boot in production when MULTISIG_NETWORK is unset', () => {
      const load = loadConfig({ ...REQUIRED_PROD_ENV, MULTISIG_NETWORK: undefined })
      expect(load).toThrow(/MULTISIG_NETWORK/)
    })

    it('refuses to boot (any environment) on an unset-but-explicit empty string', () => {
      const load = loadConfig({ ...REQUIRED_PROD_ENV, MULTISIG_NETWORK: '' })
      expect(load).toThrow(/Bitcoin network is not configured/)
    })

    it('refuses to boot on a typo — never silently falls back to testnet', () => {
      const load = loadConfig({ ...REQUIRED_PROD_ENV, MULTISIG_NETWORK: 'main' })
      expect(load).toThrow(/Unrecognized Bitcoin network/)
    })

    it('refuses to boot on wrong casing — case-sensitive by design', () => {
      const load = loadConfig({ ...REQUIRED_PROD_ENV, MULTISIG_NETWORK: 'MAINNET' })
      expect(load).toThrow(/Unrecognized Bitcoin network/)
    })

    it('refuses to boot on "livenet" or any other unrecognized synonym', () => {
      const load = loadConfig({ ...REQUIRED_PROD_ENV, MULTISIG_NETWORK: 'livenet' })
      expect(load).toThrow(/Unrecognized Bitcoin network/)
    })

    it("accepts 'bitcoin' as a documented alias for mainnet — requires a matching (non-testnet-looking) explorer URL and an explicit confirmation depth (LB-02)", () => {
      const load = loadConfig({ ...REQUIRED_PROD_ENV, MULTISIG_NETWORK: 'bitcoin', MULTISIG_EXPLORER_API_URL: 'https://mempool.space/api', MULTISIG_FUNDING_REQUIRED_CONFIRMATIONS: '3' })
      expect(load).not.toThrow()
      expect(load().multisig.network).toBe('mainnet')
    })

    it("accepts 'mainnet' literally — requires a matching explorer URL and an explicit confirmation depth (LB-02)", () => {
      const load = loadConfig({ ...REQUIRED_PROD_ENV, MULTISIG_NETWORK: 'mainnet', MULTISIG_EXPLORER_API_URL: 'https://mempool.space/api', MULTISIG_FUNDING_REQUIRED_CONFIRMATIONS: '3' })
      expect(load).not.toThrow()
      expect(load().multisig.network).toBe('mainnet')
    })

    it("accepts 'testnet' explicitly in production — a deliberate operator choice to stage on testnet is not itself unsafe", () => {
      const load = loadConfig({ ...REQUIRED_PROD_ENV, MULTISIG_NETWORK: 'testnet' })
      expect(load).not.toThrow()
      expect(load().multisig.network).toBe('testnet')
    })

    it("accepts 'regtest' explicitly", () => {
      const load = loadConfig({ ...REQUIRED_PROD_ENV, MULTISIG_NETWORK: 'regtest' })
      expect(load).not.toThrow()
      expect(load().multisig.network).toBe('regtest')
    })

    it('boots in development with MULTISIG_NETWORK unset — defaults to testnet, preserving existing dev/CI ergonomics', () => {
      const load = loadConfig({ NODE_ENV: 'development', DATABASE_URL: undefined, REDIS_URL: undefined, ENFORCE_CAPABILITIES: undefined, MOCK_ESCROW: undefined, MOCK_SETTLEMENT: undefined, MULTISIG_NETWORK: undefined })
      expect(load).not.toThrow()
      expect(load().multisig.network).toBe('testnet')
    })

    it('refuses to boot on a typo even in development — a wrong value is a bug regardless of environment', () => {
      const load = loadConfig({ NODE_ENV: 'development', DATABASE_URL: undefined, REDIS_URL: undefined, ENFORCE_CAPABILITIES: undefined, MOCK_ESCROW: undefined, MOCK_SETTLEMENT: undefined, MULTISIG_NETWORK: 'Mainnet' })
      expect(load).toThrow(/Unrecognized Bitcoin network/)
    })

    it('refuses to boot when MULTISIG_NETWORK=mainnet but MULTISIG_EXPLORER_API_URL still looks testnet-pointed — the concrete Fase 8.0 misconfiguration', () => {
      const load = loadConfig({ ...REQUIRED_PROD_ENV, MULTISIG_NETWORK: 'mainnet', MULTISIG_FUNDING_REQUIRED_CONFIRMATIONS: '3' /* MULTISIG_EXPLORER_API_URL left at its testnet default */ })
      expect(load).toThrow(/MULTISIG_EXPLORER_API_URL.*testnet explorer endpoint/)
    })

    it('boots when MULTISIG_NETWORK=mainnet and MULTISIG_EXPLORER_API_URL is correctly pointed at a real mainnet explorer', () => {
      const load = loadConfig({ ...REQUIRED_PROD_ENV, MULTISIG_NETWORK: 'mainnet', MULTISIG_EXPLORER_API_URL: 'https://mempool.space/api', MULTISIG_FUNDING_REQUIRED_CONFIRMATIONS: '3' })
      expect(load).not.toThrow()
    })
  })

  describe('MULTISIG_FUNDING_REQUIRED_CONFIRMATIONS (Missão 11 Fase 8.1 LB-02)', () => {
    it('refuses to boot when MULTISIG_NETWORK=mainnet and MULTISIG_FUNDING_REQUIRED_CONFIRMATIONS is unset', () => {
      const load = loadConfig({ ...REQUIRED_PROD_ENV, MULTISIG_NETWORK: 'mainnet', MULTISIG_EXPLORER_API_URL: 'https://mempool.space/api' })
      expect(load).toThrow(/MULTISIG_FUNDING_REQUIRED_CONFIRMATIONS/)
    })

    it('refuses to boot on a non-integer value', () => {
      const load = loadConfig({ ...REQUIRED_PROD_ENV, MULTISIG_FUNDING_REQUIRED_CONFIRMATIONS: 'three' })
      expect(load).toThrow(/must be a positive integer/)
    })

    it('refuses to boot on zero — zero confirmations is exactly the unsafe default this closes', () => {
      const load = loadConfig({ ...REQUIRED_PROD_ENV, MULTISIG_FUNDING_REQUIRED_CONFIRMATIONS: '0' })
      expect(load).toThrow(/must be a positive integer/)
    })

    it('boots on testnet with the value unset — defaults to 1, preserving today\'s existing dev/CI behavior', () => {
      const load = loadConfig({ NODE_ENV: 'development', DATABASE_URL: undefined, REDIS_URL: undefined, ENFORCE_CAPABILITIES: undefined, MOCK_ESCROW: undefined, MOCK_SETTLEMENT: undefined, MULTISIG_NETWORK: undefined, MULTISIG_FUNDING_REQUIRED_CONFIRMATIONS: undefined })
      expect(load).not.toThrow()
      expect(load().multisig.requiredConfirmations).toBe(1)
    })

    it('boots in production with an explicit value on mainnet', () => {
      const load = loadConfig({ ...REQUIRED_PROD_ENV, MULTISIG_NETWORK: 'mainnet', MULTISIG_EXPLORER_API_URL: 'https://mempool.space/api', MULTISIG_FUNDING_REQUIRED_CONFIRMATIONS: '6' })
      expect(load).not.toThrow()
      expect(load().multisig.requiredConfirmations).toBe(6)
    })
  })

  describe('MOCK_SETTLEMENT (Missão 11 Fase 8.1 LB-04) — same hard-stop seriousness as MOCK_ESCROW, no warning-only path', () => {
    it('refuses to boot in production when MOCK_ESCROW=false and MOCK_SETTLEMENT is unset (defaults true) — real funds would lock with settlement a no-op', () => {
      const load = loadConfig({ ...REQUIRED_PROD_ENV, MOCK_SETTLEMENT: undefined })
      expect(load).toThrow(/MOCK_SETTLEMENT/)
    })

    it('refuses to boot in production when MOCK_ESCROW=false and MOCK_SETTLEMENT=true explicitly', () => {
      const load = loadConfig({ ...REQUIRED_PROD_ENV, MOCK_SETTLEMENT: 'true' })
      expect(load).toThrow(/MOCK_SETTLEMENT/)
    })

    it('boots in production when MOCK_ESCROW=false and MOCK_SETTLEMENT=false — a real, consistent settlement configuration', () => {
      const load = loadConfig(REQUIRED_PROD_ENV)
      expect(load).not.toThrow()
    })

    it('boots in production when both MOCK_ESCROW=true and MOCK_SETTLEMENT=true — fully mock, internally consistent (blocked by RT-001 anyway, but not by this gate)', () => {
      const load = loadConfig({ ...REQUIRED_PROD_ENV, MOCK_ESCROW: 'true', MOCK_SETTLEMENT: 'true' })
      expect(load).toThrow(/MOCK_ESCROW/) // RT-001 fires first — confirms this gate doesn't mask it, not that this gate itself fired
    })

    it('boots in development regardless of MOCK_SETTLEMENT', () => {
      const load = loadConfig({ NODE_ENV: 'development', DATABASE_URL: undefined, REDIS_URL: undefined, ENFORCE_CAPABILITIES: undefined, MOCK_ESCROW: 'false', MOCK_SETTLEMENT: 'true', MULTISIG_NETWORK: undefined })
      expect(load).not.toThrow()
    })
  })

  describe('WDK_SEED_PHRASE production-ineligibility gate (Missão 11 Fase 9.1.1 §4, CTO decision)', () => {
    it('refuses to boot in production when MOCK_ESCROW=false and a real WDK_SEED_PHRASE is configured', () => {
      const load = loadConfig({ ...REQUIRED_PROD_ENV, WDK_SEED_PHRASE: 'test only example nut use this real life secret phrase must random' })
      expect(load).toThrow(/WDK_SEED_PHRASE/)
      expect(load).toThrow(/production-ineligible/)
    })

    it('boots in production when MOCK_ESCROW=false and WDK_SEED_PHRASE is unset (empty by default)', () => {
      const load = loadConfig({ ...REQUIRED_PROD_ENV, WDK_SEED_PHRASE: undefined })
      expect(load).not.toThrow()
    })

    it('boots in production when WDK_SEED_PHRASE is set but MOCK_ESCROW=true — the provider is not reachable either way', () => {
      const load = loadConfig({ ...REQUIRED_PROD_ENV, MOCK_ESCROW: 'true', MOCK_SETTLEMENT: 'true', WDK_SEED_PHRASE: 'some seed phrase' })
      expect(load).toThrow(/MOCK_ESCROW/) // RT-001 fires first — confirms this gate doesn't mask it, not that this gate itself fired
    })

    it('boots in development with MOCK_ESCROW=false and a real WDK_SEED_PHRASE — the real testnet rehearsal path (npm run demo:pix-to-usdt) is unaffected', () => {
      const load = loadConfig({ NODE_ENV: 'development', DATABASE_URL: undefined, REDIS_URL: undefined, ENFORCE_CAPABILITIES: undefined, MOCK_ESCROW: 'false', MOCK_SETTLEMENT: 'false', MULTISIG_NETWORK: undefined, WDK_SEED_PHRASE: 'test only example nut use this real life secret phrase must random' })
      expect(load).not.toThrow()
    })
  })

  describe('EVIDENCE_PROVIDER gate (Issue #265) — production must not silently fall back to local filesystem', () => {
    it('refuses to boot in production when EVIDENCE_PROVIDER is unset (defaults local-fs)', () => {
      const load = loadConfig({ ...REQUIRED_PROD_ENV, EVIDENCE_PROVIDER: undefined })
      expect(load).toThrow(/EVIDENCE_PROVIDER/)
      expect(load).toThrow(/dev\/reference implementation only/)
    })

    it('refuses to boot in production when EVIDENCE_PROVIDER=local-fs explicitly', () => {
      const load = loadConfig({ ...REQUIRED_PROD_ENV, EVIDENCE_PROVIDER: 'local-fs' })
      expect(load).toThrow(/EVIDENCE_PROVIDER/)
    })

    it('refuses to boot in production when EVIDENCE_PROVIDER=s3 but EVIDENCE_S3_BUCKET is unset — a partially wired production provider is not acceptable', () => {
      const load = loadConfig({ ...REQUIRED_PROD_ENV, EVIDENCE_S3_BUCKET: undefined })
      expect(load).toThrow(/EVIDENCE_S3_BUCKET/)
    })

    it('refuses to boot in production when EVIDENCE_PROVIDER=s3 but EVIDENCE_S3_ACCESS_KEY_ID is unset', () => {
      const load = loadConfig({ ...REQUIRED_PROD_ENV, EVIDENCE_S3_ACCESS_KEY_ID: undefined })
      expect(load).toThrow(/EVIDENCE_S3_ACCESS_KEY_ID/)
    })

    it('refuses to boot in production when EVIDENCE_PROVIDER=s3 but EVIDENCE_S3_SECRET_ACCESS_KEY is unset', () => {
      const load = loadConfig({ ...REQUIRED_PROD_ENV, EVIDENCE_S3_SECRET_ACCESS_KEY: undefined })
      expect(load).toThrow(/EVIDENCE_S3_SECRET_ACCESS_KEY/)
    })

    it('boots in production when EVIDENCE_PROVIDER=s3 and every EVIDENCE_S3_* field is configured', () => {
      const load = loadConfig(REQUIRED_PROD_ENV)
      expect(load).not.toThrow()
      expect(load().proof.evidenceProviderType).toBe('s3')
      expect(load().proof.evidenceS3.bucket).toBe('real-evidence-bucket')
    })

    it('boots in development with EVIDENCE_PROVIDER unset — local-fs remains a legitimate dev/reference default', () => {
      const load = loadConfig({ NODE_ENV: 'development', DATABASE_URL: undefined, REDIS_URL: undefined, ENFORCE_CAPABILITIES: undefined, MOCK_ESCROW: undefined, MOCK_SETTLEMENT: undefined, MULTISIG_NETWORK: undefined, EVIDENCE_PROVIDER: undefined })
      expect(load).not.toThrow()
      expect(load().proof.evidenceProviderType).toBe('local-fs')
    })

    // CTO DELTA (Invalid Provider Regression Pin) — an independent
    // micro-verification confirmed current runtime behavior is already
    // fail-closed (resolveEvidenceProviderType() validates against a
    // recognized allowlist BEFORE the 'local-fs' | 's3' cast is ever
    // applied — config/index.ts's own RECOGNIZED_EVIDENCE_PROVIDER_TYPES),
    // but found no test explicitly PINS it. These tests exist so that
    // reintroducing the former unsafe pattern — an unchecked cast plus an
    // `else`/default branch quietly resolving to 'local-fs' — fails the
    // suite immediately, rather than only failing if someone happens to
    // also delete this comment. Not a redesign: no new runtime behavior,
    // no normalization added — 'S3' stays rejected exactly like 's33'.
    describe('invalid/unrecognized EVIDENCE_PROVIDER values are rejected during config resolution, never silently normalized to local-fs', () => {
      it("rejects 's33' (a plausible typo of a valid value) outside production — resolution itself throws, not a production-only gate", () => {
        const load = loadConfig({ NODE_ENV: 'development', DATABASE_URL: undefined, REDIS_URL: undefined, ENFORCE_CAPABILITIES: undefined, MOCK_ESCROW: undefined, MOCK_SETTLEMENT: undefined, MULTISIG_NETWORK: undefined, EVIDENCE_PROVIDER: 's33' })
        expect(load).toThrow(/EVIDENCE_PROVIDER is set to an unrecognized value 's33'/)
      })

      it("rejects 'S3' (wrong case) — never case-folded or normalized to the valid 's3'", () => {
        const load = loadConfig({ NODE_ENV: 'development', DATABASE_URL: undefined, REDIS_URL: undefined, ENFORCE_CAPABILITIES: undefined, MOCK_ESCROW: undefined, MOCK_SETTLEMENT: undefined, MULTISIG_NETWORK: undefined, EVIDENCE_PROVIDER: 'S3' })
        expect(load).toThrow(/EVIDENCE_PROVIDER is set to an unrecognized value 'S3'/)
      })

      it("rejects an unrecognized value even in production with fully valid EVIDENCE_S3_* configuration present — proves rejection happens at resolution, one gate BEFORE the S3-completeness check could otherwise mask it", () => {
        const load = loadConfig({ ...REQUIRED_PROD_ENV, EVIDENCE_PROVIDER: 's33' })
        expect(load).toThrow(/EVIDENCE_PROVIDER is set to an unrecognized value 's33'/)
        // If this ever regressed to "unchecked cast + else -> local-fs",
        // the failure would instead surface (if at all) as a missing-S3-
        // config error, or no error at all outside production. Asserting
        // the ACTUAL thrown message is what's being tested here.
        expect(load).not.toThrow(/EVIDENCE_S3_BUCKET/)
      })

      it("accepts 's3' (the real, exact, lowercase value) and resolves it to itself — the positive control for the case-sensitivity tests above", () => {
        const load = loadConfig({ NODE_ENV: 'development', DATABASE_URL: undefined, REDIS_URL: undefined, ENFORCE_CAPABILITIES: undefined, MOCK_ESCROW: undefined, MOCK_SETTLEMENT: undefined, MULTISIG_NETWORK: undefined, EVIDENCE_PROVIDER: 's3' })
        expect(load).not.toThrow()
        expect(load().proof.evidenceProviderType).toBe('s3')
      })

      it("accepts 'local-fs' (the real, exact value) outside production and resolves it to itself — never coerced into anything else", () => {
        const load = loadConfig({ NODE_ENV: 'development', DATABASE_URL: undefined, REDIS_URL: undefined, ENFORCE_CAPABILITIES: undefined, MOCK_ESCROW: undefined, MOCK_SETTLEMENT: undefined, MULTISIG_NETWORK: undefined, EVIDENCE_PROVIDER: 'local-fs' })
        expect(load).not.toThrow()
        expect(load().proof.evidenceProviderType).toBe('local-fs')
      })
    })
  })

  describe('DISPUTE_AUTO_RESOLUTION_SWEEP_INTERVAL_MS (#311 item 3 — positive integer)', () => {
    const dev = { NODE_ENV: 'development', DATABASE_URL: undefined, REDIS_URL: undefined, ENFORCE_CAPABILITIES: undefined, MOCK_ESCROW: undefined, MOCK_SETTLEMENT: undefined, MULTISIG_NETWORK: undefined }
    const K = 'DISPUTE_AUTO_RESOLUTION_SWEEP_INTERVAL_MS'

    it.each(['1.5', '100abc', '0', '-1', 'abc', '', ' 5', '5 ', '+5', '1e3', '0x10', '007', ' 300', '300 ', '2147483648', '3000000000', '9007199254740993', '99999999999999999999'])('refuses %p', (v) => {
      expect(loadConfig({ ...dev, [K]: v })).toThrow(new RegExp(K))
    })

    it('accepts strict positive integers and defaults to 300000', () => {
      expect(loadConfig({ ...dev, [K]: '1000' })().trade.disputeAutoResolutionSweepIntervalMs).toBe(1000)
      jest.resetModules()
      expect(loadConfig({ ...dev, [K]: '300000' })().trade.disputeAutoResolutionSweepIntervalMs).toBe(300000)
      jest.resetModules()
      expect(loadConfig({ ...dev, [K]: '1' })().trade.disputeAutoResolutionSweepIntervalMs).toBe(1)
      jest.resetModules()
      expect(loadConfig({ ...dev, [K]: '2147483647' })().trade.disputeAutoResolutionSweepIntervalMs).toBe(2147483647)
      jest.resetModules()
      expect(loadConfig({ ...dev, [K]: undefined })().trade.disputeAutoResolutionSweepIntervalMs).toBe(300000)
    })

    it('.env.example and the config no longer claim that QVAC applies the recommendation', () => {
      const fs = require('fs')
      const text = ['.env.example', 'src/config/index.ts'].map((f) => fs.readFileSync(require('path').join(__dirname, '..', f), 'utf8')).join(' ')
      expect(text).not.toMatch(/Applies every AUTO_PROPOSED/)
      expect(text).not.toMatch(/recommendation only applies once/)
      expect(text).not.toMatch(/sweepExpiredAutoResolutions\(\) applies it/)
      expect(text).toMatch(/advisory-only/)
    })
  })

  // CTO 420 phase 2 - class A (direct timers): the six sweep/reconcile intervals feed setInterval in app.ts and the two request timeouts feed
  // setTimeout(abort) in bounded-rpc.ts. Node turns a delay of 0, a negative one or one above 2147483647 into ~1 ms, so an interval fires in a
  // tight loop and a timeout aborts every call at once. requiredStrictPositiveInt() (#688) refuses all of that at boot. Defaults are unchanged.
  describe('class A timer variables (CTO 420 phase 2) - strict positive integer <= 2147483647', () => {
    const dev = { NODE_ENV: 'development', DATABASE_URL: undefined, REDIS_URL: undefined, ENFORCE_CAPABILITIES: undefined, MOCK_ESCROW: undefined, MOCK_SETTLEMENT: undefined, MULTISIG_NETWORK: undefined }
    const TIMERS: Array<[string, string, string, number]> = [
      ['ESCROW_TIMELOCK_SWEEP_INTERVAL_MS', 'trade', 'timelockSweepIntervalMs', 300000],
      ['ESCROW_SETTLEMENT_RECONCILE_INTERVAL_MS', 'trade', 'settlementReconcileIntervalMs', 60000],
      ['MULTISIG_FEE_CONFIRMATION_SWEEP_INTERVAL_MS', 'trade', 'multisigFeeConfirmationSweepIntervalMs', 300000],
      ['MULTISIG_FEE_REORG_SWEEP_INTERVAL_MS', 'trade', 'multisigFeeReorgSweepIntervalMs', 300000],
      ['MULTISIG_FUNDING_REORG_SWEEP_INTERVAL_MS', 'trade', 'multisigFundingReorgSweepIntervalMs', 300000],
      ['MULTISIG_RELEASE_REORG_SWEEP_INTERVAL_MS', 'trade', 'multisigReleaseReorgSweepIntervalMs', 300000],
      ['MULTISIG_EXPLORER_TIMEOUT_MS', 'multisig', 'explorerRequestTimeoutMs', 8000],
      ['SAFE_GUARD_EVM_RPC_TIMEOUT_MS', 'safeGuardEvm', 'rpcRequestTimeoutMs', 8000],
    ]
    const BAD = ['0', '-1', '-5000', '1.5', '100abc', '1e3', '0x10', '007', ' 5', '5 ', '+5', '', 'abc', '2147483648', '3000000000', '99999999999999999999']
    const read = (env: string, group: string, key: string, value: string | undefined) => {
      jest.resetModules()
      return loadConfig({ ...dev, [env]: value })()[group][key]
    }

    describe.each(TIMERS)('%s', (env, group, key, dflt) => {
      it.each(BAD)('refuses %p at boot', (v) => {
        jest.resetModules()
        expect(loadConfig({ ...dev, [env]: v })).toThrow(new RegExp(env))
      })

      it('refuses the same values in production', () => {
        jest.resetModules()
        expect(loadConfig({ ...REQUIRED_PROD_ENV, [env]: '2147483648' })).toThrow(new RegExp(env))
        jest.resetModules()
        expect(loadConfig({ ...REQUIRED_PROD_ENV, [env]: '1.5' })).toThrow(new RegExp(env))
      })

      it('accepts the borders 1 and 2147483647, an ordinary value, and keeps its default', () => {
        expect(read(env, group, key, '1')).toBe(1)
        expect(read(env, group, key, '2147483647')).toBe(2147483647)
        expect(read(env, group, key, '1000')).toBe(1000)
        expect(read(env, group, key, undefined)).toBe(dflt)
      })
    })

    it('the two request timeouts refuse 2147483648 at boot instead of letting every explorer / RPC call abort immediately', () => {
      const both = ['MULTISIG_EXPLORER_TIMEOUT_MS', 'SAFE_GUARD_EVM_RPC_TIMEOUT_MS']
      for (const env of both) {
        jest.resetModules()
        // loadConfig() leaves what it sets in process.env: clear the other variable so each iteration tests ONE variable
        const only = Object.fromEntries(both.map((k) => [k, k === env ? '2147483648' : undefined]))
        expect(loadConfig({ ...dev, ...only })).toThrow(new RegExp(`${env} must be a strictly positive integer`))
      }
    })
  })

  describe('QVAC auto-resolution numeric knobs (#330 — fail-closed, strict parse)', () => {
    const dev = { NODE_ENV: 'development', DATABASE_URL: undefined, REDIS_URL: undefined, ENFORCE_CAPABILITIES: undefined, MOCK_ESCROW: undefined, MOCK_SETTLEMENT: undefined, MULTISIG_NETWORK: undefined }
    const T = 'QVAC_AUTO_RESOLUTION_CONFIDENCE_THRESHOLD'
    const W = 'QVAC_AUTO_RESOLUTION_WINDOW_HOURS'

    it.each(['0,85', 'abc', '-1', '1.5', '', ' ', 'Infinity', 'NaN', '0.85abc', '1e0'])('refuses threshold %p', (v) => {
      expect(loadConfig({ ...dev, [T]: v })).toThrow(new RegExp(T))
    })

    it.each(['0', 'NaN', 'Infinity', '-5', '721', '0,5', 'abc', ''])('refuses window %p', (v) => {
      expect(loadConfig({ ...dev, [W]: v })).toThrow(new RegExp(W))
    })

    it('also refuses invalid values in production', () => {
      expect(loadConfig({ ...REQUIRED_PROD_ENV, [T]: '0,85' })).toThrow(new RegExp(T))
    })

    it('accepts valid values and the defaults; auto-resolution stays OFF by default', () => {
      const d = loadConfig({ ...dev })().settlement
      expect(d.qvacAutoResolutionEnabled).toBe(false)
      expect(d.qvacAutoResolutionConfidenceThreshold).toBe(0.85)
      expect(d.qvacAutoResolutionWindowHours).toBe(24)
      jest.resetModules()
      const v = loadConfig({ ...dev, [T]: '1', [W]: '720' })().settlement
      expect(v.qvacAutoResolutionConfidenceThreshold).toBe(1)
      expect(v.qvacAutoResolutionWindowHours).toBe(720)
      jest.resetModules()
      const lo = loadConfig({ ...dev, [T]: '0', [W]: '0.5' })().settlement
      expect(lo.qvacAutoResolutionConfidenceThreshold).toBe(0)
      expect(lo.qvacAutoResolutionWindowHours).toBe(0.5)
    })
  })

  // CTO 421 (Classe B) — each of these, with 0 / a negative / a fraction / a unit suffix, silently disabled its
  // protection (measured: breaker never opens, WS lets 1000/1000 through, suspicious-activity detects nothing,
  // Redis PEXPIRE <= 0 deletes the rate-limit key). Strict positive integer, no timer cap, defaults unchanged.
  describe('security windows and thresholds (CTO 421 — strict positive integer, no cap)', () => {
    const dev = { NODE_ENV: 'development', DATABASE_URL: undefined, REDIS_URL: undefined, ENFORCE_CAPABILITIES: undefined, MOCK_ESCROW: undefined, MOCK_SETTLEMENT: undefined, MULTISIG_NETWORK: undefined }
    const cases: Array<[string, (c: any) => number, number]> = [
      ['RATE_LIMIT_AUTH_WINDOW_MS', (c) => c.rateLimit.authWindowMs, 60000],
      ['RATE_LIMIT_CRITICAL_WINDOW_MS', (c) => c.rateLimit.criticalWindowMs, 60000],
      ['RATE_LIMIT_WS_MESSAGE_WINDOW_MS', (c) => c.rateLimit.wsMessageWindowMs, 10000],
      ['SUSPICIOUS_AUTH_FAILURE_MAX', (c) => c.suspiciousActivity.authFailureMax, 8],
      ['SUSPICIOUS_AUTH_FAILURE_WINDOW_MS', (c) => c.suspiciousActivity.authFailureWindowMs, 300000],
      ['SUSPICIOUS_NOT_FOUND_MAX', (c) => c.suspiciousActivity.notFoundClusterMax, 15],
      ['SUSPICIOUS_NOT_FOUND_WINDOW_MS', (c) => c.suspiciousActivity.notFoundClusterWindowMs, 300000],
      ['SUSPICIOUS_RATE_LIMITED_MAX', (c) => c.suspiciousActivity.rateLimitedMax, 3],
      ['SUSPICIOUS_RATE_LIMITED_WINDOW_MS', (c) => c.suspiciousActivity.rateLimitedWindowMs, 300000],
      ['ESCROW_BREAKER_WINDOW_MS', (c) => c.escrowCircuitBreaker.windowMs, 30000],
      ['ESCROW_BREAKER_COOLDOWN_MS', (c) => c.escrowCircuitBreaker.cooldownMs, 120000],
    ]
    const refused = ['0', '-1', '-1000', '0.5', '1.5', '30s', '10000ms', '5m', '', ' ', 'abc', 'NaN', ' 5', '5 ', '+5', '1e3', '0x10', '007', '9007199254740993']

    describe.each(cases)('%s', (K, read, fallback) => {
      it.each(refused)('refuses %p at boot', (v) => {
        expect(loadConfig({ ...dev, [K]: v })).toThrow(new RegExp(`${K} must be a strictly positive integer`))
      })

      it('accepts strict positive integers, with no timer cap, and keeps the default', () => {
        for (const [v, expected] of [['1', 1], ['60000', 60000], ['2147483648', 2147483648], ['3000000000', 3000000000]] as const) {
          jest.resetModules()
          expect(read(loadConfig({ ...dev, [K]: v })())).toBe(expected)
        }
        jest.resetModules()
        expect(read(loadConfig({ ...dev, [K]: undefined })())).toBe(fallback)
      })
    })

    it('leaves the fail-closed-only knobs on their existing parser (ESCROW_BREAKER_FAILURE_THRESHOLD, RATE_LIMIT_WS_MESSAGE_MAX)', () => {
      const c = loadConfig({ ...dev, ESCROW_BREAKER_FAILURE_THRESHOLD: '0', RATE_LIMIT_WS_MESSAGE_MAX: '0' })()
      expect(c.escrowCircuitBreaker.failureThreshold).toBe(0)
      expect(c.rateLimit.wsMessageMax).toBe(0)
    })
  })

  describe('METRICS_ENABLED (CTO 429 — /metrics off by default in production, strict parse)', () => {
    const dev = { NODE_ENV: 'development', DATABASE_URL: undefined, REDIS_URL: undefined, ENFORCE_CAPABILITIES: undefined, MOCK_ESCROW: undefined, MOCK_SETTLEMENT: undefined, MULTISIG_NETWORK: undefined }

    it('defaults to OFF in production when unset', () => {
      expect(loadConfig({ ...REQUIRED_PROD_ENV, METRICS_ENABLED: undefined })().observability.metricsEnabled).toBe(false)
    })

    it('defaults to ON outside production when unset', () => {
      expect(loadConfig({ ...dev, METRICS_ENABLED: undefined })().observability.metricsEnabled).toBe(true)
    })

    it('METRICS_ENABLED=true enables it in production (explicit opt-in)', () => {
      expect(loadConfig({ ...REQUIRED_PROD_ENV, METRICS_ENABLED: 'true' })().observability.metricsEnabled).toBe(true)
    })

    it('METRICS_ENABLED=false disables it outside production', () => {
      expect(loadConfig({ ...dev, METRICS_ENABLED: 'false' })().observability.metricsEnabled).toBe(false)
    })

    it.each(['TRUE', 'False', '1', '0', 'yes', '', ' true', 'true '])('refuses to boot for the invalid value %p, in production and outside it', (v) => {
      expect(loadConfig({ ...REQUIRED_PROD_ENV, METRICS_ENABLED: v })).toThrow(/METRICS_ENABLED/)
      expect(loadConfig({ ...dev, METRICS_ENABLED: v })).toThrow(/METRICS_ENABLED/)
    })
  })

  describe('a fully correct production configuration boots cleanly', () => {
    it('every gate satisfied at once — no throw, all values reflect what was set', () => {
      const load = loadConfig(REQUIRED_PROD_ENV)
      const cfg = load()
      expect(cfg.isProduction).toBe(true)
      expect(cfg.features.mockEscrow).toBe(false)
      expect(cfg.features.enforceCapabilities).toBe(true)
      expect(cfg.database.url).toBe('postgresql://real-host/sails_protocol')
      expect(cfg.redis.url).toBe('redis://real-host:6379')
    })
  })
})
