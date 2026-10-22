import Fastify, { FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import websocket from '@fastify/websocket'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { ZodError } from 'zod'

import { config } from './config'
import { prisma } from './common/database'
import { connectDatabase } from './common/database'
import { redis } from './common/redis'
import { connectRedis } from './common/redis'
import { AppError, ERROR_DOCS_URL } from './common/errors'
import { registerEventHandlers } from './common/events/handlers'
import { eventBus } from './common/events/event-bus'
import { intentEngine } from './core/intent-engine'
import { OpenP2PTradeIntentHandler } from './modules/open-p2p/intent-handler'
import { intentRoutes } from './core/intent.routes'
import { identityRoutes } from './modules/open-identity/identity.routes'
import { liquidityRoutes } from './modules/open-liquidity/liquidity.routes'
import { tradeRoutes } from './modules/open-p2p/trade.routes'
import { chatRoutes } from './modules/open-p2p/chat.routes'
import { settlementRoutes } from './modules/open-settlement/settlement.routes'
import { peerRoutes } from './infrastructure/p2p/pear.routes'
import { relayRoutes } from './infrastructure/p2p/relay.routes'
import { reputationRoutes } from './modules/open-reputation/reputation.routes'
import { capabilityRoutes } from './modules/open-agents/capability.routes'
import { agentRoutes } from './modules/open-agents/agent.routes'
import { proofRoutes } from './modules/open-proof/proof.routes'
import { escrowService } from './modules/open-settlement/escrow.service'
import { assertArbitrationModeCompatibleWithAvailableRails } from './modules/open-settlement/escrow-providers'
import { getDisputeService } from './modules/open-settlement/dispute.service'
import { sweepMultisigFeeConfirmations } from './modules/open-settlement/multisig-fee-confirmation-job'
import { sweepMultisigFeeReorgs } from './modules/open-settlement/multisig-fee-reorg-sweep'
import { sweepMultisigFundingReorgs } from './modules/open-settlement/multisig-funding-reorg-sweep'
import { sweepMultisigReleaseReorgs } from './modules/open-settlement/multisig-release-reorg-sweep'
import { metricsRegistry, httpRequestsTotal, httpRequestDurationSeconds } from './common/metrics'
import { recordSuspiciousActivity } from './common/security/suspicious-activity'
import type { AuthenticatedRequest } from './common/middleware/auth'
import packageJson from '../package.json'

// TECHNICAL_DEBT_AUDIT.md item 17 — '0.1.0' was hardcoded 4 times below,
// independently of package.json's own version, and had already drifted
// stale (package.json is 0.1.1). Reading it from the one real source
// means this can't silently drift again.
const API_VERSION = packageJson.version
export const HTTP_BODY_LIMIT_BYTES = 1024 * 1024

export interface BuildAppOptions {
  // Technical Debt #57 bounded remediation (2026-09-10). @fastify/swagger
  // (OpenAPI spec generation, below) is never gated by this option — it
  // has no meaningful registration cost and every route's OpenAPI schema
  // metadata still needs it. @fastify/swagger-ui performs real
  // asynchronous bootstrap work (fs.readFile + require() on every
  // buildApp() call) and appears on the observed TD #57 failure path —
  // its marginal causal contribution to the historical timeout has not
  // been isolated (docs/TECHNICAL_DEBT_AUDIT.md #57). This option allows
  // test callers that do not exercise the documentation UI to skip that
  // unrelated bootstrap work while preserving the default
  // development/production behavior. Defaults to `true` — identical to
  // this option not existing at all — so `startServer()`'s real boot
  // path and every existing caller that doesn't pass this option keep
  // exactly today's behavior; no test's outcome changes unless it
  // explicitly opts out.
  registerSwaggerUi?: boolean
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const { registerSwaggerUi = true } = options

  // Missão 11 Fase 7.3.2 §1 (CTO-approved) — rail-capability validation,
  // evaluated once, unconditionally, before anything else boots. See
  // escrow-providers.ts's own comment on this function for why it lives
  // there (SCRIPT_COMMITTED_ARBITER_RAILS) rather than as a config/
  // index.ts module-load-time throw alongside RT-001.
  assertArbitrationModeCompatibleWithAvailableRails(
    config.settlement.arbitrationMode,
    config.settlement.arbitrationPolicyByEscrowType,
  )

  const app = Fastify({
    bodyLimit: HTTP_BODY_LIMIT_BYTES,
    logger: {
      level: config.app.logLevel,
      transport:
        config.app.env === 'development'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
      // PRODUCTION_READINESS_FIXES.md P1 item 9, closed 2026-08-08 —
      // Bearer tokens/cookies were logged verbatim on every request log
      // line. Redacted, not dropped: the header still shows up as
      // '[REDACTED]' so a real auth bug (missing header entirely) stays
      // visible in the logs.
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'token'],
        censor: '[REDACTED]',
      },
    },
  })

  // ── Plugins ────────────────────────────────────────────────────────────────
  // CTO_DUE_DILIGENCE_REPORT.md B-SEC-01, closed 2026-08-08 — `origin: true`
  // reflected any Origin header back, letting any site call this API with a
  // logged-in user's own credentials. `false` (not `true`) in production
  // when no allowlist is configured — fail closed, not fail open, the same
  // "safe default, loud about what's missing" pattern RT-001 already uses
  // for MOCK_ESCROW. Non-production keeps the permissive default so
  // `docker compose up` onboarding needs no extra env var.
  if (config.isProduction && config.cors.allowedOrigins.length === 0) {
    app.log.warn(
      'CORS_ALLOWED_ORIGINS is not set in production — denying all cross-origin ' +
      'browser requests by default. Set it to a comma-separated list of allowed origins.'
    )
  }
  await app.register(cors, {
    origin: config.isProduction ? config.cors.allowedOrigins : true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  })

  // CTO_DUE_DILIGENCE_REPORT.md B-SEC-04, closed 2026-08-08 — no
  // HSTS/X-Frame-Options/X-Content-Type-Options/CSP anywhere before this.
  // CSP only in production: `/docs` (swagger-ui, registered only when
  // `!config.isProduction` below) needs inline scripts/styles a strict
  // CSP would block, and it's never reachable in production anyway (same
  // gate). `default-src 'none'` — this is a pure JSON API; nothing it
  // serves should ever load a script/style/frame from anywhere.
  await app.register(helmet, {
    contentSecurityPolicy: config.isProduction
      ? { directives: { defaultSrc: ["'none'"], connectSrc: ["'self'"] } }
      : false,
  })

  // THREAT_MODEL.md's previously-unmitigated gap (config's own doc
  // comment has the full reasoning). Global default here; the identity
  // challenge/authenticate routes below layer a much tighter per-route
  // override via `config: { rateLimit: {...} }` — those two are what a
  // credential-stuffing attempt actually hits (RED_TEAM_REVIEW.md RT-002).
  // Each overridden route tracks its own budget independently (verified
  // in tests/rateLimit.test.ts) — /challenge and /authenticate do NOT
  // share one pooled counter, a deliberate simplification for this pass
  // rather than adding a custom shared keyGenerator/store; still a real
  // improvement over no rate limiting at all. Keyed by request.ip by
  // default — a deployment behind a reverse proxy needs Fastify's own
  // `trustProxy` option set separately before that IP reflects the real
  // client, not the proxy.
  //
  // package.json pins @fastify/rate-limit to exactly 11.1.0 (not a
  // caret range) — 11.2.0's normalizeIP() throws
  // `TypeError: Cannot read properties of undefined (reading 'toLowerCase')`
  // whenever request.ip is undefined, which real WebSocket upgrades under
  // Fastify's own test-injection harness (`app.injectWS()`) hit every
  // time, turning the whole handshake into a 500 (confirmed via a real
  // clean install + full suite run, 2026-08-10 — not assumed). Bump only
  // after confirming upstream fixed it.
  await app.register(rateLimit, {
    global: true,
    max: config.rateLimit.max,
    timeWindow: config.rateLimit.timeWindow,
  })

  await app.register(websocket, {
    options: { maxPayload: 1048576 }, // 1MB
  })

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Sails Protocol — Satsails Reference Implementation',
        description: 'Sails OpenP2P module — non-custodial multi-asset P2P marketplace',
        version: API_VERSION,
      },
      tags: [
        { name: 'intent', description: 'Intent Engine — cross-cutting Core, §2' },
        { name: 'open-identity', description: 'Sails OpenIdentity — auth & keypair identity' },
        { name: 'open-liquidity', description: 'Sails OpenLiquidity — offers & discovery' },
        { name: 'open-settlement', description: 'Sails OpenSettlement — escrow state machine' },
        { name: 'open-p2p', description: 'Sails OpenP2P — trades & chat' },
        { name: 'open-reputation', description: 'Sails OpenReputation — reputation system' },
        { name: 'open-agents', description: 'Sails OpenAgents — capability declaration & grants (RFC-013)' },
        { name: 'peers', description: 'P2P node management — Pears start/stop, topic/trade rooms' },
        { name: 'open-proof', description: 'Sails OpenProof — claims, proofs, verification, evidence bundles' },
      ],
    },
  })

  // Dependabot finding (2026-07-27): @fastify/swagger-ui pulls in
  // @fastify/static@9.3.0, which has a real, currently-unpatched
  // route-guard-bypass/path-traversal advisory (GHSA-83w8-p2f5-377r) —
  // no non-major fix exists yet (the fix needs @fastify/static v10,
  // which @fastify/swagger-ui's own latest release still doesn't
  // support). `/docs` was registered unconditionally in every
  // environment with no auth guard — a real, live, unauthenticated
  // attack surface, not a theoretical one. Same `config.isProduction`
  // hard-gate pattern config/index.ts already uses for MOCK_ESCROW: the
  // vulnerable static-file-serving plugin is simply never registered in
  // production, closing the exposure without waiting on an upstream fix.
  // `@fastify/swagger` above (the OpenAPI spec generator, no static file
  // serving) stays registered everywhere — it has no path-traversal
  // surface of its own.
  if (!config.isProduction && registerSwaggerUi) {
    await app.register(swaggerUi, {
      routePrefix: '/docs',
      uiConfig: { docExpansion: 'list', deepLinking: false },
    })
  }

  // ── Metrics (CTO_DUE_DILIGENCE_REPORT.md B-OPS-01, closed 2026-08-08) ─────
  // `request.routeOptions.url` is the route *pattern* (e.g.
  // `/v1/settlement/escrow/:id/dispute`), not the real URL with params
  // interpolated — using the real URL would give every distinct trade/
  // escrow/dispute id its own label series, an unbounded-cardinality
  // metrics bug. Falls back to 'unmatched' for 404s, which never reach a
  // route so have no routeOptions at all.
  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url ?? 'unmatched'
    const labels = { method: request.method, route, status_code: String(reply.statusCode) }
    httpRequestsTotal.inc(labels)
    httpRequestDurationSeconds.observe(labels, reply.elapsedTime / 1000)

    // 2026-08-15 security review — flags a slow, patient probe a volume
    // rate limiter misses. Keyed by participantId when authenticated (so
    // one identity's failures correlate across IPs), else request.ip.
    // See suspicious-activity.ts for the threshold reasoning.
    const identity = (request as AuthenticatedRequest).participantId ?? request.ip
    if (reply.statusCode === 401) recordSuspiciousActivity('AUTH_FAILURE', identity, app.log)
    else if (reply.statusCode === 404) recordSuspiciousActivity('NOT_FOUND_CLUSTER', identity, app.log)
    else if (reply.statusCode === 429) recordSuspiciousActivity('RATE_LIMITED', identity, app.log)
  })

  if (config.observability.metricsEnabled) {
    app.get('/metrics', async (_request, reply) => {
      reply.header('content-type', metricsRegistry.contentType)
      return metricsRegistry.metrics()
    })
  }

  // ── Error Handler ─────────────────────────────────────────────────────────
  app.setErrorHandler((error, request, reply) => {
    // PRODUCTION_READINESS_FIXES.md P1 item 14, closed 2026-08-08 —
    // request.id (Fastify's own real per-request id, already in every
    // log line) wasn't surfaced to the caller at all, so pointing
    // support at "the request that failed at 14:32" meant grepping logs
    // by timestamp instead of a real, matchable id.
    if (error instanceof ZodError) {
      return reply.code(400).send({
        success: false,
        error: 'VALIDATION_ERROR',
        message: 'Invalid request data',
        details: error.issues, // Zod v4 renamed ZodError.errors -> .issues
        requestId: request.id,
        docsUrl: ERROR_DOCS_URL,
      })
    }

    if (error instanceof AppError) {
      // AppError.toResponse() already builds this shape, including
      // `details` — found while testing intentRoutes.ts (this handler
      // reconstructed the response by hand and silently dropped `details`,
      // making ValidationError's whole point of returning *why* a request
      // was rejected invisible to the caller). Not a change in behavior
      // for AppError subclasses that never set `details` (defaults to []
      // either way) — only for the ones that do, like ValidationError.
      return reply.code(error.statusCode).send({ ...error.toResponse(), requestId: request.id })
    }

    // A well-behaved Fastify plugin error (e.g. @fastify/rate-limit's 429)
    // carries its own real statusCode — found while wiring rate limiting:
    // this handler previously flattened every non-ZodError/non-AppError
    // to 500 unconditionally, silently turning a correct 429 into a
    // misleading 500. Only trust statusCodes in the real 4xx/5xx range
    // (guards against a plugin/library setting something nonsensical);
    // anything else still falls through to the generic 500 below.
    const pluginError = error as { statusCode?: unknown; message?: unknown }
    if (typeof pluginError.statusCode === 'number' && pluginError.statusCode >= 400 && pluginError.statusCode < 600) {
      const statusCode = pluginError.statusCode
      app.log.warn(error)
      return reply.code(statusCode).send({
        success: false,
        error: statusCode === 429 ? 'RATE_LIMIT_EXCEEDED' : 'REQUEST_ERROR',
        message: typeof pluginError.message === 'string' ? pluginError.message : 'Request error',
        details: [],
        requestId: request.id,
        docsUrl: ERROR_DOCS_URL,
      })
    }

    app.log.error(error)
    const message = error instanceof Error ? error.message : String(error)
    return reply.code(500).send({
      success: false,
      error: 'INTERNAL_ERROR',
      message: config.app.env === 'development' ? message : 'Internal server error',
      requestId: request.id,
      docsUrl: ERROR_DOCS_URL,
    })
  })

  // ── Health check ──────────────────────────────────────────────────────────
  app.get('/health/live', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: API_VERSION,
    protocol: 'Sails Protocol',
    module: 'Sails OpenP2P',
    referenceImplementation: 'Satsails Wallet',
  }))

  app.get('/health/ready', async (_request, reply) => {
    const checks: Record<string, { ok: boolean; latencyMs: number }> = {}

    const timed = async <T,>(label: string, fn: () => Promise<T>) => {
      const start = Date.now()
      try {
        await fn()
        checks[label] = { ok: true, latencyMs: Date.now() - start }
      } catch (err) {
        app.log.error({ err, dependency: label }, 'Readiness dependency unavailable')
        checks[label] = {
          ok: false,
          latencyMs: Date.now() - start,
        }
      }
    }

    await timed('postgres', () => prisma.$queryRaw`SELECT 1`)
    await timed('redis', async () => {
      const pong = await redis.ping()
      if (pong !== 'PONG') throw new Error(`unexpected PING reply: ${pong}`)
    })

    const allOk = Object.values(checks).every((c) => c.ok)
    return reply.code(allOk ? 200 : 503).send({
      status: allOk ? 'ready' : 'not_ready',
      timestamp: new Date().toISOString(),
      checks,
    })
  })

  app.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: API_VERSION,
    protocol: 'Sails Protocol',
    module: 'Sails OpenP2P',
    referenceImplementation: 'Satsails Wallet',
    ...(config.isProduction
      ? {}
      : {
          features: {
            mockEscrow: config.features.mockEscrow,
            mockSettlement: config.features.mockSettlement,
          },
        }),
  }))

  app.get('/', async () => ({
    name: 'Sails OpenP2P',
    protocol: 'Sails Protocol — Open Coordination Protocol for Sovereign Finance',
    referenceImplementation: 'Satsails Wallet',
    docs: !config.isProduction && registerSwaggerUi ? '/docs' : null, // see this route's own registration above for why
    ws: '/ws?userId=<uuid>',
    version: API_VERSION,
  }))

  // ── Routes ─────────────────────────────────────────────────────────────────
  await app.register(intentRoutes)
  await app.register(identityRoutes)
  await app.register(peerRoutes)
  await app.register(relayRoutes)
  await app.register(liquidityRoutes)
  await app.register(tradeRoutes)
  await app.register(chatRoutes)
  await app.register(settlementRoutes)
  await app.register(reputationRoutes)
  await app.register(capabilityRoutes)
  await app.register(agentRoutes)
  await app.register(proofRoutes)

  // ── Register event handlers (Coordination Protocol) ──────────────────────
  registerEventHandlers()

  // ── Register Intent handlers (Intent Engine plugin pattern, §2.7) ────────
  // RFC-018 Phase 3 — the Core never imports a module; modules register
  // themselves. OpenP2P is the only module with a real IntentHandler today.
  intentEngine.registerHandler(OpenP2PTradeIntentHandler)

  return app
}

