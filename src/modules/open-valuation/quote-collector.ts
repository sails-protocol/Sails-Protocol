/**
 * #235 R7H-E2 — the BTC/USD price collector: every node may run one; together they publish one canonical quote
 * per window.
 *
 * One collection:
 *   1. Reads the database clock and the policy version in force. asOf = that clock: every node and the database
 *      share one time base, and a node's own clock skew cannot date a quote.
 *   2. Skips the window when its canonical quote already exists (no source is queried).
 *   3. Queries every source concurrently, each bounded by its timeout, outside any transaction. Observation times
 *      are asOf plus monotonic elapsed time.
 *   4. Selects the agreeing set (quote-selection.ts): primaries first, the reserve only when the primaries alone
 *      do not agree. No agreement, too few sources or ambiguous agreement publishes nothing.
 *   5. Publishes only while still inside the policy's publication bound (with a safety margin); the database
 *      enforces the bound again at insert and at commit.
 * Anything that goes wrong leaves the window without a quote: new authorizations fail closed once the last quote
 * ages out, and nothing about existing escrows depends on a quote.
 *
 * The collector connects with its own credential (QUOTE_COLLECTOR_DATABASE_URL), a member of the
 * sails_quote_collector role: the only role allowed to insert quotes and observations (migration
 * 20261016120000_economic_authority_roles).
 */
import { Pool } from 'pg'
import type { FastifyBaseLogger as Logger } from 'fastify'
import { startGuardedInterval, type GuardedInterval } from '../../common/guarded-interval'
import { assertIndependentSources, DEFAULT_PRICE_SOURCES, isObservation, observe, type PriceSource, type SourceFailure } from './price-sources'
import { selectAgreeingSet, type Exclusion, type QuotePolicy } from './quote-selection'
import { publishCanonicalQuote, quoteIdFor, UTC_TEXT, windowStartOf } from './canonical-quote'

/** Publication stops this long before the policy bound, leaving room for the transaction itself. */
const PUBLICATION_MARGIN_MS = 1_000

export interface CollectorOptions {
  pool: Pool
  sourceTimeoutMs: number
  sources?: readonly PriceSource[]
  asset?: string
}

export interface CollectOutcome {
  status: 'PUBLISHED' | 'LOST_RACE' | 'ALREADY_PUBLISHED' | 'REFUSED' | 'LATE' | 'NO_POLICY' | 'FAILED'
  quoteId?: string
  reason?: string
  accepted?: string[]
  excluded?: Exclusion[]
  failures?: SourceFailure[]
}

export async function collectAndPublish(opts: CollectorOptions): Promise<CollectOutcome> {
  const sources = opts.sources ?? DEFAULT_PRICE_SOURCES
  const asset = opts.asset ?? 'BTC'
  assertIndependentSources(sources)

  const { rows: [ctx] } = await opts.pool.query(
    `SELECT to_char(c.t, ${UTC_TEXT}) AS "asOf", p.id AS "policyVersionId", p."quoteWindowSeconds", p."quotePublicationMaxSeconds",
            p."maxSourceDisagreementBps", p."minAgreeingOperators", p."sourceMaxAgeSeconds", p."sourceFutureSkewSeconds",
            EXISTS (SELECT 1 FROM trade_limit_rail_policies r WHERE r."policyVersionId" = p.id AND r.asset = $1::"AssetType") AS "railAsset"
     FROM (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS t) c
     LEFT JOIN trade_limit_policy_versions p ON p.id = trade_limit_effective_policy_version(c.t)`,
    [asset],
  )
  const started = process.hrtime.bigint()
  if (!ctx.policyVersionId || !ctx.railAsset) return { status: 'NO_POLICY' }
  const policy: QuotePolicy = ctx
  const asOf = new Date(ctx.asOf)
  const clock = () => new Date(asOf.getTime() + Number(process.hrtime.bigint() - started) / 1e6)
  const windowStart = windowStartOf(asOf, policy.quoteWindowSeconds)
  const quoteId = quoteIdFor(asset, windowStart)

  if ((await opts.pool.query(`SELECT 1 FROM valuation_quotes WHERE id = $1`, [quoteId])).rowCount) return { status: 'ALREADY_PUBLISHED', quoteId }

  const results = await Promise.all(sources.map((s) => observe(s, opts.sourceTimeoutMs, clock)))
  const failures = results.filter((r): r is SourceFailure => !isObservation(r))
  const observations = results.filter(isObservation)
  const reserve = new Set(sources.filter((s) => s.reserve).map((s) => s.operator))
  let selection = selectAgreeingSet(asOf, observations.filter((o) => !reserve.has(o.operator)), policy)
  if (!selection.ok && reserve.size) selection = selectAgreeingSet(asOf, observations, policy)
  if (!selection.ok) return { status: 'REFUSED', quoteId, reason: selection.reason, excluded: selection.excluded, failures }

  const accepted = selection.accepted
  const report = { quoteId, accepted: accepted.map((o) => o.operator), excluded: selection.excluded, failures }
  if (clock().getTime() - asOf.getTime() > policy.quotePublicationMaxSeconds * 1000 - PUBLICATION_MARGIN_MS) {
    return { status: 'LATE', reason: `sources answered after ${clock().getTime() - asOf.getTime()} ms`, ...report }
  }
  const collectedAt = new Date(Math.max(...accepted.map((o) => o.collectedAt.getTime())))
  try {
    const status = await publishCanonicalQuote(opts.pool, { policyVersionId: ctx.policyVersionId, asset, windowStart, asOf, collectedAt, summary: selection.summary, observations: accepted })
    return { status, ...report }
  } catch (err) {
    return { status: 'FAILED', reason: err instanceof Error ? err.message : String(err), ...report }
  }
}

