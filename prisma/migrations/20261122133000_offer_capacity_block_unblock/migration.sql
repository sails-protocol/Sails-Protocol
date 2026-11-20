-- M-1b slice 4 (CTO 28 Despachos 029/047/048): the durable reorg BLOCK of an Offer capacity and its two-role, evidence-bound UNBLOCK.
--
-- BLOCK. When release/funding evidence of an escrow whose reservation was ALREADY released (L2/L3) is later invalidated, replaced
-- or becomes ambiguous (REORGED_INVALIDATED / REPLACEMENT_OBSERVED / AMBIGUOUS), an AFTER INSERT trigger on both evidence tables
-- writes the block on that Offer's capacity row IN THE SAME TRANSACTION as the evidence (blockedAt/blockReason/blockEvidence=escrowId).
-- The runtime has NO UPDATE on the block columns (runtime-grants.sql); only this SECURITY DEFINER trigger writes them. The released
-- reservation is never undone and no capacity is invented (conservative: the block stops NEW COMMITTED reservations, E2503).
--
-- UNBLOCK (A1 + A3, two independent functions, no generic administrative path):
--   A  offer_capacity_request_unblock(owner, logicalOfferId, evidence, requesterKey): an operator records an append-only REQUEST naming
--      the block, the evidence (must name the blocking escrow) and a canonical digest computed BY THE DATABASE
--      (sha256 over the domain "sails-offer-capacity-unblock-v1", the request id, the identity, the exact block instant, the evidence
--      and the requester key). It removes nothing.
--   B  offer_capacity_execute_unblock(requestId, reviewerKey, reviewerSignature): callable ONLY by the reviewer role. It rejects a
--      reviewer who is the requester (same session user, or either being a member of the other's role, or the same Ed25519 key),
--      re-verifies the digest, locks the capacity row and the request, requires the block to be the SAME one the request saw, re-runs
--      the L3 settlement proof (confirmation depth of the policy, no REORGED_INVALIDATED/REPLACEMENT/AMBIGUOUS, funding certain, no
--      pending transaction, no open dispute) on the blocking escrow and refuses ANY unreconciled evidence in the Offer's scope. The
--      request is consumed once (a second execution is a NOOP); the block is cleared with an unblockProof naming digest + signature.
--   The database cannot verify Ed25519 (declared residual): it stores the reviewer's signature over the decision digest for
--   re-verification by scripts/audit-offer-capacity.ts. No timeout, no unilateral path, no signature accepted as proof of finality.
--
-- Reversal (manual, not applied automatically):
--   DROP TRIGGER offer_capacity_block_release_evidence ON "escrow_release_evidence";
--   DROP TRIGGER offer_capacity_block_funding_evidence ON "escrow_funding_evidence";
--   DROP FUNCTION offer_capacity_block_on_evidence();
--   DROP FUNCTION offer_capacity_execute_unblock(text, text, text);
--   DROP FUNCTION offer_capacity_request_unblock(text, text, jsonb, text);
--   DROP FUNCTION offer_capacity_unblock_digest(text, text, text, timestamptz, jsonb, text);
--   DROP TABLE "offer_capacity_unblock_requests";
--   (the role sails_capacity_reviewer is cluster-level and is left in place)

SET lock_timeout = '5s';

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sails_capacity_reviewer') THEN
    BEGIN
      CREATE ROLE sails_capacity_reviewer NOLOGIN;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE EXCEPTION 'the role sails_capacity_reviewer must be created by the cluster administrator before this migration (NOLOGIN; a separate login role holds the reviewer credential)';
    END;
  END IF;
END
$roles$;

CREATE TABLE "offer_capacity_unblock_requests" (
    "id" TEXT NOT NULL,
    "ownerPublicKey" TEXT NOT NULL,
    "logicalOfferId" TEXT NOT NULL,
    "blockedAtObserved" TIMESTAMPTZ(3) NOT NULL,
    "blockEvidenceObserved" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "requesterKey" TEXT NOT NULL,
    "requestedBySession" TEXT NOT NULL,
    "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    "digest" TEXT NOT NULL,
    "reviewerKey" TEXT,
    "reviewerSession" TEXT,
    "reviewerSignature" TEXT,
    "executedAt" TIMESTAMPTZ(3),

    CONSTRAINT "offer_capacity_unblock_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "offer_capacity_unblock_requests_capacity_fkey" FOREIGN KEY ("ownerPublicKey", "logicalOfferId")
        REFERENCES "offer_capacity"("ownerPublicKey", "logicalOfferId") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "offer_capacity_unblock_requests_keys_check" CHECK ("requesterKey" ~ '^[0-9a-f]{64}$' AND ("reviewerKey" IS NULL OR "reviewerKey" ~ '^[0-9a-f]{64}$')),
    CONSTRAINT "offer_capacity_unblock_requests_digest_check" CHECK ("digest" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "offer_capacity_unblock_requests_executed_check" CHECK (
        ("executedAt" IS NULL AND "reviewerKey" IS NULL AND "reviewerSession" IS NULL AND "reviewerSignature" IS NULL)
        OR ("executedAt" IS NOT NULL AND "reviewerKey" IS NOT NULL AND "reviewerSession" IS NOT NULL AND "reviewerSignature" ~ '^[0-9a-f]{128}$')
    )
);

-- Append-only trail: a request never changes, except ONCE when it is consumed (the execution columns NULL -> value).
CREATE OR REPLACE FUNCTION offer_capacity_unblock_requests_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'offer_capacity_unblock_requests: the trail is append-only' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."executedAt" IS NOT NULL OR NEW."id" IS DISTINCT FROM OLD."id" OR NEW."ownerPublicKey" IS DISTINCT FROM OLD."ownerPublicKey"
     OR NEW."logicalOfferId" IS DISTINCT FROM OLD."logicalOfferId" OR NEW."blockedAtObserved" IS DISTINCT FROM OLD."blockedAtObserved"
     OR NEW."blockEvidenceObserved" IS DISTINCT FROM OLD."blockEvidenceObserved" OR NEW."evidence" IS DISTINCT FROM OLD."evidence"
     OR NEW."requesterKey" IS DISTINCT FROM OLD."requesterKey" OR NEW."requestedBySession" IS DISTINCT FROM OLD."requestedBySession"
     OR NEW."requestedAt" IS DISTINCT FROM OLD."requestedAt" OR NEW."digest" IS DISTINCT FROM OLD."digest" THEN
    RAISE EXCEPTION 'offer_capacity_unblock_requests: a request is immutable and consumed once (id=%)', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER offer_capacity_unblock_requests_guard BEFORE UPDATE OR DELETE ON "offer_capacity_unblock_requests" FOR EACH ROW EXECUTE FUNCTION offer_capacity_unblock_requests_guard();
CREATE TRIGGER offer_capacity_unblock_requests_no_truncate BEFORE TRUNCATE ON "offer_capacity_unblock_requests" FOR EACH STATEMENT EXECUTE FUNCTION offer_capacity_unblock_requests_guard();

-- Canonical digest (computed by the database, never accepted from a caller).
CREATE OR REPLACE FUNCTION offer_capacity_unblock_digest(p_id text, p_owner text, p_logical text, p_blocked_at timestamptz, p_evidence jsonb, p_requester_key text)
RETURNS text AS $$
  SELECT encode(sha256(convert_to(concat_ws(E'\x1f', 'sails-offer-capacity-unblock-v1', p_id, p_owner, p_logical,
    to_char(p_blocked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), p_evidence::text, p_requester_key), 'UTF8')), 'hex');
$$ LANGUAGE sql IMMUTABLE;

-- BLOCK trigger (same transaction as the evidence).
CREATE OR REPLACE FUNCTION offer_capacity_block_on_evidence()
RETURNS TRIGGER AS $$
DECLARE
  cap record;
BEGIN
  FOR cap IN
    SELECT DISTINCT r."ownerPublicKey", r."logicalOfferId"
      FROM "offer_capacity_reservations" r
      JOIN "trades" t ON t."tradeIntentId" = r."tradeIntentId"
      JOIN "escrows" e ON e."tradeId" = t."id"
     WHERE e."id" = NEW."escrowId" AND r."state" = 'RELEASED' AND r."releaseKind" IN ('L2_NEVER_FUNDED_REFUND', 'L3_FINALIZED_SETTLEMENT')
  LOOP
    UPDATE "offer_capacity" SET "blockedAt" = clock_timestamp(), "blockReason" = 'EVIDENCE_' || NEW."kind"::text, "blockEvidence" = NEW."escrowId", "updatedAt" = clock_timestamp()
     WHERE "ownerPublicKey" = cap."ownerPublicKey" AND "logicalOfferId" = cap."logicalOfferId" AND "blockedAt" IS NULL;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

CREATE TRIGGER offer_capacity_block_release_evidence AFTER INSERT ON "escrow_release_evidence"
  FOR EACH ROW WHEN (NEW."kind"::text IN ('REORGED_INVALIDATED', 'REPLACEMENT_OBSERVED', 'AMBIGUOUS')) EXECUTE FUNCTION offer_capacity_block_on_evidence();
CREATE TRIGGER offer_capacity_block_funding_evidence AFTER INSERT ON "escrow_funding_evidence"
  FOR EACH ROW WHEN (NEW."kind"::text IN ('REORGED_INVALIDATED', 'REPLACEMENT_OBSERVED', 'AMBIGUOUS')) EXECUTE FUNCTION offer_capacity_block_on_evidence();

-- A: record the request (removes nothing).
CREATE OR REPLACE FUNCTION offer_capacity_request_unblock(p_owner text, p_logical text, p_evidence jsonb, p_requester_key text)
RETURNS text AS $$
DECLARE
  cap record;
  rid text := gen_random_uuid()::text;
BEGIN
  SELECT c."blockedAt", c."blockEvidence" INTO cap FROM "offer_capacity" c WHERE c."ownerPublicKey" = p_owner AND c."logicalOfferId" = p_logical FOR SHARE;
  IF NOT FOUND OR cap."blockedAt" IS NULL THEN
    RAISE EXCEPTION 'E25_UNBLOCK_NOT_BLOCKED: the Offer capacity is not blocked' USING ERRCODE = 'E2510';
  END IF;
  IF p_evidence IS NULL OR p_evidence->>'escrowId' IS DISTINCT FROM cap."blockEvidence" THEN
    RAISE EXCEPTION 'E25_UNBLOCK_EVIDENCE_MISMATCH: the evidence must name the escrow that caused the block (%)', cap."blockEvidence" USING ERRCODE = 'E2511';
  END IF;
  INSERT INTO "offer_capacity_unblock_requests" ("id", "ownerPublicKey", "logicalOfferId", "blockedAtObserved", "blockEvidenceObserved", "evidence", "requesterKey", "requestedBySession", "digest")
    VALUES (rid, p_owner, p_logical, cap."blockedAt", cap."blockEvidence", p_evidence, p_requester_key, session_user,
            offer_capacity_unblock_digest(rid, p_owner, p_logical, cap."blockedAt", p_evidence, p_requester_key));
  RETURN rid;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

-- B: the reviewer executes. Lock order: capacity row -> request row -> (settlement proof) escrow/disputes.
CREATE OR REPLACE FUNCTION offer_capacity_execute_unblock(p_request_id text, p_reviewer_key text, p_signature text)
RETURNS text AS $$
DECLARE
  q record;
  cap record;
  v text;
  bad record;
BEGIN
  IF NOT pg_has_role(session_user, 'sails_capacity_reviewer', 'member') THEN
    RAISE EXCEPTION 'E25_UNBLOCK_NOT_REVIEWER: only the reviewer role may execute an unblock' USING ERRCODE = 'E2512';
  END IF;
  IF p_reviewer_key IS NULL OR p_reviewer_key !~ '^[0-9a-f]{64}$' OR p_signature IS NULL OR p_signature !~ '^[0-9a-f]{128}$' THEN
    RAISE EXCEPTION 'E25_UNBLOCK_BAD_SIGNATURE_SHAPE: reviewer key (64 hex) and signature (128 hex) are required' USING ERRCODE = 'E2513';
  END IF;

  SELECT x."ownerPublicKey", x."logicalOfferId" INTO q FROM "offer_capacity_unblock_requests" x WHERE x."id" = p_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'E25_UNBLOCK_NO_REQUEST: unknown request' USING ERRCODE = 'E2514'; END IF;
  SELECT c."blockedAt", c."blockEvidence" INTO cap FROM "offer_capacity" c WHERE c."ownerPublicKey" = q."ownerPublicKey" AND c."logicalOfferId" = q."logicalOfferId" FOR UPDATE;
  SELECT x."id", x."ownerPublicKey", x."logicalOfferId", x."blockedAtObserved", x."blockEvidenceObserved", x."evidence", x."requesterKey", x."requestedBySession", x."digest", x."executedAt"
    INTO q FROM "offer_capacity_unblock_requests" x WHERE x."id" = p_request_id FOR UPDATE;

  IF q."executedAt" IS NOT NULL THEN RETURN 'NOOP:already_executed'; END IF;

  -- independence: A and B can never be the same effective principal
  IF q."requestedBySession" = session_user OR pg_has_role(session_user, q."requestedBySession", 'member') OR pg_has_role(q."requestedBySession", session_user, 'member')
     OR q."requesterKey" = p_reviewer_key THEN
    RAISE EXCEPTION 'E25_UNBLOCK_SAME_PRINCIPAL: the reviewer must be independent of the requester' USING ERRCODE = 'E2515';
  END IF;
  IF q."digest" IS DISTINCT FROM offer_capacity_unblock_digest(q."id", q."ownerPublicKey", q."logicalOfferId", q."blockedAtObserved", q."evidence", q."requesterKey") THEN
    RAISE EXCEPTION 'E25_UNBLOCK_DIGEST_MISMATCH: the stored request does not match its canonical digest' USING ERRCODE = 'E2516';
  END IF;
  -- the request must concern the block that is in force NOW (a newer block, or an already cleared one, voids it)
  IF cap."blockedAt" IS NULL OR cap."blockedAt" IS DISTINCT FROM q."blockedAtObserved" OR cap."blockEvidence" IS DISTINCT FROM q."blockEvidenceObserved" THEN
    RAISE EXCEPTION 'E25_UNBLOCK_STALE: the request does not concern the block currently in force' USING ERRCODE = 'E2517';
  END IF;

  -- the same L3 standard the release uses, re-derived now from persisted facts on the blocking escrow
  v := offer_capacity_settlement_proof(q."blockEvidenceObserved");
  IF v LIKE 'KEEP:%' THEN
    RAISE EXCEPTION 'E25_UNBLOCK_EVIDENCE_INSUFFICIENT: %', v USING ERRCODE = 'E2518';
  END IF;
  -- any unreconciled evidence (reorg, replacement, ambiguity) anywhere in the Offer's scope refuses the unblock
  SELECT e."id" INTO bad
    FROM "offer_capacity_reservations" r
    JOIN "trades" t ON t."tradeIntentId" = r."tradeIntentId"
    JOIN "escrows" e ON e."tradeId" = t."id"
   WHERE r."ownerPublicKey" = q."ownerPublicKey" AND r."logicalOfferId" = q."logicalOfferId"
     AND ( (SELECT f."kind"::text FROM "escrow_funding_evidence" f WHERE f."escrowId" = e."id" ORDER BY f."recordedAt" DESC, f."id" DESC LIMIT 1) IN ('REORGED_INVALIDATED', 'REPLACEMENT_OBSERVED', 'AMBIGUOUS')
        OR (SELECT x."kind"::text FROM "escrow_release_evidence" x WHERE x."escrowId" = e."id" ORDER BY x."recordedAt" DESC, x."id" DESC LIMIT 1) IN ('REORGED_INVALIDATED', 'REPLACEMENT_OBSERVED', 'AMBIGUOUS') )
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'E25_UNBLOCK_SCOPE_AMBIGUOUS: unreconciled evidence remains in the Offer scope (escrow %)', bad."id" USING ERRCODE = 'E2519';
  END IF;

  UPDATE "offer_capacity_unblock_requests" SET "reviewerKey" = p_reviewer_key, "reviewerSession" = session_user, "reviewerSignature" = p_signature, "executedAt" = clock_timestamp()
   WHERE "id" = q."id" AND "executedAt" IS NULL;
  UPDATE "offer_capacity" SET "blockedAt" = NULL, "blockReason" = NULL, "unblockProof" = q."digest" || ':' || p_signature, "updatedAt" = clock_timestamp()
   WHERE "ownerPublicKey" = q."ownerPublicKey" AND "logicalOfferId" = q."logicalOfferId";
  RETURN 'EXECUTED';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION offer_capacity_execute_unblock(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION offer_capacity_execute_unblock(text, text, text) TO sails_capacity_reviewer;

RESET lock_timeout;