export async function startServer() {
  const app = await buildApp()

  // ── Connect dependencies ───────────────────────────────────────────────────
  await connectDatabase()
  await connectRedis()

  // Missão 08B — cross-instance event fan-out. Deliberately only wired
  // here (the real boot path), never in buildApp() itself — every test
  // calls buildApp() directly and would otherwise attempt a real Redis
  // pub/sub connection. A no-op for InMemoryEventStore-backed buses (see
  // SailsEventBus.enableCrossInstanceFanout()'s own comment); for the real
  // PostgresEventStore-backed eventBus, opens a dedicated duplicate()
  // connection and subscribes so this instance's own local handlers
  // (TRADE_STATUS_UPDATE/ESCROW_STATUS_UPDATE/NEW_MESSAGE/reputation
  // updates, everything registered in handlers.ts/chat.routes.ts) fire for
  // events published by ANY instance, not only this one.
  eventBus.enableCrossInstanceFanout(redis)

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  // PRODUCTION_READINESS_FIXES.md P1 item 15, closed 2026-08-08 —
  // app.close() stops accepting new requests and drains in-flight ones,
  // but never explicitly closed the Postgres pool or the Redis
  // connection; both relied on the process exiting to clean them up
  // implicitly. Explicit here so a container orchestrator's SIGTERM ->
  // graceful-shutdown path leaves no dangling connections on the DB/
  // Redis side even if something delays the actual process exit.
  const shutdown = async (signal: string) => {
    app.log.info({ msg: 'Shutting down gracefully', signal })
    await app.close()
    await eventBus.disableCrossInstanceFanout()
    await prisma.$disconnect()
    await redis.quit()
    process.exit(0)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  await app.listen({ port: config.app.port, host: config.app.host })
  // PRODUCTION_READINESS_FIXES.md P0 item 8, closed 2026-08-08 — every
  // OTHER console.* call in this function migrated to app.log below.
  // This one boot banner stays console.log on purpose: it's pure ASCII-art
  // decoration for a human watching stdout on cold start, not structured
  // operational data — wrapping it in pino's JSON output (what production
  // actually emits) would make it unreadable, a regression, not a fix.
  console.log(`
╔══════════════════════════════════════════════════════╗
║      Sails OpenP2P — Satsails Reference Impl.        ║
╠══════════════════════════════════════════════════════╣
║  HTTP  → http://${config.app.host}:${config.app.port}                   ║
║  WS    → ws://${config.app.host}:${config.app.port}/ws?userId=<uuid>    ║
║  DHT   → POST /peer/start (HyperDHT node)              ║${
    config.isProduction ? '' : `\n║  Docs  → http://${config.app.host}:${config.app.port}/docs              ║`
  }
╚══════════════════════════════════════════════════════╝
  `)

  // RFC-019 Phase 1 (rfcs/RFC-019-settlement-custody-reference-vs-normative.md)
  // — a loud, impossible-to-miss boot warning whenever the real WDK
  // provider is active. `WdkSettlementProvider.custodyModel` is the
  // introspectable form of this same fact; this is the human-visible
  // one, since a boot log is what someone actually deploying this
  // reference implementation is most likely to see.
  if (!config.features.mockEscrow) {
    app.log.warn(
      'WDK_USDT_EVM is a SERVER-CUSTODIAL REFERENCE IMPLEMENTATION. ' +
      'One server-held seed (WDK_SEED_PHRASE) signs every escrow lock/release — ' +
      "this is NOT the protocol's normative custody model. Do NOT use with real " +
      'value at risk. See CRYPTOGRAPHIC_MODEL.md §5 and ' +
      'rfcs/RFC-019-settlement-custody-reference-vs-normative.md.'
    )
  }

  // BACKLOG.md P0, "Escrow timelock proactive sweeper" — off by default,
  // see config/index.ts's own comment for why. `unref()`'d so a running
  // sweeper never keeps the process alive on its own; the process's
  // normal `shutdown()` above already calls `process.exit(0)` directly,
  // which terminates regardless of any pending interval either way.
  if (config.features.escrowTimelockSweeper) {
    const sweepInterval = setInterval(() => {
      escrowService.sweepExpiredEscrows()
        .then(({ refunded, requiresManualRecovery, failed }) => {
          if (refunded.length || requiresManualRecovery.length || failed.length) {
            app.log.info({
              msg: 'Escrow sweep completed',
              module: 'escrow-sweeper',
              refunded: refunded.length,
              // Fase 7.3.1 §C — a real, distinguishable outcome, never
              // merged into `failed`: this rail can never be
              // auto-refunded (client-held keys), a dispute is the only
              // real recovery path. Not itself an error condition to
              // alert on the same way `failed` is, but worth its own
              // visible count so an operator can see the backlog.
              requiresManualRecovery: requiresManualRecovery.length,
              failed: failed.length,
            })
          }
        })
        .catch((err) => app.log.error({ msg: 'Escrow sweep failed', module: 'escrow-sweeper', err: err instanceof Error ? err.message : err }))
    }, config.trade.timelockSweepIntervalMs)
    sweepInterval.unref()
  }

  // RFC-021 D8 — off by default, see config/index.ts's own comment.
  // unref()'d for the same reason the escrow sweeper above is.
  if (config.features.disputeAutoResolutionSweeper) {
    const disputeSweepInterval = setInterval(() => {
      getDisputeService().sweepExpiredAutoResolutions()
        .then(({ revertedToHuman, failed }) => {
          if (revertedToHuman.length || failed.length) {
            app.log.info({ msg: 'Dispute auto-resolution sweep completed (advisory-only, Missão 13 Fase 2)', module: 'dispute-auto-resolution-sweeper', revertedToHuman: revertedToHuman.length, failed: failed.length })
          }
        })
        .catch((err) => app.log.error({ msg: 'Dispute auto-resolution sweep failed', module: 'dispute-auto-resolution-sweeper', err: err instanceof Error ? err.message : err }))
    }, config.trade.disputeAutoResolutionSweepIntervalMs)
    disputeSweepInterval.unref()
  }

  // Missão 11 Fase 5 §7 — off by default, see config/index.ts's own
  // comment. unref()'d for the same reason the two sweepers above are.
  // Structurally inert (zero IN_PROGRESS obligations to find) until a real
  // FeePolicyVersion is published for MULTISIG — safe to enable ahead of
  // that.
  if (config.features.multisigFeeConfirmationSweeper) {
    const feeConfirmationInterval = setInterval(() => {
      sweepMultisigFeeConfirmations()
        .then(({ collected, stillPending, failed }) => {
          if (collected.length || failed.length) {
            app.log.info({ msg: 'MULTISIG fee confirmation sweep completed', module: 'multisig-fee-confirmation-sweeper', collected: collected.length, stillPending: stillPending.length, failed: failed.length })
          }
        })
        .catch((err) => app.log.error({ msg: 'MULTISIG fee confirmation sweep failed', module: 'multisig-fee-confirmation-sweeper', err: err instanceof Error ? err.message : err }))
    }, config.trade.multisigFeeConfirmationSweepIntervalMs)
    feeConfirmationInterval.unref()
  }

  // Missão 11 Fase 8.1 LB-08 — off by default, same reasoning as the
  // sweepers above. Structurally inert until a real COLLECTED/DISTRIBUTED
  // MULTISIG obligation exists — safe to enable ahead of that.
  if (config.features.multisigFeeReorgSweeper) {
    const feeReorgInterval = setInterval(() => {
      sweepMultisigFeeReorgs()
        .then(({ reverted, flaggedDistributed, failed }) => {
          if (reverted.length || flaggedDistributed.length || failed.length) {
            app.log.info({ msg: 'MULTISIG fee reorg sweep completed', module: 'multisig-fee-reorg-sweeper', reverted: reverted.length, flaggedDistributed: flaggedDistributed.length, failed: failed.length })
          }
        })
        .catch((err) => app.log.error({ msg: 'MULTISIG fee reorg sweep failed', module: 'multisig-fee-reorg-sweeper', err: err instanceof Error ? err.message : err }))
    }, config.trade.multisigFeeReorgSweepIntervalMs)
    feeReorgInterval.unref()
  }

  // Missão 11 Fase 8.1 LB-08(A) — off by default, same reasoning. Detects
  // only; see multisig-funding-reorg-sweep.ts's own header comment for
  // why it does not change Escrow.status.
  if (config.features.multisigFundingReorgSweeper) {
    const fundingReorgInterval = setInterval(() => {
      sweepMultisigFundingReorgs()
        .then(({ reverted, reconfirmed, replacementObserved, failed }) => {
          if (reverted.length || reconfirmed.length || replacementObserved.length || failed.length) {
            app.log.info({
              msg: 'MULTISIG funding reorg sweep completed', module: 'multisig-funding-reorg-sweeper',
              reverted: reverted.length, reconfirmed: reconfirmed.length, replacementObserved: replacementObserved.length, failed: failed.length,
            })
          }
        })
        .catch((err) => app.log.error({ msg: 'MULTISIG funding reorg sweep failed', module: 'multisig-funding-reorg-sweeper', err: err instanceof Error ? err.message : err }))
    }, config.trade.multisigFundingReorgSweepIntervalMs)
    fundingReorgInterval.unref()
  }

  // Sails Core Implementation Program M9-F — off by default, same
  // reasoning as the sweepers above. Closes C18: detects a reorg on the
  // MAIN MULTISIG release/refund/split payout (never previously
  // monitored at all — only the fee sub-output was). Detection +
  // durable evidence recording only; see that sweep's own header
  // comment for why it never attempts an automatic rebroadcast.
  if (config.features.multisigReleaseReorgSweeper) {
    const releaseReorgInterval = setInterval(() => {
      sweepMultisigReleaseReorgs()
        .then(({ reconfirmed, requiresManualReview, failed }) => {
          if (reconfirmed.length || requiresManualReview.length || failed.length) {
            app.log.info({
              msg: 'MULTISIG release-leg reorg sweep completed', module: 'multisig-release-reorg-sweeper',
              reconfirmed: reconfirmed.length, requiresManualReview: requiresManualReview.length, failed: failed.length,
            })
          }
        })
        .catch((err) => app.log.error({ msg: 'MULTISIG release-leg reorg sweep failed', module: 'multisig-release-reorg-sweeper', err: err instanceof Error ? err.message : err }))
    }, config.trade.multisigReleaseReorgSweepIntervalMs)
    releaseReorgInterval.unref()
  }

  return app
}
