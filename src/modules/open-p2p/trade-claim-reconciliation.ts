/**
 * #235 R7H-NF-E3C-5 (B2, Gate C corrective) — OBSERVATION of LEGACY `openp2p.trade.create` idempotency claims.
 *
 * CTO FREEZE: a legacy IN_PROGRESS claim never becomes COMPLETED merely because a trade matches participant, payload
 * hash and timestamp. Correlation is not causation.
 *
 * Why no attribution is possible. Before B2 a trade and its idempotency claim were two separate commits, so a process
 * that died between them left the claim `IN_PROGRESS` forever (S6). The legacy `trades` row carries no reference to the
 * claim that produced it, and the claim's own `resultRef` was written only by the settlement step that never ran. So no
 * durable causal evidence links a stuck claim to any trade: owner + payload + time only CORRELATE them. The independent
 * audit reproduced exactly the false attributions that inference allows — a claim taking another claim's trade, a
 * keyless trade, a trade of the claimant's own offer made by someone else — and two claims resolving to the same trade
 * under concurrency. This module therefore does not infer, however strong the correlation looks (a single candidate,
 * an exact hash, a few milliseconds apart: still correlation).
 *
 * What it does instead — and it can do nothing else:
 *   - it OBSERVES a legacy IN_PROGRESS claim and appends one immutable audit row saying UNRESOLVED, with the trades the
 *     claim's owner took shortly afterwards as UNVERIFIED hints (`authoritative: false`, correlation only);
 *   - it never writes `idempotency_keys`: the claim stays IN_PROGRESS — not COMPLETED, not FAILED, no `resultRef` — so
 *     the key keeps answering 409 IDEMPOTENCY_OUTCOME_UNKNOWN and can never produce a second trade;
 *   - nothing here accepts an attribution: no trade id goes in, there is no operator override, and the database refuses
 *     any audit decision other than UNRESOLVED (migration 20261018140000);
 *   - observation is idempotent and concurrency-safe by construction: ONE UNRESOLVED row per claim, enforced by a
 *     partial unique index (`ON CONFLICT DO NOTHING`), so concurrent workers and repeated replays cannot duplicate;
 *   - every time comparison is between stored UTC timestamps or an explicit `now() AT TIME ZONE 'UTC'` — never a
 *     session-local `now()` and never a client-side Date — so the database session time zone cannot change what is
 *     observed, recorded or gated.
 *
 * A claim is resolved only by durable causal evidence written by the code that created the trade — which is exactly
 * what B2's atomic admission does (the claim is committed WITH the trade).
 */
import { randomUUID } from 'crypto'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../common/database'
import { TRADE_CREATE_SCOPE } from './trade-repository'

/** The only decision there is. The audit table's CHECK constraint refuses any other value. */
export type ObservationDecision = 'UNRESOLVED'

export interface ObservationOutcome {
  claimId: string
  /** `UNRESOLVED`: observed and recorded; the claim itself is untouched. `SKIPPED`: not a legacy IN_PROGRESS claim of this scope. */
  decision: ObservationDecision | 'SKIPPED'
  /**
   * NON-AUTHORITATIVE hints: trades the claim's OWN owner took (never one of their own offers), of the legacy shape,
   * created shortly after the claim and not referenced by another claim. Correlation only — never proof that this
   * request created any of them, and never used to decide anything.
   */
  unverifiedCandidateTradeIds: string[]
}

/** Relevance window of the hints only. It gates no outcome: nothing in this module has an outcome to gate. */
export const HINT_WINDOW_SECONDS = 30
/** Upper bound on the hints exposed and recorded per claim. */
export const MAX_HINTS = 20

/** A Prisma client or an interactive-transaction client: the two statements this module issues. */
type Db = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>

/**
 * Observes ONE legacy claim. Safe to call concurrently and repeatedly: an already-settled claim, or one of another
 * scope, yields SKIPPED; an unresolved claim yields UNRESOLVED and at most ONE audit row, ever.
 */