/**
 * Refuses a collector credential that cannot publish, and one that can do more than publish (superuser, owner of
 * the quote tables, able to rewrite quotes, or holding application privileges): in production that is fatal, so a
 * misconfigured deployment cannot quietly run the collector as the application.
 */
export async function assertCollectorCredential(pool: Pool, strict: boolean, log: Logger): Promise<void> {
  const { rows: [r] } = await pool.query(
    `SELECT current_user AS role, r.rolsuper AS superuser,
            has_table_privilege('valuation_quotes', 'INSERT') AND has_table_privilege('price_observations', 'INSERT') AS publish,
            has_table_privilege('valuation_quotes', 'UPDATE') OR has_table_privilege('valuation_quotes', 'DELETE') AS rewrite,
            pg_has_role(current_user, (SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'valuation_quotes'), 'MEMBER') AS owner,
            has_table_privilege('trades', 'INSERT') AS application
     FROM pg_roles r WHERE r.rolname = current_user`,
  )
  if (!r.publish) throw new Error(`quote collector credential ${r.role} cannot publish quotes: grant it the sails_quote_collector role`)
  const excess = (['superuser', 'owner', 'rewrite', 'application'] as const).filter((k) => r[k])
  if (excess.length) {
    const msg = `quote collector credential ${r.role} is over-privileged (${excess.join(', ')}): use a login that is only a member of sails_quote_collector`
    if (strict) throw new Error(msg)
    log.warn({ msg, module: 'quote-collector' })
  }
}

export interface QuoteCollector {
  stop: () => Promise<void>
}

export async function startQuoteCollector(log: Logger, opts: { databaseUrl: string; intervalMs: number; sourceTimeoutMs: number; strictCredential: boolean }): Promise<QuoteCollector> {
  const pool = new Pool({ connectionString: opts.databaseUrl, max: 2 })
  try {
    await assertCollectorCredential(pool, opts.strictCredential, log)
  } catch (err) {
    await pool.end()
    throw err
  }
  const interval: GuardedInterval = startGuardedInterval(async () => {
    try {
      const out = await collectAndPublish({ pool, sourceTimeoutMs: opts.sourceTimeoutMs })
      const detail = { module: 'quote-collector', quoteId: out.quoteId, accepted: out.accepted, excluded: out.excluded, failures: out.failures, reason: out.reason }
      if (out.status === 'PUBLISHED') log[out.excluded?.length || out.failures?.length ? 'warn' : 'info']({ msg: 'Canonical quote published', ...detail })
      else if (out.status === 'REFUSED' || out.status === 'LATE' || out.status === 'FAILED' || out.status === 'NO_POLICY') log.warn({ msg: `No canonical quote published (${out.status})`, ...detail })
    } catch (err) {
      log.error({ msg: 'Quote collection failed', module: 'quote-collector', err: err instanceof Error ? err.message : err })
    }
  }, opts.intervalMs)
  return {
    stop: async () => {
      await interval.stop()
      await pool.end()
    },
  }
}
