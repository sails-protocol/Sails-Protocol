-- #235 R7H-NF-E3C-5 (B2, Gate C corrective) — legacy idempotency claims are OBSERVED, never attributed.
--
-- CTO FREEZE: a legacy IN_PROGRESS `openp2p.trade.create` claim never becomes COMPLETED merely because a trade matches
-- participant, payload hash and timestamp. Correlation is not causation. A legacy trade carries no reference to the
-- claim that produced it, so no trade can be attributed to a stuck claim from durable causal evidence.
--
-- The audit table introduced by 20261018130000 recorded MATCHED / AMBIGUOUS / NO_ATTRIBUTABLE_TRADE decisions. After
-- this migration it can only record that a claim was observed and left UNRESOLVED:
--   * the decision vocabulary is a single value, enforced by the database (NOT VALID: rows an earlier, never-deployed
--     build of this branch may have written in a development database stay readable; no NEW row can say anything else);
--   * at most ONE UNRESOLVED observation exists per claim (partial unique index), so concurrent workers and repeated
--     replays cannot produce duplicate or conflicting outcomes;
--   * `candidateTradeIds` is, by definition, a list of NON-AUTHORITATIVE correlation hints.
-- Additive on existing data: no row of any table is read, rewritten or deleted. The append-only trigger is unchanged.
--
-- Rollback (manual):
--   DROP INDEX "idempotency_reconciliation_audit_claim_unresolved_key";
--   ALTER TABLE "idempotency_reconciliation_audit" DROP CONSTRAINT "idempotency_reconciliation_audit_unresolved_only";
--   ALTER TABLE "idempotency_reconciliation_audit" ADD CONSTRAINT "idempotency_reconciliation_audit_decision_check"
--     CHECK ("decision" IN ('MATCHED', 'AMBIGUOUS', 'NO_ATTRIBUTABLE_TRADE'));

ALTER TABLE "idempotency_reconciliation_audit"
  DROP CONSTRAINT "idempotency_reconciliation_audit_decision_check";

ALTER TABLE "idempotency_reconciliation_audit"
  ADD CONSTRAINT "idempotency_reconciliation_audit_unresolved_only"
  CHECK ("decision" = 'UNRESOLVED') NOT VALID;

CREATE UNIQUE INDEX "idempotency_reconciliation_audit_claim_unresolved_key"
  ON "idempotency_reconciliation_audit"("claimId")
  WHERE "decision" = 'UNRESOLVED';

COMMENT ON COLUMN "idempotency_reconciliation_audit"."decision"
  IS 'UNRESOLVED only: a legacy claim was observed and left unresolved. Never an attribution.';
COMMENT ON COLUMN "idempotency_reconciliation_audit"."candidateTradeIds"
  IS 'NON-AUTHORITATIVE correlation hints (trades the claim owner took shortly after the claim). Not proof of causation.';