export async function observeLegacyTradeClaim(claimId: string, observedBy: string, db: Db = prisma): Promise<ObservationOutcome> {
  const [claim] = await db.$queryRaw<Array<{ id: string; participantId: string }>>`
    SELECT id, "participantId"
    FROM idempotency_keys
    WHERE id = ${claimId} AND scope = ${TRADE_CREATE_SCOPE} AND status = 'IN_PROGRESS'::"IdempotencyKeyStatus"`
  if (!claim) return { claimId, decision: 'SKIPPED', unverifiedCandidateTradeIds: [] }

  // Hints, computed in SQL between STORED timestamps (no client Date, no session-local now()).
  const hints = await db.$queryRaw<Array<{ id: string }>>`
    SELECT t.id
    FROM idempotency_keys c
    JOIN trades t ON (t."buyerId" = c."participantId" OR t."sellerId" = c."participantId")
    JOIN offers o ON o.id = t."offerId"
    WHERE c.id = ${claim.id}
      AND o."userId" <> c."participantId"
      AND t."tradeIntentId" IS NULL
      AND t."createdAt" >= c."createdAt"
      AND t."createdAt" <= c."createdAt" + make_interval(secs => ${HINT_WINDOW_SECONDS})
      AND NOT EXISTS (SELECT 1 FROM idempotency_keys other WHERE other."resultRef" = t.id AND other.id <> c.id)
    ORDER BY t."createdAt" ASC, t.id ASC
    LIMIT ${MAX_HINTS}`
  const hintIds = hints.map((h) => h.id)

  const evidence = {
    policy: 'NO_INFERRED_ATTRIBUTION_V1',
    authoritative: false,
    basis: 'CORRELATION_ONLY',
    hintCriteria: 'trades the claim owner took (never one of their own offers), legacy shape (no tradeIntentId), created within hintWindowSeconds after the claim, not referenced by another claim',
    hintWindowSeconds: HINT_WINDOW_SECONDS,
    hintCount: hintIds.length,
  }
  await db.$executeRaw`
    INSERT INTO idempotency_reconciliation_audit (id, "claimId", scope, "participantId", decision, "candidateTradeIds", evidence, "decidedBy", "decidedAt")
    VALUES (${randomUUID()}, ${claim.id}, ${TRADE_CREATE_SCOPE}, ${claim.participantId}, 'UNRESOLVED',
            ${JSON.stringify(hintIds)}::jsonb, ${JSON.stringify(evidence)}::jsonb, ${observedBy}, (now() AT TIME ZONE 'UTC'))
    ON CONFLICT ("claimId") WHERE "decision" = 'UNRESOLVED' DO NOTHING`

  return { claimId: claim.id, decision: 'UNRESOLVED', unverifiedCandidateTradeIds: hintIds }
}

/**
 * Bulk observer: records the not-yet-observed IN_PROGRESS legacy claims older than `olderThanMs`, oldest first, so the
 * unresolved population is visible in the audit trail. Not scheduled by the server (invoking it is an operational
 * choice) and it can only ever append observations: it has no way to settle, fail or attribute a claim. Age is measured
 * on the database's UTC clock against the claim's stored (UTC) `createdAt`.
 */
export async function observeLegacyTradeClaims(opts: { olderThanMs: number; limit?: number; observedBy: string }, db: Db = prisma): Promise<ObservationOutcome[]> {
  const olderThanSeconds = Math.max(0, opts.olderThanMs) / 1000
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT k.id
    FROM idempotency_keys k
    WHERE k.scope = ${TRADE_CREATE_SCOPE}
      AND k.status = 'IN_PROGRESS'::"IdempotencyKeyStatus"
      AND k."createdAt" < ((now() AT TIME ZONE 'UTC') - make_interval(secs => ${olderThanSeconds}))
      AND NOT EXISTS (SELECT 1 FROM idempotency_reconciliation_audit a WHERE a."claimId" = k.id AND a.decision = 'UNRESOLVED')
    ORDER BY k."createdAt" ASC, k.id ASC
    LIMIT ${opts.limit ?? 100}`
  const outcomes: ObservationOutcome[] = []
  for (const row of rows) outcomes.push(await observeLegacyTradeClaim(row.id, opts.observedBy, db))
  return outcomes
}
