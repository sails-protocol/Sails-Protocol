/**
 * Config — Sails Protocol reference implementation
 * The first bootstrap file (TODO.md §2 "Immediate Priority").
 * Every other file that imports 'config' depends on this existing.
 */
import 'dotenv/config'
import { normalizeBitcoinNetwork, type BitcoinNetwork } from '@satsails/p2p-schemas'

import { parseArbitrationMode, type ArbitrationMode } from '../modules/open-settlement/arbitration-policy'
function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback
  if (v === undefined) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return v
}

function requiredInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const parsed = parseInt(raw, 10)
  if (isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be a valid integer, got: ${raw}`)
  }
  return parsed
}

// Same shape as requiredInt(), plus a floor of 1 — for values (like a
// network-call timeout in ms) where zero or negative would be nonsensical
// rather than merely unusual. Same validated-config discipline
// resolveMultisigRequiredConfirmations() below already applies to
// MULTISIG_FUNDING_REQUIRED_CONFIRMATIONS.
function requiredPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const parsed = parseInt(raw, 10)
  if (isNaN(parsed) || parsed < 1) {
    throw new Error(`Environment variable ${name} must be a positive integer, got: ${raw}`)
  }
  return parsed
}

function requiredFiniteNumber(name: string, fallback: number, validate: (value: number) => boolean, expectation: string): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (raw.trim() === '' || !Number.isFinite(parsed) || !validate(parsed)) {
    throw new Error(`Invalid ${name}: must be ${expectation}, got: ${raw}`)
  }
  return parsed
}

function requiredStrictPositiveInt(name: string, fallback: number): number {
  return requiredFiniteNumber(name, fallback, (value) => Number.isInteger(value) && value > 0, 'a positive integer')
}

// Missão 11 Fase 8.1 LB-03 — NODE_ENV used to be a bare `=== 'production'`
// string comparison with no validation of anything else. Every fail-closed
// guard in this file (RT-001, ENFORCE_CAPABILITIES, DATABASE_URL/REDIS_URL
// no-fallback, MULTISIG_NETWORK/MOCK_SETTLEMENT above) pivots on this one
// comparison — a typo ('Production', 'prod') or an unexpected value would
// silently evaluate to `false` and boot the permissive dev/test posture
// with zero error. Validated against the exact set this codebase actually
// uses (development is the implicit default; test is Jest's own default,
// see package.json's jest config; production is the deployed value —
// docker's own Dockerfile sets exactly this). Any other value throws
// immediately, in every environment — an unrecognized NODE_ENV is a
// config bug regardless of what was intended.
const RECOGNIZED_NODE_ENVS = ['development', 'test', 'production'] as const
type RecognizedNodeEnv = (typeof RECOGNIZED_NODE_ENVS)[number]

function resolveNodeEnv(): RecognizedNodeEnv {
  const raw = process.env.NODE_ENV
  if (raw === undefined) return 'development'
  if (!(RECOGNIZED_NODE_ENVS as readonly string[]).includes(raw)) {
    throw new Error(
      `FATAL: NODE_ENV is set to an unrecognized value '${raw}'. Expected one of: ${RECOGNIZED_NODE_ENVS.join(', ')}. ` +
      'Refusing to boot — see Missão 11 Fase 8.1 LB-03. Every fail-closed guard in this file depends on NODE_ENV ' +
      'meaning exactly what it says; an unrecognized value must never silently fall through to the permissive posture.'
    )
  }
  return raw as RecognizedNodeEnv
}

const resolvedNodeEnv = resolveNodeEnv()

// Missão 06.5 — computed once, before the object literal, so the
// database/redis fallback logic below can read it (a field can't
// reference `config.isProduction` from inside `config`'s own literal —
// it doesn't exist yet during its own construction).
const isProductionEnv = resolvedNodeEnv === 'production'

// Missão 11 Fase 8.1 LB-01 — MULTISIG_NETWORK used to be a bare string
// that multisig.provider.ts's own networkFor() silently mapped to
// testnet for anything unrecognized (typo, wrong case, unset). Same
// required-in-production/defaulted-in-dev shape DATABASE_URL/REDIS_URL
// already use below: an explicitly WRONG value throws in every
// environment (a typo is a typo regardless of NODE_ENV — see
// normalizeBitcoinNetwork()), but an entirely UNSET value only throws in
// production; dev/CI environments that have never set this var keep
// defaulting to testnet exactly as before.
function resolveMultisigNetwork(): BitcoinNetwork {
  const raw = process.env.MULTISIG_NETWORK
  if (raw === undefined) {
    if (isProductionEnv) {
      throw new Error(
        'FATAL: NODE_ENV=production but MULTISIG_NETWORK is not set. Refusing to boot — ' +
        'see Missão 11 Fase 8.1 LB-01. Set MULTISIG_NETWORK explicitly (mainnet, testnet, or regtest; ' +
        "'bitcoin' accepted as an alias for mainnet)."
      )
    }
    return 'testnet'
  }
  return normalizeBitcoinNetwork(raw)
}

const resolvedMultisigNetwork = resolveMultisigNetwork()

// Missão 11 Fase 8.1 LB-02 — the confirmation-depth requirement for
// recognizing an escrow's own FUNDING (the trade collateral itself) as
// safely locked. Deliberately a SEPARATE setting from
// FeePolicyVersion.requiredConfirmations (that field's own schema comment
// is explicit: it governs when a broadcast FEE output becomes COLLECTED
// revenue — a different economic fact, only meaningful for policy-aware
// escrows, and entirely absent for a legacy escrow). Escrow funding-lock
// safety is a protocol-level Bitcoin-safety parameter that applies to
// EVERY MULTISIG escrow regardless of fee-policy status, so it lives here
// as a config value, not a per-policy DB column — reusing the fee field
// would have left every legacy escrow with no depth requirement at all.
//
// Gated on the resolved Bitcoin NETWORK (mainnet), not NODE_ENV: a
// controlled mainnet rehearsal (docs/MAINNET_MULTISIG_PROOF.md) is the
// actual real-money signal, and might not run with NODE_ENV=production
// set. Default of 1 (testnet/regtest) preserves today's actual dev/CI
// ergonomics and behavior — this was already the effective confirmation
// requirement before this fix (a bare `status.confirmed` boolean is "at
// least 1"), so nothing about non-mainnet behavior silently gets slower.
function resolveMultisigRequiredConfirmations(): number {
  const raw = process.env.MULTISIG_FUNDING_REQUIRED_CONFIRMATIONS
  if (raw === undefined) {
    if (resolvedMultisigNetwork === 'mainnet') {
      throw new Error(
        'FATAL: MULTISIG_NETWORK=mainnet but MULTISIG_FUNDING_REQUIRED_CONFIRMATIONS is not set. ' +
        'Refusing to boot — see Missão 11 Fase 8.1 LB-02. A bare single (or zero) confirmation is not ' +
        'sufficient economic finality for real BTC; set this explicitly (e.g. ' +
        'MULTISIG_FUNDING_REQUIRED_CONFIRMATIONS=3).'
      )
    }
    return 1
  }
  const parsed = parseInt(raw, 10)
  if (isNaN(parsed) || parsed < 1) {
    throw new Error(`Environment variable MULTISIG_FUNDING_REQUIRED_CONFIRMATIONS must be a positive integer, got: ${raw}`)
  }
  return parsed
}

// Issue #265 CTO Gate R2, BLOCKER 1 — EVIDENCE_PROVIDER used to be a bare
// `(process.env.EVIDENCE_PROVIDER ?? 'local-fs') as 'local-fs' | 's3'`
// cast, not real parsing: a genuinely unrecognized value (a typo, e.g.
// 's33') was caught by neither the production 'local-fs' guard nor the
// 's3' one below, fell through `createEvidenceProvider()`'s `else`
// branch unexamined, and silently constructed
// `LocalFilesystemEvidenceProvider` anyway — defeating the entire
// fail-closed guarantee this file exists to provide. Same
// NODE_ENV/MULTISIG_NETWORK shape used everywhere else in this file: an
// explicitly WRONG value throws in EVERY environment (a typo is a typo
// regardless of NODE_ENV), an entirely UNSET value defaults to
// 'local-fs' (the legitimate dev/reference default) and is only
// rejected by the production-only FATAL guard further down.
const RECOGNIZED_EVIDENCE_PROVIDER_TYPES = ['local-fs', 's3'] as const
type EvidenceProviderType = (typeof RECOGNIZED_EVIDENCE_PROVIDER_TYPES)[number]

function resolveEvidenceProviderType(): EvidenceProviderType {
  const raw = process.env.EVIDENCE_PROVIDER
  if (raw === undefined) return 'local-fs'
  if (!(RECOGNIZED_EVIDENCE_PROVIDER_TYPES as readonly string[]).includes(raw)) {
    throw new Error(
      `FATAL: EVIDENCE_PROVIDER is set to an unrecognized value '${raw}'. Expected one of: ` +
      `${RECOGNIZED_EVIDENCE_PROVIDER_TYPES.join(', ')}. Refusing to boot — an unrecognized evidence storage ` +
      'provider must never silently fall through to LocalFilesystemEvidenceProvider (see Issue #265).'
    )
  }
  return raw as EvidenceProviderType
}

const resolvedEvidenceProviderType = resolveEvidenceProviderType()

function parseArbitrationPolicyOverrides(raw: string | undefined): Record<string, ArbitrationMode> {
  if (!raw?.trim()) return {}
  const result: Record<string, ArbitrationMode> = {}
  for (const entry of raw.split(',')) {
    const [implementationRaw, modeRaw] = entry.split('=').map((v) => v.trim())
    if (!implementationRaw || (modeRaw !== 'trusted-list' && modeRaw !== 'market')) {
      throw new Error(
        `Invalid ARBITRATION_POLICY_BY_ESCROW_TYPE entry '${entry}'. Expected IMPLEMENTATION=trusted-list|market`
      )
    }
    result[implementationRaw] = modeRaw
  }
  return result
}

export const config = {
  env: resolvedNodeEnv,
  isProduction: isProductionEnv,

  // Matches what app.ts (the pre-existing Fastify bootstrap) actually
  // reads — found via a real `tsc --noEmit` run, not assumed.
  app: {
    port: requiredInt('PORT', 3000),
    host: process.env.HOST ?? '0.0.0.0',
    env: resolvedNodeEnv,
    logLevel: process.env.LOG_LEVEL ?? 'info',
  },

  // Missão 06.5 — the `localhost`/default-credential fallback stays for
  // development/test ergonomics (unchanged local-onboarding experience,
  // same value docker-compose.yml's own `app` service still overrides
  // explicitly anyway) but is withheld in production: `required()` then
  // has no fallback to fall back to, so a production boot with no real
  // DATABASE_URL/REDIS_URL set throws immediately at config load —
  // before a single query or connection is attempted — rather than
  // silently talking to `localhost` with a well-known default password.
  // Same "structural, not someone-remembering-to-check" posture RT-001
  // (mockEscrow, below) already established for this file.
  database: {
    url: isProductionEnv
      ? required('DATABASE_URL')
      : required('DATABASE_URL', 'postgresql://postgres:password@localhost:5432/sails_protocol'),
  },

  redis: {
    url: isProductionEnv
      ? required('REDIS_URL')
      : required('REDIS_URL', 'redis://localhost:6379'),
  },

  auth: {
    // RED_TEAM_REVIEW.md RT-002: this is the field that matters most in
    // this whole file. Challenge tokens expire fast on purpose.
    challengeTtlSeconds: requiredInt('AUTH_CHALLENGE_TTL', 120),
    sessionTtlSeconds: requiredInt('AUTH_SESSION_TTL', 3600),
    // Security review finding, 2026-08-15 (P1): chat.routes.ts/relay.routes.ts's
    // WS upgrade auth used to put the raw, long-lived session token in
    // `?token=` — logged in full by any proxy/LB (pino's own request-log
    // redact only masks named object fields, never a substring inside
    // req.url). Replaced with a single-use ticket, deliberately short-
    // lived: a ticket that leaks into a log is worthless within seconds
    // and can never be replayed a second time even before it expires.
    wsTicketTtlSeconds: requiredInt('AUTH_WS_TICKET_TTL', 30),
  },

  pear: {
    bootstrapNodes: (process.env.HYPERDHT_BOOTSTRAP ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
  },

  // CTO_DUE_DILIGENCE_REPORT.md B-SEC-01, closed 2026-08-08 — `origin: true`
  // (reflect any Origin header) was a real, live gap: any site could call
  // this API using a logged-in user's own session/token. Comma-separated
  // allowlist, same `.split(',').filter(Boolean)` pattern already used for
  // `HYPERDHT_BOOTSTRAP` above. Empty by default — `app.ts` decides what an
  // empty list means per environment (permissive in dev so onboarding stays
  // `docker compose up` simple, deny-by-default in production).
  cors: {
    allowedOrigins: (process.env.CORS_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  // THREAT_MODEL.md — "no rate limiting exists anywhere" was an explicit,
  // named unmitigated gap (Low severity, becomes higher at scale) until
  // this pass. Two tiers: a general per-IP ceiling for every route, and a
  // much tighter one for the identity challenge/authenticate routes
  // specifically (RED_TEAM_REVIEW.md RT-002's own "this is the field that
  // matters most" — those two routes are what a credential-stuffing/
  // brute-force attempt would actually hit).
  rateLimit: {
    max: requiredInt('RATE_LIMIT_MAX', 100),
    timeWindow: process.env.RATE_LIMIT_WINDOW ?? '1 minute',
    authMax: requiredInt('RATE_LIMIT_AUTH_MAX', 10),
    // Unused since Missão 08B (see authWindowMs below) — kept, still
    // settable, only in case a local-store fallback is ever reintroduced
    // for this tier.
    authTimeWindow: process.env.RATE_LIMIT_AUTH_WINDOW ?? '1 minute',
    // CTO_DUE_DILIGENCE_REPORT.md A-SEC-05, closed 2026-08-08 — the
    // global ceiling above covers every route generically, but disputes/
    // arbitration and capability revocation are real-money/real-authority
    // actions a spammer would specifically target (each dispute costs a
    // real arbiter's time; each revoke is a real authority change) —
    // tighter than the global default, looser than the auth tier (these
    // routes need `requireAuth` first, which already raises the bar).
    criticalMax: requiredInt('RATE_LIMIT_CRITICAL_MAX', 20),
    // Unused since Missão 08B (see criticalWindowMs below) — same reason
    // as authTimeWindow above.
    criticalTimeWindow: process.env.RATE_LIMIT_CRITICAL_WINDOW ?? '1 minute',
    // Missão 08B Fase 9 — auth/critical moved from @fastify/rate-limit's
    // own per-route local store (`config: { rateLimit: {...} } }`,
    // consuming authTimeWindow/criticalTimeWindow above) to a small
    // custom Redis-backed preHandler (redis-rate-limit.ts), so the two
    // tiers that actually matter for security (credential-stuffing,
    // dispute/arbitration/capability-revoke spam) share one counter
    // across every instance instead of counting per-instance. Native
    // @fastify/rate-limit double-registration was empirically proven to
    // not cleanly isolate two stores (see the 08B report) — hence the
    // small purpose-built preHandler instead of a second plugin
    // registration. Separate, additive, milliseconds-typed env vars
    // (not reusing the string vars above — no `ms`-string-parsing
    // dependency added just for this) so Redis's PEXPIRE gets a plain
    // number directly — same default window (60s) as the tiers they
    // parallel and supersede.
    authWindowMs: requiredInt('RATE_LIMIT_AUTH_WINDOW_MS', 60000),
    criticalWindowMs: requiredInt('RATE_LIMIT_CRITICAL_WINDOW_MS', 60000),
    // 2026-08-15 security review: the two tiers above are @fastify/rate-limit,
    // which only fires on the HTTP request/response lifecycle — a WebSocket
    // upgrade is one HTTP request, then the connection stays open and every
    // later SEND_MESSAGE arrives as a `message` frame, never a new HTTP
    // request, so neither tier ever sees it. chat.routes.ts's SEND_MESSAGE
    // handler writes to Postgres and emits an event on every call — a
    // connected client with a valid ws-ticket-derived session could otherwise
    // flood both with no ceiling at all. Same in-memory, single-instance,
    // deliberate-simplification precedent as the HTTP tiers above (no shared
    // Redis store yet); see ws-message-rate-limiter.ts.
    wsMessageMax: requiredInt('RATE_LIMIT_WS_MESSAGE_MAX', 20),
    wsMessageWindowMs: requiredInt('RATE_LIMIT_WS_MESSAGE_WINDOW_MS', 10000),
  },

  // 2026-08-15 security review — common/security/suspicious-activity.ts.
  // A volume rate limiter (the tiers above) never catches a slow, patient
  // probe; this is a separate, threshold-based detection layer, not
  // another rate limit — it never blocks anything, only logs + emits an
  // event once an identity crosses its threshold within the window. 401
  // gets the highest bar (a real user mistyping a password looks
  // identical for one or two attempts); 404 clustering (ID enumeration)
  // gets the lowest, since it's the cheapest pattern for an attacker to
  // generate. The three numbers below are reasoned starting points, not
  // measured ones — this deployment has no real production traffic yet
  // to calibrate a false-positive rate against. Env-var overridable for
  // exactly that reason: tune them once real traffic exists, don't
  // treat the defaults as validated.
  suspiciousActivity: {
    authFailureMax: requiredInt('SUSPICIOUS_AUTH_FAILURE_MAX', 8),
    authFailureWindowMs: requiredInt('SUSPICIOUS_AUTH_FAILURE_WINDOW_MS', 5 * 60 * 1000),
    notFoundClusterMax: requiredInt('SUSPICIOUS_NOT_FOUND_MAX', 15),
    notFoundClusterWindowMs: requiredInt('SUSPICIOUS_NOT_FOUND_WINDOW_MS', 5 * 60 * 1000),
    rateLimitedMax: requiredInt('SUSPICIOUS_RATE_LIMITED_MAX', 3),
    rateLimitedWindowMs: requiredInt('SUSPICIOUS_RATE_LIMITED_WINDOW_MS', 5 * 60 * 1000),
  },

  // 2026-08-15 security review — escrow-circuit-breaker.ts. Deliberately
  // scoped per-escrowId, never global: pausing the whole exchange because
  // of anomalous activity on ONE trade would turn the circuit breaker
  // itself into a denial-of-service lever (an attacker triggers a few
  // conflicts on their own trade, every other user's trading grinds to a
  // halt). Auto-resets after cooldownMs — this protocol has no
  // operator/admin tier to manually reset it (no-platform-operator-
  // visibility is a deliberate architectural choice, not an oversight),
  // so a manual-reset design would leave a tripped breaker stuck open
  // forever with nobody able to clear it. Same disclosure as
  // suspiciousActivity above: these three numbers are a reasoned
  // starting point (real concurrent conflicts on one escrow should be
  // rare in normal use — a handful per escrow's whole lifetime, not
  // per minute — so this threshold has room before it risks a false
  // trip), not something measured against real traffic.
  escrowCircuitBreaker: {
    failureThreshold: requiredInt('ESCROW_BREAKER_FAILURE_THRESHOLD', 5),
    windowMs: requiredInt('ESCROW_BREAKER_WINDOW_MS', 30 * 1000),
    cooldownMs: requiredInt('ESCROW_BREAKER_COOLDOWN_MS', 2 * 60 * 1000),
  },

  features: {
    // RED_TEAM_REVIEW.md RT-001: this is the single most important line
    // in this file. Left true, "escrow" is theater — see escrow.service.ts.
    mockEscrow: process.env.MOCK_ESCROW?.toLowerCase() !== 'false',
    mockSettlement: process.env.MOCK_SETTLEMENT?.toLowerCase() !== 'false',
    // Gates common/events/handlers.ts's reaction to openp2p.trade.created,
    // which calls settlement-orchestrator.ts's executeSettlement() —
    // creates escrow, locks funds, and (once PIX is emulated as received)
    // releases a real signed WDK transfer, with no human/dispute-window
    // step in between. Default false deliberately: openp2p.trade.created
    // fires for every real HTTP-driven trade in this codebase, not only
    // agent-driven demo trades, so auto-firing full fund release
    // unconditionally the instant two parties match would silently bypass
    // the negotiation/dispute-window design (Escrow.timelockHours) this
    // protocol otherwise relies on. Same "off by default, explicit opt-in"
    // shape as mockEscrow/mockSettlement above, for the same reason:
    // moving funds automatically is not a safe default.
    autoSettleOnMatch: process.env.AUTO_SETTLE_ON_MATCH === 'true',
    // RFC-014: capability-registry.ts (real since RFC-013) had zero real
    // callers anywhere in the money-moving path — a working permission
    // system nothing ever consults. This flag turns on the two real
    // enforcement points RFC-014 adds (intentEngine.create() for
    // TradeIntent, executeSettlement() before the USDT release). Default
    // false for the same reason autoSettleOnMatch is: a reference
    // deployment with no CapabilityGrants issued yet is a valid,
    // pre-existing state (every test/demo in this repo runs with none
    // issued) — flipping this to true with no grants issued would reject
    // every TradeIntent and settlement, not fail safe silently.
    enforceCapabilities: process.env.ENFORCE_CAPABILITIES === 'true',
    // RFC-015: application-layer two-person control on escrow.service.ts's
    // releaseFunds() — NOT on-chain multisig (WDK's real package is
    // single-owner only, checked before choosing this design). When on,
    // the normal (non-disputed) release path requires both of the
    // trade's own two counterparties (Trade.buyerId, Trade.sellerId) to
    // have separately called POST /v1/settlement/escrow/:id/approve-release
    // first. Default false for the same reason every other
    // behavior-changing flag in this file is: turning it on changes the
    // required calling pattern (the atomic executeSettlement() convenience
    // function will start failing at its release step, by design, since
    // no approval can exist yet within that same synchronous call — see
    // RFC-015's Alternatives Considered). Arbitrated releases
    // (Escrow.status === 'DISPUTED') always bypass this check, regardless
    // of this flag — a dispute existing already means the two-party
    // agreement this control is meant to enforce didn't happen.
    requireDualApprovalForRelease: process.env.REQUIRE_DUAL_APPROVAL_RELEASE === 'true',
    // RFC-017: SocialEngineeringAgent (RFC-007 D7) calls QVAC on every
    // chat message sent through openp2p.message.sent — a real local-LLM
    // call per message, not free. Default false for cost/latency, the
    // same reason autoSettleOnMatch/enforceCapabilities/
    // requireDualApprovalForRelease all default false: a reference
    // deployment that hasn't opted in should not pay for or wait on a
    // local model call on every single chat message.
    socialEngineeringDetection: process.env.SOCIAL_ENGINEERING_DETECTION === 'true',
    // BACKLOG.md P0, "Escrow timelock proactive sweeper" — was a real,
    // named gap: escrow.service.ts's lockFunds() always computed and
    // stored a real Escrow.expiresAt, but nothing ever read it back, so
    // a FUNDS_LOCKED escrow whose counterparty never returned stayed
    // locked forever. Default false for the same reason every other
    // flag in this file defaults false: no test or deployment in this
    // repo's history has ever run a background process that moves funds
    // on a timer, and turning this on is a real behavior change (an
    // abandoned trade now auto-refunds instead of staying stuck) that a
    // deployment should opt into deliberately, not inherit silently.
    escrowTimelockSweeper: process.env.ESCROW_TIMELOCK_SWEEPER === 'true',
    // RFC-021 D8 — off by default, same reasoning as escrowTimelockSweeper
    // above: a real background process applying real dispute rulings on a
    // timer is a real behavior change a deployment opts into deliberately.
    // Only meaningful when qvacAutoResolutionEnabled (settlement config,
    // below) is also true — otherwise no dispute is ever AUTO_PROPOSED for
    // this to find.
    disputeAutoResolutionSweeper: process.env.DISPUTE_AUTO_RESOLUTION_SWEEPER === 'true',
    // Missão 11 Fase 5 §7 — off by default, same reasoning as the two
    // sweepers above: a real background process recognizing on-chain
    // Protocol Fee collections is real economic-accounting behavior a
    // deployment opts into deliberately. Structurally inert until a real
    // FeePolicyVersion is published for MULTISIG (the only rail that can
    // ever produce an IN_PROGRESS obligation) — safe to enable ahead of
    // that with zero effect, but left off by default regardless.
    multisigFeeConfirmationSweeper: process.env.MULTISIG_FEE_CONFIRMATION_SWEEPER === 'true',
    // Missão 11 Fase 8.1 LB-08 — off by default, same reasoning as the
    // three sweepers above. Re-checks already-COLLECTED/DISTRIBUTED fee
    // obligations for a reorg that invalidated their confirming block —
    // detection only; the actual revert/flag logic
    // (recordReorgAndRevert()) already existed in
    // fee-collection-recognition.service.ts before this fix, just with
    // nothing calling it.
    multisigFeeReorgSweeper: process.env.MULTISIG_FEE_REORG_SWEEPER === 'true',
    // Missão 11 Fase 8.1 LB-08(A) — off by default, same reasoning.
    // Detection + logging only (see that sweep's own header comment for
    // why no status mutation happens here).
    multisigFundingReorgSweeper: process.env.MULTISIG_FUNDING_REORG_SWEEPER === 'true',
    // Sails Core Implementation Program M9-F (Release-Leg Finality &
    // Reorg Closure) — off by default, same reasoning as the three
    // sweepers above. Closes C18: re-checks the MAIN MULTISIG
    // release/refund/split payout (Escrow.txReleaseId) for a reorg —
    // never previously monitored at all (only the fee sub-output was).
    // Detection + durable evidence recording only; see that sweep's own
    // header comment for why World C (confirmed payout disappears,
    // funding outpoint unspent) is flagged for manual review rather than
    // auto-rebroadcast.
    multisigReleaseReorgSweeper: process.env.MULTISIG_RELEASE_REORG_SWEEPER === 'true',
  },

  trade: {
    defaultTimelockHours: requiredInt('DEFAULT_TIMELOCK_HOURS', 24),
    // How often the sweeper above (when enabled) checks for expired
    // FUNDS_LOCKED escrows. 5 minutes by default — frequent enough that
    // a real abandoned trade doesn't sit stuck for hours, infrequent
    // enough that it's not a meaningful query load on its own.
    timelockSweepIntervalMs: requiredInt('ESCROW_TIMELOCK_SWEEP_INTERVAL_MS', 300000),
    // How often the RFC-021 D8 sweeper (when enabled) checks for
    // AUTO_PROPOSED disputes past their contest deadline. Same 5-minute
    // default as the escrow sweeper above, same reasoning.
    disputeAutoResolutionSweepIntervalMs: requiredStrictPositiveInt('DISPUTE_AUTO_RESOLUTION_SWEEP_INTERVAL_MS', 300000),
    // How often the Fase 5 confirmation sweeper (when enabled) checks
    // IN_PROGRESS MULTISIG fee obligations against the chain. Same
    // 5-minute default as the other two sweepers — confirmation depth
    // itself is a per-policy decision (FeePolicyVersion.requiredConfirmations),
    // this is only how often the job bothers to look.
    multisigFeeConfirmationSweepIntervalMs: requiredInt('MULTISIG_FEE_CONFIRMATION_SWEEP_INTERVAL_MS', 300000),
    // How often the Fase 8.1 reorg sweeper (when enabled) re-checks
    // recently-collected MULTISIG fee obligations. Same 5-minute default.
    multisigFeeReorgSweepIntervalMs: requiredInt('MULTISIG_FEE_REORG_SWEEP_INTERVAL_MS', 300000),
    // Missão 11 Fase 8.1 LB-08 — once a COLLECTED/DISTRIBUTED obligation's
    // confirming block is this many blocks deep, the reorg sweeper stops
    // re-checking it — a reorg past this depth is not a real operational
    // concern worth an unbounded, ever-growing query. 100 blocks matches
    // Bitcoin Core's own coinbase-maturity constant — a widely-recognized,
    // independently-justified reference point for "practically
    // immutable" in the Bitcoin ecosystem, not an arbitrary pick.
    multisigReorgSafetyWindowBlocks: requiredInt('MULTISIG_REORG_SAFETY_WINDOW_BLOCKS', 100),
    // How often the Fase 8.1(A) funding-reorg sweeper (when enabled)
    // re-checks FUNDS_LOCKED MULTISIG escrows. Same 5-minute default.
    multisigFundingReorgSweepIntervalMs: requiredInt('MULTISIG_FUNDING_REORG_SWEEP_INTERVAL_MS', 300000),
    // Sails Core Implementation Program M9-F — how often the release-leg
    // reorg sweeper (when enabled) re-checks terminal MULTISIG escrows'
    // main payout. Same 5-minute default as every other sweeper here.
    // Reuses multisigReorgSafetyWindowBlocks above for its own depth cutoff.
    multisigReleaseReorgSweepIntervalMs: requiredInt('MULTISIG_RELEASE_REORG_SWEEP_INTERVAL_MS', 300000),
  },

  // Sails OpenProof (proof.service.ts) — Fase 1 Task 3(c). Evidence
  // submitted long after the Claim it supports is worth less as proof of
  // anything that happened *at the claimed time*, the same reasoning
  // escrow.timelockHours already applies to fund locks. Verification
  // nonces follow auth.ts's challenge-response TTL pattern exactly.
  proof: {
    submissionWindowHours: requiredInt('PROOF_SUBMISSION_WINDOW_HOURS', 72),
    verificationNonceTtlSeconds: requiredInt('PROOF_VERIFICATION_NONCE_TTL', 300),
    // RFC-007 D2 — LocalFilesystemEvidenceProvider's storage root
    // (evidence-provider.ts). A real, working default for a single-server
    // reference deployment; not multi-instance safe, not durable across
    // container restart/redeploy — see EVIDENCE_PROVIDER below.
    evidenceStorageDir: process.env.PROOF_EVIDENCE_STORAGE_DIR ?? './data/evidence',
    // Issue #265 — which EvidenceProvider implementation
    // evidence-provider.ts's exported singleton wires up. 'local-fs'
    // remains the dev/reference default; production is fail-closed against
    // it (see the FATAL guard below) rather than allowed to silently
    // inherit it. Real validation, not a bare cast — see
    // resolveEvidenceProviderType() above (CTO Gate R2, BLOCKER 1).
    evidenceProviderType: resolvedEvidenceProviderType,
    // Generic S3-compatible object storage config (works unmodified
    // against AWS S3, Cloudflare R2, MinIO, or any other S3-compatible
    // vendor via `endpoint` — Issue #265's own mission explicitly rules
    // out a Cloudflare-only/AWS-only adapter). Same bare
    // `process.env.X ?? default` convention as safeGuardEvm below;
    // `forcePathStyle` exists because some S3-compatible vendors
    // (MinIO, some R2 setups) require path-style requests instead of
    // AWS's virtual-hosted-style default.
    evidenceS3: {
      endpoint: process.env.EVIDENCE_S3_ENDPOINT ?? '',
      region: process.env.EVIDENCE_S3_REGION ?? 'auto',
      bucket: process.env.EVIDENCE_S3_BUCKET ?? '',
      accessKeyId: process.env.EVIDENCE_S3_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.EVIDENCE_S3_SECRET_ACCESS_KEY ?? '',
      forcePathStyle: process.env.EVIDENCE_S3_FORCE_PATH_STYLE === 'true',
    },
  },

  settlement: {
    // RFC-007 D4 — "each wallet/application registers its own Trusted
    // Arbitrators," not a protocol-wide list. Empty by default — dispute
    // routes surface a clear config error rather than the app refusing to
    // boot, since a reference deployment with no disputes yet is valid.
    trustedArbitrators: (process.env.TRUSTED_ARBITRATORS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    // RFC-021 Phase 0 — real Protocol Fee rate (PROTOCOL_ECONOMY.md §3/§6.2:
    // "Protocol Fee is OFF (0%)" is the documented bootstrap-phase default,
    // activating later "at a default of 0.40%" (revised 2026-08-11 from
    // the original 0.05%-0.15% planning range — see PROTOCOL_ECONOMY.md
    // §3/§6.2 for the competitive reasoning). Default 0 here matches the
    // bootstrap phase exactly — a deployment opts in by setting a real
    // rate, e.g. PROTOCOL_FEE_RATE=0.004 for 0.40%. escrow.service.ts's
    // releaseFunds() is the only place this is read.
    protocolFeeRate: parseFloat(process.env.PROTOCOL_FEE_RATE ?? '0'),
    // Missão 11 Fase 4 — a plain destination address for the NEW,
    // policy-versioned Protocol Fee collection mechanism (FeePolicyVersion/
    // FeeObligation) — completely unrelated to protocolFeeRate above (the
    // OLD, still-untouched RFC-021 Phase 0 accounting-only mechanism).
    // Deliberately just an address string, never a seed/private key —
    // same "empty by default, surface a clear config error rather than
    // refuse to boot" pattern MULTISIG_SEED/WDK_SEED_PHRASE already use.
    // Undefined by default: no real Sails-controlled treasury address has
    // ever been chosen or created by this project (every prior Missão 11
    // phase explicitly deferred that decision) — a deployment that hasn't
    // set this cannot construct a fee-collecting transaction at all,
    // by construction, not by convention.
    protocolFeeCollectionAddress: process.env.SAILS_PROTOCOL_FEE_COLLECTION_ADDRESS || undefined,
    // RFC-021 D2 — which ArbitrationProvider settlement.routes.ts's
    // getDisputeService() constructs. 'trusted-list' (default) preserves
    // RFC-007 D4's exact original behavior for every existing deployment;
    // 'market' opts into the new permissionless registry
    // (MarketArbitrationProvider). Not a boolean flag — a third mode
    // could exist later without a breaking rename.
    arbitrationMode: parseArbitrationMode(process.env.ARBITRATION_MODE),
    // ADR-003: optional per-implementation override. Example: MOCK=market,MULTISIG=trusted-list.
    arbitrationPolicyByEscrowType: parseArbitrationPolicyOverrides(process.env.ARBITRATION_POLICY_BY_ESCROW_TYPE),
    // RFC-021 D8 — QVAC-assisted automated first-pass dispute resolution.
    // Off by default, same "opt-in per deployment" pattern arbitrationMode
    // itself uses — a fresh deployment keeps today's exact behavior
    // (every dispute goes straight to the assigned human arbiter) until
    // this is explicitly turned on. Payment-method-agnostic by design —
    // nothing about this config is PIX-specific or rail-specific.
    qvacAutoResolutionEnabled: process.env.QVAC_AUTO_RESOLUTION_ENABLED === 'true',
    // Only a recommendation at or above this confidence (0-1) is even
    // proposed — anything lower falls straight through to the human
    // arbiter, unchanged. Starting conservative (high bar), tunable per
    // deployment as real-world calibration data accumulates.
    qvacAutoResolutionConfidenceThreshold: requiredFiniteNumber(
      'QVAC_AUTO_RESOLUTION_CONFIDENCE_THRESHOLD',
      0.85,
      (value) => value >= 0 && value <= 1,
      'a finite number in the range [0, 1]'
    ),
    // How long either trade party has to contest a proposed advisory ruling
    // before sweepExpiredAutoResolutions() returns it to human review.
    qvacAutoResolutionWindowHours: requiredFiniteNumber(
      'QVAC_AUTO_RESOLUTION_WINDOW_HOURS',
      24,
      (value) => value > 0,
      'a finite number greater than 0'
    ),
  },

  // WDK_USDT_EVM SettlementProvider (wdk-settlement.provider.ts) — real
  // @tetherto/wdk-wallet-evm calls against a public EVM testnet. Empty
  // seed phrase by default, same "surface a clear config error, don't
  // refuse to boot" pattern as settlement.trustedArbitrators above.
  // Sepolia + a placeholder token address are safe, inert defaults — the
  // provider still requires an explicit funded seed before it will send
  // a real (testnet) transaction.
  wdk: {
    seedPhrase: process.env.WDK_SEED_PHRASE ?? '',
    rpcUrl: process.env.WDK_RPC_URL ?? 'https://sepolia.drpc.org',
    usdtContract: process.env.WDK_USDT_CONTRACT ?? '',
    // Bounded Remediation (WDK Fund-Moving Safety, 2026-09-08) —
    // wdk-execution-truth.ts's bounded receipt-confirmation wait after a
    // fresh broadcast: attempts * intervalMs = ~30s default, well inside
    // Sepolia's own ~12s block time for at least one real chance to
    // observe inclusion within a single request/response cycle, without
    // an unbounded or background poll (no worker authorized). Not a
    // confirmation-DEPTH guarantee (1 confirmation, not N) — see that
    // file's own header comment and docs/WDK_FUND_MOVING_OPERATIONS_SAFETY.md
    // for the explicit residual this leaves for future hardening.
    receiptPollAttempts: Number(process.env.WDK_RECEIPT_POLL_ATTEMPTS ?? 10),
    receiptPollIntervalMs: Number(process.env.WDK_RECEIPT_POLL_INTERVAL_MS ?? 3000),
  },

  // MULTISIG SettlementProvider (multisig.provider.ts) — real 2-of-3
  // Bitcoin P2WSH script/PSBT construction against a public block-explorer
  // API. Empty seed by default, same "surface a clear config error, don't
  // refuse to boot" pattern as wdk.seedPhrase above — this provider's own
  // header comment has the full custody-model disclosure (server-derived
  // keys, single-arbiter limitation).
  multisig: {
    seed: process.env.MULTISIG_SEED ?? '',
    network: resolvedMultisigNetwork,
    explorerApiUrl: process.env.MULTISIG_EXPLORER_API_URL ?? 'https://mempool.space/testnet/api',
    requiredConfirmations: resolveMultisigRequiredConfirmations(),
    // Sails Core Implementation Program M8.6 (Execution Cost Semantics) —
    // a deterministic, deployment-wide CEILING on the rail execution cost
    // (Bitcoin miner fee) a MULTISIG settlement transaction may ever
    // imply, expressed as a fee RATE (sat/vByte) rather than an absolute
    // amount, since the real fee scales with transaction size. This is
    // NOT a fee-market-optimality oracle (execution-cost-policy.ts's own
    // header explains the distinction) — it exists solely to bound the
    // "excessive fee as a skim" attack (a translator or compromised
    // explorer response claiming an absurd fee to divert value):
    // multisig.provider.ts's own real fee-rate lookup
    // (fetchFeeRateSatsPerVByte(), mempool.space's `/v1/fees/recommended`)
    // has never had any ceiling at all before this. 200 sat/vB is a
    // deliberately generous default — well above any historically
    // observed real-world Bitcoin fee spike — so this never rejects a
    // legitimate, even unusually expensive, real transaction; it exists
    // to catch a value clearly outside plausible reality, not to
    // second-guess normal fee-market conditions.
    maxFeeRateSatsPerVByte: Number(process.env.MULTISIG_MAX_FEE_RATE_SATS_PER_VBYTE ?? '200'),
    // A pure sat/vByte ceiling alone scales badly for a very small
    // escrow: a generous rate bound (sized for real fee-market spikes)
    // can still represent a large FRACTION of a tiny trade's total
    // value, leaving room for a real, if bounded, skim
    // (execution-cost-policy.ts's own header — the single-beneficiary
    // "COST-18" attack this second, independent, proportional bound
    // closes). Basis points, never a float, matching this codebase's
    // own established money-math discipline.
    //
    // 2000 = 20.00% — deliberately loose, found directly (not assumed)
    // while validating against this repository's own real
    // multisigProvider.test.ts fixture: a genuinely realistic real-fee-
    // spike scenario (50 sat/vB, a small 100,000-sat/~0.001 BTC escrow)
    // already implies a real, honest fee of ~8.2% of gross — a tighter
    // default (5%, this policy's own first draft) would have rejected
    // that as if it were a skim, which mission §15/§19's own explicit
    // "never reject a legitimate, even unusually expensive, real
    // transaction" instruction forbids. This value exists ONLY to bound
    // an extreme, implausible skim (mission §16's own worked example is
    // 50%) on a very small escrow — it is NOT tight enough to catch a
    // moderate (~10%) skim on a small trade, which is honestly
    // indistinguishable from a legitimately high fee during real
    // congestion without an external fee-market oracle (deliberately not
    // introduced, mission §15) — a disclosed, accepted residual, not a
    // silently swept-away gap.
    maxFeeProportionOfGrossBasisPoints: Number(process.env.MULTISIG_MAX_FEE_PROPORTION_BPS ?? '2000'),
    // A minimum, ABSOLUTE floor on the effective ceiling — found directly
    // (not assumed) while validating against this repository's own real
    // dust-policy test fixtures: those deliberately use near-dust escrow
    // amounts (a few hundred sats) to exercise Bitcoin's own dust-relay
    // threshold, where even the cheapest realistic fee (1 sat/vB) is
    // already a large PERCENTAGE of such a tiny total — the proportional
    // bound above would otherwise reject a real, honest, minimal fee on
    // a legitimately tiny escrow, which mission M8.6 §15/§19's own
    // "never reject a legitimate transaction" instruction forbids. This
    // floor exists purely so the proportional bound never becomes
    // TIGHTER than what any realistic single/double-output transaction
    // fee requires even under normal (non-spike) network conditions —
    // it does not weaken the rate or proportional bounds for any escrow
    // large enough that 20%/200sat-vB already exceeds it.
    minFeeFloorSats: Number(process.env.MULTISIG_MIN_FEE_FLOOR_SATS ?? '10000'),
    // docs/TECHNICAL_DEBT_AUDIT.md #51 (F1) — bounded liveness for the
    // explorer API. Every live call in this provider must resolve or
    // fail within this ceiling; whether a given call may then be safely
    // retried is decided per-call-site in multisig.provider.ts, never
    // here (a read may retry, a broadcast never does).
    explorerRequestTimeoutMs: requiredPositiveInt('MULTISIG_EXPLORER_TIMEOUT_MS', 8000),
  },

  // LIGHTNING_HODL SettlementProvider (lightning-hodl.provider.ts) — real
  // Arkade (Ark protocol) VTXO/Taproot script construction and signing.
  // Empty seed by default, same pattern as wdk.seedPhrase/multisig.seed
  // above. Defaults point at Ark Labs' own public mutinynet deployment —
  // confirmed reachable (real getInfo()/getVtxos() responses) before this
  // config was added, not assumed. See that file's own header comment for
  // the full custody-model and release/refund verification-scope
  // disclosure.
  arkade: {
    seed: process.env.ARKADE_SEED ?? '',
    asp: process.env.ARKADE_ASP_URL ?? 'https://mutinynet.arkade.sh',
    explorerApiUrl: process.env.ARKADE_EXPLORER_API_URL ?? 'https://mempool.mutinynet.arkade.sh/api',
  },

  // SAFE_GUARD_EVM SettlementProvider (safe-guard-evm.provider.ts, RFC-020)
  // — a Safe Transaction Guard + ERC-4337 escrow whose arbiter co-signer
  // key lives in AWS KMS, never in this process. Empty kmsKeyId by
  // default, same "surface a clear config error, don't refuse to boot"
  // pattern as wdk.seedPhrase/multisig.seed/arkade.seed above — without a
  // real AWS_KMS_KEY_ID the disputed-release/refund path throws a real
  // AWS auth/network error the first time it's actually exercised, not a
  // fabricated one. chainId/entryPointAddress default to Sepolia + the
  // real, well-known canonical ERC-4337 v0.7 EntryPoint address (same one
  // used throughout `packages/sails-sdk/src/custody/evm-4337.ts`'s own
  // tests) — inert public values, safe to ship as defaults.
  // rpcUrl defaults to the same public Sepolia RPC `wdk.rpcUrl` already
  // uses, for the same reason. bundlerUrl has no project precedent to
  // match (ERC-4337 bundlers are their own distinct infra, not served by
  // a plain RPC) — empty by default, same "clear config error, don't
  // refuse to boot" pattern, surfaced only when broadcast() is actually
  // reached. The four contract addresses below are real, canonical,
  // chain-agnostic deployments (Safe v1.4.1 / Safe4337Module v0.3.0) —
  // verified live against Sepolia (`eth_getCode`, all five non-empty)
  // before being hardcoded here, and `safeProxy.creationCode` (used for
  // CREATE2 address prediction) was verified byte-for-byte identical to
  // the real deployed factory's own `proxyCreationCode()` return value
  // via a live `eth_call`, not merely copied from the installed npm
  // package on trust. `deterministicDeployer` is the well-known
  // Arachnid/EIP-2470-style singleton factory (same address on every EVM
  // chain that has it deployed, including Sepolia — also verified live)
  // used to deploy `SailsEscrowSafe` itself deterministically, so its
  // address can be predicted off-chain before the Safe exists and baked
  // into the Safe's own guard-setup step later.
  safeGuardEvm: {
    chainId: BigInt(process.env.SAFE_GUARD_EVM_CHAIN_ID ?? '11155111'),
    entryPointAddress: process.env.SAFE_GUARD_EVM_ENTRY_POINT ?? '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
    kmsKeyId: process.env.AWS_KMS_KEY_ID ?? '',
    kmsRegion: process.env.AWS_REGION ?? 'us-east-1',
    rpcUrl: process.env.SAFE_GUARD_EVM_RPC_URL ?? 'https://sepolia.drpc.org',
    bundlerUrl: process.env.SAFE_GUARD_EVM_BUNDLER_URL ?? '',
    safeProxyFactory: process.env.SAFE_GUARD_EVM_PROXY_FACTORY ?? '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67',
    safeSingleton: process.env.SAFE_GUARD_EVM_SINGLETON ?? '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762',
    safe4337Module: process.env.SAFE_GUARD_EVM_4337_MODULE ?? '0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226',
    safeModuleSetup: process.env.SAFE_GUARD_EVM_MODULE_SETUP ?? '0x2dd68b007B46fBe91B9A7c3EDa5A7a1063cB5b47',
    multiSendCallOnly: process.env.SAFE_GUARD_EVM_MULTISEND_CALL_ONLY ?? '0x9641d764fc13c8B624c04430C7356C1C7C8102e2',
    deterministicDeployer: process.env.SAFE_GUARD_EVM_DETERMINISTIC_DEPLOYER ?? '0x4e59b44847b379578588920ca78fbf26c0b4956c',
    // docs/TECHNICAL_DEBT_AUDIT.md #51 (F1) — bounded liveness for both
    // the RPC (ethers JsonRpcProvider reads) and the bundler (raw fetch
    // submission). Retry policy is decided per-call-site in
    // safe-guard-evm.provider.ts, never here.
    rpcRequestTimeoutMs: requiredPositiveInt('SAFE_GUARD_EVM_RPC_TIMEOUT_MS', 8000),
  },
}

// RT-001's fix, made structural instead of relying on someone remembering
// to check .env before deploying: refuse to boot with mock settlement in
// production. This is not a warning — it is a hard stop.
if (config.isProduction && config.features.mockEscrow) {
  throw new Error(
    'FATAL: NODE_ENV=production but MOCK_ESCROW is not explicitly false. ' +
    'Refusing to boot — see RED_TEAM_REVIEW.md RT-001. Set MOCK_ESCROW=false ' +
    'in your production environment once a real SettlementProvider is wired in.'
  )
}

// Issue #303 - Capability Authority is a production-eligibility invariant.
// Supersedes Missao 06.5's "explicitly set, true or false" rule: a production
// process may boot ONLY with ENFORCE_CAPABILITIES exactly 'true'. Unset,
// 'false', or any other value is fatal. Dev/test/reference environments are
// unaffected and may still run with enforcement disabled (ADR-004 s9 remains
// true outside production). Reads process.env directly so a typo such as
// 'TRUE' or '1' is rejected instead of silently collapsing to false.
if (config.isProduction && process.env.ENFORCE_CAPABILITIES !== 'true') {
  throw new Error(
    'FATAL: NODE_ENV=production requires ENFORCE_CAPABILITIES=true (got ' +
    (process.env.ENFORCE_CAPABILITIES === undefined ? 'unset' : `'${process.env.ENFORCE_CAPABILITIES}'`) +
    '). Capability Authority cannot be disabled in production - see ' +
    'docs/adr/ADR-004-capability-grant-temporal-authority.md (Issue #303 amendment). ' +
    'Participants obtain the canonical grants through the SDK (capabilities.ensureCanonicalGrants).'
  )
}

// Missão 11 Fase 8.1 LB-04 — promoted from a console.warn to the same
// hard-stop RT-001 above already gives MOCK_ESCROW. Warning-only was a
// real, dangerous asymmetry: MOCK_ESCROW=false + MOCK_SETTLEMENT left at
// its default-true means real funds get locked into a real escrow while
// release/refund/split is a silent no-op — an operator who only checked
// for RT-001's own fatal error (and never saw a mere warning line in a
// noisy startup log) could boot exactly this configuration in
// production. No warning-only path remains for this combination.
if (config.isProduction && !config.features.mockEscrow && config.features.mockSettlement) {
  throw new Error(
    'FATAL: NODE_ENV=production, MOCK_ESCROW=false, but MOCK_SETTLEMENT is not explicitly false. ' +
    'This combination would lock real funds into escrow while settlement (release/refund/split) is a ' +
    'no-op. Refusing to boot — see Missão 11 Fase 8.1 LB-04. Set MOCK_SETTLEMENT=false.'
  )
}

// Missão 11 Fase 8.1 LB-01 — the concrete, evidenced misconfiguration
// this catches: an operator flips MULTISIG_NETWORK to mainnet but never
// updates MULTISIG_EXPLORER_API_URL away from its testnet-pointed
// default, so every funding/confirmation query would silently ask the
// wrong chain's explorer about a real mainnet address (funds would
// simply never be recognized as locked — a "stuck," not stolen, failure,
// but a real one). A substring heuristic on the explorer URL, not
// exhaustive network detection — it exists specifically to catch
// "left the default unedited," the exact scenario found during the
// Fase 8.0 audit, not to validate arbitrary custom explorer URLs.
if (config.multisig.network === 'mainnet' && config.multisig.explorerApiUrl.toLowerCase().includes('testnet')) {
  throw new Error(
    `FATAL: MULTISIG_NETWORK=mainnet but MULTISIG_EXPLORER_API_URL ('${config.multisig.explorerApiUrl}') ` +
    'still looks like a testnet explorer endpoint. Refusing to boot with a contradictory Bitcoin network ' +
    'configuration — see Missão 11 Fase 8.1 LB-01. Set MULTISIG_EXPLORER_API_URL to a real mainnet explorer.'
  )
}

// Missão 11 Fase 9.1.1 §4 — CTO decision, frozen: WDK_USDT_EVM
// (wdk-settlement.provider.ts) is a SERVER-CUSTODIAL REFERENCE
// IMPLEMENTATION / PRODUCTION-INELIGIBLE — one server-held seed can move
// every escrow it funds (that provider's own header comment, RFC-019).
// It must never become the active settlement authority for real
// production value through configuration alone. This is the smallest
// fail-closed protection for that: in production, a real (non-empty)
// WDK_SEED_PHRASE combined with MOCK_ESCROW=false (the two conditions
// that together make this provider actually reachable and capable of
// moving funds — see wdk-settlement.provider.ts's own getWallet()) is a
// FATAL boot-time refusal, same "refuse to boot, don't silently allow
// it and fail unpredictably later" pattern every other production gate
// in this file already uses (RT-001, LB-01, LB-04). Deliberately does
// NOT try to distinguish a testnet-pointed WDK_RPC_URL from a
// mainnet-pointed one — wdk-settlement.provider.ts's own header comment
// already discloses that boundary "is enforced by config... and by
// convention, not by code, since the provider has no way to distinguish
// 'testnet with worthless tokens' from 'mainnet with real USDT'"; rather
// than build an unreliable RPC-URL heuristic, this gate refuses the
// entire provider in production outright, regardless of which network
// its RPC happens to point at — the CTO's own frozen decision is that
// WDK_USDT_EVM is production-ineligible categorically, not "ineligible
// only on mainnet." Local dev/test/staging (NODE_ENV != production) is
// completely unaffected — `npm run demo:pix-to-usdt`'s real testnet
// rehearsal keeps working exactly as before.
if (config.isProduction && !config.features.mockEscrow && config.wdk.seedPhrase !== '') {
  throw new Error(
    'FATAL: NODE_ENV=production, MOCK_ESCROW=false, and WDK_SEED_PHRASE is configured. ' +
    'WDK_USDT_EVM is a server-custodial reference implementation and is production-ineligible ' +
    '— see docs/rfcs/RFC-019-settlement-custody-reference-vs-normative.md and Missão 11 Fase 9.1.1 §4. ' +
    'Refusing to boot. Unset WDK_SEED_PHRASE in production, or use it only in a non-production environment.'
  )
}

// Issue #265 — LocalFilesystemEvidenceProvider (evidence-provider.ts) is a
// dev/reference implementation only: no multi-instance story (#234's own
// audit found docs/DEPLOYMENT.md's Multi-Instance Deployment section never
// mentions evidence storage at all), no durability across container
// restart/redeploy (App Runner, the documented production target, has no
// persistent volume for the app container — evidenceStorageDir defaults to
// a path on the container's own ephemeral disk). Same "refuse to boot,
// don't silently allow it and fail unpredictably later" pattern RT-001/
// LB-01/LB-04/the WDK guard above already use — a production deployment
// must never silently write real evidence bytes to disk that vanishes on
// the next redeploy.
if (config.isProduction && config.proof.evidenceProviderType === 'local-fs') {
  throw new Error(
    'FATAL: NODE_ENV=production but EVIDENCE_PROVIDER is unset (or "local-fs"). ' +
    'LocalFilesystemEvidenceProvider is a dev/reference implementation only — refusing to boot ' +
    'with production evidence silently written to ephemeral container-local disk. ' +
    'Set EVIDENCE_PROVIDER=s3 and configure EVIDENCE_S3_BUCKET/EVIDENCE_S3_ACCESS_KEY_ID/' +
    'EVIDENCE_S3_SECRET_ACCESS_KEY (see src/modules/open-proof/s3-evidence-provider.ts).'
  )
}
if (config.isProduction && config.proof.evidenceProviderType === 's3') {
  const missing = (['bucket', 'accessKeyId', 'secretAccessKey'] as const).filter(
    (key) => config.proof.evidenceS3[key] === ''
  )
  if (missing.length > 0) {
    throw new Error(
      `FATAL: NODE_ENV=production, EVIDENCE_PROVIDER=s3, but EVIDENCE_S3_${missing[0].replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()} ` +
      `is not set (missing: ${missing.join(', ')}). Refusing to boot — a production evidence provider ` +
      'must be fully configured, not partially wired. See src/modules/open-proof/s3-evidence-provider.ts.'
    )
  }
}
