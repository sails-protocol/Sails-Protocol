-- #235 R7H-NF-E3C-5 (D8) — append-only audit of legacy idempotency-claim reconciliation decisions.
--
-- Legacy `openp2p.trade.create` claims left IN_PROGRESS by a process that died after its trade committed are settled
-- only when exactly one trade is independently attributable to them (src/modules/open-p2p/trade-claim-reconciliation.ts).
-- Every decision — resolved or not — leaves one row here with the evidence it was based on, so a resolution can be
-- reviewed and an undecidable claim is visibly undecided rather than silently failed. Additive; touches no existing row.
-- Immutable: UPDATE and DELETE are refused by the database.
--
-- Rollback (manual):
--   DROP TRIGGER idempotency_reconciliation_audit_append_only ON "idempotency_reconciliation_audit";
--   DROP FUNCTION idempotency_reconciliation_audit_append_only();
--   DROP TABLE "idempotency_reconciliation_audit";

CREATE TABLE "idempotency_reconciliation_audit" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "candidateTradeIds" JSONB NOT NULL,
    "evidence" JSONB NOT NULL,
    "decidedBy" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_reconciliation_audit_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "idempotency_reconciliation_audit_decision_check"
      CHECK ("decision" IN ('MATCHED', 'AMBIGUOUS', 'NO_ATTRIBUTABLE_TRADE'))
);

CREATE INDEX "idempotency_reconciliation_audit_claimId_idx" ON "idempotency_reconciliation_audit"("claimId");

CREATE OR REPLACE FUNCTION idempotency_reconciliation_audit_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'idempotency_reconciliation_audit is append-only (id=%)', OLD.id
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER idempotency_reconciliation_audit_append_only
BEFORE UPDATE OR DELETE ON "idempotency_reconciliation_audit"
FOR EACH ROW
EXECUTE FUNCTION idempotency_reconciliation_audit_append_only();
