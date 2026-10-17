/**
 * #235 R7H-E2 — live smoke test of the BTC/USD price sources (not part of CI: it depends on the exchanges).
 *
 *   npm run price:smoke
 *
 * Queries every production source once through the production adapters, applies the agreeing-set selection under
 * the policy version in force (read from DATABASE_URL), and prints what a collector would publish. Read only: it
 * never writes a quote.
 */
import 'dotenv/config'
import { Pool } from 'pg'
import { DEFAULT_PRICE_SOURCES, assertIndependentSources, isObservation, observe } from '../src/modules/open-valuation/price-sources'
import { selectAgreeingSet, type QuotePolicy } from '../src/modules/open-valuation/quote-selection'

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgresql://postgres:password@localhost:5432/sails_protocol' })
  try {
    const { rows: [policy] } = await pool.query(
      `SELECT version, "quoteWindowSeconds", "quotePublicationMaxSeconds", "maxSourceDisagreementBps", "minAgreeingOperators", "sourceMaxAgeSeconds", "sourceFutureSkewSeconds"
       FROM trade_limit_policy_versions WHERE id = trade_limit_effective_policy_version(clock_timestamp() AT TIME ZONE 'UTC')`,
    )
    if (!policy) throw new Error('no trade-limit policy version is in force on this database')
    assertIndependentSources(DEFAULT_PRICE_SOURCES)
    const asOf = new Date()
    const started = process.hrtime.bigint()
    const clock = () => new Date(asOf.getTime() + Number(process.hrtime.bigint() - started) / 1e6)
    const results = await Promise.all(DEFAULT_PRICE_SOURCES.map(async (s) => ({ source: s, result: await observe(s, 3000, clock) })))
    for (const { source, result } of results) {
      console.log(isObservation(result)
        ? `${source.operator.padEnd(9)} ${source.reserve ? 'reserve' : 'primary'}  ${result.price.toFixed().padStart(12)} USD  source age ${result.sourceTimestamp ? `${((asOf.getTime() - result.sourceTimestamp.getTime()) / 1000).toFixed(1)} s` : 'n/a (no timestamp)'}  answered after ${result.collectedAt.getTime() - asOf.getTime()} ms`
        : `${source.operator.padEnd(9)} ${source.reserve ? 'reserve' : 'primary'}  FAILED: ${result.reason}`)
    }
    const observations = results.map((r) => r.result).filter(isObservation)
    const reserve = new Set(DEFAULT_PRICE_SOURCES.filter((s) => s.reserve).map((s) => s.operator))
    let selection = selectAgreeingSet(asOf, observations.filter((o) => !reserve.has(o.operator)), policy as QuotePolicy)
    if (!selection.ok) selection = selectAgreeingSet(asOf, observations, policy as QuotePolicy)
    console.log(`\npolicy v${policy.version}: ${JSON.stringify(selection.ok ? { accepted: selection.accepted.map((o) => o.operator), ...selection.summary, excluded: selection.excluded } : selection)}`)
    console.log(`elapsed ${clock().getTime() - asOf.getTime()} ms (publication bound ${policy.quotePublicationMaxSeconds} s)`)
    process.exitCode = selection.ok ? 0 : 1
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
