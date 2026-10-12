/**
 * #235 R7H-E2 — writing and reading the canonical valuation quote (tables and invariants: migration
 * 20261015120000_economic_authority_foundation).
 *
 * Publication is one short transaction, opened only after every source has answered (no transaction is ever held
 * across an HTTP call): the quote row under its deterministic id with ON CONFLICT (id) DO NOTHING, then its
 * observations, then COMMIT. The id is the window's only unique key, so a losing publisher yields instead of
 * failing, and never overwrites the winner. The database re-checks completeness and the publication bound at
 * commit; a crash before COMMIT leaves nothing.
 *
 * Every timestamp crosses the wire as UTC text: the columns are `timestamp without time zone` holding UTC, and
 * node-pg would otherwise read them back as local time.
 */
import type { Pool } from 'pg'
import type { SourceObservation } from './price-sources'
import type { QuoteSummary } from './quote-selection'

export const quoteIdFor = (asset: string, windowStart: Date) => `${asset}:${windowStart.getTime() / 1000}`

export function windowStartOf(asOf: Date, windowSeconds: number): Date {
  const ms = windowSeconds * 1000
  return new Date(Math.floor(asOf.getTime() / ms) * ms)
}

const utc = (d: Date) => d.toISOString().slice(0, 23)

export const UTC_TEXT = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`

export interface CanonicalQuoteInput {
  policyVersionId: string
  asset: string
  windowStart: Date
  asOf: Date
  collectedAt: Date
  summary: QuoteSummary
  observations: readonly SourceObservation[]
}

/** PUBLISHED: this publisher's quote is the window's canonical quote. LOST_RACE: another publisher's already is. */
export async function publishCanonicalQuote(pool: Pool, q: CanonicalQuoteInput): Promise<'PUBLISHED' | 'LOST_RACE'> {
  const id = quoteIdFor(q.asset, q.windowStart)
  const client = await pool.connect()
  let failure: Error | undefined
  try {
    await client.query('BEGIN')
    const inserted = await client.query(
      `INSERT INTO valuation_quotes (id, "policyVersionId", "baseAsset", "windowStart", "asOf", "collectedAt", "priceMaxUsd", "priceMedianUsd", "observationCount", "sourceSpreadBps")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (id) DO NOTHING RETURNING id`,
      [id, q.policyVersionId, q.asset, utc(q.windowStart), utc(q.asOf), utc(q.collectedAt), q.summary.priceMaxUsd, q.summary.priceMedianUsd, q.summary.observationCount, q.summary.sourceSpreadBps],
    )
    if (!inserted.rowCount) {
      await client.query('ROLLBACK')
      return 'LOST_RACE'
    }
    for (const o of q.observations) {
      await client.query(
        `INSERT INTO price_observations (id, "quoteId", operator, "priceUsd", "sourceTimestamp", "collectedAt", "payloadSha256") VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [`${id}:${o.operator}`, id, o.operator, o.price.toFixed(8), o.sourceTimestamp ? utc(o.sourceTimestamp) : null, utc(o.collectedAt), o.payloadSha256],
      )
    }
    await client.query('COMMIT')
    return 'PUBLISHED'
  } catch (err) {
    failure = err instanceof Error ? err : new Error(String(err))
    await client.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    client.release(failure)
  }
}

export interface AuthorizationQuote {
  id: string
  policyVersionId: string
  priceMaxUsd: string
  asOf: Date
}

/**
 * The quote a new authorization may use: the newest canonical quote for the asset, only if it was published under
 * the policy version in force and is still within that version's maximum age — otherwise null, and nothing new
 * can be authorized (fail closed). The same rules exposure_reservations_insert() enforces in the database.
 */
export async function readAuthorizationQuote(db: Pick<Pool, 'query'>, asset = 'BTC'): Promise<AuthorizationQuote | null> {
  const { rows } = await db.query(
    `SELECT q.id, q."policyVersionId", q."priceMaxUsd"::text AS "priceMaxUsd", to_char(q."asOf", ${UTC_TEXT}) AS "asOf",
            q."policyVersionId" = trade_limit_effective_policy_version(clock_timestamp() AT TIME ZONE 'UTC')
              AND (clock_timestamp() AT TIME ZONE 'UTC') - q."asOf" <= make_interval(secs => p."quoteMaxAgeSeconds") AS usable
     FROM valuation_quotes q JOIN trade_limit_policy_versions p ON p.id = q."policyVersionId"
     WHERE q."baseAsset" = $1::"AssetType" ORDER BY q."windowStart" DESC LIMIT 1`,
    [asset],
  )
  const q = rows[0]
  return q?.usable ? { id: q.id, policyVersionId: q.policyVersionId, priceMaxUsd: q.priceMaxUsd, asOf: new Date(q.asOf) } : null
}
